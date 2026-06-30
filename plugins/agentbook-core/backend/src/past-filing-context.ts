import { db } from './db/client.js';

/** A confirmed past filing's stored extract (universal StandardTaxExtract fields). */
function fmt(cents?: number | null): string {
  if (cents == null) return 'n/a';
  return '$' + Math.round(cents / 100).toLocaleString();
}

/**
 * Build an LLM-ready multi-year tax-history summary from the tenant's
 * CONFIRMED past filings. Returns '' when there are none (additive: callers
 * append only when non-empty, so behavior is unchanged for users with no
 * uploads). Pure DB read — no HTTP self-call.
 */
export async function buildPastFilingContext(tenantId: string, yearsBack = 3): Promise<string> {
  const filings = await db.abPastTaxFiling.findMany({
    where: { tenantId, status: 'confirmed' },
    orderBy: { taxYear: 'desc' },
    take: yearsBack * 4,
  });
  if (filings.length === 0) return '';

  const lines: string[] = ['## Tax History (reference only — do not share raw numbers unless asked)', ''];
  for (const f of filings) {
    const d: any = f.extractedData || {};
    const region = f.region ? `${f.jurisdiction.toUpperCase()} / ${f.region}` : f.jurisdiction.toUpperCase();
    lines.push(`${f.taxYear} (${region}) [${f.formType}]:`);
    lines.push(`  Total income: ${fmt(d.totalIncomeCents)} | Net: ${fmt(d.netIncomeCents)} | Tax payable: ${fmt(d.taxPayableCents)}`);
    if (d.refundOrBalanceCents != null) {
      lines.push(d.refundOrBalanceCents >= 0
        ? `  Refund: ${fmt(d.refundOrBalanceCents)}`
        : `  Balance owing: ${fmt(-d.refundOrBalanceCents)}`);
    }
    if (d.savingsRoomCents != null) lines.push(`  Savings/RRSP room: ${fmt(d.savingsRoomCents)}`);
    lines.push(`  Source: confirmed ${f.formType} upload (confidence ${Math.round((f.confidence || 0) * 100)}%)`);
  }
  return lines.join('\n');
}

/** Lightweight list for the chat skill (download links built by caller). */
export async function listPastFilingsForTenant(tenantId: string) {
  return db.abPastTaxFiling.findMany({
    where: { tenantId },
    orderBy: [{ taxYear: 'desc' }, { createdAt: 'desc' }],
  });
}
