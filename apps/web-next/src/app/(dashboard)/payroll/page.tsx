'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Users, Plus, Play, Loader2, Check, Landmark, FileText, CalendarClock, Download, AlertTriangle } from 'lucide-react';
import { formatCurrencyCents } from '@/lib/jurisdiction-currency';

const API = '/api/v1/agentbook-payroll';

interface Employee { id: string; name: string; payType: string; payRateCents: number; payFrequency: string; jurisdiction: string; region: string }
interface Stub { id: string; employeeName: string; grossCents: number; federalTaxCents: number; stateTaxCents: number; ficaCents: number; netCents: number; sgCents: number }
interface PayRun { id: string; periodStart: string; periodEnd: string; status: string; stubs: Stub[] }
interface Deposit { id: string; form: string; periodLabel: string; amountCents: number; dueDate: string; status: string }
interface YearEndForm { formType: string; employeeName: string; year: number; boxes: Record<string, number>; employeeId?: string }

const JURIS = [{ v: 'us', l: '🇺🇸 US' }, { v: 'ca', l: '🇨🇦 CA' }, { v: 'uk', l: '🇬🇧 UK' }, { v: 'au', l: '🇦🇺 AU' }];
const FREQ = ['weekly', 'biweekly', 'semimonthly', 'monthly'];
const FORM_LABEL: Record<string, string> = { '941': 'Form 941', '940': 'Form 940', t4: 'T4 remittance', paye: 'PAYE/NI', bas: 'BAS (PAYG)', sg: 'Superannuation Guarantee' };

type Tab = 'employees' | 'runs' | 'deposits' | 'yearend';

