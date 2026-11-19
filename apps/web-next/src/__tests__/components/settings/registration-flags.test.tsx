/**
 * Business Profile registration flags (PR 2b.4): conditional visibility per
 * jurisdiction and the unanswered-registration prompt.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentBookSettingsPanel } from '@/components/settings/AgentBookSettingsPanel';

const BASE = {
  companyName: 'Acme', companyAddress: null, companyEmail: null, companyPhone: null,
  abn: null, logoUrl: null, brandColor: '#000000', defaultPaymentTerms: 'net-30',
  invoiceFooterNote: null, invoiceThankYouMessage: null, businessType: 'freelancer',
  gstRegistered: null, qstRegistered: null, gstReportingBasis: null,
};

let puts: Array<Record<string, unknown>> = [];
function mount(cfg: Record<string, unknown>) {
  puts = [];
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    const ok = (data: unknown) =>
      Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(data) });
    if (url.includes('/agentbook-core/tenant-config')) {
      if (init?.method === 'PUT') { puts.push(JSON.parse(String(init.body))); return ok({ success: true, data: { ...BASE, ...cfg } }); }
      return ok({ data: { ...BASE, ...cfg } });
    }
    return ok({ success: true, data: {} });
  }) as unknown as typeof fetch;
  return render(<AgentBookSettingsPanel initialTab="profile" />);
}
const has = (id: string) => screen.queryByTestId(id) !== null;

afterEach(() => vi.restoreAllMocks());

describe('registration flags visibility', () => {
  it('US: hides all three', async () => {
    mount({ jurisdiction: 'us', region: 'CA' });
    await screen.findByDisplayValue('Acme');
    expect(has('reg-gst')).toBe(false);
    expect(has('reg-qst')).toBe(false);
    expect(has('reg-basis')).toBe(false);
  });
  it('AU: GST + reporting basis, no QST, prompt while unanswered', async () => {
    mount({ jurisdiction: 'au', region: 'NSW' });
    await screen.findByTestId('reg-gst');
    expect(has('reg-basis')).toBe(true);
    expect(has('reg-qst')).toBe(false);
    expect(has('reg-prompt')).toBe(true);
  });
  it('CA outside Quebec: GST + basis, no QST', async () => {
    mount({ jurisdiction: 'ca', region: 'ON' });
    await screen.findByTestId('reg-gst');
    expect(has('reg-basis')).toBe(true);
    expect(has('reg-qst')).toBe(false);
  });
  it('CA Quebec: all three', async () => {
    mount({ jurisdiction: 'ca', region: 'QC' });
    await screen.findByTestId('reg-qst');
    expect(has('reg-gst')).toBe(true);
    expect(has('reg-basis')).toBe(true);
  });
  it('no prompt once GST registration is answered', async () => {
    mount({ jurisdiction: 'au', region: 'NSW', gstRegistered: false });
    await screen.findByTestId('reg-gst');
    expect(has('reg-prompt')).toBe(false);
  });
  it('saves the chosen basis and QST answer in the PUT body', async () => {
    mount({ jurisdiction: 'ca', region: 'QC' });
    const basis = await screen.findByTestId('reg-basis-select');
    fireEvent.change(basis, { target: { value: 'cash' } });
    fireEvent.change(screen.getByTestId('reg-qst-select'), { target: { value: 'yes' } });
    fireEvent.click(screen.getAllByRole('button').find((b) => /save/i.test(b.textContent ?? ''))!);
    await waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0].gstReportingBasis).toBe('cash');
    expect(puts[0].qstRegistered).toBe(true);
  });
});

import { isQuebecRegion } from '@/lib/region-codes';
import { CATALOG } from '@agentbook/i18n/catalog';

describe('isQuebecRegion', () => {
  it.each(['QC', 'qc', ' QC ', 'Quebec', 'quebec', 'Québec', 'québec', 'QUÉBEC', 'Québec'])('accepts %s', (v) => {
    expect(isQuebecRegion(v)).toBe(true);
  });
  it.each(['ON', 'Ontario', '', null, undefined, 'Quebec City'])('rejects %s', (v) => {
    expect(isQuebecRegion(v as string | null | undefined)).toBe(false);
  });
});

describe('CA wording is not Australian (per locale)', () => {
  const key = 'gst_registered_label_ca';
  it.each(['en', 'fr-CA', 'zh-CN'])('%s CA label', (loc) => {
    const v = (CATALOG[loc] as Record<string, Record<string, string>>).core_ui[key];
    expect(v).toMatch(/GST|TPS/);
    expect(v).not.toMatch(/austral|澳大利亚|Australia/i);
  });
});

describe('CA render in Quebec spelled out', () => {
  it('shows QST for region "Québec"', async () => {
    mount({ jurisdiction: 'ca', region: 'Québec' });
    await screen.findByTestId('reg-qst');
  });
  it('CA does not render the Australian hint', async () => {
    mount({ jurisdiction: 'ca', region: 'ON' });
    await screen.findByTestId('reg-gst');
    expect(screen.getByTestId('reg-gst').textContent).not.toMatch(/Gst registered au hint/);
  });
});
