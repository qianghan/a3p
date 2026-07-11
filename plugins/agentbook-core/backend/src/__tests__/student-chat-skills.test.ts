import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAbTenantConfigFindUnique = vi.fn();
const mockAbConversationFindFirst = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    abTenantConfig: { findUnique: (...args: any[]) => mockAbTenantConfigFindUnique(...args) },
    abConversation: {
      findFirst: (...args: any[]) => mockAbConversationFindFirst(...args),
      create: vi.fn(async () => ({})),
    },
    abAccount: { findMany: vi.fn(async () => []) },
    abEvent: { create: vi.fn(async () => ({})) },
  },
}));

const mockHasAddOn = vi.fn();
vi.mock('@naap/billing', () => ({ hasAddOn: (...args: any[]) => mockHasAddOn(...args) }));

const mockFetch = vi.fn();
global.fetch = mockFetch as any;

import { executeClassification } from '../server';

const SKILL_ENDPOINTS: Record<string, any> = {
  'find-scholarships': { method: 'POST', url: '/api/v1/agentbook-scholarship/discover' },
  'save-scholarship': { method: 'INTERNAL', url: '' },
  'find-coop-opportunities': { method: 'POST', url: '/api/v1/agentbook-career/discover' },
  'save-coop-opportunity': { method: 'INTERNAL', url: '' },
  'find-roommate-matches': { method: 'GET', url: '/api/v1/agentbook-housing/roommate/matches' },
};

function classification(name: string, extractedParams: Record<string, any> = {}) {
  return {
    selectedSkill: { name, endpoint: SKILL_ENDPOINTS[name], parameters: {} },
    extractedParams,
    confidence: 0.9,
    confirmBefore: false,
    memory: [], skills: [], conversation: [], tenantConfig: {},
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('student chat skills — eligibility gate', () => {
  it('blocks find-scholarships for a non-student tenant with a friendly nudge, makes no HTTP call', async () => {
    mockAbTenantConfigFindUnique.mockResolvedValueOnce({ businessType: 'freelancer' });
    const result = await executeClassification(classification('find-scholarships'), 'find me a scholarship', 'tenant-1', 'api');
    expect(result.responseData.message).toMatch(/Student Success/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('blocks find-scholarships for a student tenant missing the add-on', async () => {
    mockAbTenantConfigFindUnique.mockResolvedValueOnce({ businessType: 'student' });
    mockHasAddOn.mockResolvedValueOnce(false);
    const result = await executeClassification(classification('find-scholarships'), 'find me a scholarship', 'tenant-1', 'api');
    expect(result.responseData.message).toMatch(/Student Success/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('allows find-scholarships through to the HTTP call for an eligible tenant', async () => {
    mockAbTenantConfigFindUnique.mockResolvedValueOnce({ businessType: 'student' });
    mockHasAddOn.mockResolvedValueOnce(true);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { candidates: [], note: 'ok' } }) });
    await executeClassification(classification('find-scholarships', { query: 'chemistry' }), 'find scholarships for chemistry majors', 'tenant-1', 'api');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/v1/agentbook-scholarship/discover');
  });

  it('blocks find-roommate-matches the same way', async () => {
    mockAbTenantConfigFindUnique.mockResolvedValueOnce({ businessType: 'freelancer' });
    const result = await executeClassification(classification('find-roommate-matches'), 'find me a roommate', 'tenant-1', 'api');
    expect(result.responseData.message).toMatch(/Student Success/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('blocks save-scholarship for an ineligible tenant before any candidate resolution', async () => {
    mockAbTenantConfigFindUnique.mockResolvedValueOnce({ businessType: 'freelancer' });
    const result = await executeClassification(classification('save-scholarship'), 'save the first one', 'tenant-1', 'api');
    expect(result.responseData.message).toMatch(/Student Success/);
    expect(mockAbConversationFindFirst).not.toHaveBeenCalled();
  });
});
