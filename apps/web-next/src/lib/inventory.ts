/**
 * Inventory engine — items, purchases, on-hand (spec §5.4, PR 5A).
 *
 * Weighted average cost, fixed in v1. The sub-ledger stores VALUE in integer
 * cents (`onHandValueCents`); average cost is derived (value ÷ qty), so it can
 * never drift from account 1500 by rounding.
 *
 * Quantities are Decimal(14,4) in the database. All qty math here is done in
 * integer ten-thousandths ("units") — exact, and a Float input (bill/invoice
 * line qty) is converted via its 4-dp string, never multiplied as a float.
 *
 * Postings (every one balanced, keyed, period-gated):
 *   purchase (bill line)  DR 1500 inside the bill's own entry      movement bill_line / line.id
 *   purchase void         CR 1500 inside the bill/payment void      movement bill_line_void / line.id
 *   opening stock         DR 1500 | CR 3900                          stock_opening / item.id
 *   adjustment            DR shrinkage | CR 1500 (or reverse)        stock_adjust / key
 *   negative-stock true-up DR/CR 1500 vs cogs                        stock_adjust / trueup:<source>
 *   stock out (5B sales)  DR cogs | CR 1500                          <caller sourceType> / <caller id>
 *
 * Relief (value moved out by a sale/shrinkage):
 *   valueOut = round(onHandValue × qtyOut ÷ onHandQty); when qtyOut takes the
 *   LAST units (qtyOut ≥ onHandQty) it is exactly onHandValue, so value hits 0
 *   at qty 0. Units sold beyond on-hand (negative stock) relieve 0; the first
 *   purchase that brings qty back to ≥ 0 posts a `stock_adjust` true-up that
 *   sets the value to (remaining qty × that purchase's unit cost).
 */
import 'server-only';
import { randomUUID } from 'node:crypto';
import { PublicError } from '@/lib/api-error';
import { appendBalancedEntry, assertPeriodOpen, LedgerPeriodClosedError, type LedgerLine } from '@/lib/ledger-writer';
import { ensureChartOfAccounts } from '@/lib/agentbook-chart-of-accounts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
export type InventoryDb = any;

export class InventoryError extends PublicError {
  declare readonly status: number;
  constructor(status: number, public readonly code: string, message?: string) {
    super(message ?? code, status);
  }
}

/* -------------------------------------------------------------- account roles */

export type InventoryRole = 'inventory' | 'cogs' | 'shrinkage' | 'opening_equity';

/** Jurisdictions with their own chart pack in ensureChartOfAccounts; others get the US chart. */
const CHART_JURISDICTIONS = new Set(['us', 'ca', 'au']);
/** Packs whose 5000 already is Cost of Goods Sold (owner call O3). */
const COGS_5000 = new Set(['au', 'uk']);

/**
 * The chart a tenant actually has: an unknown/unwired jurisdiction (incl. uk today) falls back to US.
 * Owner-call O3 deviation: UK tenants run on the US chart where 5000 is Advertising, so their COGS is
 * 5990 for now; a UK pack (CHART_PROVIDERS in agentbook-chart-of-accounts.ts) must move COGS to 5000.
 */
export function chartJurisdiction(jurisdiction: string | null | undefined): string {
  const j = String(jurisdiction || 'us').toLowerCase();
  return CHART_JURISDICTIONS.has(j) ? j : 'us';
}

export function accountCodeForRole(role: InventoryRole, jurisdiction: string | null | undefined): string {
  switch (role) {
    case 'inventory': return '1500';
    case 'opening_equity': return '3900';
    case 'shrinkage': return '5995';
    case 'cogs': return COGS_5000.has(chartJurisdiction(jurisdiction)) ? '5000' : '5990';
  }
}

/** Every inventory-role account code for a jurisdiction (never an expense category a person picks). */
export function inventoryRoleCodes(jurisdiction: string | null | undefined): Set<string> {
  return new Set((['inventory', 'cogs', 'shrinkage', 'opening_equity'] as InventoryRole[]).map((r) => accountCodeForRole(r, jurisdiction)));
}

/**
 * Drop inventory-role accounts (1500, 3900, the market's COGS, 5995) from a
 * list of expense categories offered to a person or to auto-categorise: COGS
 * and shrinkage are posted only by the inventory engine (PR 5A review I3).
 * A tenant-config read failure falls back to the US set.
 */
