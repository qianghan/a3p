import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTestContext } from './helpers/test-context';

/**
 * The resolver from reply-language.ts only helps if the two places that build
 * deterministic reply text actually call it. Both used to read
 * AbTenantConfig.locale directly, which is how an English question on a fr-CA
 * tenant came back as English prose with `42 014,79 CA$` in the middle of it
 * and a French template line underneath.
 *
 * Source-level assertions on purpose: these are WIRING facts (which value is
 * handed to replyT / fmtCurrency), and the behavioural half — what
 * resolveReplyLocale decides — is covered by reply-language.test.ts. A test
 * that mocked the whole reply path would pass on a reverted call site.
 */
const SERVER = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
const BRAIN = readFileSync(join(__dirname, '..', 'agent-brain.ts'), 'utf8');

/**
 * Only the body of `_executeClassificationCore` — every skill reply the chat
 * path renders deterministically. Scoping the money/date guards to this slice
 * keeps them honest: the same file also builds LLM prompts and HTML reports,
 * where a locale-formatted number is the wrong thing.
 */
const CORE_SLICE = (() => {
  const start = SERVER.indexOf('async function _executeClassificationCore');
  expect(start).toBeGreaterThan(-1);
  const after = SERVER.slice(start + 1);
  const ends = [after.indexOf('\nexport '), after.indexOf('\nasync function ')]
    .filter((n) => n > -1);
  return after.slice(0, Math.min(...ends));
})();

/** Lines a reviewer deliberately marked as prompt/machine input. */
const UNMARKED_CORE_LINES = CORE_SLICE.split('\n').filter((l) => !l.includes('money-format-ok'));

describe('reply locale wiring', () => {
  it('server.ts derives the reply locale from the user text, not the tenant row alone', () => {
    expect(SERVER).toContain('resolveReplyLocale({');
    expect(SERVER).toMatch(/const t = replyT\(\{ locale: replyLocale \}\)/);
    expect(SERVER).not.toMatch(/replyT\(\{ locale: tenantLocale \}\)/);
    // money in replies formats with the reply locale
    expect(SERVER).toMatch(/const tenantMoney = \(cents: number, currency\?: string\) =>\s*fmtCurrency\(cents, currency \|\| tenantCurrency, replyLocale\)/);
  });

  it('server.ts feeds the thread to the resolver so a bare "yes" keeps the language', () => {
    expect(SERVER).toMatch(/previousUserTexts:\s*\(classification\.conversation/);
    // `conversation` is NEWEST FIRST (pairTurns contract) — reversing it here
    // would make the resolver read the OLDEST turn as the most recent one.
    expect(SERVER).not.toMatch(/previousUserTexts:[\s\S]{0,160}\.reverse\(\)/);
  });

  it('server.ts formats no reply-facing value with the tenant locale any more', () => {
    expect(SERVER).not.toMatch(/fmtCurrency\([^)]*tenantLocale\)/);
    expect(SERVER).not.toMatch(/toLocaleDateString\(tenantLocale/);
  });

  it('server.ts reports the locale it replied in', () => {
    // The Telegram adapter renders its own buttons/labels and needs to know.
    expect(SERVER).toMatch(/responseData: \{[\s\S]{0,400}replyLocale/);
  });

  it('agent-brain.ts uses the same resolver for its own templates and reports it', () => {
    expect(BRAIN).toContain('resolveReplyLocale({');
    expect(BRAIN).not.toMatch(/const t = replyT\(replyConfig\)/);
    expect(BRAIN).toContain('replyLocale');
  });

  it('agent-brain.ts re-resolves once the thread is loaded', () => {
    // The first resolve happens before Step 2, so it has no history: a bare
    // "oui" after a French turn would fall back to the tenant locale there.
    expect(BRAIN).toMatch(/previousUserTexts:/);
  });

  it('buildResponse carries replyLocale through to the caller', () => {
    expect(BRAIN).toMatch(/replyLocale\?: string/);
    expect(BRAIN).toMatch(/replyLocale: responseData\.replyLocale \?\? replyLocale/);
  });

  it('the brain never reverses the thread before handing it to the resolver', () => {
    // `conversation` is NEWEST FIRST (pairTurns' contract). Reversing it would
    // make the resolver treat the OLDEST turn as the most recent one, so a
    // thread that switched language would answer in the language it started in.
    for (const m of BRAIN.matchAll(/previousUserTexts:/g)) {
      const before = BRAIN.slice(Math.max(0, m.index! - 200), m.index!);
      expect(before, 'a .reverse() right before previousUserTexts').not.toMatch(/\.reverse\(\)/);
    }
  });

  it('every reply the brain returns carries a locale, including the helper-built ones', () => {
    // translateTaxCoreResult / buildTaxDraftStatusResponse /
    // handleTaxDraftRegenerate / tryApplyCorrection all return before the
    // resolved value is in scope, so the exported entry point backfills it.
    expect(BRAIN).toMatch(/replyLocale \?\?=|data\.replyLocale = /);
  });

  it('a correction is classified with the real thread and tenant, not empty literals', () => {
    // `_executeClassificationCore` derives the reply language from exactly
    // these two fields. With `conversation: []` / `tenantConfig: {}` it
    // resolved en-US, so a fr-CA user correcting an amount got English
    // templates and US money back.
    const start = BRAIN.indexOf('async function tryApplyCorrection');
    const body = BRAIN.slice(start, BRAIN.indexOf('\nfunction extractVendorFromTurns'));
    expect(body).not.toMatch(/conversation:\s*\[\]/);
    expect(body).not.toMatch(/tenantConfig:\s*\{\}/);
    expect(body).toMatch(/^\s*conversation,$/m);
    expect(body).toMatch(/^\s*tenantConfig,$/m);
  });

  it('no reply-facing money in the skill handlers formats without a locale', () => {
    // fmtCurrency(cents, currency) falls back to the currency's home market —
    // an AUD amount shown to a fr-CA user in en-AU digits. The third argument
    // is what makes the number match the rest of the sentence.
    const twoArg = UNMARKED_CORE_LINES.filter((l) => /fmtCurrency\(\s*[^(),]+,\s*[^(),]+\s*\)/.test(l));
    expect(twoArg, `two-argument fmtCurrency calls:\n${twoArg.join('\n')}`).toHaveLength(0);
  });

  it('no date in the skill handlers formats with the server process locale', () => {
    // A bare toLocaleDateString() uses the locale of whatever machine the
    // backend happens to run on — not the user's, and not even stable
    // between environments.
    const bare = UNMARKED_CORE_LINES.filter((l) => /\.toLocaleDateString\(\s*\)/.test(l));
    expect(bare, `bare toLocaleDateString() calls:\n${bare.join('\n')}`).toHaveLength(0);
  });
});

// ─── Behaviour: the field actually arrives on the response ──────────────────

const mockState: {
  tenantConfig: { locale?: string | null; jurisdiction?: string } | null;
} = { tenantConfig: null };

vi.mock('../db/client.js', () => ({
  db: {
    abConversation: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({})),
    },
    abConvThread: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args: any) => ({
        id: 'thread-1', lastActiveAt: new Date(), turns: [], activeEntities: [], parkedFills: [],
        ...args.data,
      })),
      update: vi.fn(async () => ({})),
    },
    abAgentSession: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args: any) => ({ ...args.data, id: 'sess-new', version: 1 })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    // The where clause matters: getActiveTaxQuestionnaireSession asks for an
    // in-progress one (there is none), getLatestTaxQuestionnaireSession asks
    // for the newest of any status (there is a completed one). A fixed-array
    // mock would answer both the same way and the test would prove nothing.
    abTaxQuestionnaireSession: {
      findFirst: vi.fn(async (args: any) =>
        args?.where?.status ? null : { id: 'tq-1', status: 'completed' }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    abTaxFastTrackDraft: { findUnique: vi.fn(async () => null) },
    abTenantConfig: { findFirst: vi.fn(async () => mockState.tenantConfig) },
    abUserMemory: { findMany: vi.fn(async () => []) },
    abSkillManifest: { findMany: vi.fn(async () => []) },
    abEvent: { create: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(async () => 1),
  },
}));

