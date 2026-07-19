/**
 * Personal Finance page — AU-aware bank-connect button (PARITY-4).
 *
 * Root cause: `handleStartBankConnect` always called `/plaid/link-token`,
 * which hardcodes `country_codes: [CountryCode.Us, CountryCode.Ca]` (Plaid's
 * SDK has no AU country code at all). An AU tenant clicking "Connect bank"
 * got a Plaid Link UI silently scoped to the wrong countries instead of an
 * honest failure. This mirrors AU-7's chat/MCP fix
 * (plugins/agentbook-core/backend/src/agent-brain.ts).
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
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

function mockFetchForJurisdiction(jurisdiction: 'au' | 'us') {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/agentbook-core/tenant-config')) {
      return jsonResponse({ success: true, data: { currency: jurisdiction === 'au' ? 'AUD' : 'USD', locale: jurisdiction === 'au' ? 'en-AU' : 'en-US', jurisdiction } });
    }
    if (url.includes('/plaid/link-token')) {
      return jsonResponse({ success: true, data: { linkToken: 'link-sandbox-abc' } });
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
    // /accounts, /budget, /transactions all share this shape.
    return jsonResponse({ success: true, data: [] });
  });
}

describe('Personal Finance page — AU bank-connect decline (PARITY-4)', () => {
  it('shows the honest decline message instead of calling /plaid/link-token for an AU tenant', async () => {
    mockFetchForJurisdiction('au');

    render(<PersonalFinancePage />);

    const connectButton = await screen.findByText('Connect bank');
    fireEvent.click(connectButton);

    await waitFor(() => {
      expect(screen.getByText(/Bank sync isn't available for Australian accounts yet/i)).toBeInTheDocument();
    });

    const linkTokenCalls = mockFetch.mock.calls.filter(([url]: [string]) => url.includes('/plaid/link-token'));
    expect(linkTokenCalls).toHaveLength(0);
  });

  it('still calls /plaid/link-token for a US tenant (no regression)', async () => {
    mockFetchForJurisdiction('us');

    render(<PersonalFinancePage />);

    const connectButton = await screen.findByText('Connect bank');
    fireEvent.click(connectButton);

    await waitFor(() => {
      const linkTokenCalls = mockFetch.mock.calls.filter(([url]: [string]) => url.includes('/plaid/link-token'));
      expect(linkTokenCalls.length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/Bank sync isn't available for Australian accounts yet/i)).not.toBeInTheDocument();
  });
});
