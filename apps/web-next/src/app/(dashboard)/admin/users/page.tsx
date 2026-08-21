'use client';

/**
 * Admin User Management Page
 * View and manage all users in the system.
 */

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Users,
  Shield,
  User,
  Crown,
  MoreVertical,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Mail,
  Calendar,
  Search,
  Bell,
  Gift,
  Handshake,
} from 'lucide-react';
import { Button, Input, Select, Badge } from '@naap/ui';
import { useAuth } from '@/contexts/auth-context';
import { AdminNav } from '@/components/admin/AdminNav';
import { useT } from '@/hooks/use-t';

interface SystemUser {
  id: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  walletAddress: string | null;
  roles: string[];
  emailVerified: boolean;
  suspended?: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  _count?: { teamMemberships: number };
  planName?: string | null;
  planCode?: string | null;
  businessType?: string | null;
  isSalesRep?: boolean;
  isAdmin?: boolean;
  invitesSent?: number;
  invitesPaid?: number;
  rewardMonthsEarned?: number;
}

// Key map, not a label map — module scope has no translator. `prettyType`
// therefore takes one; the old parameter was also named `t`, which would have
// shadowed it.
const BUSINESS_TYPE_KEYS: Record<string, string> = {
  student: 'common.persona_student', freelancer: 'common.persona_freelancer',
  sole_proprietor: 'common.persona_sole_proprietor',
  consultant: 'common.persona_consultant', contractor: 'common.persona_contractor',
  agency: 'common.persona_agency', startup: 'common.persona_startup',
};
const prettyType = (t: (k: string) => string, type?: string | null) =>
  (type ? (BUSINESS_TYPE_KEYS[type] ? t(BUSINESS_TYPE_KEYS[type]) : type.replace(/_/g, ' ')) : null);
const prettyPlan = (name?: string | null) => name || 'Free';

