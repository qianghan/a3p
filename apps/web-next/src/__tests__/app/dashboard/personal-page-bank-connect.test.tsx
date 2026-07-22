/**
 * Personal Finance page — AU-aware bank-connect button.
 *
 * Originally (PARITY-4) an AU tenant clicking "Connect bank" got an honest
 * decline message, since Plaid (our bank-connection provider) has no
 * country code for Australia at all. AU-1 Task 4 replaces that decline with
 * a real Basiq-backed connect flow — mirroring the business-side
 * `BankConnection.tsx`'s AU branch (Task 3, PR #318) via the shared
 * `useBasiqConnect` hook (`@naap/plugin-sdk`).
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import PersonalFinancePage from '@/app/(dashboard)/personal/page';

vi.mock('react-plaid-link', () => ({
  usePlaidLink: () => ({ open: vi.fn(), ready: false, exit: vi.fn() }),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  });
}

function baseRoutes(jurisdiction: 'au' | 'us', overrides: Record<string, () => Promise<unknown>> = {}) {
  return (url: string) => {
    if (url.includes('/agentbook-core/tenant-config')) {
      return jsonResponse({ success: true, data: { currency: jurisdiction === 'au' ? 'AUD' : 'USD', locale: jurisdiction === 'au' ? 'en-AU' : 'en-US', jurisdiction } });
    }
    if (url.includes('/snapshot')) {
      return jsonResponse({ success: true, data: { netWorthCents: 0, assetsCents: 0, liabilitiesCents: 0, accountCount: 0, month: { incomeCents: 0, spendingCents: 0, savingsRate: 0, businessFlaggedCents: 0, spendByCategory: [] } } });
    }
    if (url.includes('/trend')) {
      // 402 (gated) is a normal, successful response shape for this route —
      // avoids asserting on the Personal Insights add-on, which is out of
      // scope here.
      return jsonResponse({ success: false }, 402);
    }
    if (url.includes('/agentbook-billing/me/addons')) {
      return jsonResponse({ addons: [] });
    }
    for (const [frag, handler] of Object.entries(overrides)) {
      if (url.includes(frag)) return handler();
    }
    // /accounts, /budget, /transactions all share this shape.
    return jsonResponse({ success: true, data: [] });
  };
}

describe('Personal Finance page — bank-connect (AU-1 Task 4: Basiq)', () => {
  beforeEach(() => {
    mockFetch.mockClear();
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AU jurisdiction: clicking Connect bank calls the Basiq consent-url route, not Plaid link-token', async () => {
    mockFetch.mockImplementation(baseRoutes('au', {
      '/bank/basiq/consent-url': () => jsonResponse({ success: true, data: { consentUrl: 'https://consent.basiq.io/home?token=abc' } }),
    }));

    render(<PersonalFinancePage />);
    const connectButton = await screen.findByText('Connect bank');
    fireEvent.click(connectButton);

    await waitFor(() => {
      const consentCalls = mockFetch.mock.calls.filter(([url]: [string]) => url.includes('/bank/basiq/consent-url'));
      expect(consentCalls.length).toBeGreaterThan(0);
    });
    const linkTokenCalls = mockFetch.mock.calls.filter(([url]: [string]) => url.includes('/plaid/link-token'));
    expect(linkTokenCalls).toHaveLength(0);
    expect(window.open).toHaveBeenCalledWith('https://consent.basiq.io/home?token=abc', 'basiq-consent', 'width=480,height=720');
  });

  it('still calls /plaid/link-token for a US tenant (no regression)', async () => {
    mockFetch.mockImplementation(baseRoutes('us', {
      '/plaid/link-token': () => jsonResponse({ success: true, data: { linkToken: 'link-sandbox-abc' } }),
    }));

    render(<PersonalFinancePage />);
    const connectButton = await screen.findByText('Connect bank');
    fireEvent.click(connectButton);

    await waitFor(() => {
      const linkTokenCalls = mockFetch.mock.calls.filter(([url]: [string]) => url.includes('/plaid/link-token'));
      expect(linkTokenCalls.length).toBeGreaterThan(0);
    });
    const consentCalls = mockFetch.mock.calls.filter(([url]: [string]) => url.includes('/bank/basiq/consent-url'));
    expect(consentCalls).toHaveLength(0);
  });

  it('AU jurisdiction: a 402 from consent-url (Personal Insights not enabled) shows the upsert message', async () => {
    mockFetch.mockImplementation(baseRoutes('au', {
      '/bank/basiq/consent-url': () => jsonResponse({ error: 'Net-worth trends and proactive alerts are part of Personal Insights — enable it in your Personal Finance settings to use them.' }, 402),
    }));

    render(<PersonalFinancePage />);
    const connectButton = await screen.findByText('Connect bank');
    fireEvent.click(connectButton);

    await waitFor(() => {
      expect(screen.getByText('Bank sync is part of Personal Insights — enable it above to sync.')).toBeInTheDocument();
    });
    expect(window.open).not.toHaveBeenCalled();
  });

  it('AU jurisdiction: handles basiqJobId: null (user cancelled) cleanly — no error shown, no status poll', async () => {
    mockFetch.mockImplementation(baseRoutes('au', {
      '/bank/basiq/consent-url': () => jsonResponse({ success: true, data: { consentUrl: 'https://consent.basiq.io/home?token=abc' } }),
      '/bank/basiq/status': () => { throw new Error('status should never be polled when jobId is null'); },
    }));

    render(<PersonalFinancePage />);
    const connectButton = await screen.findByText('Connect bank');
    fireEvent.click(connectButton);

    await waitFor(() => {
      const consentCalls = mockFetch.mock.calls.filter(([url]: [string]) => url.includes('/bank/basiq/consent-url'));
      expect(consentCalls.length).toBeGreaterThan(0);
    });

    // Simulate the callback route's postMessage with a cancelled (null) jobId.
    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { basiqJobId: null },
    }));

    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/timed out/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
    const statusCalls = mockFetch.mock.calls.filter(([url]: [string]) => url.includes('/bank/basiq/status'));
    expect(statusCalls).toHaveLength(0);
  });

  it('disconnect calls the Basiq route for a basiq-provider account and the Plaid route for a plaid-provider account', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockFetch.mockImplementation(baseRoutes('au', {
      '/accounts': () => jsonResponse({
        success: true,
        data: [
          { id: 'acct-basiq-1', name: 'Basiq Savings', type: 'savings', balanceCents: 10000, isAsset: true, plaidAccountId: null, institution: 'ANZ', connected: true, lastSynced: null, provider: 'basiq' },
          { id: 'acct-plaid-1', name: 'Chase Checking', type: 'checking', balanceCents: 50000, isAsset: true, plaidAccountId: 'plaid-acc-1', institution: 'Chase', connected: true, lastSynced: null, provider: 'plaid' },
        ],
      }),
    }));

    render(<PersonalFinancePage />);
    const disconnectButtons = await screen.findAllByText('Disconnect');
    expect(disconnectButtons).toHaveLength(2);

    fireEvent.click(disconnectButtons[0]);
    await waitFor(() => {
      const basiqDisconnectCalls = mockFetch.mock.calls.filter(([url]: [string]) => url.includes('/bank/basiq/disconnect'));
      expect(basiqDisconnectCalls.length).toBeGreaterThan(0);
    });

    fireEvent.click(disconnectButtons[1]);
    await waitFor(() => {
      const plaidDisconnectCalls = mockFetch.mock.calls.filter(([url]: [string]) => url.includes('/plaid/disconnect') && !url.includes('/bank/basiq/'));
      expect(plaidDisconnectCalls.length).toBeGreaterThan(0);
    });
  });
});
