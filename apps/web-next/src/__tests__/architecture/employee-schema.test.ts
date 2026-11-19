/** PR 4a: additive employee/payroll schema — exact types, optional/default, privacy. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const schema = readFileSync(join(ROOT, 'packages/database/prisma/schema.prisma'), 'utf8');
const registry = readFileSync(join(ROOT, 'apps/web-next/src/lib/agentbook-tenant-data-models.ts'), 'utf8');
const exportRoute = readFileSync(join(ROOT, 'apps/web-next/src/app/api/v1/agentbook/me/export/route.ts'), 'utf8');

function modelBody(name: string): string {
  const m = schema.match(new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, 'm'));
  if (!m) throw new Error(`model ${name} not found`);
  return m[1];
}
function line(model: string, f: string): string {
  const l = modelBody(model).split('\n').find((x) => new RegExp(`^\\s*${f}\\s`).test(x));
  if (!l) throw new Error(`${model}.${f} missing`);
  return l.replace(/\/\/.*$/, '').trim().split(/\s+/).join(' ');
}

describe('AbEmployee additive columns', () => {
  const cases: Array<[string, string]> = [
    ['phone', 'phone String?'], ['address', 'address String?'],
    ['dateOfBirth', 'dateOfBirth DateTime?'], ['endDate', 'endDate DateTime?'],
    ['employmentBasis', 'employmentBasis String?'], ['payAnchorDate', 'payAnchorDate DateTime?'],
    ['taxFreeThreshold', 'taxFreeThreshold Boolean?'], ['residency', 'residency String?'],
    ['helpDebt', 'helpDebt Boolean?'], ['td1Federal', 'td1Federal Int?'],
    ['td1Provincial', 'td1Provincial Int?'], ['cppExempt', 'cppExempt Boolean?'],
    ['eiExempt', 'eiExempt Boolean?'], ['extraWithholdingCents', 'extraWithholdingCents Int?'],
  ];
  it.each(cases)('%s', (f, expected) => expect(line('AbEmployee', f)).toBe(expected));
});

describe('AbPayRun additive columns', () => {
  it('payDate', () => expect(line('AbPayRun', 'payDate')).toBe('payDate DateTime?'));
  it('payFrequency', () => expect(line('AbPayRun', 'payFrequency')).toBe('payFrequency String?'));
});

describe('AbEmployeeSensitive', () => {
  const cases: Array<[string, string]> = [
    ['tenantId', 'tenantId String'], ['employeeId', 'employeeId String @unique'],
    ['taxIdEnc', 'taxIdEnc String?'], ['taxIdLast4', 'taxIdLast4 String?'],
    ['bankAccountEnc', 'bankAccountEnc String?'], ['bankLast4', 'bankLast4 String?'],
    ['bankRoutingLabel', 'bankRoutingLabel String?'], ['superFundUsi', 'superFundUsi String?'],
    ['superFundName', 'superFundName String?'], ['superMemberNumberEnc', 'superMemberNumberEnc String?'],
  ];
  it.each(cases)('%s', (f, expected) => expect(line('AbEmployeeSensitive', f)).toBe(expected));
  it('has no plaintext tax-id / bank / member-number columns', () => {
    const names = modelBody('AbEmployeeSensitive').split('\n')
      .map((l) => l.trim().split(/\s+/)[0]).filter((n) => /^[a-z]\w*$/.test(n));
    const plain = names.filter((n) => /(tax|tfn|sin|ssn|bank|account|member|routing)/i.test(n)
      && !/(Enc|Last4|Label|tenantId)$/.test(n));
    expect(plain).toEqual([]);
    expect(names).not.toEqual(expect.arrayContaining(['taxId', 'bankAccount', 'superMemberNumber']));
  });
});

describe('AbEmployeeChange', () => {
  const cases: Array<[string, string]> = [
    ['actorId', 'actorId String'], ['action', 'action String @default("update")'],
    ['fields', 'fields String[]'], ['createdAt', 'createdAt DateTime @default(now())'],
  ];
  it.each(cases)('%s', (f, expected) => expect(line('AbEmployeeChange', f)).toBe(expected));
  it('stores no values', () => {
    const names = modelBody('AbEmployeeChange');
    expect(names).not.toMatch(/\b(oldValue|newValue|before|after|value)\b\s/);
  });
});

describe('privacy plumbing', () => {
  it('registered for tenant deletion before AbEmployee', () => {
    const i = (n: string) => registry.indexOf(`{ name: '${n}',`);
    expect(i('AbEmployeeSensitive')).toBeGreaterThan(-1);
    expect(i('AbEmployeeChange')).toBeGreaterThan(-1);
    expect(i('AbEmployeeSensitive')).toBeLessThan(i('AbEmployee'));
    expect(i('AbEmployeeChange')).toBeLessThan(i('AbEmployee'));
  });
  it('me/export includes the audit trail but never AbEmployeeSensitive', () => {
    expect(exportRoute).toContain('db.abEmployeeChange.findMany');
    expect(exportRoute).not.toMatch(/db\.abEmployeeSensitive\./);
  });
});
