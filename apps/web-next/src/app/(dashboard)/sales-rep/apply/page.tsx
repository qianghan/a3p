'use client';

/**
 * Partner Program application wizard — the Q&A-that-is-the-contract flow
 * from sales-rep.html §4. Reachable by any authenticated paid user (not
 * gated on the sales_rep role, since applicants by definition don't have
 * it yet) — separate from /sales-rep, which is the already-active rep's
 * dashboard. PR6 folds this into a single state-adaptive /sales-rep route;
 * until then this stands alone as its own page.
 */

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Loader2, CheckCircle2, Circle } from 'lucide-react';
import { Button, Textarea, Select, Label } from '@naap/ui';

type Eligibility = { eligible: true } | { eligible: false; reason: string };

interface Application {
  id: string;
  status: 'draft' | 'submitted' | 'under_review' | 'more_info_requested' | 'approved' | 'rejected';
  jurisdiction: string;
  answers: Record<string, unknown>;
  annualFeeCentsPaid: number;
  reviewDecision?: string | null;
  reviewNotes?: string | null;
  moreInfoMessage?: string | null;
  reviewedAt?: string | null;
}

interface LiabilitySection {
  key: string;
  title: string;
  body: string;
  acknowledged: boolean;
}

interface ContractPreview {
  sections: LiabilitySection[];
  allSectionsAcknowledged: boolean;
  taxpayerNoticeAcknowledged: boolean;
  readyToSign: boolean;
  contractPreviewHtml: string;
  taxFormType: string;
}

const JURISDICTIONS = [
  { value: 'us', label: 'United States' },
  { value: 'ca', label: 'Canada' },
  { value: 'uk', label: 'United Kingdom' },
  { value: 'au', label: 'Australia' },
];

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

async function getJson(url: string, init?: RequestInit) {
  const res = await fetch(url, { credentials: 'include', ...init });
  return res.json();
}

