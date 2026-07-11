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

describe('student chat skills — save-scholarship candidate resolution', () => {
  const CANDIDATES = [
    { title: 'Chen Family Award', amountText: '$2,000', deadlineText: 'June 1', sourceUrl: 'https://example.edu/chen', sourceLabel: 'example.edu' },
    { title: 'TD Community Scholarship', amountText: '$1,000', deadlineText: 'July 15', sourceUrl: 'https://td.com/scholarship', sourceLabel: 'td.com' },
  ];

  beforeEach(() => {
    mockAbTenantConfigFindUnique.mockResolvedValue({ businessType: 'student' });
    mockHasAddOn.mockResolvedValue(true);
  });

  it('resolves "save the first one" via ordinal to the first candidate and posts it', async () => {
    mockAbConversationFindFirst.mockResolvedValueOnce({ skillUsed: 'find-scholarships', data: { success: true, data: { candidates: CANDIDATES } } });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { id: 'opp-1' } }) });
    const result = await executeClassification(classification('save-scholarship'), 'save the first one', 'tenant-1', 'api');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/v1/agentbook-scholarship/opportunities');
    const body = JSON.parse((opts as any).body);
    expect(body.title).toBe('Chen Family Award');
    expect(result.responseData.message).toMatch(/Chen Family Award/);
  });

  it('resolves "save the TD one" via fuzzy title match to the second candidate', async () => {
    mockAbConversationFindFirst.mockResolvedValueOnce({ skillUsed: 'find-scholarships', data: { success: true, data: { candidates: CANDIDATES } } });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { id: 'opp-2' } }) });
    await executeClassification(classification('save-scholarship'), 'save the TD one', 'tenant-1', 'api');
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse((opts as any).body);
    expect(body.title).toBe('TD Community Scholarship');
  });

  it('falls back to direct free-text extraction when there is no prior find-scholarships turn', async () => {
    mockAbConversationFindFirst.mockResolvedValueOnce(null);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { id: 'opp-3' } }) });
    await executeClassification(
      classification('save-scholarship', { title: 'Rotary Club Award', amountText: '$500', deadlineText: '2027-06-01' }),
      'save a scholarship called the Rotary Club Award, $500, due June 1',
      'tenant-1', 'api',
    );
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse((opts as any).body);
    expect(body.title).toBe('Rotary Club Award');
  });

  it('asks for clarification when nothing resolves (no prior turn, no direct title)', async () => {
    mockAbConversationFindFirst.mockResolvedValueOnce(null);
    const result = await executeClassification(classification('save-scholarship'), 'save that one', 'tenant-1', 'api');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.responseData.message).toMatch(/not sure which/i);
  });
});

describe('student chat skills — save-coop-opportunity candidate resolution', () => {
  const JOB_CANDIDATES = [
    { title: 'Software Engineering Co-op', employer: 'Shopify', location: 'Remote', compText: '$28/hr', deadlineText: 'March 1', sourceUrl: 'https://shopify.com/careers/1', sourceLabel: 'shopify.com' },
    { title: 'Data Analyst Intern', employer: 'RBC', location: 'Toronto, ON', compText: '$25/hr', deadlineText: 'February 15', sourceUrl: 'https://rbc.com/careers/2', sourceLabel: 'rbc.com' },
  ];

  beforeEach(() => {
    mockAbTenantConfigFindUnique.mockResolvedValue({ businessType: 'student' });
    mockHasAddOn.mockResolvedValue(true);
  });

  it('resolves "save the first one" via ordinal and posts it', async () => {
    mockAbConversationFindFirst.mockResolvedValueOnce({ skillUsed: 'find-coop-opportunities', data: { success: true, data: { candidates: JOB_CANDIDATES } } });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { id: 'job-1' } }) });
    const result = await executeClassification(classification('save-coop-opportunity'), 'save the first one', 'tenant-1', 'api');
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/v1/agentbook-career/opportunities');
    const body = JSON.parse((opts as any).body);
    expect(body.title).toBe('Software Engineering Co-op');
    expect(body.employer).toBe('Shopify');
    expect(result.responseData.message).toMatch(/Software Engineering Co-op/);
  });

  it('resolves "save the RBC one" via fuzzy employer/title match', async () => {
    mockAbConversationFindFirst.mockResolvedValueOnce({ skillUsed: 'find-coop-opportunities', data: { success: true, data: { candidates: JOB_CANDIDATES } } });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { id: 'job-2' } }) });
    await executeClassification(classification('save-coop-opportunity'), 'save the RBC one', 'tenant-1', 'api');
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse((opts as any).body);
    expect(body.title).toBe('Data Analyst Intern');
  });

  it('falls back to direct free-text extraction when there is no prior find-coop-opportunities turn', async () => {
    mockAbConversationFindFirst.mockResolvedValueOnce(null);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { id: 'job-3' } }) });
    await executeClassification(
      classification('save-coop-opportunity', { title: 'Marketing Intern', employer: 'Local Startup Co' }),
      'save this marketing intern role at Local Startup Co',
      'tenant-1', 'api',
    );
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse((opts as any).body);
    expect(body.title).toBe('Marketing Intern');
    expect(body.employer).toBe('Local Startup Co');
  });
});
