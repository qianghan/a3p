'use client';

/**
 * Admin Notifications — compose + broadcast log.
 * See docs/superpowers/specs/2026-07-01-admin-notifications-design.md.
 */

import React, { Suspense, useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Bell, Send, AlertTriangle, CheckCircle2, Clock, Users as UsersIcon, Sparkles, Gift, Megaphone, Wand2 } from 'lucide-react';
import { Button, Input, Select, Badge } from '@naap/ui';
import { useAuth } from '@/contexts/auth-context';
import { AdminNav } from '@/components/admin/AdminNav';
import { getTemplatesFor, type NotificationTemplate } from '@/lib/notification-templates';

const SEVERITY_DOT: Record<string, string> = {
  info: 'bg-blue-500',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  urgent: 'bg-red-500',
};

const CATEGORY_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  feature: Sparkles,
  reward: Gift,
  admin_broadcast: Megaphone,
};

const CATEGORIES = [
  { value: 'feature', label: 'New feature' },
  { value: 'reward', label: 'Discount / reward' },
  { value: 'admin_broadcast', label: 'General broadcast' },
  { value: 'referral_thanks', label: 'Referral thank-you (system-triggered — not composable here)' },
];
const AUDIENCE_TYPES = [
  { value: 'all', label: 'Everyone' },
  { value: 'plan', label: 'By plan' },
  { value: 'segment', label: 'Segment (richer filters)' },
  { value: 'list', label: 'Specific emails / tenant IDs' },
  { value: 'single', label: 'Single user' },
];

interface NotificationLogItem {
  id: string;
  category: string;
  title: string;
  audienceType: string;
  status: string;
  scheduledFor: string | null;
  dispatchedAt: string | null;
  createdAt: string;
  stats: { delivered: number; read: number; acted: number; emailSent: number; emailFailed: number; emailSkipped: number };
}

function AdminNotificationsInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { hasRole } = useAuth();
  const isAdmin = hasRole('system:admin');

  const [category, setCategory] = useState('admin_broadcast');
  const [severity, setSeverity] = useState('info');
  const [title, setTitle] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [ctaLabel, setCtaLabel] = useState('');
  const [ctaUrl, setCtaUrl] = useState('');
  const [appliedTemplateId, setAppliedTemplateId] = useState<string | null>(null);

  const templates = useMemo(() => getTemplatesFor(category), [category]);

  const applyTemplate = useCallback((t: NotificationTemplate) => {
    setTitle(t.title);
    setBodyText(t.body);
    setCtaLabel(t.ctaLabel ?? '');
    setCtaUrl(t.ctaUrl ?? '');
    setSeverity(t.severity);
    setAppliedTemplateId(t.id);
  }, []);
  const [audienceType, setAudienceType] = useState('all');
  const [planCodesInput, setPlanCodesInput] = useState('');
  const [signupAfter, setSignupAfter] = useState('');
  const [signupBefore, setSignupBefore] = useState('');
  const [minInvitesSent, setMinInvitesSent] = useState('');
  const [minInvitesPaid, setMinInvitesPaid] = useState('');
  const [hasReward, setHasReward] = useState<'any' | 'yes' | 'no'>('any');
  const [listInput, setListInput] = useState('');
  const [singleTenantId, setSingleTenantId] = useState('');
  const [scheduledFor, setScheduledFor] = useState('');

  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [log, setLog] = useState<NotificationLogItem[]>([]);
  const [logLoading, setLogLoading] = useState(true);

  useEffect(() => {
    const tid = searchParams.get('tenantId');
    if (tid) {
      setAudienceType('single');
      setSingleTenantId(tid);
    }
  }, [searchParams]);

  const audienceFilter = useMemo(() => {
    if (audienceType === 'plan') {
      return { planCodes: planCodesInput.split(',').map((s) => s.trim()).filter(Boolean) };
    }
    if (audienceType === 'segment') {
      const f: Record<string, unknown> = {};
      const planCodes = planCodesInput.split(',').map((s) => s.trim()).filter(Boolean);
      if (planCodes.length) f.planCodes = planCodes;
      if (signupAfter) f.signupAfter = signupAfter;
      if (signupBefore) f.signupBefore = signupBefore;
      if (minInvitesSent) f.minInvitesSent = Number(minInvitesSent);
      if (minInvitesPaid) f.minInvitesPaid = Number(minInvitesPaid);
      if (hasReward !== 'any') f.hasReward = hasReward === 'yes';
      return f;
    }
    if (audienceType === 'list') {
      const raw = listInput.split(',').map((s) => s.trim()).filter(Boolean);
      const emails = raw.filter((s) => s.includes('@'));
      const tenantIds = raw.filter((s) => !s.includes('@'));
      return { emails, tenantIds };
    }
    if (audienceType === 'single') {
      return { tenantId: singleTenantId.trim() };
    }
    return undefined;
  }, [audienceType, planCodesInput, signupAfter, signupBefore, minInvitesSent, minInvitesPaid, hasReward, listInput, singleTenantId]);

  const loadLog = useCallback(async () => {
    try {
      setLogLoading(true);
      const res = await fetch('/api/v1/agentbook-core/admin/notifications', { credentials: 'include' });
      const data = await res.json();
      if (data.success) setLog(data.data.notifications || []);
    } finally {
      setLogLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) loadLog();
  }, [isAdmin, loadLog]);

  // Debounced live audience-size preview.
  useEffect(() => {
    if (!isAdmin) return;
    const handle = setTimeout(async () => {
      setPreviewLoading(true);
      try {
        const res = await fetch('/api/v1/agentbook-core/admin/notifications/segment-preview', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audienceType, audienceFilter }),
        });
        const data = await res.json();
        setPreviewCount(data.success ? data.data.count : null);
      } catch {
        setPreviewCount(null);
      } finally {
        setPreviewLoading(false);
      }
    }, 400);
    return () => clearTimeout(handle);
  }, [isAdmin, audienceType, audienceFilter]);

  async function handleSend() {
    setError(null);
    setSuccessMsg(null);
    if (!title.trim() || !bodyText.trim()) {
      setError('Title and message are required.');
      return;
    }
    setSending(true);
    try {
      const res = await fetch('/api/v1/agentbook-core/admin/notifications', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category,
          severity,
          title,
          bodyText,
          ctaLabel: ctaLabel || undefined,
          ctaUrl: ctaUrl || undefined,
          audienceType,
          audienceFilter,
          scheduledFor: scheduledFor || undefined,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setSuccessMsg(scheduledFor ? 'Notification scheduled.' : 'Notification sent.');
        setTitle('');
        setBodyText('');
        setCtaLabel('');
        setCtaUrl('');
        setScheduledFor('');
        await loadLog();
      } else {
        setError(data.error || 'Failed to send notification.');
      }
    } catch {
      setError('Failed to send notification.');
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    if (!isAdmin) router.push('/agentbook');
  }, [isAdmin, router]);
  if (!isAdmin) return null;

  return (
    <div className="p-4 max-w-6xl mx-auto">
      <AdminNav />
      <div className="mb-4">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <Bell className="w-5 h-5" />
          Notifications
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">Compose an in-app + email broadcast, or view past sends.</p>
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-lg mb-4 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          {error}
        </div>
      )}
      {successMsg && (
        <div className="bg-emerald-500/10 text-emerald-600 px-4 py-3 rounded-lg mb-4 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" />
          {successMsg}
        </div>
      )}

      {/* Composer */}
      <div className="bg-card border border-border rounded-lg p-4 mb-6 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Category</label>
            <Select
              value={category}
              onChange={(e) => { setCategory(e.target.value); setAppliedTemplateId(null); }}
              className="mt-1"
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value} disabled={c.value === 'referral_thanks'}>
                  {c.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Severity</label>
            <Select value={severity} onChange={(e) => setSeverity(e.target.value)} className="mt-1">
              <option value="info">Info</option>
              <option value="success">Success</option>
              <option value="warning">Warning</option>
              <option value="urgent">Urgent</option>
            </Select>
          </div>
        </div>

        {templates.length > 0 && (
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Wand2 className="w-3.5 h-3.5" /> Start from a template
            </label>
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
              {templates.map((t) => {
                const Icon = CATEGORY_ICON[category] ?? Sparkles;
                const isApplied = appliedTemplateId === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => applyTemplate(t)}
                    className={`text-left rounded-lg border p-3 transition-colors ${
                      isApplied
                        ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                        : 'border-border bg-background hover:border-primary/50 hover:bg-muted/40'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                        <Icon className="w-3.5 h-3.5 text-primary" /> {t.name}
                      </span>
                      {isApplied && <Badge variant="secondary">Applied</Badge>}
                    </div>
                    {/* Mini live preview — mirrors the end-user notification bell's row styling */}
                    <div className="rounded-md border border-border/60 bg-card px-2.5 py-2">
                      <div className="flex items-start gap-2">
                        <span className={`mt-1 h-1.5 w-1.5 rounded-full shrink-0 ${SEVERITY_DOT[t.severity]}`} />
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-foreground truncate">{t.title}</div>
                          <div className="text-[11px] text-muted-foreground line-clamp-2 mt-0.5">{t.body}</div>
                          {t.ctaLabel && (
                            <span className="inline-block mt-1.5 text-[11px] font-medium text-primary">{t.ctaLabel} →</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-muted-foreground mt-1.5">
              Applying a template fills the fields below — replace anything in [brackets] before sending.
            </p>
          </div>
        )}

        <div>
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Title</label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Receipt scanning just got faster" className="mt-1" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Message</label>
          <textarea
            value={bodyText}
            onChange={(e) => setBodyText(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            placeholder="What changed, and why the user should care."
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">CTA label (optional)</label>
            <Input value={ctaLabel} onChange={(e) => setCtaLabel(e.target.value)} placeholder="Try it now" className="mt-1" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">CTA link (optional)</label>
            <Input value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} placeholder="/agentbook/expenses" className="mt-1" />
          </div>
        </div>

        <div className="border-t border-border pt-4">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Audience</label>
          <Select value={audienceType} onChange={(e) => setAudienceType(e.target.value)} className="mt-1">
            {AUDIENCE_TYPES.map((a) => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
          </Select>

          {(audienceType === 'plan' || audienceType === 'segment') && (
            <Input
              value={planCodesInput}
              onChange={(e) => setPlanCodesInput(e.target.value)}
              placeholder="Plan codes, comma-separated (e.g. pro, business)"
              className="mt-2"
            />
          )}

          {audienceType === 'segment' && (
            <div className="mt-2 grid grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] text-muted-foreground">Signed up after</label>
                <Input type="date" value={signupAfter} onChange={(e) => setSignupAfter(e.target.value)} />
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground">Signed up before</label>
                <Input type="date" value={signupBefore} onChange={(e) => setSignupBefore(e.target.value)} />
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground">Min. invites sent</label>
                <Input type="number" min={0} value={minInvitesSent} onChange={(e) => setMinInvitesSent(e.target.value)} />
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground">Min. invites paid</label>
                <Input type="number" min={0} value={minInvitesPaid} onChange={(e) => setMinInvitesPaid(e.target.value)} />
              </div>
              <div className="col-span-2">
                <label className="text-[11px] text-muted-foreground">Has earned a referral reward</label>
                <Select value={hasReward} onChange={(e) => setHasReward(e.target.value as 'any' | 'yes' | 'no')} className="mt-1">
                  <option value="any">Any</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </Select>
              </div>
            </div>
          )}

          {audienceType === 'list' && (
            <textarea
              value={listInput}
              onChange={(e) => setListInput(e.target.value)}
              rows={2}
              className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              placeholder="Emails or tenant IDs, comma-separated"
            />
          )}

          {audienceType === 'single' && (
            <Input value={singleTenantId} onChange={(e) => setSingleTenantId(e.target.value)} placeholder="Tenant ID" className="mt-2" />
          )}

          <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
            <UsersIcon className="w-3.5 h-3.5" />
            {previewLoading ? 'Estimating reach…' : previewCount === null ? 'Reach unknown' : `Will reach ${previewCount} user${previewCount === 1 ? '' : 's'}`}
          </div>
        </div>

        <div className="border-t border-border pt-4 flex items-center justify-between gap-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Send time</label>
            <Input
              type="datetime-local"
              value={scheduledFor}
              onChange={(e) => setScheduledFor(e.target.value)}
              className="mt-1"
            />
            <p className="text-[11px] text-muted-foreground mt-1">Leave blank to send immediately.</p>
          </div>
          <Button variant="primary" icon={<Send className="w-4 h-4" />} onClick={handleSend} disabled={sending}>
            {sending ? 'Sending…' : scheduledFor ? 'Schedule' : 'Send now'}
          </Button>
        </div>
      </div>

      {/* Log */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b border-border text-sm font-medium">Recent broadcasts</div>
        <table className="w-full">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-2 text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Title</th>
              <th className="px-4 py-2 text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Category</th>
              <th className="px-4 py-2 text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Status</th>
              <th className="px-4 py-2 text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Delivered / Read / Acted</th>
              <th className="px-4 py-2 text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Email sent / failed / skipped</th>
              <th className="px-4 py-2 text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {logLoading ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground text-sm">Loading…</td></tr>
            ) : log.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground text-sm">No notifications sent yet.</td></tr>
            ) : (
              log.map((n) => (
                <tr key={n.id} className="hover:bg-muted/30">
                  <td className="px-4 py-2.5 text-sm font-medium">{n.title}</td>
                  <td className="px-4 py-2.5 text-sm"><Badge variant="secondary">{n.category}</Badge></td>
                  <td className="px-4 py-2.5 text-sm">
                    {n.status === 'sent' ? (
                      <span className="flex items-center gap-1 text-emerald-600"><CheckCircle2 className="w-3.5 h-3.5" />Sent</span>
                    ) : n.status === 'pending' && n.scheduledFor ? (
                      <span className="flex items-center gap-1 text-amber-600"><Clock className="w-3.5 h-3.5" />Scheduled</span>
                    ) : (
                      <span className="text-muted-foreground">{n.status}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-muted-foreground">{n.stats.delivered} / {n.stats.read} / {n.stats.acted}</td>
                  <td className="px-4 py-2.5 text-sm text-muted-foreground">{n.stats.emailSent} / {n.stats.emailFailed} / {n.stats.emailSkipped}</td>
                  <td className="px-4 py-2.5 text-sm text-muted-foreground">{new Date(n.createdAt).toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function AdminNotificationsPage() {
  return (
    <Suspense fallback={<div className="p-4 max-w-6xl mx-auto text-sm text-muted-foreground">Loading…</div>}>
      <AdminNotificationsInner />
    </Suspense>
  );
}
