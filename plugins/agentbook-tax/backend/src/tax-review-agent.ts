import { db } from './db/client.js';
import { getTaxReviewPack } from '@agentbook/jurisdictions/tax-review-loader';
import type { ComputedFilingTotals, CriticalField } from '@agentbook/jurisdictions/interfaces';
import { usTaxBrackets } from '@agentbook/jurisdictions/us/tax-brackets';
import { caTaxBrackets } from '@agentbook/jurisdictions/ca/tax-brackets';
import { auTaxBrackets } from '@agentbook/jurisdictions/au/tax-brackets';
import type { TaxBracketProvider } from '@agentbook/jurisdictions/interfaces';
import { updateFilingField } from './tax-filing.js';
import { submitFiling } from './tax-efiling.js';
import { createHash } from 'node:crypto';
import { formatCurrency } from '@agentbook/i18n';

// Local copy, deliberately not a cross-package import — see this task's
// Interfaces note on why (Global Constraint 10's precedent).
function cleanJson(raw: string): string {
  let s = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first > 0 || (last >= 0 && last < s.length - 1)) {
    if (first >= 0 && last > first) s = s.slice(first, last + 1);
  }
  return s;
}

export type CallGeminiFn = (systemPrompt: string, userMessage: string, maxTokens?: number) => Promise<string | null>;

// Local copy of language.ts's languageDirective()/localeLanguageName() —
// verbatim, not reinvented — same Global Constraint 10 precedent as
// cleanJson above: both are pure, dependency-free functions, and
// plugins/agentbook-core/backend is a separate package. Keeping the exact
// wording matters: it's the one instruction every other chat prompt in
// this codebase already shares, and a subtly different rewording here
// would mean two competing "how to mirror the user's language" texts.
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', fr: 'French', es: 'Spanish', zh: 'Chinese', de: 'German',
  pt: 'Portuguese', it: 'Italian', ja: 'Japanese', ko: 'Korean', hi: 'Hindi',
  ar: 'Arabic', vi: 'Vietnamese', th: 'Thai', nl: 'Dutch', pl: 'Polish', ru: 'Russian',
};
function localeLanguageName(locale: string | null | undefined): string | null {
  if (typeof locale !== 'string' || !locale.trim()) return null;
  const primary = locale.trim().toLowerCase().split(/[-_]/)[0];
  return LANGUAGE_NAMES[primary] ?? null;
}
function languageDirective(locale: string | null | undefined): string {
  const preferred = localeLanguageName(locale);
  return [
    'LANGUAGE: Reply in the same language the user wrote their message in.',
    'If their message is too short to tell (for example "yes", "ok", "是的", "oui"),',
    'continue in the language the conversation has been using so far' +
      (preferred ? `, and otherwise use ${preferred}.` : '.'),
    'Never switch language mid-conversation unless the user does.',
  ].join(' ');
}

// Direct imports, not a generic jurisdiction-pack loader — mirrors the exact
// existing pattern in tax-fast-track-draft-compute.ts.
const TAX_BRACKET_PROVIDERS: Record<string, TaxBracketProvider> = {
  us: usTaxBrackets,
  ca: caTaxBrackets,
  au: auTaxBrackets,
};

// Field IDs each jurisdiction's forms use for the two totals that feed
// calculateTax(). This is the one place this module needs to know a
// concrete field name per jurisdiction — everything else goes through
// TaxReviewPack.criticalFields()/summaryPrompt(), which are jurisdiction-
// agnostic to this module's own code.
const TAXABLE_INCOME_FIELD: Record<string, { formCode: string; fieldId: string }> = {
  ca: { formCode: 'T1', fieldId: 'taxable_income_26000' },
  us: { formCode: '1040', fieldId: 'taxable_income' },
  au: { formCode: 'IndividualReturn', fieldId: 'taxable_income' },
};
const TOTAL_INCOME_FIELD: Record<string, { formCode: string; fieldId: string }> = {
  ca: { formCode: 'T1', fieldId: 'total_income_15000' },
  us: { formCode: '1040', fieldId: 'total_income_9' },
  au: { formCode: 'IndividualReturn', fieldId: 'taxable_income' }, // AU forms don't split these — same field
};

