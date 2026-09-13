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
