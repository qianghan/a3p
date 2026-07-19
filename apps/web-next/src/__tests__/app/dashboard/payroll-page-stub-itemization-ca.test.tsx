/**
 * Payroll page — CA pay-stub itemization (PARITY-6, Task 2).
 *
 * Root cause: a CA/Quebec pay stub's `ficaCents` is CPP/QPP + EI (+ QPIP)
 * combined into one figure (see calcCA in apps/web-next/src/lib/
 * payroll-engine.ts) — the per-stub summary line showed only one combined
 * "FICA/NI" figure even though `splitCaDeductions()` already computes the
 * real, separately-reportable components. This itemizes the per-stub line
 * back out into CPP/QPP + EI (+ QPIP) using `itemizeCaStub()`, which
 * annualizes via the employee's own pay frequency (mirroring calcCA's own
 * `annual = grossCents * payPeriodsPerYear` convention) and divides the
 * split back down to a per-period figure.
 *
 * Employees below use a monthly pay frequency (12 periods/year) and a
 * $90,000 annual salary so the annualized split matches the same
 * splitCaDeductions(90_000_00, region) fixture worked-example values used
 * in Task 1's test and in apps/web-next/src/lib/__tests__/
 * payroll-engine.test.ts — only divided by 12 and re-rounded here.
 * Per-period cents were computed as Math.round(annualSplitCents / 12), then
 * formatted with formatCurrencyCents (which itself further rounds to whole
 * dollars — maximumFractionDigits: 0) — both rounding steps were verified
 * numerically before writing these assertions:
 *   ON:  CPP 386_750/12 -> 32_229c -> $322,  EI 104_912/12 -> 8_743c -> $87
 *   QC:  QPP 433_920/12 -> 36_160c -> $362,  EI 86_067/12  -> 7_172c -> $72,
 *        QPIP 44_460/12 -> 3_705c  -> $37
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

import PayrollPage from '@/app/(dashboard)/payroll/page';

function jsonResponse(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(data) });
}

function stubRowFor(employeeName: string): HTMLElement {
  const nameEl = screen.getByText(employeeName);
  const row = nameEl.closest('div');
  if (!row) throw new Error(`could not find wrapping row for ${employeeName}`);
  return row as HTMLElement;
}

describe('Payroll page — CA pay-stub itemization (PARITY-6)', () => {
  beforeEach(() => {
    global.fetch = vi.fn((url: string) => {
      if (url.includes('/employees')) {
        return jsonResponse({
          success: true,
          data: [
            { id: 'emp-on', name: 'Jane ON', payType: 'salary', payRateCents: 9_000_000, payFrequency: 'monthly', jurisdiction: 'ca', region: 'ON' },
            { id: 'emp-qc', name: 'Marie QC', payType: 'salary', payRateCents: 9_000_000, payFrequency: 'monthly', jurisdiction: 'ca', region: 'QC' },
          ],
        });
      }
      if (url.includes('/pay-runs')) {
        return jsonResponse({
          success: true,
          data: [
            {
              id: 'run-1',
              periodStart: '2025-06-01',
              periodEnd: '2025-06-30',
              status: 'paid',
              stubs: [
                { id: 'stub-on', employeeName: 'Jane ON', grossCents: 750_000, federalTaxCents: 50_000, stateTaxCents: 0, ficaCents: 40_972, netCents: 659_028, sgCents: 0 },
                { id: 'stub-qc', employeeName: 'Marie QC', grossCents: 750_000, federalTaxCents: 50_000, stateTaxCents: 0, ficaCents: 47_037, netCents: 652_963, sgCents: 0 },
              ],
            },
          ],
        });
      }
      if (url.includes('/tax-deposits')) return jsonResponse({ success: true, data: [] });
      if (url.includes('/year-end')) return jsonResponse({ success: true, data: { forms: [] } });
      return jsonResponse({ success: true, data: [] });
    }) as unknown as typeof fetch;
  });

  it('itemizes CPP + EI (not one combined FICA/NI figure) for a non-Quebec CA employee stub', async () => {
    render(<PayrollPage />);
    fireEvent.click(await screen.findByText('Pay runs'));

    await waitFor(() => {
      expect(screen.getByText('Jane ON')).toBeInTheDocument();
    });
    const row = stubRowFor('Jane ON');
    expect(within(row).getByText(/CPP \$322/i)).toBeInTheDocument();
    expect(within(row).getByText(/EI \$87/i)).toBeInTheDocument();
    expect(within(row).queryByText(/FICA\/NI/i)).not.toBeInTheDocument();
  });

  it('itemizes QPP + EI + QPIP (not CPP, not one combined FICA/NI figure) for a Quebec employee stub', async () => {
    render(<PayrollPage />);
    fireEvent.click(await screen.findByText('Pay runs'));

    await waitFor(() => {
      expect(screen.getByText('Marie QC')).toBeInTheDocument();
    });
    const row = stubRowFor('Marie QC');
    expect(within(row).getByText(/QPP \$362/i)).toBeInTheDocument();
    expect(within(row).getByText(/EI \$72/i)).toBeInTheDocument();
    expect(within(row).getByText(/QPIP \$37/i)).toBeInTheDocument();
    expect(within(row).queryByText(/CPP \$/i)).not.toBeInTheDocument();
    expect(within(row).queryByText(/FICA\/NI/i)).not.toBeInTheDocument();
  });
});
