import React, { useEffect, useState, useCallback } from 'react';
import { GraduationCap, Search, ExternalLink, Loader2, Plus, Trash2, Calendar } from 'lucide-react';
import { scholarshipApi, type Opportunity, type Candidate, STATUS_FLOW } from '../lib/api';

const inputCls =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30';

function fmtDeadline(d: string | null): string | null {
  if (!d) return null;
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString();
}

export const ScholarshipPage: React.FC = () => {
  const [items, setItems] = useState<Opportunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await scholarshipApi.list());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const runDiscover = async () => {
    setSearching(true);
    setSearchNote(null);
    try {
      const res = await scholarshipApi.discover(query.trim() || undefined);
      setCandidates(res.candidates);
      setSearchNote(res.note);
    } catch (e) {
      setSearchNote(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  };

  const track = async (c: Candidate) => {
    setSavingKey(c.sourceUrl + c.title);
    try {
      await scholarshipApi.save(c);
      setCandidates((cs) => cs.filter((x) => !(x.sourceUrl === c.sourceUrl && x.title === c.title)));
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingKey(null);
    }
  };

  const setStatus = async (id: string, status: string) => {
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, status } : x)));
    try { await scholarshipApi.setStatus(id, status); } catch { await load(); }
  };

  const remove = async (id: string) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
    try { await scholarshipApi.remove(id); } catch { await load(); }
  };

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-6">
      <div className="mb-5">
        <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
          <GraduationCap className="w-5 h-5" /> Scholarship Copilot
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Find scholarships you&apos;re eligible for, then track and prepare each one.
          AgentBook finds, drafts, and reminds — <strong>you review and submit</strong>.
        </p>
      </div>

      {/* Discover */}
      <div className="rounded-xl border border-border bg-card p-4 mb-6">
        <label className="block text-sm font-medium text-foreground mb-2">Find scholarships</label>
        <div className="flex gap-2">
          <input
            className={inputCls}
            placeholder="Optional focus — e.g. &ldquo;need-based&rdquo; or &ldquo;for computer science&rdquo;"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void runDiscover(); }}
          />
          <button
            onClick={() => void runDiscover()}
            disabled={searching}
            className="shrink-0 flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            Search
          </button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Matched to your school, region, and visa status from your profile. Every result links to its source — always confirm details there.
        </p>

        {searchNote && candidates.length === 0 && (
          <p className="mt-3 text-sm text-muted-foreground">{searchNote}</p>
        )}

        {candidates.length > 0 && (
          <div className="mt-4 space-y-2">
            {searchNote && <p className="text-xs text-muted-foreground">{searchNote}</p>}
            {candidates.map((c) => (
              <div key={c.sourceUrl + c.title} className="rounded-lg border border-border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">{c.title}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {[c.amountText, c.deadlineText && `Deadline: ${c.deadlineText}`].filter(Boolean).join(' · ')}
                    </div>
                    {c.eligibilitySummary && (
                      <div className="mt-1 text-xs text-muted-foreground">{c.eligibilitySummary}</div>
                    )}
                    <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer"
                      className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline">
                      {c.sourceLabel || 'Source'} <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                  <button
                    onClick={() => void track(c)}
                    disabled={savingKey === c.sourceUrl + c.title}
                    className="shrink-0 flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
                  >
                    {savingKey === c.sourceUrl + c.title ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                    Track
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tracker */}
      <h2 className="text-sm font-semibold text-foreground mb-2">Your scholarships</h2>
      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : err ? (
        <p className="text-sm text-destructive py-4">{err}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center rounded-lg border border-dashed border-border">
          Nothing tracked yet — search above, or track one you&apos;ve already found.
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((o) => (
            <div key={o.id} className="rounded-lg border border-border bg-card p-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">{o.title}</div>
                <div className="mt-0.5 text-xs text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  {o.payload?.amountText && <span>{o.payload.amountText}</span>}
                  {fmtDeadline(o.deadline) && (
                    <span className="inline-flex items-center gap-1"><Calendar className="w-3 h-3" />{fmtDeadline(o.deadline)}</span>
                  )}
                  {o.sourceUrl && (
                    <a href={o.sourceUrl} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline">
                      {o.sourceLabel || 'Source'} <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
                {o.payload?.eligibilitySummary && (
                  <div className="mt-1 text-xs text-muted-foreground">{o.payload.eligibilitySummary}</div>
                )}
              </div>
              <div className="shrink-0 flex items-center gap-2">
                <select
                  value={STATUS_FLOW.includes(o.status as typeof STATUS_FLOW[number]) ? o.status : 'shortlisted'}
                  onChange={(e) => void setStatus(o.id, e.target.value)}
                  className="rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground capitalize"
                >
                  {STATUS_FLOW.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <button onClick={() => void remove(o.id)} aria-label="Remove"
                  className="text-muted-foreground hover:text-destructive p-1 rounded hover:bg-muted">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