export default function PartnerApplicationPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);
  const [application, setApplication] = useState<Application | null>(null);
  const [step, setStep] = useState(1);

  const [motivation, setMotivation] = useState('');
  const [referralPlan, setReferralPlan] = useState('');
  const [jurisdiction, setJurisdiction] = useState('us');
  const [preview, setPreview] = useState<ContractPreview | null>(null);
  const [signedByName, setSignedByName] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [eligRes, appRes] = await Promise.all([
        getJson('/api/v1/agentbook-billing/sales-rep/application/eligibility'),
        getJson('/api/v1/agentbook-billing/sales-rep/application'),
      ]);
      if (eligRes.success) setEligibility(eligRes.data);
      const app: Application | null = appRes.success ? appRes.data.application : null;
      setApplication(app);
      if (app) {
        setMotivation((app.answers?.motivation as string) || '');
        setReferralPlan((app.answers?.referralPlan as string) || '');
        setJurisdiction(app.jurisdiction);
      }
      // Resume at the furthest step the applicant already reached, rather
      // than always dropping a returning draft back at step 1 — "save and
      // come back" (sales-rep.html §4) should resume progress, not just
      // preserve the field values.
      if (app?.status === 'draft') {
        const previewRes = await getJson(
          `/api/v1/agentbook-billing/sales-rep/application/${app.id}/contract-preview`,
        );
        if (previewRes.success) {
          setPreview(previewRes.data);
          const hasAnyAcknowledgment =
            previewRes.data.taxpayerNoticeAcknowledged ||
            previewRes.data.sections.some((s: LiabilitySection) => s.acknowledged);
          if (previewRes.data.readyToSign) setStep(5);
          else if (hasAnyAcknowledgment) setStep(3);
        }
      }
    } catch {
      setError('Failed to load the Partner Program application.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadPreview = useCallback(async (applicationId: string) => {
    const res = await getJson(`/api/v1/agentbook-billing/sales-rep/application/${applicationId}/contract-preview`);
    if (res.success) setPreview(res.data);
  }, []);

  useEffect(() => {
    if (application?.status === 'draft' && step >= 3 && !preview) {
      loadPreview(application.id);
    }
  }, [application, step, preview, loadPreview]);

  const startApplication = async () => {
    setBusy(true);
    setError(null);
    const res = await getJson('/api/v1/agentbook-billing/sales-rep/application', { method: 'POST' });
    if (res.success) {
      setApplication(res.data.application);
      setJurisdiction(res.data.application.jurisdiction);
      setStep(1);
      // Clear out any preview left over from a prior application (e.g.
      // "Apply again" after a rejection) — otherwise step 3 would briefly
      // render stale acknowledgment state from the superseded application.
      setPreview(null);
    } else {
      setError(res.error || 'Failed to start your application.');
    }
    setBusy(false);
  };

  const saveDraft = async (updates: { answers?: Record<string, unknown>; jurisdiction?: string }) => {
    if (!application) return;
    setBusy(true);
    setError(null);
    const res = await getJson(`/api/v1/agentbook-billing/sales-rep/application/${application.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (res.success) setApplication(res.data.application);
    else setError(res.error || 'Failed to save your progress.');
    setBusy(false);
    return res.success;
  };

  const toggleAck = async (input: { sectionKey?: string; taxpayerNotice?: boolean }, acknowledged: boolean) => {
    if (!application) return;
    setBusy(true);
    setError(null);
    const res = await getJson(`/api/v1/agentbook-billing/sales-rep/application/${application.id}/acknowledge`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, acknowledged }),
    });
    if (res.success) {
      setApplication(res.data.application);
      await loadPreview(application.id);
    } else {
      setError(res.error || 'Failed to save your acknowledgment.');
    }
    setBusy(false);
  };

  const submit = async () => {
    if (!application) return;
    setBusy(true);
    setError(null);
    const res = await getJson(`/api/v1/agentbook-billing/sales-rep/application/${application.id}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedByName }),
    });
    if (res.success) {
      setApplication(res.data.application);
    } else {
      setError(res.error || 'Failed to submit your application.');
    }
    setBusy(false);
  };

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  // No application yet — either the intro/eligibility screen or a start button.
  if (!application) {
    return (
      <div className="p-6 max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-xl font-semibold">Become an AgentBook Partner</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Earn real commission recommending AgentBook to other freelancers and small businesses — a serious,
            contract-backed program, not a "refer a friend" gimmick.
          </p>
        </div>
        {error && <div className="rounded-md bg-destructive/10 text-destructive text-sm px-3 py-2">{error}</div>}
        {eligibility && !eligibility.eligible && (
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-sm font-medium mb-1">You&apos;re not eligible to apply yet</p>
            <p className="text-sm text-muted-foreground">{eligibility.reason}</p>
          </div>
        )}
        {eligibility && eligibility.eligible && (
          <div className="rounded-lg border border-border bg-card p-4 space-y-3">
            <p className="text-sm text-muted-foreground">
              You&apos;re on a qualifying annual paid plan — you can apply now. The application is a short,
              5-step Q&amp;A that doubles as your Partner Agreement: fit questions, jurisdiction confirmation,
              reading and acknowledging your benefits and obligations, a taxpayer-information notice, and a final
              e-signed review. You can save and come back any time before you sign.
            </p>
            <Button onClick={startApplication} disabled={busy}>
              {busy && <Loader2 className="w-4 h-4 animate-spin mr-1.5" />}
              Start application
            </Button>
          </div>
        )}
      </div>
    );
  }

  // Non-draft states: status views.
  if (application.status === 'approved') {
    return (
      <div className="p-6 max-w-2xl mx-auto space-y-4">
        <h1 className="text-xl font-semibold">You&apos;re an approved Partner</h1>
        <p className="text-sm text-muted-foreground">Head to your Partner dashboard to get your referral link.</p>
        <Link href="/sales-rep"><Button>Go to your dashboard</Button></Link>
      </div>
    );
  }
  if (application.status === 'submitted' || application.status === 'under_review') {
    return (
      <div className="p-6 max-w-2xl mx-auto space-y-4">
        <h1 className="text-xl font-semibold">Application under review</h1>
        <p className="text-sm text-muted-foreground">
          Thanks for applying. We&apos;ll email you once a decision is made — no action needed from you right now.
        </p>
      </div>
    );
  }
  if (application.status === 'more_info_requested') {
    return (
      <div className="p-6 max-w-2xl mx-auto space-y-4">
        <h1 className="text-xl font-semibold">We need a bit more information</h1>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm">{application.moreInfoMessage || 'An admin has requested more information about your application.'}</p>
        </div>
        <p className="text-sm text-muted-foreground">Please contact support to continue your application.</p>
      </div>
    );
  }
  if (application.status === 'rejected') {
    return (
      <div className="p-6 max-w-2xl mx-auto space-y-4">
        <h1 className="text-xl font-semibold">Application not approved</h1>
        {application.reviewNotes && (
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-sm">{application.reviewNotes}</p>
          </div>
        )}
        {error && <div className="rounded-md bg-destructive/10 text-destructive text-sm px-3 py-2">{error}</div>}
        <Button onClick={startApplication} disabled={busy}>
          {busy && <Loader2 className="w-4 h-4 animate-spin mr-1.5" />}
          Apply again
        </Button>
      </div>
    );
  }

  // Draft — the 5-step wizard.
  const steps = ['Fit', 'Jurisdiction', 'Benefits & liabilities', 'Taxpayer notice', 'Review & sign'];

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Partner Program application</h1>
        <p className="text-sm text-muted-foreground mt-1">A draft — nothing is final until you sign in step 5.</p>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {steps.map((label, i) => {
          const n = i + 1;
          return (
            <div key={label} className={`flex items-center gap-1.5 text-xs ${n === step ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
              {n < step ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> : <Circle className="w-3.5 h-3.5" />}
              {label}
            </div>
          );
        })}
      </div>

      {error && <div className="rounded-md bg-destructive/10 text-destructive text-sm px-3 py-2">{error}</div>}

      {step === 1 && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-4">
          <div>
            <Label htmlFor="motivation">Why do you want to become a Partner?</Label>
            <Textarea id="motivation" value={motivation} onChange={(e) => setMotivation(e.target.value)} rows={3} />
          </div>
          <div>
            <Label htmlFor="referralPlan">How do you plan to refer people?</Label>
            <Textarea id="referralPlan" value={referralPlan} onChange={(e) => setReferralPlan(e.target.value)} rows={3} />
          </div>
          <div className="flex justify-end">
            <Button
              disabled={busy}
              onClick={async () => {
                const ok = await saveDraft({ answers: { motivation, referralPlan } });
                if (ok) setStep(2);
              }}
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin mr-1.5" />}
              Continue
            </Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-4">
          <div>
            <Label htmlFor="jurisdiction">Confirm your jurisdiction</Label>
            <p className="text-xs text-muted-foreground mb-2">
              This determines your contract terms, tax-form obligations, and disclosures in the next step.
            </p>
            <Select id="jurisdiction" value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)}>
              {JURISDICTIONS.map((j) => <option key={j.value} value={j.value}>{j.label}</option>)}
            </Select>
          </div>
          <div className="flex justify-between">
            <Button variant="secondary" onClick={() => setStep(1)}>Back</Button>
            <Button
              disabled={busy}
              onClick={async () => {
                const ok = await saveDraft({ jurisdiction });
                if (ok) setStep(3);
              }}
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin mr-1.5" />}
              Continue
            </Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-4">
          <p className="text-sm text-muted-foreground">Read and acknowledge each section — no single "agree to everything" checkbox.</p>
          {!preview ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : (
            <div className="space-y-3">
              {preview.sections.map((s) => (
                <label key={s.key} className="flex items-start gap-3 rounded-md border border-border p-3 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={s.acknowledged}
                    disabled={busy}
                    onChange={(e) => toggleAck({ sectionKey: s.key }, e.target.checked)}
                  />
                  <span>
                    <span className="block text-sm font-medium">{s.title}</span>
                    <span className="block text-sm text-muted-foreground mt-0.5">{s.body}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
          <div className="flex justify-between">
            <Button variant="secondary" onClick={() => setStep(2)}>Back</Button>
            <Button disabled={busy || !preview?.allSectionsAcknowledged} onClick={() => setStep(4)}>
              Continue
            </Button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-4">
          <p className="text-sm">
            We&apos;ll collect the required taxpayer form ({preview?.taxFormType || 'per your jurisdiction'}) during
            Stripe Connect payout setup, after approval — not here, so we don&apos;t collect sensitive tax IDs from
            applicants who might not be approved.
          </p>
          <label className="flex items-start gap-3 rounded-md border border-border p-3 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={preview?.taxpayerNoticeAcknowledged ?? false}
              disabled={busy}
              onChange={(e) => toggleAck({ taxpayerNotice: true }, e.target.checked)}
            />
            <span className="text-sm">I understand and acknowledge this.</span>
          </label>
          <div className="flex justify-between">
            <Button variant="secondary" onClick={() => setStep(3)}>Back</Button>
            <Button disabled={busy || !preview?.taxpayerNoticeAcknowledged} onClick={() => setStep(5)}>
              Continue
            </Button>
          </div>
        </div>
      )}

      {step === 5 && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-4">
          <p className="text-sm text-muted-foreground">Read the full agreement, then type your full legal name to sign.</p>
          <pre className="whitespace-pre-wrap text-xs bg-muted rounded-md p-3 max-h-80 overflow-y-auto font-mono">
            {preview?.contractPreviewHtml}
          </pre>
          <div>
            <Label htmlFor="signedByName">Full legal name (must match the name on your account)</Label>
            <input
              id="signedByName"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={signedByName}
              onChange={(e) => setSignedByName(e.target.value)}
              disabled={busy}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            By typing your name and clicking sign, you agree this is your legally binding electronic signature.
          </p>
          <div className="flex justify-between">
            <Button variant="secondary" onClick={() => setStep(4)}>Back</Button>
            <Button disabled={busy || !preview?.readyToSign || !signedByName.trim()} onClick={submit}>
              {busy && <Loader2 className="w-4 h-4 animate-spin mr-1.5" />}
              Sign & submit application
            </Button>
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Applying for {money(application.annualFeeCentsPaid)}/year plan — your progress is saved automatically as you go.
      </p>
    </div>
  );
}
