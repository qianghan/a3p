import React, { useState } from 'react';
import { ShieldAlert, ShieldCheck, ShieldQuestion, ExternalLink, Loader2 } from 'lucide-react';
import { startupApi, type StartupBenefitApplication, type StartupBenefitAuditReview, type AuditFinding, type ProgramInfo } from '../lib/api';

const RISK_STYLE: Record<'low' | 'medium' | 'high', string> = {
  low: 'bg-green-500/10 text-green-600 border-green-500/20',
  medium: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  high: 'bg-red-500/10 text-red-600 border-red-500/20',
};

const RISK_ICON: Record<'low' | 'medium' | 'high', React.ComponentType<{ className?: string }>> = {
  low: ShieldCheck,
  medium: ShieldQuestion,
  high: ShieldAlert,
};

function FindingRow({
  finding, index, alreadyOverridden, onOverride, submitting,
}: {
  finding: AuditFinding;
  index: number;
  alreadyOverridden: boolean;
  onOverride: (index: number, reason: string) => void;
  submitting: boolean;
}) {
  const [reason, setReason] = useState('');
  const requiresReason = finding.severity === 'high';
  return (
    <div className="border border-border rounded-lg p-3 mb-2">
      <div className="flex items-center gap-2 mb-1">
        <span className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full border ${RISK_STYLE[finding.severity]}`}>
          {finding.severity}
        </span>
        {alreadyOverridden && <span className="text-xs text-muted-foreground">Overridden</span>}
      </div>
      <p className="text-sm text-foreground">{finding.issue}</p>
      <p className="text-sm text-muted-foreground mt-1">{finding.recommendation}</p>
      {!alreadyOverridden && (
        <div className="mt-2 flex items-center gap-2">
          {requiresReason && (
            <>
              <label htmlFor={`override-reason-${index}`} className="sr-only">Reason for overriding this finding</label>
              <input
                id={`override-reason-${index}`}
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason for overriding this finding"
                className="flex-1 px-3 py-1.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </>
          )}
          <button
            type="button"
            disabled={submitting || (requiresReason && !reason.trim())}
            onClick={() => onOverride(index, reason.trim())}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-background border border-border rounded-lg text-xs font-medium hover:bg-muted/50 transition-colors disabled:opacity-50 shrink-0"
          >
            Override
          </button>
        </div>
      )}
    </div>
  );
}

export function AuditReviewSection({
  application, auditReview, program, onChange,
}: {
  application: StartupBenefitApplication;
  auditReview: StartupBenefitAuditReview | null;
  program: ProgramInfo | null;
  onChange: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [overridingIndex, setOverridingIndex] = useState<number | null>(null);

  async function handleRun() {
    setRunning(true);
    try {
      await startupApi.runAuditReview(application.id);
      onChange();
    } finally {
      setRunning(false);
    }
  }

  async function handleOverride(findingIndex: number, reason: string) {
    setOverridingIndex(findingIndex);
    try {
      await startupApi.overrideAuditFinding(application.id, findingIndex, reason || undefined);
      onChange();
    } finally {
      setOverridingIndex(null);
    }
  }

  if (application.status !== 'ready_for_review' && application.status !== 'audit_reviewed') {
    return null;
  }

  if (!auditReview) {
    return (
      <div className="mb-6">
        <h2 className="text-sm font-semibold text-foreground mb-2">Audit review</h2>
        <button
          type="button"
          disabled={running}
          onClick={handleRun}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldQuestion className="w-4 h-4" />}
          Run audit review
        </button>
      </div>
    );
  }

  const RiskIcon = RISK_ICON[auditReview.riskLevel];
  const overriddenIndexes = new Set(auditReview.overrides.map((o) => o.findingIndex));

  return (
    <div className="mb-6">
      <h2 className="text-sm font-semibold text-foreground mb-2 flex items-center gap-1.5">
        <RiskIcon className="w-4 h-4" /> Audit review
        <span className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full border ${RISK_STYLE[auditReview.riskLevel]}`}>
          {auditReview.riskLevel} risk
        </span>
      </h2>
      {auditReview.findings.length === 0 ? (
        <p className="text-sm text-muted-foreground">No findings — this draft looks well-substantiated.</p>
      ) : (
        auditReview.findings.map((finding, i) => (
          <FindingRow
            key={i}
            finding={finding}
            index={i}
            alreadyOverridden={overriddenIndexes.has(i)}
            onOverride={handleOverride}
            submitting={overridingIndex === i}
          />
        ))
      )}
      {program && (
        <a
          href={program.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-1"
        >
          Learn more <ExternalLink className="w-3 h-3" />
        </a>
      )}
    </div>
  );
}