export default function PayrollPage() {
  const [tab, setTab] = useState<Tab>('employees');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [runs, setRuns] = useState<PayRun[]>([]);
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [forms, setForms] = useState<YearEndForm[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [salary, setSalary] = useState('');
  const [freq, setFreq] = useState('biweekly');
  const [juris, setJuris] = useState('us');
  const [region, setRegion] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [locale, setLocale] = useState('en-US');
  const year = new Date().getFullYear();

  const fmt$ = useCallback((c: number) => formatCurrencyCents(c, currency, locale), [currency, locale]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [e, r, d, y, cfg] = await Promise.all([
        fetch(`${API}/employees`).then((x) => x.json()),
        fetch(`${API}/pay-runs`).then((x) => x.json()),
        fetch(`${API}/tax-deposits`).then((x) => x.json()),
        fetch(`${API}/year-end?year=${year}`).then((x) => x.json()),
        fetch('/api/v1/agentbook-core/tenant-config').then((x) => x.json()),
      ]);
      if (e?.success) setEmployees(e.data);
      if (r?.success) setRuns(r.data);
      if (d?.success) setDeposits(d.data);
      if (y?.success) setForms(y.data.forms);
      if (cfg?.success) {
        setCurrency(cfg.data?.currency || 'USD');
        setLocale(cfg.data?.locale || 'en-US');
      }
    } finally { setLoading(false); }
  }, [year]);
  useEffect(() => { void load(); }, [load]);

  const addEmployee = async () => {
    setBusy(true);
    try {
      await fetch(`${API}/employees`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), payRateCents: Math.round(Number(salary) * 100), payFrequency: freq, jurisdiction: juris, region: region.trim() }),
      });
      setName(''); setSalary(''); setRegion(''); setShowForm(false);
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
      if (create?.success) await fetch(`${API}/pay-runs/${create.data.id}/process`, { method: 'POST' });
      await load();
    } finally { setBusy(false); }
  };

  const markDepositPaid = async (id: string) => {
    await fetch(`${API}/tax-deposits`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
    await load();
  };

  if (loading) return <div className="flex justify-center py-24"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;

  const TABS: { id: Tab; label: string; icon: React.ReactNode; count?: number }[] = [
    { id: 'employees', label: 'Employees', icon: <Users className="w-4 h-4" />, count: employees.length },
    { id: 'runs', label: 'Pay runs', icon: <Play className="w-4 h-4" />, count: runs.length },
    { id: 'deposits', label: 'Tax deposits', icon: <Landmark className="w-4 h-4" />, count: deposits.filter((d) => d.status === 'pending').length },
    { id: 'yearend', label: 'Year-end', icon: <FileText className="w-4 h-4" /> },
  ];

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-6">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-bold text-foreground flex items-center gap-2"><Users className="w-5 h-5" /> Payroll</h1>
        <div className="flex gap-2">
          <button onClick={() => { setTab('employees'); setShowForm((s) => !s); }} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border border-border hover:bg-muted">
            <Plus className="w-4 h-4" /> Employee
          </button>
          <button onClick={() => void runPayroll()} disabled={busy || employees.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
            <Play className="w-4 h-4" /> Run payroll
          </button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground mb-5">Pay employees and contractors with automatic withholding, deposits, and year-end forms.</p>

      {employees.some((e) => e.jurisdiction === 'au') && (
        <div className="mb-5 flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <p>
            AU payroll here calculates PAYG withholding and Superannuation Guarantee for your own records, but does{' '}
            <strong>not</strong> lodge Single Touch Payroll (STP) reports to the ATO in real time. You&apos;ll still need
            STP-enabled software (or your BAS/tax agent) to report each pay run to the ATO as required by law.
          </p>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-border mb-5 overflow-x-auto">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${
              tab === t.id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {t.icon}{t.label}
            {t.count !== undefined && t.count > 0 && (
              <span className={`ml-0.5 text-xs px-1.5 rounded-full ${tab === t.id ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* Employees */}
      {tab === 'employees' && (
        <>
          {showForm && (
            <div className="rounded-xl border border-border bg-card p-4 mb-4 grid grid-cols-1 sm:grid-cols-6 gap-3 items-end">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
              <input type="number" value={salary} onChange={(e) => setSalary(e.target.value)} placeholder="Annual salary" className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
              <select value={freq} onChange={(e) => setFreq(e.target.value)} className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground capitalize">
                {FREQ.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
              <select value={juris} onChange={(e) => setJuris(e.target.value)} className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground">
                {JURIS.map((j) => <option key={j.v} value={j.v}>{j.l}</option>)}
              </select>
              {(juris === 'us' || juris === 'ca') && (
                <input value={region} onChange={(e) => setRegion(e.target.value.toUpperCase())} placeholder={juris === 'ca' ? 'Province (e.g. QC)' : 'State (e.g. CA)'}
                  maxLength={2} className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
              )}
              <button onClick={() => void addEmployee()} disabled={busy || !name || !salary} className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">Save</button>
            </div>
          )}
          {employees.length === 0 ? (
            <Empty icon={<Users className="w-6 h-6" />} title="No employees yet" hint="Add your first employee to run payroll." />
          ) : (
            <div className="rounded-xl border border-border bg-card divide-y divide-border">
              {employees.map((e) => (
                <div key={e.id} className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-medium">{e.name.slice(0, 2).toUpperCase()}</div>
                    <div><p className="text-sm font-medium text-foreground">{e.name}</p>
                      <p className="text-xs text-muted-foreground capitalize">{e.payFrequency} · {e.jurisdiction.toUpperCase()}{(e.jurisdiction === 'us' || e.jurisdiction === 'ca') && e.region ? ` · ${e.region}` : ''}</p></div>
                  </div>
                  <p className="text-sm font-medium text-foreground">{fmt$(e.payRateCents)}<span className="text-muted-foreground font-normal">/yr</span></p>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Pay runs */}
      {tab === 'runs' && (
        runs.length === 0 ? <Empty icon={<Play className="w-6 h-6" />} title="No pay runs yet" hint="Click “Run payroll” to pay your team for the current period." /> : (
          <div className="space-y-3">
            {runs.map((r) => {
              const gross = r.stubs.reduce((s, st) => s + st.grossCents, 0);
              const net = r.stubs.reduce((s, st) => s + st.netCents, 0);
              const tax = gross - net;
              const sg = r.stubs.reduce((s, st) => s + (st.sgCents || 0), 0);
              return (
                <div key={r.id} className="rounded-xl border border-border bg-card p-4">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-sm font-medium text-foreground">{new Date(r.periodStart).toLocaleDateString()} – {new Date(r.periodEnd).toLocaleDateString()}</p>
                    <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-primary/10 text-primary capitalize">
                      {r.status === 'paid' && <Check className="w-3.5 h-3.5" />}{r.status}</span>
                  </div>
                  <div className={`grid gap-3 mb-3 ${sg > 0 ? 'grid-cols-4' : 'grid-cols-3'}`}>
                    <Mini label="Gross" value={fmt$(gross)} />
                    <Mini label="Withheld" value={fmt$(tax)} />
                    <Mini label="Net pay" value={fmt$(net)} accent />
                    {sg > 0 && <Mini label="Super (employer)" value={fmt$(sg)} />}
                  </div>
                  <div className="divide-y divide-border border-t border-border">
                    {r.stubs.map((st) => (
                      <div key={st.id} className="flex items-center justify-between py-1.5 text-xs">
                        <span className="text-foreground">{st.employeeName}</span>
                        <span className="text-muted-foreground">
                          gross {fmt$(st.grossCents)} · tax {fmt$(st.federalTaxCents + st.stateTaxCents + st.ficaCents)}
                          {st.sgCents > 0 && <> · super {fmt$(st.sgCents)}</>} · net <span className="text-foreground font-medium">{fmt$(st.netCents)}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

      {/* Tax deposits */}
      {tab === 'deposits' && (
        deposits.length === 0 ? <Empty icon={<Landmark className="w-6 h-6" />} title="No tax deposits yet" hint="Processed pay runs accrue payroll-tax remittance obligations here." /> : (
          <div className="rounded-xl border border-border bg-card divide-y divide-border">
            {deposits.map((d) => {
              const overdue = d.status === 'pending' && new Date(d.dueDate) < new Date();
              return (
                <div key={d.id} className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-3">
                    <CalendarClock className={`w-4 h-4 ${overdue ? 'text-destructive' : 'text-muted-foreground'}`} />
                    <div>
                      <p className="text-sm font-medium text-foreground">{FORM_LABEL[d.form] || d.form} · {d.periodLabel}</p>
                      <p className={`text-xs ${overdue ? 'text-destructive' : 'text-muted-foreground'}`}>Due {new Date(d.dueDate).toLocaleDateString()}{overdue ? ' · overdue' : ''}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-foreground">{fmt$(d.amountCents)}</span>
                    <a href={`${API}/tax-deposits/${d.id}/pdf`} target="_blank" rel="noreferrer" className="text-xs px-2.5 py-1 rounded-md border border-border hover:bg-muted inline-flex items-center gap-1">
                      <Download className="w-3.5 h-3.5" />PDF
                    </a>
                    {d.status === 'paid'
                      ? <span className="text-xs text-primary inline-flex items-center gap-1"><Check className="w-3.5 h-3.5" />paid</span>
                      : <button onClick={() => void markDepositPaid(d.id)} className="text-xs px-2.5 py-1 rounded-md border border-border hover:bg-muted">Mark paid</button>}
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

      {/* Year-end */}
      {tab === 'yearend' && (
        <>
          <p className="text-sm text-muted-foreground mb-3">{year} forms, generated from processed pay runs.</p>
          {forms.length === 0 ? <Empty icon={<FileText className="w-6 h-6" />} title="No forms yet" hint={`Process payroll in ${year} to generate W-2 / T4 forms.`} /> : (
            <div className="rounded-xl border border-border bg-card divide-y divide-border">
              {forms.map((f, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">{f.employeeName}</p>
                    <p className="text-xs text-muted-foreground">
                      {f.formType} · gross {fmt$(f.boxes.grossWagesCents || 0)} · tax {fmt$((f.boxes.incomeTaxWithheldCents || 0) + (f.boxes.ficaWithheldCents || 0))}
                      {!!f.boxes.superannuationPaidCents && <> · super {fmt$(f.boxes.superannuationPaidCents)}</>}
                    </p>
                  </div>
                  {f.employeeId ? (
                    <a href={`${API}/year-end/pdf?year=${year}&employeeId=${f.employeeId}`} target="_blank" rel="noreferrer" className="text-xs px-2.5 py-1 rounded-md border border-border hover:bg-muted inline-flex items-center gap-1">
                      <Download className="w-3.5 h-3.5" />{f.formType}
                    </a>
                  ) : (
                    // Defensive fallback — the year-end API always includes employeeId today,
                    // but if an older cached response lacks it, degrade to the JSON list
                    // rather than link to a PDF route that would 400.
                    <a href={`${API}/year-end?year=${year}`} target="_blank" rel="noreferrer" className="text-xs px-2.5 py-1 rounded-md border border-border hover:bg-muted inline-flex items-center gap-1">
                      <Download className="w-3.5 h-3.5" />{f.formType}
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Mini({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-lg bg-background border border-border p-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-sm font-bold ${accent ? 'text-primary' : 'text-foreground'}`}>{value}</p>
    </div>
  );
}

function Empty({ icon, title, hint }: { icon: React.ReactNode; title: string; hint: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card py-12 text-center">
      <div className="w-12 h-12 rounded-full bg-muted text-muted-foreground flex items-center justify-center mx-auto mb-3">{icon}</div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground mt-1">{hint}</p>
    </div>
  );
}
