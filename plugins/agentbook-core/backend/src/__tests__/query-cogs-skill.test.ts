import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PR 5B — the query-cogs chat skill (INTERNAL handler in server.ts): gated on
 * trackInventory, sums the sale-family movements in the asked period (sales
 * minus voids / edit reversals), replies through the catalog in the locale.
 */
const mockCfg = vi.fn();
const mockMoves = vi.fn();
vi.mock('../db/client.js', () => ({
  db: {
    abTenantConfig: { findUnique: (...a: any[]) => mockCfg(...a), findFirst: (...a: any[]) => mockCfg(...a) },
    abStockMovement: { findMany: (...a: any[]) => mockMoves(...a) },
    abConversation: { create: vi.fn(async () => ({})) },
    abSkillRun: { create: vi.fn(async () => ({})) },
  },
}));

import { executeClassification, cogsPeriodFromText } from '../server';
import { BUILT_IN_SKILLS } from '../built-in-skills';

const cls = (tenantConfig: Record<string, unknown> = {}) => ({
  selectedSkill: { name: 'query-cogs', endpoint: { method: 'INTERNAL', url: '' }, parameters: {} },
  extractedParams: {}, confidence: 0.9, confirmBefore: false,
  memory: [], skills: [], conversation: [], tenantConfig,
}) as any;

beforeEach(() => vi.clearAllMocks());

describe('query-cogs', () => {
  it('is registered before general-question', () => {
    const names = BUILT_IN_SKILLS.map((s: any) => s.name);
    expect(names.indexOf('query-cogs')).toBeGreaterThan(-1);
    expect(names.indexOf('query-cogs')).toBeLessThan(names.indexOf('general-question'));
  });

  it('period: this quarter by default; last quarter / this year / this month on request', () => {
    const now = new Date('2026-11-23T12:00:00Z');
    const iso = (p: { from: Date; to: Date }) => [p.from.toISOString().slice(0, 10), p.to.toISOString().slice(0, 10)];
    expect(iso(cogsPeriodFromText("what's my COGS?", now))).toEqual(['2026-10-01', '2027-01-01']);
    expect(iso(cogsPeriodFromText('COGS last quarter', now))).toEqual(['2026-07-01', '2026-10-01']);
    expect(iso(cogsPeriodFromText('COGS this year', now))).toEqual(['2026-01-01', '2027-01-01']);
    expect(iso(cogsPeriodFromText('coût des marchandises vendues ce mois-ci', now))).toEqual(['2026-11-01', '2026-12-01']);
    expect(iso(cogsPeriodFromText('上季度销售成本', new Date('2026-02-10T00:00:00Z')))).toEqual(['2025-10-01', '2026-01-01']);
  });

  it('tracking off → says how to turn it on, reads no movements', async () => {
    mockCfg.mockResolvedValue({ trackInventory: false });
    const r = await executeClassification(cls(), 'cogs', 't1', 'api');
    expect(r.responseData.message).toMatch(/Track inventory/);
    expect(mockMoves).not.toHaveBeenCalled();
  });

  it('nets sales against voids and states the period', async () => {
    mockCfg.mockResolvedValue({ trackInventory: true, currency: 'USD' });
    mockMoves.mockResolvedValue([
      { sourceType: 'stock_sale', valueCents: -3000 },
      { sourceType: 'stock_sale', valueCents: -1250 },
      { sourceType: 'stock_sale_void', valueCents: 1250 },
    ]);
    const r = await executeClassification(cls(), "what's my COGS this year?", 't1', 'api');
    expect(r.skillResponse.data.cogsCents).toBe(3000);
    expect(r.responseData.message).toMatch(/Cost of goods sold for this year \(\d{4}-01-01 – \d{4}-12-31\): \*\*\$30\*\*/);
    const where = mockMoves.mock.calls[0][0].where;
    expect(where.sourceType.in).toEqual(['stock_sale', 'stock_sale_void', 'stock_sale_edit_reverse']);
  });

  it('a sale fully netted by its void reads $0, never -$0', async () => {
    mockCfg.mockResolvedValue({ trackInventory: true, currency: 'USD' });
    mockMoves.mockResolvedValue([
      { sourceType: 'stock_sale', valueCents: -1250 },
      { sourceType: 'stock_sale_void', valueCents: 1250 },
    ]);
    const r = await executeClassification(cls(), "what's my COGS this quarter?", 't1', 'api');
    expect(Object.is(r.skillResponse.data.cogsCents, -0)).toBe(false);
    expect(r.responseData.message).toContain('**$0**');
    expect(r.responseData.message).not.toContain('-$0');
  });

  it('replies in fr-CA through the catalog', async () => {
    mockCfg.mockResolvedValue({ trackInventory: true, currency: 'CAD' });
    mockMoves.mockResolvedValue([]);
    const r = await executeClassification(cls({ locale: 'fr-CA' }), 'cogs', 't1', 'api');
    expect(r.responseData.message).toContain('Aucun article stocké n’a été vendu pour ce trimestre');
  });
});
