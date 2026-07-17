'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Wordmark } from '@/components/brand/Wordmark';
import { OAuthButtons, type OAuthProvider } from '@/components/auth/oauth-buttons';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';

export default function RegisterForm() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vhsPlayed, setVhsPlayed] = useState(false);
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    confirmPassword: '',
    displayName: '',
    ageConfirmed: false,
  });
  const [ref, setRef] = useState<string | null>(null);

  // Capture a referral code from ?ref= and stash it in a cookie so it also
  // survives the OAuth sign-up round-trip.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('ref');
    if (code) {
      const clean = code.trim().toUpperCase().slice(0, 32);
      setRef(clean);
      document.cookie = `ab_ref=${encodeURIComponent(clean)}; path=/; max-age=${60 * 60 * 24 * 30}; SameSite=Lax`;
    }
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (formData.password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (!formData.ageConfirmed) {
      setError('Please confirm you are at least 18 and agree to the Terms and Privacy Policy');
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch(`${API_BASE}/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: formData.email,
          password: formData.password,
          displayName: formData.displayName,
          ageConfirmed: formData.ageConfirmed,
          ...(ref ? { ref } : {}),
        }),
      });
      if (!response.ok) {
        if (response.status === 429) {
          throw new Error('Too many attempts. Please wait and try again.');
        }
        throw new Error('Unable to create account. Please try again later.');
      }
      sessionStorage.setItem('pendingVerificationEmail', formData.email);
      router.push('/verify-email');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      setError(msg.includes('Too many') ? msg : 'Unable to create account. Please try again later.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleOAuthRegister = (provider: OAuthProvider) => {
    window.location.href = `${API_BASE}/v1/auth/oauth/${provider}?action=register`;
  };

  const inputClass =
    'w-full px-3 py-2 text-sm bg-background border border-muted-foreground/25 rounded-lg text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-muted-foreground/50 focus:ring-1 focus:ring-muted-foreground/20 transition-colors';

  return (
    <div className="w-full max-w-sm px-4">
      {/* AgentBook wordmark */}
      <div className="text-center mb-8">
        <div className="mb-3"><Wordmark size={40} /></div>
        <h1 className="text-lg font-medium text-muted-foreground">Create your account</h1>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-destructive text-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label htmlFor="displayName" className="block text-[13px] font-medium text-muted-foreground mb-1.5">
            Name
          </label>
          <input
            id="displayName"
            name="displayName"
            type="text"
            value={formData.displayName}
            onChange={handleChange}
            className={inputClass}
            placeholder="Your name"
            required
          />
        </div>

        <div>
          <label htmlFor="email" className="block text-[13px] font-medium text-muted-foreground mb-1.5">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            value={formData.email}
            onChange={handleChange}
            className={inputClass}
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
            name="password"
            type="password"
            value={formData.password}
            onChange={handleChange}
            className={inputClass}
            placeholder="Min. 8 characters"
            required
            minLength={8}
          />
        </div>

        <div>
          <label htmlFor="confirmPassword" className="block text-[13px] font-medium text-muted-foreground mb-1.5">
            Confirm password
          </label>
          <input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            value={formData.confirmPassword}
            onChange={handleChange}
            className={inputClass}
            placeholder="Confirm your password"
            required
          />
        </div>

        <label className="flex items-start gap-2 text-[11px] text-muted-foreground/60 cursor-pointer">
          <input
            type="checkbox"
            name="ageConfirmed"
            checked={formData.ageConfirmed}
            onChange={(e) => setFormData(prev => ({ ...prev, ageConfirmed: e.target.checked }))}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-muted-foreground/40 accent-brand-primary"
            required
          />
          <span>
            I confirm I am at least 18 years old and agree to the{' '}
            <Link href="/legal/terms" className="hover:text-muted-foreground transition-colors">
              Terms
            </Link>{' '}
            and{' '}
            <Link href="/legal/privacy" className="hover:text-muted-foreground transition-colors">
              Privacy Policy
            </Link>
            .
          </span>
        </label>

        <button
          type="submit"
          disabled={isLoading}
          className="w-full py-2.5 bg-gradient-to-b from-brand-bright to-brand-primary text-[#04231b] rounded-lg text-sm font-semibold transition hover:brightness-105 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {isLoading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Creating account...
            </>
          ) : (
            'Create account'
          )}
        </button>
      </form>

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

      <OAuthButtons onSelect={handleOAuthRegister} />

      <p className="mt-5 text-center text-[13px] text-muted-foreground">
        Already have an account?{' '}
        <Link href="/login" className="text-foreground hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
