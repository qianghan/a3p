import { describe, it, expect } from 'vitest';
import { buildExtractionPrompt, parseExtractionJson } from '@/lib/agentbook-startup/document-extraction';

describe('buildExtractionPrompt', () => {
  it('includes the document label/description and asks for compact JSON', () => {
    const prompt = buildExtractionPrompt('payroll_register', {
      docType: 'payroll_register', label: 'Payroll register', description: 'Wages paid to employees performing qualified research, by pay period.', required: true,
    });
    expect(prompt).toContain('Payroll register');
    expect(prompt).toContain('Wages paid to employees performing qualified research');
    expect(prompt).toContain('JSON');
  });
});

describe('parseExtractionJson', () => {
  it('parses a well-formed response for payroll_register', () => {
    const result = parseExtractionJson('payroll_register', '{"totalWagesCents": 2500000, "confidence": 0.9}');
    expect(result).toEqual({ totalWagesCents: 2500000, confidence: 0.9 });
  });

  it('strips markdown code fences if the model wraps its JSON', () => {
    const result = parseExtractionJson('payroll_register', '```json\n{"totalWagesCents": 100}\n```');
    expect(result).toEqual({ totalWagesCents: 100 });
  });

  it('returns an empty object (never throws) for unparseable text', () => {
    const result = parseExtractionJson('payroll_register', 'not json at all');
    expect(result).toEqual({});
  });
});
