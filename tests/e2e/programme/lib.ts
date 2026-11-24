import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { catalogT, loginAs, loginUnavailableReason, newPersonaContext, pageLocales, settle, type CatalogT } from '../mobile-app/helpers';
import { todayIso, type Persona } from '../mobile-app/fixtures';
import { api, expectOk } from '../nightly/helpers/api';

/**
 * Shared plumbing for the programme's cross-PR prod journeys. Everything here only READS tenant state or talks to
 * the same routes the per-PR specs in tests/e2e/mobile-app use; fixtures are created and unwound by each spec.
 */

export const EXPENSE = '/api/v1/agentbook-expense';
export const CORE = '/api/v1/agentbook-core';
export const TAX = '/api/v1/agentbook-tax';
export const INVOICE = '/api/v1/agentbook-invoice';
export const PAYROLL = '/api/v1/agentbook-payroll';
export const CHAT = `${CORE}/agent/message`;
export const PERSONAS: Persona[] = ['maya', 'alex', 'sydney'];

export interface TenantCfg {
  jurisdiction: 'us' | 'ca' | 'au' | string;
  region: string | null;
  currency: string;
  gstRegistered: boolean | null;
  qstRegistered: boolean | null;
  gstReportingBasis: string | null;
  accountingBasis: string | null;
  trackInventory: boolean | null;
}
export interface Ctx { context: BrowserContext; page: Page; t: CatalogT; formatLocale: string; cfg: TenantCfg }

export async function tenantConfig(page: Page): Promise<TenantCfg> {
  const res = await api(page).get(`${CORE}/tenant-config`);
  expectOk(res, 'tenant config');
  const c = res.data.data;
  return {
    jurisdiction: c.jurisdiction, region: c.region ?? null, currency: c.currency,
    gstRegistered: c.gstRegistered ?? null, qstRegistered: c.qstRegistered ?? null,
    gstReportingBasis: c.gstReportingBasis ?? null, accountingBasis: c.accountingBasis ?? null,
    trackInventory: c.trackInventory ?? null,
  };
}

/** Log in, load /app/capture, prove the catalog locale against the page's h1, read the tenant config. */
export async function openPersona(browser: Browser, baseURL: string | undefined, persona: Persona): Promise<Ctx> {
  const reason = loginUnavailableReason(baseURL);
  expect(reason, reason ?? '').toBeNull();
  const context = await newPersonaContext(browser, baseURL);
  const page = await context.newPage();
  await loginAs(page, persona);
  await page.goto('/app/capture');
  await settle(page);
  const loc = await pageLocales(page);
  const t = catalogT(loc.stringLocale);
  await expect(page.getByRole('heading', { name: t('mobile.capture.title') })).toBeVisible();
  page.on('dialog', (d) => { void d.accept(); });
  return { context, page, t, formatLocale: loc.formatLocale, cfg: await tenantConfig(page) };
}

export interface Tb { balanced: boolean; byCode: Record<string, number> }
/** Trial balance by account code (debit − credit) and the route's own balanced flag. */
export async function trialBalance(page: Page): Promise<Tb> {
  const res = await api(page).get(`${CORE}/trial-balance`);
  expectOk(res, 'trial balance');
  const byCode: Record<string, number> = {};
  for (const a of res.data.data.accounts as Array<{ code: string; balance: number }>) byCode[a.code] = (byCode[a.code] ?? 0) + a.balance;
  return { balanced: res.data.data.balanced === true && res.data.data.totalDebits === res.data.data.totalCredits, byCode };
}
export const tbDelta = (a: Tb, b: Tb, code: string) => (b.byCode[code] ?? 0) - (a.byCode[code] ?? 0);
/** Every code whose balance differs between two trial balances: code -> after − before. */
export function tbMoved(a: Tb, b: Tb): Record<string, number> {
  const out: Record<string, number> = {};
  for (const code of new Set([...Object.keys(a.byCode), ...Object.keys(b.byCode)])) {
    const d = tbDelta(a, b, code);
    if (d !== 0) out[code] = d;
  }
  return out;
}

