/**
 * Proactive money-moves — three deterministic suggestions:
 *   1. Cash cushion thin (< 2 months runway)
 *   2. Revenue concentration risk (one client > 50% of billed)
 *   3. Tax-bracket proximity (within $5k of jumping to next bracket)
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { usTaxBrackets } from '@agentbook/jurisdictions/us/tax-brackets';
import { caTaxBrackets } from '@agentbook/jurisdictions/ca/tax-brackets';
import { auTaxBrackets } from '@agentbook/jurisdictions/au/tax-brackets';
import type { TaxBracketProvider } from '@agentbook/jurisdictions/interfaces';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Move {
  type: string;
  urgency: 'critical' | 'important' | 'informational';
  title: string;
  description: string;
  impactCents: number;
}

// Real, tested jurisdiction-pack bracket data — replaces two previously
// hand-duplicated, drifted local arrays (the old inline US_BRACKETS was
// missing the top two real federal brackets, 32%/35%/37%, compared to the
// actual usTaxBrackets provider) and adds Australia, which this route never
// supported at all.
const BRACKET_PROVIDERS: Record<string, TaxBracketProvider> = {
  us: usTaxBrackets,
  ca: caTaxBrackets,
  au: auTaxBrackets,
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const moves: Move[] = [];

    const cash = await db.abAccount.findFirst({ where: { tenantId, code: '1000' } });
    if (cash) {
      const lines = await db.abJournalLine.findMany({
        where: { accountId: cash.id, entry: { tenantId } },
      });
      const balance = lines.reduce((s, l) => s + l.debitCents - l.creditCents, 0);
      const threeMonthsAgo = new Date(Date.now() - 90 * 86_400_000);
      const expenses = await db.abExpense.aggregate({
        where: { tenantId, isPersonal: false, date: { gte: threeMonthsAgo } },
        _sum: { amountCents: true },
      });
      const monthlyExp = (expenses._sum.amountCents || 0) / 3;
      if (monthlyExp > 0 && balance / monthlyExp < 2) {
        moves.push({
          type: 'cash_cushion',
          urgency: balance / monthlyExp < 1 ? 'critical' : 'important',
          title: 'Cash cushion thin',
          description: `${(balance / monthlyExp).toFixed(1)} months runway`,
          impactCents: Math.round(monthlyExp * 3 - balance),
        });
      }
    }

    const clients = await db.abClient.findMany({ where: { tenantId } });
    const totalRev = clients.reduce((s, c) => s + c.totalBilledCents, 0);
    if (totalRev > 0) {
      const top = [...clients].sort((a, b) => b.totalBilledCents - a.totalBilledCents)[0];
      if (top && top.totalBilledCents / totalRev > 0.5) {
        moves.push({
          type: 'revenue_cliff',
          urgency: 'important',
          title: `${top.name} = ${Math.round((top.totalBilledCents / totalRev) * 100)}% of revenue`,
          description: 'Diversification recommended',
          impactCents: top.totalBilledCents,
        });
      }
    }

    const config = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    const estimate = await db.abTaxEstimate.findFirst({
      where: { tenantId },
      orderBy: { calculatedAt: 'desc' },
    });
    if (estimate && estimate.netIncomeCents > 0) {
      const jurisdiction = config?.jurisdiction || 'us';
      const provider = BRACKET_PROVIDERS[jurisdiction] ?? usTaxBrackets;
      const brackets = provider.getTaxBrackets(new Date().getFullYear());
      for (let i = 0; i < brackets.length - 1; i++) {
        const b = brackets[i];
        if (b.max && estimate.netIncomeCents > b.min && estimate.netIncomeCents < b.max) {
          const gap = b.max - estimate.netIncomeCents;
          if (gap < 500_000 && gap > 0) {
            const nextRate = brackets[i + 1].rate;
            const savings = Math.round(gap * (nextRate - b.rate));
            moves.push({
              type: 'optimal_timing',
              urgency: 'informational',
              title: `$${(gap / 100).toFixed(0)} from next tax bracket`,
              description: `Prepay $${(gap / 100).toFixed(0)} in deductible expenses before year-end to stay in the ${(b.rate * 100).toFixed(0)}% bracket and save ~$${(savings / 100).toFixed(0)}.`,
              impactCents: savings,
            });
            break;
          }
        }
      }
    }

    return NextResponse.json({ success: true, data: moves });
  } catch (err) {
    console.error('[agentbook-core/money-moves] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
