/**
 * Pure AI-CPA review logic: turn a snapshot of books metrics into actionable
 * findings + a 0-100 health score. Jurisdiction-aware (US/CA/UK/AU). Kept pure
 * so it is deterministic and unit-testable; the route gathers the metrics.
 */

export interface ReviewMetrics {
  jurisdiction: string;
  uncategorizedExpenseCount: number;
  missingReceiptCount: number;
  overdueBillCount: number;
  overdueBillCents: number;
  effectiveTaxRate: number; // percent, e.g. 27.3
  netIncomeCents: number;
  estimatedTaxCents: number;
  cashOnHandCents: number;
  quarterlyTaxDueSoon: boolean; // a quarterly installment is due within 30 days
}

export type Severity = 'info' | 'warning' | 'critical';

export interface Finding {
  severity: Severity;
  category: string;
  title: string;
  detail: string;
  actionItem: string;
  autoFixable: boolean;
}

export interface ReviewResult {
  findings: Finding[];
  score: number; // 0-100
}

const SEVERITY_PENALTY: Record<Severity, number> = { info: 2, warning: 8, critical: 18 };

function taxFormName(jurisdiction: string): string {
  switch (jurisdiction) {
    case 'ca': return 'T2125';
    case 'uk': return 'SA103';
    case 'au': return 'business schedule';
    default: return 'Schedule C';
  }
}

export function runCpaReview(m: ReviewMetrics): ReviewResult {
  const findings: Finding[] = [];

  if (m.uncategorizedExpenseCount > 0) {
    findings.push({
      severity: m.uncategorizedExpenseCount > 10 ? 'warning' : 'info',
      category: 'bookkeeping',
      title: `${m.uncategorizedExpenseCount} uncategorized expense${m.uncategorizedExpenseCount === 1 ? '' : 's'}`,
      detail: `Uncategorized expenses can't be mapped to ${taxFormName(m.jurisdiction)} lines and may be missed deductions.`,
      actionItem: 'Categorize these so they flow to the right tax line.',
      autoFixable: true,
    });
  }

  if (m.missingReceiptCount > 0) {
    findings.push({
      severity: m.missingReceiptCount > 5 ? 'warning' : 'info',
      category: 'audit-readiness',
      title: `${m.missingReceiptCount} expense${m.missingReceiptCount === 1 ? '' : 's'} missing a receipt`,
      detail: 'Expenses without a receipt are weak under audit.',
      actionItem: 'Attach receipts (snap a photo via Telegram or the app).',
      autoFixable: false,
    });
  }

  if (m.overdueBillCount > 0) {
    findings.push({
      severity: 'warning',
      category: 'payables',
      title: `${m.overdueBillCount} overdue bill${m.overdueBillCount === 1 ? '' : 's'} (${(m.overdueBillCents / 100).toFixed(0)} owed)`,
      detail: 'Overdue payables can mean late fees and strained vendor relationships.',
      actionItem: 'Review and pay overdue bills, or renegotiate terms.',
      autoFixable: false,
    });
  }

  if (m.quarterlyTaxDueSoon) {
    findings.push({
      severity: 'critical',
      category: 'tax',
      title: 'Quarterly tax installment due soon',
      detail: 'A quarterly estimated tax payment is due within 30 days.',
      actionItem: 'Set aside the estimated amount and pay before the deadline.',
      autoFixable: false,
    });
  }

  // Cash runway vs known tax liability.
  if (m.estimatedTaxCents > 0 && m.cashOnHandCents < m.estimatedTaxCents) {
    findings.push({
      severity: 'critical',
      category: 'cash-flow',
      title: 'Cash on hand is below your estimated tax bill',
      detail: `Estimated tax owed is ${(m.estimatedTaxCents / 100).toFixed(0)} but cash on hand is ${(m.cashOnHandCents / 100).toFixed(0)}.`,
      actionItem: 'Build a tax reserve so the bill is covered when due.',
      autoFixable: false,
    });
  }

  if (m.effectiveTaxRate > 35) {
    findings.push({
      severity: 'info',
      category: 'tax-planning',
      title: `High effective tax rate (${m.effectiveTaxRate.toFixed(1)}%)`,
      detail: 'There may be unclaimed deductions or a more efficient structure.',
      actionItem: 'Review deductions and discuss entity structure with your accountant.',
      autoFixable: false,
    });
  }

  if (findings.length === 0) {
    findings.push({
      severity: 'info',
      category: 'clean',
      title: 'Books look healthy',
      detail: 'No issues found in this review.',
      actionItem: 'Keep recording expenses and receipts as you go.',
      autoFixable: false,
    });
  }

  const penalty = findings.reduce((s, f) => s + SEVERITY_PENALTY[f.severity], 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));

  return { findings, score };
}
