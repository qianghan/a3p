import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MileagePage } from '../pages/Mileage';

// PARITY-8 regression coverage: the rate-preview tooltip must pick the
// CRA tier (72¢ vs 66¢, 5,000 km break) using the YTD total scoped to
// the unit currently being previewed — NOT a combined mi+km YTD sum.
// The real per-request calculation (apps/web-next/.../mileage/route.ts
// `ytdMilesOrKm()`) has always been unit-scoped; the preview regressed
// this by summing `summary.ytd.miles` across both units.

function summaryPayload(ytdByUnit: { mi: number; km: number }) {
  return {
    success: true,
    data: {
      entries: [],
      summary: {
        ytd: { miles: ytdByUnit.mi + ytdByUnit.km, deductibleCents: 0, entryCount: 0 },
        ytdByUnit,
        monthly: [],
        byClient: [],
        byPurpose: [],
      },
    },
  };
}

function installFetch(summary: unknown, jurisdiction: 'us' | 'ca' | 'au' | 'uk' = 'ca') {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/agentbook-expense/mileage?summary=true')) {
      return Promise.resolve({ ok: true, json: async () => summary } as any);
    }
    if (url.includes('/agentbook-invoice/clients')) {
      return Promise.resolve({ ok: true, json: async () => ({ data: [] }) } as any);
    }
    if (url.includes('/agentbook-core/tenant-config')) {
      return Promise.resolve({ ok: true, json: async () => ({ data: { currency: 'CAD', jurisdiction } }) } as any);
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as any);
  });
  globalThis.fetch = fetchMock as any;
  return fetchMock;
}

// The Unit <select> has no accessible label association (no htmlFor/id
// in the markup), so it can't be found via getByLabelText. It's the
// first <select> in document order (the Client picker is the second),
// distinguished here by its options.
function getUnitSelect(): HTMLSelectElement {
  const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
  const unitSelect = selects.find((s) =>
    Array.from(s.options).some((o) => o.value === 'mi') &&
    Array.from(s.options).some((o) => o.value === 'km'),
  );
  if (!unitSelect) throw new Error('Unit select not found');
  return unitSelect;
}

async function openForm() {
  fireEvent.click(screen.getByRole('button', { name: /log trip/i }));
  await waitFor(() => expect(screen.getByText(/estimated rate/i)).toBeInTheDocument());
}

describe('MileagePage — CRA tier preview', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mixed-unit tenant: scopes the preview tier to the previewed unit only, not the combined mi+km YTD', async () => {
    // 2,000 mi YTD (under the 5,000 break) but 6,000 km YTD (over the
    // break). Combined would be 8,000 — if the preview wrongly summed
    // across units, even the mi preview would show the high tier.
    installFetch(summaryPayload({ mi: 2000, km: 6000 }), 'ca');
    render(<MileagePage />);
    await openForm();

    // Default unit is 'mi' — should show the LOW tier (72¢), because
    // mi-only YTD (2,000) is under the break, even though the combined
    // total (8,000) is over it.
    expect(await screen.findByText(/72¢\/km \(CRA, first 5,000 km YTD\)/i)).toBeInTheDocument();

    // Switch to km — should show the HIGH tier (66¢), because km-only
    // YTD (6,000) is over the break.
    fireEvent.change(getUnitSelect(), { target: { value: 'km' } });
    expect(await screen.findByText(/66¢\/km \(CRA, over 5,000 km YTD\)/i)).toBeInTheDocument();
  });

  it('single-unit tenant (all km): preview is unaffected by the unit-scoping fix', async () => {
    // Every entry logged in km — scoping by unit changes nothing here,
    // this must keep behaving exactly as before.
    installFetch(summaryPayload({ mi: 0, km: 6000 }), 'ca');
    render(<MileagePage />);
    await openForm();

    fireEvent.change(getUnitSelect(), { target: { value: 'km' } });
    expect(await screen.findByText(/66¢\/km \(CRA, over 5,000 km YTD\)/i)).toBeInTheDocument();
  });

  it('single-unit tenant (all mi), under the break: preview is unaffected by the unit-scoping fix', async () => {
    installFetch(summaryPayload({ mi: 3000, km: 0 }), 'ca');
    render(<MileagePage />);
    await openForm();

    // Stays on default 'mi' unit.
    expect(await screen.findByText(/72¢\/km \(CRA, first 5,000 km YTD\)/i)).toBeInTheDocument();
  });

  it('US jurisdiction preview is unaffected (flat rate, no tiering)', async () => {
    installFetch(summaryPayload({ mi: 12000, km: 0 }), 'us');
    render(<MileagePage />);
    await openForm();
    expect(await screen.findByText(/67¢\/mi \(IRS standard rate\)/i)).toBeInTheDocument();
  });

  it('AU jurisdiction preview is unaffected (flat rate, no tiering)', async () => {
    installFetch(summaryPayload({ mi: 0, km: 12000 }), 'au');
    render(<MileagePage />);
    await openForm();
    expect(await screen.findByText(/88¢\/km \(ATO cents-per-km method\)/i)).toBeInTheDocument();
  });
});
