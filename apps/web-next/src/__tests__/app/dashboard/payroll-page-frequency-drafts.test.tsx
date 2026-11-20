/**
 * PR 4c — payroll list: each employee links to its profile, the frequency
 * shows the market label, and "Generate draft pay runs" posts the drafts
 * request and lists the run's payDate and frequency.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithI18n, i18nT, jsonResponse } from '../mobile/test-utils';
import PayrollPage from '@/app/(dashboard)/payroll/page';

let posts: Array<{ url: string; body: unknown }> = [];
let runs: unknown[] = [];

function mockFetch(jurisdiction: string) {
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      runs = [{ id: 'r1', periodStart: '2026-11-09T00:00:00.000Z', periodEnd: '2026-11-22T00:00:00.000Z', payDate: '2026-11-22T00:00:00.000Z', payFrequency: 'biweekly', status: 'draft', stubs: [] }];
      return jsonResponse(201, { success: true, data: { runs } });
    }
    if (url.includes('tenant-config')) return jsonResponse(200, { success: true, data: { jurisdiction, currency: 'AUD', locale: 'en-AU' } });
    if (url.endsWith('/employees')) return jsonResponse(200, { success: true, data: [{ id: 'e1', name: 'Pat', payType: 'salary', payRateCents: 6_500_000, payFrequency: 'biweekly', jurisdiction, region: '' }] });
    if (url.endsWith('/pay-runs')) return jsonResponse(200, { success: true, data: runs });
    return jsonResponse(200, { success: true, data: url.includes('year-end') ? { forms: [] } : [] });
  }) as unknown as typeof fetch;
}

beforeEach(() => { posts = []; runs = []; });

describe('payroll list (PR 4c)', () => {
  it('AU: Fortnightly label and a link to the employee profile', async () => {
    mockFetch('au');
    renderWithI18n(<PayrollPage />, 'en');
    const link = await screen.findByRole('link', { name: /Pat/ });
    expect(link.getAttribute('href')).toBe('/payroll/employees/e1');
    expect(screen.getByText(/Fortnightly/)).toBeInTheDocument();
  });

  it('CA in fr-CA: Aux deux semaines, not the AU wording', async () => {
    mockFetch('ca');
    renderWithI18n(<PayrollPage />, 'fr-CA');
    await screen.findByRole('link', { name: /Pat/ });
    expect(screen.getByText(/Aux deux semaines/)).toBeInTheDocument();
    expect(screen.queryByText(/quinzaine/)).toBeNull();
  });

  it('generates drafts and shows the pay date and frequency of the new run', async () => {
    mockFetch('us');
    renderWithI18n(<PayrollPage />, 'en');
    const t = i18nT('en');
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(t('core_ui.generate_draft_pay_runs')) }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: '/api/v1/agentbook-payroll/pay-runs', body: { generate: 'drafts' } });
    const line = await screen.findByText((_, el) => el?.tagName === 'P' && el.textContent === `${t('core_ui.pay_date_on', { date: new Date('2026-11-22T00:00:00.000Z').toLocaleDateString(undefined, { timeZone: 'UTC' }) })} · ${t('core_ui.bi_weekly')}`);
    expect(line).toBeInTheDocument();
  });
});
