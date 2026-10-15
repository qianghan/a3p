import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { installFetch, json, withShell } from './chat-test-utils';

vi.mock('@/app/app/_lib/image', () => ({ compressImage: vi.fn(async (f: File) => f) }));

import MobileChat from '../../../app/app/chat/page';

const ok = (data: unknown) => json(200, { success: true, data });
function server() {
  return installFetch(async (call) => {
    if (call.path === '/api/v1/agentbook-core/threads') return ok([]);
    return json(404, { success: false, error: `unmocked ${call.method} ${call.path}` });
  });
}
const goto = (qs: string) => window.history.replaceState({}, '', `/app/chat${qs}`);

afterEach(() => {
  vi.unstubAllGlobals();
  goto('');
});

describe('MobileChat — ?topic deep links', () => {
  it('tax_deadline prefills the composer and does not send', async () => {
    const { calls } = server();
    goto('?topic=tax_deadline');
    render(withShell(<MobileChat />));
    const input = (await screen.findByTestId('chat-input')) as HTMLTextAreaElement | HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('When is my next tax payment due, and how much is it?'));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('bill_due prefills a bills question', async () => {
    server();
    goto('?topic=bill_due');
    render(withShell(<MobileChat />));
    const input = (await screen.findByTestId('chat-input')) as HTMLTextAreaElement | HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('Which bills are due soon?'));
  });

  it('an unknown topic leaves the composer empty', async () => {
    server();
    goto('?topic=wire-me-money');
    render(withShell(<MobileChat />));
    const input = (await screen.findByTestId('chat-input')) as HTMLTextAreaElement | HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('no topic leaves the composer empty', async () => {
    server();
    goto('');
    render(withShell(<MobileChat />));
    const input = (await screen.findByTestId('chat-input')) as HTMLTextAreaElement | HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('prefills once: user edits and re-renders are not overwritten', async () => {
    const { calls } = server();
    goto('?topic=bill_due');
    const { rerender } = render(withShell(<MobileChat />));
    const input = (await screen.findByTestId('chat-input')) as HTMLTextAreaElement | HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('Which bills are due soon?'));
    fireEvent.change(input, { target: { value: 'my own text' } });
    rerender(withShell(<MobileChat />));
    expect(input.value).toBe('my own text');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});
