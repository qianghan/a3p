import { db } from './db/client.js';
import { getTaxReviewPack } from '@agentbook/jurisdictions/tax-review-loader';
import type { ComputedFilingTotals, CriticalField } from '@agentbook/jurisdictions/interfaces';
import { usTaxBrackets } from '@agentbook/jurisdictions/us/tax-brackets';
import { caTaxBrackets } from '@agentbook/jurisdictions/ca/tax-brackets';
import { auTaxBrackets } from '@agentbook/jurisdictions/au/tax-brackets';
import type { TaxBracketProvider } from '@agentbook/jurisdictions/interfaces';

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
