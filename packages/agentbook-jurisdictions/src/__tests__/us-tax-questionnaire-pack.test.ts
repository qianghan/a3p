import { describe, it, expect } from 'vitest';
import { UsTaxQuestionnairePack } from '../us/tax-questionnaire-pack.js';
import type { StandardTaxExtract } from '../interfaces.js';

const pack = new UsTaxQuestionnairePack();

describe('UsTaxQuestionnairePack', () => {
  it('has jurisdiction set to "us"', () => {
    expect(pack.jurisdiction).toBe('us');
  });

  describe('nextQuestionPrompt', () => {
    it('reflects the qaHistory entries passed in', () => {
      const prompt = pack.nextQuestionPrompt({
        qaHistory: [
          { question: 'What is your filing status this year?', answer: 'Married filing jointly, no changes from last year' },
        ],
      });
      expect(prompt).toContain('What is your filing status this year?');
      expect(prompt).toContain('Married filing jointly, no changes from last year');
    });

    it('reflects a priorFiling known field', () => {
      const priorFiling: StandardTaxExtract = {
        formType: '1040',
        taxYear: 2024,
        jurisdiction: 'us',
        region: 'CA',
        totalIncomeCents: 8500000,
        taxableIncomeCents: 7200000,
        formFields: {},
        attachedForms: {},
        confidence: 0.9,
      };
      const prompt = pack.nextQuestionPrompt({ qaHistory: [], priorFiling });
      expect(prompt).toContain('$85,000');
      expect(prompt).toContain('$72,000');
      expect(prompt).toContain('CA');
    });

    it('reflects the profile block when provided', () => {
      const prompt = pack.nextQuestionPrompt({ qaHistory: [], profile: 'Client is a freelance graphic designer in Austin, TX.' });
      expect(prompt).toContain('Client is a freelance graphic designer in Austin, TX.');
    });

    it('instructs the LLM to skip anything already answered or already known', () => {
      const prompt = pack.nextQuestionPrompt({ qaHistory: [] });
      expect(prompt).toMatch(/do not ask|Do NOT ask/i);
    });

    it('instructs the LLM to reply with exactly one line of JSON, no markdown fences', () => {
      const prompt = pack.nextQuestionPrompt({ qaHistory: [] });
      expect(prompt).toContain('{"question"');
      expect(prompt).toContain('{"done": true}');
      expect(prompt).toMatch(/no markdown code fences/i);
    });

    it('is US-federal-specific in content (filing status, W-2/1099, itemized vs standard, retirement)', () => {
      const prompt = pack.nextQuestionPrompt({ qaHistory: [] });
      expect(prompt).toContain('Filing status');
      expect(prompt).toContain('W-2');
      expect(prompt).toContain('1099-NEC');
      expect(prompt).toContain('standard deduction');
      expect(prompt).toContain('401(k)');
    });
  });

  describe('parseNextQuestionResponse', () => {
    it('returns {question} for a valid question shape', () => {
      expect(pack.parseNextQuestionResponse({ question: 'Did you get married this year?' })).toEqual({
        question: 'Did you get married this year?',
      });
    });

    it('returns {done: true} for a valid done shape', () => {
      expect(pack.parseNextQuestionResponse({ done: true })).toEqual({ done: true });
    });

    it('throws on a malformed shape missing both fields', () => {
      expect(() => pack.parseNextQuestionResponse({ foo: 'bar' })).toThrow(/Unexpected questionnaire response shape/);
    });

    it('throws on a completely different shape', () => {
      expect(() => pack.parseNextQuestionResponse('just a string')).toThrow(/Unexpected questionnaire response shape/);
      expect(() => pack.parseNextQuestionResponse(null)).toThrow(/Unexpected questionnaire response shape/);
      expect(() => pack.parseNextQuestionResponse({ question: '' })).toThrow(/Unexpected questionnaire response shape/);
      expect(() => pack.parseNextQuestionResponse({ done: false })).toThrow(/Unexpected questionnaire response shape/);
    });
  });
});
