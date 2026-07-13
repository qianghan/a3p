'use client';
import { useEffect, useState } from 'react';
import { getCsrfToken } from '@/lib/api/csrf';

export function ConsentForm({ uid }: { uid: string }) {
  const [details, setDetails] = useState<{ clientId: string; clientName: string; alreadyGranted: boolean } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`/api/v1/oauth/interaction?uid=${uid}`).then((r) => r.json()).then(setDetails);
  }, [uid]);

  async function respond(allow: boolean) {
    setSubmitting(true);
    // The server now enforces CSRF on this mutation (it grants/denies a
    // durable consent record) the same way every other cookie-authenticated
    // mutation in this codebase does — see ConnectedAppsList.tsx for the
    // established client-side pattern this mirrors.
    const csrfToken = await getCsrfToken();
    const res = await fetch('/api/v1/oauth/consent-decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ uid, allow }),
    });
    const { redirectTo } = await res.json();
    window.location.href = redirectTo;
  }

  if (!details) return null;

  return (
    <div className="max-w-md mx-auto mt-24 p-6 rounded-xl border border-border bg-card">
      <h1 className="text-lg font-semibold mb-2">Connect to AgentBook</h1>
      <p className="text-sm text-muted-foreground mb-6">
        <strong>{details.clientName}</strong> wants to access your AgentBook data —
        expenses, invoices, tax info — and take actions on your behalf
        (you&apos;ll always be asked to confirm before anything is recorded or sent).
        {details.alreadyGranted && ' You previously approved this app.'}
      </p>
      <div className="flex gap-3">
        <button
          disabled={submitting}
          onClick={() => respond(true)}
          className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
        >
          Allow
        </button>
        <button
          disabled={submitting}
          onClick={() => respond(false)}
          className="px-4 py-2 rounded-lg border border-border text-sm font-medium disabled:opacity-50"
        >
          Deny
        </button>
      </div>
    </div>
  );
}
