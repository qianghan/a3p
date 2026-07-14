/**
 * Shared entitlement guard for the Tax Fast-Track add-on. Mirrors
 * lib/agentbook-personal-insights/guard.ts's requirePersonalInsightsAddon()
 * exactly. Only the two routes that kick off new paid LLM/PDF/storage work
 * (/start, /regenerate) call this — /answer, /cancel, /status stay
 * ungated so a tenant who starts with an active subscription and then
 * lapses mid-questionnaire isn't blocked from finishing or viewing what
 * they already paid for.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { hasAddOn } from '@naap/billing';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const TAX_FAST_TRACK_ADDON_CODE = 'tax_fast_track';

export type TaxFastTrackGuard = { tenantId: string } | { response: NextResponse };

export async function requireTaxFastTrackAddon(request: NextRequest): Promise<TaxFastTrackGuard> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return { response: resolved.response };
  const { tenantId } = resolved;
  if (!(await hasAddOn(tenantId, TAX_FAST_TRACK_ADDON_CODE))) {
    return {
      response: NextResponse.json(
        { error: 'Tax Fast-Track is a paid add-on — enable it in Settings to start a filing draft review.' },
        { status: 402 },
      ),
    };
  }
  return { tenantId };
}
