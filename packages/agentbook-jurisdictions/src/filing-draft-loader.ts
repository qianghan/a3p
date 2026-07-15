import type { FilingDraftPack } from './interfaces.js';
import { CaFilingDraftPack } from './ca/filing-draft-pack.js';
import { UsFilingDraftPack } from './us/filing-draft-pack.js';
import { AuFilingDraftPack } from './au/filing-draft-pack.js';
// uk deliberately NOT registered — no UK FilingDraftPack exists yet (out of
// scope for PR-7; see docs/superpowers/specs/2026-07-14-tax-fast-track-au-design.md).

const PACKS: Record<string, FilingDraftPack> = {
  ca: new CaFilingDraftPack(),
  us: new UsFilingDraftPack(),
  au: new AuFilingDraftPack(),
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
