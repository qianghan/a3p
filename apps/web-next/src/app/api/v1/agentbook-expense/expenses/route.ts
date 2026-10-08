/**
 * Expense list + create — native Next.js route.
 *
 * GET: list with filters (status, vendor, date range, isPersonal).
 * POST: create with vendor upsert, learned-category pattern lookup,
 * and double-entry journal posting in a single transaction. Mirrors
 * the legacy plugin Express handler so the record-expense agent skill
 * works end-to-end.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { audit } from '@/lib/agentbook-audit';
import { inferSource, inferActor } from '@/lib/agentbook-audit-context';
import { withSoftDelete, parseIncludeDeleted } from '@/lib/agentbook-soft-delete';
import { withHttpIdempotency } from '@/lib/agentbook-idempotency';
import { ensureChartOfAccounts, ensureUncategorizedAccount } from '@/lib/agentbook-chart-of-accounts';
import { publicErrorMessage } from '@/lib/api-error';
import { autoCategorizeForTenant, getPendingSuggestions } from '@/lib/agentbook-auto-categorize';
import { parseExpenseListQuery, encodeCursor, countDocFilters } from '@/lib/agentbook-expense-list-query';
import { deriveCategorySource, suggestionFromPending } from '@/lib/mobile/doc-mapper';
import type { Prisma } from '@naap/database';

/**
 * Mirrors the legacy Express handler's `checkAndAutoCategorize` — which
 * never actually ran in production. `/api/v1/agentbook-expense` resolves to
 * this Next.js route in prod (AGENTBOOK_EXPENSE_URL is unset), not the
 * Express plugin backend, so that function was dead code: every expense
 * created there never triggered a proactive categorization run. A tenant
 * whose only expense landed uncategorized had no automatic path to get it
 * categorized — only the 6-hourly watchdog cron
 * (auto-categorize-watchdog/route.ts) could eventually reach it.
 *
 * Calls autoCategorizeForTenant directly rather than the Express version's
 * self-HTTP-fetch (which existed only because Express and Next.js are
 * separate processes there) — we're already inside the Next.js process, so
 * a direct call avoids the fetch, the x-internal-cron header, and the
 * CRON_SECRET round-trip entirely.
 */
