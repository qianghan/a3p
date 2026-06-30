'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Users, Plus, Play, Loader2, Check } from 'lucide-react';

const API = '/api/v1/agentbook-payroll';

interface Employee { id: string; name: string; payType: string; payRateCents: number; payFrequency: string; jurisdiction: string }
interface Stub { id: string; employeeName: string; grossCents: number; federalTaxCents: number; ficaCents: number; netCents: number }
interface PayRun { id: string; periodStart: string; periodEnd: string; status: string; stubs: Stub[] }

const fmt$ = (c: number) => '$' + (c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
const JURIS = [{ v: 'us', l: '🇺🇸 US' }, { v: 'ca', l: '🇨🇦 CA' }, { v: 'uk', l: '🇬🇧 UK' }, { v: 'au', l: '🇦🇺 AU' }];
const FREQ = ['weekly', 'biweekly', 'semimonthly', 'monthly'];

export default function PayrollPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [runs, setRuns] = useState<PayRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [salary, setSalary] = useState('');
  const [freq, setFreq] = useState('biweekly');
  const [juris, setJuris] = useState('us');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [e, r] = await Promise.all([
        fetch(`${API}/employees`).then((x) => x.json()),
        fetch(`${API}/pay-runs`).then((x) => x.json()),
      ]);
      if (e?.success) setEmployees(e.data);
      if (r?.success) setRuns(r.data);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const addEmployee = async () => {
    setBusy(true);
    try {
      await fetch(`${API}/employees`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), payRateCents: Math.round(Number(salary) * 100), payFrequency: freq, jurisdiction: juris }),
      });
      setName(''); setSalary(''); setShowForm(false);
      await load();
    } finally { setBusy(false); }
  };

  const runPayroll = async () => {
    setBusy(true);
    try {
      const now = new Date();
      const start = new Date(now); start.setDate(now.getDate() - 14);
      const create = await fetch(`${API}/pay-runs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ periodStart: start.toISOString().slice(0, 10), periodEnd: now.toISOString().slice(0, 10) }),
      }).then((x) => x.json());
      if (create?.success) {
        await fetch(`${API}/pay-runs/${create.data.id}/process`, { method: 'POST' });
      }
      await load();
    } finally { setBusy(false); }
  };

  if (loading) return <div className="flex justify-center py-24"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2"><Users className="w-5 h-5" /> Payroll</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Pay employees and contractors with automatic withholding.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowForm((s) => !s)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border border-border hover:bg-muted">
            <Plus className="w-4 h-4" /> Employee
          </button>
          <button onClick={() => void runPayroll()} disabled={busy || employees.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
            <Play className="w-4 h-4" /> Run payroll
          </button>
        </div>
      </div>

      {showForm && (
        <div className="rounded-xl border border-border bg-card p-4 mb-5 grid grid-cols-1 sm:grid-cols-5 gap-3 items-end">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
          <input type="number" value={salary} onChange={(e) => setSalary(e.target.value)} placeholder="Annual salary" className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
          <select value={freq} onChange={(e) => setFreq(e.target.value)} className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground capitalize">
            {FREQ.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <select value={juris} onChange={(e) => setJuris(e.target.value)} className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground">
            {JURIS.map((j) => <option key={j.v} value={j.v}>{j.l}</option>)}
          </select>
          <button onClick={() => void addEmployee()} disabled={busy || !name || !salary} className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">Save</button>
        </div>
      )}

      <h2 className="text-sm font-semibold text-foreground mb-2">Employees ({employees.length})</h2>
      {employees.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center rounded-xl border border-border bg-card mb-6">No employees yet.</p>
      ) : (
        <div className="rounded-xl border border-border bg-card divide-y divide-border mb-6">
          {employees.map((e) => (
            <div key={e.id} className="flex items-center justify-between px-4 py-3">
              <div><p className="text-sm font-medium text-foreground">{e.name}</p>
                <p className="text-xs text-muted-foreground capitalize">{e.payFrequency} · {e.jurisdiction.toUpperCase()}</p></div>
              <p className="text-sm text-foreground">{fmt$(e.payRateCents)}/yr</p>
            </div>
          ))}
        </div>
      )}

      <h2 className="text-sm font-semibold text-foreground mb-2">Pay runs</h2>
      {runs.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center rounded-xl border border-border bg-card">No pay runs yet.</p>
      ) : (
        <div className="space-y-3">
          {runs.map((r) => {
            const gross = r.stubs.reduce((s, st) => s + st.grossCents, 0);
            const net = r.stubs.reduce((s, st) => s + st.netCents, 0);
            return (
              <div key={r.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-medium text-foreground">
                    {new Date(r.periodStart).toLocaleDateString()} – {new Date(r.periodEnd).toLocaleDateString()}
                  </p>
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600">
                    {r.status === 'paid' && <Check className="w-3.5 h-3.5" />}{r.status}
                  </span>
                </div>
                <div className="flex gap-4 text-xs text-muted-foreground mb-2">
                  <span>Gross {fmt$(gross)}</span><span>Net {fmt$(net)}</span><span>{r.stubs.length} employees</span>
                </div>
                <div className="divide-y divide-border">
                  {r.stubs.map((st) => (
                    <div key={st.id} className="flex items-center justify-between py-1.5 text-xs">
                      <span className="text-foreground">{st.employeeName}</span>
                      <span className="text-muted-foreground">gross {fmt$(st.grossCents)} · tax {fmt$(st.federalTaxCents + st.ficaCents)} · net <span className="text-foreground font-medium">{fmt$(st.netCents)}</span></span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
