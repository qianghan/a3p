/**
 * Mobile app (/app) shared contract — C1. Imported by the route handlers AND
 * by app/app/_lib/api.ts and the screens, so it must stay dependency-free.
 */
export type AlertSeverity = 'critical' | 'warn' | 'info';
export type AlertKind = 'invoice_overdue' | 'tax_deadline' | 'receipts_missing' | 'uncategorized' | 'review_needed' | 'bill_due';
export type MobileRoute = '/app' | '/app/docs' | '/app/capture' | '/app/chat' | `/app/docs/${string}`;

export interface MobileAlert {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  params: Record<string, string | number>;            // e.g. {client:'Acme', days:12, amountCents:180000, count:3}
  target?: { route: MobileRoute; query?: Record<string, string> };
  action?: { type: 'post'; endpoint: string; labelKey: string };   // endpoint is an /api/v1/... path
}
export interface MobileKpis {
  monthNetCents: number | null;       // month-to-date revenue - expenses
  cashTodayCents: number | null;
  outstandingCents: number;           // open invoice balance
  overdueCount: number;
  overdueCents: number;
  estTaxOwedCents: number | null;     // null when the jurisdiction has no estimate
}
export interface UpcomingItem {
  id: string;
  kind: 'tax' | 'calendar' | 'bill';
  titleKey: string;                    // i18n key
  params: Record<string, string | number>;
  date: string;                        // ISO date
  daysAway: number;
  amountCents: number | null;
}
export interface RecentItem {
  id: string;
  kind: 'expense' | 'invoice' | 'payment';
  label: string;
  amountCents: number;
  at: string;                          // ISO datetime
  docId?: string;                      // present for expenses → /app/docs/[docId]
}
export interface MobileHome {
  currency: string;                    // ISO 4217
  generatedAt: string;                 // ISO datetime
  isBrandNew: boolean;
  kpis: MobileKpis;
  alerts: MobileAlert[];               // ranked critical>warn>info, max 5
  nextUp: UpcomingItem[];              // max 3
  recent: RecentItem[];                // max 5
}

export type DocFilter = 'needs-review' | 'no-category' | 'no-receipt' | 'all' | 'archived';
export interface MobileDoc {
  id: string;
  date: string;                        // ISO date
  amountCents: number;
  vendorName: string | null;
  description: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categorySource: 'ai' | 'user' | 'rule' | null;
  confidence: number | null;           // 0..1
  status: 'confirmed' | 'pending_review' | 'rejected';
  isPersonal: boolean;
  receiptUrl: string | null;
  receiptStatus: 'pending' | 'attached' | 'skipped' | null;
  archivedAt: string | null;
  suggestion: { categoryId: string; categoryName: string; confidence: number } | null;  // pending AI suggestion
}
export interface DocCounts { needsReview: number; noCategory: number; noReceipt: number; archived: number }
export interface DocList { items: MobileDoc[]; nextCursor: string | null; counts: DocCounts | null }
export interface ExpenseCategory { id: string; name: string; code: string }
export interface ReviewItem { expenseId: string; action: 'accept' | 'reject'; categoryId?: string }
export interface ReviewResult { expenseId: string; ok: boolean; error?: string }
export interface FromReceiptResult { doc: MobileDoc; duplicate: boolean; ocr: { amountCents: number | null; vendor: string | null; date: string | null } }
