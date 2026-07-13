import { describe, it, expect } from 'vitest';
import { CaTaxQuestionnairePack } from '../ca/tax-questionnaire-pack.js';
import type { StandardTaxExtract } from '../interfaces.js';

const pack = new CaTaxQuestionnairePack();

describe('CaTaxQuestionnairePack', () => {
  it('has jurisdiction set to "ca"', () => {
    expect(pack.jurisdiction).toBe('ca');
  });

  describe('nextQuestionPrompt', () => {
    it('reflects the qaHistory entries passed in', () => {
      const prompt = pack.nextQuestionPrompt({
        qaHistory: [
          { question: 'What province did you live in on December 31?', answer: 'Ontario, same as last year' },
        ],
      });
      expect(prompt).toContain('What province did you live in on December 31?');
      expect(prompt).toContain('Ontario, same as last year');
    });

    it('reflects a priorFiling known field', () => {
      const priorFiling: StandardTaxExtract = {
        formType: 'T1',
        taxYear: 2024,
        jurisdiction: 'ca',
        region: 'ON',
        totalIncomeCents: 8500000,
        taxableIncomeCents: 7200000,
        savingsRoomCents: 1500000,
        formFields: {},
        attachedForms: {},
        confidence: 0.9,
      };
      const prompt = pack.nextQuestionPrompt({ qaHistory: [], priorFiling });
      expect(prompt).toContain('$85,000');
      expect(prompt).toContain('$72,000');
      expect(prompt).toContain('ON');
      expect(prompt).toContain('$15,000');
    });

    it('reflects the profile block when provided', () => {
      const prompt = pack.nextQuestionPrompt({ qaHistory: [], profile: 'Client is a freelance graphic designer in Toronto, ON.' });
      expect(prompt).toContain('Client is a freelance graphic designer in Toronto, ON.');
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

    it('is Canada-specific in content (T1 General, province, T4/T4A slips, RRSP, GST/HST)', () => {
      const prompt = pack.nextQuestionPrompt({ qaHistory: [] });
      expect(prompt).toContain('T1 General');
      expect(prompt).toContain('Province');
      expect(prompt).toContain('T4');
      expect(prompt).toContain('T4A');
      expect(prompt).toContain('RRSP');
      expect(prompt).toContain('GST/HST');
    });
  });

  describe('parseNextQuestionResponse', () => {
    it('returns {question} for a valid question shape', () => {
      expect(pack.parseNextQuestionResponse({ question: 'Did you move provinces this year?' })).toEqual({
        question: 'Did you move provinces this year?',
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
