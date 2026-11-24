// ReDoS guard for the bill chat parsers (CodeQL js/polynomial-redos on #660).
// Each input is built to NOT match, so the engine explores every path: a
// succeeding match is fast and proves nothing.
import { describe, it, expect } from 'vitest';
import { parseBillVendor, parseBillAmount, parseDueDate } from '../bill-chat.js';

const N = 50_000;
const hostile = [
  '\t'.repeat(N) + '!',
  '!'.repeat(N),
  '9'.repeat(N) + 'x',
  'owe ' + '\t'.repeat(N) + 'x',
  'je dois ' + ' 1'.repeat(N) + 'x',
  'factures de ' + '\t'.repeat(N),
  '我欠' + '我欠!'.repeat(N),
  'bill from ' + 'a '.repeat(N),
];
const never = () => null;

describe('bill chat parsers stay linear on hostile input', () => {
  for (const s of hostile) {
    it(`${JSON.stringify(s.slice(0, 12))}… (${s.length} chars)`, () => {
      const t0 = performance.now();
      parseBillVendor(s);
      parseBillAmount(s, never);
      parseDueDate(s, new Date('2026-11-23T00:00:00Z'));
      expect(performance.now() - t0).toBeLessThan(200);
    });
  }
});
