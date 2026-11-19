/**
 * Employee profile: strict PUT schema, per-jurisdiction tax-id validation,
 * and the masked view every response uses (PR 4b, spec §5.5).
 *
 * The masked view is the ONLY shape an employee leaves the API in: the
 * AbEmployeeSensitive row is reduced to last4 / labels / presence flags,
 * ciphertext never appears.
 */

import { z } from 'zod';

const digits = (s: string) => s.replace(/[\s-]/g, '');

/** AU Tax File Number: 8 or 9 digits, ATO weighted checksum (sum % 11 === 0). */
export function isValidTfn(raw: string): boolean {
  const d = digits(raw);
  if (!/^\d{8,9}$/.test(d)) return false;
  const w = d.length === 9 ? [1, 4, 3, 7, 5, 8, 6, 9, 10] : [10, 7, 8, 4, 6, 3, 5, 1];
  const sum = d.split('').reduce((s, c, i) => s + Number(c) * w[i], 0);
  return sum % 11 === 0;
}

/** CA Social Insurance Number: 9 digits, Luhn checksum (CRA's sample 046 454 286 passes). */
export function isValidSin(raw: string): boolean {
  const d = digits(raw);
  if (!/^\d{9}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let n = Number(d[i]);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

/** US SSN: 9 digits; area not 000/666/9xx, group not 00, serial not 0000. */
export function isValidSsn(raw: string): boolean {
  const d = digits(raw);
  if (!/^\d{9}$/.test(d)) return false;
  const area = d.slice(0, 3), group = d.slice(3, 5), serial = d.slice(5);
  return area !== '000' && area !== '666' && area[0] !== '9' && group !== '00' && serial !== '0000';
}

/** A value echoed back from the masked view (e.g. `***-**-1234`, `••••1234`) — never overwrites. */
export function isMaskedInput(raw: string): boolean {
  return /[*•xX]/.test(raw);
}

export function validateTaxId(jurisdiction: string, raw: string): boolean {
  switch (jurisdiction) {
    case 'au': return isValidTfn(raw);
    case 'ca': return isValidSin(raw);
    case 'us': return isValidSsn(raw);
    default: return false;
  }
}

const dateish = z.union([z.coerce.date(), z.null()]);

/** PUT body. `.strict()` — unknown keys are a 400, not silently dropped. */
export const employeeUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().email().max(320).nullable(),
  type: z.enum(['w2', 'contractor_1099']),
  payType: z.enum(['salary', 'hourly']),
  payRateCents: z.number().int().min(0).max(1_000_000_000),
  payFrequency: z.enum(['weekly', 'biweekly', 'semimonthly', 'monthly']),
  jurisdiction: z.enum(['us', 'ca', 'uk', 'au']),
  region: z.string().max(10),
  filingStatus: z.string().max(40),
  allowances: z.number().int().min(0).max(99),
  phone: z.string().max(40).nullable(),
  address: z.string().max(500).nullable(),
  dateOfBirth: dateish,
  endDate: dateish,
  employmentBasis: z.enum(['full_time', 'part_time', 'casual']).nullable(),
  payAnchorDate: dateish,
  // AU
  taxFreeThreshold: z.boolean().nullable(),
  residency: z.enum(['resident', 'foreign', 'working_holiday']).nullable(),
  helpDebt: z.boolean().nullable(),
  // CA (TD1 claim amounts, cents)
  td1Federal: z.number().int().min(0).max(100_000_000).nullable(),
  td1Provincial: z.number().int().min(0).max(100_000_000).nullable(),
  cppExempt: z.boolean().nullable(),
  eiExempt: z.boolean().nullable(),
  // US
  extraWithholdingCents: z.number().int().min(0).max(100_000_000).nullable(),
  // Sensitive inputs — encrypted (taxId, bankAccount, superMemberNumber) or label-only.
  taxId: z.string().max(20),
  bankAccount: z.string().max(40),
  bankRoutingLabel: z.string().max(60).nullable(),
  superFundUsi: z.string().max(30).nullable(),
  superFundName: z.string().max(200).nullable(),
  superMemberNumber: z.string().max(40),
}).partial().strict();

export type EmployeeUpdate = z.infer<typeof employeeUpdateSchema>;

export const SENSITIVE_INPUT_KEYS = ['taxId', 'bankAccount', 'bankRoutingLabel', 'superFundUsi', 'superFundName', 'superMemberNumber'] as const;
/** Inputs that must be encrypted — these need EMPLOYEE_PII_ENCRYPTION_KEY. */
export const ENCRYPTED_INPUT_KEYS = ['taxId', 'bankAccount', 'superMemberNumber'] as const;
export type RevealField = typeof ENCRYPTED_INPUT_KEYS[number];

interface SensitiveRow {
  taxIdEnc?: string | null; taxIdLast4?: string | null;
  bankAccountEnc?: string | null; bankLast4?: string | null; bankRoutingLabel?: string | null;
  superFundUsi?: string | null; superFundName?: string | null; superMemberNumberEnc?: string | null;
}

/** The only outward shape of an employee. Ciphertext columns never pass through. */
export function maskEmployee<T extends Record<string, unknown>>(employee: T, sensitive?: SensitiveRow | null) {
  const { sensitive: _drop, ...rest } = employee as T & { sensitive?: unknown };
  const s = sensitive ?? ((employee as { sensitive?: SensitiveRow | null }).sensitive ?? null);
  return {
    ...rest,
    sensitive: {
      hasTaxId: Boolean(s?.taxIdEnc),
      taxIdLast4: s?.taxIdLast4 ?? null,
      hasBankAccount: Boolean(s?.bankAccountEnc),
      bankLast4: s?.bankLast4 ?? null,
      bankRoutingLabel: s?.bankRoutingLabel ?? null,
      superFundUsi: s?.superFundUsi ?? null,
      superFundName: s?.superFundName ?? null,
      hasSuperMemberNumber: Boolean(s?.superMemberNumberEnc),
    },
  };
}
