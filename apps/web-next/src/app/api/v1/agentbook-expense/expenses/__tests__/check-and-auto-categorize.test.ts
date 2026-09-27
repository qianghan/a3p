/**
 * `checkAndAutoCategorize` never actually ran in production.
 *
 * The ORIGINAL implementation lived only in the legacy Express plugin
 * backend (plugins/agentbook-expense/backend/src/server.ts). Production
 * resolves `/api/v1/agentbook-expense/*` to this Next.js route, not the
 * Express backend (AGENTBOOK_EXPENSE_URL is unset — see
 * apps/web-next/src/lib/agentbook-config.ts), so the Express version was
 * structurally dead code: no expense ever created in production went
 * through it. A tenant whose only expense(s) were all uncategorized had no
 * proactive path to automatic categorization — only the 6-hourly watchdog
 * cron could eventually reach it.
 *
 * This is the real production version, ported into the route that actually
 * serves traffic, calling `autoCategorizeForTenant` directly rather than
 * doing a self-HTTP-fetch with an `x-internal-cron` header (the Express
 * version needed that only because it and Next.js are separate processes).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

vi.mock('server-only', () => ({}));

describe('wiring: POST actually calls checkAndAutoCategorize', () => {
  // A pure-function unit test on checkAndAutoCategorize itself proves the
  // LOGIC is correct, but not that the POST handler still calls it — the
  // exact class of gap that let the original Express version's proactive
  // trigger sit dead in prod undetected. Source-scan the call site directly
  // so a future refactor that silently drops the `await
  // checkAndAutoCategorize(tenantId)` line fails a test, not just ships.
  it('the POST handler source contains the call, after the expense is created', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', 'route.ts'), 'utf8');
    const createIdx = src.indexOf('abExpense.create(');
    const callIdx = src.indexOf('await checkAndAutoCategorize(tenantId)');
    expect(createIdx, 'abExpense.create( not found in route.ts').toBeGreaterThan(-1);
    expect(callIdx, 'await checkAndAutoCategorize(tenantId) call site missing from POST handler').toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(createIdx);
  });
});

const expenseCount = vi.fn();
vi.mock('@naap/database', () => ({
  prisma: {
    abExpense: { count: (...a: unknown[]) => expenseCount(...a) },
  },
}));

const autoCategorizeForTenant = vi.fn();
vi.mock('@/lib/agentbook-auto-categorize', () => ({
  autoCategorizeForTenant: (...a: unknown[]) => autoCategorizeForTenant(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
  autoCategorizeForTenant.mockResolvedValue({ appliedCount: 0, pending: [], skippedCount: 0 });
});

describe('checkAndAutoCategorize (real production route)', () => {
  it('a tenant whose ONLY expense is uncategorized (100% > 10% threshold) triggers a real run', async () => {
    expenseCount
      .mockResolvedValueOnce(1) // total
      .mockResolvedValueOnce(1); // uncategorized
    const { checkAndAutoCategorize } = await import('../route');

    await checkAndAutoCategorize('tenant-1');

    expect(autoCategorizeForTenant).toHaveBeenCalledWith('tenant-1');
  });

  it('does nothing when the tenant has zero expenses', async () => {
    expenseCount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    const { checkAndAutoCategorize } = await import('../route');

    await checkAndAutoCategorize('tenant-1');

    expect(autoCategorizeForTenant).not.toHaveBeenCalled();
  });

  it('stays quiet under the 10% threshold — does not run on every single expense creation', async () => {
    expenseCount
      .mockResolvedValueOnce(20) // total
      .mockResolvedValueOnce(1); // uncategorized — 5%
    const { checkAndAutoCategorize } = await import('../route');

    await checkAndAutoCategorize('tenant-1');

    expect(autoCategorizeForTenant).not.toHaveBeenCalled();
  });

  it('a real error from autoCategorizeForTenant is swallowed — best-effort, must never break expense creation', async () => {
    expenseCount.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    autoCategorizeForTenant.mockRejectedValueOnce(new Error('Gemini timed out'));
    const { checkAndAutoCategorize } = await import('../route');

    await expect(checkAndAutoCategorize('tenant-1')).resolves.toBeUndefined();
  });
});
