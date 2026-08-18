/**
 * The skill list the web chat route hands to the agent brain.
 *
 * Two properties, both asserted against the real POST handler rather than a
 * mirror of its merge — the defects were in what the route actually did with
 * the DB, and a mirror would have kept passing through both of them.
 *
 *   1. The fetch asks for a deterministic row order. Routing takes the FIRST
 *      skill whose triggers match, so an unordered array makes the winner of
 *      any pattern collision undefined. PR-5 fixed agent-brain's internal
 *      fetch, but this route passes its own `skills`, so agent-brain never runs
 *      that fetch in production — see skill-manifest-order.test.ts.
 *
 *   2. A skill an admin disabled in the DB stays disabled. `dbSkills` is
 *      filtered to `enabled: true`, and the built-in fallback re-added any
 *      BUILT_IN_SKILLS name missing from that filtered list — so disabling a
 *      built-in skill in the admin UI removed its row from the query result and
 *      the fallback silently put it straight back, marked `enabled: true`.
 *      Nothing downstream re-checks `enabled`, so the skill kept routing. The
 *      admin toggle is explicitly meant to win over code: see the "CODE IS
 *      AUTHORITATIVE" comment in the route and skill-reconciliation.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

/**
 * A fake that APPLIES the where clause instead of ignoring it.
 *
 * This matters more than it looks: the disable leak lives entirely in the gap
 * between "rows in the table" and "rows the query returns". A mock that resolves
 * a fixed array whatever it is asked hands the route a disabled row it would
 * never see in production, so the row lands in `seenNames`, the fallback finds
 * nothing missing, and the bug is invisible. Filtering here is what makes the
 * test able to fail.
 */
const skillManifestFindMany = vi.fn();
let table: ReturnType<typeof row>[] = [];

function fakeFindMany(args: {
  where?: { enabled?: boolean; OR?: Array<{ tenantId: string | null }> };
  orderBy?: unknown;
}) {
  let rows = table;
  if (args?.where?.enabled !== undefined) {
    rows = rows.filter((r) => r.enabled === args.where!.enabled);
  }
  if (args?.where?.OR) {
    const scopes = args.where.OR.map((c) => c.tenantId);
    rows = rows.filter((r) => scopes.includes(r.tenantId));
  }
  return rows;
}

vi.mock('@naap/database', () => ({
  prisma: {
    abSkillManifest: { findMany: (...a: unknown[]) => skillManifestFindMany(...a) },
  },
}));

const handleAgentMessage = vi.fn();
vi.mock('@agentbook-core/agent-brain', () => ({
  handleAgentMessage: (...a: unknown[]) => handleAgentMessage(...a),
}));

vi.mock('@agentbook-core/server', () => ({
  callGemini: vi.fn(),
  classifyAndExecuteV1: vi.fn(),
  classifyOnly: vi.fn(),
  executeClassification: vi.fn(),
  // Mid-review interception for the Tax Review Agent. The route spreads the
  // factory's result into the ctx, so this must return an object even though
  // this file asserts nothing about it.
  buildTaxReviewCtx: vi.fn(() => ({ checkActiveTaxReview: vi.fn(), answerTaxReview: vi.fn() })),
}));

/**
 * A two-skill stand-in for the real 84. The properties under test are about the
 * merge, not about any particular skill, and a fixture keeps the assertions
 * readable and stable as BUILT_IN_SKILLS grows.
 */
vi.mock('@agentbook-core/built-in-skills', () => ({
  BUILT_IN_SKILLS: [
    {
      name: 'manage-bills',
      description: 'bills',
      category: 'bookkeeping',
      triggerPatterns: ['bills?.*due'],
      excludePatterns: ['owe.*tax'],
    },
    {
      name: 'never-seeded-skill',
      description: 'has no DB row at all',
      category: 'finance',
      triggerPatterns: ['something'],
    },
  ],
}));

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: vi.fn(async () => ({ tenantId: 'tenant-1' })),
}));

vi.mock('@/lib/agentbook-rate-limit', () => ({
  checkAndIncrement: vi.fn(async () => ({ allowed: true })),
}));

vi.mock('@/lib/agentbook-config', () => ({
  getAppBaseUrl: () => 'https://x.example',
  getPluginBaseUrls: () => ({}),
}));

vi.mock('@/lib/tax-fast-track-draft', () => ({
  generateFilingDraft: vi.fn(),
}));

