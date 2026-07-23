/**
 * Region normalization for tenant config.
 *
 * Every US/CA tax + sales-tax lookup keys on a 2-letter code
 * (STATE_RATES[region.toUpperCase()], PROVINCIAL_BRACKETS[province]). If a
 * tenant stores a full name like "Ontario" or "California", those lookups miss
 * and silently fall back — US → `?? 0` (no state income/sales tax) or CA →
 * Ontario's rate — i.e. wrong tax on a real return (M2). Normalizing on write
 * (uppercase, full-name → code, reject unknowns) makes the stored value always
 * match what the rate tables expect.
 *
 * Only US and CA are strictly validated (that's where a wrong region mis-taxes).
 * AU/UK and any other jurisdiction pass through trimmed+uppercased without
 * rejection, so entering an AU state (e.g. "NSW") or leaving it blank still works.
 */

const US_STATES: Record<string, string> = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA', COLORADO: 'CO',
  CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA', HAWAII: 'HI', IDAHO: 'ID',
  ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA',
  MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN',
  MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV',
  'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR',
  PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD',
  TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA',
  'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY', 'DISTRICT OF COLUMBIA': 'DC',
  'WASHINGTON DC': 'DC', 'WASHINGTON, DC': 'DC',
};
const US_CODES = new Set(Object.values(US_STATES));

const CA_PROVINCES: Record<string, string> = {
  ONTARIO: 'ON', QUEBEC: 'QC', 'QUÉBEC': 'QC', 'BRITISH COLUMBIA': 'BC', ALBERTA: 'AB',
  MANITOBA: 'MB', SASKATCHEWAN: 'SK', 'NEW BRUNSWICK': 'NB', 'NOVA SCOTIA': 'NS',
  'PRINCE EDWARD ISLAND': 'PE', 'NEWFOUNDLAND AND LABRADOR': 'NL', NEWFOUNDLAND: 'NL',
  YUKON: 'YT', 'NORTHWEST TERRITORIES': 'NT', NUNAVUT: 'NU',
};
const CA_CODES = new Set(Object.values(CA_PROVINCES));

export type NormalizeResult = { ok: true; value: string } | { ok: false; error: string };

export function normalizeRegionCode(jurisdiction: string | null | undefined, region: string): NormalizeResult {
  const raw = (region ?? '').trim();
  if (raw === '') return { ok: true, value: '' }; // region is optional
  const upper = raw.toUpperCase();
  const j = (jurisdiction || 'us').toLowerCase();

  if (j === 'us') {
    if (US_CODES.has(upper)) return { ok: true, value: upper };
    if (US_STATES[upper]) return { ok: true, value: US_STATES[upper] };
    return { ok: false, error: `Unrecognized US state "${region}". Use a 2-letter code (e.g. CA, NY, TX).` };
  }
  if (j === 'ca') {
    if (CA_CODES.has(upper)) return { ok: true, value: upper };
    if (CA_PROVINCES[upper]) return { ok: true, value: CA_PROVINCES[upper] };
    return { ok: false, error: `Unrecognized Canadian province "${region}". Use a 2-letter code (e.g. ON, QC, BC).` };
  }
  // AU / UK / other: no strict code table drives tax here — keep the tenant's
  // value (uppercased) without rejecting, so AU states etc. still work.
  return { ok: true, value: upper };
}