export async function withoutInventoryRoles<T extends { code?: string | null }>(db: InventoryDb, tenantId: string, rows: T[]): Promise<T[]> {
  let jurisdiction: string | null = null;
  try {
    const cfg = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    jurisdiction = cfg?.jurisdiction ?? null;
  } catch {
    jurisdiction = null;
  }
  const codes = inventoryRoleCodes(jurisdiction);
  return rows.filter((r) => !r.code || !codes.has(r.code));
}

export async function resolveAccountByRole(db: InventoryDb, tenantId: string, role: InventoryRole): Promise<{ id: string; code: string }> {
  const cfg = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
  const code = accountCodeForRole(role, cfg?.jurisdiction);
  let a = await db.abAccount.findFirst({ where: { tenantId, code } });
  if (!a) {
    await ensureChartOfAccounts(tenantId);
    a = await db.abAccount.findFirst({ where: { tenantId, code } });
  }
  if (!a) throw new InventoryError(422, 'ledger_account_missing', `Account ${code} not found`);
  return { id: a.id, code };
}

/* --------------------------------------------------------------------- qty */

export const QTY_SCALE = 10_000;

/** A qty (Decimal, string or Float) → integer ten-thousandths. Throws on > 4 dp strings. */
export function toUnits(q: unknown): number {
  if (q === null || q === undefined || q === '') return 0;
  let s: string;
  if (typeof q === 'number') {
    if (!Number.isFinite(q)) throw new InventoryError(400, 'invalid_qty');
    s = q.toFixed(4);
  } else {
    s = String(q).trim();
  }
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m || /[^0]/.test((m[3] ?? '').slice(4))) {
    throw new InventoryError(400, 'invalid_qty', `Quantity ${s} is not a number with at most 4 decimals`);
  }
  const frac = (m[3] ?? '').slice(0, 4).padEnd(4, '0');
  const units = Number(m[2]) * QTY_SCALE + Number(frac);
  if (!Number.isSafeInteger(units)) throw new InventoryError(400, 'invalid_qty');
  return m[1] === '-' && units !== 0 ? -units : units;
}

/** Units → Decimal string Prisma accepts ("12.5000"). */
export function unitsToDecimal(u: number): string {
  const neg = u < 0;
  const a = Math.abs(u);
  return `${neg ? '-' : ''}${Math.floor(a / QTY_SCALE)}.${String(a % QTY_SCALE).padStart(4, '0')}`;
}

/** Units → a plain number for display/API (4 dp exact in a double). */
export const unitsToNumber = (u: number) => u / QTY_SCALE;

/**
 * Value relieved when `outUnits` leave a stock of (qtyUnits, valueCents).
 * Pure; the spec's rounding rule. Never negative-relieves an empty stock.
 */
export function reliefValueCents(qtyUnits: number, valueCents: number, outUnits: number): number {
  if (outUnits <= 0 || qtyUnits <= 0) return 0;
  if (outUnits >= qtyUnits) return valueCents; // the last unit takes the remainder
  return Math.round((valueCents * outUnits) / qtyUnits);
}

/* --------------------------------------------------------------- internals */

const isP2002 = (e: unknown) => (e as { code?: string })?.code === 'P2002';

function periodError(err: unknown): never {
  if (err instanceof LedgerPeriodClosedError) throw new InventoryError(422, 'period_closed', err.message);
  throw err;
}

export async function loadItem(db: InventoryDb, tenantId: string, itemId: string): Promise<Row> {
  const item = await db.abInventoryItem.findFirst({ where: { id: itemId, tenantId, deletedAt: null } });
  if (!item) throw new InventoryError(404, 'item_not_found');
  return item;
}

/** Tenant has opted in (spec: gate on the flag, never businessType alone). */
export async function inventoryEnabled(db: InventoryDb, tenantId: string): Promise<boolean> {
  const cfg = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
  return cfg?.trackInventory === true;
}

export async function assertInventoryEnabled(db: InventoryDb, tenantId: string): Promise<void> {
  if (!(await inventoryEnabled(db, tenantId))) {
    throw new InventoryError(422, 'inventory_not_enabled', 'Turn on inventory tracking in Business Profile first');
  }
}

interface MovementInput {
  itemId: string;
  date: Date;
  type: string;
  qtyUnits: number;
  valueCents: number;
  sourceType: string;
  sourceId: string;
  journalEntryId: string | null;
}

