import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTestContext } from './helpers/test-context';
import { BUILT_IN_SKILLS } from '../built-in-skills';

/**
 * The classifier must route against CODE, not against whatever is in the
 * skill table.
 *
 * `set-vendor-alias` shipped in #443, passed its routing unit test, deployed,
 * and then did nothing at all in production — "SBUX is Starbucks" and even
 * "rename SBUX to Starbucks" both fell through to general-question. It is the
 * only one of the 84 built-ins with no AbSkillManifest row, and that is what
 * exposed the defect: the message route carefully reconciles code over DB and
 * appends code-only skills, but handleAgentMessage then runs its OWN
 * `abSkillManifest.findMany` and hands THAT array to the classifier. The
 * route's array only ever reached executeStep. So the reconcile was dead code
 * on every channel, and a skill with no row could not be routed to.
 *
 * skill-manifest-query-order.test.ts states the inverse as fact — "this covers
 * agent-brain's OWN fetch, which only runs when the caller passes no skills".
 * The fetch is unconditional. The comment described an intent nobody had
 * implemented, which is why nothing caught this for 83 skills: they all had
 * rows, so DB and code agreed by luck rather than by construction.
 *
 * These tests assert on the array the CLASSIFIER receives, because that is the
 * only array that decides routing.
 */

/** Rows as production actually has them: no set-vendor-alias, and one drifted. */
const DB_ROWS = [
  {
    id: 'row-record-expense',
    tenantId: null,
    source: 'built_in',
    enabled: true,
    name: 'record-expense',
    description: 'stale description from the DB',
    category: 'bookkeeping',
    // Drifted: the real skill's patterns live in code and were edited there.
    triggerPatterns: ['^stale-drifted-pattern$'],
    requirePatterns: [],
    excludePatterns: [],
    parameters: {},
    endpoint: null,
    responseTemplate: null,
    confirmBefore: false,
  },
  {
    id: 'row-daily-briefing',
    tenantId: null,
    source: 'built_in',
    // The admin turned this off in the UI. It must stay off.
    enabled: false,
    name: 'daily-briefing',
    description: 'disabled by the admin',
    category: 'reporting',
    triggerPatterns: ['daily briefing'],
    requirePatterns: [],
    excludePatterns: [],
    parameters: {},
    endpoint: null,
    responseTemplate: null,
    confirmBefore: false,
  },
  {
    id: 'row-tenant-custom',
    tenantId: 'test-tenant',
    source: 'custom',
    enabled: true,
    name: 'record-expense',
    description: 'a tenant customisation of a built-in name',
    category: 'bookkeeping',
    triggerPatterns: ['^my very own pattern$'],
    requirePatterns: [],
    excludePatterns: [],
    parameters: {},
    endpoint: null,
    responseTemplate: null,
    confirmBefore: false,
  },
];

// The mock APPLIES the where clause. A fixed array that ignores `enabled`
// cannot fail on a bug whose cause IS the filter — that is how the silent
// skill re-enable in #427 stayed green.
const skillManifestFindMany = vi.fn(async (args: any = {}) => {
  const where = args?.where ?? {};
  return DB_ROWS.filter((r) => {
    if (where.enabled !== undefined && r.enabled !== where.enabled) return false;
    if (Array.isArray(where.OR)) {
      const ok = where.OR.some((c: any) =>
        'tenantId' in c ? c.tenantId === r.tenantId : true,
      );
      if (!ok) return false;
    }
    return true;
  });
});

vi.mock('../db/client.js', () => ({
  db: {
    abConversation: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []), create: vi.fn(async () => ({})) },
    abAgentSession: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 0 })) },
    abTaxQuestionnaireSession: { findFirst: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 0 })) },
    abTenantConfig: { findFirst: vi.fn(async () => null) },
    abUserMemory: { findMany: vi.fn(async () => []) },
    abSkillManifest: { findMany: skillManifestFindMany },
    abConvThread: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args: any) => ({ id: 'thread-1', turns: [], ...args.data })),
    },
    abEvent: { create: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(async () => 1),
  },
}));

/** The `skills` argument handed to classifyOnly — index 5 of the call. */
async function skillsSeenByClassifier(text: string) {
  const harness = buildTestContext({
    text,
    tenantId: 'test-tenant',
    classification: {
      selectedSkill: { name: 'record-expense', endpoint: { method: 'POST', path: '/expenses' } },
      confidence: 0.9,
    },
    skillResponses: { 'POST /expenses': { data: { id: 'exp-1' } } },
  });
  const { handleAgentMessage } = await import('../agent-brain');
  await handleAgentMessage(harness.req as any, harness.ctx as any);
  expect(harness.classifyOnly, 'classifyOnly was never called').toHaveBeenCalled();
  // classifyOnly's mock is declared as (text: string), so TS types the call
  // tuple as length 1. The real signature is
  // (text, tenantId, channel, attachments, memory, skills, conversation, tenantConfig).
  const call = harness.classifyOnly.mock.calls[0] as unknown as unknown[];
  return call[5] as Array<Record<string, any>>;
}

beforeEach(() => {
  skillManifestFindMany.mockClear();
});

describe('the classifier routes against code, not the skill table', () => {
  it('sees a built-in that has no DB row', async () => {
    const skills = await skillsSeenByClassifier('SBUX is Starbucks');
    const names = skills.map((s) => s.name);
    expect(
      names,
      'set-vendor-alias exists in BUILT_IN_SKILLS but has no AbSkillManifest row; ' +
        'if the classifier cannot see it, the skill is unreachable in production',
    ).toContain('set-vendor-alias');
  });

  it('sees every enabled built-in, so shipping a skill never needs a seed run', async () => {
    const skills = await skillsSeenByClassifier('spent $5 on coffee');
    const names = new Set(skills.map((s) => s.name));
    // daily-briefing is deliberately excluded — the admin disabled it.
    const missing = BUILT_IN_SKILLS.map((s) => s.name)
      .filter((n) => n !== 'daily-briefing' && !names.has(n));
    expect(missing, `built-ins invisible to the classifier: ${missing.join(', ')}`).toEqual([]);
  });

  it('takes trigger patterns from code when a global built-in row has drifted', async () => {
    const skills = await skillsSeenByClassifier('spent $5 on coffee');
    const global = skills.find((s) => s.name === 'record-expense' && s.tenantId === null);
    expect(global).toBeTruthy();
    expect(
      global!.triggerPatterns,
      'a stale DB row must not decide routing for a global built-in',
    ).not.toContain('^stale-drifted-pattern$');
    const code = BUILT_IN_SKILLS.find((s) => s.name === 'record-expense') as any;
    expect(global!.triggerPatterns).toEqual(code.triggerPatterns);
  });
});

describe('what code authority must NOT override', () => {
  it('keeps a skill the admin disabled disabled', async () => {
    const skills = await skillsSeenByClassifier('spent $5 on coffee');
    expect(
      skills.map((s) => s.name),
      'daily-briefing is off in the DB; the code fallback must not resurrect it',
    ).not.toContain('daily-briefing');
  });

  it('leaves a tenant-scoped customisation alone', async () => {
    const skills = await skillsSeenByClassifier('spent $5 on coffee');
    const custom = skills.find((s) => s.tenantId === 'test-tenant');
    expect(custom, 'the tenant row disappeared').toBeTruthy();
    expect(
      custom!.triggerPatterns,
      'a tenant customisation is not a built-in and code has no business clobbering it',
    ).toEqual(['^my very own pattern$']);
  });
});
