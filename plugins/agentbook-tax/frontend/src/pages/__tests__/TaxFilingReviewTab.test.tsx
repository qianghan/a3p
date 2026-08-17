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

/**
 * Routes each request by URL rather than by call order.
 *
 * The component now reads review/status BEFORE deciding whether to start a
 * review, and separately fetches tenant-config for currency/locale, so a
 * positional sequence no longer describes the traffic — and a positional mock
 * would quietly hand the status check a review/start payload.
 */
function mockRoutes(routes: { match: string; body: any }[], fallback: any = { success: false }) {
  (global.fetch as any).mockImplementation((url: string) => {
    const u = String(url);
    const hit = routes.find((r) => u.includes(r.match));
    return Promise.resolve({ json: () => Promise.resolve(hit ? hit.body : fallback) });
  });
}

/** No review on file — the state read comes back empty. */
const NO_REVIEW = {
  match: 'review/status',
  body: { success: true, data: { status: null, active: false, confirmedAndFresh: false, summaryText: null, criticalFields: [], computedTotals: {} } },
};

function calls(): string[] {
  return (global.fetch as any).mock.calls.map((c: any[]) => String(c[0]));
}

describe('TaxFilingReviewTab', () => {
  it('loads the review summary and renders the critical fields with their current values', async () => {
    mockRoutes([
      NO_REVIEW,
      { match: 'review/start', body: { success: true, data: {
        message: 'Your taxable income is $73,000...',
        criticalFields: [{ formCode: 'T1', fieldId: 'taxable_income_26000', label: 'Taxable income', currentValue: 7300000 }],
        computedTotals: { taxableIncomeCents: 7300000, taxPayableCents: 1150000 },
      } } },
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
    mockRoutes([
      NO_REVIEW,
      { match: 'review/start', body: { success: true, data: { message: 'summary', criticalFields: [{ formCode: 'T1', fieldId: 'taxable_income_26000', label: 'Taxable income', currentValue: 7300000 }], computedTotals: {} } } },
      { match: 'review/edit-field', body: { success: true, data: { message: 'Updated to $80,000.', computedTotals: { taxableIncomeCents: 8000000 } } } },
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
    mockRoutes([
      NO_REVIEW,
      { match: 'review/start', body: { success: true, data: { message: 'summary', criticalFields: [], computedTotals: {} } } },
      { match: 'review/confirm', body: { success: true, data: { message: 'Filed!', filed: false } } },
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
    mockRoutes([NO_REVIEW, { match: 'review/start', body: { success: true, data: { message: 's', criticalFields: [], computedTotals: {} } } }]);
    render(
      <ShellProvider value={shellFor('fr-CA')}>
        <TaxFilingReviewTab taxYear={2025} />
      </ShellProvider>,
    );
    await waitFor(() => expect(screen.getByText('Révision de la déclaration')).toBeInTheDocument());
  });
});

/**
 * Opening this tab must not CHANGE anything.
 *
 * It used to POST review/start unconditionally on mount, which burned a Gemini
 * call every time the tab was opened AND upserted the row back to
 * 'summarizing' with confirmedAt/reviewedFormsHash cleared — silently
 * un-confirming a review the user had already approved, so the submit gate
 * demanded it all over again.
 */
describe('TaxFilingReviewTab does not mutate the review just by opening', () => {
  it('renders an in-progress review from its stored summary without calling review/start', async () => {
    mockRoutes([
      { match: 'review/status', body: { success: true, data: {
        status: 'summarizing', active: true, confirmedAndFresh: false,
        summaryText: 'Your taxable income is $73,000.',
        criticalFields: [{ formCode: 'T1', fieldId: 'taxable_income_26000', label: 'Taxable income', currentValue: 7300000 }],
        computedTotals: { taxableIncomeCents: 7300000 },
      } } },
    ]);
    render(
      <ShellProvider value={shellFor('en')}>
        <TaxFilingReviewTab taxYear={2025} />
      </ShellProvider>,
    );

    await waitFor(() => expect(screen.getByText('Your taxable income is $73,000.')).toBeInTheDocument());
    expect(calls().some((u) => u.includes('review/start'))).toBe(false);
    expect(screen.getByDisplayValue('73000')).toBeInTheDocument();
  });

  it('does NOT re-start (and so cannot un-confirm) an already-confirmed, fresh review', async () => {
    mockRoutes([
      { match: 'review/status', body: { success: true, data: {
        status: 'confirmed', active: false, confirmedAndFresh: true,
        summaryText: 'Filed — confirmation AB-123.',
        criticalFields: [], computedTotals: { taxPayableCents: 1150000 },
      } } },
    ]);
    render(
      <ShellProvider value={shellFor('en')}>
        <TaxFilingReviewTab taxYear={2025} />
      </ShellProvider>,
    );

    await waitFor(() => expect(screen.getByText('Filed — confirmation AB-123.')).toBeInTheDocument());
    expect(calls().some((u) => u.includes('review/start'))).toBe(false);
    // And it does not invite a second confirm the backend would 409.
    expect(screen.getByText(/submit filing/i).closest('button')).toBeDisabled();
  });

  it('reads review/status BEFORE review/start, in that order, when it does have to start one', async () => {
    mockRoutes([
      NO_REVIEW,
      { match: 'review/start', body: { success: true, data: { message: 'summary', criticalFields: [], computedTotals: {} } } },
    ]);
    render(
      <ShellProvider value={shellFor('en')}>
        <TaxFilingReviewTab taxYear={2025} />
      </ShellProvider>,
    );

    await waitFor(() => expect(calls().some((u) => u.includes('review/start'))).toBe(true));
    const urls = calls().filter((u) => u.includes('review/'));
    expect(urls[0]).toContain('review/status');
    expect(urls[1]).toContain('review/start');
  });

  it('surfaces a refused edit (409/400) instead of looking as though it saved', async () => {
    mockRoutes([
      NO_REVIEW,
      { match: 'review/start', body: { success: true, data: { message: 'summary', criticalFields: [{ formCode: 'T1', fieldId: 'taxable_income_26000', label: 'Taxable income', currentValue: 7300000 }], computedTotals: {} } } },
      { match: 'review/edit-field', body: { success: false, error: 'Invalid amount: must be a whole number of cents between 0 and 1000000000' } },
    ]);
    render(
      <ShellProvider value={shellFor('en')}>
        <TaxFilingReviewTab taxYear={2025} />
      </ShellProvider>,
    );
    await waitFor(() => screen.getByDisplayValue('73000'));
    fireEvent.change(screen.getByDisplayValue('73000'), { target: { value: '-500' } });
    fireEvent.click(screen.getByText(/save/i));
    await waitFor(() => expect(screen.getByText(/invalid amount/i)).toBeInTheDocument());
  });
});
