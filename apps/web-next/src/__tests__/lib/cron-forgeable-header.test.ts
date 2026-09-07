import { describe, it, expect } from 'vitest';

/**
 * Four routes authorised on `x-vercel-cron: 1` ALONE:
 *
 *     return cron === '1' || (!!process.env.CRON_SECRET && secret === ...);
 *
 * That header is an ordinary inbound request header. Anyone who can reach the
 * URL can send it, so the secret branch was decoration — and since the cron
 * config in vercel.json carries no `?secret=`, the header was these routes'
 * only live auth path. `recognize-revenue` recognises deferred revenue;
 * `reset-quotas` resets billing quotas.
 *
 * Left out of #486 on purpose: that PR fixed fail-OPEN guards, and mixing a
 * second class of defect into a security change doubles its regression
 * surface. This is the follow-up it named.
 *
 * The replacement is the same requireCronSecret helper, which accepts the
 * `Authorization: Bearer` that Vercel attaches to a cron invocation — the
 * shape payment-reminders and recurring-invoices have required, Bearer-only,
 * since #387 in July.
 */

const ROUTES = [
  'agentbook-billing/cron/reset-quotas',
  'agentbook-billing/cron/cleanup-events',
  'agentbook/cron/cpa-review',
  'agentbook/cron/recognize-revenue',
];

/**
 * Comments are stripped before matching. The fix's own explanatory note names
 * the header it removed, and an assertion that cannot tell code from prose
 * fails on the very comment documenting the fix — which is exactly what
 * happened on the first run.
 */
const read = async (rel: string) => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const src = readFileSync(join(__dirname, '../../app/api/v1', rel, 'route.ts'), 'utf8');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
};

describe('no route treats a forgeable header as sufficient auth', () => {
  it.each(ROUTES)('%s does not authorise on x-vercel-cron alone', async (r) => {
    const src = await read(r);
    expect(
      src,
      'x-vercel-cron is an inbound header any caller can set; it cannot be the only check',
    ).not.toMatch(/x-vercel-cron/);
  });

  it.each(ROUTES)('%s uses the shared fail-closed helper', async (r) => {
    const src = await read(r);
    expect(src).toMatch(/requireCronSecret\(/);
  });

  it('and none of them kept a local auth predicate', async () => {
    for (const r of ROUTES) {
      const src = await read(r);
      expect(src, `${r} still has its own isAuthorized`).not.toMatch(/function isAuthorized/);
    }
  });

  it('the route list is not silently empty', () => {
    expect(ROUTES).toHaveLength(4);
  });
});