/** Insert a movement and apply it to the item. Caller holds the transaction. */
async function applyMovement(tx: InventoryDb, tenantId: string, m: MovementInput): Promise<Row> {
  const item = await tx.abInventoryItem.findFirst({ where: { id: m.itemId, tenantId } });
  if (!item) throw new InventoryError(404, 'item_not_found');
  const movement = await tx.abStockMovement.create({
    data: {
      tenantId, itemId: m.itemId, date: m.date, type: m.type,
      qty: unitsToDecimal(m.qtyUnits), valueCents: m.valueCents,
      sourceType: m.sourceType, sourceId: m.sourceId, journalEntryId: m.journalEntryId,
    },
  });
  const qty = toUnits(item.onHandQty) + m.qtyUnits;
  const value = item.onHandValueCents + m.valueCents;
  await tx.abInventoryItem.update({
    where: { id: m.itemId },
    data: { onHandQty: unitsToDecimal(qty), onHandValueCents: value },
  });
  return movement;
}

/** Existing movement for a key (replay detection). */
const findMovement = (db: InventoryDb, tenantId: string, sourceType: string, sourceId: string) =>
  db.abStockMovement.findFirst({ where: { tenantId, sourceType, sourceId } });

/**
 * True-up after a purchase: if the stock WAS negative and is now ≥ 0, set the
 * value to (qty × purchase unit cost) — at qty 0, exactly 0 — and post the
 * difference DR/CR 1500 against cogs.
 */
async function trueUpAfterPurchase(tx: InventoryDb, tenantId: string, itemId: string, prevQtyUnits: number, purchase: { qtyUnits: number; valueCents: number; date: Date; key: string }): Promise<Row | null> {
  if (prevQtyUnits >= 0) return null;
  const item = await tx.abInventoryItem.findFirst({ where: { id: itemId, tenantId } });
  const qty = toUnits(item.onHandQty);
  if (qty < 0) return null; // still negative: wait for the purchase that crosses zero
  const expected = qty === 0 ? 0 : Math.round((purchase.valueCents * qty) / purchase.qtyUnits);
  const delta = expected - item.onHandValueCents;
  if (delta === 0) return null;
  const inv = await resolveAccountByRole(tx, tenantId, 'inventory');
  const cogs = await resolveAccountByRole(tx, tenantId, 'cogs');
  const abs = Math.abs(delta);
  const lines: LedgerLine[] = delta > 0
    ? [{ accountId: inv.id, debitCents: abs, creditCents: 0, description: 'Negative-stock true-up' },
       { accountId: cogs.id, debitCents: 0, creditCents: abs, description: 'Negative-stock true-up' }]
    : [{ accountId: cogs.id, debitCents: abs, creditCents: 0, description: 'Negative-stock true-up' },
       { accountId: inv.id, debitCents: 0, creditCents: abs, description: 'Negative-stock true-up' }];
  const sourceId = `trueup:${purchase.key}`;
  const entryId = await appendBalancedEntry(tx, tenantId, { date: purchase.date, memo: `Stock true-up: ${item.name}`, sourceType: 'stock_adjust', sourceId }, lines);
  return applyMovement(tx, tenantId, { itemId, date: purchase.date, type: 'stock_adjust', qtyUnits: 0, valueCents: delta, sourceType: 'stock_adjust', sourceId, journalEntryId: entryId });
}

/* ----------------------------------------------------------- purchase hooks */

/**
 * A bill line's purchase generations. An at_payment bill can be paid, have the
 * payment voided, and be paid again: each payment is a new purchase movement
 * (`bill_line` / line.id, then line.id:1, line.id:2 …) and each void reverses
 * the latest one (`bill_line_void`, same numbering). Without generations the
 * second payment's DR 1500 found the first movement as a "replay" and the
 * sub-ledger drifted from 1500 (found by the PR 5B journal property test).
 */
