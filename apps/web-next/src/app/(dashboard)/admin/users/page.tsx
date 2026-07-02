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
} from 'lucide-react';
import { Button, Input, Select, Badge } from '@naap/ui';
import { useAuth } from '@/contexts/auth-context';
import { AdminNav } from '@/components/admin/AdminNav';

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
  invitesSent?: number;
  invitesPaid?: number;
  rewardMonthsEarned?: number;
}

export default function AdminUsersPage() {
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

    const matchesRole =
      selectedRole === 'all' ||
      user.roles.some(r => r.includes(selectedRole));

    return matchesSearch && matchesRole;
  });

  const getRoleIcon = (roles: string[]) => {
    if (roles.includes('system:admin')) return <Crown className="w-4 h-4 text-yellow-500" />;
    if (roles.some(r => r.includes(':admin'))) return <Shield className="w-4 h-4 text-blue-500" />;
    return <User className="w-4 h-4 text-gray-500" />;
  };

  const getRoleBadges = (roles: string[]) => {
    return roles.slice(0, 3).map(role => (
      <Badge
        key={role}
        variant="blue"
      >
        {role.replace('system:', '').replace(':admin', ' Admin')}
      </Badge>
    ));
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
            User Management
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            View and manage all users in the system
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
            placeholder="Search by email, name, or wallet..."
          />
        </div>
        <Select
          value={selectedRole}
          onChange={(e) => setSelectedRole(e.target.value)}
        >
          <option value="all">All Roles</option>
          <option value="system:admin">System Admin</option>
          <option value=":admin">Plugin Admin</option>
          <option value="viewer">Viewer</option>
        </Select>
      </div>

      {/* Users Table */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <table className="w-full">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-2.5 text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                User
              </th>
              <th className="px-4 py-2.5 text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                Roles
              </th>
              <th className="px-4 py-2.5 text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                Status
              </th>
              <th className="px-4 py-2.5 text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                Joined
              </th>
              <th className="px-4 py-2.5 text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                Teams
              </th>
              <th className="px-4 py-2.5 text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                Plan
              </th>
              <th className="px-4 py-2.5 text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                Referrals
              </th>
              <th className="px-4 py-2.5 text-right text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filteredUsers.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                  <Users className="w-8 h-8 mx-auto mb-3 opacity-50" />
                  <p className="text-sm">No users found</p>
                </td>
              </tr>
            ) : (
              filteredUsers.map(user => (
                <tr key={user.id} className="hover:bg-muted/30">
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center">
                        {user.avatarUrl ? (
                          <img src={user.avatarUrl} alt="" className="w-8 h-8 rounded-md" />
                        ) : (
                          getRoleIcon(user.roles)
                        )}
                      </div>
                      <div>
                        <div className="font-medium text-sm">
                          {user.displayName || 'No Name'}
                        </div>
                        <div className="text-sm text-muted-foreground flex items-center gap-1">
                          {user.email ? (
                            <>
                              <Mail className="w-3 h-3" />
                              {user.email}
                            </>
                          ) : user.walletAddress ? (
                            <span className="font-mono text-xs">
                              {user.walletAddress.slice(0, 6)}...{user.walletAddress.slice(-4)}
                            </span>
                          ) : (
                            'No email'
                          )}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {getRoleBadges(user.roles)}
                      {user.roles.length > 3 && (
                        <span className="px-2 py-0.5 text-xs text-muted-foreground">
                          +{user.roles.length - 3} more
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    {user.emailVerified ? (
                      <span className="flex items-center gap-1 text-green-500 text-sm">
                        <CheckCircle2 className="w-4 h-4" />
                        Verified
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-muted-foreground text-sm">
                        <XCircle className="w-4 h-4" />
                        Unverified
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
                    {user._count?.teamMemberships || 0}
                  </td>
                  <td className="px-4 py-2.5 text-sm">
                    {user.planName ? (
                      <Badge variant="blue">{user.planName}</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
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
                      {user.suspended && <Badge variant="rose">Suspended</Badge>}
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<MoreVertical className="w-4 h-4" />}
                        onClick={() => setOpenMenuId(openMenuId === user.id ? null : user.id)}
                      />
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
                            Send notification
                          </button>
                          {user.suspended ? (
                            <button
                              type="button"
                              disabled={actionBusy}
                              onClick={() => doAction(user.id, 'reactivate')}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
                            >
                              Reactivate user
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={actionBusy || user.id === currentUser?.id}
                              onClick={() => doAction(user.id, 'suspend')}
                              className="w-full text-left px-3 py-2 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-40"
                            >
                              Suspend user
                            </button>
                          )}
                          {user.roles.includes('system:admin') ? (
                            <button
                              type="button"
                              disabled={actionBusy || user.id === currentUser?.id}
                              onClick={() => doAction(user.id, 'revokeAdmin')}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-muted disabled:opacity-40"
                            >
                              Remove admin
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={actionBusy}
                              onClick={() => doAction(user.id, 'grantAdmin')}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
                            >
                              Make admin
                            </button>
                          )}
                          {user.roles.includes('sales_rep') ? (
                            <button
                              type="button"
                              disabled={actionBusy}
                              onClick={() => doRevokeSalesRep(user.id)}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-muted disabled:opacity-40"
                            >
                              Remove sales rep
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
                              Promote to sales rep
                            </button>
                          )}
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
            <h3 className="text-base font-semibold mb-1">Promote to sales rep</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {promoteTarget.email || promoteTarget.displayName} gets a free comped plan and their own
              commission-tracked referral link — no Stripe charge.
            </p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Comped plan</label>
                <Select
                  value={promotePlan}
                  onChange={(e) => setPromotePlan(e.target.value as 'pro' | 'business')}
                >
                  <option value="pro">Pro</option>
                  <option value="business">Business</option>
                </Select>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Commission %</label>
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
                <label className="block text-xs font-medium text-muted-foreground mb-1">Payout frequency</label>
                <Select
                  value={promoteFrequency}
                  onChange={(e) => setPromoteFrequency(e.target.value as 'monthly' | 'quarterly' | 'annual')}
                >
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="annual">Annual</option>
                </Select>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setPromoteTarget(null)} disabled={actionBusy}>
                Cancel
              </Button>
              <Button onClick={doPromoteToSalesRep} disabled={actionBusy}>
                Promote
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
