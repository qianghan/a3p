/** PR 2c — Settings › Business Profile restatement card: preview numbers, confirmed apply, result. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
vi.mock('@/hooks/use-t', async () => (await import('../../app/mobile/_i18n-mock')).useTMock);
import { TaxRestatementCard } from '@/components/settings/TaxRestatementCard';
import { AgentBookSettingsPanel } from '@/components/settings/AgentBookSettingsPanel';

const PREVIEW = {
  year: 2026, from: '2025-07-01', to: '2026-06-30', applicable: true,
  eligible: [{ expenseId: 'e1', date: '2026-03-10', description: 'Officeworks', amountCents: 11000, recoverableTaxCents: 1000, taxCode: 'GST' }],
  skipped: [{ expenseId: 'e2', date: '2025-09-01', description: 'Old', amountCents: 5500, recoverableTaxCents: 0, taxCode: 'GST', reason: 'period_closed' }],
  counts: { eligible: 1, skippedClosed: 1, skippedOther: 0, alreadyTyped: 2, noTaxAmount: 0 },
  recoverableTaxCents: 1000, expenseDeltaCents: -1000, netProfitDeltaCents: 1000,
};
const AFTER = { ...PREVIEW, eligible: [], counts: { ...PREVIEW.counts, eligible: 0, alreadyTyped: 3 }, recoverableTaxCents: 0, expenseDeltaCents: 0, netProfitDeltaCents: 0 };

function mockFetch() {
  let applied = false;
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    let data: unknown = {};
    if (url.includes('/agentbook-tax/restatement')) {
      if (init?.method === 'POST') { applied = true; data = { ...PREVIEW, restated: PREVIEW.eligible, failed: [], remaining: 0 }; }
      else data = applied ? AFTER : PREVIEW;
    } else if (url.includes('/agentbook-core/tenant-config')) {
      data = { companyName: 'Acme', businessType: 'freelancer', jurisdiction: 'au', region: 'NSW', gstRegistered: true, currency: 'AUD' };
    }
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve({ success: true, data }) });
  }) as unknown as typeof fetch;
  return calls;
}
afterEach(() => vi.restoreAllMocks());

describe('TaxRestatementCard', () => {
  it('previews, applies only after confirmation, shows the result and then nothing left', async () => {
    const calls = mockFetch();
    render(<TaxRestatementCard jurisdiction="ca" currency="CAD" />);
    expect((await screen.findByTestId('restatement-summary')).textContent).toBe('Purchases with recoverable tax still in expense: 1 (CA$10).');
    expect(screen.getByTestId('restatement-delta').textContent).toBe('Restating lowers expenses and raises net profit by CA$10.');
    expect(screen.getByTestId('restatement-closed').textContent).toBe('In closed months, left as they are: 1.');
    expect(screen.getAllByTestId('restatement-row')).toHaveLength(1);

    fireEvent.click(screen.getByTestId('restatement-apply'));
    expect(calls.some((c) => c.method === 'POST')).toBe(false); // the first click only asks
    expect(screen.getByTestId('restatement-confirm').textContent).toContain('Restate these purchases (1) for 2025-07-01 – 2026-06-30? CA$10 moves from expenses');
    fireEvent.click(screen.getByTestId('restatement-confirm-no'));
    expect(screen.queryByTestId('restatement-confirm')).toBeNull();

    fireEvent.click(screen.getByTestId('restatement-apply'));
    fireEvent.click(screen.getByTestId('restatement-confirm-yes'));
    await waitFor(() => expect(screen.getByTestId('restatement-result').textContent).toContain('Purchases restated: 1. CA$10 moved to your GST/HST account.'));
    const post = calls.find((c) => c.method === 'POST');
    expect(JSON.parse(post!.body!)).toEqual({ year: 2026 }); // the year the server named
    expect(calls[0].url).toBe('/api/v1/agentbook-tax/restatement'); // first preview asks the server for the current year
    await screen.findByTestId('restatement-nothing');
  });

  it('is mounted in Business Profile for an AU registrant', async () => {
    mockFetch();
    render(<AgentBookSettingsPanel initialTab="profile" />);
    expect(await screen.findByTestId('restatement-card')).toBeTruthy();
  });

  it('one Apply continues bounded batches until nothing remains, and reports failed rows', async () => {
    const posts: number[] = [];
    let n = 0;
    global.fetch = vi.fn((url: string, init?: RequestInit) => {
      let data: unknown = PREVIEW;
      if (init?.method === 'POST') {
        n++;
        posts.push(n);
        data = n === 1
          ? { ...PREVIEW, restated: [PREVIEW.eligible[0], PREVIEW.eligible[0]], recoverableTaxCents: 2000, failed: [], remaining: 3 }
          : { ...PREVIEW, restated: [PREVIEW.eligible[0]], recoverableTaxCents: 1000, failed: [PREVIEW.eligible[0]], remaining: 0 };
      }
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve({ success: true, data }) });
    }) as unknown as typeof fetch;
    render(<TaxRestatementCard jurisdiction="au" currency="AUD" />);
    fireEvent.click(await screen.findByTestId('restatement-apply'));
    fireEvent.click(screen.getByTestId('restatement-confirm-yes'));
    await waitFor(() => expect(screen.getByTestId('restatement-result').textContent).toContain('Purchases restated: 3. A$30 moved'));
    expect(posts).toEqual([1, 2]);
    expect(screen.getByTestId('restatement-failed').textContent).toBe('Could not restate: 1. They were left unchanged; try again.');
  });
});