async function purchaseGenerations(tx: InventoryDb, tenantId: string, billLineId: string) {
  const sourceType = { in: ['bill_line', 'bill_line_void'] };
  const all: Row[] = [
    ...((await tx.abStockMovement.findMany({ where: { tenantId, sourceType, sourceId: billLineId } })) || []),
    ...((await tx.abStockMovement.findMany({ where: { tenantId, sourceType, sourceId: { startsWith: `${billLineId}:` } } })) || []),
  ];
  const byGen = (a: Row, b: Row) => genOf(a.sourceId) - genOf(b.sourceId);
  const genOf = (sid: string) => (sid.includes(':') ? Number(sid.slice(sid.lastIndexOf(':') + 1)) : 0);
  return {
    purchases: all.filter((m) => m.sourceType === 'bill_line').sort(byGen),
    voids: all.filter((m) => m.sourceType === 'bill_line_void').sort(byGen),
    key: (gen: number) => (gen === 0 ? billLineId : `${billLineId}:${gen}`),
  };
}

/**
 * A bill line with itemId was booked (its DR 1500 is part of `journalEntryId`).
 * Call inside the bill's transaction. Idempotent per live purchase generation.
 */
export async function recordPurchaseMovement(tx: InventoryDb, tenantId: string, p: { itemId: string; billLineId: string; qty: unknown; valueCents: number; date: Date; journalEntryId: string | null }): Promise<Row> {
  const g = await purchaseGenerations(tx, tenantId, p.billLineId);
  if (g.purchases.length > g.voids.length) return g.purchases[g.purchases.length - 1]; // live purchase: replay
  const sourceId = g.key(g.purchases.length);
  const qtyUnits = toUnits(p.qty);
  if (qtyUnits <= 0) throw new InventoryError(400, 'invalid_qty', 'A purchase quantity must be positive');
  const before = await tx.abInventoryItem.findFirst({ where: { id: p.itemId, tenantId } });
  if (!before) throw new InventoryError(404, 'item_not_found');
  const movement = await applyMovement(tx, tenantId, {
    itemId: p.itemId, date: p.date, type: 'purchase', qtyUnits, valueCents: p.valueCents,
    sourceType: 'bill_line', sourceId, journalEntryId: p.journalEntryId,
  });
  await trueUpAfterPurchase(tx, tenantId, p.itemId, toUnits(before.onHandQty), { qtyUnits, valueCents: p.valueCents, date: p.date, key: `bill_line:${sourceId}` });
  return movement;
}

/** Reverse a bill line's live purchase exactly (qty and value as booked). Inside the void's transaction. */
export async function reversePurchaseMovement(tx: InventoryDb, tenantId: string, p: { billLineId: string; date: Date; journalEntryId: string | null }): Promise<Row | null> {
  const g = await purchaseGenerations(tx, tenantId, p.billLineId);
  if (g.purchases.length === 0) return null;
  if (g.voids.length >= g.purchases.length) return g.voids[g.voids.length - 1]; // already reversed: replay
  const orig = g.purchases[g.voids.length];
  return applyMovement(tx, tenantId, {
    itemId: orig.itemId, date: p.date, type: 'purchase_void', qtyUnits: -toUnits(orig.qty), valueCents: -orig.valueCents,
    sourceType: 'bill_line_void', sourceId: g.key(g.voids.length), journalEntryId: p.journalEntryId,
  });
}

/* -------------------------------------------------------- standalone posts */

type TxDb = InventoryDb & { $transaction: (fn: (tx: InventoryDb) => Promise<unknown>) => Promise<unknown> };

async function postKeyed(db: TxDb, tenantId: string, key: { sourceType: string; sourceId: string }, same: (m: Row) => boolean, run: (tx: InventoryDb) => Promise<Row>): Promise<{ movement: Row; replayed: boolean }> {
  const replay = (m: Row) => {
    if (!same(m)) throw new InventoryError(409, 'idempotency_key_conflict', 'This key was used for a different stock movement');
    return { movement: m, replayed: true };
  };
  const hit = await findMovement(db, tenantId, key.sourceType, key.sourceId);
  if (hit) return replay(hit);
  try {
    const movement = (await db.$transaction(run)) as Row;
    return { movement, replayed: false };
  } catch (err) {
    if (isP2002(err)) {
      const again = await findMovement(db, tenantId, key.sourceType, key.sourceId);
      if (again) return replay(again);
    }
    return periodError(err);
  }
}

