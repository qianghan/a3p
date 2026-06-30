'use client';

/**
 * Admin Global Config — Feature Flags.
 *
 * List, toggle, create, and delete global feature flags so launch features can
 * be dark-shipped and flipped on without a deploy. (LLM/model provider config
 * has its own existing API; a UI for it follows in a separate change.)
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ToggleRight, AlertTriangle, CheckCircle2, Plus, Trash2, Power, PowerOff } from 'lucide-react';
import { Button, Input, Badge } from '@naap/ui';
import { useAuth } from '@/contexts/auth-context';
import { AdminNav } from '@/components/admin/AdminNav';
import { LLMProvidersSection } from '@/components/admin/LLMProvidersSection';

interface Flag {
  key: string;
  enabled: boolean;
  description: string | null;
  updatedAt: string;
}

const PATH = '/api/v1/admin/feature-flags';

export default function AdminConfigPage() {
  const router = useRouter();
  const { hasRole } = useAuth();
  const [flags, setFlags] = useState<Flag[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const isAdmin = hasRole('system:admin');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(PATH, { credentials: 'include' });
      const data = await res.json();
      if (data.success) setFlags(data.data.flags);
      else setError(data.error || 'Failed to load flags');
    } catch {
      setError('Failed to load flags');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) { router.push('/agentbook'); return; }
    load();
  }, [isAdmin, load, router]);

  const flash = (m: string) => { setSuccessMsg(m); setTimeout(() => setSuccessMsg(null), 4000); };

  const toggle = async (flag: Flag) => {
    try {
      setBusy(flag.key);
      setError(null);
      const res = await fetch(PATH, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ key: flag.key, enabled: !flag.enabled }),
      });
      const data = await res.json();
      if (data.success) { setFlags((p) => p.map((f) => (f.key === flag.key ? { ...f, enabled: !f.enabled } : f))); flash(`${!flag.enabled ? 'Enabled' : 'Disabled'} "${flag.key}".`); }
      else setError(data.error || 'Toggle failed');
    } catch { setError('Toggle failed'); } finally { setBusy(null); }
  };

  const create = async () => {
    try {
      setBusy('__new__');
      setError(null);
      const res = await fetch(PATH, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ key: newKey, enabled: false, description: newDesc || undefined }),
      });
      const data = await res.json();
      if (data.success) { setNewKey(''); setNewDesc(''); flash(`Created "${data.data.key}".`); await load(); }
      else setError(data.error || 'Create failed');
    } catch { setError('Create failed'); } finally { setBusy(null); }
  };

  const remove = async (key: string) => {
    try {
      setBusy(key);
      setError(null);
      const res = await fetch(`${PATH}?key=${encodeURIComponent(key)}`, { method: 'DELETE', credentials: 'include' });
      const data = await res.json();
      if (data.success) { setFlags((p) => p.filter((f) => f.key !== key)); flash(`Deleted "${key}".`); }
      else setError(data.error || 'Delete failed');
    } catch { setError('Delete failed'); } finally { setBusy(null); }
  };

  if (!isAdmin) return null;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <AdminNav />

      <div className="flex items-center gap-3">
        <div className="p-2 rounded-md bg-muted"><ToggleRight className="w-5 h-5 text-muted-foreground" /></div>
        <div>
          <h1 className="text-lg font-semibold">Feature Flags</h1>
          <p className="text-sm text-muted-foreground">Global flags to dark-ship and toggle features without a deploy.</p>
        </div>
      </div>

      {error && <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm"><AlertTriangle size={16} /> {error}</div>}
      {successMsg && <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/10 text-emerald-500 text-sm"><CheckCircle2 size={16} /> {successMsg}</div>}

      <div className="p-4 rounded-lg border border-border bg-card flex flex-col sm:flex-row gap-2 sm:items-end">
        <div className="flex-1"><label className="text-xs text-muted-foreground">Key</label><Input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="agentbook.new-feature" /></div>
        <div className="flex-1"><label className="text-xs text-muted-foreground">Description (optional)</label><Input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="What it gates" /></div>
        <Button onClick={create} loading={busy === '__new__'} disabled={!newKey.trim()} icon={<Plus size={16} />}>Add flag</Button>
      </div>

      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>
      ) : flags.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground"><ToggleRight size={32} className="mx-auto mb-3 opacity-30" /><p className="text-sm">No flags yet</p></div>
      ) : (
        <div className="grid gap-2">
          {flags.map((flag) => (
            <div key={flag.key} className={`flex items-center gap-3 p-4 rounded-lg border ${flag.enabled ? 'bg-card border-border' : 'bg-muted/30 border-border/50'}`}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium">{flag.key}</span>
                  <Badge variant={flag.enabled ? 'emerald' : 'secondary'}>{flag.enabled ? 'on' : 'off'}</Badge>
                </div>
                {flag.description && <p className="text-xs text-muted-foreground truncate mt-0.5">{flag.description}</p>}
              </div>
              <Button variant="ghost" size="sm" loading={busy === flag.key} onClick={() => toggle(flag)} icon={flag.enabled ? <PowerOff size={14} /> : <Power size={14} />}>
                {flag.enabled ? 'Disable' : 'Enable'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => remove(flag.key)} icon={<Trash2 size={14} />} className="text-destructive hover:bg-destructive/10" />
            </div>
          ))}
        </div>
      )}

      <hr className="border-border" />
      <LLMProvidersSection />
    </div>
  );
}
