/**
 * Tax fast-track questionnaire tab (PR-4) — a UI-native path to answer the
 * same adaptive questionnaire chat already drives (PR-3), plus a review/
 * download screen for the generated filing draft + client letter.
 *
 * Same plain useState + useEffect + relative fetch() pattern as
 * TaxPackageContent/PastFilingsPage in this same plugin — no new state
 * library. Polls GET /status while a session is mid-conversation or a
 * draft is 'pending', mirroring PastFilings.tsx's poll-while-processing
 * pattern exactly.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileText, Loader2, Send, XCircle } from 'lucide-react';

const API = '/api/v1/agentbook-core/tax-fast-track';

interface QaPair { question: string; answer: string; }

interface StatusResponse {
  session: { id: string; status: string; qaHistory: QaPair[]; askedCount: number } | null;
  draft: {
    status: string;
    draftPdfUrl: string | null;
    letterPdfUrl: string | null;
    draftSummary: {
      estimatedTotalIncomeCents?: number;
      estimatedTaxableIncomeCents?: number;
      estimatedTaxPayableCents?: number;
      taxPayableDeltaVsLastYearCents?: number;
      changesFromLastYear: string[];
      openQuestions: string[];
      caveat: string;
    } | null;
    errorMsg: string | null;
    stale: boolean;
  } | null;
}

const fmtMoney = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const FastTrackTab: React.FC = () => {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [sending, setSending] = useState(false);
  const [answerText, setAnswerText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/status`);
      const j = await res.json();
      if (j.success) setData(j.data);
    } catch { /* silent, matches PastFilingsPage's own load() */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    pollRef.current = setInterval(() => {
      setData((prev) => {
        const shouldPoll = prev?.session?.status === 'in_progress' || prev?.draft?.status === 'pending';
        if (shouldPoll) load();
        return prev;
      });
    }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [load]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch(`${API}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
      const j = await res.json();
      if (!j.success) { setError(j.error || 'Failed to start.'); return; }
      if (j.data.status === 'blocked') { setError(j.data.message); return; }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const sendAnswer = async () => {
    if (!answerText.trim()) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`${API}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: answerText }) });
      const j = await res.json();
      if (!j.success) { setError(j.error || 'Failed to send answer.'); return; }
      setAnswerText('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const cancel = async () => {
    if (!confirm('Cancel the tax fast-track questionnaire?')) return;
    await fetch(`${API}/cancel`, { method: 'POST' });
    await load();
  };

  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    if (!data?.session?.id || retrying) return; // guard against a double-click firing two concurrent generations
    setRetrying(true);
    try {
      await fetch(`${API}/regenerate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: data.session.id }) });
      await load();
    } finally {
      setRetrying(false);
    }
  };

  if (loading) {
    return <div className="px-4 py-5 sm:p-6 max-w-3xl mx-auto text-sm text-muted-foreground">Loading…</div>;
  }

  const { session, draft } = data || { session: null, draft: null };

  return (
    <div className="px-4 py-5 sm:p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <FileText className="w-6 h-6 text-primary" />
        <h1 className="text-2xl font-bold">Tax Fast-Track</h1>
      </div>

      {error && <p className="text-sm text-red-500 mb-4">{error}</p>}

      {/* Screen 1: no active session, no draft */}
      {!session && (
        <div className="bg-card border border-border rounded-xl p-6 text-center">
          <p className="text-sm text-muted-foreground mb-4">
            Answer a short, adaptive set of questions based on your confirmed prior-year return, and get an estimated filing draft plus a cover letter for your accountant.
          </p>
          <button
            onClick={start}
            disabled={starting}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg font-medium disabled:opacity-50 inline-flex items-center gap-2"
          >
            {starting ? <><Loader2 className="w-4 h-4 animate-spin" /> Starting…</> : 'Start'}
          </button>
        </div>
      )}

      {/* Screen 2: active session, incomplete — the transcript + answer box */}
      {session && session.status === 'in_progress' && (
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="space-y-3 mb-4">
            {session.qaHistory.map((qa, i) => (
              <div key={i} className="border-b border-border/50 pb-2 last:border-0">
                <p className="text-sm font-medium">{qa.question}</p>
                {qa.answer ? <p className="text-sm text-muted-foreground mt-1">{qa.answer}</p> : <p className="text-xs text-primary mt-1">Waiting for your answer…</p>}
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={answerText}
              onChange={(e) => setAnswerText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') sendAnswer(); }}
              placeholder="Type your answer…"
              className="flex-1 p-2 border border-border rounded-lg bg-background text-sm"
              disabled={sending}
            />
            <button onClick={sendAnswer} disabled={sending || !answerText.trim()} className="px-3 py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-50">
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
            <button onClick={cancel} className="px-3 py-2 border border-border rounded-lg text-muted-foreground hover:bg-muted/50">
              <XCircle className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Screen 3: completed, draft pending */}
      {session && session.status === 'completed' && draft && draft.status === 'pending' && !draft.stale && (
        <div className="bg-card border border-border rounded-xl p-6 text-center">
          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2 text-primary" />
          <p className="text-sm text-muted-foreground">Generating your draft…</p>
        </div>
      )}

      {/* Screen 4: draft ready — review + download */}
      {draft && draft.status === 'ready' && draft.draftSummary && (
        <div className="bg-card border border-border rounded-xl p-4 space-y-4">
          {draft.draftSummary.estimatedTaxPayableCents != null && (
            <div>
              <h2 className="text-sm font-medium text-muted-foreground mb-2">Estimated figures</h2>
              <div className="text-sm space-y-1">
                <div className="flex justify-between"><span>Estimated tax payable</span><span>{fmtMoney(draft.draftSummary.estimatedTaxPayableCents)}</span></div>
                {draft.draftSummary.taxPayableDeltaVsLastYearCents != null && (
                  <div className="flex justify-between text-muted-foreground">
                    <span>Vs. last year's actual tax payable</span>
                    <span>{draft.draftSummary.taxPayableDeltaVsLastYearCents >= 0 ? '+' : '-'}{fmtMoney(Math.abs(draft.draftSummary.taxPayableDeltaVsLastYearCents))}</span>
                  </div>
                )}
              </div>
            </div>
          )}
          <div>
            <h2 className="text-sm font-medium text-muted-foreground mb-2">What changed this year</h2>
            {draft.draftSummary.changesFromLastYear.length
              ? <ul className="text-sm list-disc pl-4 space-y-1">{draft.draftSummary.changesFromLastYear.map((c, i) => <li key={i}>{c}</li>)}</ul>
              : <p className="text-sm text-muted-foreground">No material changes identified.</p>}
          </div>
          <div>
            <h2 className="text-sm font-medium text-muted-foreground mb-2">Open questions for your accountant</h2>
            {draft.draftSummary.openQuestions.length
              ? <ul className="text-sm list-disc pl-4 space-y-1">{draft.draftSummary.openQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul>
              : <p className="text-sm text-muted-foreground">None identified.</p>}
          </div>
          <p className="text-xs italic text-red-700">{draft.draftSummary.caveat}</p>
          <div className="flex gap-2 pt-2 border-t border-border">
            {draft.draftPdfUrl && (
              <a href={draft.draftPdfUrl} target="_blank" rel="noreferrer" className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-muted/50 inline-flex items-center gap-1">
                <Download className="w-3.5 h-3.5" /> Filing draft
              </a>
            )}
            {draft.letterPdfUrl && (
              <a href={draft.letterPdfUrl} target="_blank" rel="noreferrer" className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-muted/50 inline-flex items-center gap-1">
                <Download className="w-3.5 h-3.5" /> Client letter
              </a>
            )}
          </div>
        </div>
      )}

      {/* Screen 5: failed, or stuck pending past the staleness timeout */}
      {draft && (draft.status === 'failed' || draft.stale) && (
        <div className="bg-card border border-border rounded-xl p-6 text-center">
          <p className="text-sm text-red-500 mb-3">
            {draft.status === 'failed' ? `Something went wrong (${draft.errorMsg}).` : 'This is taking longer than expected.'}
          </p>
          <button onClick={retry} disabled={retrying} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg font-medium disabled:opacity-50 inline-flex items-center gap-2">
            {retrying ? <><Loader2 className="w-4 h-4 animate-spin" /> Retrying…</> : 'Try again'}
          </button>
        </div>
      )}

      {/* A cancelled/abandoned session with no draft falls back to screen 1's copy on next load (session is not null but status isn't in_progress/completed) */}
      {session && session.status !== 'in_progress' && session.status !== 'completed' && !draft && (
        <div className="bg-card border border-border rounded-xl p-6 text-center">
          <p className="text-sm text-muted-foreground mb-4">Your last fast-track session was cancelled. Start a new one whenever you're ready.</p>
          <button onClick={start} disabled={starting} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg font-medium disabled:opacity-50 inline-flex items-center gap-2">
            {starting ? <><Loader2 className="w-4 h-4 animate-spin" /> Starting…</> : 'Start'}
          </button>
        </div>
      )}
    </div>
  );
};
