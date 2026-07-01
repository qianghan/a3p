'use client';

import { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';
import { Loader2 } from 'lucide-react';
import { Wordmark } from '@/components/brand/Wordmark';
import { OAuthButtons, type OAuthProvider } from '@/components/auth/oauth-buttons';

function formatOAuthError(errorCode: string): string {
  const errorMessages: Record<string, string> = {
    invalid_provider: 'Invalid authentication provider.',
    no_code: 'Authentication was cancelled or failed. Please try again.',
    invalid_state: 'Authentication session expired. Please try again.',
    access_denied: 'Access was denied. Please try again.',
    oauth_failed: 'Authentication failed. Please try again.',
  };
  return errorMessages[errorCode] || decodeURIComponent(errorCode);
}

export default function LoginForm() {
  const { login, loginWithOAuth, isLoading, isAuthenticated } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [vhsPlayed, setVhsPlayed] = useState(false);

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      const raw = searchParams.get('redirect') || '/agentbook';
      const safeRedirect = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/agentbook';
      router.replace(safeRedirect);
    }
  }, [isLoading, isAuthenticated, router, searchParams]);

  useEffect(() => {
    const oauthError = searchParams.get('error');
    if (oauthError) setError(formatOAuthError(oauthError));
  }, [searchParams]);

  const handleOAuth = useCallback(async (provider: OAuthProvider) => {
    setError('');
    try { await loginWithOAuth(provider); }
    catch (err) { setError(err instanceof Error ? err.message : 'OAuth login failed'); }
  }, [loginWithOAuth]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try { await login(email, password); }
    catch (err) { setError(err instanceof Error ? err.message : 'Login failed'); }
  };

  return (
    <div className="w-full max-w-sm px-4">
      {/* AgentBook wordmark + brand */}
      <div className="text-center mb-8">
        <div className="mb-3"><Wordmark size={40} /></div>
        <h1 className="text-lg font-medium text-muted-foreground">Sign in to your account</h1>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-destructive text-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label htmlFor="email" className="block text-[13px] font-medium text-muted-foreground mb-1.5">
            Email
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-background border border-muted-foreground/25 rounded-lg text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-muted-foreground/50 focus:ring-1 focus:ring-muted-foreground/20 transition-colors"
            placeholder="you@example.com"
            required
          />
        </div>

        <div>
          <label htmlFor="password" className="block text-[13px] font-medium text-muted-foreground mb-1.5">
            Password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-background border border-muted-foreground/25 rounded-lg text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-muted-foreground/50 focus:ring-1 focus:ring-muted-foreground/20 transition-colors"
            placeholder="Enter your password"
            required
          />
        </div>

        <button
          type="submit"
          disabled={isLoading}
          className="w-full py-2.5 bg-gradient-to-b from-brand-bright to-brand-primary text-[#04231b] rounded-lg text-sm font-semibold transition hover:brightness-105 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
          Continue with email
        </button>
      </form>

      <div className="mt-2 text-center">
        <Link href="/forgot-password" className="text-[13px] text-muted-foreground/60 hover:text-muted-foreground transition-colors">
          Forgot password?
        </Link>
      </div>

      <div className="my-5">
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-border/40" />
          </div>
          <div className="relative flex justify-center text-[11px] uppercase tracking-wider">
            <span className="bg-background px-3 text-muted-foreground/60">or</span>
          </div>
        </div>
      </div>

      <OAuthButtons onSelect={handleOAuth} />

      <p className="mt-5 text-center text-[13px] text-muted-foreground">
        Don&apos;t have an account?{' '}
        <Link href="/register" className="text-foreground hover:underline">
          Sign up
        </Link>
      </p>
    </div>
  );
}
