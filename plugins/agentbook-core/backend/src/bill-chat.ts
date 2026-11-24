/**
 * PR 3d.3 — chat surfaces for accounts payable: record-bill, pay-bill,
 * query-payables. Patterns are lowercase (selectSkillByPatterns tests the
 * lowercased message) and mirrored in consultation-triage.ts so a
 * question-shaped phrasing reaches the skill, not the advisor.
 *
 * Pure helpers only: parsing a bill out of a message, choosing which open
 * bill a "pay" message means, and aging buckets. The handlers in server.ts
 * call the Next bills routes (which call lib/purchases) — no direct writes.
 */

/** "add a bill from Hydro $84 due Dec 15", "pay later", "facture fournisseur", "记录账单". */
export const RECORD_BILL_PATTERN =
  "\\b(record|add|enter|log|save|create|new)\\b.{0,25}\\bbills?\\b|\\bbill from\\b|\\bpay later\\b|\\bvendor bill\\b|\\b(i|we) owe\\b.{0,40}\\d|" +
  "\\b(ajoute[rz]?|enregistre[rz]?|saisi[rs]?|cr[ée]e[rz]?)(?![a-z]).{0,25}\\bfactures? (de |d['’])?(fournisseur|[àa] payer)|\\bfactures? (de |d['’])?fournisseur\\b.{0,60}\\d|\\bpayer plus tard\\b|\\bje dois\\b.{0,40}\\d|" +
  "(记录|添加|录入|新增|记一笔).{0,14}(账单|应付)|稍后(付款|支付)|我欠[^0-9多谁哪]{1,10}\\d";

/** "pay the Hydro bill", "paid the rent bill $1,200", "mark the Telus bill paid". */
export const PAY_BILL_PATTERN =
  "\\b(pay|paid|settle|settled)\\b.{0,30}\\bbills?\\b|\\bmark\\b.{0,30}\\bbills?\\b.{0,15}\\bpaid\\b|\\bbills?\\b.{0,30}\\b(is|was) paid\\b|" +
  "\\b(payer|pay[ée]e?|r[ée]gler|r[ée]gl[ée]e?)(?![a-z]).{0,30}\\bfactures? (de |d['’])?(fournisseur|[àa] payer)|\\bfacture\\b.{0,30}\\b(fournisseur)\\b.{0,20}\\bpay[ée]e\\b|" +
  "(支付|付清|付了|结清|还清).{0,10}账单|账单.{0,10}(已付|付清|已支付)";

/** "what bills are due", "accounts payable", "who do I owe", "AP aging". */
export const QUERY_PAYABLES_PATTERN =
  // Review I3: the old manage-bills phrasings ("my rent is due friday", "what do I owe?").
  "\\brent\\b.{0,20}\\bdue\\b|^\\s*(what|how much) do (i|we) owe\\b(?!.{0,40}\\d)|\\bbills?\\b.{0,30}\\bdue\\b|\\boverdue bills?\\b|\\b(open|unpaid|upcoming|outstanding) bills?\\b|\\baccounts payable\\b|\\bpayables?\\b|\\bap aging\\b|\\bwho do (i|we) owe\\b|\\bwhat do (i|we) owe\\b.{0,30}\\b(vendors?|suppliers?|bills?)\\b|\\b(do|how much do) (i|we) owe\\b.{0,30}\\b(vendors?|suppliers?|bills?)\\b|" +
  "\\bloyer\\b.{0,20}\\bd[ûu](?![a-z])|\\bcombien (est-ce que )?je dois\\b(?!.{0,40}\\d)|qu['’]est-ce que je dois(\\s*\\?|\\s+(ce|cette|aux?|à)\\b)|\\bfactures? ([àa] payer|fournisseurs?|impay[ée]es|en retard|[àa] [ée]ch[ée]ance)\\b|\\bcomptes fournisseurs\\b|\\bcomptes cr[ée]diteurs\\b|\\b(qui|combien) (est-ce que )?je dois\\b.{0,30}\\bfournisseurs?\\b|" +
  "房租.{0,8}(到期|该交|要交)|我欠(多少|谁|哪些)|应付账款|应付款|待付账单|未付账单|账单.{0,8}(到期|逾期)|逾期账单|欠供应商";

