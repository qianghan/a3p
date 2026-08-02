import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Choosing what to file must never destroy what was filed against.
 *
 * The filing package was all-or-nothing: `{ year, jurisdiction }` and nothing
 * else, so a user who disagreed that an expense belonged in this year's
 * submission — or whose accountant did — had no way to say so short of
 * deleting it. Deleting is the one thing that must not happen: the receipt is
 * the evidence behind the deduction, and it is needed precisely when someone
 * later asks whether the deduction was justified.
 *
 * So exclusion is opt-OUT (default everything, existing callers unchanged) and
 * is kept lexically distinct from deletion everywhere. "Remove from filing"
 * reading as "destroy the evidence" is how a deduction becomes unsupportable
 * at audit, and the distance between those two ideas has to be maintained in
 * the API, not just in the UI copy.
 */
const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const readCode = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const LIB = 'apps/web-next/src/lib/agentbook-tax-package.ts';
const ROUTE = 'apps/web-next/src/app/api/v1/agentbook-tax/tax-package/generate/route.ts';

describe('the user can choose what goes into a filing', () => {
  it('the package accepts an exclusion set', () => {
    expect(readCode(LIB)).toMatch(/excludeExpenseIds\?:\s*string\[\]/);
  });

  it('the exclusion actually filters the query', () => {
    // Accepting the parameter and ignoring it would be worse than not having
    // it: the UI would report an exclusion the filing does not reflect.
    const code = readCode(LIB);
    expect(code).toMatch(/id:\s*\{\s*notIn:\s*excludeExpenseIds\s*\}/);
  });

  it('it is opt-out, so an existing caller gets the same package as before', () => {
    // Opt-in would silently produce an empty filing for every caller that has
    // not been updated.
    const code = readCode(LIB);
    expect(code).toMatch(/excludeExpenseIds\s*&&\s*excludeExpenseIds\.length\s*>\s*0/);
  });

  it('the route validates the set rather than passing it straight to the query', () => {
    const code = readCode(ROUTE);
    expect(code).toMatch(/Array\.isArray\(rawExclusions\)/);
    expect(code).toMatch(/MAX_EXCLUSIONS/);
  });
});

describe('excluding is not deleting', () => {
  it('the package module never deletes an expense', () => {
    const code = readCode(LIB);
    expect(code).not.toMatch(/abExpense\.delete/);
    expect(code).not.toMatch(/abExpense\.updateMany[\s\S]{0,80}deletedAt/);
  });

  it('the generate route never deletes anything', () => {
    const code = readCode(ROUTE);
    expect(code).not.toMatch(/\bdelete(?:Many)?\s*\(/);
    expect(code).not.toMatch(/deletedAt/);
  });

  it('a soft-deleted expense still appears on the year it belonged to', () => {
    // Unrelated to exclusion, and worth pinning next to it: an expense deleted
    // in February still belonged to the books at the close of the prior year,
    // and dropping it would understate that year's return.
    expect(readCode(LIB)).toMatch(/deletedAt:\s*\{\s*gt:\s*end\s*\}/);
  });
});
