'use client';

/**
 * Admin Payroll Providers — choose the payroll provider per jurisdiction and
 * store its API key. The built-in calculator is the default everywhere; other
 * providers are recorded for when their adapter ships.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Banknote, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Button, Input, Select, Badge } from '@naap/ui';
import { useAuth } from '@/contexts/auth-context';
import { AdminNav } from '@/components/admin/AdminNav';

interface ProviderMeta {
  id: string;
  label: string;
  description: string;
  status: 'ready' | 'planned';
  requiresApiKey: boolean;
  coverage: string;
}
interface JurisdictionConfig {
  jurisdiction: string;
  provider: string;
  enabled: boolean;
  hasApiKey: boolean;
}

const JNAME: Record<string, string> = { us: 'United States', ca: 'Canada', uk: 'United Kingdom', au: 'Australia' };

export default function AdminPayrollPage() {
  const router = useRouter();
  const { hasRole } = useAuth();
  const [config, setConfig] = useState<JurisdictionConfig[]>([]);
  const [providers, setProviders] = useState<ProviderMeta[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { provider: string; apiKey: string }>>({});
  const [loading, setLoading] = useState(true);
  const [savingJ, setSavingJ] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const isAdmin = hasRole('system:admin');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/v1/admin/payroll-providers', { credentials: 'include' });
      const data = await res.json();
      if (data.success) {
        setConfig(data.data.config);
        setProviders(data.data.providers);
        setDrafts(Object.fromEntries(data.data.config.map((c: JurisdictionConfig) => [c.jurisdiction, { provider: c.provider, apiKey: '' }])));
      } else setError(data.error || 'Failed to load');
    } catch {
      setError('Failed to load payroll config');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) { router.push('/agentbook'); return; }
    load();
  }, [isAdmin, load, router]);

  const save = async (jurisdiction: string) => {
    const draft = drafts[jurisdiction];
    if (!draft) return;
    try {
      setSavingJ(jurisdiction);
      setError(null);
      setSuccessMsg(null);
      const res = await fetch('/api/v1/admin/payroll-providers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ jurisdiction, provider: draft.provider, apiKey: draft.apiKey || undefined }),
      });
      const data = await res.json();
      if (data.success) {
        setSuccessMsg(`Saved ${JNAME[jurisdiction] || jurisdiction}.`);
        setTimeout(() => setSuccessMsg(null), 4000);
        await load();
      } else setError(data.error || 'Save failed');
    } catch {
      setError('Save failed');
    } finally {
      setSavingJ(null);
    }
  };

  if (!isAdmin) return null;

  const metaFor = (id: string) => providers.find((p) => p.id === id);

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <AdminNav />

      <div className="flex items-center gap-3">
        <div className="p-2 rounded-md bg-muted"><Banknote className="w-5 h-5 text-muted-foreground" /></div>
        <div>
          <h1 className="text-lg font-semibold">Payroll Providers</h1>
          <p className="text-sm text-muted-foreground">
            Choose how payroll runs per country. The built-in calculator is the default; connect a provider to run real payroll.
          </p>
        </div>
      </div>

      {error && <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm"><AlertTriangle size={16} /> {error}</div>}
      {successMsg && <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/10 text-emerald-500 text-sm"><CheckCircle2 size={16} /> {successMsg}</div>}

      <div className="p-4 rounded-lg bg-muted/50 border border-border/50 text-sm text-muted-foreground">
        Recommendation: keep <strong>Calculator</strong> as the default (free, every country). For real US+CA payroll the best single provider is <strong>Deel</strong>; <strong>Finch</strong> is the cheapest option to read an existing payroll into the books. Selecting a provider before its adapter ships is recorded — pay runs use the calculator until then.
      </div>

      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>
      ) : (
        <div className="grid gap-3">
          {config.map((c) => {
            const draft = drafts[c.jurisdiction] || { provider: c.provider, apiKey: '' };
            const meta = metaFor(draft.provider);
            return (
              <div key={c.jurisdiction} className="p-4 rounded-lg border border-border bg-card">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{JNAME[c.jurisdiction] || c.jurisdiction.toUpperCase()}</span>
                    <Badge variant={c.provider === 'calculator' ? 'secondary' : 'blue'}>{c.provider}</Badge>
                    {c.hasApiKey && <Badge variant="emerald">key set</Badge>}
                  </div>
                  <Button size="sm" loading={savingJ === c.jurisdiction} onClick={() => save(c.jurisdiction)}>Save</Button>
                </div>
                <div className="grid sm:grid-cols-2 gap-3">
                  <Select
                    value={draft.provider}
                    onChange={(e) => setDrafts((d) => ({ ...d, [c.jurisdiction]: { ...draft, provider: e.target.value } }))}
                  >
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}{p.status === 'planned' ? ' — coming soon' : ''}</option>
                    ))}
                  </Select>
                  {meta?.requiresApiKey && (
                    <Input
                      type="password"
                      placeholder={c.hasApiKey ? '•••••••• (set — type to replace)' : `${meta.label} API key`}
                      value={draft.apiKey}
                      onChange={(e) => setDrafts((d) => ({ ...d, [c.jurisdiction]: { ...draft, apiKey: e.target.value } }))}
                    />
                  )}
                </div>
                {meta && <p className="text-xs text-muted-foreground mt-2">{meta.description} · Coverage: {meta.coverage}</p>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
