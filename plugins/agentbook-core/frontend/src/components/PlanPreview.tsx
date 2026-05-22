import React from 'react';
import { CheckCircle, XCircle } from 'lucide-react';

export interface PlanStep {
  skill?: string;
  description: string;
}

interface PlanPreviewProps {
  steps: PlanStep[];
  onProceed: () => void;
  onCancel: () => void;
  disabled?: boolean;
}

/**
 * Inline preview of a destructive-action plan returned by the agent brain.
 *
 * The Proceed / Cancel buttons mirror the Telegram inline-keyboard pattern in
 * apps/web-next/.../telegram/webhook/route.ts. Closes G-012 — the third and
 * final auto-fail clause from the 2026-05-21 rubric gap report.
 */
export const PlanPreview: React.FC<PlanPreviewProps> = ({
  steps,
  onProceed,
  onCancel,
  disabled,
}) => (
  <div className="mt-2 border border-border rounded-lg p-3 bg-muted/30">
    <div className="text-xs font-medium text-muted-foreground mb-2">
      I&apos;d like to do this:
    </div>
    <ol className="space-y-1 mb-3">
      {steps.map((step, i) => (
        <li key={i} className="text-sm">
          <span className="font-medium text-muted-foreground mr-2">{i + 1}.</span>
          {step.description}
        </li>
      ))}
    </ol>
    <div className="flex gap-2">
      <button
        type="button"
        onClick={onProceed}
        disabled={disabled}
        className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-50"
      >
        <CheckCircle className="w-4 h-4" />
        Proceed
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={disabled}
        className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium border border-border rounded-md hover:bg-muted disabled:opacity-50"
      >
        <XCircle className="w-4 h-4" />
        Cancel
      </button>
    </div>
  </div>
);
