/**
 * PR 5A.4 — the trackInventory toggle in Business Profile: offered to the
 * merchant/retail business types only, and the saved PUT carries the flag
 * (the flag is the gate, never businessType alone).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentBookSettingsPanel } from '@/components/settings/AgentBookSettingsPanel';

const BASE = {
  companyName: 'Acme', companyAddress: null, companyEmail: null, companyPhone: null,
  abn: null, logoUrl: null, brandColor: '#000000', defaultPaymentTerms: 'net-30',
  invoiceFooterNote: null, invoiceThankYouMessage: null, businessType: 'freelancer',
  gstRegistered: null, qstRegistered: null, gstReportingBasis: null, jurisdiction: 'ca', region: 'ON',
};
let puts: Array<Record<string, unknown>> = [];
function mount(cfg: Record<string, unknown>) {
  puts = [];
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(data) });
    if (url.includes('/agentbook-core/tenant-config')) {
      if (init?.method === 'PUT') { puts.push(JSON.parse(String(init.body))); return ok({ success: true, data: { ...BASE, ...cfg } }); }
      return ok({ data: { ...BASE, ...cfg } });
    }
    return ok({ success: true, data: {} });
  }) as unknown as typeof fetch;
  return render(<AgentBookSettingsPanel initialTab="profile" />);
}
afterEach(() => vi.restoreAllMocks());

/** The profile form has loaded this config: the company name input shows its value. */
const loaded = () => screen.findByDisplayValue('Acme');

describe('Business Profile — Track inventory (offered to merchant/retail only; gated on the flag)', () => {
  it.each(['merchant', 'retail'])('%s: shown, and saving sends trackInventory: true', async (businessType) => {
    mount({ businessType });
    const box = (await screen.findByTestId('inventory-toggle-input')) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    fireEvent.click(screen.getAllByRole('button').find((b) => /save/i.test(b.textContent ?? ''))!);
    await waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0].trackInventory).toBe(true);
  });

  it.each(['freelancer', 'consultant', 'agency', 'contractor', 'startup'])('%s with tracking off: hidden', async (businessType) => {
    mount({ businessType });
    await loaded();
    // The registration block beside it has rendered for this config, so absence is real.
    expect(screen.getByTestId('reg-basis')).toBeTruthy();
    expect(screen.queryByTestId('inventory-toggle')).toBeNull();
  });

  it('a non-retail tenant that already has the flag on still sees it (so it can turn it off)', async () => {
    mount({ businessType: 'consultant', trackInventory: true });
    expect(((await screen.findByTestId('inventory-toggle-input')) as HTMLInputElement).checked).toBe(true);
  });

  it('students do not see it', async () => {
    mount({ businessType: 'student' });
    await screen.findByText(/international student question/i);
    expect(screen.queryByTestId('inventory-toggle')).toBeNull();
  });
});
