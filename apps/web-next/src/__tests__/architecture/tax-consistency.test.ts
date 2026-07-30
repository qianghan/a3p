/**
 * Architectural invariants for tax + surface consistency.
 *
 * These are structural assertions, deliberately not arithmetic. Every bug they
 * guard was real and shipped, and each was invisible to conventional tests
 * because the maths was correct in isolation — only the WIRING was wrong:
 *
 *  #381  the estimate passed `region` to the bracket provider AND called
 *        calculateStateTax, counting CA provincial tax twice.
 *  #382  cash-flow and chat computed federal-only tax, disagreeing with the
 *        estimate for anyone in a modelled state/province.
 *  #383  a second, less accurate inline engine lived in the Express plugin.
 *  #385  the Telegram reply and the T1 form each had their own divergent copy.
 *
 * A cross-surface "same number" test can't catch these cheaply — the surfaces
 * live in different runtimes. What actually keeps them honest is the rule that
 * there is ONE composer and ONE sub-national source, so this asserts exactly
 * that, on every PR.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// apps/web-next/src/__tests__/architecture -> repo root
const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const ESTIMATE = 'apps/web-next/src/app/api/v1/agentbook-tax/tax/estimate/route.ts';
const CASHFLOW = 'apps/web-next/src/app/api/v1/agentbook-tax/cashflow/scenario/route.ts';
const CHAT = 'plugins/agentbook-core/backend/src/server.ts';
const TELEGRAM = 'apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts';
const EXPRESS_TAX = 'plugins/agentbook-tax/backend/src/server.ts';
const COMPOSER = 'packages/agentbook-jurisdictions/src/total-tax.ts';
const SUBNATIONAL = 'packages/agentbook-jurisdictions/src/sub-national-tax.ts';

describe('one canonical tax engine', () => {
  it('the shared composer and single sub-national source exist', () => {
    expect(existsSync(join(ROOT, COMPOSER))).toBe(true);
    expect(existsSync(join(ROOT, SUBNATIONAL))).toBe(true);
  });

  it('the estimate does NOT hand `region` to the bracket provider (that double-counted CA provincial tax)', () => {
    const src = read(ESTIMATE);
    // The provider ADDS provincial tax when given a region; calculateStateTax is
    // the single source of sub-national tax. Passing both counts it twice.
    expect(src).not.toMatch(/\.calculateTax\([^)]*,\s*region/);
    // …and it must still apply sub-national tax from that one source.
    expect(src).toMatch(/calculateStateTax\(/);
  });

  it('every scenario surface uses the shared composer rather than its own maths', () => {
    for (const [name, path] of [['cash-flow', CASHFLOW], ['chat', CHAT], ['telegram', TELEGRAM]] as const) {
      expect(read(path), `${name} must use estimateTotalIncomeTax`).toMatch(/estimateTotalIncomeTax/);
    }
  });

  it('the legacy inline bracket engine stays deleted from the Express plugin', () => {
    const src = read(EXPRESS_TAX);
    expect(src).not.toMatch(/^const (US|CA)_FEDERAL_BRACKETS/m);
    expect(src).not.toMatch(/function getBrackets\s*\(/);
  });

  it('the T1 form uses the canonical 2025 CA federal brackets, not a stale table', () => {
    const src = read('plugins/agentbook-tax/backend/src/tax-forms.ts');
    expect(src).toMatch(/5737500/);   // $57,375 — canonical first bracket
    expect(src).not.toMatch(/5590700/); // $55,907 — the stale prior-year value
  });
});

describe('conversational surfaces share one brain', () => {
  it('MCP routes through the agent-message endpoint instead of its own logic', () => {
    const src = read('apps/web-next/src/lib/mcp/ask-agentbook-tool.ts');
    expect(src).toMatch(/agentbook-core\/agent\/message/);
    expect(src).toMatch(/channel:\s*'mcp'/);
  });

  it("only the machine 'api' channel opts out of the advisor persona, so new channels inherit it", () => {
    const src = read('plugins/agentbook-core/backend/src/advisor-persona.ts');
    // A denylist, not an allowlist: whatsapp/mcp/sms are "human" by default.
    expect(src).toMatch(/isHumanChannel/);
    expect(src).toMatch(/channel\s*!==\s*'api'/);
  });
});

describe('honesty guarantees', () => {
  it('the estimate discloses which tax-year tables it used', () => {
    const src = read(ESTIMATE);
    expect(src).toMatch(/taxTablesYear|taxYearNote/);
  });

  it('e-filing can only report "filed" via a certified partner', () => {
    const src = read('plugins/agentbook-tax/backend/src/tax-efiling.ts');
    expect(src).toMatch(/buildFilingOutcome/);
    expect(src).toMatch(/exported_not_filed/);
  });
});
