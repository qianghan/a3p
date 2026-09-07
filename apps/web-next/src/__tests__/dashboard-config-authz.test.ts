// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isPrivateHost } from '@/lib/gateway/types';

/**
 * `dashboardPluginConfig` is upserted by `key` alone — no tenant column — so
 * these rows are INSTALLATION-wide. The PUT required only a valid session, so
 * any logged-in user could repoint the Metabase URL and secret key for
 * everyone; and `config/test` then reported whether that URL answered, which
 * turns the pair into an internal port-probe oracle.
 *
 * Structural, because exercising the route means standing up sessions, CSRF
 * and Prisma — while the defect is which guard the handler calls, which the
 * source states directly.
 */

const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const CONFIG = 'apps/web-next/src/app/api/v1/dashboard/config/route.ts';
const TEST = 'apps/web-next/src/app/api/v1/dashboard/config/test/route.ts';

describe('writing installation-wide dashboard config', () => {
  it('requires an admin, not merely a session', () => {
    const src = strip(read(CONFIG));
    const put = src.slice(src.indexOf('export async function PUT'));
    expect(put).toContain('await requireAdmin(request)');
  });

  it('still rejects an anonymous caller before anything else', () => {
    const src = strip(read(CONFIG));
    const put = src.slice(src.indexOf('export async function PUT'));
    expect(put).toContain('errors.unauthorized');
    expect(put).toContain('validateCSRF');
  });

  it('never returns any bytes of the signing secret', () => {
    const src = strip(read(CONFIG));
    // It used to answer with `substring(0, 8)` of the key.
    expect(src).not.toMatch(/metabaseSecretKey\.substring/);
    expect(src).toContain('metabaseSecretKeyConfigured');
  });
});

describe('the connectivity probe cannot be aimed inside the network', () => {
  it('checks the host before fetching, and refuses redirects', () => {
    const src = strip(read(TEST));
    const i = src.indexOf('isPrivateHost(target.hostname)');
    const j = src.indexOf('await fetch(');
    expect(i, 'no isPrivateHost check').toBeGreaterThan(-1);
    expect(i, 'the host check must precede the fetch').toBeLessThan(j);
    expect(src).toMatch(/redirect: 'error'/);
  });

  it('rejects the addresses that make this an oracle', () => {
    // The shared checker from the SSRF work — asserted here so this route's
    // protection cannot be quietly weakened by changing that helper.
    for (const h of ['169.254.169.254', '127.0.0.1', 'localhost', '10.0.0.5', '192.168.1.1', '::1']) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    expect(isPrivateHost('metabase.example.com')).toBe(false);
  });

  it('refuses a non-http scheme rather than handing it to fetch', () => {
    const src = strip(read(TEST));
    expect(src).toMatch(/target\.protocol !== 'https:' && target\.protocol !== 'http:'/);
  });
});
