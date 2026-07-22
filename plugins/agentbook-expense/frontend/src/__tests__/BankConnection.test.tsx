import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { BankConnectionPage } from '../pages/BankConnection';

/**
 * AU-1 task 3: BankConnection.tsx AU (Basiq) branch + the disconnect button
 * (previously missing for both providers).
 *
 * Mirrors the mocking approach in
 * apps/web-next/src/__tests__/app/dashboard/personal-page-bank-connect.test.tsx
 * (mock `react-plaid-link`'s `usePlaidLink`, mock `fetch` by URL).
 */

const usePlaidLinkMock = vi.fn((..._args: unknown[]) => ({ open: vi.fn(), ready: false, exit: vi.fn() }));
vi.mock('react-plaid-link', () => ({
  usePlaidLink: (config: unknown) => usePlaidLinkMock(config),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch as any;

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as any);
}

function installFetch(opts: {
  jurisdiction: 'au' | 'us' | 'ca';
  accounts?: unknown[];
}) {
  const accounts = opts.accounts ?? [];
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/agentbook-core/tenant-config')) {
      return jsonResponse({ success: true, data: { jurisdiction: opts.jurisdiction, currency: opts.jurisdiction === 'au' ? 'AUD' : 'USD' } });
    }
    if (url.includes('/bank-accounts')) {
      return jsonResponse({ data: accounts });
    }
    if (url.includes('/reconciliation-summary')) {
      return jsonResponse({ data: null });
    }
    if (url.includes('/bank-transactions')) {
      return jsonResponse({ data: [] });
    }
    return jsonResponse({ success: true, data: {} });
  });
}

