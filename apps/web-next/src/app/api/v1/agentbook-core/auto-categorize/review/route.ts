/**
 * POST /api/v1/agentbook-core/auto-categorize/review
 *
 * Bulk accept / reject of the auto-categorizer's pending suggestions (mobile
 * "Review AI picks"). Accept runs the SAME categorize path as the desktop row
 * picker (lib/agentbook-categorize-expense.ts): category, journal backfill,
 * vendor learning. Reject only drops the suggestion. Ids that are not this
 * tenant's live expenses are reported per item, never acted on.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { getPendingSuggestions, dropPendingSuggestion, type PendingSuggestion } from '@/lib/agentbook-auto-categorize';
import { categorizeExpense } from '@/lib/agentbook-categorize-expense';
import { publicErrorMessage } from '@/lib/api-error';
import type { ReviewItem, ReviewResult } from '@/lib/mobile/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_ITEMS = 50;
const ACTIONS = new Set(['accept', 'reject']);

function parseItems(body: unknown): ReviewItem[] | string {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || items.length === 0) return 'items must be a non-empty array';
  if (items.length > MAX_ITEMS) return `at most ${MAX_ITEMS} items per request`;
  const out: ReviewItem[] = [];
  for (const raw of items) {
    const it = raw as { expenseId?: unknown; action?: unknown; categoryId?: unknown } | null;
    if (!it || typeof it.expenseId !== 'string' || !it.expenseId || typeof it.action !== 'string' || !ACTIONS.has(it.action)) {
      return 'each item needs an expenseId and an action of accept or reject';
    }
    if (it.categoryId !== undefined && (typeof it.categoryId !== 'string' || !it.categoryId)) {
      return 'categoryId must be a non-empty string';
    }
    out.push({
      expenseId: it.expenseId,
      action: it.action as ReviewItem['action'],
      ...(typeof it.categoryId === 'string' ? { categoryId: it.categoryId } : {}),
    });
  }
  return out;
}

async function reviewOne(
  tenantId: string,
  item: ReviewItem,
  pending: Map<string, PendingSuggestion>,
): Promise<ReviewResult> {
  const expense = await db.abExpense.findFirst({
    where: { id: item.expenseId, tenantId, deletedAt: null },
    select: { id: true },
  });
  if (!expense) return { expenseId: item.expenseId, ok: false, error: 'not_found' };

  const suggestion = pending.get(item.expenseId);

  if (item.action === 'reject') {
    if (suggestion) {
      await dropPendingSuggestion(tenantId, item.expenseId);
      pending.delete(item.expenseId);
    }
    return { expenseId: item.expenseId, ok: true };
  }

  const categoryId = item.categoryId ?? suggestion?.suggestedCategoryId;
  if (!categoryId) return { expenseId: item.expenseId, ok: false, error: 'no_suggestion' };

  // The categorize route trusts its caller's categoryId; this bulk path does
  // not: only this tenant's active expense accounts are accepted.
  const category = await db.abAccount.findFirst({
    where: { id: categoryId, tenantId, accountType: 'expense', isActive: true },
    select: { id: true },
  });
  if (!category) return { expenseId: item.expenseId, ok: false, error: 'invalid_category' };

  const source = suggestion && categoryId === suggestion.suggestedCategoryId ? 'agent_confirmed' : 'user_corrected';
  const outcome = await categorizeExpense(tenantId, item.expenseId, { categoryId, source });
  if (!outcome.ok) {
    return { expenseId: item.expenseId, ok: false, error: outcome.status === 404 ? 'not_found' : 'failed' };
  }
  if (suggestion) {
    await dropPendingSuggestion(tenantId, item.expenseId);
    pending.delete(item.expenseId);
  }
  return { expenseId: item.expenseId, ok: true };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const body = await request.json().catch(() => null);
    const items = parseItems(body);
    if (typeof items === 'string') {
      return NextResponse.json({ success: false, error: items }, { status: 400 });
    }

    const pending = new Map((await getPendingSuggestions(tenantId)).map((p) => [p.expenseId, p]));
    const results: ReviewResult[] = [];
    // Sequential on purpose: the pending list is one JSON row, and parallel
    // drops would overwrite each other.
    for (const item of items) {
      try {
        results.push(await reviewOne(tenantId, item, pending));
      } catch (err) {
        console.error('[auto-categorize/review] item failed:', err);
        results.push({ expenseId: item.expenseId, ok: false, error: 'failed' });
      }
    }

    return NextResponse.json({ success: true, data: { results } });
  } catch (err) {
    console.error('[auto-categorize/review] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}
