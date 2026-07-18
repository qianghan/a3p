import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from '@/contexts/auth-context';

function TestButton() {
  const { loginWithOAuth } = useAuth();
  return <button onClick={() => loginWithOAuth('google')}>go</button>;
}

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  global.fetch = vi.fn();
  // jsdom's window.location.href is a getter/setter on the real Location
  // object and can't be `delete`d — redefine it as a plain writable property
  // instead so we can observe navigation without actually navigating.
  Object.defineProperty(window, 'location', {
    value: { ...window.location, href: '' },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

describe('loginWithOAuth — standalone-mode awareness', () => {
  it('requests the standalone-aware URL when display-mode: standalone matches', async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(display-mode: standalone)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { url: 'https://accounts.google.com/o/oauth2/authorize?x=1' } }),
    });

    render(<AuthProvider><TestButton /></AuthProvider>);
    fireEvent.click(screen.getByText('go'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/auth/oauth/google?standalone=1'),
        expect.objectContaining({ credentials: 'include' })
      );
    });
  });

  it('requests the plain URL (no standalone param) in a normal browser tab', async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { url: 'https://accounts.google.com/o/oauth2/authorize?x=1' } }),
    });

    render(<AuthProvider><TestButton /></AuthProvider>);
    fireEvent.click(screen.getByText('go'));

    await waitFor(() => {
      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).not.toContain('standalone=1');
    });
  });
});
