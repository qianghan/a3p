import type { TaxQuestionnairePack } from './interfaces.js';
import { CaTaxQuestionnairePack } from './ca/tax-questionnaire-pack.js';
import { UsTaxQuestionnairePack } from './us/tax-questionnaire-pack.js';
import { AuTaxQuestionnairePack } from './au/tax-questionnaire-pack.js';
// uk deliberately NOT registered — no UK TaxQuestionnairePack/FilingDraftPack
// exists yet (out of scope for PR-7; see docs/superpowers/specs/2026-07-14-tax-fast-track-au-design.md).

const PACKS: Record<string, TaxQuestionnairePack> = {
  ca: new CaTaxQuestionnairePack(),
  us: new UsTaxQuestionnairePack(),
  au: new AuTaxQuestionnairePack(),
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
