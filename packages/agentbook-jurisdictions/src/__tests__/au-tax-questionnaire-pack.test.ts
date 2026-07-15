import { describe, it, expect } from 'vitest';
import { AuTaxQuestionnairePack } from '../au/tax-questionnaire-pack.js';
import type { StandardTaxExtract } from '../interfaces.js';

const pack = new AuTaxQuestionnairePack();

describe('AuTaxQuestionnairePack', () => {
  it('has jurisdiction set to "au"', () => {
    expect(pack.jurisdiction).toBe('au');
  });

  describe('nextQuestionPrompt', () => {
    it('reflects the qaHistory entries passed in', () => {
      const prompt = pack.nextQuestionPrompt({
        qaHistory: [
          { question: 'Are you still trading as a sole trader?', answer: 'Yes, same as last year' },
        ],
      });
      expect(prompt).toContain('Are you still trading as a sole trader?');
      expect(prompt).toContain('Yes, same as last year');
    });

    it('reflects a priorFiling known field', () => {
      const priorFiling: StandardTaxExtract = {
        formType: 'income-statement',
        taxYear: 2025,
        jurisdiction: 'au',
        region: 'NSW',
        totalIncomeCents: 9500000,
        taxableIncomeCents: 8800000,
        savingsRoomCents: 600000,
        formFields: {},
        attachedForms: {},
        confidence: 0.9,
      };
      const prompt = pack.nextQuestionPrompt({ qaHistory: [], priorFiling });
      expect(prompt).toContain('$95,000');
      expect(prompt).toContain('$88,000');
      expect(prompt).toContain('NSW');
      expect(prompt).toContain('$6,000');
    });

    it('reflects the profile block when provided', () => {
      const prompt = pack.nextQuestionPrompt({ qaHistory: [], profile: 'Client is a sole trader graphic designer in Sydney, NSW.' });
      expect(prompt).toContain('Client is a sole trader graphic designer in Sydney, NSW.');
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

    it('is Australia-specific in content (ATO, myGov, GST $75,000 threshold, superannuation, Medicare Levy)', () => {
      const prompt = pack.nextQuestionPrompt({ qaHistory: [] });
      expect(prompt).toContain('ATO');
      expect(prompt).toContain('myGov');
      expect(prompt).toContain('$75,000');
      expect(prompt).toContain('superannuation');
      expect(prompt).toContain('Medicare Levy');
      expect(prompt).toContain('sole trader');
    });
  });

  describe('parseNextQuestionResponse', () => {
    it('returns {question} for a valid question shape', () => {
      expect(pack.parseNextQuestionResponse({ question: 'Did your business structure change this year?' })).toEqual({
        question: 'Did your business structure change this year?',
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