/** Opening stock: DR 1500 | CR 3900, one per item (stock_opening / item.id). */
export async function recordOpeningStock(db: TxDb, tenantId: string, input: { itemId: string; qty: unknown; valueCents: number; date: Date }): Promise<{ movement: Row; replayed: boolean }> {
  await assertInventoryEnabled(db, tenantId);
  const item = await loadItem(db, tenantId, input.itemId);
  const qtyUnits = toUnits(input.qty);
  if (qtyUnits <= 0) throw new InventoryError(400, 'invalid_qty');
  if (!Number.isInteger(input.valueCents) || input.valueCents <= 0) throw new InventoryError(400, 'invalid_amount');
  await assertPeriodOpen(db, tenantId, input.date).catch(periodError);
  const inv = await resolveAccountByRole(db, tenantId, 'inventory');
  const eq = await resolveAccountByRole(db, tenantId, 'opening_equity');
  const key = { sourceType: 'stock_opening', sourceId: item.id };
  return postKeyed(db, tenantId, key, (m) => toUnits(m.qty) === qtyUnits && m.valueCents === input.valueCents, async (tx) => {
    await assertPeriodOpen(tx, tenantId, input.date);
    const before = await tx.abInventoryItem.findFirst({ where: { id: item.id, tenantId } });
    const entryId = await appendBalancedEntry(tx, tenantId, { date: input.date, memo: `Opening stock: ${item.name}`, ...key }, [
      { accountId: inv.id, debitCents: input.valueCents, creditCents: 0, description: `Opening stock: ${item.name}` },
      { accountId: eq.id, debitCents: 0, creditCents: input.valueCents, description: 'Opening balance equity' },
    ]);
    const m = await applyMovement(tx, tenantId, { itemId: item.id, date: input.date, type: 'opening', qtyUnits, valueCents: input.valueCents, ...key, journalEntryId: entryId });
    await trueUpAfterPurchase(tx, tenantId, item.id, toUnits(before.onHandQty), { qtyUnits, valueCents: input.valueCents, date: input.date, key: `stock_opening:${item.id}` });
    return m;
  });
}

/**
 * Stock adjustment (count correction / shrinkage).
 *   qty < 0: value relieved at average cost (or the given valueCents), DR shrinkage | CR 1500.
 *   qty > 0: valueCents required (found stock), DR 1500 | CR shrinkage.
 *   qty = 0 with valueCents: revalue.
 */
export async function adjustStock(db: TxDb, tenantId: string, input: { itemId: string; qty: unknown; valueCents?: number | null; date: Date; reason?: string | null; idempotencyKey?: string | null }): Promise<{ movement: Row; replayed: boolean }> {
  await assertInventoryEnabled(db, tenantId);
  const item = await loadItem(db, tenantId, input.itemId);
  const qtyUnits = toUnits(input.qty);
  if (input.valueCents != null && !Number.isInteger(input.valueCents)) throw new InventoryError(400, 'invalid_amount');
  if (qtyUnits > 0 && (input.valueCents == null || input.valueCents < 0)) throw new InventoryError(400, 'value_required', 'Added stock needs a value');
  if (qtyUnits === 0 && !input.valueCents) throw new InventoryError(400, 'invalid_qty');
  await assertPeriodOpen(db, tenantId, input.date).catch(periodError);
  const inv = await resolveAccountByRole(db, tenantId, 'inventory');
  const shrink = await resolveAccountByRole(db, tenantId, 'shrinkage');
  const key = { sourceType: 'stock_adjust', sourceId: input.idempotencyKey?.trim() || randomUUID() };
  // A replay must be the same adjustment: item, qty, and (when given) value.
  const same = (m: Row) => toUnits(m.qty) === qtyUnits && m.itemId === item.id &&
    (input.valueCents == null || Math.abs(m.valueCents) === Math.abs(input.valueCents));
  return postKeyed(db, tenantId, key, same, async (tx) => {
    await assertPeriodOpen(tx, tenantId, input.date);
    const cur = await tx.abInventoryItem.findFirst({ where: { id: item.id, tenantId } });
    const curQty = toUnits(cur.onHandQty);
    // Signed value change to stock.
    let valueDelta: number;
    if (qtyUnits < 0 && input.valueCents != null) {
      // An explicit removal value can never take out more than the stock holds,
      // and emptying the stock must take out exactly what is left (value 0 at qty 0).
      const out = Math.abs(input.valueCents);
      if (out > Math.max(0, cur.onHandValueCents)) {
        throw new InventoryError(422, 'adjust_value_exceeds_stock', 'The value removed is more than the stock on hand is worth');
      }
      if (curQty + qtyUnits === 0 && out !== cur.onHandValueCents) {
        throw new InventoryError(422, 'adjust_value_mismatch', 'Removing all stock must remove its whole value');
      }
      valueDelta = -out;
    } else if (qtyUnits < 0) valueDelta = -reliefValueCents(curQty, cur.onHandValueCents, -qtyUnits);
    else valueDelta = input.valueCents!; // found stock (qty > 0) or a pure revaluation (qty 0)
    let entryId: string | null = null;
    if (valueDelta !== 0) {
      const abs = Math.abs(valueDelta);
      const memo = `Stock adjustment: ${item.name}${input.reason ? ` (${input.reason})` : ''}`;
      entryId = await appendBalancedEntry(tx, tenantId, { date: input.date, memo, ...key }, valueDelta < 0
        ? [{ accountId: shrink.id, debitCents: abs, creditCents: 0, description: memo }, { accountId: inv.id, debitCents: 0, creditCents: abs, description: memo }]
        : [{ accountId: inv.id, debitCents: abs, creditCents: 0, description: memo }, { accountId: shrink.id, debitCents: 0, creditCents: abs, description: memo }]);
    }
    return applyMovement(tx, tenantId, { itemId: item.id, date: input.date, type: 'stock_adjust', qtyUnits, valueCents: valueDelta, ...key, journalEntryId: entryId });
  });
}

