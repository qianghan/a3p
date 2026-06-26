import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TelegramCard } from '../components/TelegramCard';

const mockFetch = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

function statusRes(data: object) {
  return Promise.resolve({ json: () => Promise.resolve({ success: true, data }) });
}

describe('TelegramCard', () => {
  it('shows connect form when not configured', async () => {
    mockFetch.mockReturnValue(statusRes({ configured: false }));
    render(<TelegramCard />);
    await waitFor(() => expect(screen.queryByText(/Loading/i)).toBeNull());
    expect(screen.getByPlaceholderText(/Paste bot token/i)).toBeTruthy();
    expect(screen.getByText(/Connect Bot/i)).toBeTruthy();
  });

  it('shows connected state with bot username', async () => {
    mockFetch.mockReturnValue(statusRes({
      configured: true,
      botUsername: 'agentbookdev_bot',
      webhookActive: true,
      chatIds: ['111'],
    }));
    render(<TelegramCard />);
    await waitFor(() => expect(screen.getByText(/@agentbookdev_bot/)).toBeTruthy());
    expect(screen.getByText(/Active/i)).toBeTruthy();
  });

  it('disables Connect button when token is empty', async () => {
    mockFetch.mockReturnValue(statusRes({ configured: false }));
    render(<TelegramCard />);
    await waitFor(() => expect(screen.queryByText(/Loading/i)).toBeNull());
    const btn = screen.getByRole('button', { name: /Connect Bot/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });
});
