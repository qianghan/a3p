/**
 * PR 3bc.5 guard — every bill reader uses the shared unpaid rule
 * (status in open|partial, deletedAt null — lib/bill-amounts). A reader that
 * filters `status: 'open'` alone silently drops partially-paid bills.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../../..');
const READERS = [
  'apps/web-next/src/app/api/v1/agentbook-expense/bills/route.ts',
  'apps/web-next/src/app/api/v1/agentbook-tax/reports/ap-aging/route.ts',
  'apps/web-next/src/app/api/v1/agentbook-tax/reports/balance-sheet/route.ts',
  'apps/web-next/src/lib/balance-sheet.ts',
  'apps/web-next/src/lib/mobile/home.ts',
  'apps/web-next/src/lib/mobile/upcoming.ts',
  'apps/web-next/src/lib/cpa-run.ts',
  'plugins/agentbook-core/backend/src/server.ts',
];

/** `abBill.<read>(` … up to the matching close paren — the call's argument text. */
function billReads(src: string): string[] {
  const out: string[] = [];
  const re = /abBill\.(findMany|findFirst|findUnique|count|aggregate|groupBy)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) depth += src[i] === '(' ? 1 : src[i] === ')' ? -1 : 0;
    out.push(src.slice(m.index, i));
  }
  return out;
}

describe('bill readers use the shared unpaid rule', () => {
  for (const rel of READERS) {
    const src = readFileSync(path.join(ROOT, rel), 'utf8');
    it(`${rel}: no bill read filters status 'open' alone`, () => {
      const bad = billReads(src).filter((c) => /status\s*:\s*['"]open['"]/.test(c));
      expect(bad).toEqual([]);
    });
    it(`${rel}: no in-memory "status === 'open'" unpaid test`, () => {
      expect(src.match(/\.status\s*===\s*['"]open['"]/g) ?? []).toEqual([]);
    });
    it(`${rel}: references the shared bill-amounts helper`, () => {
      expect(/bill-amounts/.test(src)).toBe(true);
    });
  }
});
