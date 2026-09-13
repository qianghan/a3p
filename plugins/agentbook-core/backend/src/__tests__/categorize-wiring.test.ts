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

describe('telegram adapter has no private categorize path', () => {
  const ROUTE = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts'), 'utf8');
  it('routes every categorize phrasing through the brain', () => {
    expect(ROUTE).not.toMatch(/\^\(auto\[\\- \]\?\)\?categori\[sz\]e/);
    expect(ROUTE).not.toContain('autoCategorizeForTenant(tenantId, { force: true })');
  });
});
