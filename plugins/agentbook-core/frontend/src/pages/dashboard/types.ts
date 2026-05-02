export interface NextMoment {
  kind: 'income' | 'tax' | 'rent' | 'recurring';
  label: string;
  amountCents: number;
  daysOut: number;
  sourceId?: string;
}

export interface AttentionItem {
  id: string;
  severity: 'critical' | 'warn' | 'info';
  title: string;
  subtitle?: string;
  amountCents?: number;
  action?: { label: string; href?: string; postEndpoint?: string };
}

export interface RecurringOutflow {
  vendor: string;
  amountCents: number;
  nextExpectedDate: string;
}

export interface OverviewPayload {
  cashToday: number;
  projection: { days: { date: string; cents: number }[]; moodLabel: 'healthy' | 'tight' | 'critical' } | null;
  nextMoments: NextMoment[];
  attention: AttentionItem[];
  recurringOutflows: RecurringOutflow[];
  monthMtd: { revenueCents: number; expenseCents: number; netCents: number } | null;
  monthPrev: { revenueCents: number; expenseCents: number; netCents: number } | null;
  isBrandNew: boolean;
}

export interface ActivityItem {
  id: string;
  kind: 'invoice_sent' | 'invoice_paid' | 'invoice_voided' | 'expense' | 'payment';
  label: string;
  amountCents: number;
  date: string;
  href?: string;
}

export interface AgentSummary {
  summary: string;
  generatedAt: string;
  source: 'llm' | 'fallback';
}
