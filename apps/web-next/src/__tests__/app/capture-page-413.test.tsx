/**
 * #235 through the REAL client (api.ts not mocked): Vercel answers an oversized
 * upload with a plain-text 413 before our route runs. The page must surface it.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ToastHost } from '@/app/app/_kit';

vi.mock('@/hooks/use-t', async () => (await import('./mobile/_i18n-mock')).useTMock);
import MobileCapture from '../../app/app/capture/page';

beforeEach(() => {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/expenses/from-receipt')) return new Response('Request Entity Too Large', { status: 413 });
    if (String(url).includes('/tenant-config')) return new Response(JSON.stringify({ success: true, data: { currency: 'CAD', jurisdiction: 'ca' } }), { status: 200 });
    return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
  }));
});

describe('capture via the real api client', () => {
  it('a plain-text 413 from the platform becomes a visible message', async () => {
    render(<ToastHost><MobileCapture /></ToastHost>);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'big.jpg', { type: 'image/jpeg' })], configurable: true });
    await act(async () => { fireEvent.change(input); });
    expect(await screen.findByText(/couldn.t auto-read the receipt/i)).toBeInTheDocument();
    expect(screen.getByText(/too large to upload/i)).toBeInTheDocument();
  });
});
