import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * WIRING GUARD for the submit-review gate (Task 16).
 *
 * tax-filing-submit-review-gate.test.ts covers the gate's behaviour. It
 * cannot tell you the source ORDER is preserved — a future refactor could
 * move the status check after the submit call (or drop it entirely) while
 * that test's mocked-fetch sequencing still happens to pass. This asserts
 * directly on the source so the gate can't silently regress.
 */
describe('tax-filing-submit gate wiring', () => {
  it('handleTaxFilingSubmit checks review/status before ever calling the real submit endpoint, in source order', () => {
    const src = readFileSync(new URL('../server.ts', import.meta.url), 'utf-8');
    const fnStart = src.indexOf('export async function handleTaxFilingSubmit');
    expect(fnStart).toBeGreaterThan(-1);
    // Window sized to cover the whole function body, comments included —
    // the gate grew a fail-closed try/catch around each hop.
    const fnBody = src.slice(fnStart, fnStart + 6000);
    const statusIdx = fnBody.indexOf('/review/status');
    const submitIdx = fnBody.indexOf('/tax-filing/${taxYear}/submit');
    expect(statusIdx).toBeGreaterThan(-1);
    expect(submitIdx).toBeGreaterThan(statusIdx);
  });
});
