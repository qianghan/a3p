// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@naap/database', () => ({ prisma: {} }));
import { parseTaxLabel } from '@/lib/agentbook-receipt-ocr';

describe('parseTaxLabel (OCR tax_label, PR 2b.8)', () => {
  it('keeps a short printed label, trimmed', () => {
    expect(parseTaxLabel(' GST ')).toBe('GST');
    expect(parseTaxLabel('TPS/TVQ')).toBe('TPS/TVQ');
  });
  it('rejects non-strings, blanks, long text and markup', () => {
    expect(parseTaxLabel(null)).toBeNull();
    expect(parseTaxLabel(10)).toBeNull();
    expect(parseTaxLabel('  ')).toBeNull();
    expect(parseTaxLabel('x'.repeat(25))).toBeNull();
    expect(parseTaxLabel('<b>GST</b>')).toBeNull();
  });
});
