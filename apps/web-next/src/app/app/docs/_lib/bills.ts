import type { MobileDoc } from '@/lib/mobile/types';
import type { PurchaseRow } from '@/lib/purchases-view';
import { call, EXPENSE } from '../../_lib/api';

/**
 * Bill rows for the Docs list (PR 3bc.7). Rows the server sent malformed are
 * dropped rather than rendered: a bill row needs a string id, ISO date, integer
 * total and a due|paid badge.
 */
export async function listBillRows(): Promise<PurchaseRow[]> {
  const PAGE = 100;
  const MAX_PAGES = 10; // 1,000 bills — the route's own ceiling
  const out: PurchaseRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({ kind: 'bill', limit: String(PAGE) });
    if (page > 0) qs.set('offset', String(page * PAGE));
    const env = await call<PurchaseRow[]>(`${EXPENSE}/purchases?${qs.toString()}`);
    const raw = Array.isArray(env.data) ? env.data : [];
    for (const r of raw) {
      if (
        r && r.kind === 'bill' && typeof r.id === 'string' && typeof r.date === 'string' && !isNaN(Date.parse(r.date)) &&
        Number.isInteger(r.amountCents) && (r.status === 'due' || r.status === 'paid')
      ) out.push(r);
    }
    if (raw.length < PAGE) break;
  }
  return out;
}

/**
 * Bills among the documents, newest first. The documents page by cursor, so a bill older than the oldest
 * document loaded so far waits until scrolling reaches its date (or the documents run out).
 */
export function interleaveBills(items: MobileDoc[], bills: PurchaseRow[], cursor: unknown): { doc: MobileDoc | null; bill: PurchaseRow | null }[] {
  const oldest = items.length ? Date.parse(items[items.length - 1].date) : Infinity;
  const shown = bills.filter((b) => !cursor || Date.parse(b.date) >= oldest);
  const all = [
    ...items.map((d) => ({ doc: d as MobileDoc | null, bill: null as PurchaseRow | null, at: Date.parse(d.date) })),
    ...shown.map((b) => ({ doc: null as MobileDoc | null, bill: b, at: Date.parse(b.date) })),
  ];
  return shown.length ? all.sort((a, b) => b.at - a.at) : all;
}
