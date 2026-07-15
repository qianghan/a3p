import { describe, it, expect } from 'vitest';
import { AuFilingDraftPack } from '../au/filing-draft-pack.js';
import type { StandardTaxExtract } from '../interfaces.js';

const priorFiling: StandardTaxExtract = {
  formType: 'income-statement', taxYear: 2025, jurisdiction: 'au', region: 'NSW',
  totalIncomeCents: 9500000, taxableIncomeCents: 8800000,
  formFields: {}, attachedForms: {}, confidence: 0.9,
};

describe('AuFilingDraftPack', () => {
  const pack = new AuFilingDraftPack();

  it('has jurisdiction set to "au"', () => {
    expect(pack.jurisdiction).toBe('au');
  });

  it('extractDeltasPrompt includes the prior filing baseline and qa history', () => {
    const prompt = pack.extractDeltasPrompt({
      qaHistory: [{ question: 'Still a sole trader?', answer: 'Yes, same as last year' }],
      priorFiling,
    });
    expect(prompt).toContain('$95,000');
    expect(prompt).toContain('Still a sole trader?');
    expect(prompt).toContain('Yes, same as last year');
    expect(prompt).toContain('income-statement');
    expect(prompt).toContain('State/territory');
  });

  it('extractDeltasPrompt asks about GST threshold and super contribution changes as bullet topics', () => {
    const prompt = pack.extractDeltasPrompt({ qaHistory: [], priorFiling });
    expect(prompt).toContain('$75,000');
    expect(prompt).toMatch(/superannuation|super contribution/i);
  });

  it('parseDeltas extracts a full response', () => {
    const deltas = pack.parseDeltas({
      incomeDeltaPercent: 8, dependentsDelta: 0,
      changesFromLastYear: ['Crossed the $75,000 GST threshold, now registered'],
      openQuestions: ['Confirm first BAS lodgment date'],
    });
    expect(deltas.incomeDeltaPercent).toBe(8);
    expect(deltas.changesFromLastYear).toEqual(['Crossed the $75,000 GST threshold, now registered']);
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

  it('clientLetterPrompt includes the estimated figures when present, in AU terms', () => {
    const prompt = pack.clientLetterPrompt({
      qaHistory: [],
      priorFiling,
      summary: {
        estimatedTotalIncomeCents: 10200000, estimatedTaxableIncomeCents: 9400000,
        estimatedTaxPayableCents: 1800000, taxPayableDeltaVsLastYearCents: 60000,
        changesFromLastYear: ['Crossed the $75,000 GST threshold, now registered'], openQuestions: [], caveat: 'This is an estimate.',
      },
    });
    expect(prompt).toContain('$18,000');
    expect(prompt).toContain('up $600');
    expect(prompt).toContain('ATO');
    expect(prompt).toMatch(/BAS/);
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
