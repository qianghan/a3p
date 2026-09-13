/**
 * The what-if simulator, as a pure function.
 *
 * Until this module existed the projection lived inside an Express route body
 * that production never runs (prod serves the Next routes), so every "what if
 * I hire someone at $5K/mo?" in chat resolved to NOT_IMPLEMENTED and fell back
 * to a clarifying question. The arithmetic here is copied verbatim from that
 * route so the extraction cannot change a number; these tests pin it.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  projectScenario,
  formatScenarioReply,
  interpretScenario,
  type FinancialBase,
} from '../scenario-simulation';

const base: FinancialBase = {
  totalRevenueCents: 12_000_000,
  monthlyBurnCents: 400_000,
  cashBalanceCents: 2_000_000,
  jurisdiction: 'ca',
  region: 'BC',
  currency: 'CAD',
};
const flatTax = (net: number) => Math.round(Math.max(0, net) * 0.25);

describe('projectScenario', () => {
  it('hire at $5K/mo lowers monthly net by $5K and shortens runway', () => {
    const r = projectScenario(base, { type: 'hire', params: { monthlyCostCents: 500_000 } }, flatTax, 2026);
    expect(r.current.monthlyNetCents).toBe(600_000);
    expect(r.projected.monthlyNetCents).toBe(100_000);
    expect(r.impact.monthlyNetChangeCents).toBe(-500_000);
    expect(r.projected.runwayMonths).toBeLessThan(r.current.runwayMonths as number);
    expect(r.cashProjection12Months).toHaveLength(12);
    expect(r.impact.annualTaxChangeCents).toBeLessThan(0);
  });

  it('flags the month cash goes negative', () => {
    const r = projectScenario(
      { ...base, cashBalanceCents: 100_000 },
      { type: 'add_expense', params: { monthlyCostCents: 800_000 } },
      flatTax,
      2026,
    );
    expect(r.impact.cashDangerMonth).toBe(1);
  });

  it('leaves cash danger null when the projection never dips below zero', () => {
    const r = projectScenario(base, { type: 'add_revenue', params: { monthlyRevenueCents: 100_000 } }, flatTax, 2026);
    expect(r.impact.cashDangerMonth).toBeNull();
    expect(r.impact.monthlyNetChangeCents).toBe(100_000);
  });

  it('charges equipment as a one-time hit to cash plus monthly depreciation', () => {
    const r = projectScenario(
      base,
      { type: 'buy_equipment', params: { amountCents: 1_200_000, depreciationYears: 5 } },
      flatTax,
      2026,
    );
    // 1,200,000 / (5 * 12) = 20,000/month of depreciation.
    expect(r.projected.monthlyExpensesCents).toBe(420_000);
    expect(r.projected.oneTimeCostCents).toBe(1_200_000);
    expect(r.projected.cashCents).toBe(800_000);
  });

  it('drops a named client\'s billings spread over twelve months', () => {
    const r = projectScenario(
      { ...base, clients: [{ name: 'Acme Corp', billedCents: 2_400_000 }] },
      { type: 'lose_client', params: { clientName: 'acme' } },
      flatTax,
      2026,
    );
    expect(r.impact.monthlyNetChangeCents).toBe(-200_000);
    expect(r.scenario).toContain('Acme Corp');
  });

  it('marks a client it could not find, instead of silently reporting no impact', () => {
    // The old shape put "(not found — no revenue impact calculated)" into a
    // free-text `scenario` string the chat reply never printed, so the user
    // was told their net changes by $0.00 — a confident answer to a question
    // the code did not model. The signal has to be structural for a caller to
    // branch on it.
    const r = projectScenario(
      { ...base, clients: [{ name: 'Acme Corp', billedCents: 2_400_000 }] },
      { type: 'lose_client', params: { clientName: 'Globex' } },
      flatTax,
      2026,
    );
    expect(r.notModelled).toBe('client_not_found');
    expect(r.impact.monthlyNetChangeCents).toBe(0);
  });

  it('leaves notModelled unset when the client did match', () => {
    const r = projectScenario(
      { ...base, clients: [{ name: 'Acme Corp', billedCents: 2_400_000 }] },
      { type: 'lose_client', params: { clientName: 'acme' } },
      flatTax,
      2026,
    );
    expect(r.notModelled).toBeUndefined();
  });

  it('applies the revenue figure it describes when both fields are present', () => {
    // The apply read `monthlyCostCents || monthlyRevenueCents` while the
    // description read the reverse, so a scenario carrying both described
    // one number and projected another.
    const r = projectScenario(
      base,
      { type: 'add_revenue', params: { monthlyRevenueCents: 300_000, monthlyCostCents: 100_000 } },
      flatTax,
      2026,
    );
    expect(r.impact.monthlyNetChangeCents).toBe(300_000);
    expect(r.scenario).toContain('3,000');
  });

  it('passes the jurisdiction, region and year straight to the tax function', () => {
    const calcTax = vi.fn(() => 0);
    projectScenario(base, { type: 'hire', params: { monthlyCostCents: 500_000 } }, calcTax, 2026);
    expect(calcTax).toHaveBeenCalledWith(expect.any(Number), 'ca', 'BC', 2026);
  });
});

describe('interpretScenario', () => {
  it('parses the LLM JSON, fenced or not', async () => {
    const llm = vi.fn(async () => '```json\n{"type":"hire","params":{"monthlyCostCents":500000}}\n```');
    expect(await interpretScenario('what if I hire someone at $5K/mo?', llm)).toEqual({
      type: 'hire',
      params: { monthlyCostCents: 500000 },
    });
  });

  it('falls back to a custom scenario when the LLM is unavailable or unparseable', async () => {
    expect(await interpretScenario('what if?', async () => null)).toEqual({ type: 'custom', description: 'what if?' });
    expect(await interpretScenario('what if?', async () => 'sorry, I cannot')).toEqual({
      type: 'custom',
      description: 'what if?',
    });
  });
});

describe('formatScenarioReply', () => {
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  const t = (k: string, p?: Record<string, string | number>) => `${k} ${JSON.stringify(p ?? {})}`;

  it('always carries the numbers, even without a narrative', () => {
    const r = projectScenario(base, { type: 'hire', params: { monthlyCostCents: 500_000 } }, flatTax, 2026);
    const s = formatScenarioReply(r, null, money, t);
    expect(s).toContain('skill.scenario_monthly_net');
    expect(s).toContain('"change":"$-5000.00"');
    expect(s).toContain('skill.scenario_runway');
    expect(s).toContain('skill.scenario_tax');
  });

  it('leads with the narrative when there is one, and never swallows the numbers', () => {
    const r = projectScenario(base, { type: 'hire', params: { monthlyCostCents: 500_000 } }, flatTax, 2026);
    const s = formatScenarioReply(r, 'Hiring costs you $5,000 a month.', money, t);
    expect(s.startsWith('Hiring costs you $5,000 a month.')).toBe(true);
    expect(s).toContain('skill.scenario_monthly_net');
  });

  it('adds the cash warning only when the projection goes negative', () => {
    const safe = projectScenario(base, { type: 'hire', params: { monthlyCostCents: 500_000 } }, flatTax, 2026);
    expect(formatScenarioReply(safe, null, money, t)).not.toContain('skill.scenario_cash_negative');

    const danger = projectScenario(
      { ...base, cashBalanceCents: 100_000 },
      { type: 'add_expense', params: { monthlyCostCents: 800_000 } },
      flatTax,
      2026,
    );
    const s = formatScenarioReply(danger, null, money, t);
    expect(s).toContain('skill.scenario_cash_negative');
    expect(s).toContain('"month":1');
  });
});

/**
 * The inline handler in `server.ts` is not importable here — `server.ts` opens
 * a Prisma client and an Express app at module load. These read its source, in
 * the same style as the architecture suite, because the defects they pin live
 * in the WIRING, not in this module: a correct projection handed to a handler
 * that prints it anyway is still a confident wrong answer.
 */