export function computeFilingTotals(
  jurisdiction: string, region: string, taxYear: number, forms: Record<string, Record<string, any>>,
): ComputedFilingTotals {
  const taxableField = TAXABLE_INCOME_FIELD[jurisdiction];
  const totalField = TOTAL_INCOME_FIELD[jurisdiction];
  const taxableIncomeCents = taxableField ? forms[taxableField.formCode]?.[taxableField.fieldId] : undefined;
  const totalIncomeCents = totalField ? forms[totalField.formCode]?.[totalField.fieldId] : undefined;

  const provider = TAX_BRACKET_PROVIDERS[jurisdiction];
  let taxPayableCents: number | undefined;
  if (provider && typeof taxableIncomeCents === 'number') {
    taxPayableCents = provider.calculateTax(taxableIncomeCents, taxYear, undefined, region).taxCents;
  }

  return { totalIncomeCents, taxableIncomeCents, taxPayableCents };
}

/**
 * Independent of consultation-review.ts by design (Global Constraint 4) —
 * a smaller problem (does every $ figure match one of THIS filing's own
 * computed totals) than consultation-review.ts's generic ledger-facts
 * problem, so it gets its own small, purpose-built check rather than
 * sharing that module's more general verifier.
 */
export function verifyGroundedNumbers(text: string, totals: ComputedFilingTotals): boolean {
  const dollarMatches = text.match(/\$[\d,]+(?:\.\d{2})?/g) || [];
  if (dollarMatches.length === 0) return true; // nothing to verify
  const groundedDollars = new Set(
    Object.values(totals)
      .filter((v): v is number => typeof v === 'number')
      .map((cents) => Math.round(cents / 100)),
  );
  for (const match of dollarMatches) {
    const n = Number(match.replace(/[$,]/g, ''));
    if (!groundedDollars.has(Math.round(n))) return false;
  }
  return true;
}

function fmtGeneric(cents?: number): string {
  if (cents == null) return 'not available';
  return `$${(cents / 100).toLocaleString()}`;
}

function deterministicFallbackSummary(totals: ComputedFilingTotals): string {
  return `Here's where your filing stands: total income ${fmtGeneric(totals.totalIncomeCents)}, taxable income ${fmtGeneric(totals.taxableIncomeCents)}, estimated tax payable ${fmtGeneric(totals.taxPayableCents)}. Reply with a number to change, ask a question about any figure, or say "looks good" to submit.`;
}

// Jurisdiction picks the currency code passed to formatCurrency; locale
// (the tenant's own AbTenantConfig.locale) picks the formatting style. A
// tenant with no locale set falls back to the jurisdiction's own default
// market locale — unchanged formatting from before this feature existed,
// not a regression for the common case of an unset locale.
const DEFAULT_LOCALE_FOR_JURISDICTION: Record<string, string> = { ca: 'en-CA', us: 'en-US', au: 'en-AU' };