export async function checkAndAutoCategorize(tenantId: string): Promise<void> {
  try {
    const [total, uncategorized] = await Promise.all([
      db.abExpense.count({ where: { tenantId, isPersonal: false } }),
      db.abExpense.count({
        where: { tenantId, isPersonal: false, categoryId: null, status: { in: ['pending_review', 'confirmed'] } },
      }),
    ]);
    if (total === 0 || uncategorized / total <= 0.10) return;
    await autoCategorizeForTenant(tenantId);
  } catch (err) {
    console.warn('[agentbook-expense/expenses] checkAndAutoCategorize failed (best-effort):', err instanceof Error ? err.message : err);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function normalizeVendorName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

interface CreateExpenseBody {
  amountCents?: number;
  vendor?: string;
  categoryId?: string;
  date?: string;
  description?: string;
  receiptUrl?: string;
  confidence?: number;
  isPersonal?: boolean;
  taxAmountCents?: number;
  tipAmountCents?: number;
  paymentMethod?: string;
  currency?: string;
  notes?: string;
  tags?: string;
  isBillable?: boolean;
  clientId?: string;
  source?: string;
  status?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;
  const auditSource = inferSource(request);
  const auditActor = await inferActor(request);

  return withHttpIdempotency(request, {
    tenantId,
    endpoint: 'POST /api/v1/agentbook-expense/expenses',
    handler: async (rawBody) => {
      try {
        let body: CreateExpenseBody = {};
        try {
          body = rawBody ? (JSON.parse(rawBody) as CreateExpenseBody) : {};
        } catch {
          body = {};
        }
        const {
          amountCents, vendor, categoryId, date, description, receiptUrl, confidence, isPersonal,
          taxAmountCents, tipAmountCents, paymentMethod, currency, notes, tags, isBillable, clientId, source, status,
        } = body;

        if (!amountCents || amountCents <= 0) {
          return { status: 400, body: { success: false, error: 'amountCents must be a positive integer' } };
        }

        let vendorRecord: { id: string; defaultCategoryId: string | null; normalizedName: string } | null = null;
        if (vendor) {
          const normalized = normalizeVendorName(vendor);
          if (normalized) {
            vendorRecord = await db.abVendor.upsert({
              where: { tenantId_normalizedName: { tenantId, normalizedName: normalized } },
              update: { transactionCount: { increment: 1 }, lastSeen: new Date() },
              create: {
                tenantId,
                name: vendor,
                normalizedName: normalized,
                defaultCategoryId: categoryId || null,
              },
              select: { id: true, defaultCategoryId: true, normalizedName: true },
            });
          }
        }

        // Guarantee the chart of accounts BEFORE resolving a category — and
        // unconditionally, not only when a category is already known. A tenant
        // who skipped onboarding has ZERO accounts, so there is nothing to
        // categorize into: resolvedCategoryId would stay null, no journal would
        // post, and a category-gated seed would never fire. Seeding first means
        // this expense (and every later categorization / auto-categorization)
        // has real accounts to book against. Cheap no-op once seeded, and it
        // runs its own transaction so it must stay outside the one below.
        if (!isPersonal) {
          await ensureChartOfAccounts(tenantId);
        }

        let resolvedCategoryId: string | null = categoryId ?? null;
        let resolvedConfidence: number | null = confidence ?? null;
        if (!resolvedCategoryId && vendorRecord) {
          const pattern = await db.abPattern.findUnique({
            where: { tenantId_vendorPattern: { tenantId, vendorPattern: vendorRecord.normalizedName } },
          });
          if (pattern) {
            // Verify the remembered category still exists before trusting it.
            //
            // AbPattern.categoryId is a bare String with no relation, so nothing
            // at the database level stops it outliving the account it names.
            // AbJournalLine.accountId DOES have a real foreign key — so a stale
            // pattern did not degrade categorisation, it made the whole write
            // explode: the user got
            //   "I couldn't record that expense. Error: Invalid
            //    `prisma.abJournalEntry.create()` invocation: Foreign key
            //    constraint violated: AbJournalLine_accountId_fkey"
            // and no expense at all. Recording an expense is the most basic
            // thing this product does; a remembered preference must never be
            // able to take it down.
            //
            // Scoped by tenantId as well as id: a pattern must not be able to
            // point at another tenant's account.
            const category = await db.abAccount.findFirst({
              where: { id: pattern.categoryId, tenantId },
              select: { id: true },
            });
            if (category) {
              resolvedCategoryId = pattern.categoryId;
              resolvedConfidence = pattern.confidence;
              await db.abPattern.update({
                where: { id: pattern.id },
                data: { usageCount: { increment: 1 }, lastUsed: new Date() },
              });
            } else {
              // Drop the dangling pattern rather than letting it fail every
              // future expense for this vendor. Categorisation falls back to
              // uncategorised, which the user can correct — and that correction
              // relearns the pattern against a live account.
              console.warn(
                `[expenses] pattern ${pattern.id} referenced missing account ${pattern.categoryId}; removing`,
              );
              await db.abPattern.delete({ where: { id: pattern.id } }).catch(() => {});
            }
          }
        }

        // Where the debit lands. A business expense ALWAYS posts: when no
        // category resolved, it goes to the suspense account rather than
        // silently skipping the ledger. Gating the journal on a resolved
        // category is what made an uncategorized expense invisible to the P&L,
        // the trial balance and the tax estimate while still showing in the
        // user's list as "confirmed" — and invisible to the review queue too,
        // so nothing anywhere asked them to fix it. The cash left their bank
        // regardless; the books have to agree.
        //
        // Note this does NOT set expense.categoryId — see below.
        // Runs its own upsert, so like ensureChartOfAccounts it stays outside
        // the transaction opened below.
        let debitAccountId: string | null = resolvedCategoryId;
        if (!debitAccountId && !isPersonal) {
          debitAccountId = (await ensureUncategorizedAccount(tenantId)).id;
        }

        const expense = await db.$transaction(async (tx) => {
          let journalEntryId: string | null = null;
          if (debitAccountId && !isPersonal) {
            const cashAccount = await tx.abAccount.findFirst({ where: { tenantId, code: '1000' } });
            if (cashAccount) {
              const je = await tx.abJournalEntry.create({
                data: {
                  tenantId,
                  date: new Date(date || Date.now()),
                  memo: `Expense: ${description || vendor || 'Expense'}`,
                  sourceType: 'expense',
                  verified: true,
                  lines: {
                    create: [
                      { tenantId, accountId: debitAccountId, debitCents: amountCents, creditCents: 0, description: description || vendor || 'Expense' }, // G-009
                      { tenantId, accountId: cashAccount.id, debitCents: 0, creditCents: amountCents, description: `Payment: ${vendor || 'Expense'}` }, // G-009
                    ],
                  },
                },
              });
              journalEntryId = je.id;
            }
          }

          const exp = await tx.abExpense.create({
            data: {
              tenantId,
              amountCents,
              taxAmountCents: taxAmountCents || 0,
              tipAmountCents: tipAmountCents || 0,
              vendorId: vendorRecord?.id,
              // resolvedCategoryId, NOT debitAccountId — a suspense posting is
              // bookkeeping, not classification. The auto-categorize watchdog,
              // the catch-up summary and the "Uncategorized" reports all key
              // off categoryId === null; stamping 6999 here would hide the
              // expense from every prompt to actually classify it.
              categoryId: resolvedCategoryId,
              date: new Date(date || Date.now()),
              description: description || vendor || 'Expense',
              notes: notes || null,
              receiptUrl,
              paymentMethod: paymentMethod || 'unknown',
              currency: currency || 'USD',
              tags: tags || null,
              confidence: resolvedConfidence,
              isPersonal: isPersonal || false,
              isBillable: isBillable || false,
              clientId: clientId || null,
              journalEntryId,
              ...(source ? { source } : {}),
              ...(status ? { status } : {}),
            },
            include: { vendor: true },
          });

          await tx.abEvent.create({
            data: {
              tenantId,
              eventType: 'expense.recorded',
              actor: 'agent',
              action: {
                expense_id: exp.id,
                amountCents,
                vendor: vendor || null,
                categoryId: resolvedCategoryId,
                isPersonal: isPersonal || false,
                hasReceipt: !!receiptUrl,
              },
            },
          });

          return exp;
        });

        await audit({
          tenantId,
          source: auditSource,
          actor: auditActor,
          action: 'expense.create',
          entityType: 'AbExpense',
          entityId: expense.id,
          after: {
            amountCents,
            vendorId: expense.vendorId,
            vendorName: vendor || null,
            categoryId: resolvedCategoryId,
            date: expense.date,
            description: expense.description,
            isPersonal: expense.isPersonal,
            hasReceipt: !!receiptUrl,
          },
        });

        await checkAndAutoCategorize(tenantId);

        return {
          status: 201,
          body: {
            success: true,
            data: expense,
            meta: {
              vendor: vendorRecord,
              categoryFromPattern: !categoryId && !!resolvedCategoryId,
              confidence: resolvedConfidence,
            },
          },
        };
      } catch (err) {
        console.error('[agentbook-expense/expenses POST] failed:', err);
        return {
          status: 500,
          body: { success: false, error: publicErrorMessage(err) },
        };
      }
    },
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const params = request.nextUrl.searchParams;

    // Legacy params keep their meaning; mobile PR 1 adds status, hasReceipt,
    // categoryId, archived (archived rows hidden by default), q, cursor and
    // withCounts — see lib/agentbook-expense-list-query.ts.
    const parsed = parseExpenseListQuery(params, tenantId);
    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
    }
    const { limit, offset, withCounts } = parsed;
    const includeDeleted = parseIncludeDeleted(params);
    const where = withSoftDelete(parsed.where as Record<string, unknown>, includeDeleted) as Prisma.AbExpenseWhereInput;
    // `total` is the whole filtered list, so it must not include the cursor's
    // keyset clause (that would shrink it on every page after the first).
    const countWhere = withSoftDelete(parsed.countWhere as Record<string, unknown>, includeDeleted) as Prisma.AbExpenseWhereInput;

    const [rows, total, counts] = await Promise.all([
      db.abExpense.findMany({
        where,
        include: { vendor: { select: { id: true, name: true, normalizedName: true } } },
        // `id` breaks date ties so cursor pages never skip or repeat a row.
        orderBy: [{ date: 'desc' }, { id: 'desc' }],
        // One extra row tells us whether another page exists; it is not returned.
        take: limit + 1,
        skip: offset,
      }),
      db.abExpense.count({ where: countWhere }),
      withCounts ? countDocFilters(tenantId) : Promise.resolve(null),
    ]);
    const hasMore = rows.length > limit;
    const expenses = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? encodeCursor(expenses[expenses.length - 1]) : null;

    // The suggestion is decoration on an uncategorized row: read the pending
    // batch only when this page has one, and never let its failure 500 the list.
    const pending = expenses.some((e) => !e.categoryId)
      ? await getPendingSuggestions(tenantId).catch((err) => {
          console.warn('[agentbook-expense/expenses GET] pending suggestions unavailable:', err instanceof Error ? err.message : err);
          return [];
        })
      : [];

    const categoryIds = [...new Set(expenses.map((e) => e.categoryId).filter((id): id is string => Boolean(id)))];
    const categories = categoryIds.length > 0
      ? await db.abAccount.findMany({
          where: { id: { in: categoryIds }, tenantId },
          select: { id: true, name: true, code: true },
        })
      : [];
    const categoryMap = Object.fromEntries(categories.map((c) => [c.id, { name: c.name, code: c.code }]));
    const suggestionByExpense = new Map(pending.map((p) => [p.expenseId, p]));

    const enriched = expenses.map((e) => ({
      ...e,
      vendorName: e.vendor?.name || null,
      categoryName: e.categoryId ? categoryMap[e.categoryId]?.name || null : null,
      categoryCode: e.categoryId ? categoryMap[e.categoryId]?.code || null : null,
      categorySource: deriveCategorySource(e),
      suggestion: e.categoryId ? null : suggestionFromPending(suggestionByExpense.get(e.id)),
    }));

    return NextResponse.json({
      success: true,
      data: enriched,
      meta: { total, limit, offset, nextCursor, ...(counts ? { counts } : {}) },
    });
  } catch (err) {
    console.error('[agentbook-expense/expenses GET] failed:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
}
