/**
 * Add-on availability by jurisdiction.
 *
 * Some add-ons need a jurisdiction-specific engine and must only be OFFERED and
 * SOLD where that engine exists — otherwise a tenant pays for a feature that
 * answers "not available for your jurisdiction".
 *
 * `startup_tax_benefits` implements TaxBenefitProvider only for US + AU
 * (packages/agentbook-jurisdictions/src/{us,au}/tax-benefits.ts; CA/UK packs
 * have none). Keep this list in sync with the packs that implement it.
 *
 * Add-ons NOT listed here are available in every region (the default).
 */
export const ADDON_JURISDICTIONS: Record<string, readonly string[]> = {
  startup_tax_benefits: ['us', 'au'],
};

/** True if `code` is available to a tenant in `region` (default: available everywhere). */
export function isAddOnAvailable(code: string, region: string | null | undefined): boolean {
  const allowed = ADDON_JURISDICTIONS[code];
  if (!allowed) return true;
  return allowed.includes((region || 'us').toLowerCase());
}
