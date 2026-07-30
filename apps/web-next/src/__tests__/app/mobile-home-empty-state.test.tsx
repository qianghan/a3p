/**
 * Mobile/PWA home — first-run experience.
 *
 * A brand-new account previously landed on three $0 tiles plus a non-tappable
 * "Snap a receipt" hint, which reads as broken and offers no way forward. The
 * page now distinguishes three states — no data yet, real data, and a failed
 * load — and always offers real, tappable next steps.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import MobileHome from '@/app/app/page';

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
}

beforeEach(() => {
  vi.clearAllMocks();
});

const ZERO = { success: true, total_revenue: 0, total_expenses: 0, total_estimated_tax: 0, data: { jurisdiction: 'us' } };
const WITH_DATA = { success: true, total_revenue: 5000, total_expenses: 1200, total_estimated_tax: 800, data: { jurisdiction: 'us' } };

describe('MobileHome — empty state (new account)', () => {
  it('welcomes the user and explains what to do instead of showing $0 tiles', async () => {
    mockFetch.mockReturnValue(ok(ZERO));
    render(<MobileHome />);

    await waitFor(() => expect(screen.getByText(/let’s get your books started/i)).toBeTruthy());
    expect(screen.getByText(/start filling in/i)).toBeTruthy();
    // the misleading zero tiles are gone
    expect(screen.queryByText('Revenue')).toBeNull();
    expect(screen.queryByText('Estimated tax')).toBeNull();
  });

  it('offers tappable next steps that link to real destinations', async () => {
    mockFetch.mockReturnValue(ok(ZERO));
    render(<MobileHome />);

    await waitFor(() => expect(screen.getByText(/Snap a receipt/i)).toBeTruthy());
    const hrefs = Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/app/capture');
    expect(hrefs).toContain('/app/chat');
    expect(hrefs).toContain('/app/docs');
  });
});

describe('MobileHome — with data', () => {
  it('shows the year-to-date tiles', async () => {
    mockFetch.mockReturnValue(ok(WITH_DATA));
    render(<MobileHome />);

    await waitFor(() => expect(screen.getByText('Revenue')).toBeTruthy());
    expect(screen.getByText('Expenses')).toBeTruthy();
    expect(screen.getByText('Estimated tax')).toBeTruthy();
    expect(screen.getByText('Year to date')).toBeTruthy();
  });

  it('still offers the next-step actions alongside real numbers', async () => {
    mockFetch.mockReturnValue(ok(WITH_DATA));
    render(<MobileHome />);
    await waitFor(() => expect(screen.getByText('Revenue')).toBeTruthy());
    const hrefs = Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/app/capture');
  });
});

describe('MobileHome — failed load', () => {
  it('says it could not load rather than silently implying the books are empty', async () => {
    mockFetch.mockReturnValue(Promise.reject(new Error('offline')));
    render(<MobileHome />);

    await waitFor(() => expect(screen.getByText(/couldn’t load your numbers/i)).toBeTruthy());
    // must NOT be mistaken for a new/empty account
    expect(screen.queryByText(/let’s get your books started/i)).toBeNull();
    expect(screen.queryByText('Revenue')).toBeNull();
  });

  it('treats an unsuccessful payload as a failure too', async () => {
    mockFetch.mockReturnValue(ok({ success: false, error: 'boom' }));
    render(<MobileHome />);
    await waitFor(() => expect(screen.getByText(/couldn’t load your numbers/i)).toBeTruthy());
  });
});
