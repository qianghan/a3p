import { describe, it, expect, vi, beforeEach } from 'vitest';

const findFirst = vi.fn();
const seedCanadianForms = vi.fn().mockResolvedValue({ created: 4, updated: 0 });
const seedUsForms = vi.fn().mockResolvedValue({ created: 2, updated: 0 });
const seedAuForms = vi.fn().mockResolvedValue({ created: 2, updated: 0 });

vi.mock('../tax-forms.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tax-forms.js')>();
  return { ...actual, seedCanadianForms, seedUsForms, seedAuForms };
});

vi.mock('../db/client.js', () => ({
  db: {
    abTenantConfig: { findFirst: vi.fn().mockResolvedValue({ jurisdiction: 'us', region: 'CA' }) },
    abTaxFiling: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'f1' }), update: vi.fn() },
    abTaxFormTemplate: { findMany: (...args: any[]) => findFirst(...args) },
    abTaxSlip: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

beforeEach(() => { findFirst.mockResolvedValue([]); });

describe('populateFiling — jurisdiction-aware seed dispatch', () => {
  it('seeds US forms (not CA forms) for a us-jurisdiction tenant with no templates yet', async () => {
    const { populateFiling } = await import('../tax-filing.js');
    await populateFiling('tenant-1', 2025);
    expect(seedUsForms).toHaveBeenCalled();
    expect(seedCanadianForms).not.toHaveBeenCalled();
    expect(seedAuForms).not.toHaveBeenCalled();
  });
});