/**
 * Stock out at weighted average (the 5B sale path calls this inside the
 * invoice transaction): DR cogs | CR 1500 for the relieved value, keyed by
 * the caller's (sourceType, sourceId). Returns the relieved value in cents.
 */
export async function relieveStock(tx: InventoryDb, tenantId: string, input: { itemId: string; qty: unknown; date: Date; sourceType: string; sourceId: string; type?: string; memo?: string }): Promise<{ movement: Row; valueCents: number; negative: boolean }> {
  const hit = await findMovement(tx, tenantId, input.sourceType, input.sourceId);
  if (hit) {
    // Replay: report the original outcome — was stock below zero right after this movement?
    const all: Row[] = (await tx.abStockMovement.findMany({ where: { tenantId, itemId: hit.itemId }, orderBy: { createdAt: 'asc' } })) || [];
    const upTo = all.slice(0, all.findIndex((m) => m.id === hit.id) + 1);
    const qtyAfter = upTo.reduce((s, m) => s + toUnits(m.qty), 0);
    return { movement: hit, valueCents: -hit.valueCents, negative: qtyAfter < 0 };
  }
  const outUnits = toUnits(input.qty);
  if (outUnits <= 0) throw new InventoryError(400, 'invalid_qty');
  await assertPeriodOpen(tx, tenantId, input.date).catch(periodError);
  const item = await tx.abInventoryItem.findFirst({ where: { id: input.itemId, tenantId } });
  if (!item) throw new InventoryError(404, 'item_not_found');
  const qty = toUnits(item.onHandQty);
  // Never relieve a negative value: the movement and the journal must move 1500
  // by the same amount (a negative relief used to change the sub-ledger with no
  // entry — found by the PR 5B journal property test).
  const value = Math.max(0, reliefValueCents(qty, item.onHandValueCents, outUnits));
  let entryId: string | null = null;
  if (value > 0) {
    const inv = await resolveAccountByRole(tx, tenantId, 'inventory');
    const cogs = await resolveAccountByRole(tx, tenantId, 'cogs');
    const memo = input.memo ?? `Cost of goods sold: ${item.name}`;
    entryId = await appendBalancedEntry(tx, tenantId, { date: input.date, memo, sourceType: input.sourceType, sourceId: input.sourceId }, [
      { accountId: cogs.id, debitCents: value, creditCents: 0, description: memo },
      { accountId: inv.id, debitCents: 0, creditCents: value, description: memo },
    ]);
  }
  const movement = await applyMovement(tx, tenantId, {
    itemId: item.id, date: input.date, type: input.type ?? 'stock_sale', qtyUnits: -outUnits, valueCents: -value,
    sourceType: input.sourceType, sourceId: input.sourceId, journalEntryId: entryId,
  });
  return { movement, valueCents: value, negative: qty - outUnits < 0 };
}

/* ------------------------------------------------------------- 5B: sales */

/** An invoice line as the sale hooks need it (quantity is the Float column). */
export interface SaleLine { id: string; itemId?: string | null; quantity: unknown }

const SALE_FAMILY = ['stock_sale', 'stock_sale_edit_reverse', 'stock_sale_void'];

