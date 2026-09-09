import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getMileageRate,
  resolveMileageDeduction,
  CRA_TERRITORIES_SUPPLEMENT_CENTS_PER_KM,
} from './agentbook-mileage-rates';

// The module is `import 'server-only'`; vitest resolves the client build,
// which throws on import. Same stub the sibling rate tests use.
vi.mock('server-only', () => ({}));

/**
 * The CRA's territorial supplement, in the copy that actually books the money.
 *
 * The CRA allows an extra 4c/km for travel in the Northwest Territories, Yukon
 * and Nunavut, on top of the tiered automobile allowance rates. This file is
 * where the CA tiers live and where the deduction is computed, so a lookup
 * with no region meant a territories-resident sole trader was under-claiming
 * 4c on every business kilometre — in the app, over chat, and on every edit.
 *
 * The supplement is Canadian. 'NT' is also the code for Australia's Northern
 * Territory, so the gate has to be on the jurisdiction, not on the code alone.
 */

const AUG_2026 = new Date(Date.UTC(2026, 7, 15));
const AUG_2025 = new Date(Date.UTC(2025, 7, 15));

const TERRITORIES = ['NT', 'YT', 'NU'] as const;
const PROVINCES = ['AB', 'BC', 'SK', 'MB', 'ON', 'QC', 'NB', 'NS', 'NL', 'PE'] as const;

describe('the territories get base + 4c at both tiers', () => {
  it('exports the supplement as a number', () => {
    expect(CRA_TERRITORIES_SUPPLEMENT_CENTS_PER_KM).toBe(4);
  });

  it.each(TERRITORIES)('%s: 77c under the break, 71c over it (2026)', (region) => {
    expect(getMileageRate('ca', 2026, 0, undefined, region).ratePerUnitCents).toBe(77);
    expect(getMileageRate('ca', 2026, 7_500, undefined, region).ratePerUnitCents).toBe(71);
  });

  it.each(TERRITORIES)('%s: 76c/70c against the 2025 tiers', (region) => {
    expect(getMileageRate('ca', 2025, 0, undefined, region).ratePerUnitCents).toBe(76);
    expect(getMileageRate('ca', 2025, 9_000, undefined, region).ratePerUnitCents).toBe(70);
  });

  it('says so in the reason, which is the memo and the audit line', () => {
    const r = getMileageRate('ca', 2026, 0, undefined, 'NT');
    expect(r.reason).toMatch(/77¢\/km/);
    expect(r.reason).toMatch(/territorial supplement/i);
    expect(r.reason).toMatch(/NT/);
  });

  it('books the supplemented amount, not the provincial one', () => {
    // 100 km in Yukon, 2026: 100 x 77c = $77.00. The bug booked $73.00.
    const d = resolveMileageDeduction('ca', AUG_2026, 100, 0, 'km', 'YT');
    expect(d.ratePerUnitCents).toBe(77);
    expect(d.deductibleAmountCents).toBe(7_700);
    expect(d.deductibleAmountCents).not.toBe(7_300);
  });

  it('still tiers on the running total, supplement and all', () => {
    // 6,000 km already driven puts this trip in the high tier: 71c, not 77c.
    const d = resolveMileageDeduction('ca', AUG_2026, 200, 6_000, 'km', 'NU');
    expect(d.ratePerUnitCents).toBe(71);
    expect(d.deductibleAmountCents).toBe(14_200);
  });

  it('does not cap — the territories supplement a tier, it does not add a ceiling', () => {
    const d = resolveMileageDeduction('ca', AUG_2026, 12_000, 0, 'km', 'NT');
    expect(d.claimableUnits).toBe(12_000);
    expect(d.maxClaimableUnitsPerYear).toBeUndefined();
    expect(d.capNote).toBeNull();
  });
});

describe('every other Canadian region is unchanged', () => {
  it.each(PROVINCES)('%s: still 73c/67c for 2026', (region) => {
    expect(getMileageRate('ca', 2026, 0, undefined, region).ratePerUnitCents).toBe(73);
    expect(getMileageRate('ca', 2026, 7_500, undefined, region).ratePerUnitCents).toBe(67);
  });

  it.each([undefined, '', 'ZZ'] as const)('a region of %o books the provincial rate', (region) => {
    // Most tenants have no region recorded. Guessing the supplement for them
    // would over-claim, which is the direction that gets penalised.
    expect(getMileageRate('ca', 2026, 0, undefined, region).ratePerUnitCents).toBe(73);
    expect(resolveMileageDeduction('ca', AUG_2026, 100, 0, 'km', region).deductibleAmountCents).toBe(7_300);
  });

  it('leaves the provincial reason free of supplement wording', () => {
    expect(getMileageRate('ca', 2026, 0, undefined, 'ON').reason).not.toMatch(/supplement/i);
  });
});

