/**
 * Payroll page — AU Single Touch Payroll (STP) tab (Wave 2 surfacing).
 * The STP tab is AU-only and shows the prepared pay event (per-employee YTD
 * gross / PAYG-withheld / super + employer totals), with a "prepared, not
 * lodged" disclosure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import PayrollPage from '@/app/(dashboard)/payroll/page';

function jsonResponse(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(data) });
}

function mockFetch(jurisdiction: string) {
  global.fetch = vi.fn((url: string) => {
    if (url.includes('/au/stp')) {
      return jsonResponse({
        success: true,
        data: {
          payRunId: 'run1', financialYear: 2026,
          period: { start: '2026-03-01', end: '2026-03-14' },
          payees: [{ employeeId: 'e1', name: 'Ann Employee', ytdGrossCents: 6_000_000, ytdPaygWithheldCents: 1_200_000, ytdSuperCents: 720_000 }],
          employerTotals: { ytdGrossCents: 6_000_000, ytdPaygWithheldCents: 1_200_000, ytdSuperCents: 720_000, payeeCount: 1 },
          lodgment: 'prepared',
        },
      });
    }
    if (url.includes('tenant-config')) return jsonResponse({ success: true, data: { jurisdiction, currency: jurisdiction === 'au' ? 'AUD' : 'USD', locale: 'en-AU' } });
    return jsonResponse({ success: true, data: url.includes('year-end') ? { forms: [] } : [] });
  }) as unknown as typeof fetch;
}

describe('Payroll page — AU STP tab', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('shows the STP tab for an AU tenant and renders the prepared pay event', async () => {
    mockFetch('au');
    render(<PayrollPage />);
    const stpTab = await screen.findByRole('button', { name: /STP/i });
    fireEvent.click(stpTab);
    await waitFor(() => expect(screen.getByText('Ann Employee')).toBeInTheDocument());
    const row = screen.getByText('Ann Employee').closest('tr') as HTMLElement;
    expect(within(row).getByText(/\$60,000/)).toBeInTheDocument();     // YTD gross
    expect(within(row).getByText(/\$12,000/)).toBeInTheDocument();     // PAYG withheld
    // Prepared-not-lodged disclosure is present (assert a contiguous run —
    // the word "not" sits in its own <b> tag, so a cross-node regex won't match).
    expect(screen.getByText(/lodge it to the ATO/i)).toBeInTheDocument();
  });

  it('does NOT show the STP tab for a US tenant', async () => {
    mockFetch('us');
    render(<PayrollPage />);
    // Wait for load to finish (employees tab renders), then assert no STP tab.
    await screen.findByRole('button', { name: /Employees/i });
    expect(screen.queryByRole('button', { name: /^STP$/i })).not.toBeInTheDocument();
  });
});