/** Sale-family movements for one invoice line (original, edit reposts, edit reversals, void). */
async function lineSaleMovements(tx: InventoryDb, tenantId: string, lineId: string): Promise<Row[]> {
  const sourceType = { in: SALE_FAMILY };
  return [
    ...((await tx.abStockMovement.findMany({ where: { tenantId, sourceType, sourceId: lineId } })) || []),
    ...((await tx.abStockMovement.findMany({ where: { tenantId, sourceType, sourceId: { startsWith: `${lineId}:` } } })) || []),
  ];
}

/** Put a line's net sold stock back at exactly the value it took out: DR 1500 | CR cogs. */
async function returnLineStock(tx: InventoryDb, tenantId: string, lineId: string, key: { sourceType: string; sourceId: string }, date: Date, memo: string): Promise<Row | null> {
  const hit = await findMovement(tx, tenantId, key.sourceType, key.sourceId);
  if (hit) return hit;
  const ms = await lineSaleMovements(tx, tenantId, lineId);
  if (ms.length === 0) return null;
  const outUnits = -ms.reduce((s, m) => s + toUnits(m.qty), 0);
  const outValue = -ms.reduce((s, m) => s + m.valueCents, 0);
  if (outUnits === 0 && outValue === 0) return null;
  let entryId: string | null = null;
  if (outValue !== 0) {
    const inv = await resolveAccountByRole(tx, tenantId, 'inventory');
    const cogs = await resolveAccountByRole(tx, tenantId, 'cogs');
    const abs = Math.abs(outValue);
    entryId = await appendBalancedEntry(tx, tenantId, { date, memo, ...key }, outValue > 0
      ? [{ accountId: inv.id, debitCents: abs, creditCents: 0, description: memo }, { accountId: cogs.id, debitCents: 0, creditCents: abs, description: memo }]
      : [{ accountId: cogs.id, debitCents: abs, creditCents: 0, description: memo }, { accountId: inv.id, debitCents: 0, creditCents: abs, description: memo }]);
  }
  return applyMovement(tx, tenantId, {
    itemId: ms[0].itemId, date, type: key.sourceType, qtyUnits: outUnits, valueCents: outValue, ...key, journalEntryId: entryId,
  });
}

/**
 * Invoice created (revenue posted): relieve stock for every line that has an
 * itemId — `stock_sale` / line.id, DR cogs | CR 1500. Only when the tenant
 * tracks inventory. Call inside the invoice's transaction. Idempotent per line.
 */
export async function postInvoiceCogs(tx: InventoryDb, tenantId: string, input: { invoiceNumber: string; date: Date; lines: SaleLine[] }): Promise<{ lineId: string; valueCents: number; negative: boolean }[]> {
  const itemLines = (input.lines ?? []).filter((l) => l.itemId);
  if (itemLines.length === 0 || !(await inventoryEnabled(tx, tenantId))) return [];
  const out = [];
  for (const l of itemLines) {
    const r = await relieveStock(tx, tenantId, {
      itemId: l.itemId!, qty: l.quantity, date: input.date, sourceType: 'stock_sale', sourceId: l.id,
      memo: `Cost of goods sold: Invoice ${input.invoiceNumber}`,
    });
    out.push({ lineId: l.id, valueCents: r.valueCents, negative: r.negative });
  }
  return out;
}

/** Invoice voided: return each item line's net sold stock (`stock_sale_void` / line.id). */
export async function voidInvoiceCogs(tx: InventoryDb, tenantId: string, input: { invoiceNumber: string; date: Date; lineIds: string[] }): Promise<Row[]> {
  const out: Row[] = [];
  for (const id of input.lineIds) {
    const m = await returnLineStock(tx, tenantId, id, { sourceType: 'stock_sale_void', sourceId: id }, input.date, `Void COGS: Invoice ${input.invoiceNumber}`);
    if (m) out.push(m);
  }
  return out;
}

/**
 * An item line's quantity was edited (revision `rev`): reverse what the line
 * currently has out (`stock_sale_edit_reverse` / line:rev), then relieve the
 * new quantity (`stock_sale` / line:rev).
 */
