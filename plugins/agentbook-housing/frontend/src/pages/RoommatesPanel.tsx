import React, { useEffect, useState, useCallback } from 'react';
import { Loader2, Users, ShieldCheck, Power, Search } from 'lucide-react';
import {
  roommateApi, fmtCents, LIFESTYLE_TAGS,
  type RoommateProfile, type RoommateMatch, type RoommateProfileInput,
} from '../lib/api';

const inputCls =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30';

function budgetText(min: number | null, max: number | null): string {
  if (min == null && max == null) return 'any budget';
  if (min != null && max != null) return `${fmtCents(min)}–${fmtCents(max)}/mo`;
  if (max != null) return `up to ${fmtCents(max)}/mo`;
  return `from ${fmtCents(min)}/mo`;
}

export const RoommatesPanel: React.FC = () => {
  const [profile, setProfile] = useState<RoommateProfile | null>(null);
  const [matches, setMatches] = useState<RoommateMatch[]>([]);
  const [matchNote, setMatchNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Draft form state (seeded from an existing profile).
  const [handle, setHandle] = useState('');
  const [jurisdiction, setJurisdiction] = useState('us');
  const [area, setArea] = useState('');
  const [budgetMin, setBudgetMin] = useState('');
  const [budgetMax, setBudgetMax] = useState('');
  const [moveIn, setMoveIn] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [bio, setBio] = useState('');
  const [consent, setConsent] = useState(false);

  const seed = useCallback((p: RoommateProfile | null) => {
    setHandle(p?.displayHandle ?? '');
    setJurisdiction(p?.jurisdiction ?? 'us');
    setArea(p?.area ?? '');
    setBudgetMin(p?.budgetMinCents != null ? String(Math.round(p.budgetMinCents / 100)) : '');
    setBudgetMax(p?.budgetMaxCents != null ? String(Math.round(p.budgetMaxCents / 100)) : '');
    setMoveIn(p?.moveInMonth ?? '');
    setTags(p?.lifestyle ?? []);
    setBio(p?.bio ?? '');
    setConsent(Boolean(p?.active));
  }, []);

  const load = useCallback(async () => {
    try {
      const p = await roommateApi.getProfile();
      setProfile(p);
      seed(p);
      if (p?.active) {
        const m = await roommateApi.matches();
        setMatches(m.matches);
        setMatchNote(m.note);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [seed]);

  useEffect(() => { void load(); }, [load]);

  const toggleTag = (t: string) =>
    setTags((xs) => (xs.includes(t) ? xs.filter((x) => x !== t) : [...xs, t]));

  const cents = (s: string): number | null => {
    const n = parseFloat(s);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
  };

  const save = async (active: boolean) => {
    setErr(null);
    if (active && (!handle.trim() || !area.trim())) {
      setErr('A display handle and an area are required to go live.');
      return;
    }
    if (active && !consent) {
      setErr('Please tick the consent box to make your profile discoverable.');
      return;
    }
    setSaving(true);
    try {
      const input: RoommateProfileInput = {
        active,
        consent,
        displayHandle: handle.trim() || 'Student',
        jurisdiction,
        area: area.trim(),
        budgetMinCents: cents(budgetMin),
        budgetMaxCents: cents(budgetMax),
        moveInMonth: moveIn.trim() || null,
        lifestyle: tags,
        bio: bio.trim() || null,
      };
      const saved = await roommateApi.saveProfile(input);
      setProfile(saved);
      seed(saved);
      if (saved.active) {
        const m = await roommateApi.matches();
        setMatches(m.matches);
        setMatchNote(m.note);
      } else {
        setMatches([]);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const withdraw = async () => {
    setSaving(true);
    try {
      await roommateApi.withdraw();
      setProfile(null);
      seed(null);
      setMatches([]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>;
  }

  const isLive = Boolean(profile?.active);

  return (
    <div>
      {/* Consent / privacy explainer */}
      <div className="rounded-xl border border-border bg-card p-4 mb-6">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground mb-1">
          <ShieldCheck className="w-4 h-4" /> How roommate matching works
        </div>
        <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-0.5">
          <li>Your profile is <strong>off until you turn it on</strong>, and only opted-in students appear in matches.</li>
          <li>We store <strong>no contact details and no exact address</strong> — just a handle, area, budget, and preferences.</li>
          <li>AgentBook shows <strong>compatibility only</strong>. It never messages anyone — you reach out through your school or housing group.</li>
          <li>Turn your profile off any time to disappear from every match list instantly.</li>
        </ul>
      </div>

      {err && <p className="text-sm text-destructive mb-3">{err}</p>}

      {/* Profile editor */}
      <div className="rounded-xl border border-border bg-card p-4 mb-6">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-medium text-foreground">Your roommate profile</div>
          {isLive
            ? <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600">Live &amp; discoverable</span>
            : <span className="text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">Off</span>}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <input className={inputCls} placeholder="Display handle* (not your real name)" value={handle} onChange={(e) => setHandle(e.target.value)} />
          <select className={inputCls} value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)}>
            <option value="us">United States</option>
            <option value="ca">Canada</option>
            <option value="uk">United Kingdom</option>
            <option value="au">Australia</option>
          </select>
          <input className={inputCls} placeholder="Area / campus* (e.g. Boston, UBC)" value={area} onChange={(e) => setArea(e.target.value)} />
          <input className={inputCls} placeholder="Move-in month (e.g. 2026-09)" value={moveIn} onChange={(e) => setMoveIn(e.target.value)} />
          <input className={inputCls} placeholder="Budget min /mo (e.g. 800)" inputMode="decimal" value={budgetMin} onChange={(e) => setBudgetMin(e.target.value)} />
          <input className={inputCls} placeholder="Budget max /mo (e.g. 1500)" inputMode="decimal" value={budgetMax} onChange={(e) => setBudgetMax(e.target.value)} />
        </div>
        <textarea className={`${inputCls} mt-2`} rows={2} placeholder="Short intro (optional — no contact info)" value={bio} onChange={(e) => setBio(e.target.value)} />

        <div className="mt-3">
          <div className="text-xs text-muted-foreground mb-1">Lifestyle preferences</div>
          <div className="flex flex-wrap gap-1.5">
            {LIFESTYLE_TAGS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => toggleTag(t)}
                className={`text-[11px] px-2 py-1 rounded-full border ${tags.includes(t) ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:bg-muted'}`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <label className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
          <input type="checkbox" className="mt-0.5" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>I consent to my handle, area, budget, and preferences being shown to other opted-in students for roommate matching. No contact details are shared.</span>
        </label>

        <div className="mt-3 flex flex-wrap gap-2">
          {isLive ? (
            <>
              <button onClick={() => void save(true)} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} Save &amp; refresh matches
              </button>
              <button onClick={() => void save(false)} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-muted disabled:opacity-50">
                <Power className="w-4 h-4" /> Turn off
              </button>
              <button onClick={() => void withdraw()} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50">
                Delete profile
              </button>
            </>
          ) : (
            <button onClick={() => void save(true)} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Users className="w-4 h-4" />} Go live &amp; find roommates
            </button>
          )}
        </div>
      </div>

      {/* Matches */}
      {isLive && (
        <>
          <h2 className="text-sm font-semibold text-foreground mb-1">Compatible students</h2>
          {matchNote && <p className="text-xs text-muted-foreground mb-3">{matchNote}</p>}
          {matches.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center rounded-lg border border-dashed border-border">
              No compatible students yet — check back as more opt in for your area.
            </p>
          ) : (
            <div className="space-y-2">
              {matches.map((m, i) => (
                <div key={`${m.displayHandle}-${i}`} className="rounded-lg border border-border bg-card p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium text-foreground">{m.displayHandle}</div>
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-primary/10 text-primary">{m.score}% match</span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {m.area} · {budgetText(m.budgetMinCents, m.budgetMaxCents)}{m.moveInMonth ? ` · move-in ${m.moveInMonth}` : ''}
                  </div>
                  {m.reasons.length > 0 && (
                    <div className="mt-1 text-xs text-muted-foreground">Why: {m.reasons.join(' · ')}</div>
                  )}
                  {m.bio && <div className="mt-1 text-xs text-foreground/80 italic">“{m.bio}”</div>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};
