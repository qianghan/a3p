'use client';

/**
 * Admin Skills Configuration
 *
 * Lists the platform-wide agent skills (AbSkillManifest, tenantId = null) and
 * lets a system admin enable/disable each one — i.e. install/uninstall it for
 * the agent. Backed by /api/v1/admin/skills (GET list, PATCH toggle).
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, AlertTriangle, CheckCircle2, Search, Power, PowerOff } from 'lucide-react';
import { Button, Input, Badge } from '@naap/ui';
import { useAuth } from '@/contexts/auth-context';
import { AdminNav } from '@/components/admin/AdminNav';

interface SkillEntry {
  name: string;
  description: string;
  category: string;
  source: string;
  enabled: boolean;
}

export default function AdminSkillsPage() {
  const router = useRouter();
  const { hasRole } = useAuth();
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const isAdmin = hasRole('system:admin');

  const loadSkills = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/v1/admin/skills', { credentials: 'include' });
      const data = await res.json();
      if (data.success) setSkills(data.data.skills || []);
      else setError(data.error || 'Failed to load skills');
    } catch {
      setError('Failed to load skills');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) {
      router.push('/agentbook');
      return;
    }
    loadSkills();
  }, [isAdmin, loadSkills, router]);

  const toggleSkill = async (name: string, enabled: boolean) => {
    try {
      setBusy(name);
      setError(null);
      setSuccessMsg(null);
      const res = await fetch('/api/v1/admin/skills', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name, enabled }),
      });
      const data = await res.json();
      if (data.success) {
        setSkills((prev) => prev.map((s) => (s.name === name ? { ...s, enabled } : s)));
        setSuccessMsg(`${enabled ? 'Enabled' : 'Disabled'} "${name}".`);
        setTimeout(() => setSuccessMsg(null), 4000);
      } else {
        setError(data.error || 'Failed to update skill');
      }
    } catch {
      setError('Failed to update skill');
    } finally {
      setBusy(null);
    }
  };

  const filtered = skills.filter((s) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.category.toLowerCase().includes(q)
    );
  });
  const enabledCount = skills.filter((s) => s.enabled).length;

  if (!isAdmin) return null;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <AdminNav />

      <div className="flex items-center gap-3">
        <div className="p-2 rounded-md bg-muted">
          <Sparkles className="w-5 h-5 text-muted-foreground" />
        </div>
        <div>
          <h1 className="text-lg font-semibold">Agent Skills</h1>
          <p className="text-sm text-muted-foreground">
            Install or uninstall the skills the agent can use. {enabledCount} of {skills.length} enabled.
          </p>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          <AlertTriangle size={16} /> {error}
        </div>
      )}
      {successMsg && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/10 text-emerald-500 text-sm">
          <CheckCircle2 size={16} /> {successMsg}
        </div>
      )}

      <Input
        icon={<Search size={16} />}
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="Search skills..."
      />

      {loading ? (
        <div className="flex flex-col items-center justify-center py-16">
          <div className="h-5 w-5 animate-spin text-muted-foreground border-2 border-current border-t-transparent rounded-full mb-3" />
          <p className="text-sm text-muted-foreground">Loading skills...</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <Sparkles size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">{searchQuery ? 'No skills match your search' : 'No skills found'}</p>
        </div>
      ) : (
        <div className="grid gap-2">
          {filtered.map((skill) => (
            <div
              key={skill.name}
              className={`flex items-center gap-3 p-4 rounded-lg border transition-all ${
                skill.enabled ? 'bg-card border-border' : 'bg-muted/30 border-border/50 opacity-70'
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-foreground">{skill.name}</span>
                  <Badge variant="secondary">{skill.category}</Badge>
                  {skill.source !== 'built_in' && <Badge variant="blue">{skill.source}</Badge>}
                  {!skill.enabled && <Badge variant="rose">disabled</Badge>}
                </div>
                <p className="text-xs text-muted-foreground truncate mt-0.5">{skill.description}</p>
              </div>
              <Button
                variant={skill.enabled ? 'ghost' : 'secondary'}
                size="sm"
                loading={busy === skill.name}
                onClick={() => toggleSkill(skill.name, !skill.enabled)}
                icon={skill.enabled ? <PowerOff size={14} /> : <Power size={14} />}
                className={skill.enabled ? 'text-muted-foreground' : 'text-emerald-500 hover:bg-emerald-500/10'}
              >
                {skill.enabled ? 'Disable' : 'Enable'}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
