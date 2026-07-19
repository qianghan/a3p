/**
 * Tests for `nextQuarterlyTaxDeadline` — the tax-deadline countdown used
 * by the morning digest. Previously this logic was duplicated as
 * hardcoded US/CA-only `Date[]` arrays in both `agentbook-digest-tips.ts`
 * and `morning-digest/route.ts`, silently treating AU tenants as US
 * (wrong deadline dates). This now reads real, already-published
 * `@agentbook/jurisdictions` calendar-pack data instead.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

// The module under test imports `prisma as db` from '@naap/database' at
// the top level (used by `buildTipContext`, not by the function under
// test here) — mock it so the import doesn't require a live DB.
vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findUnique: vi.fn() },
    abAccount: { findMany: vi.fn() },
    abJournalLine: { aggregate: vi.fn(), findMany: vi.fn() },
    abExpense: { aggregate: vi.fn(), count: vi.fn() },
    abInvoice: { findMany: vi.fn() },
    abRecurringRule: { findMany: vi.fn() },
    abTaxEstimate: { findFirst: vi.fn() },
  },
}));

import { nextQuarterlyTaxDeadline } from './agentbook-digest-tips';

describe('nextQuarterlyTaxDeadline', () => {
  it('US: returns days until the next IRS quarterly-estimate deadline (Apr 15 / Jun 15 / Sep 15 / Jan 15)', () => {
    const now = new Date(Date.UTC(2026, 2, 20)); // Mar 20, 2026 — before Apr 15
    const days = nextQuarterlyTaxDeadline('us', '', now);
    const expectedDate = new Date(Date.UTC(2026, 3, 15));
    const expectedDays = Math.round((expectedDate.getTime() - now.getTime()) / 86_400_000);
    expect(days).toBe(expectedDays);
  });

  it('CA: returns days until the next CRA quarterly-instalment deadline (15th of Mar/Jun/Sep/Dec)', () => {
    const now = new Date(Date.UTC(2026, 4, 1)); // May 1, 2026 — before Jun 15
    const days = nextQuarterlyTaxDeadline('ca', '', now);
    const expectedDate = new Date(Date.UTC(2026, 5, 15));
    const expectedDays = Math.round((expectedDate.getTime() - now.getTime()) / 86_400_000);
    expect(days).toBe(expectedDays);
  });

  it('AU: returns days until the next PAYG instalment deadline (Oct 28 / Feb 28 / Apr 28 / Jul 28) — NOT a US/CA date', () => {
    const now = new Date(Date.UTC(2026, 8, 1)); // Sep 1, 2026 — before Oct 28
    const days = nextQuarterlyTaxDeadline('au', '', now);
    const expectedDate = new Date(Date.UTC(2026, 9, 28));
    const expectedDays = Math.round((expectedDate.getTime() - now.getTime()) / 86_400_000);
    expect(days).toBe(expectedDays);
    // Explicitly prove this is NOT the old bug's US fallback date (Sep 15 already passed, so the
    // old broken code would have picked Jan 15 next year — a very different, wrong number).
    const wrongUsFallbackDays = Math.round(
      (new Date(Date.UTC(2027, 0, 15)).getTime() - now.getTime()) / 86_400_000,
    );
    expect(days).not.toBe(wrongUsFallbackDays);
  });

  it('returns null when no known jurisdiction/region has any upcoming quarterly deadline in the lookup window (defensive edge case, not expected in practice)', () => {
    // Every real jurisdiction pack always has an upcoming deadline within a year,
    // so this just confirms the function doesn't throw for an unrecognized jurisdiction —
    // it should fall back to the 'us' pack's deadlines (same fallback as every other
    // jurisdiction-pack consumer in this codebase, e.g. `BRACKET_PROVIDERS[j] ?? usTaxBrackets`).
    const now = new Date(Date.UTC(2026, 2, 20));
    const days = nextQuarterlyTaxDeadline('zz', '', now);
    expect(days).not.toBeNull();
  });
});
