import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from '@/contexts/auth-context';
import { SNAPSHOT_PREFIX, SNAPSHOT_OWNER_KEY } from '@/lib/mobile/snapshot-keys';

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

describe('/app snapshots never outlive the session that saved them', () => {
  const SNAP = `${SNAPSHOT_PREFIX}home`;
  const mockMe = (status: number, user?: { id: string; email: string }) =>
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (String(url).includes('/v1/auth/me')) {
        return { ok: status === 200, status, json: async () => (user ? { data: { user } } : {}) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

  function LoginButton() {
    const { login } = useAuth();
    return <button onClick={() => login('a@b.c', 'pw').catch(() => {})}>signin</button>;
  }

  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(SNAP, '{"data":{"balance":1000},"savedAt":"2026-10-07T14:30:00.000Z"}');
  });
  afterEach(() => window.localStorage.clear());

  it('clears them when the session turns out to be invalid (401)', async () => {
    mockMe(401);
    render(<AuthProvider><AuthState /></AuthProvider>);
    await waitFor(() => expect(screen.getByText(/err:401/)).toBeTruthy());
    expect(window.localStorage.getItem(SNAP)).toBeNull();
  });

  it('clears them at the start of a login, before the request settles', async () => {
    mockMe(401);
    render(<AuthProvider><AuthState /><LoginButton /></AuthProvider>);
    await waitFor(() => expect(screen.getByText(/err:401/)).toBeTruthy());
    window.localStorage.setItem(SNAP, '{"data":{"balance":1000},"savedAt":"2026-10-07T14:30:00.000Z"}');
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));
    fireEvent.click(screen.getByText('signin'));
    await waitFor(() => expect(window.localStorage.getItem(SNAP)).toBeNull());
  });

  it('keeps them for the same user who saved them', async () => {
    window.localStorage.setItem(SNAPSHOT_OWNER_KEY, 'u1');
    mockMe(200, { id: 'u1', email: 'a@x.com' });
    render(<AuthProvider><AuthState /></AuthProvider>);
    await waitFor(() => expect(screen.getByText(/user:a@x.com/)).toBeTruthy());
    expect(window.localStorage.getItem(SNAP)).not.toBeNull();
  });

  it('drops them when a different user is signed in without a logout', async () => {
    window.localStorage.setItem(SNAPSHOT_OWNER_KEY, 'u1');
    mockMe(200, { id: 'u2', email: 'b@x.com' });
    render(<AuthProvider><AuthState /></AuthProvider>);
    await waitFor(() => expect(screen.getByText(/user:b@x.com/)).toBeTruthy());
    await waitFor(() => expect(window.localStorage.getItem(SNAP)).toBeNull());
    expect(window.localStorage.getItem(SNAPSHOT_OWNER_KEY)).toBe('u2');
  });

  it('still clears them when removing the auth tokens throws', async () => {
    const realRemove = Storage.prototype.removeItem;
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key: string) {
      if (key.startsWith('naap_')) throw new Error('denied');
      return realRemove.call(this, key);
    });
    mockMe(401);
    render(<AuthProvider><AuthState /></AuthProvider>);
    await waitFor(() => expect(screen.getByText(/err:401/)).toBeTruthy());
    expect(window.localStorage.getItem(SNAP)).toBeNull();
  });
});
