import { useEffect } from 'react';

/**
 * This route predates the canonical Settings page (the Next.js `/settings`
 * page, rendering AgentBookSettingsPanel.tsx) and duplicated Business
 * Profile + Invoice Defaults with none of the later jurisdiction/currency/
 * student-profile work. Rather than maintain two settings surfaces, this
 * just forwards — a real browser navigation (not a client-side route),
 * since /settings lives outside this plugin's MemoryRouter/`/agentbook/*`
 * mount point.
 */
export function SettingsPage(): JSX.Element {
  useEffect(() => {
    window.location.href = '/settings';
  }, []);

  return (
    <div className="p-6 text-muted-foreground text-sm">
      Redirecting to Settings…
    </div>
  );
}
