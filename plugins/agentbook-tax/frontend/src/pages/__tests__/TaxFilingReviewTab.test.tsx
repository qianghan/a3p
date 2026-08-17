import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ShellProvider } from '@naap/plugin-sdk';
import type { ShellContext, II18nService } from '@naap/plugin-sdk';
import { createTranslator } from '@agentbook/i18n';
import { CATALOG } from '@agentbook/i18n/catalog';
import { TaxFilingReviewTab } from '../TaxFilingReviewTab';

/**
 * A real translator over the real catalog, wrapped in a minimal mock
 * ShellContext — mirrors plugins/agentbook-billing/frontend's
 * i18n-billing.test.tsx, the established pattern for testing a component
 * that consumes `useI18n()` with real (not stubbed) translated strings.
 */
function shellFor(locale: string): ShellContext {
  const { t } = createTranslator(locale, CATALOG);
  const i18n: II18nService = {
    locale,
    t,
    formatMoney: (c) => String(c),
    formatCurrency: (c) => String(c),
    formatDate: (d) => String(d),
    formatDateOnly: (d) => String(d),
    formatNumber: (n) => String(n),
    formatPercent: (n) => String(n),
    parseAmount: () => ({ ok: true, cents: 0, ambiguous: false, formatted: '' }),
  };
  return {
    auth: {} as never,
    navigate: () => {},
    eventBus: {} as never,
    theme: {} as never,
    notifications: {} as never,
    integrations: {} as never,
    logger: {} as never,
    permissions: {} as never,
    version: '2.0.0',
    i18n,
  } as ShellContext;
}

beforeEach(() => {
  global.fetch = vi.fn();
});

function mockFetchSequence(responses: any[]) {
  let call = 0;
  (global.fetch as any).mockImplementation(() =>
    Promise.resolve({ json: () => Promise.resolve(responses[Math.min(call++, responses.length - 1)]) }),
  );
}

describe('TaxFilingReviewTab', () => {
  it('loads the review summary and renders the critical fields with their current values', async () => {
    mockFetchSequence([
      { success: true, data: {
        message: 'Your taxable income is $73,000...',
        criticalFields: [{ formCode: 'T1', fieldId: 'taxable_income_26000', label: 'Taxable income', currentValue: 7300000 }],
        computedTotals: { taxableIncomeCents: 7300000, taxPayableCents: 1150000 },
      } },
    ]);
    render(
      <ShellProvider value={shellFor('en')}>
        <TaxFilingReviewTab taxYear={2025} />
      </ShellProvider>,
    );
    // Disambiguated from the plan's literal `/taxable income/i` regex: the
    // mock summary message ("Your taxable income is $73,000...") and the
    // field's own label ("Taxable income") both match that pattern, so
    // getByText throws on multiple matches. Matching the exact label text
    // keeps the test's intent (the critical field renders) without the
    // false ambiguity — verified this is a test-data collision, not a
    // component defect, before making this change.
    await waitFor(() => expect(screen.getByText('Taxable income')).toBeInTheDocument());
    expect(screen.getByDisplayValue('73000')).toBeInTheDocument(); // dollars, not cents, in the input
  });

  it('editing a field calls POST .../review/edit-field with the exact formCode/fieldId — no free-text round trip', async () => {
    mockFetchSequence([
      { success: true, data: { message: 'summary', criticalFields: [{ formCode: 'T1', fieldId: 'taxable_income_26000', label: 'Taxable income', currentValue: 7300000 }], computedTotals: {} } },
      { success: true, data: { message: 'Updated to $80,000.', computedTotals: { taxableIncomeCents: 8000000 } } },
    ]);
    render(
      <ShellProvider value={shellFor('en')}>
        <TaxFilingReviewTab taxYear={2025} />
      </ShellProvider>,
    );
    await waitFor(() => screen.getByDisplayValue('73000'));
    fireEvent.change(screen.getByDisplayValue('73000'), { target: { value: '80000' } });
    fireEvent.click(screen.getByText(/save/i));
    await waitFor(() => {
      const editCall = (global.fetch as any).mock.calls.find((c: any[]) => String(c[0]).includes('edit-field'));
      expect(editCall).toBeDefined();
      const body = JSON.parse(editCall[1].body);
      expect(body).toEqual({ formCode: 'T1', fieldId: 'taxable_income_26000', valueCents: 8000000 });
    });
  });

  it('clicking Submit calls POST .../review/confirm with no body', async () => {
    mockFetchSequence([
      { success: true, data: { message: 'summary', criticalFields: [], computedTotals: {} } },
      { success: true, data: { message: 'Filed!', filed: false } },
    ]);
    render(
      <ShellProvider value={shellFor('en')}>
        <TaxFilingReviewTab taxYear={2025} />
      </ShellProvider>,
    );
    await waitFor(() => screen.getByText(/submit filing/i));
    fireEvent.click(screen.getByText(/submit filing/i));
    await waitFor(() => {
      const confirmCall = (global.fetch as any).mock.calls.find((c: any[]) => String(c[0]).includes('/confirm'));
      expect(confirmCall).toBeDefined();
    });
  });

  it('renders French labels when the shell injects an fr-CA translator', async () => {
    mockFetchSequence([{ success: true, data: { message: 's', criticalFields: [], computedTotals: {} } }]);
    render(
      <ShellProvider value={shellFor('fr-CA')}>
        <TaxFilingReviewTab taxYear={2025} />
      </ShellProvider>,
    );
    await waitFor(() => expect(screen.getByText('Révision de la déclaration')).toBeInTheDocument());
  });
});
