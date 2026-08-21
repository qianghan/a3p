import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ChatHistoryTab } from '../components/ChatHistoryTab';
// Prod mounts these inside the shell; bare rendering asserts against
// useI18n's key-humanising fallback. See ./i18n-harness.tsx.
import { withShell } from './i18n-harness';

const mockFetch = vi.fn();
beforeEach(() => { vi.stubGlobal('fetch', mockFetch); mockFetch.mockReset(); });

const ITEM = {
  id: '1', question: 'Spent $45 on lunch', answer: 'Logged $45 — Meals',
  channel: 'telegram', skillUsed: 'record-expense', createdAt: new Date().toISOString(),
};

function searchRes(items = [ITEM], total = 1, nextCursor: string | null = null) {
  return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { items, total, nextCursor } }) });
}

describe('ChatHistoryTab', () => {
  it('renders conversation items after load', async () => {
    mockFetch.mockReturnValue(searchRes());
    render(withShell(<ChatHistoryTab />));
    await waitFor(() => expect(screen.getByText(/Spent \$45 on lunch/)).toBeTruthy());
  });

  it('shows total count', async () => {
    mockFetch.mockReturnValue(searchRes([ITEM], 42));
    render(withShell(<ChatHistoryTab />));
    await waitFor(() => expect(screen.getByText(/42 messages/i)).toBeTruthy());
  });

  it('shows empty state when no results', async () => {
    mockFetch.mockReturnValue(searchRes([], 0, null));
    render(withShell(<ChatHistoryTab />));
    await waitFor(() => expect(screen.getByText(/No messages found/i)).toBeTruthy());
  });

  it('hides Load more when nextCursor is null', async () => {
    mockFetch.mockReturnValue(searchRes([ITEM], 1, null));
    render(withShell(<ChatHistoryTab />));
    await waitFor(() => expect(screen.queryByText(/Load more/i)).toBeNull());
  });

  it('shows Load more when nextCursor is set', async () => {
    mockFetch.mockReturnValue(searchRes([ITEM], 21, '2026-06-20T00:00:00.000Z'));
    render(withShell(<ChatHistoryTab />));
    await waitFor(() => expect(screen.getByText(/Load more/i)).toBeTruthy());
  });
});