export async function startReview(
  tenantId: string, taxYear: number, callGemini: CallGeminiFn,
): Promise<{ message: string; criticalFields: CriticalField[]; computedTotals: ComputedFilingTotals }> {
  const filing = await db.abTaxFiling.findFirst({
    where: { tenantId, taxYear, filingType: 'personal_return' },
  });
  if (!filing) throw new Error(`No filing found for tenant ${tenantId} / year ${taxYear}`);

  const forms = (filing.forms as Record<string, Record<string, any>>) || {};
  const totals = computeFilingTotals(filing.jurisdiction, filing.region, taxYear, forms);
  const pack = getTaxReviewPack(filing.jurisdiction);
  const criticalFields = pack.criticalFields(forms);

  const config = await db.abTenantConfig.findFirst({ where: { userId: tenantId } });
  const locale = config?.locale || DEFAULT_LOCALE_FOR_JURISDICTION[filing.jurisdiction] || 'en-US';
  const personalProfileContext = ''; // Task 13 wires the real buildPersonalProfileContext() call at the HTTP boundary; kept out of this pure-DB-and-LLM module to avoid a new cross-plugin dependency here.

  const prompt = languageDirective(locale) + '\n\n' + pack.summaryPrompt({ forms, computedTotals: totals, personalProfileContext, locale });
  const raw = await callGemini(prompt, 'Summarize this filing for review.', 400);

  let message: string;
  if (raw) {
    try {
      const parsed = pack.parseSummary(JSON.parse(cleanJson(raw)));
      message = verifyGroundedNumbers(parsed.summaryText, totals)
        ? parsed.summaryText
        : deterministicFallbackSummary(totals);
    } catch {
      message = deterministicFallbackSummary(totals);
    }
  } else {
    message = deterministicFallbackSummary(totals);
  }

  await db.abTaxFilingReview.upsert({
    where: { tenantId_taxYear: { tenantId, taxYear } },
    create: { tenantId, taxYear, status: 'summarizing', summaryText: message },
    update: { status: 'summarizing', summaryText: message, awaitingFieldId: null, confirmedAt: null },
  });

  return { message, criticalFields, computedTotals: totals };
}

// Deliberately not a cross-package import of apps/web-next's
// money-validation.ts — that package boundary doesn't resolve from a
// plugin backend (Global Constraint 10). This is intentionally small.
const MAX_MONEY_CENTS = 1_000_000_000; // $10,000,000.00
function parseMoneyInputCents(text: string): number | null {
  const cleaned = text.replace(/[^0-9.-]/g, '');
  if (!cleaned) return null;
  const dollars = Number(cleaned);
  if (!Number.isFinite(dollars) || dollars < 0) return null;
  const cents = Math.round(dollars * 100);
  return cents >= 0 && cents <= MAX_MONEY_CENTS ? cents : null;
}

type ReplyIntent =
  | { kind: 'confirm' }
  | { kind: 'cancel' }
  | { kind: 'field_value'; cents: number }
  | { kind: 'field_edit_request'; field: { formCode: string; fieldId: string }; cents: number }
  | { kind: 'question'; field?: { formCode: string; fieldId: string } }
  | { kind: 'unclear' };

