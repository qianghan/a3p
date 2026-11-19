/** PR 2b.1: additive tax-code columns exist, optional/defaulted, exact types. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const schema = readFileSync(join(ROOT, 'packages/database/prisma/schema.prisma'), 'utf8');

function modelBody(name: string): string {
  const m = schema.match(new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, 'm'));
  if (!m) throw new Error(`model ${name} not found`);
  return m[1];
}
function field(model: string, f: string): string | undefined {
  const line = modelBody(model).split('\n').find((l) => new RegExp(`^\\s*${f}\\s`).test(l));
  return line?.replace(/\/\/.*$/, '').trim().split(/\s+/)[1];
}

describe('tax code schema columns (additive)', () => {
  const cases: Array<[string, string, string]> = [
    ['AbExpense', 'taxCode', 'String?'],
    ['AbExpense', 'recoverableTaxCents', 'Int'],
    ['AbTenantConfig', 'qstRegistered', 'Boolean?'],
    ['AbTenantConfig', 'gstReportingBasis', 'String?'],
    ['AbVendor', 'defaultTaxCode', 'String?'],
  ];
  it.each(cases)('%s.%s is %s', (model, f, type) => {
    expect(field(model, f)).toBe(type);
  });
  it('recoverableTaxCents defaults to 0', () => {
    expect(modelBody('AbExpense')).toMatch(/recoverableTaxCents\s+Int\s+@default\(0\)/);
  });
});
