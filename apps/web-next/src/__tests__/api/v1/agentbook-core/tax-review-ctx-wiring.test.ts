/**
 * CHANNEL-PARITY WIRING GUARD for the Tax Review Agent's mid-review
 * interception (ctx.checkActiveTaxReview / ctx.answerTaxReview).
 *
 * The original wiring lived inline in ONE ctx-construction site: the
 * dev-only Express route in plugins/agentbook-core/backend/src/server.ts.
 * The three sites that actually serve users in production — web chat,
 * Telegram, WhatsApp — each build their own ctx and supplied neither
 * function, so the whole interception path was dead code everywhere real
 * users live, while agent-brain's unit tests (which inject the ctx
 * themselves) stayed green. This repo calls that failure mode
 * "adapter-only logic" / "channel asymmetry".
 *
 * Two layers, deliberately:
 *   1. A behavioural check on the web chat route: the ctx it really hands
 *      to handleAgentMessage carries both functions, sourced from the
 *      shared factory.
 *   2. A source-level check on all four ctx sites, which is the only way
 *      to cover the Telegram and WhatsApp webhooks (wrapped in signature
 *      verification and channel bookkeeping) without turning this into an
 *      integration test.
 *
 * The factory's own behaviour — URLs, headers, fail-open on a non-JSON
 * reply — is covered where it lives, in
 * plugins/agentbook-core/backend/src/__tests__/tax-review-ctx-factory.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const handleAgentMessage = vi.fn(async () => ({ success: true, data: { message: 'ok' } }));
vi.mock('@agentbook-core/agent-brain', () => ({
  handleAgentMessage: (...a: unknown[]) => handleAgentMessage(...a),
}));

// Sentinels, so the assertion below proves the route took its two ctx
// entries FROM the shared factory rather than reimplementing them.
const checkActiveTaxReview = vi.fn();
const answerTaxReview = vi.fn();
const buildTaxReviewCtx = vi.fn(() => ({ checkActiveTaxReview, answerTaxReview }));

vi.mock('@agentbook-core/server', () => ({
  buildTaxReviewCtx: (...a: unknown[]) => buildTaxReviewCtx(...a),
  callGemini: vi.fn(),
  classifyAndExecuteV1: vi.fn(),
  classifyOnly: vi.fn(),
  executeClassification: vi.fn(),
}));

vi.mock('@naap/database', () => ({
  prisma: { abSkillManifest: { findMany: vi.fn(async () => []) } },
}));
vi.mock('@agentbook-core/skill-source', () => ({
  reconcileSkills: (rows: unknown[]) => rows,
  SKILL_QUERY: () => ({}),
}));
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: vi.fn(async () => ({ tenantId: 'tenant-1' })),
}));
vi.mock('@/lib/agentbook-rate-limit', () => ({
  checkAndIncrement: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('@/lib/agentbook-grounding', () => ({ buildGroundingFacts: vi.fn() }));
vi.mock('@/lib/tax-fast-track-draft', () => ({ generateFilingDraft: vi.fn() }));
vi.mock('@/lib/agentbook-config', () => ({
  getAppBaseUrl: () => 'https://app.example',
  getPluginBaseUrls: () => ({ '/api/v1/agentbook-tax': 'https://tax.example' }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  handleAgentMessage.mockResolvedValue({ success: true, data: { message: 'ok' } });
  buildTaxReviewCtx.mockReturnValue({ checkActiveTaxReview, answerTaxReview });
});

function agentPost(text = 'looks good') {
  return new NextRequest('http://x/api/v1/agentbook-core/agent/message', {
    method: 'POST',
    body: JSON.stringify({ text }),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('web chat route supplies the tax-review ctx functions', () => {
  it('hands handleAgentMessage both checkActiveTaxReview and answerTaxReview, from the shared factory', async () => {
    const { POST } = await import('@/app/api/v1/agentbook-core/agent/message/route');
    await POST(agentPost());

    expect(buildTaxReviewCtx).toHaveBeenCalledTimes(1);
    const ctx = handleAgentMessage.mock.calls[0][1] as Record<string, unknown>;
    expect(ctx.checkActiveTaxReview).toBe(checkActiveTaxReview);
    expect(ctx.answerTaxReview).toBe(answerTaxReview);
  });

  it('gives the factory the plugin baseUrls map, so it targets the tax host and not a localhost default', async () => {
    const { POST } = await import('@/app/api/v1/agentbook-core/agent/message/route');
    await POST(agentPost());

    expect(buildTaxReviewCtx).toHaveBeenCalledWith(
      expect.objectContaining({ '/api/v1/agentbook-tax': 'https://tax.example' }),
    );
  });
});

/**
 * Every ctx-construction site, by source. The behavioural test above can
 * only reach the web chat route; these catch a channel being added, or the
 * shared factory being dropped from one, without spinning up grammY or
 * WhatsApp signature verification.
 */
// Paths are resolved from the vitest root (apps/web-next) rather than
// import.meta.url — under the jsdom environment that is an http:// URL,
// which readFileSync rejects.
const CTX_SITES: { label: string; file: string }[] = [
  {
    label: 'web chat (apps/web-next agent/message)',
    file: resolve(process.cwd(), 'src/app/api/v1/agentbook-core/agent/message/route.ts'),
  },
  {
    label: 'Telegram webhook',
    file: resolve(process.cwd(), 'src/app/api/v1/agentbook/telegram/webhook/route.ts'),
  },
  {
    label: 'WhatsApp webhook',
    file: resolve(process.cwd(), 'src/app/api/v1/agentbook/whatsapp/webhook/route.ts'),
  },
  {
    label: 'dev Express agent/message route',
    file: resolve(process.cwd(), '../../plugins/agentbook-core/backend/src/server.ts'),
  },
];

/** Comment lines are dropped so a prose mention of `handleAgentMessage(`
 *  in a file header isn't mistaken for a call site. */
function codeLinesOnly(src: string): string {
  return src
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

function callSiteOffsets(src: string): number[] {
  const offsets: number[] = [];
  for (let i = src.indexOf('handleAgentMessage('); i !== -1; i = src.indexOf('handleAgentMessage(', i + 1)) {
    offsets.push(i);
  }
  return offsets;
}

describe('every agent-brain ctx site wires the tax-review functions', () => {
  for (const site of CTX_SITES) {
    it(`${site.label} passes buildTaxReviewCtx into every ctx it builds`, () => {
      const src = codeLinesOnly(readFileSync(site.file, 'utf-8'));
      const offsets = callSiteOffsets(src);
      expect(offsets.length, 'expected this file to construct an agent-brain ctx').toBeGreaterThan(0);
      for (const offset of offsets) {
        // The ctx object is the second argument; a generous window covers
        // both the one-line (Telegram/WhatsApp) and multi-line (web chat,
        // Express) formattings.
        expect(src.slice(offset, offset + 2500)).toContain('buildTaxReviewCtx(');
      }
    });
  }
});
