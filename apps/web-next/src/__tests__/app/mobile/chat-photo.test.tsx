import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { installFetch, json, withShell, type Call } from './chat-test-utils';

const { compress } = vi.hoisted(() => ({
  compress: vi.fn(async (f: File) => new File([f], 'compressed.jpg', { type: 'image/jpeg' })),
}));
vi.mock('@/app/app/_lib/image', () => ({ compressImage: (f: File) => compress(f) }));

import MobileChat from '../../../app/app/chat/page';

const RECEIPT = '/api/v1/agentbook-expense/expenses/from-receipt';
const doc = {
  id: 'doc9', date: '2026-10-07', amountCents: 450, vendorName: 'E2E Coffee', description: null,
  categoryId: null, categoryName: null, categorySource: null, confidence: 0.9, status: 'confirmed',
  isPersonal: false, receiptUrl: 'https://x.public.blob.vercel-storage.com/r.jpg', receiptStatus: 'attached',
  archivedAt: null, suggestion: null,
};

function server(receipt: (call: Call) => Response | Promise<Response>) {
  return installFetch(async (call) => {
    if (call.path === '/api/v1/agentbook-core/threads') return json(200, { success: true, data: [] });
    if (call.path === RECEIPT && call.method === 'POST') return receipt(call);
    return json(404, { success: false });
  });
}
const pick = (file: File) => {
  fireEvent.click(screen.getByTestId('chat-attach'));
  fireEvent.change(screen.getByTestId('chat-file-library'), { target: { files: [file] } });
};
const keyOf = (c: Call) => (c.body as FormData).get('idempotencyKey');

afterEach(() => { vi.unstubAllGlobals(); compress.mockClear(); });

describe('MobileChat photo attach', () => {
  it('compresses, uploads via from-receipt, and links the new doc', async () => {
    // Hold the upload open so the transient 'uploading' state can be observed (an instant mock makes it a race).
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    const { calls } = server(async () => {
      await held;
      return json(200, { success: true, data: { doc, duplicate: false, ocr: { amountCents: 450, vendor: 'E2E Coffee', date: '2026-10-07' } } });
    });
    render(withShell(<MobileChat />));
    await screen.findByTestId('chat-empty');
    pick(new File(['raw'], 'IMG_1.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByTestId('chat-receipt')).toHaveAttribute('data-status', 'uploading');
    release();
    await waitFor(() => expect(screen.getByTestId('chat-receipt')).toHaveAttribute('data-status', 'done'));
    expect(compress).toHaveBeenCalledTimes(1);
    const upload = calls.filter((c) => c.path === RECEIPT);
    expect(upload).toHaveLength(1);
    expect(((upload[0].body as FormData).get('file') as File).name).toBe('compressed.jpg');
    expect(screen.getByTestId('chat-receipt')).toHaveTextContent('E2E Coffee');
    expect(screen.getByTestId('chat-receipt')).toHaveTextContent('$4.50');
    expect(screen.getByTestId('chat-receipt-open')).toHaveAttribute('href', '/app/docs/doc9');
    // Never sent to the agent brain (D1).
    expect(calls.some((c) => c.path === '/api/v1/agentbook-core/agent/message')).toBe(false);
  });

  it('retry after a failed upload reuses the SAME idempotency key', async () => {
    let n = 0;
    const { calls } = server(() => (++n === 1
      ? json(500, { success: false, error: 'boom' })
      : json(200, { success: true, data: { doc, duplicate: false, ocr: { amountCents: 450, vendor: null, date: null } } })));
    render(withShell(<MobileChat />));
    await screen.findByTestId('chat-empty');
    pick(new File(['raw'], 'IMG_2.jpg', { type: 'image/jpeg' }));
    await waitFor(() => expect(screen.getByTestId('chat-receipt')).toHaveAttribute('data-status', 'failed'));
    expect(screen.getByTestId('chat-receipt')).toHaveTextContent("Couldn't save the receipt.");
    fireEvent.click(screen.getByTestId('chat-receipt-retry'));
    await waitFor(() => expect(screen.getByTestId('chat-receipt')).toHaveAttribute('data-status', 'done'));
    const uploads = calls.filter((c) => c.path === RECEIPT);
    expect(uploads).toHaveLength(2);
    expect(keyOf(uploads[0])).toBeTruthy();
    expect(keyOf(uploads[1])).toBe(keyOf(uploads[0]));
    expect(screen.getAllByTestId('chat-receipt')).toHaveLength(1);
  });

  it('a duplicate (same key replayed server-side) is labelled Already saved', async () => {
    server(() => json(200, { success: true, data: { doc, duplicate: true, ocr: { amountCents: 450, vendor: null, date: null } } }));
    render(withShell(<MobileChat />));
    await screen.findByTestId('chat-empty');
    pick(new File(['raw'], 'IMG_3.jpg', { type: 'image/jpeg' }));
    await waitFor(() => expect(screen.getByTestId('chat-receipt')).toHaveTextContent('Already saved'));
  });

  it('two photos get two different keys', async () => {
    const { calls } = server(() => json(200, { success: true, data: { doc, duplicate: false, ocr: { amountCents: null, vendor: null, date: null } } }));
    render(withShell(<MobileChat />));
    await screen.findByTestId('chat-empty');
    pick(new File(['a'], 'a.jpg', { type: 'image/jpeg' }));
    await waitFor(() => expect(screen.getAllByTestId('chat-receipt')[0]).toHaveAttribute('data-status', 'done'));
    pick(new File(['b'], 'b.jpg', { type: 'image/jpeg' }));
    await waitFor(() => expect(screen.getAllByTestId('chat-receipt')).toHaveLength(2));
    await waitFor(() => expect(calls.filter((c) => c.path === RECEIPT)).toHaveLength(2));
    const [k1, k2] = calls.filter((c) => c.path === RECEIPT).map(keyOf);
    expect(k1).not.toBe(k2);
  });
});
