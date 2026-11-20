'use client';

/**
 * Employee detail / edit (PR 4c, spec §5.5): Personal, Pay, Tax, Banking and
 * Super (AU) / Benefits (CA) sections, by market.
 *
 * Privacy rules this screen keeps:
 * - Sensitive inputs (tax id, bank account, super member number) start EMPTY;
 *   the masked last4 is only a placeholder. A blank field or a masked echo is
 *   never sent, so a stored value can't be overwritten by its own mask.
 * - A 503 pii_key_unconfigured disables the encrypted inputs, shows why, and
 *   re-sends the save without them so non-sensitive edits still land.
 * - Reveal happens only on an explicit click, lives in component state only
 *   (never storage), and re-masks on Hide or after 30 seconds.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, AlertTriangle, Eye, EyeOff } from 'lucide-react';
import { useT } from '@/hooks/use-t';
import { frequencyLabelKey, PAY_FREQUENCIES } from '@/lib/payroll-frequency';
import { isMaskedEcho } from '@/lib/agentbook-employee-profile';

const API = '/api/v1/agentbook-payroll/employees';
const ENCRYPTED = ['taxId', 'bankAccount', 'superMemberNumber'] as const;
type EncField = typeof ENCRYPTED[number];
const REMASK_MS = 30_000;

interface Masked {
  hasTaxId: boolean; taxIdLast4: string | null; hasBankAccount: boolean; bankLast4: string | null;
  bankRoutingLabel: string | null; superFundUsi: string | null; superFundName: string | null; hasSuperMemberNumber: boolean;
}
type Emp = Record<string, unknown> & { id: string; jurisdiction: string; sensitive: Masked };

type Kind = 'text' | 'date' | 'money' | 'int' | 'bool' | 'enum';
interface FieldDef { key: string; label: string; kind: Kind; options?: Array<[string, string]>; nullable?: boolean }

const isoDay = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 10) : '');

function toForm(f: FieldDef, v: unknown): string | boolean {
  if (f.kind === 'bool') return Boolean(v);
  if (v === null || v === undefined) return '';
  if (f.kind === 'date') return isoDay(v);
  if (f.kind === 'money') return (Number(v) / 100).toString();
  return String(v);
}

function fromForm(f: FieldDef, v: string | boolean): unknown {
  if (f.kind === 'bool') return Boolean(v);
  const s = String(v).trim();
  if (s === '') return f.nullable === false ? '' : null;
  if (f.kind === 'money') return Math.round(Number(s) * 100);
  if (f.kind === 'int') return Math.round(Number(s));
  return s;
}

export default function EmployeeDetail({ id }: { id: string }) {
  const t = useT();
  const [emp, setEmp] = useState<Emp | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [form, setForm] = useState<Record<string, string | boolean>>({});
  const [initial, setInitial] = useState<Record<string, string | boolean>>({});
  const [secret, setSecret] = useState<Record<EncField, string>>({ taxId: '', bankAccount: '', superMemberNumber: '' });
  const [piiUnavailable, setPiiUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [revealed, setRevealed] = useState<{ field: EncField; value: string } | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const j = emp?.jurisdiction ?? 'us';
  const yesNoEnum = (pairs: Array<[string, string]>) => pairs.map(([v, k]) => [v, t(k)] as [string, string]);

  const sections: Array<{ title: string; fields: FieldDef[] }> = [
    { title: t('core_ui.personal'), fields: [
      { key: 'name', label: t('common.name'), kind: 'text', nullable: false },
      { key: 'email', label: t('core_ui.email_address'), kind: 'text' },
      { key: 'phone', label: t('core_ui.phone'), kind: 'text' },
      { key: 'address', label: t('core_ui.address'), kind: 'text' },
      { key: 'dateOfBirth', label: t('core_ui.date_of_birth'), kind: 'date' },
      { key: 'employmentBasis', label: t('core_ui.employment_basis'), kind: 'enum',
        options: yesNoEnum([['full_time', 'core_ui.full_time'], ['part_time', 'core_ui.part_time'], ['casual', 'core_ui.casual']]) },
      { key: 'endDate', label: t('core_ui.end_date'), kind: 'date' },
    ] },
    { title: t('core_ui.pay_details'), fields: [
      { key: 'payType', label: t('core_ui.pay_type'), kind: 'enum', nullable: false, options: yesNoEnum([['salary', 'core_ui.salary'], ['hourly', 'core_ui.hourly']]) },
      { key: 'payRateCents', label: t('core_ui.pay_rate'), kind: 'money', nullable: false },
      { key: 'payFrequency', label: t('core_ui.pay_frequency'), kind: 'enum', nullable: false,
        options: PAY_FREQUENCIES.map((f) => [f, t(frequencyLabelKey(f, j))] as [string, string]) },
      { key: 'payAnchorDate', label: t('core_ui.first_day_of_a_pay_period'), kind: 'date' },
      ...(j === 'us' || j === 'ca' ? [{ key: 'region', label: t('core_ui.state_or_province'), kind: 'text' as Kind, nullable: false }] : []),
    ] },
    { title: t('core_ui.tax_details'), fields:
      j === 'au' ? [
        { key: 'taxFreeThreshold', label: t('core_ui.tax_free_threshold_claimed'), kind: 'bool' },
        { key: 'residency', label: t('core_ui.residency_for_tax'), kind: 'enum',
          options: yesNoEnum([['resident', 'core_ui.australian_resident'], ['foreign', 'core_ui.foreign_resident'], ['working_holiday', 'core_ui.working_holiday_maker']]) },
        { key: 'helpDebt', label: t('core_ui.help_or_study_loan_debt'), kind: 'bool' },
      ] : j === 'ca' ? [
        { key: 'td1Federal', label: t('core_ui.td1_federal_claim_amount'), kind: 'money' },
        { key: 'td1Provincial', label: t('core_ui.td1_provincial_claim_amount'), kind: 'money' },
      ] : j === 'us' ? [
        { key: 'filingStatus', label: t('core_ui.w4_filing_status'), kind: 'enum', nullable: false, options: yesNoEnum([['single', 'core_ui.single'], ['married', 'core_ui.married']]) },
        { key: 'allowances', label: t('core_ui.w4_allowances'), kind: 'int', nullable: false },
        { key: 'extraWithholdingCents', label: t('core_ui.extra_withholding_per_pay_period'), kind: 'money' },
      ] : [] },
    { title: t('core_ui.banking'), fields: [
      { key: 'bankRoutingLabel', label: t(({ au: 'core_ui.bsb', ca: 'core_ui.transit_and_institution_number', us: 'core_ui.aba_routing_number', uk: 'core_ui.sort_code' } as Record<string, string>)[j] ?? 'core_ui.aba_routing_number'), kind: 'text' },
    ] },
    ...(j === 'au' ? [{ title: t('core_ui.superannuation'), fields: [
      { key: 'superFundName', label: t('core_ui.super_fund_name'), kind: 'text' as Kind },
      { key: 'superFundUsi', label: t('core_ui.fund_usi'), kind: 'text' as Kind },
    ] }] : j === 'ca' ? [{ title: t('core_ui.benefits'), fields: [
      { key: 'cppExempt', label: t('core_ui.cpp_or_qpp_exempt'), kind: 'bool' as Kind },
      { key: 'eiExempt', label: t('core_ui.ei_exempt'), kind: 'bool' as Kind },
    ] }] : []),
  ];
  const allFields = sections.flatMap((s) => s.fields);
  const SENSITIVE_PLAIN = new Set(['bankRoutingLabel', 'superFundName', 'superFundUsi']);

  const hydrate = useCallback((e: Emp, fields: FieldDef[]) => {
    const f: Record<string, string | boolean> = {};
    for (const d of fields) f[d.key] = toForm(d, SENSITIVE_PLAIN.has(d.key) ? (e.sensitive as unknown as Record<string, unknown>)[d.key] : e[d.key]);
    setForm(f); setInitial(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      const res = await fetch(`${API}/${id}`);
      const body = await res.json().catch(() => null);
      if (!live) return;
      if (!res.ok || !body?.success) { setNotFound(true); return; }
      setEmp(body.data as Emp);
    })();
    return () => { live = false; };
  }, [id]);

  // Hydrate once the jurisdiction (and so the field list) is known.
  const hydratedFor = useRef<string | null>(null);
  useEffect(() => {
    if (emp && hydratedFor.current !== emp.id + emp.jurisdiction) { hydratedFor.current = emp.id + emp.jurisdiction; hydrate(emp, allFields); }
  });

  // Unmount: cancel the pending re-mask timer (the revealed value dies with the component state).
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } }, []);

  const lastFor = (f: EncField): string | null =>
    f === 'taxId' ? emp?.sensitive.taxIdLast4 ?? null : f === 'bankAccount' ? emp?.sensitive.bankLast4 ?? null : null;
  const hasFor = (f: EncField) =>
    f === 'taxId' ? emp?.sensitive.hasTaxId : f === 'bankAccount' ? emp?.sensitive.hasBankAccount : emp?.sensitive.hasSuperMemberNumber;

  const buildBody = (withEncrypted: boolean) => {
    const body: Record<string, unknown> = {};
    for (const d of allFields) {
      if (form[d.key] === initial[d.key]) continue;
      body[d.key] = fromForm(d, form[d.key]);
    }
    if (withEncrypted) {
      for (const f of ENCRYPTED) {
        const v = secret[f].trim();
        if (v && !isMaskedEcho(v, lastFor(f))) body[f] = v;
      }
    }
    return body;
  };

  const put = async (body: Record<string, unknown>) => {
    const res = await fetch(`${API}/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { res, json: await res.json().catch(() => null) };
  };

  const save = async () => {
    setBusy(true); setStatus(null);
    try {
      let body = buildBody(!piiUnavailable);
      if (Object.keys(body).length === 0) { setStatus({ ok: true, text: t('core_ui.profile_saved') }); return; }
      let { res, json } = await put(body);
      if (res.status === 503 && json?.code === 'pii_key_unconfigured') {
        setPiiUnavailable(true);
        setSecret({ taxId: '', bankAccount: '', superMemberNumber: '' });
        body = buildBody(false);
        if (Object.keys(body).length === 0) return;
        ({ res, json } = await put(body));
      }
      if (!res.ok || !json?.success) { setStatus({ ok: false, text: t('core_ui.couldnt_save_the_profile', { error: String(json?.error ?? res.status) }) }); return; }
      setEmp(json.data as Emp);
      hydratedFor.current = null;
      setSecret({ taxId: '', bankAccount: '', superMemberNumber: '' });
      setStatus({ ok: true, text: t('core_ui.profile_saved') });
    } finally { setBusy(false); }
  };

  const reveal = async (field: EncField) => {
    setRevealError(null);
    const res = await fetch(`${API}/${id}/reveal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ field }) });
    const json = await res.json().catch(() => null);
    if (res.status === 503 && json?.code === 'pii_key_unconfigured') { setPiiUnavailable(true); return; }
    if (res.status === 403) { setRevealError(t('core_ui.only_the_account_owner_can_reveal_this')); return; }
    if (!res.ok || !json?.success) { setRevealError(t('core_ui.couldnt_reveal_this_value')); return; }
    setRevealed({ field, value: String(json.data.value) });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setRevealed(null), REMASK_MS);
  };
  const hide = () => { if (timer.current) clearTimeout(timer.current); setRevealed(null); };

  if (notFound) {
    return (
      <div className="max-w-3xl mx-auto p-4 sm:p-6">
        <BackLink label={t('core_ui.back_to_payroll')} />
        <p className="text-sm text-muted-foreground">{t('core_ui.employee_not_found')}</p>
      </div>
    );
  }
  if (!emp || Object.keys(form).length === 0) return <div className="flex justify-center py-24"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;

  const encLabel: Record<EncField, string> = {
    taxId: t(j === 'au' ? 'core_ui.tax_file_number_tfn' : j === 'ca' ? 'core_ui.social_insurance_number_sin' : 'core_ui.social_security_number_ssn'),
    bankAccount: t('core_ui.bank_account_number'),
    superMemberNumber: t('core_ui.member_number'),
  };
  const encSection: Record<EncField, string> = { taxId: t('core_ui.tax_details'), bankAccount: t('core_ui.banking'), superMemberNumber: t('core_ui.superannuation') };
  const encFields: EncField[] = j === 'au' ? ['taxId', 'bankAccount', 'superMemberNumber'] : j === 'ca' || j === 'us' ? ['taxId', 'bankAccount'] : ['bankAccount'];

  const renderEnc = (f: EncField) => {
    const last = lastFor(f);
    const has = hasFor(f);
    const inputId = `emp-${f}`;
    return (
      <div key={f} className="flex flex-col gap-1">
        <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">{encLabel[f]}</label>
        <input id={inputId} value={secret[f]} disabled={piiUnavailable} autoComplete="off" spellCheck={false}
          placeholder={last ? `•••• ${last}` : t('core_ui.type_a_new_value_to_replace_it')}
          onChange={(e) => setSecret((s) => ({ ...s, [f]: e.target.value }))}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground disabled:opacity-50" />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{has ? (last ? t('core_ui.on_file_ending', { last4: last }) : t('core_ui.on_file')) : t('core_ui.not_on_file')}</span>
          {has && !piiUnavailable && (revealed?.field === f ? (
            <>
              <code className="px-1.5 py-0.5 rounded bg-muted text-foreground">{revealed.value}</code>
              <button type="button" onClick={hide} className="inline-flex items-center gap-1 text-primary"><EyeOff className="w-3.5 h-3.5" />{t('core_ui.hide')}</button>
            </>
          ) : (
            <button type="button" onClick={() => void reveal(f)} className="inline-flex items-center gap-1 text-primary"><Eye className="w-3.5 h-3.5" />{t('core_ui.reveal')}</button>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-6">
      <BackLink label={t('core_ui.back_to_payroll')} />
      <h1 className="text-xl font-bold text-foreground mb-1">{t('core_ui.employee_profile')}</h1>
      <p className="text-sm text-muted-foreground mb-5">{String(emp.name)} · {j.toUpperCase()}</p>

      {piiUnavailable && (
        <div role="status" className="mb-5 flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /><p>{t('core_ui.sensitive_fields_unavailable')}</p>
        </div>
      )}
      {revealError && <p role="alert" className="mb-4 text-sm text-destructive">{revealError}</p>}

      <div className="space-y-4">
        {sections.map((s) => {
          const enc = encFields.filter((f) => encSection[f] === s.title);
          if (s.fields.length === 0 && enc.length === 0) return null;
          return (
            <section key={s.title} className="rounded-xl border border-border bg-card p-4">
              <h2 className="text-sm font-semibold text-foreground mb-3">{s.title}</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {s.fields.map((d) => <FieldInput key={d.key} def={d} value={form[d.key]} onChange={(v) => setForm((f) => ({ ...f, [d.key]: v }))} />)}
                {enc.map(renderEnc)}
              </div>
            </section>
          );
        })}
      </div>

      <div className="mt-5 flex items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={busy}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">{t('common.save')}</button>
        {status && <span role="status" className={`text-sm ${status.ok ? 'text-primary' : 'text-destructive'}`}>{status.text}</span>}
      </div>
    </div>
  );
}

function BackLink({ label }: { label: string }) {
  return (
    <Link href="/payroll" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-3">
      <ArrowLeft className="w-4 h-4" />{label}
    </Link>
  );
}

function FieldInput({ def, value, onChange }: { def: FieldDef; value: string | boolean; onChange: (v: string | boolean) => void }) {
  const id = `emp-${def.key}`;
  const cls = 'rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground';
  if (def.kind === 'bool') {
    return (
      <label htmlFor={id} className="flex items-center gap-2 text-sm text-foreground self-end py-2">
        <input id={id} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />{def.label}
      </label>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">{def.label}</label>
      {def.kind === 'enum' ? (
        <select id={id} value={String(value)} onChange={(e) => onChange(e.target.value)} className={cls}>
          {def.nullable !== false && <option value="">—</option>}
          {def.options!.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      ) : (
        <input id={id} value={String(value)} onChange={(e) => onChange(e.target.value)} className={cls}
          type={def.kind === 'date' ? 'date' : def.kind === 'text' ? 'text' : 'number'}
          step={def.kind === 'money' ? '0.01' : undefined} inputMode={def.kind === 'money' ? 'decimal' : def.kind === 'int' ? 'numeric' : undefined} />
      )}
    </div>
  );
}
