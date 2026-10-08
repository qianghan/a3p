/**
 * The Home banner's words for one alert.
 *
 * PURE ON PURPOSE — no React, and only a type import. The production e2e
 * (tests/e2e/mobile-app/home.spec.ts) imports this same function with the
 * same catalog to compute the exact sentence it expects on screen; a test that
 * re-implemented the copy would happily pass against a page rendering the
 * wrong sentence.
 *
 * Every catalog key below is a literal t('…') call so the /app hygiene guard
 * can prove each one resolves in en / fr-CA / zh-CN. The one exception is the
 * server-supplied action label (alert.action.labelKey), which the server emits
 * as a key; server-i18n-keys.test.ts proves it resolves.
 */
import type { MobileAlert } from '@/lib/mobile/types';

export type Translate = (key: string, params?: Record<string, string | number>) => string;
export type FormatCents = (cents: number) => string;

export interface AlertCopy {
  title: string;
  /** Button/link text; null when the alert has nowhere mobile to go. */
  actionLabel: string | null;
  /** In-app destination for target alerts; null for action alerts and for anything outside /app. */
  href: string | null;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** A link only ever points inside the mobile app — never at a desktop page (spec principle 4). */
export function mobileHref(target: MobileAlert['target'] | undefined): string | null {
  if (!target || typeof target.route !== 'string') return null;
  const route = target.route;
  if (!(route === '/app' || route.startsWith('/app/'))) return null;
  const query = target.query && Object.keys(target.query).length > 0 ? `?${new URLSearchParams(target.query).toString()}` : '';
  return `${route}${query}`;
}

function targetLabel(kind: MobileAlert['kind'], t: Translate): string {
  switch (kind) {
    case 'review_needed':
      return t('mobile.home.action.review');
    case 'uncategorized':
      return t('mobile.home.action.categorize');
    case 'receipts_missing':
      return t('mobile.home.action.add_receipts');
    default:
      return t('mobile.home.action.details');
  }
}

export function alertCopy(alert: MobileAlert, t: Translate, money: FormatCents): AlertCopy {
  const p = alert.params ?? {};
  const amount = p.amountCents === undefined || p.amountCents === null ? '' : money(num(p.amountCents));
  // `days` is signed: home.ts emits a negative value for an already-overdue bill.
  const signedDays = Math.round(num(p.days));
  const days = Math.max(0, signedDays);
  const count = Math.max(0, Math.round(num(p.count)));

  let title: string;
  switch (alert.kind) {
    case 'invoice_overdue':
      title = t('mobile.home.alert.invoice_overdue', { count: days, client: text(p.client) || t('mobile.home.alert.a_client'), amount });
      break;
    case 'tax_deadline':
      if (days === 0) title = t('mobile.home.alert.tax_deadline_today');
      else if (amount) title = t('mobile.home.alert.tax_deadline', { count: days, amount });
      else title = t('mobile.home.alert.tax_deadline_no_amount', { count: days });
      break;
    case 'bill_due': {
      const vendor = text(p.vendor) || t('mobile.home.alert.a_vendor');
      if (signedDays < 0) title = t('mobile.home.alert.bill_overdue', { count: -signedDays, vendor, amount });
      else if (days === 0) title = t('mobile.home.alert.bill_due_today', { vendor, amount });
      else title = t('mobile.home.alert.bill_due', { count: days, vendor, amount });
      break;
    }
    case 'receipts_missing':
      title = t('mobile.home.alert.receipts_missing', { count });
      break;
    case 'uncategorized':
      title = t('mobile.home.alert.uncategorized', { count });
      break;
    case 'review_needed':
      // home.ts raises this alert when there are pending-review rows OR fresh AI
      // suggestions, so `count` can be 0 while `suggestions` is not — never say "0 items".
      title = t('mobile.home.alert.review_needed', { count: count || Math.max(0, Math.round(num(p.suggestions))) });
      break;
    default:
      title = t('mobile.home.alert.generic');
  }

  // i18n-dynamic: the server emits this key (mobile.alerts.action_remind); server-i18n-keys.test.ts proves every emitted key resolves in en/fr-CA/zh-CN
  if (alert.action) return { title, actionLabel: t(alert.action.labelKey), href: null };
  const href = mobileHref(alert.target);
  return { title, actionLabel: href ? targetLabel(alert.kind, t) : null, href };
}
