/** PR 3bc.8 / review I1: Settings explains the reports fallback next to the reporting-basis control. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
vi.mock('@/hooks/use-t', async () => (await import('../../app/mobile/_i18n-mock')).useTMock);
import { AgentBookSettingsPanel } from '@/components/settings/AgentBookSettingsPanel';

const BASE = {
  companyName: 'Acme', companyAddress: null, companyEmail: null, companyPhone: null, abn: null, logoUrl: null,
  brandColor: '#000000', defaultPaymentTerms: 'net-30', invoiceFooterNote: null, invoiceThankYouMessage: null,
  businessType: 'freelancer', gstRegistered: true, qstRegistered: null, jurisdiction: 'au', region: 'NSW',
};
function mount(cfg: Record<string, unknown>, cashBasisDisabled: unknown) {
  global.fetch = vi.fn((url: string) => Promise.resolve({
    ok: true, status: 200, headers: new Headers(),
    json: () => Promise.resolve(url.includes('/agentbook-core/tenant-config')
      ? { success: true, data: { ...BASE, ...cfg }, cashBasisDisabled }
      : { success: true, data: {} }),
  })) as unknown as typeof fetch;
  return render(<AgentBookSettingsPanel initialTab="profile" />);
}
afterEach(() => vi.restoreAllMocks());
const BLOCK = { reason: 'open_at_entry_bills', openAtEntryBillCount: 2 };

describe('reporting-basis note for open bills', () => {
  it('cash selected + open at_entry bills → note with count', async () => {
    mount({ gstReportingBasis: 'cash' }, BLOCK);
    const note = await screen.findByTestId('reg-basis-open-bills');
    expect(note.textContent).toBe('Open bills: 2. Until they are paid, your P&L and balance sheet use accrual basis. Your sales tax return still counts purchases when they are paid.');
  });
  it('appears when the user switches the select to cash', async () => {
    mount({ gstReportingBasis: 'accrual' }, BLOCK);
    const sel = await screen.findByTestId('reg-basis-select');
    expect(screen.queryByTestId('reg-basis-open-bills')).toBeNull();
    fireEvent.change(sel, { target: { value: 'cash' } });
    await waitFor(() => expect(screen.getByTestId('reg-basis-open-bills')).toBeTruthy());
  });
  it('cash selected, no open bills → no note', async () => {
    mount({ gstReportingBasis: 'cash' }, null);
    await screen.findByTestId('reg-basis-select');
    expect(screen.queryByTestId('reg-basis-open-bills')).toBeNull();
  });
});
