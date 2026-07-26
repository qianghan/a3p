/**
 * Settings → Payments tab (invoice card-collection via Stripe Connect).
 * Verifies the connect flow (redirect to Stripe onboarding) and the
 * connected/ready state, driving the real component with a mocked fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentBookSettingsPanel } from '@/components/settings/AgentBookSettingsPanel';

const MINIMAL_CONFIG = {
  companyName: 'Acme', companyAddress: null, companyEmail: null, companyPhone: null,
  abn: null, logoUrl: null, brandColor: '#000000', defaultPaymentTerms: 'net-30',
  invoiceFooterNote: null, invoiceThankYouMessage: null, jurisdiction: 'us', businessType: 'freelancer',
};

function jsonOk(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(data) });
}

let onboardCalls = 0;

function mockFetch(connectStatus: { connected: boolean; payoutsEnabled: boolean; accountId: string | null }) {
  onboardCalls = 0;
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    if (url.includes('/agentbook-core/tenant-config')) return jsonOk({ data: MINIMAL_CONFIG });
    if (url.includes('/agentbook-invoice/connect/status')) return jsonOk({ success: true, data: connectStatus });
    if (url.includes('/agentbook-invoice/connect/onboard')) {
      expect(init?.method).toBe('POST');
      onboardCalls++;
      return jsonOk({ success: true, data: { url: 'https://connect.stripe.com/onboard/abc' } });
    }
    return jsonOk({ success: true, data: {} });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  Object.defineProperty(window, 'location', { value: { href: '', origin: 'https://app.test' }, writable: true, configurable: true });
});
afterEach(() => vi.restoreAllMocks());

describe('Settings → Payments tab', () => {
  it('offers Connect Stripe and redirects to onboarding when not connected', async () => {
    mockFetch({ connected: false, payoutsEnabled: false, accountId: null });
    render(<AgentBookSettingsPanel initialTab="payments" />);

    const connectBtn = await screen.findByRole('button', { name: /connect stripe/i });
    fireEvent.click(connectBtn);

    await waitFor(() => expect(onboardCalls).toBe(1));
    await waitFor(() => expect(window.location.href).toBe('https://connect.stripe.com/onboard/abc'));
  });

  it('shows the ready state (with the Collect-by-card hint) once payouts are enabled', async () => {
    mockFetch({ connected: true, payoutsEnabled: true, accountId: 'acct_1' });
    render(<AgentBookSettingsPanel initialTab="payments" />);

    expect(await screen.findByText(/Connected/i)).toBeTruthy();
    expect(await screen.findByText(/Collect by card/i)).toBeTruthy();
    // No Connect button in the ready state.
    expect(screen.queryByRole('button', { name: /connect stripe/i })).toBeNull();
  });

  it('prompts to finish onboarding when the account exists but payouts are not enabled', async () => {
    mockFetch({ connected: true, payoutsEnabled: false, accountId: 'acct_1' });
    render(<AgentBookSettingsPanel initialTab="payments" />);

    expect(await screen.findByRole('button', { name: /finish stripe onboarding/i })).toBeTruthy();
    expect(await screen.findByText(/Incomplete/i)).toBeTruthy();
  });
});