export default function AdminUsersPage() {
  const t = useT();
  const router = useRouter();
  const { hasRole, user: currentUser } = useAuth();
  const [users, setUsers] = useState<SystemUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRole, setSelectedRole] = useState<string>('all');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [promoteTarget, setPromoteTarget] = useState<SystemUser | null>(null);
  const [promotePlan, setPromotePlan] = useState<'pro' | 'business'>('pro');
  const [promoteCommissionPercent, setPromoteCommissionPercent] = useState('20');
  const [promoteFrequency, setPromoteFrequency] = useState<'monthly' | 'quarterly' | 'annual'>('quarterly');

  const isAdmin = hasRole('system:admin');

  async function doAction(userId: string, action: string) {
    setActionBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (data.success) {
        setOpenMenuId(null);
        await loadUsers();
      } else {
        setError(data.error?.message || data.error || 'Action failed');
      }
    } catch {
      setError('Action failed');
    } finally {
      setActionBusy(false);
    }
  }

  async function doSetPlan(userId: string, plan: 'free' | 'pro' | 'business') {
    setActionBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'setPlan', plan }),
      });
      const data = await res.json();
      if (data.success) {
        setOpenMenuId(null);
        await loadUsers();
      } else {
        setError(data.error?.message || data.error || 'Failed to change plan');
      }
    } catch {
      setError('Failed to change plan');
    } finally {
      setActionBusy(false);
    }
  }

  async function doPromoteToSalesRep() {
    if (!promoteTarget) return;
    const commissionBps = Math.round(Number(promoteCommissionPercent) * 100);
    setActionBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/admin/users/${promoteTarget.id}/sales-rep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ plan: promotePlan, commissionBps, payoutFrequency: promoteFrequency }),
      });
      const data = await res.json();
      if (data.success) {
        setPromoteTarget(null);
        setOpenMenuId(null);
        await loadUsers();
      } else {
        setError(data.error?.message || data.error || 'Failed to promote to sales rep');
      }
    } catch {
      setError('Failed to promote to sales rep');
    } finally {
      setActionBusy(false);
    }
  }

  async function doRevokeSalesRep(userId: string) {
    setActionBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/admin/users/${userId}/sales-rep`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json();
      if (data.success) {
        setOpenMenuId(null);
        await loadUsers();
      } else {
        setError(data.error?.message || data.error || 'Failed to revoke sales rep');
      }
    } catch {
      setError('Failed to revoke sales rep');
    } finally {
      setActionBusy(false);
    }
  }

  useEffect(() => {
    if (!isAdmin) {
      router.push('/agentbook');
      return;
    }
    loadUsers();
  }, [isAdmin]);

  async function loadUsers() {
    try {
      setLoading(true);
      const res = await fetch('/api/v1/admin/users');
      const data = await res.json();
      if (data.success) {
        setUsers(data.data.users || []);
      } else {
        setError(data.error?.message || 'Failed to load users');
      }
    } catch (err) {
      setError('Failed to load users');
    } finally {
      setLoading(false);
    }
  }

  const filteredUsers = users.filter(user => {
    const matchesSearch =
      !searchQuery ||
      user.email?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      user.displayName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      user.walletAddress?.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesFilter =
      selectedRole === 'all' ||
      (selectedRole === 'admins' && user.isAdmin) ||
      (selectedRole === 'sales_reps' && user.isSalesRep) ||
      (selectedRole === 'students' && user.businessType === 'student') ||
      (selectedRole === 'paid' && (user.planCode ?? 'free') !== 'free') ||
      (selectedRole === 'free' && (user.planCode ?? 'free') === 'free');

    return matchesSearch && matchesFilter;
  });

  const getRoleIcon = (user: SystemUser) => {
    if (user.isAdmin) return <Crown className="w-4 h-4 text-yellow-500" />;
    if (user.isSalesRep) return <Handshake className="w-4 h-4 text-emerald-500" />;
    return <User className="w-4 h-4 text-gray-500" />;
  };

  // Meaningful AgentBook access badges (Admin / Sales rep) — not raw RBAC roles.
  const getAccessBadges = (user: SystemUser) => {
    const badges = [];
    if (user.isAdmin) badges.push(<Badge key="admin" variant="amber">{t('nav.admin')}</Badge>);
    if (user.isSalesRep) badges.push(<Badge key="rep" variant="emerald">{t('admin_ui.sales_rep')}</Badge>);
    return badges.length ? badges : <span className="text-muted-foreground text-sm">{t('core_ui.user')}</span>;
  };

  if (!isAdmin) {
    return null;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="h-5 w-5 animate-spin text-muted-foreground border-2 border-current border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="p-4 max-w-6xl mx-auto">
      <AdminNav />
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <Shield className="w-5 h-5" />
            {t('admin_ui.user_management')}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('admin_ui.users_sub')}
          </p>
        </div>
        <div className="text-sm text-muted-foreground">
          {users.length} total users
        </div>
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-lg mb-4 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          {error}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="flex-1">
          <Input
            icon={<Search className="w-4 h-4" />}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('admin_ui.ph_search_users')}
          />
        </div>
        <Select
          value={selectedRole}
          onChange={(e) => setSelectedRole(e.target.value)}
        >
          <option value="all">{t('admin_ui.everyone')}</option>
          <option value="admins">{t('admin_ui.admins')}</option>
          <option value="sales_reps">{t('admin_ui.sales_reps')}</option>
          <option value="students">{t('admin_ui.students')}</option>
          <option value="paid">{t('admin_ui.paid_plans')}</option>
          <option value="free">{t('admin_ui.free_plan')}</option>
        </Select>
      </div>

      {/* Users Table */}
      <div className="bg-card border border-border rounded-lg overflow-x-auto">
        <table className="w-full">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-2.5 text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                {t('core_ui.user')}
              </th>
              <th className="px-4 py-2.5 text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                {t('admin_ui.access')}
              </th>
              <th className="px-4 py-2.5 text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                {t('common.status')}
              </th>
              <th className="px-4 py-2.5 text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                {t('admin_ui.joined')}
              </th>
              <th className="px-4 py-2.5 text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                {t('accounting.type')}
              </th>
              <th className="px-4 py-2.5 text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                {t('admin_ui.plan')}
              </th>
              <th className="px-4 py-2.5 text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                {t('admin_ui.referrals')}
              </th>
              <th className="px-4 py-2.5 text-right text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                {t('common.actions')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filteredUsers.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                  <Users className="w-8 h-8 mx-auto mb-3 opacity-50" />
                  <p className="text-sm">{t('admin_ui.no_users')}</p>
                </td>
              </tr>
            ) : (
              filteredUsers.map(user => (
                <tr key={user.id} className="hover:bg-muted/30">
                  <td className="px-4 py-2.5 max-w-[260px]">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 shrink-0 rounded-md bg-muted flex items-center justify-center">
                        {user.avatarUrl ? (
                          <img src={user.avatarUrl} alt="" className="w-8 h-8 rounded-md" />
                        ) : (
                          getRoleIcon(user)
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium text-sm truncate">
                          {user.displayName || 'No Name'}
                        </div>
                        <div className="text-sm text-muted-foreground flex items-center gap-1 min-w-0" title={user.email || user.walletAddress || ''}>
                          {user.email ? (
                            <>
                              <Mail className="w-3 h-3 shrink-0" />
                              <span className="truncate">{user.email}</span>
                            </>
                          ) : user.walletAddress ? (
                            <span className="font-mono text-xs truncate">
                              {user.walletAddress.slice(0, 6)}...{user.walletAddress.slice(-4)}
                            </span>
                          ) : (
                            t('admin_ui.no_email')
                          )}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {getAccessBadges(user)}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    {user.emailVerified ? (
                      <span className="flex items-center gap-1 text-green-500 text-sm">
                        <CheckCircle2 className="w-4 h-4" />
                        {t('admin_ui.verified')}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-muted-foreground text-sm">
                        <XCircle className="w-4 h-4" />
                        {t('admin_ui.unverified')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      {new Date(user.createdAt).toLocaleDateString()}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-sm">
                    {prettyType(t, user.businessType) ? (
                      <Badge variant="blue">{prettyType(t, user.businessType)}</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-sm">
                    <Badge variant={(user.planCode ?? 'free') === 'free' ? 'secondary' : 'emerald'}>{prettyPlan(user.planName)}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-sm text-muted-foreground">
                    {(user.invitesSent ?? 0) > 0 ? (
                      <div className="flex items-center gap-1">
                        <Gift className="w-3 h-3" />
                        <span>{user.invitesPaid ?? 0}/{user.invitesSent} paid</span>
                        {(user.rewardMonthsEarned ?? 0) > 0 && (
                          <Badge variant="emerald">{user.rewardMonthsEarned}mo earned</Badge>
                        )}
                      </div>
                    ) : (
                      <span>—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right relative">
                    <div className="inline-flex items-center gap-2 justify-end">
                      {user.suspended && <Badge variant="rose">{t('admin_ui.suspended')}</Badge>}
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<MoreVertical className="w-4 h-4" />}
                        onClick={() => setOpenMenuId(openMenuId === user.id ? null : user.id)}
                      >
                        {t('admin_ui.manage')}
                      </Button>
                    </div>
                    {openMenuId === user.id && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setOpenMenuId(null)} />
                        <div className="absolute right-4 z-20 mt-1 w-48 rounded-md border border-border bg-card shadow-lg py-1 text-left">
                          <button
                            type="button"
                            onClick={() => router.push(`/admin/notifications?tenantId=${user.id}`)}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-2"
                          >
                            <Bell className="w-3.5 h-3.5" />
                            {t('admin_ui.send_notification')}
                          </button>
                          {user.suspended ? (
                            <button
                              type="button"
                              disabled={actionBusy}
                              onClick={() => doAction(user.id, 'reactivate')}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
                            >
                              {t('admin_ui.reactivate_user')}
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={actionBusy || user.id === currentUser?.id}
                              onClick={() => doAction(user.id, 'suspend')}
                              className="w-full text-left px-3 py-2 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-40"
                            >
                              {t('admin_ui.suspend_user')}
                            </button>
                          )}
                          {user.isAdmin ? (
                            <button
                              type="button"
                              disabled={actionBusy || user.id === currentUser?.id}
                              onClick={() => doAction(user.id, 'revokeAdmin')}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-muted disabled:opacity-40"
                            >
                              {t('admin_ui.remove_admin')}
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={actionBusy}
                              onClick={() => doAction(user.id, 'grantAdmin')}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
                            >
                              {t('admin_ui.make_admin')}
                            </button>
                          )}
                          {user.isSalesRep ? (
                            <button
                              type="button"
                              disabled={actionBusy}
                              onClick={() => doRevokeSalesRep(user.id)}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-muted disabled:opacity-40"
                            >
                              {t('admin_ui.remove_sales_rep')}
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={actionBusy}
                              onClick={() => {
                                setPromoteTarget(user);
                                setOpenMenuId(null);
                              }}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-muted disabled:opacity-50 flex items-center gap-2"
                            >
                              <Gift className="w-3.5 h-3.5" />
                              {t('admin_ui.promote_to_rep')}
                            </button>
                          )}
                          <div className="border-t border-border mt-1 pt-1">
                            <div className="px-3 py-1 text-[11px] uppercase tracking-wider text-muted-foreground">{t('admin_ui.comp_plan')}</div>
                            {(['free', 'pro', 'business'] as const).map((p) => {
                              const current = (user.planCode ?? 'free') === p;
                              return (
                                <button
                                  key={p}
                                  type="button"
                                  disabled={actionBusy || current}
                                  onClick={() => doSetPlan(user.id, p)}
                                  className="w-full text-left px-3 py-2 text-sm hover:bg-muted disabled:opacity-40 flex items-center justify-between"
                                >
                                  <span className="capitalize">{p}</span>
                                  {current && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {promoteTarget && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-xl">
            <h3 className="text-base font-semibold mb-1">{t('admin_ui.promote_to_rep')}</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {promoteTarget.email || promoteTarget.displayName} gets a free comped plan and their own
              commission-tracked referral link — no Stripe charge.
            </p>
            {(promoteTarget.invitesSent ?? 0) > 0 && (
              <div className="rounded-md bg-amber-500/10 text-amber-700 text-xs px-3 py-2 mb-4">
                This user already has {promoteTarget.invitesSent} existing referral{promoteTarget.invitesSent === 1 ? '' : 's'}
                {' '}({promoteTarget.invitesPaid ?? 0} paid). Their referral link stays the same on promotion, so anyone who
                signed up through it — past or future — will start earning commission on renewal payments going forward.
              </div>
            )}
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">{t('admin_ui.comped_plan')}</label>
                <Select
                  value={promotePlan}
                  onChange={(e) => setPromotePlan(e.target.value as 'pro' | 'business')}
                >
                  <option value="pro">Pro</option>
                  <option value="business">Business</option>
                </Select>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">{t('admin_ui.commission_pct')}</label>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={promoteCommissionPercent}
                  onChange={(e) => setPromoteCommissionPercent(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">{t('admin_ui.payout_frequency')}</label>
                <Select
                  value={promoteFrequency}
                  onChange={(e) => setPromoteFrequency(e.target.value as 'monthly' | 'quarterly' | 'annual')}
                >
                  <option value="monthly">{t('billing.monthly')}</option>
                  <option value="quarterly">{t('expenses_ui.quarterly')}</option>
                  <option value="annual">{t('billing.annual')}</option>
                </Select>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setPromoteTarget(null)} disabled={actionBusy}>
                {t('common.cancel')}
              </Button>
              <Button onClick={doPromoteToSalesRep} disabled={actionBusy}>
                {t('admin_ui.promote')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
