'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import { useRouter, usePathname } from 'next/navigation';
import type { User } from '@naap/types';

// Re-export for consumers that import User from here
export type { User };

export interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  sessionExpiresAt: Date | null;
  authErrorStatus: number | null;
}

export interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  loginWithOAuth: (provider: 'google' | 'github') => Promise<void>;
  loginWithWallet: (address: string, signature: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshSession: () => Promise<void>;
  hasRole: (role: string) => boolean;
  hasAnyRole: (roles: string[]) => boolean;
  hasPermission: (permission: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE_KEYS = {
  AUTH_TOKEN: 'naap_auth_token',
  CSRF_TOKEN: 'naap_csrf_token',
} as const;

// Helper to sync token to both localStorage and cookie for middleware access
function setTokenStorage(token: string | null) {
  if (typeof window === 'undefined') return;

  if (token) {
    localStorage.setItem(STORAGE_KEYS.AUTH_TOKEN, token);
    // Set cookie for middleware (httpOnly should be handled by server)
    document.cookie = `${STORAGE_KEYS.AUTH_TOKEN}=${token}; path=/; max-age=${60 * 60 * 24 * 7}; samesite=strict`;
  } else {
    localStorage.removeItem(STORAGE_KEYS.AUTH_TOKEN);
    // Clear cookie
    document.cookie = `${STORAGE_KEYS.AUTH_TOKEN}=; path=/; max-age=0`;
  }
}

// Fetch a CSRF token from the server and store it in sessionStorage.
// Called after successful login so that plugin API calls include the token.
async function fetchAndStoreCsrfToken() {
  try {
    const res = await fetch('/api/v1/auth/csrf', { credentials: 'include' });
    if (res.ok) {
      const json = await res.json();
      const token = json.data?.token || json.token;
      if (token && typeof window !== 'undefined') {
        sessionStorage.setItem(STORAGE_KEYS.CSRF_TOKEN, token);
      }
    }
  } catch {
    // Non-critical — the SDK's getCsrfToken() will generate a fallback
  }
}

// Clear ALL auth-related storage (use on logout or invalid session)
// Note: httpOnly cookies (naap_auth_token, naap_csrf_token) cannot be cleared via JavaScript.
// The logout endpoint (/api/v1/auth/logout) handles clearing those server-side.
// This function clears client-accessible storage only.
function clearAllAuthStorage() {
  if (typeof window === 'undefined') return;

  // Clear localStorage tokens
  localStorage.removeItem(STORAGE_KEYS.AUTH_TOKEN);
  localStorage.removeItem(STORAGE_KEYS.CSRF_TOKEN);

  // Clear session storage (may contain cached user data)
  try {
    sessionStorage.clear();
  } catch {
    // Ignore errors
  }
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();

  const [state, setState] = useState<AuthState>({
    user: null,
    isAuthenticated: false,
    isLoading: true,
    sessionExpiresAt: null,
    authErrorStatus: null,
  });

  const getToken = useCallback(() => {
    if (typeof window === 'undefined') return null;
    
    // Try localStorage first
    const localToken = localStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
    if (localToken) return localToken;
    
    // Fallback to reading from cookie (in case localStorage was cleared)
    const cookieMatch = document.cookie.match(new RegExp('(^| )' + STORAGE_KEYS.AUTH_TOKEN + '=([^;]+)'));
    return cookieMatch ? cookieMatch[2] : null;
  }, []);

  const fetchUser = useCallback(async (): Promise<{ user: User | null; authErrorStatus: number | null }> => {
    const token = getToken();
    if (!token) {
      return { user: null, authErrorStatus: null };
    }

    try {
      const response = await fetch(`${API_BASE}/v1/auth/me`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
        },
        credentials: 'include', // Include cookies in request
        cache: 'no-store', // Prevent Next.js from caching
      });

      if (!response.ok) {
        if (response.status === 401) {
          // Clear ALL auth storage on unauthorized (token invalid/expired)
          clearAllAuthStorage();
          return { user: null, authErrorStatus: 401 };
        }
        // 5xx / other non-OK: surface the status so RequireAuth can decide
        // whether to redirect or show an error UI. Returning authErrorStatus=null
        // here is what previously caused the endless-reload loop on /agentbook
        // (middleware sends cookie-holder → /agentbook, RequireAuth redirects
        // to /login without clearing cookie, middleware sends back → loop).
        return { user: null, authErrorStatus: response.status };
      }

      const data = await response.json();

      // Handle both wrapped ({ data: { user } }) and unwrapped ({ user }) responses
      const userData = data.data?.user || data.user;
      if (!userData) {
        console.warn('[auth] API returned 200 but no user data - clearing stale auth');
        clearAllAuthStorage();
        return { user: null, authErrorStatus: 200 };
      }
      
      // Ensure token is synced to localStorage if it's missing
      if (!localStorage.getItem(STORAGE_KEYS.AUTH_TOKEN) && token) {
        localStorage.setItem(STORAGE_KEYS.AUTH_TOKEN, token);
      }

      // Ensure CSRF token is available for plugin mutations (non-blocking)
      if (!sessionStorage.getItem(STORAGE_KEYS.CSRF_TOKEN)) {
        fetchAndStoreCsrfToken();
      }

      return { user: userData, authErrorStatus: null };
    } catch (error) {
      console.error('Error fetching user:', error);
      // Do not treat transient failures as invalid sessions.
      return { user: null, authErrorStatus: null };
    }
  }, [getToken]);

  useEffect(() => {
    let mounted = true;
    const initAuth = async () => {
      const { user, authErrorStatus } = await fetchUser();
      if (mounted) {
        setState({
          user,
          isAuthenticated: !!user,
          isLoading: false,
          sessionExpiresAt: null,
          authErrorStatus,
        });
      }
    };
    initAuth();
    return () => { mounted = false; };
  }, [fetchUser]);

  const login = useCallback(async (email: string, password: string) => {
    setState(prev => ({ ...prev, isLoading: true }));
    try {
      const response = await fetch(`${API_BASE}/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include', // Include cookies
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) {
        if (response.status === 429) {
          throw new Error('Too many sign-in attempts. Please try again later.');
        }
        if (response.status >= 500) {
          throw new Error('Unable to sign in right now. Please try again later.');
        }
        throw new Error('Invalid email or password');
      }
      const data = await response.json();

      // Handle both wrapped ({ data: { user, token } }) and unwrapped responses
      const userData = data.data?.user || data.user;
      const tokenData = data.data?.token || data.token;
      const expiresAtData = data.data?.expiresAt || data.expiresAt;

      // Store token if provided (for client-side auth checks)
      if (tokenData) {
        setTokenStorage(tokenData);
      }

      // Fetch CSRF token so plugin mutations include X-CSRF-Token
      await fetchAndStoreCsrfToken();

      setState({
        user: userData,
        isAuthenticated: true,
        isLoading: false,
        sessionExpiresAt: expiresAtData ? new Date(expiresAtData) : null,
        authErrorStatus: null,
      });
      router.push('/agentbook');
    } catch (error) {
      setState(prev => ({ ...prev, isLoading: false }));
      throw error;
    }
  }, [router]);

  const loginWithOAuth = useCallback(async (provider: 'google' | 'github') => {
    try {
      const response = await fetch(`${API_BASE}/v1/auth/oauth/${provider}`, {
        credentials: 'include',
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error?.message || err.message || 'Failed to initiate OAuth');
      }
      const data = await response.json();
      const url = data.data?.url || data.url;
      if (url) {
        window.location.href = url;
      } else {
        throw new Error(`OAuth provider ${provider} is not configured`);
      }
    } catch (error) {
      console.error('OAuth error:', error);
      throw error;
    }
  }, []);

  const loginWithWallet = useCallback(async (address: string, signature: string) => {
    setState(prev => ({ ...prev, isLoading: true }));
    try {
      const response = await fetch(`${API_BASE}/v1/auth/wallet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include', // Include cookies
        body: JSON.stringify({ address, signature }),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Wallet login failed');
      }
      const data = await response.json();

      // Handle both wrapped and unwrapped responses
      const userData = data.data?.user || data.user;
      const tokenData = data.data?.token || data.token;
      const expiresAtData = data.data?.expiresAt || data.expiresAt;

      // Store token if provided
      if (tokenData) {
        setTokenStorage(tokenData);
      }

      // Fetch CSRF token so plugin mutations include X-CSRF-Token
      await fetchAndStoreCsrfToken();

      setState({
        user: userData,
        isAuthenticated: true,
        isLoading: false,
        sessionExpiresAt: expiresAtData ? new Date(expiresAtData) : null,
        authErrorStatus: null,
      });
      router.push('/agentbook');
    } catch (error) {
      setState(prev => ({ ...prev, isLoading: false }));
      throw error;
    }
  }, [router]);

  const logout = useCallback(async () => {
    // Mark an intentional sign-out so the ProtectedRoute guard doesn't race us
    // to /login when it sees the cleared session on a protected page.
    if (typeof window !== 'undefined') (window as unknown as { __abSigningOut?: boolean }).__abSigningOut = true;
    const token = getToken();
    if (token) {
      try {
        await fetch(`${API_BASE}/v1/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          credentials: 'include', // Include cookies
        });
      } catch (error) {
        console.error('Logout error:', error);
      }
    }
    // Clear ALL auth storage to ensure clean state
    clearAllAuthStorage();
    setState({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      sessionExpiresAt: null,
      authErrorStatus: null,
    });
    // Force hard navigation to clear any cached state. Explicit sign-out lands
    // on the marketing landing page (the front door), not the sign-in form.
    window.location.href = '/';
  }, [getToken, router]);

  const refreshSession = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    try {
      const response = await fetch(`${API_BASE}/v1/auth/refresh`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'include', // Include cookies
      });
      if (!response.ok) throw new Error('Session refresh failed');
      const data = await response.json();

      // Handle both wrapped and unwrapped responses
      const tokenData = data.data?.token || data.token;
      const expiresAtData = data.data?.expiresAt || data.expiresAt;

      // Store token if provided
      if (tokenData) {
        setTokenStorage(tokenData);
      }

      setState(prev => ({
        ...prev,
        sessionExpiresAt: expiresAtData ? new Date(expiresAtData) : null,
      }));
    } catch (error) {
      console.error('Session refresh error:', error);
      await logout();
    }
  }, [getToken, logout]);

  const hasRole = useCallback((role: string) => {
    return state.user?.roles?.includes(role) ?? false;
  }, [state.user]);

  const hasAnyRole = useCallback((roles: string[]) => {
    return roles.some(role => state.user?.roles?.includes(role));
  }, [state.user]);

  const hasPermission = useCallback((permission: string) => {
    if (state.user?.permissions?.includes('*')) return true;
    return state.user?.permissions?.includes(permission) ?? false;
  }, [state.user]);

  const value = useMemo<AuthContextValue>(() => ({
    ...state,
    login,
    loginWithOAuth,
    loginWithWallet,
    logout,
    refreshSession,
    hasRole,
    hasAnyRole,
    hasPermission,
  }), [state, login, loginWithOAuth, loginWithWallet, logout, refreshSession, hasRole, hasAnyRole, hasPermission]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export function RequireAuth({
  children,
  requiredRoles,
  fallback,
}: {
  children: ReactNode;
  requiredRoles?: string[];
  fallback?: ReactNode;
}) {
  const { user, isAuthenticated, isLoading, authErrorStatus, hasAnyRole } = useAuth();
  const pathname = usePathname();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      // Intentional sign-out is navigating to the landing page ('/') itself —
      // don't hijack it with a /login redirect.
      if (typeof window !== 'undefined' && (window as unknown as { __abSigningOut?: boolean }).__abSigningOut) {
        return;
      }
      // Three cases:
      //   1. 401 or 200-without-user → explicit invalid session: clear cookie
      //      via /logout and redirect to /login. Middleware will then allow
      //      the user to reach the login page.
      //   2. 5xx or other non-OK → /auth/me is failing transiently. Do NOT
      //      redirect — that creates an endless reload loop because the
      //      middleware sees the cookie and bounces /login back to /agentbook.
      //      Stay on the page; the user sees the error UI below.
      //   3. authErrorStatus === null AND no token → unauthenticated visitor,
      //      simple redirect to /login is safe (no cookie → no middleware
      //      bounce-back).
      const hasExplicitInvalidSession =
        authErrorStatus === 401 || (authErrorStatus === 200 && !user);
      const hasTransientServerError =
        typeof authErrorStatus === 'number' && authErrorStatus >= 500;

      if (hasTransientServerError) {
        // Render the error UI below — do NOT redirect.
        return;
      }

      if (hasExplicitInvalidSession) {
        clearAllAuthStorage();
        fetch('/api/v1/auth/logout', { method: 'GET', credentials: 'include' })
          .catch(() => {})
          .finally(() => {
            window.location.replace(`/login?redirect=${encodeURIComponent(pathname)}`);
          });
      } else {
        window.location.replace(`/login?redirect=${encodeURIComponent(pathname)}`);
      }
    }
  }, [isLoading, isAuthenticated, authErrorStatus, user, pathname]);

  if (isLoading) {
    return fallback ?? (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      </div>
    );
  }

  // /auth/me is failing transiently (5xx). Showing an error UI here breaks
  // the redirect loop with middleware: the cookie still exists, so any
  // attempt to redirect to /login would be bounced back to /agentbook.
  const transientServerError =
    !isAuthenticated && typeof authErrorStatus === 'number' && authErrorStatus >= 500;
  if (transientServerError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
        <h1 className="text-xl font-semibold">We're having trouble loading your session</h1>
        <p className="mt-2 text-sm text-muted-foreground max-w-md">
          The authentication service returned an error ({authErrorStatus}). This is usually
          temporary. Try reloading the page, or sign out and back in.
        </p>
        <div className="mt-6 flex gap-3">
          <button
            onClick={() => window.location.reload()}
            className="rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:opacity-90"
          >
            Reload
          </button>
          <button
            onClick={() => {
              clearAllAuthStorage();
              fetch('/api/v1/auth/logout', { method: 'GET', credentials: 'include' })
                .catch(() => {})
                .finally(() => {
                  window.location.replace('/login');
                });
            }}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  // Show loading state while redirecting to login
  if (!isAuthenticated) {
    return fallback ?? (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      </div>
    );
  }

  if (requiredRoles && !hasAnyRole(requiredRoles)) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center">
        <h1 className="text-2xl font-bold text-destructive">Access Denied</h1>
        <p className="text-muted-foreground mt-2">You do not have permission to view this page.</p>
      </div>
    );
  }

  return <>{children}</>;
}
