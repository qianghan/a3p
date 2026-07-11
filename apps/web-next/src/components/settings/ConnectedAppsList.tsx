'use client';

import React, { useEffect, useState } from 'react';
import { Loader2, ShieldOff } from 'lucide-react';
import { useShell } from '@/contexts/shell-context';
import { getCsrfToken } from '@/lib/api/csrf';

interface ConnectedApp {
  clientId: string;
  clientName: string;
  scope: string;
  grantedAt: string;
}

/**
 * Lists MCP/OAuth clients (e.g. Claude Desktop, Claude Code) the user has
 * granted AgentBook access to, and lets them revoke access. Revoking calls
 * `DELETE /api/v1/oauth/connected-apps`, which invalidates the underlying
 * tokens immediately rather than just marking consent revoked and letting
 * them expire on their own TTL.
 */
export function ConnectedAppsList() {
  const { notifications } = useShell();
  const [apps, setApps] = useState<ConnectedApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [revokingClientId, setRevokingClientId] = useState<string | null>(null);

  useEffect(() => {
    const loadApps = async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/v1/oauth/connected-apps');
        if (res.ok) {
          const { data } = await res.json();
          setApps(data || []);
        } else {
          notifications.error('Failed to load connected apps');
        }
      } catch {
        notifications.error('Failed to load connected apps');
      } finally {
        setLoading(false);
      }
    };
    void loadApps();
    // Intentionally run once on mount, matching the established pattern
    // elsewhere in this settings area (see AgentBookSettingsPanel's
    // `useEffect(() => { void fetchStatus(); }, [])`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRevoke = async (clientId: string, clientName: string) => {
    setRevokingClientId(clientId);
    try {
      const csrfToken = await getCsrfToken();
      const res = await fetch('/api/v1/oauth/connected-apps', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ clientId }),
      });

      if (res.ok) {
        notifications.success(`Revoked access for ${clientName}`);
        setApps((prev) => prev.filter((app) => app.clientId !== clientId));
      } else {
        const data = await res.json();
        notifications.error(data.error?.message || data.error || 'Failed to revoke access');
      }
    } catch {
      notifications.error('Failed to revoke access');
    } finally {
      setRevokingClientId(null);
    }
  };

  if (loading) {
    return (
      <div className="text-sm text-muted-foreground flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading connected apps...
      </div>
    );
  }

  if (apps.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No apps are currently connected to your AgentBook account.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {apps.map((app) => (
        <div
          key={app.clientId}
          className="flex items-center justify-between p-3 rounded-lg border bg-muted/30"
        >
          <div>
            <div className="text-sm font-medium">{app.clientName}</div>
            <div className="text-xs text-muted-foreground">
              Connected {new Date(app.grantedAt).toLocaleDateString()} &middot; scope: {app.scope}
            </div>
          </div>
          <button
            type="button"
            onClick={() => handleRevoke(app.clientId, app.clientName)}
            disabled={revokingClientId === app.clientId}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-muted text-muted-foreground hover:bg-destructive/20 hover:text-destructive transition-all disabled:opacity-50"
          >
            {revokingClientId === app.clientId ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <ShieldOff className="w-3.5 h-3.5" />
            )}
            Revoke
          </button>
        </div>
      ))}
    </div>
  );
}
