import { describe, it, expect, vi } from 'vitest';
import { buildTestContext } from './helpers/test-context';

/**
 * A consultation turn must be asked to ANSWER, not to apologise.
 *
 * #439 added triage so advisory questions bypass the 84 skills and reach the
 * advisor. It routed them into `brainAccountantFallback` — whose prompt opens
 * "You could not confidently understand the user's intent" and then offers
 * three moves, two of which are "ask a clarifying question" and "suggest a
 * next step", followed by a list of the mechanical things AgentBook can do.
 *
 * That function is the DIDN'T-UNDERSTAND handler. Pointing the consultation
 * feature at it told the model, on every advisory turn, that it had failed to
 * understand a question it had understood perfectly well. Production, all five
 * in a row:
 *
 *   can I deduct a home office?          → "I can't give tax advice on whether
 *                                           you can deduct a home office. I can
 *                                           help you track your home office
 *                                           expenses if you tell me what they are."
 *   what is the instant asset write-off? → "I can't give tax advice on specific
 *                                           deductions like the instant asset write-off…"
 *   should I register for GST?           → same shape
 *   what are the CRA rules for meals?    → same shape
 *   explain how RRSP contributions work  → same shape
 *
 * The model was obeying its instructions. Explaining how a deduction works is
 * not giving personalised advice, and refusing to is the opposite of the
 * feature — a user asking a tax question got told to type in receipts.
 *
 * The credibility rails are NOT the problem and must survive: the reviewer
 * blocks invented amounts and another country's tax authority, and those are
 * what make the answers trustworthy. Only the framing changes.
 */

const findFirst = vi.fn(async () => null);
vi.mock('../db/client.js', () => ({
  db: {
    abConversation: { findFirst, findMany: vi.fn(async () => []), create: vi.fn(async () => ({})) },
    abAgentSession: { findFirst, create: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 0 })) },
    abTaxQuestionnaireSession: { findFirst, updateMany: vi.fn(async () => ({ count: 0 })) },
    abTenantConfig: { findFirst: vi.fn(async () => ({ jurisdiction: 'ca', locale: 'en-CA' })) },
    abUserMemory: { findMany: vi.fn(async () => []) },
    abSkillManifest: { findMany: vi.fn(async () => []) },
    abAdvisorPersona: { findFirst, create: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
    abConvThread: {
      findFirst,
      create: vi.fn(async (a: any) => ({ id: 'thread-1', turns: [], ...a.data })),
      update: vi.fn(async () => ({})),
    },
    abEvent: { create: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(async () => 1),
  },
}));

/** Run one turn and return the system prompt used for the advisory answer. */
async function promptFor(text: string, draft = 'A home office is deductible when the space is used regularly and exclusively for work.') {
  const harness = buildTestContext({
    text,
    tenantId: 'tenant-consult',
    llmFixtures: [{ response: draft }],
  });
  const { handleAgentMessage } = await import('../agent-brain');
  const res: any = await handleAgentMessage(harness.req as any, harness.ctx as any);
  const call = harness.llmCalls.history.find((h) => h.user.includes(text));
  return { system: call?.system ?? '', message: res?.data?.message ?? res?.message ?? '', res };
}

describe('the consultation prompt asks for an answer', () => {
  it('does not tell the model it failed to understand the question', async () => {
    const { system } = await promptFor('can I deduct a home office?');
    expect(system, 'the didn\'t-understand handler must not be the advisory prompt')
      .not.toMatch(/could not confidently understand/i);
  });

  it('instructs it to explain the rule rather than offer to track receipts', async () => {
    const { system } = await promptFor('can I deduct a home office?');
    // The three-move menu is what produced "I can help you track your
    // home office expenses" instead of an answer.
    expect(system).not.toMatch(/pick ONE move/i);
    expect(system, 'nothing tells the model to answer the question')
      .toMatch(/answer|explain/i);
  });

  it('keeps the credibility rails that make the answer worth reading', async () => {
    const { system } = await promptFor('can I deduct a home office?');
    expect(system, 'must still refuse to invent figures').toMatch(/never invent|do not invent|not.{0,20}invent/i);
    expect(system, 'must still be an AI, not a licensed accountant').toMatch(/licensed|professional/i);
  });
});

describe('what must not change', () => {
  it('a genuinely unclear turn still gets the clarifying handler', async () => {
    // The confusion handler is correct for its own case and must survive.
    // 'blah blah something vague' triages transactional, classification
    // returns null, and THAT is when "I didn't understand" is the right frame.
    const { system } = await promptFor('mmm the thing with the stuff from before');
    expect(system).toMatch(/could not confidently understand/i);
  });

  it('an invented amount is still not sent to the user', async () => {
    // The reviewer blocks ungrounded money. If fixing the prompt also
    // disabled the guard, this is where it shows.
    const { message } = await promptFor(
      'can I deduct a home office?',
      'You can deduct exactly $4,317.62 for your home office this year.',
    );
    expect(message, 'an unverifiable dollar figure reached the user').not.toContain('4,317.62');
  });
});
