/**
 * useBasiqConnect — shared popup + postMessage + status-poll flow for
 * connecting a bank account via Basiq's hosted Consent UI (AU-1).
 *
 * Extracted from `plugins/agentbook-expense/frontend/src/pages/
 * BankConnection.tsx`'s original inline implementation (AU-1 Task 3, PR
 * #318) so the business-side (agentbook-expense) and personal-side
 * (apps/web-next's Personal Finance page) bank-connect flows share one
 * implementation instead of two near-identical copies (AU-1 Task 4).
 *
 * Lives in `@naap/plugin-sdk` rather than `apps/web-next/src/lib` — plugin
 * frontends (like agentbook-expense's) are built as standalone UMD bundles
 * with their own package.json/vite config and cannot import from
 * `apps/web-next/src`. `@naap/plugin-sdk` is the one workspace package both
 * surfaces already depend on and already share React hooks through (see
 * the sibling `useAgentEvents.ts`).
 *
 * This hook owns only the popup-open → wait-for-callback-postMessage →
 * poll-status-until-terminal part of the flow. Fetching the initial
 * `consentUrl` (the `POST .../bank/basiq/consent-url` call) is left to the
 * caller, since the two surfaces differ there: the personal-finance routes
 * are gated behind the paid Personal Insights add-on (a 402 the caller must
 * handle with its own messaging) while the business-side routes are not.
 *
 * Usage:
 *   const basiq = useBasiqConnect({
 *     apiBase: '/api/v1/agentbook-expense', // or '/api/v1/agentbook-personal'
 *     onConnected: async (accountsLinked) => { ...refresh account list... },
 *   });
 *
 *   async function handleStartConnectBasiq() {
 *     basiq.setConnecting(true);
 *     basiq.clearError();
 *     const res = await fetch(`${apiBase}/bank/basiq/consent-url`, { method: 'POST' });
 *     const data = await res.json();
 *     if (!data.success) { basiq.setError('...'); basiq.setConnecting(false); return; }
 *     basiq.startConnect(data.data.consentUrl);
 *   }
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// Basiq's hosted Consent UI can involve multi-step bank login/MFA — this is
// a legitimately slow (but healthy) flow, unlike a frozen-iframe failure
// mode. Give it materially longer than a typical "stuck UI" watchdog before
// giving up.
export const BASIQ_TIMEOUT_MS = 5 * 60 * 1000;
export const BASIQ_POLL_MS = 3000;

export interface BasiqStatusResponse {
  success: boolean;
  data?: {
    status: 'success' | 'in-progress' | 'failed' | string;
    accountsLinked?: number;
    error?: string;
  };
}

export interface UseBasiqConnectOptions {
  /** API base for this surface, e.g. '/api/v1/agentbook-expense' or '/api/v1/agentbook-personal'. */
  apiBase: string;
  /** Called once the job-status poll reports success. Caller should refetch its own account list. */
  onConnected: (accountsLinked: number) => void | Promise<void>;
}

export interface UseBasiqConnectResult {
  /** True from the moment the caller starts the flow until it ends (success, failure, timeout, or cancellation). */
  connecting: boolean;
  /** Error message from a failed/timed-out connection attempt, or null. */
  error: string | null;
  /** Manually set the connecting flag — used by the caller before/around its own initial consent-url fetch. */
  setConnecting: (value: boolean) => void;
  /** Manually set the error message — used by the caller if the initial consent-url fetch itself fails. */
  setError: (message: string | null) => void;
  /** Clear a previously-set error (e.g. a "Dismiss" button). */
  clearError: () => void;
  /**
   * Opens Basiq's hosted Consent UI in a popup for the given consentUrl,
   * waits for the callback route's postMessage, then polls status until
   * success/failure/timeout. Faithful extraction of BankConnection.tsx's
   * original inline flow — same timeout, same null-jobId (user-cancelled)
   * handling, same popup-closed fallback.
   */
  startConnect: (consentUrl: string) => void;
}

export function useBasiqConnect({ apiBase, onConnected }: UseBasiqConnectOptions): UseBasiqConnectResult {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const closeWatchRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const messageHandlerRef = useRef<((event: MessageEvent) => void) | null>(null);

  const clearAll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (closeWatchRef.current) {
      clearInterval(closeWatchRef.current);
      closeWatchRef.current = null;
    }
    if (messageHandlerRef.current) {
      window.removeEventListener('message', messageHandlerRef.current);
      messageHandlerRef.current = null;
    }
  }, []);

  // Cleanup on unmount — matches BankConnection.tsx's original
  // `useEffect(() => clearBasiqPolling, [clearBasiqPolling])`.
  useEffect(() => clearAll, [clearAll]);

  const startConnect = useCallback((consentUrl: string) => {
    const popup = window.open(consentUrl, 'basiq-consent', 'width=480,height=720');

    clearAll();

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || !('basiqJobId' in (event.data ?? {}))) return;
      window.removeEventListener('message', onMessage);
      messageHandlerRef.current = null;
      if (closeWatchRef.current) {
        clearInterval(closeWatchRef.current);
        closeWatchRef.current = null;
      }

      const jobId = event.data.basiqJobId as string | null;
      if (!jobId) {
        // User cancelled inside Basiq's hosted UI (or the redirect
        // otherwise arrived without a valid jobId) — stop cleanly, no
        // error, matching the Plaid onExit behavior on both surfaces.
        setConnecting(false);
        return;
      }

      const startedAt = Date.now();
      pollRef.current = setInterval(async () => {
        if (Date.now() - startedAt > BASIQ_TIMEOUT_MS) {
          clearAll();
          setError('Bank connection timed out — please try again.');
          setConnecting(false);
          return;
        }
        try {
          const statusRes = await fetch(`${apiBase}/bank/basiq/status?jobId=${encodeURIComponent(jobId)}`);
          const statusJson: BasiqStatusResponse = await statusRes.json();
          if (!statusJson.success || !statusJson.data) return; // transient — keep polling
          const status = statusJson.data;
          if (status.status === 'success') {
            clearAll();
            setConnecting(false);
            await onConnected(status.accountsLinked ?? 0);
          } else if (status.status === 'failed') {
            clearAll();
            setError(`Bank connection failed: ${status.error ?? 'unknown error'}`);
            setConnecting(false);
          }
        } catch {
          // transient network error — keep polling until timeout
        }
      }, BASIQ_POLL_MS);
    };
    messageHandlerRef.current = onMessage;
    window.addEventListener('message', onMessage);

    // Fallback: if the popup is closed without ever posting a message (user
    // cancelled inside Basiq's UI before completing consent, or simply
    // closed the window), stop waiting.
    closeWatchRef.current = setInterval(() => {
      if (popup?.closed) {
        clearAll();
        setConnecting(false);
      }
    }, 1000);
  }, [apiBase, onConnected, clearAll]);

  return {
    connecting,
    error,
    setConnecting,
    setError,
    clearError: useCallback(() => setError(null), []),
    startConnect,
  };
}
