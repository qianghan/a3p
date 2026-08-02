import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WIRING GUARD for the consultation reviewer.
 *
 * consultation-review.test.ts covers the reviewer itself. It cannot tell you
 * the advisory path still CALLS it — delete the call and all 20 of those tests
 * stay green while invented figures go straight back to users. That exact
 * shape already caught a regression tonight: 34 period-parse tests passed
 * while the pipeline had stopped using the helper.
 *
 * Structural rather than behavioural because brainAccountantFallback is a
 * module-private function reached only through the full handleAgentMessage
 * pipeline with a live LLM; a behavioural test here would be mostly mock.
 */
const SRC = join(__dirname, '..', 'agent-brain.ts');

/** Comments stripped — a guard must match code, not prose about code. */
const code = readFileSync(SRC, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** The body of brainAccountantFallback, where the LLM reply is produced. */
const fallbackBody = (() => {
  const start = code.indexOf('async function brainAccountantFallback');
  expect(start, 'brainAccountantFallback must exist').toBeGreaterThan(-1);
  const next = code.indexOf('\nfunction ', start + 1);
  const alt = code.indexOf('\nasync function ', start + 1);
  const end = Math.min(...[next, alt].filter((i) => i > -1));
  return code.slice(start, Number.isFinite(end) ? end : undefined);
})();

describe('the advisory path verifies before it answers', () => {
  it('reviews the draft', () => {
    expect(fallbackBody).toMatch(/reviewConsultation\s*\(/);
  });

  it('never returns a draft that has not passed review', () => {
    // The assertion that matters, and the one I first got wrong: merely
    // finding `verdict === 'pass'` somewhere in the body passes even when the
    // draft is returned unconditionally BEFORE the review runs — a reviewer
    // that executes and is ignored, the most expensive possible no-op.
    //
    // So check every `return draft` individually: each must sit immediately
    // after a pass verdict.
    const returns = [...fallbackBody.matchAll(/return\s+(?:draft|repaired)\s*;/g)];
    expect(returns.length, 'the draft must be returned somewhere').toBeGreaterThan(0);
    for (const m of returns) {
      const preceding = fallbackBody.slice(Math.max(0, m.index! - 120), m.index!);
      expect(
        preceding,
        `an unguarded "${m[0]}" — the draft reaches the user without passing review`,
      ).toMatch(/verdict\s*===\s*'pass'/);
    }
  });

  it('falls back to the safe answer rather than shipping an unverified one', () => {
    expect(fallbackBody).toMatch(/safeFallback\s*\(/);
  });

  it('attempts exactly one repair, not a loop', () => {
    // Each round is latency the user waits through, and a model that reached
    // for an invented figure twice will not find a grounded one on the third.
    const repairs = fallbackBody.match(/repairBrief\s*\(/g) ?? [];
    expect(repairs).toHaveLength(1);
  });

  it('passes the tenant jurisdiction into the grounding context', () => {
    // Defaulting to 'us' for a CA tenant would make the foreign-authority
    // check pass on exactly the answer it exists to block.
    expect(fallbackBody).toMatch(/jurisdiction:\s*tenantConfig\?\.jurisdiction/);
  });

  it('grounds on the ledger facts AND the context supplied to the model', () => {
    // Widened deliberately when the grounding pack landed: the tenant's own
    // ledger lines now lead, so an answer can cite real figures instead of
    // being blocked for having no support. The guard failing on that change
    // is the guard working — it is asserting the exact shape of what the
    // reviewer verifies against.
    expect(fallbackBody).toMatch(/facts:\s*\[[\s\S]{0,120}groundingFacts/);
    expect(fallbackBody).toMatch(/personalProfileContext/);
    expect(fallbackBody).toMatch(/pastFilingContext/);
  });

  it('feeds the model the SAME lines the reviewer checks against', () => {
    // If the prompt context and the verifier's fact list can diverge, the
    // model gets told things the reviewer will then block — the worst of both.
    expect(fallbackBody).toMatch(/groundingBlock/);
  });
});

describe('triage actually decides the route', () => {
  // consultation-triage.test.ts has 38 tests on the classifier. Not one of
  // them can tell you the pipeline CALLS it — delete the call and all 38 stay
  // green while every advisory question goes back to a data skill. That exact
  // shape has now bitten twice in this codebase (period-parse, and the
  // reviewer above), so it gets a guard rather than a comment.
  const brainSource = code;

  it('triages before classification, not after routing fails', () => {
    const triageAt = brainSource.indexOf('triageTurn(');
    const classifyAt = brainSource.indexOf('ctx.classifyOnly');
    expect(triageAt, 'triageTurn must be called').toBeGreaterThan(-1);
    expect(classifyAt).toBeGreaterThan(-1);
    expect(
      triageAt,
      'triage must run BEFORE classification — running it after is the bug it fixes',
    ).toBeLessThan(classifyAt);
  });

  it('a consultative turn returns without touching the skill layer', () => {
    const branch = brainSource.slice(brainSource.indexOf("triage.kind === 'consultative'"));
    const head = branch.slice(0, 1400);
    expect(head).toMatch(/brainAccountantFallback\(/);
    expect(head).toMatch(/return buildResponse\(/);
  });

  it('passes the tenant ledger facts into the advisory answer', () => {
    const branch = brainSource.slice(brainSource.indexOf("triage.kind === 'consultative'"));
    expect(branch.slice(0, 1400)).toMatch(/buildGroundingFacts\(tenantId\)/);
  });

  it('a grounding failure degrades the answer rather than the request', () => {
    // Throwing here would turn a chat message into a 500 for something that is
    // only context. The reviewer already blocks whatever cannot be supported.
    const branch = brainSource.slice(brainSource.indexOf('ctx.buildGroundingFacts'));
    expect(branch.slice(0, 400)).toMatch(/catch/);
  });
});
