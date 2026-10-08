import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, within, waitFor } from '@testing-library/react';
import type { MobileHome } from '@/lib/mobile/types';
import { KpiStrip, kpiCents } from '@/app/app/_home/KpiStrip';
import { useAlertAction } from '@/app/app/_home/useAlertAction';
import { ToastHost } from '@/app/app/_kit/Toast';
import { renderWithI18n, routeFetch, jsonResponse, expectTouchTarget } from './test-utils';
import { homeFixture } from './fixtures';
import { formatCurrencyCents } from '@/lib/jurisdiction-currency';

function Harness({ data, onDone = () => {} }: { data: MobileHome; onDone?: () => void }) {
  const actions = useAlertAction(onDone);
  return <KpiStrip data={data} actions={actions} />;
}

function renderStrip(data: MobileHome, locale = 'en', onDone?: () => void) {
  return renderWithI18n(<ToastHost><Harness data={data} onDone={onDone} /></ToastHost>, locale);
}

const region = () => screen.getByRole('region', { name: 'Key numbers' });
const tile = (id: string) => document.querySelector(`[data-kpi="${id}"]`) as HTMLElement;

describe('KpiStrip', () => {
  it('shows four tiles in order with labels and CAD amounts', () => {
    renderStrip(homeFixture());
    const ids = Array.from(region().querySelectorAll('[data-kpi]')).map((el) => el.getAttribute('data-kpi'));
    expect(ids).toEqual(['month_net', 'cash', 'outstanding', 'tax']);
    expect(tile('month_net')).toHaveTextContent('Net this month');
    expect(tile('month_net')).toHaveTextContent('CA$4,123');
    expect(tile('cash')).toHaveTextContent('Cash today');
    expect(tile('cash')).toHaveTextContent('CA$12,500');
    expect(tile('outstanding')).toHaveTextContent('Outstanding');
    expect(tile('outstanding')).toHaveTextContent('CA$9,800');
    expect(tile('outstanding')).toHaveTextContent('2 overdue · CA$3,800');
    expect(tile('tax')).toHaveTextContent('Estimated tax');
    expect(tile('tax')).toHaveTextContent('CA$6,150');
  });

  it('every tile is a ≥44px button that opens a dialog', () => {
    renderStrip(homeFixture());
    for (const id of ['month_net', 'cash', 'outstanding', 'tax']) {
      expectTouchTarget(tile(id));
      expect(tile(id)).toHaveAttribute('aria-haspopup', 'dialog');
    }
  });

  it('a figure that does not exist is a labelled dash, never a zero', () => {
    renderStrip(homeFixture({ kpis: { ...homeFixture().kpis, cashTodayCents: null, estTaxOwedCents: null } }));
    expect(within(tile('cash')).getByLabelText('Not available')).toHaveTextContent('—');
    expect(within(tile('tax')).getByLabelText('Not available')).toBeInTheDocument();
    expect(tile('tax')).not.toHaveTextContent('$0');
  });

  it('no overdue line when nothing is overdue', () => {
    renderStrip(homeFixture({ kpis: { ...homeFixture().kpis, overdueCount: 0, overdueCents: 0 } }));
    expect(tile('outstanding')).not.toHaveTextContent('overdue');
  });

  it('Outstanding sheet: totals, the overdue list from alerts, and Remind in place', async () => {
    const fetchMock = routeFetch({
      '/api/v1/agentbook-invoice/invoices/inv-1/remind': () => jsonResponse(200, { success: true, data: {} }),
    });
    const onDone = vi.fn();
    renderStrip(homeFixture(), 'en', onDone);
    fireEvent.click(tile('outstanding'));
    const dialog = screen.getByRole('dialog', { name: 'Outstanding' });
    expect(dialog).toHaveTextContent('CA$9,800');
    expect(dialog).toHaveTextContent('Overdue invoices');
    expect(within(dialog).getByText('2')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('CA$3,800');
    const row = within(dialog).getByRole('list', { name: 'Overdue invoice list' }).querySelector('li') as HTMLElement;
    expect(row).toHaveTextContent('Acme');
    expect(row).toHaveTextContent('12 days overdue · CA$1,800');
    fireEvent.click(within(row).getByRole('button', { name: 'Remind' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status', { name: 'Notifications' })).toHaveTextContent('Reminder logged');
  });

  it('Outstanding sheet Remind keeps keyboard focus inside the modal: aria-disabled + aria-busy, never disabled', async () => {
    let answer!: (r: Response) => void;
    const fetchMock = routeFetch({
      '/api/v1/agentbook-invoice/invoices/inv-1/remind': () => new Promise<Response>((r) => { answer = r; }),
    });
    renderStrip(homeFixture());
    fireEvent.click(tile('outstanding'));
    const dialog = screen.getByRole('dialog', { name: 'Outstanding' });
    const button = within(dialog).getByRole('button', { name: 'Remind' });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute('aria-busy', 'true'));
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button); // a second tap while pending does nothing
    expect(fetchMock).toHaveBeenCalledTimes(1);
    answer(jsonResponse(200, { success: true, data: {} }));
    await waitFor(() => expect(button).not.toHaveAttribute('aria-busy'));
    expect(button).toHaveAttribute('aria-disabled', 'true'); // done: stays inert
    expect(button).not.toBeDisabled();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Estimated tax sheet: amount, definition, next tax date from nextUp, and a chat link', () => {
    renderStrip(homeFixture());
    fireEvent.click(tile('tax'));
    const dialog = screen.getByRole('dialog', { name: 'Estimated tax' });
    expect(dialog).toHaveTextContent('CA$6,150');
    expect(dialog).toHaveTextContent('What you’d owe if the year ended today.');
    expect(dialog).toHaveTextContent('Next tax date: Oct 15');
    expect(within(dialog).getByRole('link', { name: 'Ask about tax' })).toHaveAttribute('href', '/app/chat');
  });

  it('Estimated tax sheet for a region with no estimate says so', () => {
    renderStrip(homeFixture({ kpis: { ...homeFixture().kpis, estTaxOwedCents: null } }));
    fireEvent.click(tile('tax'));
    expect(screen.getByRole('dialog', { name: 'Estimated tax' })).toHaveTextContent('No tax estimate is available for your region yet.');
  });

  it('Net and Cash sheets link to mobile screens only', () => {
    renderStrip(homeFixture({ kpis: { ...homeFixture().kpis, cashTodayCents: null } }));
    fireEvent.click(tile('month_net'));
    expect(within(screen.getByRole('dialog', { name: 'Net this month' })).getByRole('link', { name: 'See expenses' })).toHaveAttribute('href', '/app/docs');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(tile('cash'));
    const cash = screen.getByRole('dialog', { name: 'Cash today' });
    expect(cash).toHaveTextContent('Connect a bank account to see your cash.');
    expect(within(cash).getByRole('link', { name: 'Ask about cash flow' })).toHaveAttribute('href', '/app/chat');
    for (const a of Array.from(document.querySelectorAll('a'))) expect(a.getAttribute('href')).toMatch(/^\/app(\/|$|\?)/);
  });

  it('AU: AUD figures and no US self-employment wording anywhere in the strip or sheets', () => {
    renderStrip(homeFixture({ currency: 'AUD' }));
    expect(tile('tax')).toHaveTextContent('A$6,150');
    fireEvent.click(tile('tax'));
    expect(document.body.textContent).not.toMatch(/self-employment|Schedule C|Schedule SE|1040/i);
  });

  const NEG = { ...homeFixture().kpis, monthNetCents: -123_400 };

  it.each([
    ['USD', 'en', '-$1,234', '$12,500'],
    ['CAD', 'en', '-CA$1,234', 'CA$12,500'],
    ['AUD', 'en', '-A$1,234', 'A$12,500'],
  ])('%s tenant (%s): exact negative net and cash strings; the name carries label, sign and "net loss"', (currency, locale, net, cash) => {
    renderStrip(homeFixture({ currency, kpis: NEG }), locale);
    expect(tile('month_net')).toHaveTextContent(net);
    expect(tile('month_net')).toHaveAttribute('aria-label', `Net this month, ${net}, net loss`);
    expect(tile('cash')).toHaveAttribute('aria-label', `Cash today, ${cash}`);
    expect(net).toBe(formatCurrencyCents(-123_400, currency, locale));
    expect(cash).toBe(formatCurrencyCents(1_250_000, currency, locale));
  });

  it('fr-CA: exact tile names (NBSP / narrow-NBSP grouping, trailing $) and the French loss marker', () => {
    renderStrip(homeFixture({ kpis: NEG }), 'fr-CA');
    const net = formatCurrencyCents(-123_400, 'CAD', 'fr-CA');
    const cash = formatCurrencyCents(1_250_000, 'CAD', 'fr-CA');
    expect(net).toMatch(/^-1[  ]234[  ]\$$/);
    expect(cash).toMatch(/^12[  ]500[  ]\$$/);
    expect(tile('month_net')).toHaveAttribute('aria-label', `Net ce mois-ci, ${net}, perte nette`);
    expect(tile('cash')).toHaveAttribute('aria-label', `Encaisse aujourd’hui, ${cash}`);
    expect(tile('outstanding')).toHaveTextContent('2 en retard');
    fireEvent.click(tile('tax'));
    expect(screen.getByRole('dialog', { name: 'Impôt estimé' })).toHaveTextContent('Prochaine échéance fiscale');
  });

  it('zh-CN: exact tile names and the Chinese loss marker', () => {
    renderStrip(homeFixture({ kpis: NEG }), 'zh-CN');
    expect(tile('month_net')).toHaveAttribute('aria-label', '本月净额, -CA$1,234, 净亏损');
    expect(tile('cash')).toHaveAttribute('aria-label', '今日现金, CA$12,500');
    expect(tile('tax')).toHaveTextContent('预估税款');
    expect(tile('outstanding')).toHaveTextContent('2 张逾期');
  });

  it('a positive month carries no loss marker', () => {
    renderStrip(homeFixture());
    expect(tile('month_net')).toHaveAttribute('aria-label', 'Net this month, CA$4,123');
  });

  it('null month net: labelled dash on the tile, and the sheet explains it is not a zero', () => {
    renderStrip(homeFixture({ kpis: { ...homeFixture().kpis, monthNetCents: null } }));
    expect(within(tile('month_net')).getByLabelText('Not available')).toHaveTextContent('—');
    expect(tile('month_net')).toHaveAttribute('aria-label', 'Net this month, Not available');
    expect(tile('month_net')).not.toHaveTextContent('$0');
    fireEvent.click(tile('month_net'));
    const dialog = screen.getByRole('dialog', { name: 'Net this month' });
    expect(within(dialog).getByLabelText('Not available')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('No activity yet this month, so there is no net figure to show.');
    expect(dialog).not.toHaveTextContent('$0');
    expect(dialog).not.toHaveTextContent('Money in minus money out');
  });

  const overdueAlert = (n: number) => ({
    id: `od${n}`,
    kind: 'invoice_overdue' as const,
    severity: 'critical' as const,
    params: { client: `Client ${n}`, days: 10 + n, amountCents: 100_000 * n },
    action: { type: 'post' as const, endpoint: `/api/v1/agentbook-invoice/invoices/inv-${n}/remind`, labelKey: 'mobile.alerts.action_remind' },
  });
  const overdueData = (count: number, alerts: number) =>
    homeFixture({ kpis: { ...homeFixture().kpis, overdueCount: count, overdueCents: 700_000 }, alerts: Array.from({ length: alerts }, (_, i) => overdueAlert(i + 1)) });
  const openOutstanding = () => {
    fireEvent.click(tile('outstanding'));
    return screen.getByRole('dialog', { name: 'Outstanding' });
  };

  it('Outstanding sheet discloses a partial list: 7 overdue, 3 listed -> "Showing 3 of 7" + a chat link', () => {
    renderStrip(overdueData(7, 3));
    const dialog = openOutstanding();
    expect(dialog.querySelector('[data-overdue-partial]')).toHaveTextContent('Showing 3 of 7 overdue invoices');
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(3);
    expect(within(dialog).getByRole('link', { name: 'Ask about the rest' })).toHaveAttribute('href', '/app/chat');
  });

  it('Outstanding sheet: a complete list (3 of 3) has no "Showing" line and no ask link', () => {
    renderStrip(overdueData(3, 3));
    const dialog = openOutstanding();
    expect(dialog.querySelector('[data-overdue-partial]')).toBeNull();
    expect(dialog).not.toHaveTextContent('Showing');
    expect(within(dialog).queryByRole('link', { name: 'Ask about the rest' })).toBeNull();
  });

  it('singular wording: 1 overdue, 0 listed -> "Showing 0 of 1 overdue invoice"', () => {
    renderStrip(overdueData(1, 0));
    const dialog = openOutstanding();
    const line = dialog.querySelector('[data-overdue-partial]') as HTMLElement;
    expect(line.textContent).toBe('Showing 0 of 1 overdue invoice');
  });

  it('partial-list line is localized (fr-CA, zh-CN)', () => {
    const { unmount } = renderStrip(overdueData(7, 3), 'fr-CA');
    fireEvent.click(tile('outstanding'));
    expect(document.querySelector('[data-overdue-partial]')?.textContent).toBe('3 sur 7 factures en retard affichées');
    unmount();
    renderStrip(overdueData(7, 3), 'zh-CN');
    fireEvent.click(tile('outstanding'));
    expect(document.querySelector('[data-overdue-partial]')?.textContent).toBe('显示 7 张逾期发票中的 3 张');
  });

  it('an overdue row with a missing amount shows the dash, never $0; a missing days figure is omitted', () => {
    const a = overdueAlert(1);
    renderStrip(homeFixture({ kpis: { ...homeFixture().kpis, overdueCount: 3 }, alerts: [
      { ...a, id: 'x1', params: { client: 'NoAmount', days: 5 } },
      { ...a, id: 'x2', params: { client: 'NoDays', amountCents: 250_000 } },
      { ...a, id: 'x3', params: { client: 'Garbage', days: 'soon', amountCents: Number.NaN } },
    ] }));
    const rows = within(openOutstanding()).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('NoAmount');
    expect(rows[0]).toHaveTextContent('5 days overdue');
    expect(within(rows[0]).getByLabelText('Not available')).toHaveTextContent('—');
    expect(rows[0]).not.toHaveTextContent('$0');
    expect(rows[1]).toHaveTextContent('CA$2,500');
    expect(rows[1]).not.toHaveTextContent('overdue');
    expect(rows[1]).not.toHaveTextContent('0 days');
    expect(within(rows[2]).getByLabelText('Not available')).toBeInTheDocument();
    expect(rows[2]).not.toHaveTextContent('days');
    expect(rows[2]).not.toHaveTextContent('$0');
  });


  it('kpiCents maps each tile to its field', () => {
    const d = homeFixture();
    expect([kpiCents(d, 'month_net'), kpiCents(d, 'cash'), kpiCents(d, 'outstanding'), kpiCents(d, 'tax')]).toEqual([412_300, 1_250_000, 980_000, 615_000]);
  });
});