export function quarterOf(iso: string): { periodStart: string; periodEnd: string } {
  const d = new Date(`${iso}T00:00:00Z`);
  const q = Math.floor(d.getUTCMonth() / 3);
  return {
    periodStart: new Date(Date.UTC(d.getUTCFullYear(), q * 3, 1)).toISOString().slice(0, 10),
    periodEnd: new Date(Date.UTC(d.getUTCFullYear(), q * 3 + 3, 0)).toISOString().slice(0, 10),
  };
}

export interface ReturnLines {
  /** AU BAS: 1B GST on purchases, G10, G11, W1, W2 (null fields for other markets). */
  b1: number; g10: number; g11: number; w1: number; w2: number;
  /** CA GST/HST return line 108 (ITCs). */
  itc: number;
}
/** The market's sales-tax return for the quarter holding `iso` (AU BAS / CA GST-HST); zeros for US (no return). */
export async function returnLines(page: Page, jurisdiction: string, iso: string = todayIso()): Promise<ReturnLines> {
  const { periodStart, periodEnd } = quarterOf(iso);
  const zero: ReturnLines = { b1: 0, g10: 0, g11: 0, w1: 0, w2: 0, itc: 0 };
  if (jurisdiction === 'au') {
    const res = await api(page).get(`${TAX}/au/bas-return?periodStart=${periodStart}&periodEnd=${periodEnd}`);
    expectOk(res, `BAS ${periodStart}`);
    const d = res.data.data;
    return { ...zero, b1: d.label1BGstOnPurchasesCents, g10: d.g10CapitalPurchasesCents, g11: d.g11NonCapitalPurchasesCents, w1: d.w1TotalWagesCents, w2: d.w2PaygWithheldCents };
  }
  if (jurisdiction === 'ca') {
    const res = await api(page).get(`${TAX}/ca/gst-hst-return?periodStart=${periodStart}&periodEnd=${periodEnd}`);
    expectOk(res, `GST/HST return ${periodStart}`);
    return { ...zero, itc: res.data.data.line108ItcCents };
  }
  return zero;
}
export function linesDelta(a: ReturnLines, b: ReturnLines): ReturnLines {
  return { b1: b.b1 - a.b1, g10: b.g10 - a.g10, g11: b.g11 - a.g11, w1: b.w1 - a.w1, w2: b.w2 - a.w2, itc: b.itc - a.itc };
}

export async function expenseIdsByQuery(page: Page, q: string): Promise<string[]> {
  const res = await api(page).get(`${EXPENSE}/expenses?q=${encodeURIComponent(q)}&limit=100`);
  expectOk(res, `expenses q=${q}`);
  return (res.data.data as Array<{ id: string }>).map((r) => r.id);
}

/** Send one chat turn on the web channel; the reply and the skill that handled it. */
export async function say(page: Page, text: string): Promise<{ message: string; skillUsed?: string; [k: string]: unknown }> {
  const res = await api(page).post(CHAT, { channel: 'web', text });
  expect(res.status, `chat: ${text}`).toBe(200);
  return res.data.data;
}

/** Void every live payment of a bill, then the bill (the only order the engine allows). Never throws. */
export async function unwindBill(page: Page, id: string): Promise<void> {
  try {
    const got = await api(page).get(`${EXPENSE}/bills/${id}`);
    if (got.status !== 200) return;
    for (const p of (got.data.data.payments as Array<{ id: string; voidedAt: string | null }>).filter((x) => !x.voidedAt)) {
      const r = await api(page).delete(`${EXPENSE}/bills/${id}/payments/${p.id}`);
      if (r.status >= 400) console.error(`[programme e2e] could not void payment ${p.id} of bill ${id}: ${r.status}`);
    }
    if (got.data.data.status !== 'cancelled') {
      const r = await api(page).delete(`${EXPENSE}/bills/${id}`);
      if (r.status >= 400) console.error(`[programme e2e] could not void bill ${id}: ${r.status}`);
    }
  } catch (err) {
    console.error(`[programme e2e] could not unwind bill ${id}:`, err);
  }
}