describe('BankConnectionPage — AU (Basiq) branch', () => {
  beforeEach(() => {
    mockFetch.mockClear();
    usePlaidLinkMock.mockClear();
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AU jurisdiction: clicking Connect Bank calls the Basiq consent-url route, not Plaid link-token', async () => {
    installFetch({ jurisdiction: 'au' });
    render(<BankConnectionPage />);

    const connectButton = await screen.findByText('Connect with Basiq');
    fireEvent.click(connectButton);

    await waitFor(() => {
      const consentCalls = mockFetch.mock.calls.filter((call: any[]) => String(call[0]).includes('/bank/basiq/consent-url'));
      expect(consentCalls.length).toBeGreaterThan(0);
    });

    const linkTokenCalls = mockFetch.mock.calls.filter((call: any[]) => String(call[0]).includes('/plaid/link-token'));
    expect(linkTokenCalls).toHaveLength(0);
  });

  it('AU jurisdiction: never invokes usePlaidLink\'s open (Plaid flow untouched)', async () => {
    installFetch({ jurisdiction: 'au' });
    render(<BankConnectionPage />);
    await screen.findByText('Connect with Basiq');
    // usePlaidLink is still called (it's an unconditional hook call), but
    // with a null token — assert no Plaid Link token was ever set for AU.
    const linkTokenCalls = mockFetch.mock.calls.filter((call: any[]) => String(call[0]).includes('/plaid/link-token'));
    expect(linkTokenCalls).toHaveLength(0);
  });

  it('non-AU jurisdiction (US): Connect Bank still drives the Plaid Link flow, unchanged', async () => {
    installFetch({ jurisdiction: 'us' });
    mockFetch.mockImplementation((url: string, init?: any) => {
      if (url.includes('/agentbook-core/tenant-config')) {
        return jsonResponse({ success: true, data: { jurisdiction: 'us', currency: 'USD' } });
      }
      if (url.includes('/bank-accounts')) return jsonResponse({ data: [] });
      if (url.includes('/reconciliation-summary')) return jsonResponse({ data: null });
      if (url.includes('/bank-transactions')) return jsonResponse({ data: [] });
      if (url.includes('/plaid/link-token')) {
        return jsonResponse({ success: true, data: { linkToken: 'link-sandbox-abc' } });
      }
      return jsonResponse({ success: true, data: {} });
    });

    render(<BankConnectionPage />);
    const connectButton = await screen.findByText('Connect with Plaid');
    fireEvent.click(connectButton);

    await waitFor(() => {
      const linkTokenCalls = mockFetch.mock.calls.filter((call: any[]) => String(call[0]).includes('/plaid/link-token'));
      expect(linkTokenCalls.length).toBeGreaterThan(0);
    });

    const consentCalls = mockFetch.mock.calls.filter((call: any[]) => String(call[0]).includes('/bank/basiq/consent-url'));
    expect(consentCalls).toHaveLength(0);
  });

  it('disconnect button calls the Basiq disconnect route for a basiq-provider account', async () => {
    installFetch({
      jurisdiction: 'au',
      accounts: [
        {
          id: 'acct-basiq-1',
          name: 'Basiq Savings',
          officialName: null,
          type: 'savings',
          subtype: null,
          mask: '1234',
          balanceCents: 10000,
          currency: 'AUD',
          institution: 'ANZ',
          connected: true,
          lastSynced: null,
          provider: 'basiq',
        },
      ],
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<BankConnectionPage />);
    const disconnectButton = await screen.findByText('Disconnect');
    fireEvent.click(disconnectButton);

    await waitFor(() => {
      const disconnectCalls = mockFetch.mock.calls.filter((call: any[]) => String(call[0]).includes('/bank/basiq/disconnect'));
      expect(disconnectCalls.length).toBeGreaterThan(0);
    });
    const plaidDisconnectCalls = mockFetch.mock.calls.filter((call: any[]) => String(call[0]).includes('/plaid/disconnect'));
    expect(plaidDisconnectCalls).toHaveLength(0);
  });

  it('disconnect button calls the Plaid disconnect route for a plaid-provider account', async () => {
    installFetch({
      jurisdiction: 'us',
      accounts: [
        {
          id: 'acct-plaid-1',
          name: 'Chase Checking',
          officialName: null,
          type: 'checking',
          subtype: null,
          mask: '5678',
          balanceCents: 50000,
          currency: 'USD',
          institution: 'Chase',
          connected: true,
          lastSynced: null,
          provider: 'plaid',
        },
      ],
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<BankConnectionPage />);
    const disconnectButton = await screen.findByText('Disconnect');
    fireEvent.click(disconnectButton);

    await waitFor(() => {
      const disconnectCalls = mockFetch.mock.calls.filter((call: any[]) => String(call[0]).includes('/plaid/disconnect'));
      expect(disconnectCalls.length).toBeGreaterThan(0);
    });
    const basiqDisconnectCalls = mockFetch.mock.calls.filter((call: any[]) => String(call[0]).includes('/bank/basiq/disconnect'));
    expect(basiqDisconnectCalls).toHaveLength(0);
  });

  it('disconnect prompts for confirmation and does nothing if declined', async () => {
    installFetch({
      jurisdiction: 'au',
      accounts: [
        {
          id: 'acct-basiq-2',
          name: 'Basiq Checking',
          officialName: null,
          type: 'checking',
          subtype: null,
          mask: '4321',
          balanceCents: 2000,
          currency: 'AUD',
          institution: 'CBA',
          connected: true,
          lastSynced: null,
          provider: 'basiq',
        },
      ],
    });
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<BankConnectionPage />);
    const disconnectButton = await screen.findByText('Disconnect');
    fireEvent.click(disconnectButton);

    // Give any accidental async call a chance to fire.
    await new Promise((r) => setTimeout(r, 10));
    const disconnectCalls = mockFetch.mock.calls.filter((call: any[]) => String(call[0]).includes('/disconnect'));
    expect(disconnectCalls).toHaveLength(0);
  });

  it('handles basiqJobId: null (user cancelled) cleanly — no error shown, stops waiting', async () => {
    installFetch({ jurisdiction: 'au' });
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/agentbook-core/tenant-config')) {
        return jsonResponse({ success: true, data: { jurisdiction: 'au', currency: 'AUD' } });
      }
      if (url.includes('/bank-accounts')) return jsonResponse({ data: [] });
      if (url.includes('/reconciliation-summary')) return jsonResponse({ data: null });
      if (url.includes('/bank-transactions')) return jsonResponse({ data: [] });
      if (url.includes('/bank/basiq/consent-url')) {
        return jsonResponse({ success: true, data: { consentUrl: 'https://consent.basiq.io/home?token=abc' } });
      }
      if (url.includes('/bank/basiq/status')) {
        throw new Error('status should never be polled when jobId is null');
      }
      return jsonResponse({ success: true, data: {} });
    });

    render(<BankConnectionPage />);
    const connectButton = await screen.findByText('Connect with Basiq');
    fireEvent.click(connectButton);

    await waitFor(() => {
      const consentCalls = mockFetch.mock.calls.filter((call: any[]) => String(call[0]).includes('/bank/basiq/consent-url'));
      expect(consentCalls.length).toBeGreaterThan(0);
    });

    // Simulate the callback route's postMessage with a cancelled (null) jobId.
    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { basiqJobId: null },
    }));

    // No error banner should ever appear.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/timed out/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
    const statusCalls = mockFetch.mock.calls.filter((call: any[]) => String(call[0]).includes('/bank/basiq/status'));
    expect(statusCalls).toHaveLength(0);
  });
});