beforeEach(() => {
  mockState.tenantConfig = null;
  vi.clearAllMocks();
});

describe('every reply reports the locale it was written in', () => {
  /**
   * Drives the tax-draft-status intent, whose reply is built by a shared
   * helper that returns before the resolved locale is ever in scope — i.e.
   * precisely the shape of reply that used to arrive with no locale at all
   * and left the Telegram adapter falling back to the tenant row.
   *
   * The db mock deliberately has no abAdvisorPersona, so the persona step of
   * the same post-processing block throws (you will see it logged as
   * non-fatal). That is the point: the locale is attached before it, so a
   * persona failure can never cost a reply its language.
   */
  async function draftStatusLocale(text: string, tenantLocale: string | null): Promise<unknown> {
    mockState.tenantConfig = tenantLocale === null ? null : { locale: tenantLocale, jurisdiction: 'us' };
    const { req, ctx } = buildTestContext({ text, tenantId: `tenant-${tenantLocale ?? 'none'}` });
    const { handleAgentMessage } = await import('../agent-brain');
    const res = await handleAgentMessage(req as any, ctx as any);
    expect(res.data.skillUsed).toBe('tax-draft-status');
    return res.data.replyLocale;
  }

  it('falls back to en-US for an English turn on a tenant with no locale', async () => {
    expect(await draftStatusLocale('what is the status of my filing draft', null)).toBe('en-US');
  });

  it('answers a French turn in French', async () => {
    expect(await draftStatusLocale('où en est mon filing draft', 'fr-CA')).toBe('fr-CA');
  });

  it("follows the user's language over the tenant row", async () => {
    // English question, French tenant: English text, Canadian money.
    expect(await draftStatusLocale('what is the status of my filing draft', 'fr-CA')).toBe('en-CA');
  });
});
