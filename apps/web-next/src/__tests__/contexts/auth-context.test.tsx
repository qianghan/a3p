import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from '@/contexts/auth-context';

function TestButton() {
  const { loginWithOAuth } = useAuth();
  return <button onClick={() => loginWithOAuth('google')}>go</button>;
}

function AuthState() {
  const { isAuthenticated, isLoading, authErrorStatus, user } = useAuth();
  if (isLoading) return <div>loading</div>;
  return <div>{`auth:${isAuthenticated} err:${authErrorStatus} user:${user?.email ?? 'none'}`}</div>;
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

describe('initial session hydration — OAuth httpOnly cookie', () => {
  // Regression: OAuth logins set an httpOnly naap_auth_token cookie that JS
  // can't read (no localStorage token either). fetchUser used to bail before
  // calling /auth/me, so the user looked logged-out while the cookie was live
  // → RequireAuth redirected to /login and middleware bounced back forever.
  it('authenticates via the cookie when there is no JS-readable token', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (String(url).includes('/v1/auth/me')) {
        return { ok: true, status: 200, json: async () => ({ data: { user: { email: 'oauth@x.com' } } }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    render(<AuthProvider><AuthState /></AuthProvider>);

    await waitFor(() => expect(screen.getByText(/auth:true/)).toBeTruthy());
    expect(screen.getByText(/user:oauth@x.com/)).toBeTruthy();

    // /me was called — with NO Authorization header (cookie-based) — proving we
    // no longer bail when getToken() is null.
    const meCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find((c) => String(c[0]).includes('/v1/auth/me'));
    expect(meCall).toBeTruthy();
    expect((meCall![1] as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBeUndefined();
    expect((meCall![1] as RequestInit).credentials).toBe('include');
  });

  it('surfaces a 401 (so RequireAuth clears the cookie) when the session is invalid', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (String(url).includes('/v1/auth/me')) return { ok: false, status: 401, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({}) };
    });

    render(<AuthProvider><AuthState /></AuthProvider>);

    await waitFor(() => expect(screen.getByText(/auth:false/)).toBeTruthy());
    expect(screen.getByText(/err:401/)).toBeTruthy();
  });
});
