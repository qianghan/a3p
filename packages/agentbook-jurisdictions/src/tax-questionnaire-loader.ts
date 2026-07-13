import type { TaxQuestionnairePack } from './interfaces.js';
import { CaTaxQuestionnairePack } from './ca/tax-questionnaire-pack.js';
import { UsTaxQuestionnairePack } from './us/tax-questionnaire-pack.js';
// au/uk deliberately NOT registered — matching past-filing-loader.ts's stated
// scope for this new capability (see the design spec's "Revised: pack interface").

const PACKS: Record<string, TaxQuestionnairePack> = {
  ca: new CaTaxQuestionnairePack(),
  us: new UsTaxQuestionnairePack(),
};

export function registerTaxQuestionnairePack(pack: TaxQuestionnairePack): void {
  PACKS[pack.jurisdiction] = pack;
}

export function getTaxQuestionnairePack(jurisdiction: string): TaxQuestionnairePack {
  const pack = PACKS[jurisdiction];
  if (!pack) throw new Error(`No TaxQuestionnairePack for jurisdiction: ${jurisdiction}`);
  return pack;
}

export function listSupportedJurisdictions(): string[] {
  return Object.keys(PACKS);
}
