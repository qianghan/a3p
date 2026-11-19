import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { withShell } from './i18n-harness';
import { BillsPage } from '../pages/Bills';
import { createTranslator } from '@agentbook/i18n';
import { CATALOG } from '@agentbook/i18n/catalog';

/**
 * PR 3bc review I2 — a refused payment (closed period, missing account,
 * already paid) shows the server's reason, localized, and the bill stays open.
 */
const BILL = { id: 'b1', vendorName: 'Telstra', description: null, amountCents: 8800, dueDate: '2026-12-01', status: 'open', effectiveStatus: 'open', paidDate: null };
let payReply: { status: number; body: Record<string, unknown> };

beforeEach(() => {
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('action=pay') && init?.method === 'POST') {
      return { ok: payReply.status < 400, status: payReply.status, json: async () => payReply.body };
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: [BILL], summary: { openCents: 8800, overdueCents: 0, count: 1 } }) };
  }));
});
afterEach(() => vi.unstubAllGlobals());

async function clickPay(locale = 'en') {
  render(withShell(<BillsPage />, locale));
  const { t } = createTranslator(locale, CATALOG);
  fireEvent.click(await screen.findByRole('button', { name: t('expenses_ui.pay') }));
  return t;
}

describe('Bills — pay refused', () => {
  it('422 period_closed shows the closed-period message; Pay stays available', async () => {
    payReply = { status: 422, body: { success: false, code: 'period_closed', error: 'Fiscal period 2026-11 is closed' } };
    const t = await clickPay();
    expect(await screen.findByText(t('expenses_ui.bill_payment_period_closed'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('expenses_ui.pay') })).toBeTruthy();
  });

  it('422 ledger_account_missing (fr-CA) shows the French message', async () => {
    payReply = { status: 422, body: { success: false, code: 'ledger_account_missing' } };
    const t = await clickPay('fr-CA');
    const msg = t('expenses_ui.bill_payment_account_missing');
    expect(msg).toMatch(/plan comptable/);
    expect(await screen.findByText(msg)).toBeTruthy();
  });

  it('409 shows the conflict message', async () => {
    payReply = { status: 409, body: { success: false, code: 'bill_already_paid' } };
    const t = await clickPay();
    expect(await screen.findByText(t('expenses_ui.bill_payment_conflict'))).toBeTruthy();
  });

  it('a successful pay shows no error', async () => {
    payReply = { status: 200, body: { success: true, data: { ...BILL, status: 'paid' } } };
    const t = await clickPay();
    await waitFor(() => expect(screen.queryByText(t('expenses_ui.bill_payment_failed'))).toBeNull());
    expect(screen.queryByText(t('expenses_ui.bill_payment_period_closed'))).toBeNull();
  });
});
