/**
 * Category suggestion at ENTRY time — the other half of one-step entry.
 *
 * Until now a manually entered expense had no category field: it was saved
 * uncategorized (booked to 6999 suspense) and categorized in a second step,
 * by the user or hours later by the auto-categorizer. This answers the
 * question while the form is still open, so the entry can be saved once, on
 * its real category.
 *
 * Order (each step is cheaper and more trustworthy than the next):
 *   1. the vendor's remembered default      — 0.95, what the user chose last time
 *   2. a learned vendor pattern             — its own confidence
 *   3. one AI classification                — only if memory has nothing; below
 *                                             MIN_AI_CONFIDENCE it says nothing
 * A suggestion never names an account that is not a live expense category of
 * THIS tenant, and never the 6999 suspense account (a bookkeeping holding pen,
 * not a classification).
 */
import 'server-only';
import { prisma as db } from '@naap/database';
import { classifyExpenseWithGemini, type CategoryRow } from '@/lib/agentbook-auto-categorize';
import { UNCATEGORIZED_CODE } from '@/lib/agentbook-chart-of-accounts';

export const MIN_AI_CONFIDENCE = 0.55;
export const REMEMBERED_CONFIDENCE = 0.95;

export type SuggestionSource = 'vendor' | 'pattern' | 'ai';
export interface CategorySuggestion {
  categoryId: string;
  categoryName: string;
  confidence: number;
  source: SuggestionSource;
}
export interface SuggestInput { vendor?: string | null; description?: string | null; amountCents?: number }

/** Same normalisation as the expense create route and the auto-categorizer (they key AbVendor/AbPattern on it). */
export const normalizeVendor = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '').trim();

/** The tenant's categories a human or the AI may pick: live expense accounts, never suspense. */
async function liveCategories(tenantId: string): Promise<CategoryRow[]> {
  const rows = await db.abAccount.findMany({
    where: { tenantId, accountType: 'expense', isActive: true },
    select: { id: true, name: true, code: true, taxCategory: true },
    orderBy: { code: 'asc' },
  });
  return (rows as CategoryRow[]).filter((c) => c.code !== UNCATEGORIZED_CODE);
}

export async function suggestCategory(tenantId: string, input: SuggestInput): Promise<CategorySuggestion | null> {
  const vendor = (input.vendor ?? '').trim();
  const description = (input.description ?? '').trim();
  if (!vendor && !description) return null;

  const cats = await liveCategories(tenantId);
  const byId = new Map(cats.map((c) => [c.id, c]));
  const hit = (id: string | null | undefined, confidence: number, source: SuggestionSource): CategorySuggestion | null => {
    const c = id ? byId.get(id) : undefined;
    return c ? { categoryId: c.id, categoryName: c.name, confidence, source } : null;
  };

  const normalized = vendor ? normalizeVendor(vendor) : '';
  if (normalized) {
    const v = await db.abVendor.findUnique({ where: { tenantId_normalizedName: { tenantId, normalizedName: normalized } } });
    const fromVendor = hit(v?.defaultCategoryId, REMEMBERED_CONFIDENCE, 'vendor');
    if (fromVendor) return fromVendor;
    const p = await db.abPattern.findUnique({ where: { tenantId_vendorPattern: { tenantId, vendorPattern: normalized } } });
    const fromPattern = hit(p?.categoryId, p?.confidence ?? 0, 'pattern');
    if (fromPattern) return fromPattern;
  }

  if (!cats.length) return null;
  try {
    const answer = await classifyExpenseWithGemini(
      { id: 'draft', amountCents: input.amountCents ?? 0, date: new Date(), description: description || null, vendorName: vendor || null, vendorId: null },
      cats,
    );
    if (!answer || !answer.categoryName || answer.confidence < MIN_AI_CONFIDENCE) return null;
    const c = cats.find((x) => x.name === answer.categoryName);
    return c ? { categoryId: c.id, categoryName: c.name, confidence: answer.confidence, source: 'ai' } : null;
  } catch {
    return null; // a suggestion is a convenience; it must never fail the entry form
  }
}

/**
 * Teach the books what a HUMAN decided: pattern at 0.95 and the vendor default, so the next
 * entry for this vendor is prefilled and a correction replaces the old memory. Best-effort
 * (the expense already saved); returns whether anything was written.
 */
export async function rememberVendorCategory(
  tenantId: string,
  vendorName: string,
  categoryId: string,
  source: 'user' | 'user_corrected',
): Promise<boolean> {
  const normalized = normalizeVendor(vendorName ?? '');
  if (!normalized) return false;
  try {
    const cat = (await liveCategories(tenantId)).find((c) => c.id === categoryId);
    if (!cat) return false;
    await db.abPattern.upsert({
      where: { tenantId_vendorPattern: { tenantId, vendorPattern: normalized } },
      update: { categoryId, confidence: REMEMBERED_CONFIDENCE, source, usageCount: { increment: 1 }, lastUsed: new Date() },
      create: { tenantId, vendorPattern: normalized, categoryId, confidence: REMEMBERED_CONFIDENCE, source },
    });
    await db.abVendor.upsert({
      where: { tenantId_normalizedName: { tenantId, normalizedName: normalized } },
      update: { defaultCategoryId: categoryId },
      create: { tenantId, name: vendorName.trim(), normalizedName: normalized, defaultCategoryId: categoryId },
    });
    return true;
  } catch (err) {
    console.warn('[agentbook-suggest-category] remember skipped:', err instanceof Error ? err.message : err);
    return false;
  }
}
