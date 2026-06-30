'use client';

/**
 * Admin LLM provider config — a UI over the existing
 * /api/v1/agentbook-core/admin/llm-configs API (GET list, POST create,
 * [id]/set-default, [id]/test, DELETE). Self-contained so it can drop into the
 * admin Config page without touching the rest of it.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Cpu, Star, Trash2, Zap, Plus, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Button, Input, Select, Badge } from '@naap/ui';

interface LLMConfig {
  id: string;
  name: string;
  provider: string;
  apiKey: string; // redacted by the API
  enabled: boolean;
  isDefault: boolean;
  modelFast: string;
  modelStandard: string;
  modelPremium: string;
  modelVision: string;
}

const BASE = '/api/v1/agentbook-core/admin/llm-configs';
const PROVIDERS = ['gemini', 'openai', 'claude', 'kimi', 'minimax'];

export function LLMProvidersSection() {
  const [configs, setConfigs] = useState<LLMConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', provider: 'gemini', apiKey: '' });

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(BASE, { credentials: 'include' });
      const data = await res.json();
      if (data.success) setConfigs(data.data);
      else setError(data.error || 'Failed to load LLM providers');
    } catch {
      setError('Failed to load LLM providers');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 4000); };

  const act = async (path: string, method: string, body?: unknown, okMsg?: string) => {
    setError(null);
    const res = await fetch(path, {
      method, credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.success !== false) { if (okMsg) flash(okMsg); return data; }
    setError(data?.error || `Request failed (${res.status})`);
    return null;
  };

  const setDefault = async (id: string) => { setBusy(id); await act(`${BASE}/${id}/set-default`, 'POST', undefined, 'Default updated.'); await load(); setBusy(null); };
  const test = async (id: string) => { setBusy(id); const r = await act(`${BASE}/${id}/test`, 'POST', undefined); if (r) flash(r.data?.ok === false ? 'Test: provider returned an error' : 'Test passed.'); setBusy(null); };
  const remove = async (id: string) => { setBusy(id); await act(`${BASE}/${id}`, 'DELETE', undefined, 'Provider removed.'); await load(); setBusy(null); };
  const create = async () => {
    if (!form.name.trim() || !form.apiKey.trim()) { setError('Name and API key are required'); return; }
    setBusy('__new__');
    const r = await act(BASE, 'POST', { name: form.name.trim(), provider: form.provider, apiKey: form.apiKey.trim() }, 'Provider added.');
    if (r) { setForm({ name: '', provider: 'gemini', apiKey: '' }); setAdding(false); await load(); }
    setBusy(null);
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-md bg-muted"><Cpu className="w-5 h-5 text-muted-foreground" /></div>
          <div>
            <h2 className="text-base font-semibold">LLM Providers</h2>
            <p className="text-sm text-muted-foreground">The model providers the agent can use. One is the default.</p>
          </div>
        </div>
        <Button size="sm" variant="secondary" icon={<Plus size={16} />} onClick={() => setAdding((v) => !v)}>Add provider</Button>
      </div>

      {error && <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm"><AlertTriangle size={16} /> {error}</div>}
      {msg && <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/10 text-emerald-500 text-sm"><CheckCircle2 size={16} /> {msg}</div>}

      {adding && (
        <div className="p-4 rounded-lg border border-border bg-card grid sm:grid-cols-4 gap-2 items-end">
          <div><label className="text-xs text-muted-foreground">Name</label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Google Gemini" /></div>
          <div><label className="text-xs text-muted-foreground">Provider</label><Select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>{PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}</Select></div>
          <div><label className="text-xs text-muted-foreground">API key</label><Input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-…" /></div>
          <Button onClick={create} loading={busy === '__new__'}>Save</Button>
        </div>
      )}

      {loading ? (
        <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
      ) : configs.length === 0 ? (
        <div className="text-center py-6 text-muted-foreground text-sm">No LLM providers configured</div>
      ) : (
        <div className="grid gap-2">
          {configs.map((c) => (
            <div key={c.id} className="flex items-center gap-3 p-4 rounded-lg border border-border bg-card">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{c.name}</span>
                  <Badge variant="secondary">{c.provider}</Badge>
                  {c.isDefault && <Badge variant="amber">default</Badge>}
                  {!c.enabled && <Badge variant="rose">disabled</Badge>}
                </div>
                <p className="text-xs text-muted-foreground truncate mt-0.5 font-mono">{c.modelStandard} · key {c.apiKey}</p>
              </div>
              {!c.isDefault && <Button variant="ghost" size="sm" loading={busy === c.id} onClick={() => setDefault(c.id)} icon={<Star size={14} />}>Default</Button>}
              <Button variant="ghost" size="sm" loading={busy === c.id} onClick={() => test(c.id)} icon={<Zap size={14} />}>Test</Button>
              <Button variant="ghost" size="sm" onClick={() => remove(c.id)} icon={<Trash2 size={14} />} className="text-destructive hover:bg-destructive/10" />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
