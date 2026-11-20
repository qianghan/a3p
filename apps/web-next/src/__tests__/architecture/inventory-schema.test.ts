/** PR 5A.2: additive inventory schema — exact types, optional/default, indexes, registry/export wiring. */
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

describe('AbInventoryItem', () => {
  const cases: Array<[string, string]> = [
    ['sku', 'sku String?'],
    ['name', 'name String'],
    ['unit', 'unit String @default("each")'],
    ['costingMethod', 'costingMethod String @default("wac")'],
    ['onHandQty', 'onHandQty Decimal @default(0) @db.Decimal(14, 4)'],
    ['onHandValueCents', 'onHandValueCents Int @default(0)'],
    ['reorderPoint', 'reorderPoint Decimal? @db.Decimal(14, 4)'],
    ['salePriceCents', 'salePriceCents Int?'],
    ['isActive', 'isActive Boolean @default(true)'],
    ['deletedAt', 'deletedAt DateTime?'],
  ];
  it.each(cases)('%s', (f, expected) => expect(line('AbInventoryItem', f)).toBe(expected));
  it('indexes', () => {
    const b = modelBody('AbInventoryItem');
    expect(b).toContain('@@unique([tenantId, sku])');
    expect(b).toContain('@@index([tenantId])');
  });
});

describe('AbStockMovement', () => {
  const cases: Array<[string, string]> = [
    ['qty', 'qty Decimal @db.Decimal(14, 4)'],
    ['valueCents', 'valueCents Int'],
    ['type', 'type String'],
    ['sourceType', 'sourceType String?'],
    ['sourceId', 'sourceId String?'],
    ['journalEntryId', 'journalEntryId String?'],
  ];
  it.each(cases)('%s', (f, expected) => expect(line('AbStockMovement', f)).toBe(expected));
  it('documents the movement types', () => {
    const l = modelBody('AbStockMovement').split('\n').find((x) => /^\s*type\s/.test(x))!;
    for (const t of ['purchase', 'stock_sale', 'stock_sale_void', 'stock_adjust', 'opening']) expect(l).toContain(t);
  });
  it('indexes', () => {
    const b = modelBody('AbStockMovement');
    expect(b).toContain('@@index([tenantId])');
    expect(b).toContain('@@index([itemId])');
    expect(b).toContain('@@unique([tenantId, sourceType, sourceId])');
  });
});

describe('flags and links', () => {
  it('trackInventory defaults off', () =>
    expect(line('AbTenantConfig', 'trackInventory')).toBe('trackInventory Boolean @default(false)'));
  it('AbInvoiceLine.itemId nullable', () => expect(line('AbInvoiceLine', 'itemId')).toBe('itemId String?'));
  it('AbBillLine.itemId not re-added', () =>
    expect((modelBody('AbBillLine').match(/^\s*itemId\s/gm) || []).length).toBe(1));
});

describe('tenant deletion + export wiring', () => {
  it('registry deletes movements before items', () => {
    const a = registry.indexOf("name: 'AbStockMovement'");
    const b = registry.indexOf("name: 'AbInventoryItem'");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
  });
  it('export includes both', () => {
    expect(exportRoute).toContain('db.abInventoryItem.findMany');
    expect(exportRoute).toContain('db.abStockMovement.findMany');
  });
});
