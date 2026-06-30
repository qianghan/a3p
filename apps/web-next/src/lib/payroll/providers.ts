/**
 * Payroll provider registry + pure config helpers.
 *
 * The built-in **calculator** is the universal default (free, every
 * jurisdiction, computes withholding + records — no money movement/filing).
 * Other providers are admin-configurable per jurisdiction:
 *   - finch  — read an existing payroll into the books (data only)
 *   - check  — run real US payroll (files + direct deposit)
 *   - deel   — international payroll + contractors (US/CA/UK/AU + global)
 *
 * Recommended first integration for the US+CA-must segment: deel (one provider
 * covers both); finch is the cheapest data-only add. Until a provider adapter
 * is implemented + credentialed, jurisdictions fall back to the calculator.
 */

export type PayrollProviderId = 'calculator' | 'finch' | 'check' | 'deel';

export interface PayrollProviderMeta {
  id: PayrollProviderId;
  label: string;
  description: string;
  status: 'ready' | 'planned';
  requiresApiKey: boolean;
  coverage: string;
}

export const PAYROLL_PROVIDERS: readonly PayrollProviderMeta[] = [
  { id: 'calculator', label: 'Calculator & records', description: 'Built-in withholding calculator. No money movement or filing.', status: 'ready', requiresApiKey: false, coverage: 'US · CA · UK · AU' },
  { id: 'finch', label: 'Finch (read existing payroll)', description: 'Pull an existing payroll system into the books. Data only.', status: 'planned', requiresApiKey: true, coverage: '250+ systems (US · CA)' },
  { id: 'check', label: 'Check (run US payroll)', description: 'Real payroll runs, filing & direct deposit.', status: 'planned', requiresApiKey: true, coverage: 'US' },
  { id: 'deel', label: 'Deel (international + contractors)', description: 'Payroll & contractor payouts across 130+ countries.', status: 'planned', requiresApiKey: true, coverage: 'US · CA · UK · AU + global' },
];

export const JURISDICTIONS = ['us', 'ca', 'uk', 'au'] as const;
export type Jurisdiction = (typeof JURISDICTIONS)[number];

const PROVIDER_IDS = PAYROLL_PROVIDERS.map((p) => p.id) as PayrollProviderId[];

/** Only the calculator is live today; the rest need an adapter + credentials. */
export function isProviderLive(id: PayrollProviderId): boolean {
  return id === 'calculator';
}

/** Resolve the active provider for a jurisdiction; default + fallback is the calculator. */
export function resolveProviderId(
  rows: Array<{ jurisdiction: string; provider: string; enabled: boolean }>,
  jurisdiction: string,
): PayrollProviderId {
  const row = rows.find((r) => r.jurisdiction === jurisdiction && r.enabled);
  const id = row?.provider as PayrollProviderId | undefined;
  return id && (PROVIDER_IDS as string[]).includes(id) ? id : 'calculator';
}

/** Validate an admin config update. Returns normalized fields or null. */
export function parseProviderUpdate(
  body: unknown,
): { jurisdiction: Jurisdiction; provider: PayrollProviderId; apiKey?: string } | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const jurisdiction = typeof b.jurisdiction === 'string' ? b.jurisdiction.toLowerCase() : '';
  const provider = typeof b.provider === 'string' ? b.provider : '';
  if (!(JURISDICTIONS as readonly string[]).includes(jurisdiction)) return null;
  if (!(PROVIDER_IDS as string[]).includes(provider)) return null;
  const apiKey = typeof b.apiKey === 'string' && b.apiKey.trim().length > 0 ? b.apiKey.trim() : undefined;
  return { jurisdiction: jurisdiction as Jurisdiction, provider: provider as PayrollProviderId, apiKey };
}
