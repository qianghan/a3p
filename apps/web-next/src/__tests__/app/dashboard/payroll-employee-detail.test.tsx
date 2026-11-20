/**
 * PR 4c — employee detail/edit screen (spec §5.5).
 *
 * Rendered with the REAL translator (renderWithI18n), so every label asserted
 * here proves its catalog key exists in that locale.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { renderWithI18n, i18nT, jsonResponse } from '../mobile/test-utils';
import EmployeeDetail from '@/app/(dashboard)/payroll/employees/[id]/employee-detail';

type Call = { url: string; method: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
let putResponses: Array<[number, unknown]> = [];
let revealResponse: [number, unknown] = [200, { success: true, data: { field: 'taxId', value: '046454286' } }];

function employee(jurisdiction: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'e1', name: 'Pat Tagged', email: null, payType: 'salary', payRateCents: 6_500_000, payFrequency: 'biweekly',
    jurisdiction, region: jurisdiction === 'ca' ? 'ON' : jurisdiction === 'us' ? 'TX' : '', filingStatus: 'single', allowances: 0,
    phone: null, address: null, dateOfBirth: null, endDate: null, employmentBasis: 'full_time', payAnchorDate: '2026-01-05T00:00:00.000Z',
    taxFreeThreshold: true, residency: 'resident', helpDebt: false, td1Federal: 1_612_900, td1Provincial: null, cppExempt: false, eiExempt: false,
    extraWithholdingCents: null,
    sensitive: { hasTaxId: true, taxIdLast4: '4286', hasBankAccount: true, bankLast4: '6789', bankRoutingLabel: null, superFundUsi: null, superFundName: null, hasSuperMemberNumber: false },
    ...extra,
  };
}

function mockFetch(emp: unknown) {
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    if (url.endsWith('/reveal')) return jsonResponse(revealResponse[0], revealResponse[1]);
    if (method === 'PUT') {
      const [status, b] = putResponses.shift() ?? [200, { success: true, data: emp }];
      return jsonResponse(status, b);
    }
    if (emp === null) return jsonResponse(404, { success: false, error: 'employee not found' });
    return jsonResponse(200, { success: true, data: emp });
  }) as unknown as typeof fetch;
}

beforeEach(() => { calls = []; putResponses = []; revealResponse = [200, { success: true, data: { field: 'taxId', value: '046454286' } }]; });

describe('labels per market per locale', () => {
  it.each([
    ['au', 'en', ['tax_file_number_tfn', 'superannuation', 'residency_for_tax', 'tax_free_threshold_claimed', 'bsb'], ['social_insurance_number_sin', 'w4_filing_status']],
    ['ca', 'fr-CA', ['social_insurance_number_sin', 'td1_federal_claim_amount', 'cpp_or_qpp_exempt', 'transit_and_institution_number', 'benefits'], ['tax_file_number_tfn', 'superannuation']],
    ['us', 'zh-CN', ['social_security_number_ssn', 'w4_filing_status', 'extra_withholding_per_pay_period', 'aba_routing_number'], ['tax_file_number_tfn', 'td1_federal_claim_amount']],
  ])('%s in %s shows the market’s fields only', async (j, locale, present, absent) => {
    mockFetch(employee(j));
    renderWithI18n(<EmployeeDetail id="e1" />, locale);
    const t = i18nT(locale);
    await screen.findByRole('heading', { name: t('core_ui.employee_profile') });
    for (const k of present) expect(screen.getAllByText(t(`core_ui.${k}`)).length).toBeGreaterThan(0);
    for (const k of absent) expect(screen.queryByText(t(`core_ui.${k}`))).toBeNull();
  });

  it('frequency select uses the market label: Fortnightly in AU, Bi-weekly in CA (fr-CA wording)', async () => {
    mockFetch(employee('au'));
    const { unmount } = renderWithI18n(<EmployeeDetail id="e1" />, 'en');
    const sel = await screen.findByLabelText('Pay frequency') as HTMLSelectElement;
    expect(sel.value).toBe('biweekly');
    expect(within(sel).getByRole('option', { name: 'Fortnightly' })).toBeInTheDocument();
    unmount();
    mockFetch(employee('ca'));
    renderWithI18n(<EmployeeDetail id="e1" />, 'fr-CA');
    const sel2 = await screen.findByLabelText('Fréquence de paie') as HTMLSelectElement;
    expect(within(sel2).getByRole('option', { name: 'Aux deux semaines' })).toBeInTheDocument();
    expect(within(sel2).queryByRole('option', { name: /quinzaine/ })).toBeNull();
  });
});

describe('editing', () => {
  it('sends only changed fields; a frequency edit is a PUT of payFrequency; masked values are never echoed', async () => {
    mockFetch(employee('us'));
    renderWithI18n(<EmployeeDetail id="e1" />, 'en');
    const sel = await screen.findByLabelText('Pay frequency');
    fireEvent.change(sel, { target: { value: 'monthly' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Profile saved');
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe('/api/v1/agentbook-payroll/employees/e1');
    expect(put.body).toEqual({ payFrequency: 'monthly' });
  });

  it('typing the masked rendering into a sensitive field does not send it', async () => {
    mockFetch(employee('us'));
    renderWithI18n(<EmployeeDetail id="e1" />, 'en');
    const acct = await screen.findByLabelText('Account number');
    expect((acct as HTMLInputElement).value).toBe('');
    expect((acct as HTMLInputElement).placeholder).toBe('•••• 6789');
    fireEvent.change(acct, { target: { value: '•••• 6789' } });
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '555-0100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Profile saved');
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ phone: '555-0100' });
  });

  it('a new sensitive value and money fields are sent in the API’s units', async () => {
    mockFetch(employee('ca'));
    renderWithI18n(<EmployeeDetail id="e1" />, 'en');
    fireEvent.change(await screen.findByLabelText('Social insurance number (SIN)'), { target: { value: '046 454 286' } });
    fireEvent.change(screen.getByLabelText('TD1 federal claim amount'), { target: { value: '16500.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Profile saved');
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ taxId: '046 454 286', td1Federal: 1_650_050 });
  });
});

describe('jurisdiction selector', () => {
  it('shows the stored value, and changing it PUTs only { jurisdiction } with the market switched', async () => {
    const stored = employee('us');
    mockFetch(stored);
    putResponses = [[200, { success: true, data: employee('au') }]];
    renderWithI18n(<EmployeeDetail id="e1" />, 'en');
    const sel = await screen.findByLabelText('Country') as HTMLSelectElement;
    expect(sel.value).toBe('us');
    fireEvent.change(sel, { target: { value: 'au' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Profile saved');
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ jurisdiction: 'au' });
    // After the save the AU field set renders (TFN), not W-4.
    expect(await screen.findByLabelText('Tax file number (TFN)')).toBeInTheDocument();
  });
});

describe('503 pii_key_unconfigured', () => {
  it('shows the unavailable state, disables sensitive inputs, and still saves the non-sensitive edit', async () => {
    mockFetch(employee('au'));
    putResponses = [[503, { success: false, code: 'pii_key_unconfigured', error: 'x' }]];
    renderWithI18n(<EmployeeDetail id="e1" />, 'en');
    fireEvent.change(await screen.findByLabelText('Tax file number (TFN)'), { target: { value: '123456782' } });
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '0400 000 000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const t = i18nT('en');
    await screen.findByText(t('core_ui.sensitive_fields_unavailable'));
    await screen.findByText('Profile saved');
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts.map((p) => p.body)).toEqual([{ taxId: '123456782', phone: '0400 000 000' }, { phone: '0400 000 000' }]);
    expect((screen.getByLabelText('Tax file number (TFN)') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Reveal' })).toBeNull();
  });
});

describe('reveal', () => {
  it('reveals only on an explicit click, and re-masks on Hide', async () => {
    mockFetch(employee('ca'));
    renderWithI18n(<EmployeeDetail id="e1" />, 'en');
    await screen.findByText('On file, ending 4286');
    expect(calls.some((c) => c.url.endsWith('/reveal'))).toBe(false);
    expect(screen.queryByText('046454286')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Reveal' })[0]);
    await screen.findByText('046454286');
    expect(calls.find((c) => c.url.endsWith('/reveal'))!.body).toEqual({ field: 'taxId' });
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    await waitFor(() => expect(screen.queryByText('046454286')).toBeNull());
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
  });

  it('unmounting while revealed clears the re-mask timer', async () => {
    mockFetch(employee('ca'));
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const { unmount } = renderWithI18n(<EmployeeDetail id="e1" />, 'en');
    await screen.findByText('On file, ending 4286');
    fireEvent.click(screen.getAllByRole('button', { name: 'Reveal' })[0]);
    await screen.findByText('046454286');
    const before = clear.mock.calls.length;
    unmount();
    expect(clear.mock.calls.length).toBeGreaterThan(before);
    clear.mockRestore();
  });

  it('403 shows the owner-only message and no value', async () => {
    mockFetch(employee('ca'));
    revealResponse = [403, { success: false, error: 'only the account owner can reveal employee details' }];
    renderWithI18n(<EmployeeDetail id="e1" />, 'en');
    await screen.findByText('On file, ending 4286');
    fireEvent.click(screen.getAllByRole('button', { name: 'Reveal' })[0]);
    await screen.findByText('Only the account owner can reveal this.');
  });
});

it('404 (deleted employee) shows not found', async () => {
  mockFetch(null);
  renderWithI18n(<EmployeeDetail id="gone" />, 'en');
  await screen.findByText('Employee not found');
});
