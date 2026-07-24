/**
 * Bank-sync is a paid feature. The Free plan carries a `bank_connections`
 * quota of 0, so `checkQuota` denies it; Pro (3) and Business (unlimited, -1)
 * pass. This guard folds tenant resolution + the quota check into one call so
 * the Plaid/Basiq connect entry points can't be hit by a free-plan tenant
 * (or directly, bypassing the UI). Modeled on requireStudentAddon /
 * requirePersonalInsightsAddon.
 *
 * Fail-closed: on a DB error `checkQuota` returns { allowed:false,
 * retryable:true } → we surface 503 (transient) rather than 402 (upgrade), so
 * a paying customer isn't told to upgrade because of an outage.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { checkQuota } from '@naap/billing';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export type BankGuard = { tenantId: string } | { response: NextResponse };

export async function requireBankConnectionQuota(request: NextRequest): Promise<BankGuard> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return { response: resolved.response };
  const { tenantId } = resolved;

  const q = await checkQuota(tenantId, 'bank_connections');
  if (!q.allowed) {
    const retryable = q.retryable === true;
    return {
      response: NextResponse.json(
        {
          success: false,
          error: retryable
            ? "We couldn't verify your plan just now — please try again in a moment."
            : 'Bank sync is a paid feature. Upgrade to Pro or Business to connect a bank account.',
          upgradeUrl: '/billing',
        },
        { status: retryable ? 503 : 402 },
      ),
    };
  }
  return { tenantId };
}
