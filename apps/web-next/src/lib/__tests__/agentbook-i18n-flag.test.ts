/**
 * The translation gate (decision D2).
 *
 * The gate exists because a CA tenant may ALREADY hold locale='fr-CA', written
 * by the Canada-only language selector that predates this work. Hiding the
 * picker would not stop those tenants seeing partially-translated French, so
 * the gate has to apply at RESOLUTION, not at selection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// `server-only` throws outside a Server Component; the same stub is used by
// mcp-flag.test.ts, the existing precedent for testing a flag reader.
vi.mock('server-only', () => ({}));

const findUnique = vi.fn();
vi.mock('@naap/database', () => ({
  prisma: { featureFlag: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}));

describe('isI18nLocalesEnabled', () => {
  beforeEach(() => {
    findUnique.mockReset();
    vi.resetModules();
  });

  it('is FALSE when the flag row does not exist', async () => {
    findUnique.mockResolvedValue(null);
    const { isI18nLocalesEnabled } = await import('../agentbook-i18n-flag');
    expect(await isI18nLocalesEnabled()).toBe(false);
  });

  it('is FALSE when the row exists but is disabled', async () => {
    findUnique.mockResolvedValue({ enabled: false });
    const { isI18nLocalesEnabled } = await import('../agentbook-i18n-flag');
    expect(await isI18nLocalesEnabled()).toBe(false);
  });

  it('is TRUE only when explicitly enabled', async () => {
    findUnique.mockResolvedValue({ enabled: true });
    const { isI18nLocalesEnabled } = await import('../agentbook-i18n-flag');
    expect(await isI18nLocalesEnabled()).toBe(true);
  });

  it('FAILS CLOSED when the database throws', async () => {
    // This repo has already had to fix fail-OPEN gates. A lookup error must
    // mean "English", never "ship half-translated UI".
    findUnique.mockRejectedValue(new Error('connection refused'));
    const { isI18nLocalesEnabled } = await import('../agentbook-i18n-flag');
    expect(await isI18nLocalesEnabled()).toBe(false);
  });

  it('queries the agreed key', async () => {
    findUnique.mockResolvedValue({ enabled: true });
    const mod = await import('../agentbook-i18n-flag');
    await mod.isI18nLocalesEnabled();
    expect(mod.I18N_LOCALES_FLAG_KEY).toBe('agentbook.i18n.locales.enabled');
    expect(findUnique).toHaveBeenCalledWith({
      where: { key: 'agentbook.i18n.locales.enabled' },
    });
  });
});

describe('the gate, applied at resolution', () => {
  it('serves English strings to a tenant stored as fr-CA when the flag is off', async () => {
    // The scenario the gate exists for. Mirrors the shell's own logic: the
    // translation locale is forced to 'en' while FORMATTING keeps the tenant's.
    const { createTranslator } = await import('@agentbook/i18n');
    const { CATALOG } = await import('@agentbook/i18n/catalog');

    const tenantLocale = 'fr-CA';
    const flagOn = false;

    const gated = createTranslator(flagOn ? tenantLocale : 'en', CATALOG);
    expect(gated.t('agent.undo_success', { description: 'x' })).toBe('Undone: x');

    // Same key, ungated, proves the assertion above is not vacuous.
    const ungated = createTranslator(tenantLocale, CATALOG);
    expect(ungated.t('agent.undo_success', { description: 'x' })).toBe('Annulé : x');
  });

  it('does NOT gate formatting — those are shipped bug fixes', async () => {
    // Formatting must stay locale-correct with the flag off. Holding the date
    // fix behind the flag would keep a real bug (bill due dates rendering a day
    // early west of UTC) in production for no benefit.
    const { formatDateOnly, formatCurrency } = await import('@agentbook/i18n');
    expect(formatDateOnly('2026-03-22T00:00:00.000Z', 'fr-CA')).toMatch(/2026/);
    expect(formatCurrency(4550, 'fr-CA', 'CAD')).toContain('45');
  });
});