describe('the supplement stops at the Canadian border', () => {
  it('AU: "NT" is the Northern Territory and gets no CRA supplement', () => {
    // The genuine code collision. A Darwin sole trader must see the flat ATO
    // cents-per-km rate, not an Australian rate with a Canadian top-up.
    const withRegion = getMileageRate('au', 2026, 0, undefined, 'NT');
    const without = getMileageRate('au', 2026, 0);
    expect(withRegion.ratePerUnitCents).toBe(without.ratePerUnitCents);
    expect(withRegion.reason).not.toMatch(/supplement/i);
  });

  it.each(['us', 'uk'] as const)('%s: a territory code changes nothing', (j) => {
    for (const region of TERRITORIES) {
      expect(getMileageRate(j, 2026, 0, undefined, region).ratePerUnitCents)
        .toBe(getMileageRate(j, 2026, 0).ratePerUnitCents);
    }
  });

  it('books the same amount outside Canada with or without the region', () => {
    for (const j of ['us', 'au', 'uk'] as const) {
      const unit = j === 'au' ? 'km' as const : 'mi' as const;
      const withRegion = resolveMileageDeduction(j, AUG_2025, 100, 0, unit, 'YT');
      const without = resolveMileageDeduction(j, AUG_2025, 100, 0, unit);
      expect(withRegion.deductibleAmountCents).toBe(without.deductibleAmountCents);
    }
  });
});

describe('every write path actually passes a region', () => {
  it('no call site books mileage without one', () => {
    // The tests above all call `resolveMileageDeduction` directly, so they
    // stay green no matter what the callers pass — which is how a rate input
    // ends up wired into two of three write paths and silently missing from
    // the third. There are three (POST route, PATCH service, chat executor)
    // and a territories tenant must get the same number from all of them.
    //
    // So this reads the call sites. It is a static check, deliberately: the
    // alternative is three DB-backed integration tests for one argument.
    const root = join(__dirname, '..', '..', '..', '..');
    const callSites = execFileSync('git', [
      'grep', '-l', '--untracked', '-F', 'resolveMileageDeduction(',
      '--', 'apps/web-next/src', 'plugins/*/backend/src',
    ], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);

    // The module that defines it, and the tests that exercise it, are not
    // write paths.
    const notCallers = (f: string) =>
      f.endsWith('agentbook-mileage-rates.ts') || f.endsWith('.test.ts');
    const writePaths = callSites.filter((f) => !notCallers(f));

    // A guard that finds nothing passes vacuously. There are three.
    expect(writePaths.length, `expected 3 write paths, found:\n${callSites.join('\n')}`).toBe(3);

    const missing: string[] = [];
    for (const file of writePaths) {
      const src = readFileSync(join(root, file), 'utf8');
      for (const call of callArgLists(src, 'resolveMileageDeduction(')) {
        // (jurisdiction, tripDate, units, prior, unit, region) — six.
        if (topLevelArgCount(call) < 6) missing.push(`${file}: resolveMileageDeduction(${call})`);
      }
    }
    expect(
      missing,
      `these book mileage without a region, so NT/YT/NU under-claim 4¢/km:\n${missing.join('\n')}`,
    ).toEqual([]);
  });
});

/** Every `needle(...)` argument list in `src`, brace-matched, needle excluded. */
function callArgLists(src: string, needle: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at === -1) return out;
    let depth = 0;
    let i = at + needle.length - 1; // sits on the opening paren
    const start = i + 1;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) break;
    }
    out.push(src.slice(start, i));
    from = i;
  }
}

/** Argument count, ignoring commas nested inside (), [], {} or a string. */
function topLevelArgCount(args: string): number {
  if (args.trim() === '') return 0;
  let depth = 0;
  let quote: string | null = null;
  let count = 1;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) count++;
  }
  // A trailing comma before the close paren is not another argument.
  return args.trimEnd().endsWith(',') ? count - 1 : count;
}

describe('a region stored before codes were normalized still counts', () => {
  it.each(['Yukon', 'NUNAVUT', 'northwest territories'])('%o books at 77¢', (region) => {
    expect(getMileageRate('ca', 2026, 0, undefined, region).ratePerUnitCents).toBe(77);
  });

  it.each(['Ontario', 'QUEBEC', 'british columbia'])('%o books at 73¢', (region) => {
    expect(getMileageRate('ca', 2026, 0, undefined, region).ratePerUnitCents).toBe(73);
  });
});
