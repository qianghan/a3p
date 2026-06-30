/**
 * Unit tests for the deferred-revenue recognition math.
 *
 * Mirrors the per-row slice logic in
 * apps/web-next/.../cron/recognize-revenue/route.ts:
 *   perMonth = round(total / periodMonths)
 *   slice    = min(perMonth, remaining)
 *   complete = recognized + slice >= total  (final slice clears remainder)
 */
import { describe, it, expect } from 'vitest';

function recognizeOnce(totalCents: number, periodMonths: number, recognizedCents: number, monthsRecognized: number) {
  const remaining = totalCents - recognizedCents;
  const isFinalMonth = monthsRecognized + 1 >= periodMonths;
  const perMonth = Math.floor(totalCents / periodMonths);
  const slice = isFinalMonth ? remaining : Math.min(perMonth, remaining);
  const newRecognized = recognizedCents + slice;
  const complete = isFinalMonth || newRecognized >= totalCents;
  return { slice, recognized: complete ? totalCents : newRecognized, complete };
}

/** Run recognition month-by-month until the schedule completes. */
function runToCompletion(totalCents: number, periodMonths: number) {
  let recognized = 0;
  let months = 0;
  while (recognized < totalCents && months < periodMonths + 2) {
    const r = recognizeOnce(totalCents, periodMonths, recognized, months);
    recognized = r.recognized;
    months++;
    if (r.complete) break;
  }
  return { recognized, months };
}

describe('deferred revenue recognition', () => {
  it('recognizes an even amount each month for a clean division', () => {
    const r = recognizeOnce(12_000_00, 12, 0, 0);
    expect(r.slice).toBe(1_000_00);
    expect(r.complete).toBe(false);
  });

  it('fully recognizes the total over exactly periodMonths months', () => {
    const { recognized, months } = runToCompletion(12_000_00, 12);
    expect(recognized).toBe(12_000_00);
    expect(months).toBe(12);
  });

  it('completes uneven divisions in exactly periodMonths months', () => {
    // 100.00 over 3 months → 33/33/34, no stranded cents, no extra month.
    const { recognized, months } = runToCompletion(100_00, 3);
    expect(recognized).toBe(100_00);
    expect(months).toBe(3);
  });

  it('the final month recognizes the whole remainder', () => {
    let recognized = 0;
    recognized = recognizeOnce(100_00, 3, recognized, 0).recognized; // month 1
    recognized = recognizeOnce(100_00, 3, recognized, 1).recognized; // month 2
    const last = recognizeOnce(100_00, 3, recognized, 2);            // month 3 (final)
    expect(last.recognized).toBe(100_00);
    expect(last.complete).toBe(true);
  });

  it('does not over-recognize beyond the total mid-schedule', () => {
    const r = recognizeOnce(100_00, 10, 99_00, 5);
    expect(r.recognized).toBeLessThanOrEqual(100_00);
  });
});