export async function repostInvoiceLineCogs(tx: InventoryDb, tenantId: string, input: { invoiceNumber: string; date: Date; line: SaleLine; rev: number }): Promise<{ valueCents: number; negative: boolean } | null> {
  if (!input.line.itemId) return null;
  const sid = `${input.line.id}:${input.rev}`;
  // Reversal never depends on the flag (as void): what went out comes back.
  await returnLineStock(tx, tenantId, input.line.id, { sourceType: 'stock_sale_edit_reverse', sourceId: sid }, input.date, `Reverse COGS (edit): Invoice ${input.invoiceNumber}`);
  if (!(await inventoryEnabled(tx, tenantId))) return null;
  const r = await relieveStock(tx, tenantId, {
    itemId: input.line.itemId, qty: input.line.quantity, date: input.date, sourceType: 'stock_sale', sourceId: sid,
    memo: `Cost of goods sold: Invoice ${input.invoiceNumber}`,
  });
  return { valueCents: r.valueCents, negative: r.negative };
}

/** Every itemId exists for this tenant (no FK on AbInvoiceLine.itemId) — else 404. */
export async function assertItemsOwned(db: InventoryDb, tenantId: string, itemIds: string[]): Promise<void> {
  for (const id of new Set(itemIds)) await loadItem(db, tenantId, id);
}

/**
 * COGS by period: net sale-family movement value per month/quarter in [from, to).
 * Sales add, voids/edit reversals subtract; true-ups (stock_adjust) are excluded
 * here and stay visible on the P&L's COGS account.
 */
export async function cogsByPeriod(db: InventoryDb, tenantId: string, input: { from: Date; to: Date; granularity: 'month' | 'quarter' }) {
  const all: Row[] = (await db.abStockMovement.findMany({
    where: { tenantId, sourceType: { in: SALE_FAMILY }, date: { gte: input.from, lt: input.to } },
  })) || [];
  const buckets = new Map<string, number>();
  for (const m of all) {
    const d = new Date(m.date);
    const y = d.getUTCFullYear();
    const key = input.granularity === 'quarter' ? `${y}-Q${Math.floor(d.getUTCMonth() / 3) + 1}` : `${y}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    buckets.set(key, (buckets.get(key) ?? 0) - m.valueCents);
  }
  const periods = [...buckets.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([period, cogsCents]) => ({ period, cogsCents }));
  return { periods, totalCents: periods.reduce((s, p) => s + p.cogsCents, 0) };
}

/* ------------------------------------------------------------------- views */

export function itemView(item: Row) {
  const qtyUnits = toUnits(item.onHandQty);
  const reorder = item.reorderPoint == null ? null : toUnits(item.reorderPoint);
  return {
    id: item.id, sku: item.sku ?? null, name: item.name, unit: item.unit, isActive: item.isActive,
    onHandQty: unitsToNumber(qtyUnits),
    onHandValueCents: item.onHandValueCents,
    avgCostCents: qtyUnits > 0 ? Math.round((item.onHandValueCents * QTY_SCALE) / qtyUnits) : null,
    reorderPoint: reorder == null ? null : unitsToNumber(reorder),
    salePriceCents: item.salePriceCents ?? null,
    lowStock: reorder != null && qtyUnits <= reorder,
    negative: qtyUnits < 0,
    createdAt: item.createdAt, updatedAt: item.updatedAt,
  };
}

export function movementView(m: Row) {
  return {
    id: m.id, itemId: m.itemId, date: m.date, type: m.type,
    qty: unitsToNumber(toUnits(m.qty)), valueCents: m.valueCents,
    sourceType: m.sourceType ?? null, sourceId: m.sourceId ?? null, journalEntryId: m.journalEntryId ?? null,
  };
}

/** Stock on hand: every live item + totals. */
export async function stockOnHand(db: InventoryDb, tenantId: string) {
  const items: Row[] = await db.abInventoryItem.findMany({ where: { tenantId, deletedAt: null }, orderBy: { name: 'asc' } });
  const views = items.map(itemView);
  return {
    items: views,
    totalValueCents: views.reduce((s, v) => s + v.onHandValueCents, 0),
    lowStockCount: views.filter((v) => v.isActive && v.lowStock).length,
  };
}

/** Low-stock items (qty ≤ reorder point), active, live. Empty when tracking is off. */
export async function lowStockItems(db: InventoryDb, tenantId: string) {
  if (!(await inventoryEnabled(db, tenantId))) return [];
  const { items } = await stockOnHand(db, tenantId);
  return items.filter((v) => v.isActive && v.lowStock);
}
