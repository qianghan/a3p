/**
 * Mobile expense capture page — regression test for the silent-failure bug.
 *
 * Root cause: real phone camera photos (commonly 3-12MB) exceed the
 * platform's request body limit for /receipts/scan, which rejects the
 * request outright with a plain-text (non-JSON) body. The old `onPhoto`
 * handler had no `else` branch for a non-offline failure, so `response.json()`
 * throwing on that body was swallowed with zero visible feedback — the user
 * saw an empty amount field and a disabled Save button with no explanation.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import MobileCapture from '../../app/app/capture/page';

const mockFetch = vi.fn();
global.fetch = mockFetch;

function makeFile(name = 'receipt.jpg', type = 'image/jpeg') {
  return new File(['fake-image-bytes'], name, { type });
}

async function selectPhoto(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    fireEvent.change(input);
  });
}

describe('MobileCapture', () => {
  it('surfaces a visible error instead of swallowing a platform-level rejection (e.g. 413 payload too large)', async () => {
    // Simulates Vercel's real response for an oversized request: a non-2xx
    // status with a plain-text body, not JSON — response.json() throws.
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 413,
      headers: new Headers(),
      json: () => Promise.reject(new Error('Unexpected token R in JSON')),
    });

    render(<MobileCapture />);
    await selectPhoto(makeFile());

    await waitFor(() => {
      expect(screen.getByText(/couldn.t auto-read the receipt/i)).toBeInTheDocument();
    });

    // Amount stays empty and Save stays disabled — but now the user knows why.
    expect(screen.getByPlaceholderText('Amount')).toHaveValue(null);
    expect(screen.getByRole('button', { name: /save expense/i })).toBeDisabled();
  });

  it('surfaces a visible error for a well-formed error JSON response too (e.g. 401/500)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: new Headers(),
      json: () => Promise.resolve({ success: false, error: 'Unauthorized' }),
    });

    render(<MobileCapture />);
    await selectPhoto(makeFile());

    await waitFor(() => {
      expect(screen.getByText(/couldn.t auto-read the receipt/i)).toBeInTheDocument();
    });
  });

  it('still populates amount/vendor and enables Save on a successful extraction', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve({
        success: true,
        data: { amountCents: 4250, vendor: 'Test Cafe', date: null, receiptUrl: 'https://blob.example/r.jpg' },
      }),
    });

    render(<MobileCapture />);
    await selectPhoto(makeFile());

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Amount')).toHaveValue(42.5);
    });
    expect(screen.getByPlaceholderText('Vendor / description')).toHaveValue('Test Cafe');
    expect(screen.getByRole('button', { name: /save expense/i })).toBeEnabled();
    expect(screen.queryByText(/couldn.t auto-read the receipt/i)).not.toBeInTheDocument();
  });

  it('queues the receipt for offline replay without showing an error when the service worker reports offline', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      headers: new Headers({ 'X-Agentbook-Offline': '1' }),
      json: () => Promise.resolve({ success: false }),
    });

    render(<MobileCapture />);
    await selectPhoto(makeFile());

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Amount')).toHaveValue(null);
    });
    expect(screen.queryByText(/couldn.t auto-read the receipt/i)).not.toBeInTheDocument();
  });
});