const CONFIRM_RE = /\b(yes|confirm|submit|looks good|go ahead|that'?s (right|correct)|correct|proceed)\b/i;
const CANCEL_RE = /\b(no|cancel|stop|not yet|wait)\b/i;
const QUESTION_RE = /\b(why|how|what|explain)\b/i;

function classifyReply(
  text: string,
  awaitingField: { formCode: string; fieldId: string } | null,
  criticalFields: { formCode: string; fieldId: string; label: string }[],
): ReplyIntent {
  const trimmed = text.trim();

  if (awaitingField) {
    const cents = parseMoneyInputCents(trimmed);
    if (cents !== null) return { kind: 'field_value', cents };
    // Fall through — a reply to "what's the new value?" that isn't a
    // number is treated as unclear, not silently ignored.
  }

  if (CONFIRM_RE.test(trimmed)) return { kind: 'confirm' };
  if (CANCEL_RE.test(trimmed)) return { kind: 'cancel' };

  const lower = trimmed.toLowerCase();
  // Match on the full label, not just its first word — several critical
  // fields across jurisdictions share a first word (e.g. CA's "Total
  // business expenses" vs "Total income"), so a first-word-only match
  // would resolve to whichever field happens to sort first rather than
  // the one the user actually named.
  const matchedField = criticalFields.find((f) => lower.includes(f.label.toLowerCase()));
  const cents = parseMoneyInputCents(trimmed);

  if (matchedField && cents !== null) {
    return { kind: 'field_edit_request', field: { formCode: matchedField.formCode, fieldId: matchedField.fieldId }, cents };
  }
  if (QUESTION_RE.test(trimmed)) {
    return { kind: 'question', field: matchedField ? { formCode: matchedField.formCode, fieldId: matchedField.fieldId } : undefined };
  }
  return { kind: 'unclear' };
}

function hashForms(forms: Record<string, Record<string, any>>): string {
  return createHash('sha256').update(JSON.stringify(forms)).digest('hex');
}

export async function hasConfirmedFreshReview(tenantId: string, taxYear: number): Promise<boolean> {
  const review = await db.abTaxFilingReview.findFirst({ where: { tenantId, taxYear } });
  if (!review || review.status !== 'confirmed' || !review.reviewedFormsHash) return false;

  const filing = await db.abTaxFiling.findFirst({ where: { tenantId, taxYear, filingType: 'personal_return' } });
  if (!filing) return false;

  const currentHash = hashForms((filing.forms as Record<string, Record<string, any>>) || {});
  return currentHash === review.reviewedFormsHash;
}

export async function getActiveReviewForTenant(tenantId: string): Promise<{ taxYear: number } | null> {
  const review = await db.abTaxFilingReview.findFirst({
    where: { tenantId, status: { in: ['summarizing', 'awaiting_edit'] } },
    orderBy: { updatedAt: 'desc' },
  });
  return review ? { taxYear: review.taxYear } : null;
}

/**
 * Writes one field, recomputes totals, and clears any pending
 * awaiting-edit state — shared executor for both the chat state machine's
 * field-edit branches below AND the web review tab's structured
 * POST .../review/edit-field route (Task 13). Never guesses a field or
 * value; the caller (chat intent classification, or a web form input)
 * already knows exactly which one.
 */
const CURRENCY_FOR_JURISDICTION: Record<string, string> = { ca: 'CAD', us: 'USD', au: 'AUD' };

export async function applyFieldEdit(
  tenantId: string, taxYear: number, formCode: string, fieldId: string, cents: number,
): Promise<{ message: string; computedTotals: ComputedFilingTotals }> {
  await updateFilingField(tenantId, taxYear, formCode, fieldId, cents);

  const filing = await db.abTaxFiling.findFirst({ where: { tenantId, taxYear, filingType: 'personal_return' } });
  if (!filing) throw new Error(`No filing found for tenant ${tenantId} / year ${taxYear}`);
  const forms = (filing.forms as Record<string, Record<string, any>>) || {};
  const computedTotals = computeFilingTotals(filing.jurisdiction, filing.region, taxYear, forms);

  const review = await db.abTaxFilingReview.findFirst({ where: { tenantId, taxYear } });
  if (review) {
    await db.abTaxFilingReview.update({ where: { id: review.id }, data: { status: 'summarizing', awaitingFieldId: null } });
  }

  const config = await db.abTenantConfig.findFirst({ where: { userId: tenantId } });
  const locale = config?.locale || DEFAULT_LOCALE_FOR_JURISDICTION[filing.jurisdiction] || 'en-US';
  const currency = CURRENCY_FOR_JURISDICTION[filing.jurisdiction] || 'USD';
  return { message: `Updated to ${formatCurrency(cents, locale, currency)}. Anything else, or reply "looks good" to submit?`, computedTotals };
}

/**
 * Marks the review confirmed (hashing the CURRENT forms, so a later edit
 * through any other path makes hasConfirmedFreshReview go stale
 * automatically) and calls the real submitFiling() in the same turn —
 * shared executor for the chat 'confirm' intent below AND the web review
 * tab's structured POST .../review/confirm route (Task 13).
 */
export async function confirmAndSubmit(tenantId: string, taxYear: number): Promise<{ message: string; filed: boolean }> {
  const filing = await db.abTaxFiling.findFirst({ where: { tenantId, taxYear, filingType: 'personal_return' } });
  if (!filing) throw new Error(`No filing found for tenant ${tenantId} / year ${taxYear}`);
  const forms = (filing.forms as Record<string, Record<string, any>>) || {};

  const review = await db.abTaxFilingReview.findFirst({ where: { tenantId, taxYear } });
  if (review) {
    const reviewedFormsHash = hashForms(forms);
    await db.abTaxFilingReview.update({
      where: { id: review.id },
      data: { status: 'confirmed', confirmedAt: new Date(), reviewedFormsHash, awaitingFieldId: null },
    });
  }

  const result = await submitFiling(tenantId, taxYear);
  if (result.success) return { message: `✅ ${result.data.message}`, filed: !!result.data.filed };
  return { message: `❌ ${result.error}`, filed: false };
}

export async function answerReviewMessage(
  tenantId: string, taxYear: number, text: string, callGemini: CallGeminiFn,
): Promise<{ message: string }> {
  const filing = await db.abTaxFiling.findFirst({ where: { tenantId, taxYear, filingType: 'personal_return' } });
  if (!filing) throw new Error(`No filing found for tenant ${tenantId} / year ${taxYear}`);

  const review = await db.abTaxFilingReview.findFirst({ where: { tenantId, taxYear } });
  if (!review) throw new Error(`No active review for tenant ${tenantId} / year ${taxYear} — call startReview first`);

  const forms = (filing.forms as Record<string, Record<string, any>>) || {};
  const pack = getTaxReviewPack(filing.jurisdiction);
  const criticalFields = pack.criticalFields(forms);

  const config = await db.abTenantConfig.findFirst({ where: { userId: tenantId } });
  const locale = config?.locale || DEFAULT_LOCALE_FOR_JURISDICTION[filing.jurisdiction] || 'en-US';

  const awaitingField = review.awaitingFieldId
    ? (() => { const [formCode, fieldId] = review.awaitingFieldId!.split(':'); return { formCode, fieldId }; })()
    : null;

  const intent = classifyReply(text, awaitingField, criticalFields);

  if (intent.kind === 'cancel') {
    await db.abTaxFilingReview.update({ where: { id: review.id }, data: { status: 'summarizing', awaitingFieldId: null } });
    return { message: "No problem — I've cancelled the review and nothing was submitted. Let me know when you'd like to pick it back up." };
  }

  if (intent.kind === 'field_value' && awaitingField) {
    return applyFieldEdit(tenantId, taxYear, awaitingField.formCode, awaitingField.fieldId, intent.cents);
  }

  if (intent.kind === 'field_edit_request') {
    return applyFieldEdit(tenantId, taxYear, intent.field.formCode, intent.field.fieldId, intent.cents);
  }

  if (intent.kind === 'question') {
    const field = intent.field
      ? criticalFields.find((f) => f.formCode === intent.field!.formCode && f.fieldId === intent.field!.fieldId)!
      : { formCode: '_overall', fieldId: '_overall', label: 'your filing', currentValue: null };
    const totals = computeFilingTotals(filing.jurisdiction, filing.region, taxYear, forms);
    const prompt = languageDirective(locale) + '\n\n' + pack.explainFieldPrompt({ field, forms, computedTotals: totals, personalProfileContext: '', locale, question: text });
    const raw = await callGemini(prompt, 'Answer this question.', 300);
    if (!raw) return { message: "I couldn't generate an answer just now — you can ask again, change a number, or say \"looks good\" to submit." };
    try {
      const parsed = pack.parseFieldExplanation(JSON.parse(cleanJson(raw)));
      if (!verifyGroundedNumbers(parsed.explanation, totals)) {
        return { message: "I can't confirm that figure against your filing's real numbers, so I won't guess — you can ask a more specific question, change a number, or say \"looks good\" to submit." };
      }
      return { message: parsed.explanation };
    } catch {
      return { message: "I couldn't generate an answer just now — you can ask again, change a number, or say \"looks good\" to submit." };
    }
  }

  if (intent.kind === 'confirm') {
    return confirmAndSubmit(tenantId, taxYear);
  }

  // unclear — deterministic, no LLM call.
  return { message: 'I can update a number, answer a question about your filing, or you can say "looks good" to submit — what would you like to do?' };
}
