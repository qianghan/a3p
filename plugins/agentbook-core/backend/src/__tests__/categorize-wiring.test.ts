/**
 * The categorize handler must (a) use the shared outcome module, (b) include
 * the 6999 suspense bucket, (c) apply through the ledger-owning HTTP route,
 * and (d) never loop Gemini per expense. A unit test of the module cannot see
 * any of that — assert the wiring in the source.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
const start = SRC.indexOf("if (selectedSkill.name === 'categorize-expenses') {");
const end = SRC.indexOf('// INTERNAL handler: record-invoice-payment', start);
const BLOCK = SRC.slice(start, end);

describe('categorize-expenses handler wiring', () => {
  it('exists and is bounded', () => { expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start); });
  it('builds the reply from the shared outcome module', () => {
    expect(BLOCK).toContain('formatCategorizeReply(');
    expect(BLOCK).toContain('decide(');
    expect(BLOCK).toContain('parseBatchDecisions(');
  });
  it('treats the 6999 suspense account as uncategorized — here AND in the query-expenses filter', () => {
    expect(BLOCK).toMatch(/OR:\s*\[\s*\{\s*categoryId:\s*null\s*\}/);
    expect(BLOCK).toContain("code: '6999'");
    const qe = SRC.slice(SRC.indexOf('const wantsUncategorizedOnly'), SRC.indexOf('const wantsUncategorizedOnly') + 1200);
    expect(qe).toMatch(/OR:\s*\[\s*\{\s*categoryId:\s*null\s*\}/);
  });
  it('books confirmed rows through the ledger-owning route; drafts get only a categoryId (the confirm route posts them later)', () => {
    expect(BLOCK).toContain('/categorize`');
    expect(BLOCK).toContain("status === 'confirmed'");
    // exactly one bare update, and it is the draft branch
    expect((BLOCK.match(/db\.abExpense\.update\(/g) || []).length).toBe(1);
  });
  it('does not talk to Gemini directly or once per expense', () => {
    expect(BLOCK).not.toContain('generativelanguage.googleapis.com');
    expect((BLOCK.match(/callGemini\(/g) || []).length).toBe(1);
    expect(BLOCK).toContain('BATCH_SIZE');
  });
  it('returns the structured outcome for the evaluator', () => {
    expect(BLOCK).toMatch(/skillResponse:\s*\{\s*success:\s*true,\s*data:\s*outcome/);
  });
});

describe('categorize-expenses is not confidence-escalated', () => {
  const BRAIN = readFileSync(join(__dirname, '..', 'agent-brain.ts'), 'utf8');
  const set = BRAIN.slice(BRAIN.indexOf('const ESCALATION_EXEMPT_SKILLS'), BRAIN.indexOf(']);', BRAIN.indexOf('const ESCALATION_EXEMPT_SKILLS')));
  it('is in ESCALATION_EXEMPT_SKILLS', () => { expect(set).toContain("'categorize-expenses'"); });
});

describe('categorize-expenses is not re-planned after it has already run', () => {
  /**
   * The escalation exemption in agent-brain only covers Step 3b. Step 4 calls
   * assessComplexity on the ALREADY-EXECUTED result, and 'complex' there
   * discards it and shows a plan preview — a "Proceed?" for writes that have
   * landed, whose step then fails because executeStep refuses INTERNAL skills.
   */
  const PLANNER = readFileSync(join(__dirname, '..', 'agent-planner.ts'), 'utf8');
  const set = (name: string) => {
    const i = PLANNER.indexOf(`const ${name} = new Set(`);
    // Returning '' on a rename would make the `not.toContain` below vacuous:
    // a renamed DESTRUCTIVE_SKILLS would "pass" by not existing.
    expect(i, `${name} not found`).toBeGreaterThan(-1);
    return PLANNER.slice(i, PLANNER.indexOf(']);', i));
  };
  it('is in DIRECT_SKILLS', () => { expect(set('DIRECT_SKILLS')).toContain("'categorize-expenses'"); });
  it('is NOT in DESTRUCTIVE_SKILLS', () => { expect(set('DESTRUCTIVE_SKILLS')).not.toContain("'categorize-expenses'"); });
});

describe('the handler names and logs a failed write, and never trusts the page size', () => {
  it("reports a refused write as 'write_failed', not as an LLM error", () => {
    expect(BLOCK).toContain("'write_failed'");
    // Not `toContain('console.error(')` — the handler's outer catch already
    // had one, so that assertion passed on the unfixed code. Each of the
    // three write paths (route error, non-ok status, draft update) must log.
    expect((BLOCK.match(/console\.error\('\[categorize-expenses\] write failed:/g) || []).length).toBe(3);
  });
  it('takes the total from a COUNT, not from the capped page', () => {
    // `take: 50` + `total = rows.length` let the reply claim completeness
    // while row 51 was still uncategorized.
    expect(BLOCK).toContain('db.abExpense.count(');
    expect(BLOCK).not.toMatch(/total:\s*cands\.length/);
  });
  it('sends its own confidence in the categorize-route BODY', () => {
    // The route defaults to 1.0 — user certainty. A model guess must not be
    // recorded as that. Asserted on the request body specifically: the draft
    // branch below already wrote `confidence: a.confidence`, so a file-wide
    // match would have passed while the HTTP call still sent none.
    const body = BLOCK.slice(BLOCK.indexOf("source: 'auto_categorize'"));
    expect(body.slice(0, body.indexOf('}'))).toMatch(/confidence:\s*a\.confidence/);
  });
});

describe('telegram adapter has no private categorize path', () => {
  const ROUTE = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts'), 'utf8');
  it('routes every categorize phrasing through the brain', () => {
    expect(ROUTE).not.toMatch(/\^\(auto\[\\- \]\?\)\?categori\[sz\]e/);
    expect(ROUTE).not.toContain('autoCategorizeForTenant(tenantId, { force: true })');
  });
});
