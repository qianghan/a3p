import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PR 5A.5 — the query-stock chat skill (INTERNAL handler in server.ts):
 * gated on trackInventory, reports computed on-hand qty/value and the
 * low-stock items, replies through the skill catalog in the reply locale.
 */
const mockCfg = vi.fn();
const mockItems = vi.fn();
vi.mock('../db/client.js', () => ({
  db: {
    abTenantConfig: { findUnique: (...a: any[]) => mockCfg(...a), findFirst: (...a: any[]) => mockCfg(...a) },
    abInventoryItem: { findMany: (...a: any[]) => mockItems(...a) },
    abConversation: { create: vi.fn(async () => ({})) },
    abSkillRun: { create: vi.fn(async () => ({})) },
  },
}));

import { executeClassification } from '../server';
import { BUILT_IN_SKILLS } from '../built-in-skills';

const cls = (tenantConfig: Record<string, unknown> = {}) => ({
  selectedSkill: { name: 'query-stock', endpoint: { method: 'INTERNAL', url: '' }, parameters: {} },
  extractedParams: {}, confidence: 0.9, confirmBefore: false,
  memory: [], skills: [], conversation: [], tenantConfig,
}) as any;
const item = (o: Record<string, unknown>) => ({ id: 'i', name: 'Widget', unit: 'each', onHandQty: '15.0000', onHandValueCents: 9000, reorderPoint: null, ...o });

beforeEach(() => vi.clearAllMocks());

describe('query-stock', () => {
  it('is registered before general-question', () => {
    const names = BUILT_IN_SKILLS.map((s: any) => s.name);
    expect(names.indexOf('query-stock')).toBeGreaterThan(-1);
    expect(names.indexOf('query-stock')).toBeLessThan(names.indexOf('general-question'));
  });

  it('tracking off → says how to turn it on, never lists items', async () => {
    mockCfg.mockResolvedValue({ trackInventory: false });
    const r = await executeClassification(cls(), 'what is in stock', 't1', 'api');
    expect(r.responseData.message).toMatch(/Track inventory/);
    expect(mockItems).not.toHaveBeenCalled();
  });

  it('lists qty and value, totals them, and names the low-stock items', async () => {
    mockCfg.mockResolvedValue({ trackInventory: true, currency: 'USD' });
    mockItems.mockResolvedValue([
      item({ name: 'Widget' }),
      item({ name: 'Gadget', onHandQty: '2.5000', onHandValueCents: 1250, reorderPoint: '3.0000' }),
    ]);
    const r = await executeClassification(cls(), 'what is in stock', 't1', 'api');
    const m: string = r.responseData.message;
    expect(m).toContain('**2 items** in stock, worth $102.50');
    expect(m).toContain('Widget: 15 each ($90)');
    expect(m).toContain('Gadget: 2.5 each ($12.50)');
    expect(m).toMatch(/\*\*1 item\*\* is at or below its reorder point:\n• Gadget/);
    expect(m).not.toMatch(/• Widget\n?$/);
  });

  it('replies in the tenant locale through the catalog (fr-CA)', async () => {
    mockCfg.mockResolvedValue({ trackInventory: true, currency: 'CAD' });
    mockItems.mockResolvedValue([item({ name: 'Widget' })]);
    const r = await executeClassification(cls({ locale: 'fr-CA' }), 'stock', 't1', 'api');
    expect(r.responseData.message).toContain('**1 article** en stock');
  });
});
