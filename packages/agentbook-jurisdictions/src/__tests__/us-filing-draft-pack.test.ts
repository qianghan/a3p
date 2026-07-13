import { describe, it, expect } from 'vitest';
import { UsFilingDraftPack } from '../us/filing-draft-pack.js';
import type { StandardTaxExtract } from '../interfaces.js';

const priorFiling: StandardTaxExtract = {
  formType: '1040', taxYear: 2024, jurisdiction: 'us', region: 'CA',
  totalIncomeCents: 8500000, taxableIncomeCents: 7200000,
  formFields: { filingStatus: 'single' }, attachedForms: {}, confidence: 0.9,
};

describe('UsFilingDraftPack', () => {
  const pack = new UsFilingDraftPack();

  it('extractDeltasPrompt includes the prior filing baseline and qa history', () => {
    const prompt = pack.extractDeltasPrompt({
      qaHistory: [{ question: 'Filing status this year?', answer: 'Still single' }],
      priorFiling,
    });
    expect(prompt).toContain('$85,000');
    expect(prompt).toContain('Filing status this year?');
    expect(prompt).toContain('Still single');
  });

  it('parseDeltas extracts a full response', () => {
    const deltas = pack.parseDeltas({
      incomeDeltaPercent: 5, filingStatusChanged: false, dependentsDelta: 0,
      changesFromLastYear: ['Income up slightly'], openQuestions: ['Confirm no new 1099s'],
    });
    expect(deltas.incomeDeltaPercent).toBe(5);
    expect(deltas.changesFromLastYear).toEqual(['Income up slightly']);
  });

  it('parseDeltas defaults missing arrays to empty rather than throwing', () => {
    const deltas = pack.parseDeltas({});
    expect(deltas.changesFromLastYear).toEqual([]);
    expect(deltas.openQuestions).toEqual([]);
    expect(deltas.incomeDeltaPercent).toBeUndefined();
  });

  it('parseDeltas throws on a non-object response', () => {
    expect(() => pack.parseDeltas('not an object')).toThrow('Unexpected delta-extraction response shape');
  });

  it('clientLetterPrompt includes the estimated figures when present', () => {
    const prompt = pack.clientLetterPrompt({
      qaHistory: [],
      priorFiling,
      summary: {
        estimatedTotalIncomeCents: 8900000, estimatedTaxableIncomeCents: 7500000,
        estimatedTaxPayableCents: 1200000, taxPayableDeltaVsLastYearCents: 50000,
        changesFromLastYear: ['Income up slightly'], openQuestions: [], caveat: 'This is an estimate.',
      },
    });
    expect(prompt).toContain('$12,000');
    expect(prompt).toContain('up $500');
  });

  it('clientLetterPrompt degrades gracefully when no numeric estimate is available', () => {
    const prompt = pack.clientLetterPrompt({
      qaHistory: [], priorFiling,
      summary: { changesFromLastYear: [], openQuestions: [], caveat: 'This is an estimate.' },
    });
    expect(prompt).toContain('no numeric estimate available');
  });

  it('parseClientLetter extracts letterBody', () => {
    const result = pack.parseClientLetter({ letterBody: 'Dear Accountant,\n\nHere is my summary.' });
    expect(result.letterBody).toContain('Dear Accountant');
  });

  it('parseClientLetter throws on a missing letterBody', () => {
    expect(() => pack.parseClientLetter({})).toThrow('Unexpected client-letter response shape');
  });
});