/** Not AP: taxes owed to a revenue authority, customer invoices, a client paying us. */
export const PAYABLES_EXCLUDE = [
  'owe.*tax', 'tax.*owe', 'in taxes', '\\bcra\\b', '\\birs\\b', '\\bato\\b',
  '\\binvoice\\b', '\\bclient\\b', '\\bcustomer\\b',
];

const MONTHS_EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTHS_FR = ['janv', 'f[ée]vr', 'mars', 'avr', 'mai', 'juin', 'juil', 'ao[uû]t', 'sept', 'oct', 'nov', 'd[ée]c'];
const DAYS_EN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAYS_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const DAYS_ZH = ['日', '一', '二', '三', '四', '五', '六'];

const utcDay = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d, 12));
const startOf = (now: Date) => utcDay(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
/** A month/day with no year means the next such date on or after today. */
function nextMonthDay(now: Date, m: number, d: number): Date {
  const today = startOf(now);
  const c = utcDay(today.getUTCFullYear(), m, d);
  return c < today ? utcDay(today.getUTCFullYear() + 1, m, d) : c;
}
function nextWeekday(now: Date, dow: number): Date {
  const today = startOf(now);
  const delta = ((dow - today.getUTCDay() + 7) % 7) || 7;
  return new Date(today.getTime() + delta * 86_400_000);
}

/**
 * The due date a message states, or null. ISO, "Dec 15", "15 December",
 * "15 décembre", "12月15日", "in 10 days", "dans 10 jours", "10天后",
 * weekday names (next occurrence), "tomorrow"/"demain"/"明天".
 */
export function parseDueDate(text: string, now: Date = new Date()): Date | null {
  const s = text.toLowerCase();
  let m = s.match(/\b(20\d\d)-(\d{1,2})-(\d{1,2})\b/);
  if (m) return utcDay(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  if (m) return nextMonthDay(now, +m[1] - 1, +m[2]);
  const enMonth = `(${MONTHS_EN.join('|')})[a-z]*\\.?`;
  m = s.match(new RegExp(`\\b${enMonth}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`));
  if (m) return nextMonthDay(now, MONTHS_EN.indexOf(m[1]), +m[2]);
  m = s.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${enMonth}`));
  if (m) return nextMonthDay(now, MONTHS_EN.indexOf(m[2]), +m[1]);
  for (let i = 0; i < MONTHS_FR.length; i++) {
    m = s.match(new RegExp(`\\b(\\d{1,2})(?:er)?\\s+${MONTHS_FR[i]}`));
    if (m) return nextMonthDay(now, i, +m[1]);
  }
  m = s.match(/\bin\s+(\d{1,3})\s+days?\b|\bdans\s+(\d{1,3})\s+jours?\b|(\d{1,3})\s*天(?:后|內|内)/);
  if (m) return new Date(startOf(now).getTime() + Number(m[1] ?? m[2] ?? m[3]) * 86_400_000);
  if (/\btomorrow\b|\bdemain\b|明天/.test(s)) return new Date(startOf(now).getTime() + 86_400_000);
  for (let i = 0; i < 7; i++) {
    if (new RegExp(`\\b${DAYS_EN[i]}\\b|\\b${DAYS_FR[i]}\\b|(?:周|星期|礼拜)${DAYS_ZH[i]}`).test(s)) return nextWeekday(now, i);
  }
  if (/(?:周|星期)(?:日|天)/.test(s)) return nextWeekday(now, 0);
  return null;
}

const STOP = /\s+(?:for|of|due|on|at|by|pour|de|due|d[ue]|à|le|la|payable|échéance|of)\b.*$|\s*[$€£¥]?\s*\d.*$/i;
function clean(v: string | undefined): string | null {
  if (!v) return null;
  const out = v.replace(STOP, '').replace(/^(?:the|my|our|a|an|la|le|les|ma|mon|une?)\s+/i, '').replace(/[.,!?;:'"’]+$/, '').trim();
  if (!out || out.length > 60 || /^\d/.test(out)) return null;
  return out;
}

/** The vendor a bill message names, or null. */
export function parseBillVendor(text: string): string | null {
  const t = text.trim();
  const tries: RegExp[] = [
    /\bbill\s+from\s+([^\n]+)/i,
    /\bfactures?\s+(?:de\s+)?fournisseur\s+(?:de\s+|d['’])\s*([^\n]+)/i,
    /\bfactures?\s+(?:à|a)\s+payer\s+(?:de\s+|d['’])\s*([^\n]+)/i,
    /\bfactures?\s+(?:de|d['’])\s*([A-Z][^\n]+)/,
    /\bowe\s+(?:the\s+|my\s+|our\s+)?([^\d$\n]+?)\s+\$?\d/i,
    /\bje dois\s+[\d\s.,]+\s*\$?\s*(?:à|au|aux)\s+(?:la\s+|le\s+|l['’]|mon\s+|ma\s+)?([^\d\n]+)/i,
    /我欠\s*([^\d\s，,。]+?)\s*\d/,
    /\bowe\s+([A-Z][^\n]+)/,
    /来自\s*([^\s，,。的]+)/,
    /账单\s+([A-Za-z][\w&'’ -]{0,30}?)\s+\d/,
    /([A-Za-z一-鿿][^\s，,。]{0,20}?)\s*的?(?:账单|帐单)/,
    /\b(?:the|my|our|a|an)\s+([A-Za-z][\w&'’ -]{0,30}?)\s+bill\b/i,
    /\b([A-Z][\w&'’-]{1,30})\s+bill\b/,
  ];
  for (const re of tries) {
    const m = t.match(re);
    const v = clean(m?.[1]);
    if (v && !/^(?:a|an|the|my|new|this|that|last|next|un|une|le|la)$/i.test(v) && !/^(记录|添加|录入|新增|支付|付清)/.test(v)) {
      return v.replace(/^(?:记录|添加|录入|新增|记一笔|支付|付清|付了|结清|一笔|一张)+/, '') || null;
    }
  }
  return null;
}

/**
 * The amount a bill message states. parseAmountCents first (shared with
 * record-expense), then the fr-CA order "120 $" / "84,50 $".
 */
export function parseBillAmount(text: string, parse: (t: string) => number | null): number | null {
  const a = parse(text);
  if (a) return a;
  const m = text.match(/(\d{1,3}(?:[ \u00a0\u202f]\d{3})*|\d+)(?:,(\d{1,2}))?\s*\$/);
  if (!m) {
    // Review I3: "I owe the landlord 1200" / "我欠房东1200元" — the number right
    // after an owe-phrase is the amount even without a currency sign.
    const o = text.match(/\b(?:owe|dois)\b\D{0,40}?(\d+)(?:[.,](\d{1,2}))?(?!\d)|欠\D{0,10}?(\d+)(?:\.(\d{1,2}))?/i);
    if (!o) return null;
    const whole = Number(o[1] ?? o[3]);
    const frac = o[2] ?? o[4];
    return whole * 100 + (frac ? Number(frac.padEnd(2, '0')) : 0) || null;
  }
  const whole = Number(m[1].replace(/[ \u00a0\u202f]/g, ''));
  const cents = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
  return whole * 100 + cents || null;
}

export interface OpenBillLike {
  id: string;
  vendorName: string;
  amountCents: number;
  paidCents?: number | null;
  dueDate: string | Date;
  status: string;
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9一-鿿]+/g, ' ').trim();

/**
 * Which open bill a pay message means. A vendor named in the message must
 * match (word-prefix, either direction); with no vendor named, only a sole
 * open bill qualifies. Returns all candidates so the handler can ask.
 */
export function chooseBillToPay(text: string, bills: OpenBillLike[]): OpenBillLike[] {
  const unpaid = bills.filter((b) => b.status === 'open' || b.status === 'partial');
  const msg = ` ${norm(text)} `;
  const hits = unpaid.filter((b) => {
    const v = norm(b.vendorName);
    if (!v) return false;
    if (msg.includes(` ${v} `)) return true;
    const first = v.split(' ')[0];
    return first.length >= 3 && msg.includes(` ${first}`);
  });
  if (hits.length) return hits;
  const vendor = parseBillVendor(text);
  if (vendor) return [];
  return unpaid;
}

export const outstanding = (b: OpenBillLike) => Math.max(0, b.amountCents - (b.paidCents ?? 0));

export type AgingKey = 'current' | 'd1_30' | 'd31_60' | 'd60_plus';
/** Same buckets as reports/ap-aging (lib/ap-aging bucketFor). */
export function agingBucket(due: Date, now: Date): AgingKey {
  const days = Math.floor((startOf(now).getTime() - startOf(due).getTime()) / 86_400_000);
  if (days <= 0) return 'current';
  if (days <= 30) return 'd1_30';
  if (days <= 60) return 'd31_60';
  return 'd60_plus';
}
