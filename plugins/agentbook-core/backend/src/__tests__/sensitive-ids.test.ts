import { describe, it, expect } from 'vitest';
import { classifySensitiveIds, redactSensitiveIds, isValidSin, isValidTfn, isValidSsn } from '../sensitive-ids.js';

/** PR 4e review I1/C1 — refusal is narrow (personal ids, checksum-valid); redaction for storage is broad. */
describe('checksums', () => {
  it('SIN Luhn, TFN mod-11, SSN area/group/serial', () => {
    expect(isValidSin('046 454 286')).toBe(true);
    expect(isValidSin('046 454 287')).toBe(false);
    expect(isValidTfn('123 456 782')).toBe(true);
    expect(isValidTfn('123 456 789')).toBe(false);
    expect(isValidSsn('219-09-9999')).toBe(true);
    for (const bad of ['000-12-3456', '666-12-3456', '912-34-5678', '123-00-4567', '123-45-0000']) expect(isValidSsn(bad)).toBe(false);
  });
});

describe('ALLOWED through (business data / not checksum-valid)', () => {
  it.each([
    'INV 123 456 789',
    'invoice 046 454 286 is overdue',
    'ABN 51 824 753 556',
    'ACN 004 085 616',
    '123.456.789',
    'order 123-45-6789',
    'bank account 12345678',
    'account number 998877',
    'routing 021000021',
    'our tax id is 12-3456789',
    'my EIN 123456782',
    'TFN 123 456 789',
    'call 416-555-1234',
    'spent $123.45 on lunch',
  ])('%s', (text) => {
    expect(classifySensitiveIds(text).refuse).toBe(false);
  });

  it('a labelled but checksum-INVALID TFN is flagged as such', () => {
    expect(classifySensitiveIds('TFN 123 456 789')).toEqual({ refuse: false, labelledInvalid: 'tfn' });
  });
});

describe('REFUSED (personal id, checksum-valid)', () => {
  it.each([
    'my TFN is 123 456 782',
    'tax file number 123456782',
    'my SIN is 046 454 286',
    'mon NAS est 046-454-286',
    "numéro d'assurance sociale : 046454286",
    'my SSN is 219-09-9999',
    'social security number 219099999',
    '我的社会保险号是 046 454 286',
    '税务档案号 123456782',
    'here it is: 046 454 286',
  ])('%s', (text) => {
    expect(classifySensitiveIds(text).refuse).toBe(true);
  });
});

describe('redaction for storage is broad', () => {
  it('redacts checksum-valid TFN/SIN and valid SSN shapes regardless of keyword', () => {
    expect(redactSensitiveIds('INV 046 454 286')).toBe('INV [redacted]');
    expect(redactSensitiveIds('order 219-09-9999')).toBe('order [redacted]');
    expect(redactSensitiveIds('tfn 123456782 thanks')).toBe('tfn [redacted] thanks');
    expect(redactSensitiveIds('INV 123 456 789')).toBe('INV 123 456 789');
    expect(redactSensitiveIds('ABN 51 824 753 556')).toBe('ABN 51 824 753 556');
  });
});
