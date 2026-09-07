import { describe, it, expect, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { requireCronSecret, safeCompareBearer } from '@/lib/cron-auth';

/**
 * 21 cron routes authenticated fail-open:
 *
 *     if (process.env.CRON_SECRET && auth !== `Bearer ${secret}`) return 401;
 *
 * An unset variable makes the condition false, so nothing 401s and the job
 * runs for anyone who finds the URL. They are safe today only because the
 * variable happens to be set. #387 flipped this on six damage-path routes and
 * left the rest as a "consistency follow-up".
 */

const SECRET = 'a'.repeat(64);
const req = (init?: { auth?: string; query?: string }) =>
  new NextRequest(
    new URL(`https://x.test/api/v1/agentbook/cron/x${init?.query ? `?secret=${init.query}` : ''}`),
    { headers: init?.auth ? { authorization: init.auth } : undefined },
  );

afterEach(() => { delete process.env.CRON_SECRET; vi.restoreAllMocks(); });

describe('fail-closed', () => {
  it('refuses everyone when CRON_SECRET is unset — even a correct-looking bearer', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.CRON_SECRET;
    expect(requireCronSecret(req({ auth: `Bearer ${SECRET}` }))?.status).toBe(401);
    expect(requireCronSecret(req())?.status).toBe(401);
  });

  it('refuses when CRON_SECRET is set but empty', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.CRON_SECRET = '';
    expect(requireCronSecret(req({ auth: 'Bearer ' }))?.status).toBe(401);
  });

  it('says so in the logs, so a forgotten variable is visible to an operator', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.CRON_SECRET;
    requireCronSecret(req());
    expect(err).toHaveBeenCalled();
  });

  it('tells the caller nothing about why', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.CRON_SECRET;
    const body = await requireCronSecret(req())!.json();
    expect(JSON.stringify(body)).not.toMatch(/CRON_SECRET|unset|missing/i);
  });
});

describe('accepts both shapes already in use, so no caller changes', () => {
  it('Authorization: Bearer — what Vercel sends for a cron invocation', () => {
    process.env.CRON_SECRET = SECRET;
    expect(requireCronSecret(req({ auth: `Bearer ${SECRET}` }))).toBeNull();
  });

  it('?secret= — the four older routes', () => {
    process.env.CRON_SECRET = SECRET;
    expect(requireCronSecret(req({ query: SECRET }))).toBeNull();
  });

  it('rejects a wrong secret in either shape', () => {
    process.env.CRON_SECRET = SECRET;
    expect(requireCronSecret(req({ auth: `Bearer ${'b'.repeat(64)}` }))?.status).toBe(401);
    expect(requireCronSecret(req({ query: 'b'.repeat(64) }))?.status).toBe(401);
  });

  it('rejects a bare secret sent without the Bearer prefix', () => {
    process.env.CRON_SECRET = SECRET;
    expect(requireCronSecret(req({ auth: SECRET }))?.status).toBe(401);
  });
});

describe('the compare does not leak length or timing', () => {
  it('handles a length mismatch without throwing', () => {
    // timingSafeEqual throws on unequal lengths, which would surface as a 500
    // and itself disclose that the length was wrong.
    expect(() => safeCompareBearer('Bearer short', SECRET)).not.toThrow();
    expect(safeCompareBearer('Bearer short', SECRET)).toBe(false);
  });

  it('handles a null header', () => {
    expect(safeCompareBearer(null, SECRET)).toBe(false);
  });
});

describe('every scheduled route uses it', () => {
  /**
   * Structural, and the point of the change: a helper 21 routes do not call
   * fixes nothing — the shape of #444, #451 and #453.
   *
   * The regex distinguishes the two guards that LOOK alike:
   *
   *   process.env.CRON_SECRET && auth !== ...     fail-OPEN  (unset ⇒ no 401)
   *   !!process.env.CRON_SECRET && secret === ... fail-CLOSED (unset ⇒ false)
   *
   * Only the first is a defect, so the negation must be part of the match.
   * Getting this wrong is how a "27 fail-open routes" figure gets reported for
   * what is actually 21 — I made that mistake reading it by pattern.
   */
  const FAIL_OPEN = /(?<!!)\bprocess\.env\.CRON_SECRET\s*&&/;

  /**
   * Routes that legitimately mention the variable without the fail-open shape.
   * `admin/*` falls through to requireAdmin — a real second factor, a different
   * design, deliberately untouched.
   */
  const ALLOWED = [
    'admin/seed-skills', 'admin/skills',
    // These four are already fail-closed (`!!`). Their separate defect is
    // treating `x-vercel-cron: 1` as sufficient on its own — a forgeable
    // header, not a fail-open guard. Folding it in here would double the
    // regression surface of a security fix.
    'agentbook-billing/cron/reset-quotas', 'agentbook-billing/cron/cleanup-events',
    'agentbook/cron/cpa-review', 'agentbook/cron/recognize-revenue',
  ];

  it('no route still carries the fail-open guard', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(__dirname, '../../app/api');

    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((e) => {
        const p = join(dir, e);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith('route.ts') ? [p] : [];
      });

    const offenders = walk(root).filter((p) => {
      const rel = p.slice(p.indexOf('/api/v1/') + 8).replace('/route.ts', '');
      if (ALLOWED.includes(rel)) return false;
      const src = readFileSync(p, 'utf8');
      // comments must not count as a guard
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      return FAIL_OPEN.test(code);
    });

    expect(
      offenders,
      `fail-open CRON_SECRET guard present in:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the allow-list is not a way to smuggle a fail-open guard back in', () => {
    // Every entry has to be justified above; six is the whole list.
    expect(ALLOWED).toHaveLength(6);
  });
});
