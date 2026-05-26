import React, { useEffect, useState } from 'react';
import { Sparkles, ChevronRight, X } from 'lucide-react';

/**
 * "Resume your setup" banner (PR 53 / Tier 3 #10 abandon-recovery).
 *
 * Reads /onboarding/resume-prompt — pure read, no side effects. Renders
 * nothing when shouldShow=false (never-started, already-completed, or
 * empty progress). When shown, links to /agentbook/onboarding so the
 * user can pick up where they left off in the agent-driven flow.
 *
 * Dismissal is in-tab only (sessionStorage) — the user sees it again on
 * next session if onboarding is still incomplete. The abandon-recovery
 * cron handles the longer-form Telegram/Email nudge after 48h.
 */

interface ResumePromptResponse {
  success: boolean;
  data?: {
    shouldShow: boolean;
    completed?: number;
    total?: number;
    nextStepLabel?: string;
    hoursSinceStart?: number;
  };
}

const DISMISS_KEY = 'agentbook-onboarding-resume-dismissed';

export const ResumeOnboardingBanner: React.FC = () => {
  const [data, setData] = useState<ResumePromptResponse['data'] | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      return sessionStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (dismissed) return;
    let cancelled = false;
    void fetch('/api/v1/agentbook-core/onboarding/resume-prompt', {
      credentials: 'include',
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((json: ResumePromptResponse | null) => {
        if (cancelled) return;
        setData(json?.data ?? null);
      })
      .catch(() => {
        /* silent — banner just doesn't render */
      });
    return () => {
      cancelled = true;
    };
  }, [dismissed]);

  if (dismissed || !data || !data.shouldShow) return null;

  const dismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* sessionStorage may be unavailable in some embeddings */
    }
    setDismissed(true);
  };

  return (
    <div
      className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 flex items-center gap-3 mb-4"
      data-testid="resume-onboarding-banner"
    >
      <div className="p-2 rounded-lg bg-amber-500/10 flex-shrink-0">
        <Sparkles className="w-5 h-5 text-amber-600" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">
          You're {data.completed}/{data.total} done setting up.
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Next: {data.nextStepLabel}.{' '}
          {typeof data.hoursSinceStart === 'number' && data.hoursSinceStart >= 24
            ? `Started ${Math.round(data.hoursSinceStart / 24)} day(s) ago.`
            : ''}
        </p>
      </div>
      <a
        href="/agentbook/onboarding"
        className="inline-flex items-center gap-1 text-sm font-medium text-amber-700 hover:text-amber-900 dark:text-amber-400 dark:hover:text-amber-300"
      >
        Resume <ChevronRight className="w-3 h-3" />
      </a>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="text-muted-foreground hover:text-foreground"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
};

export default ResumeOnboardingBanner;
