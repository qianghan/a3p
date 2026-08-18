import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Prod smoke test (alex@agentbook.test, US) hit "file my 2025 taxes" and got
 * a per-form line reading "0.13636363636363635% complete" — the raw
 * filled/total ratio (0-1 scale) interpolated straight into the message with
 * "%" appended, instead of being scaled to a percentage and rounded.
 */

const mockAbConversationCreate = vi.fn(async () => ({}));

vi.mock('../db/client.js', () => ({
  db: {
    abConversation: { create: mockAbConversationCreate },
    abLLMProviderConfig: { findFirst: vi.fn(async () => null) },
  },
}));

const mockFetch = vi.fn();
global.fetch = mockFetch as any;

function classification() {
  return {
    selectedSkill: { name: 'tax-filing-start', endpoint: { method: 'INTERNAL', url: '' }, parameters: {} },
    extractedParams: {},
    confidence: 0.9,
    confirmBefore: false,
    memory: [], skills: [], conversation: [], tenantConfig: { jurisdiction: 'us', region: 'CA' },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      success: true,
      data: {
        jurisdiction: 'us',
        completeness: 3 / 22,
        forms: [{ formCode: '1040', completeness: 3 / 22, status: 'partial' }],
        missingFields: [],
      },
    }),
  });
});

describe('tax-filing-start — completeness formatting', () => {
  it('rounds a per-form completeness ratio to a whole percentage', async () => {
    const { executeClassification } = await import('../server.js');

    const result = await executeClassification(classification(), 'file my 2025 taxes', 'tenant-1', 'api');

    const message = (result as any).responseData.message as string;
    expect(message).not.toContain('0.13636363636363635');
    expect(message).toContain('14% complete');
  });
});
