'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Users, Plus, Copy, RefreshCw, ShieldCheck, Loader2, Mail, FileQuestion, Check } from 'lucide-react';

const CPA = '/api/v1/agentbook-cpa';
const CORE = '/api/v1/agentbook-core';

interface Link { id: string; token: string; label: string | null; expiresAt: string; status: string; _count?: { comments: number } }
interface Finding { severity: string; title: string; detail: string; actionItem: string; autoFixable: boolean }
interface Report { period: string; score: number; findings: Finding[] }
interface Invite { id: string; cpaEmail: string; cpaName: string | null; token: string; status: string }
interface DocRequest { id: string; description: string; status: string; requestedByEmail: string | null; fulfilledUrl: string | null }

const SEV: Record<string, string> = { critical: 'text-destructive', warning: 'text-yellow-600', info: 'text-primary', clean: 'text-green-600' };

export default function AccountantPage() {
  const [links, setLinks] = useState<Link[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [autoFix, setAutoFix] = useState(true);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [origin, setOrigin] = useState('');
  const [invites, setInvites] = useState<Invite[]>([]);
  const [docRequests, setDocRequests] = useState<DocRequest[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [linkRes, repRes, cfgRes, invRes, docRes] = await Promise.all([
        fetch(`${CPA}/link`).then((r) => r.json()),
        fetch(`${CPA}/review`).then((r) => r.json()),
        fetch(`${CORE}/tenant-config`).then((r) => r.json()),
        fetch(`${CPA}/invite`).then((r) => r.json()),
        fetch(`${CPA}/document-requests`).then((r) => r.json()),
      ]);
      if (linkRes?.success) setLinks(linkRes.data);
      if (repRes?.success && repRes.data.length) setReport(repRes.data[0]);
      if (cfgRes?.success) setAutoFix(cfgRes.data.aiCpaAutoFix ?? true);
      if (invRes?.success) setInvites(invRes.data);
      if (docRes?.success) setDocRequests(docRes.data);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { setOrigin(window.location.origin); void load(); }, [load]);

  const createLink = async () => {
    await fetch(`${CPA}/link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    await load();
  };
  const inviteCpa = async () => {
    if (!inviteEmail.trim()) return;
    await fetch(`${CPA}/invite`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cpaEmail: inviteEmail.trim() }) });
    setInviteEmail('');
    await load();
  };
  const fulfillDoc = async (id: string) => {
    const url = window.prompt('Paste the document URL to fulfill this request:');
    if (!url) return;
    await fetch(`${CPA}/document-requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, url }) });
    await load();
  };
  const runReview = async () => {
    setRunning(true);
    try {
      const r = await fetch(`${CPA}/review`, { method: 'POST' }).then((x) => x.json());
      if (r?.success) setReport(r.data);
    } finally { setRunning(false); }
  };
  const toggleAutoFix = async (val: boolean) => {
    setAutoFix(val);
    await fetch(`${CORE}/tenant-config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ aiCpaAutoFix: val }) });
  };

  if (loading) return <div className="flex justify-center py-24"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-6">
      <div className="mb-5">
        <h1 className="text-xl font-bold text-foreground flex items-center gap-2"><Users className="w-5 h-5" /> Account Access</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Share read-only books with your CPA and get an AI review.</p>
      </div>

      {/* Share links */}
      <div className="rounded-xl border border-border bg-card p-4 mb-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-foreground">Share with your accountant</h2>
          <button onClick={() => void createLink()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:opacity-90">
            <Plus className="w-4 h-4" /> New link
          </button>
        </div>
        {links.filter((l) => l.status === 'active').length === 0 ? (
          <p className="text-sm text-muted-foreground">No active links. Create one to give your CPA read-only access.</p>
        ) : (
          <div className="space-y-2">
            {links.filter((l) => l.status === 'active').map((l) => (
              <div key={l.id} className="flex items-center justify-between gap-2 text-sm">
                <code className="text-xs bg-muted px-2 py-1 rounded truncate flex-1">{origin}/review/{l.token}</code>
                <button onClick={() => navigator.clipboard?.writeText(`${origin}/review/${l.token}`)} className="text-primary hover:underline flex items-center gap-1 text-xs">
                  <Copy className="w-3.5 h-3.5" /> Copy
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Invite a named CPA */}
      <div className="rounded-xl border border-border bg-card p-4 mb-5">
        <h2 className="text-sm font-semibold text-foreground mb-1 flex items-center gap-1.5"><Mail className="w-4 h-4" /> Invite your accountant</h2>
        <p className="text-xs text-muted-foreground mb-3">They get a private portal to review your books and request documents.</p>
        <div className="flex gap-2 mb-3">
          <input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} type="email" placeholder="accountant@firm.com"
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
          <button onClick={() => void inviteCpa()} disabled={!inviteEmail.trim()}
            className="px-3 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">Invite</button>
        </div>
        {invites.filter((i) => i.status !== 'revoked').map((i) => (
          <div key={i.id} className="flex items-center justify-between gap-2 text-sm py-1">
            <span className="text-foreground">{i.cpaEmail} <span className="text-xs text-muted-foreground capitalize">· {i.status}</span></span>
            <button onClick={() => navigator.clipboard?.writeText(`${origin}/cpa-portal/${i.token}`)} className="text-primary hover:underline flex items-center gap-1 text-xs">
              <Copy className="w-3.5 h-3.5" /> Copy link
            </button>
          </div>
        ))}
      </div>

      {/* Document requests from the CPA */}
      {docRequests.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-4 mb-5">
          <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-1.5"><FileQuestion className="w-4 h-4" /> Document requests</h2>
          <div className="divide-y divide-border">
            {docRequests.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-3 py-2.5">
                <div>
                  <p className="text-sm text-foreground">{d.description}</p>
                  <p className="text-xs text-muted-foreground">{d.requestedByEmail || 'Your accountant'}</p>
                </div>
                {d.status === 'fulfilled'
                  ? <span className="text-xs text-primary inline-flex items-center gap-1 shrink-0"><Check className="w-3.5 h-3.5" />fulfilled</span>
                  : <button onClick={() => void fulfillDoc(d.id)} className="text-xs px-2.5 py-1 rounded-md border border-border hover:bg-muted shrink-0">Fulfill</button>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* AI review */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-foreground">AI CPA review</h2>
          <button onClick={() => void runReview()} disabled={running} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-border hover:bg-muted disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 ${running ? 'animate-spin' : ''}`} /> {running ? 'Reviewing…' : 'Run review'}
          </button>
        </div>

        <label className="flex items-center gap-2 text-sm text-muted-foreground mb-3 cursor-pointer">
          <input type="checkbox" checked={autoFix} onChange={(e) => void toggleAutoFix(e.target.checked)} />
          <ShieldCheck className="w-4 h-4" /> Allow the AI CPA to auto-correct bookkeeping
        </label>

        {report ? (
          <>
            <p className="text-sm text-muted-foreground mb-2">Health score <span className="font-bold text-foreground">{report.score}/100</span> · {report.period}</p>
            <div className="divide-y divide-border">
              {report.findings.map((f, i) => (
                <div key={i} className="py-2.5">
                  <p className={`text-sm font-medium ${SEV[f.severity] || 'text-foreground'}`}>{f.title}</p>
                  <p className="text-xs text-muted-foreground">{f.detail}</p>
                  <p className="text-xs text-primary mt-0.5">→ {f.actionItem}</p>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No review yet. Run one to see actionable findings.</p>
        )}
      </div>
    </div>
  );
}
