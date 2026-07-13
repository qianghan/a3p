import type { FilingDraftPack } from './interfaces.js';
import { CaFilingDraftPack } from './ca/filing-draft-pack.js';
import { UsFilingDraftPack } from './us/filing-draft-pack.js';
// au/uk deliberately NOT registered — matching tax-questionnaire-loader.ts's
// scope (the questionnaire itself only supports us/ca, so a filing draft
// can never be generated for any other jurisdiction).

const PACKS: Record<string, FilingDraftPack> = {
  ca: new CaFilingDraftPack(),
  us: new UsFilingDraftPack(),
};

export function registerFilingDraftPack(pack: FilingDraftPack): void {
  PACKS[pack.jurisdiction] = pack;
}

export function getFilingDraftPack(jurisdiction: string): FilingDraftPack {
  const pack = PACKS[jurisdiction];
  if (!pack) throw new Error(`No FilingDraftPack for jurisdiction: ${jurisdiction}`);
  return pack;
}

export function listSupportedJurisdictions(): string[] {
  return Object.keys(PACKS);
}
