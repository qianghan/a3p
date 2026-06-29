import type { PastFilingPack } from './interfaces.js';

const PACKS: Record<string, PastFilingPack> = {};

export function registerPastFilingPack(pack: PastFilingPack): void {
  PACKS[pack.jurisdiction] = pack;
}

export function getPastFilingPack(jurisdiction: string): PastFilingPack {
  const pack = PACKS[jurisdiction];
  if (!pack) throw new Error(`No PastFilingPack registered for jurisdiction: ${jurisdiction}`);
  return pack;
}

export function listSupportedJurisdictions(): string[] {
  return Object.keys(PACKS);
}
