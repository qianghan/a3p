import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, within, waitFor } from '@testing-library/react';
import type { MobileHome } from '@/lib/mobile/types';
import { KpiStrip, kpiCents } from '@/app/app/_home/KpiStrip';
import { useAlertAction } from '@/app/app/_home/useAlertAction';
import { ToastHost } from '@/app/app/_kit/Toast';
import { renderWithI18n, routeFetch, jsonResponse, expectTouchTarget } from './test-utils';
import { homeFixture } from './fixtures';

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

  it('USD tenant: dollar amounts; a negative month shows its sign, and a null month is a dash', () => {
    renderStrip(homeFixture({ currency: 'USD', kpis: { ...homeFixture().kpis, monthNetCents: -123_400 } }));
    expect(tile('month_net')).toHaveTextContent(/[-−]\$1,234/);
    expect(tile('cash')).toHaveTextContent('$12,500');
    expect(tile('month_net')).toHaveAttribute('aria-label', expect.stringMatching(/^Net this month, [-−]\$1,234$/));
  });

  it('null month net renders the labelled dash and its sheet says it is not a zero', () => {
    renderStrip(homeFixture({ kpis: { ...homeFixture().kpis, monthNetCents: null } }));
    expect(within(tile('month_net')).getByLabelText('Not available')).toHaveTextContent('—');
    expect(tile('month_net')).not.toHaveTextContent('$0');
    fireEvent.click(tile('month_net'));
    expect(within(screen.getByRole('dialog', { name: 'Net this month' })).getByLabelText('Not available')).toBeInTheDocument();
  });

  it('tile accessible names carry label and value; labels and sheet copy are localized (fr-CA, zh-CN)', () => {
    const { unmount } = renderStrip(homeFixture(), 'fr-CA');
    expect(tile('month_net')).toHaveTextContent('Net ce mois-ci');
    expect(tile('outstanding')).toHaveTextContent('2 en retard');
    expect(tile('cash')).toHaveAttribute('aria-label', expect.stringMatching(/^Encaisse aujourd’hui, .*12/));
    fireEvent.click(tile('tax'));
    expect(screen.getByRole('dialog', { name: 'Impôt estimé' })).toHaveTextContent('Prochaine échéance fiscale');
    unmount();
    renderStrip(homeFixture(), 'zh-CN');
    expect(tile('tax')).toHaveTextContent('预估税款');
    expect(tile('outstanding')).toHaveTextContent('2 张逾期');
  });

  it('kpiCents maps each tile to its field', () => {
    const d = homeFixture();
    expect([kpiCents(d, 'month_net'), kpiCents(d, 'cash'), kpiCents(d, 'outstanding'), kpiCents(d, 'tax')]).toEqual([412_300, 1_250_000, 980_000, 615_000]);
  });
});