import { POST } from '@/app/api/v1/agentbook-core/agent/message/route';

/** A DB row shaped like AbSkillManifest, global + built-in unless overridden. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    tenantId: null,
    name: 'manage-bills',
    description: 'stale db description',
    category: 'bookkeeping',
    triggerPatterns: ['bills? due'],
    requirePatterns: [],
    excludePatterns: [],
    parameters: {},
    endpoint: null,
    responseTemplate: null,
    confirmBefore: false,
    enabled: true,
    source: 'built_in',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...over,
  };
}

function postReq(text = 'what bills are due?') {
  return new NextRequest('http://x/api/v1/agentbook-core/agent/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

/** The `skills` array the route handed the brain on its last call. */
function skillsPassedToBrain(): Array<{ name: string; enabled: boolean }> {
  const ctx = handleAgentMessage.mock.calls.at(-1)?.[1] as { skills: Array<{ name: string; enabled: boolean }> };
  return ctx.skills;
}

beforeEach(() => {
  table = [];
  skillManifestFindMany.mockReset();
  skillManifestFindMany.mockImplementation(async (args) => fakeFindMany(args));
  handleAgentMessage.mockReset();
  handleAgentMessage.mockResolvedValue({ success: true, data: { message: 'ok' } });
});

describe('web chat skill fetch — deterministic order', () => {
  it('asks the DB for skills ordered by name ascending', async () => {
    await POST(postReq());

    expect(skillManifestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { name: 'asc' } }),
    );
  });

  it('preserves the DB order it asked for when handing skills to the brain', async () => {
    // The route must not re-sort, group, or reverse on the way through; the
    // ordered fetch is the whole mechanism.
    table = [
      row({ id: 'a', name: 'aaa-skill' }),
      row({ id: 'm', name: 'manage-bills' }),
      row({ id: 'z', name: 'zzz-skill' }),
    ];
    await POST(postReq());

    const names = skillsPassedToBrain().map((s) => s.name);
    expect(names.slice(0, 3)).toEqual(['aaa-skill', 'manage-bills', 'zzz-skill']);
  });
});

describe('web chat skill fetch — the admin disable toggle wins', () => {
  it('does NOT re-add a built-in skill the admin disabled in the DB', async () => {
    // The row exists and says enabled: false. Before the fix the `enabled: true`
    // query dropped it, the fallback saw the name as missing, and re-created it
    // with enabled: true — resurrecting a skill an admin had switched off.
    table = [row({ name: 'manage-bills', enabled: false })];
    await POST(postReq());

    const skills = skillsPassedToBrain();
    const bills = skills.filter((s) => s.name === 'manage-bills');
    // Either absent, or present and still disabled — never routable.
    expect(bills.every((s) => s.enabled === false)).toBe(true);
    expect(skills.some((s) => s.name === 'manage-bills' && s.enabled)).toBe(false);
  });

  it('still falls back to code for a built-in skill with no DB row', async () => {
    // The fallback's actual purpose: an unseeded built-in must reach the brain.
    // Fixing the disable leak must not disable it.
    table = [row({ name: 'manage-bills', enabled: false })];
    await POST(postReq());

    const unseeded = skillsPassedToBrain().find((s) => s.name === 'never-seeded-skill');
    expect(unseeded).toBeDefined();
    expect(unseeded!.enabled).toBe(true);
  });

  it('keeps an enabled built-in row, with its definition read from code', async () => {
    table = [row({ name: 'manage-bills', enabled: true })];
    await POST(postReq());

    const bills = skillsPassedToBrain().find((s) => s.name === 'manage-bills') as unknown as {
      enabled: boolean;
      triggerPatterns: string[];
      excludePatterns: string[];
    };
    expect(bills.enabled).toBe(true);
    expect(bills.triggerPatterns).toEqual(['bills?.*due']); // code, not the stale DB value
    expect(bills.excludePatterns).toEqual(['owe.*tax']);
  });

  it('leaves a disabled tenant-scoped custom skill disabled too', async () => {
    // Not a built-in, so the fallback was never the risk here — but the same
    // filtered-query/re-add shape must not leak a tenant's own disabled skill.
    table = [
      row({ id: 'c', name: 'tenant-custom', tenantId: 'tenant-1', source: 'custom', enabled: false }),
    ];
    await POST(postReq());

    expect(skillsPassedToBrain().some((s) => s.name === 'tenant-custom' && s.enabled)).toBe(false);
  });
});
