import type { PastFilingPack } from './interfaces.js';
import { CaPastFilingPack } from './ca/past-filing-pack.js';
import { UsPastFilingPack } from './us/past-filing-pack.js';
// Future: import { NzPastFilingPack } from './nz/past-filing-pack.js';
// Future: import { UkPastFilingPack } from './uk/past-filing-pack.js';
// Future: import { AuPastFilingPack } from './au/past-filing-pack.js';

const PACKS: Record<string, PastFilingPack> = {
  ca: new CaPastFilingPack(),
  us: new UsPastFilingPack(),
  // nz: new NzPastFilingPack(),
  // uk: new UkPastFilingPack(),
  // au: new AuPastFilingPack(),
};

export function registerPastFilingPack(pack: PastFilingPack): void {
  PACKS[pack.jurisdiction] = pack;
}

export function getPastFilingPack(jurisdiction: string): PastFilingPack {
  const pack = PACKS[jurisdiction];
  if (!pack) throw new Error(`No PastFilingPack for jurisdiction: ${jurisdiction}`);
  return pack;
}

export function listSupportedJurisdictions(): string[] {
  return Object.keys(PACKS);
}
