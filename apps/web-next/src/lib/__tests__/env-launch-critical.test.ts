/**
 * Env validation — launch-critical variables.
 *
 * `isProduction` is captured at module load, so each case sets NODE_ENV before a
 * fresh dynamic import.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const LAUNCH_KEYS = [
  'RESEND_API_KEY',
  'GEMINI_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'CRON_SECRET',
  'INTERNAL_ADMIN_SECRET',
];

const saved: Record<string, string | undefined> = {};
const TOUCHED = ['NODE_ENV', 'DATABASE_URL', 'NEXTAUTH_SECRET', ...LAUNCH_KEYS];

beforeEach(() => {
  for (const k of TOUCHED) saved[k] = process.env[k];
  vi.resetModules();
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
});

async function loadEnv(nodeEnv: string) {
  process.env.NODE_ENV = nodeEnv;
  vi.resetModules();
  return await import('../env');
}

describe('validateEnv — launch-critical reporting (production)', () => {
  it('reports every unset launch-critical var, each with what it breaks', async () => {
    process.env.DATABASE_URL = 'postgres://x';
    for (const k of LAUNCH_KEYS) delete process.env[k];

    const { validateEnv } = await loadEnv('production');
    const { launchCriticalMissing, valid } = validateEnv();

    expect(launchCriticalMissing.map((e) => e.key).sort()).toEqual([...LAUNCH_KEYS].sort());
    for (const entry of launchCriticalMissing) {
      expect(entry.breaks.length).toBeGreaterThan(10); // actionable, not just a name
    }
    // core config is present, so overall validity is unchanged
    expect(valid).toBe(true);
  });

  it('reports none when they are all set', async () => {
    process.env.DATABASE_URL = 'postgres://x';
    for (const k of LAUNCH_KEYS) process.env[k] = 'set';

    const { validateEnv } = await loadEnv('production');
    expect(validateEnv().launchCriticalMissing).toEqual([]);
  });

  it('does NOT require NEXTAUTH_SECRET in production (next-auth is unused there)', async () => {
    process.env.DATABASE_URL = 'postgres://x';
    delete process.env.NEXTAUTH_SECRET;
    for (const k of LAUNCH_KEYS) process.env[k] = 'set';

    const { validateEnv } = await loadEnv('production');
    const { valid, missing, launchCriticalMissing } = validateEnv();
    expect(missing).not.toContain('NEXTAUTH_SECRET');
    expect(launchCriticalMissing.map((e) => e.key)).not.toContain('NEXTAUTH_SECRET');
    expect(valid).toBe(true); // no more permanent false FATAL in production
  });

  it('still flags a genuinely missing DATABASE_URL', async () => {
    delete process.env.DATABASE_URL;
    const { validateEnv } = await loadEnv('production');
    const { valid, missing } = validateEnv();
    expect(valid).toBe(false);
    expect(missing).toContain('DATABASE_URL');
  });
});

describe('validateEnv — development', () => {
  it('does not report launch-critical vars outside production (local dev needs no Stripe/Resend/Gemini keys)', async () => {
    process.env.DATABASE_URL = 'postgres://x';
    process.env.NEXTAUTH_SECRET = 'dev';
    for (const k of LAUNCH_KEYS) delete process.env[k];

    const { validateEnv } = await loadEnv('development');
    const { valid, launchCriticalMissing } = validateEnv();
    expect(launchCriticalMissing).toEqual([]);
    expect(valid).toBe(true);
  });

  it('still requires NEXTAUTH_SECRET outside production (dev-api token encryption reads it)', async () => {
    process.env.DATABASE_URL = 'postgres://x';
    delete process.env.NEXTAUTH_SECRET;

    const { validateEnv } = await loadEnv('development');
    const { valid, missing } = validateEnv();
    expect(missing).toContain('NEXTAUTH_SECRET');
    expect(valid).toBe(false);
  });
});
