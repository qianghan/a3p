/**
 * PR 5A.4 — the trackInventory toggle in Business Profile: offered to every
 * non-student business, suggested when the description sells goods, and the
 * saved PUT carries the flag (the flag is the gate, never businessType alone).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentBookSettingsPanel } from '@/components/settings/AgentBookSettingsPanel';

const BASE = {
  companyName: 'Acme', companyAddress: null, companyEmail: null, companyPhone: null,
  abn: null, logoUrl: null, brandColor: '#000000', defaultPaymentTerms: 'net-30',
  invoiceFooterNote: null, invoiceThankYouMessage: null, businessType: 'freelancer',
  gstRegistered: null, qstRegistered: null, gstReportingBasis: null, jurisdiction: 'us', region: 'CA',
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

describe('Business Profile — Track inventory', () => {
  it('is offered to a non-student business and saves trackInventory: true', async () => {
    mount({});
    const box = (await screen.findByTestId('inventory-toggle-input')) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    fireEvent.click(screen.getAllByRole('button').find((b) => /save/i.test(b.textContent ?? ''))!);
    await waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0].trackInventory).toBe(true);
  });

  it('suggests it when the business sells goods', async () => {
    mount({ businessDescription: 'We run a small retail shop selling candles' });
    const toggle = await screen.findByTestId('inventory-toggle');
    // Rendered outside the shell, useT humanises the key, so compare keys' text.
    expect(toggle.textContent).toMatch(/suggested/i);
    expect(toggle.textContent).not.toMatch(/inventory help/i);
  });

  it('reflects an enabled flag', async () => {
    mount({ trackInventory: true });
    expect(((await screen.findByTestId('inventory-toggle-input')) as HTMLInputElement).checked).toBe(true);
  });

  it('students do not see it', async () => {
    mount({ businessType: 'student' });
    // The student-only block has rendered (outside the shell useT humanises the key).
    await screen.findByText(/international student question/i);
    expect(screen.queryByTestId('inventory-toggle')).toBeNull();
  });
});
