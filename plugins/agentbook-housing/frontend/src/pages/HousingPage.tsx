import React, { useEffect, useState, useCallback } from 'react';
import { Home, Loader2, Plus, Trash2, MapPin, ExternalLink, Wallet } from 'lucide-react';
import { housingApi, fmtCents, type Listing, type Affordability, type ListingInput, STATUS_FLOW } from '../lib/api';

const inputCls =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30';

// Per-listing affordability vs the recommended max rent (30% of income).
function verdict(rentCents: number | null, maxCents: number | null): { label: string; cls: string } | null {
  if (rentCents == null || maxCents == null) return null;
  if (rentCents <= maxCents) return { label: 'Within budget', cls: 'bg-emerald-500/10 text-emerald-600' };
  if (rentCents <= maxCents * 1.15) return { label: 'A stretch', cls: 'bg-amber-500/10 text-amber-600' };
  return { label: 'Over budget', cls: 'bg-red-500/10 text-red-600' };
}

export const HousingPage: React.FC = () => {
  const [items, setItems] = useState<Listing[]>([]);
  const [aff, setAff] = useState<Affordability | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<{ title: string; rent: string; area: string; commute: string; leaseTerm: string; sourceUrl: string }>(
    { title: '', rent: '', area: '', commute: '', leaseTerm: '', sourceUrl: '' },
  );

  const load = useCallback(async () => {
    try {
      const [list, affordability] = await Promise.all([housingApi.list(), housingApi.affordability().catch(() => null)]);
      setItems(list);
      setAff(affordability);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    if (!form.title.trim()) return;
    setSaving(true);
    try {
      const rentNum = parseFloat(form.rent);
      const input: ListingInput = {
        title: form.title.trim(),
        rentCents: Number.isFinite(rentNum) && rentNum >= 0 ? Math.round(rentNum * 100) : null,
        area: form.area.trim() || null,
        commute: form.commute.trim() || null,
        leaseTerm: form.leaseTerm.trim() || null,
        sourceUrl: form.sourceUrl.trim() || null,
      };
      await housingApi.save(input);
      setForm({ title: '', rent: '', area: '', commute: '', leaseTerm: '', sourceUrl: '' });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const setStatus = async (id: string, status: string) => {
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, status } : x)));
    try { await housingApi.setStatus(id, status); } catch { await load(); }
  };
  const remove = async (id: string) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
    try { await housingApi.remove(id); } catch { await load(); }
  };

  const maxRent = aff?.recommendedMaxRentCents ?? null;

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-6">
      <div className="mb-5">
        <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
          <Home className="w-5 h-5" /> Housing Copilot
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Save the rentals you&apos;re considering and compare them — with an affordability check against your real budget.
        </p>
      </div>

      {/* Affordability summary */}
      <div className="rounded-xl border border-border bg-card p-4 mb-6">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground mb-1">
          <Wallet className="w-4 h-4" /> Your budget
        </div>
        {aff?.hasIncome ? (
          <p className="text-sm text-muted-foreground">
            Based on this month&apos;s income of <strong>{fmtCents(aff.monthlyIncomeCents)}</strong>, a comfortable rent is around{' '}
            <strong className="text-foreground">{fmtCents(maxRent)}/mo</strong> (≈30% of income). Listings above are flagged.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Add income in <strong>Personal finances</strong> to see affordability flags on your listings.
          </p>
        )}
      </div>

      {/* Add listing */}
      <div className="rounded-xl border border-border bg-card p-4 mb-6">
        <div className="text-sm font-medium text-foreground mb-2">Add a listing you&apos;re considering</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <input className={inputCls} placeholder="Name / address*" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <input className={inputCls} placeholder="Monthly rent (e.g. 1200)" inputMode="decimal" value={form.rent} onChange={(e) => setForm({ ...form, rent: e.target.value })} />
          <input className={inputCls} placeholder="Area / neighbourhood" value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })} />
          <input className={inputCls} placeholder="Commute (e.g. 20 min to campus)" value={form.commute} onChange={(e) => setForm({ ...form, commute: e.target.value })} />
          <input className={inputCls} placeholder="Lease term (e.g. 12 months)" value={form.leaseTerm} onChange={(e) => setForm({ ...form, leaseTerm: e.target.value })} />
          <input className={inputCls} placeholder="Listing URL (optional)" value={form.sourceUrl} onChange={(e) => setForm({ ...form, sourceUrl: e.target.value })} />
        </div>
        <button
          onClick={() => void add()}
          disabled={saving || !form.title.trim()}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Add listing
        </button>
      </div>

      {/* Listings */}
      <h2 className="text-sm font-semibold text-foreground mb-2">Your listings</h2>
      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : err ? (
        <p className="text-sm text-destructive py-4">{err}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center rounded-lg border border-dashed border-border">
          No listings yet — add one above to start comparing.
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((o) => {
            const v = verdict(o.amountCents, maxRent);
            return (
              <div key={o.id} className="rounded-lg border border-border bg-card p-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground flex items-center gap-2 flex-wrap">
                    {o.title}
                    {o.amountCents != null && <span className="text-muted-foreground font-normal">{fmtCents(o.amountCents)}/mo</span>}
                    {v && <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${v.cls}`}>{v.label}</span>}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5">
                    {o.payload?.area && <span className="inline-flex items-center gap-1"><MapPin className="w-3 h-3" />{o.payload.area}</span>}
                    {o.payload?.commute && <span>{o.payload.commute}</span>}
                    {o.payload?.leaseTerm && <span>{o.payload.leaseTerm}</span>}
                    {o.sourceUrl && (
                      <a href={o.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                        Listing <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-2">
                  <select
                    value={STATUS_FLOW.includes(o.status as typeof STATUS_FLOW[number]) ? o.status : 'considering'}
                    onChange={(e) => void setStatus(o.id, e.target.value)}
                    className="rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground capitalize"
                  >
                    {STATUS_FLOW.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <button onClick={() => void remove(o.id)} aria-label="Remove" className="text-muted-foreground hover:text-destructive p-1 rounded hover:bg-muted">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