describe('scenario-wiring: what the chat handler does with a scenario it could not model', () => {
  const SRC = readFileSync(join(__dirname, '../server.ts'), 'utf8');
  const HANDLER = (() => {
    const start = SRC.indexOf("if (selectedSkill.name === 'simulate-scenario')");
    expect(start, 'the simulate-scenario inline handler must exist').toBeGreaterThan(0);
    const end = SRC.indexOf("if (selectedSkill.name === 'daily-briefing')", start);
    expect(end, 'the daily-briefing handler follows it').toBeGreaterThan(start);
    return SRC.slice(start, end);
  })();

  it('declines a scenario the model could not turn into a typed one', () => {
    // `interpretScenario` returns `{ type: 'custom' }` when the LLM is down or
    // babbles. The default branch of the projection then changes nothing, and
    // the reply read "Monthly net: $6000.00 → $6000.00 ($0.00/mo)" — a
    // precise, sourced-looking, entirely fictional answer.
    expect(HANDLER).toMatch(/input\.type === 'custom'/);
    expect(HANDLER).toContain("t('skill.scenario_failed')");
    // The decline must come BEFORE the projection runs.
    expect(HANDLER.indexOf("input.type === 'custom'")).toBeLessThan(
      HANDLER.indexOf('projectScenario('),
    );
  });

  it('tells the user which client it could not find, rather than showing $0', () => {
    expect(HANDLER).toMatch(/notModelled === 'client_not_found'/);
    expect(HANDLER).toContain("t('skill.scenario_client_not_found'");
  });

  it('emits a chart on exactly one path — the one that actually projected', () => {
    // A 12-point cash line under "I could not model that" is the same lie in
    // picture form, so neither decline may carry one.
    expect(HANDLER.match(/chartData/g) ?? []).toHaveLength(1);
  });
});
