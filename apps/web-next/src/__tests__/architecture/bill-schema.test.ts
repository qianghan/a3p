/** PR 3a: additive bill schema — exact types, optional/default, indexes. */
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

describe('AbBill additive columns', () => {
  const cases: Array<[string, string]> = [
    ['vendorId', 'vendorId String?'],
    ['billNumber', 'billNumber String?'],
    ['billDate', 'billDate DateTime?'],
    ['subtotalCents', 'subtotalCents Int?'],
    ['taxCents', 'taxCents Int?'],
    ['recoverableTaxCents', 'recoverableTaxCents Int @default(0)'],
    ['paidCents', 'paidCents Int @default(0)'],
    ['currency', 'currency String?'],
    ['postingMode', 'postingMode String @default("at_payment")'],
    ['revision', 'revision Int @default(0)'],
    ['idempotencyKey', 'idempotencyKey String?'],
    ['receiptUrl', 'receiptUrl String?'],
    ['deletedAt', 'deletedAt DateTime?'],
  ];
  it.each(cases)('%s', (f, expected) => expect(line('AbBill', f)).toBe(expected));
  it('indexes', () => {
    const b = modelBody('AbBill');
    for (const i of ['[tenantId, status, dueDate]', '[tenantId, billDate]', '[tenantId, deletedAt]'])
      expect(b).toContain(`@@index(${i})`);
    expect(b).toContain('@@index([tenantId, idempotencyKey])');
  });
});

describe('AbBillLine', () => {
  const cases: Array<[string, string]> = [
    ['billId', 'billId String'], ['tenantId', 'tenantId String'], ['description', 'description String'],
    ['categoryId', 'categoryId String?'], ['itemId', 'itemId String?'], ['qty', 'qty Float @default(1)'],
    ['unitCostCents', 'unitCostCents Int @default(0)'], ['amountCents', 'amountCents Int'],
    ['taxCode', 'taxCode String?'], ['taxCents', 'taxCents Int @default(0)'],
    ['recoverableTaxCents', 'recoverableTaxCents Int @default(0)'],
  ];
  it.each(cases)('%s', (f, e) => expect(line('AbBillLine', f)).toBe(e));
  it('index + cascade', () => {
    expect(modelBody('AbBillLine')).toContain('@@index([billId])');
    expect(modelBody('AbBillLine')).toContain('onDelete: Cascade');
  });
});

describe('AbBillPayment', () => {
  const cases: Array<[string, string]> = [
    ['billId', 'billId String'], ['tenantId', 'tenantId String'], ['date', 'date DateTime'],
    ['amountCents', 'amountCents Int'], ['method', 'method String @default("manual")'],
    ['journalEntryId', 'journalEntryId String?'], ['idempotencyKey', 'idempotencyKey String?'],
  ];
  it.each(cases)('%s', (f, e) => expect(line('AbBillPayment', f)).toBe(e));
  it('indexes', () => {
    const b = modelBody('AbBillPayment');
    expect(b).toContain('@@index([billId])');
    expect(b).toContain('@@index([tenantId, date])');
    expect(b).toContain('@@index([tenantId, idempotencyKey])');
  });
});

it('AbBankTransaction.matchedBillId is optional', () => {
  expect(line('AbBankTransaction', 'matchedBillId')).toBe('matchedBillId String?');
});

describe('export + deletion coverage', () => {
  it.each(['abBill', 'abBillLine', 'abBillPayment', 'abEmployee', 'abPayRun', 'abPayStub'])('export reads %s', (m) =>
    expect(exportRoute).toContain(`db.${m}.findMany`));
  it('deletion order: children before AbBill', () => {
    const idx = (n: string) => registry.indexOf(`name: '${n}'`);
    expect(idx('AbBillPayment')).toBeGreaterThan(0);
    expect(idx('AbBillLine')).toBeGreaterThan(0);
    expect(idx('AbBillPayment')).toBeLessThan(idx('AbBill'));
    expect(idx('AbBillLine')).toBeLessThan(idx('AbBill'));
    for (const n of ['AbEmployee', 'AbPayRun', 'AbPayStub']) expect(idx(n)).toBeGreaterThan(0);
  });
});
