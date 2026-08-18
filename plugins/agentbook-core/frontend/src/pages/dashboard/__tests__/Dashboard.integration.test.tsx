import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import { ShellProvider } from '@naap/plugin-sdk';
import type { ShellContext, II18nService } from '@naap/plugin-sdk';
import { createTranslator } from '@agentbook/i18n';
import { CATALOG } from '@agentbook/i18n/catalog';
import { DashboardPage } from '../../Dashboard';

/**
 * Render inside a ShellProvider carrying a REAL translator over the REAL
 * catalog.
 *
 * useI18n() does not throw without a provider — it degrades to English by
 * humanising the key ('dashboard.welcome_title' -> 'Welcome title'). That
 * keeps a page rendering on an older shell, but it is NOT the product copy,
 * so a test asserting exact strings has to supply the catalog. Using the real
 * one also means these assertions fail if a key goes missing.
 */
function render(ui: React.ReactElement) {
  const { t } = createTranslator('en', CATALOG);
  const i18n = {
    locale: 'en',
    t,
    formatMoney: (c: number) => String(c),
    formatCurrency: (c: number) => String(c),
    formatDate: (d: string | Date) => String(d),
    formatDateOnly: (d: string | Date) => String(d),
    formatNumber: (n: number) => String(n),
    formatPercent: (n: number) => String(n),
    parseAmount: () => ({ ok: true, cents: 0, ambiguous: false, formatted: '' }),
  } as II18nService;
  const shell = {
    auth: {}, navigate: () => {}, eventBus: {}, theme: {}, notifications: {},
    integrations: {}, logger: {}, permissions: {}, version: '2.0.0', i18n,
  } as unknown as ShellContext;
  return rtlRender(<ShellProvider value={shell}>{ui}</ShellProvider>);
}

const happyOverview = {
  success: true,
  data: {
    cashToday: 1420000,
    projection: { days: Array.from({ length: 30 }, (_, i) => ({ date: '2026-05-' + String(i + 1).padStart(2, '0'), cents: 1500000 })), moodLabel: 'healthy' },
    nextMoments: [{ kind: 'income', label: '💰 Acme $4,500 in 7d', amountCents: 450000, daysOut: 7 }],
    attention: [{ id: 'overdue:i1', severity: 'critical', title: 'Acme · 32 days overdue', amountCents: 450000 }],
    recurringOutflows: [],
    monthMtd: { revenueCents: 1240000, expenseCents: 410000, netCents: 830000 },
    monthPrev: { revenueCents: 1078260, expenseCents: 422680, netCents: 680320 },
    isBrandNew: false,
  },
};
const happySummary = { success: true, data: { summary: 'One invoice overdue.', generatedAt: '', source: 'fallback' } };
const happyActivity = { success: true, data: [{ id: 'exp:1', kind: 'expense', label: '🧾 Uber', amountCents: -2800, date: new Date().toISOString() }] };

let fetchMock: any;

function installFetch(responses: Record<string, any | (() => any)>) {
  fetchMock = vi.fn().mockImplementation((url: string) => {
    for (const [pattern, body] of Object.entries(responses)) {
      if (url.includes(pattern)) {
        const value = typeof body === 'function' ? body() : body;
        if (value === '500') return Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as any);
        return Promise.resolve({ ok: true, status: 200, json: async () => value } as any);
      }
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as any);
  });
  globalThis.fetch = fetchMock;
}

describe('DashboardPage integration', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('happy path renders all sections', async () => {
    installFetch({
      '/dashboard/overview':       happyOverview,
      '/dashboard/agent-summary':  happySummary,
      '/dashboard/activity':       happyActivity,
    });
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getAllByText(/Acme/).length).toBeGreaterThan(0));
    expect(screen.getByText(/This month/)).toBeInTheDocument();
    expect(screen.getByText(/Recent activity/)).toBeInTheDocument();
  });

  it('renders error banner when overview returns 500', async () => {
    installFetch({ '/dashboard/overview': '500' });
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText(/Couldn.t reach AgentBook/)).toBeInTheDocument());
  });

  it('renders onboarding hero when brand new', async () => {
    installFetch({
      '/dashboard/overview': { ...happyOverview, data: { ...happyOverview.data, isBrandNew: true } },
      '/dashboard/agent-summary': happySummary,
      '/dashboard/activity': { success: true, data: [] },
    });
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText(/Welcome to AgentBook/)).toBeInTheDocument());
  });

  it('renders rest of page when projection slice is null (partial failure)', async () => {
    installFetch({
      '/dashboard/overview':       { ...happyOverview, data: { ...happyOverview.data, projection: null } },
      '/dashboard/agent-summary':  happySummary,
      '/dashboard/activity':       happyActivity,
    });
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText(/Needs your attention/)).toBeInTheDocument());
    expect(screen.getByText(/This month/)).toBeInTheDocument();
    expect(screen.getByText(/Recent activity/)).toBeInTheDocument();
  });
});
