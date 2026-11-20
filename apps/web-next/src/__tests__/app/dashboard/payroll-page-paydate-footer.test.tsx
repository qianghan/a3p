/**
 * PR 4d — payroll statutory tabs carry the "reports use the pay date" footer.
 * The STP tab is AU-only and shows the prepared pay event (per-employee YTD
 * gross / PAYG-withheld / super + employer totals), with a "prepared, not
 * lodged" disclosure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

import enCore from '../../../../../../packages/agentbook-i18n/src/locales/en/core_ui.json';
import frCore from '../../../../../../packages/agentbook-i18n/src/locales/fr-CA/core_ui.json';
import zhCore from '../../../../../../packages/agentbook-i18n/src/locales/zh-CN/core_ui.json';

describe('Payroll page — pay-date footer (PR 4d)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('shows the footer on Tax deposits, Year-end and STP, not on Employees', async () => {
    mockFetch('au');
    render(<PayrollPage />);
    await screen.findByRole('button', { name: /STP/i });
    expect(screen.queryByTestId('payroll-pay-date-footer')).toBeNull();
    for (const name of [/Tax deposits/i, /Year-end/i, /STP/i]) {
      fireEvent.click(screen.getByRole('button', { name }));
      await waitFor(() => expect(screen.getByTestId('payroll-pay-date-footer')).toBeTruthy());
    }
  });

  it('the footer is translated in fr-CA (U+2019) and zh-CN', () => {
    expect(enCore.payroll_reports_use_pay_date).toContain('pay date');
    expect(frCore.payroll_reports_use_pay_date).toContain('date de paie');
    expect(frCore.payroll_reports_use_pay_date).toContain('’');
    expect(frCore.payroll_reports_use_pay_date).not.toContain("'");
    expect(zhCore.payroll_reports_use_pay_date).toContain('发薪日期');
  });
});
