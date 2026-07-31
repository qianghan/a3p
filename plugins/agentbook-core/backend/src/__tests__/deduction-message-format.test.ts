import { describe, it, expect } from 'vitest';
import { formatDeductionsMessage } from '../server';

/**
 * MONEY-BUG REGRESSION GUARD — found by probing production, 2026-07-31.
 *
 * "show me my tax deductions" returned TEN "$NaN"s, including the headline
 * "**Estimated Savings: $NaN**".
 *
 * The formatter read `d.amountCents` and `summary.estimatedSavingsCents`. The
 * endpoint returns AbDeductionSuggestion rows, which are keyed
 * `estimatedSavingsCents`, under a summary keyed
 * `totalEstimatedSavingsCents`. `undefined / 100` is NaN and `.toFixed(2)`
 * happily renders "NaN", so every figure was wrong in the loudest possible way.
 *
 * It survived because the formatter was buried inside
 * _executeClassificationCore and could not be called from a test. Extracting it
 * IS the fix as much as the field rename is: the assertion below is trivial,
 * and it was simply impossible to write before.
 */
const rows = [
  { message: 'Meal on 2026-07-01 fell in the same week as your invoice to Acme.', estimatedSavingsCents: 1250, status: 'open' },
  { message: 'Adobe subscription marked personal looks like a business tool.', estimatedSavingsCents: 4400, status: 'applied' },
];

describe('the deductions reply never shows NaN', () => {
  it('renders the savings figure from estimatedSavingsCents', () => {
    const out = formatDeductionsMessage({ deductions: rows }, 'USD');
    expect(out).not.toContain('NaN');
    expect(out).toContain('$12.50');
    expect(out).toContain('$44.00');
  });

  it('renders the summary from totalEstimatedSavingsCents', () => {
    const out = formatDeductionsMessage(
      { deductions: rows, summary: { totalEstimatedSavingsCents: 5650 } },
      'USD',
    );
    expect(out).not.toContain('NaN');
    expect(out).toContain('**Estimated savings: $56.50**');
  });

  it('omits the amount entirely when a row has none — silence beats NaN', () => {
    const out = formatDeductionsMessage(
      { deductions: [{ message: 'Something deductible', status: 'open' }] },
      'USD',
    );
    expect(out).not.toContain('NaN');
    expect(out).not.toContain('$');
    expect(out).toContain('Something deductible');
  });

  it('omits the summary line when the total is missing', () => {
    const out = formatDeductionsMessage({ deductions: rows, summary: {} }, 'USD');
    expect(out).not.toContain('NaN');
    expect(out).not.toContain('Estimated savings');
  });

  it('survives a null/NaN amount without printing it', () => {
    const out = formatDeductionsMessage(
      { deductions: [{ message: 'x', estimatedSavingsCents: NaN, status: 'open' }] },
      'USD',
    );
    expect(out).not.toContain('NaN');
  });
});

describe('the deductions reply uses the tenant currency', () => {
  // Maya is a CA tenant. Her savings were shown in US dollars because this
  // branch hardcoded "$" while the expense handler in the same file already
  // routed through fmtCurrency.
  it('shows CA$ for a Canadian tenant', () => {
    const out = formatDeductionsMessage(
      { deductions: rows, summary: { totalEstimatedSavingsCents: 5650 } },
      'CAD',
    );
    expect(out).toContain('CA$56.50');
    expect(out).not.toMatch(/(?<!CA)\$56\.50/);
  });

  it('shows A$ for an Australian tenant', () => {
    const out = formatDeductionsMessage({ deductions: rows }, 'AUD');
    expect(out).toContain('A$12.50');
  });
});

describe('formatting details', () => {
  it('marks the figure as a saving, not the expense amount', () => {
    // The old "description: $x" read as the cost of the thing. It is the
    // estimated tax saving.
    expect(formatDeductionsMessage({ deductions: rows }, 'USD')).toContain('saves ~$12.50');
  });

  it('caps the list at ten rows', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      message: `row ${i}`, estimatedSavingsCents: 100, status: 'open',
    }));
    const out = formatDeductionsMessage({ deductions: many }, 'USD');
    expect(out).toContain('row 9');
    expect(out).not.toContain('row 10');
  });

  it('falls back to description when a row has no message', () => {
    const out = formatDeductionsMessage(
      { deductions: [{ description: 'Home office', estimatedSavingsCents: 500, status: 'open' }] },
      'USD',
    );
    expect(out).toContain('Home office');
  });
});
