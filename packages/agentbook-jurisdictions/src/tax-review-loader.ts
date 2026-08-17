import type { TaxReviewPack } from './interfaces.js';
import { CaTaxReviewPack } from './ca/tax-review-pack.js';
import { UsTaxReviewPack } from './us/tax-review-pack.js';
import { AuTaxReviewPack } from './au/tax-review-pack.js';

const PACKS: Record<string, TaxReviewPack> = {
  ca: new CaTaxReviewPack(),
  us: new UsTaxReviewPack(),
  au: new AuTaxReviewPack(),
};

export function registerTaxReviewPack(pack: TaxReviewPack): void {
  PACKS[pack.jurisdiction] = pack;
}

export function getTaxReviewPack(jurisdiction: string): TaxReviewPack {
  const pack = PACKS[jurisdiction];
  if (!pack) throw new Error(`No TaxReviewPack for jurisdiction: ${jurisdiction}`);
  return pack;
}

export function listSupportedJurisdictions(): string[] {
  return Object.keys(PACKS);
}
