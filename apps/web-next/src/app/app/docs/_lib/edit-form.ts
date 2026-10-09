import { parseAmountToCents } from '@agentbook/i18n';
import type { MobileDoc } from '@/lib/mobile/types';
import { MAX_AMOUNT_CENTS } from '@/lib/mobile/receipt-limits';
import { formatAmountInput } from '../../_lib/format';

export interface FormState { amount: string; vendor: string; date: string; description: string; isPersonal: boolean }
export type PatchBody = Partial<{ amountCents: number; vendor: string; date: string; description: string; isPersonal: boolean }>;
/**
 * The catalog keys a form error can name. A union (not `string`) so the page can map each one to a literal
 * `t('…')` call: the hygiene guard forbids a `t(variable)`.
 */
export type FormErrorKey = 'mobile.docs.amount_invalid' | 'mobile.docs.amount_ambiguous' | 'mobile.docs.vendor_required';
export interface FormError { key: FormErrorKey; params?: Record<string, string> }

export function toForm(doc: MobileDoc, locale: string): FormState {
  return {
    amount: formatAmountInput(doc.amountCents, locale),
    vendor: doc.vendorName ?? '',
    date: (doc.date ?? '').slice(0, 10),
    description: doc.description ?? '',
    isPersonal: doc.isPersonal,
  };
}

export function isDirty(doc: MobileDoc, form: FormState, locale: string): boolean {
  const a = toForm(doc, locale);
  return a.amount !== form.amount.trim() || a.vendor !== form.vendor.trim() || a.date !== form.date
    || a.description !== form.description.trim() || a.isPersonal !== form.isPersonal;
}

/**
 * The PATCH body for what changed, or the reason it cannot be sent.
 *
 * Only changed fields are sent: an amount the user never touched must not be re-sent (the server re-posts the
 * journal entry of a booked expense whenever amount/date/category/personal change). The amount must be a
 * positive integer number of cents that fits the 32-bit column; the server would answer 400 or 500 otherwise.
 */
export function diffForm(doc: MobileDoc, form: FormState, locale: string): { body: PatchBody; error: FormError | null } {
  const initial = toForm(doc, locale);
  const body: PatchBody = {};
  if (form.amount.trim() !== initial.amount) {
    const parsed = parseAmountToCents(form.amount, locale);
    if (!parsed.ok || !Number.isSafeInteger(parsed.cents) || parsed.cents <= 0 || parsed.cents > MAX_AMOUNT_CENTS) {
      return { body: {}, error: { key: 'mobile.docs.amount_invalid' } };
    }
    if (parsed.ambiguous) return { body: {}, error: { key: 'mobile.docs.amount_ambiguous', params: { formatted: parsed.formatted } } };
    if (parsed.cents !== doc.amountCents) body.amountCents = parsed.cents;
  }
  const vendor = form.vendor.trim();
  // An empty vendor is never sent: the viewer cannot clear one, so say so instead of silently ignoring the edit.
  if (!vendor && (doc.vendorName ?? '') !== '') return { body: {}, error: { key: 'mobile.docs.vendor_required' } };
  if (vendor && vendor !== (doc.vendorName ?? '')) body.vendor = vendor;
  if (form.date && form.date !== initial.date) body.date = form.date;
  const description = form.description.trim();
  if (description !== (doc.description ?? '')) body.description = description;
  if (form.isPersonal !== doc.isPersonal) body.isPersonal = form.isPersonal;
  return { body, error: null };
}
