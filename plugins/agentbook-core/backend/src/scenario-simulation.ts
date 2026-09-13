/**
 * The financial what-if simulator, extracted from the Express route body.
 *
 * WHY THIS MODULE EXISTS
 * The projection used to live inline in `POST /api/v1/agentbook-core/simulate`
 * (server.ts). That route is only mounted by `tsx src/server.ts` in local
 * development — production serves the Next route handlers, which never carried
 * a `/simulate` port. So the `simulate-scenario` skill manifest pointed at an
 * endpoint that answers NOT_IMPLEMENTED in prod, and every "what if I hire
 * someone at $5K/month?" degraded into a clarifying question.
 *
 * The arithmetic below is a VERBATIM copy of that route body, parameterised on
 * the financial base and the tax function. Nothing was "tidied" in the move:
 * an extraction that changes a number is a bug disguised as a refactor. Both
 * callers — the Express route and the agent brain's INTERNAL handler — now run
 * this one copy.
 */

export interface ScenarioInput {
  type: 'add_expense' | 'add_revenue' | 'lose_client' | 'hire' | 'buy_equipment' | 'custom' | string;
  params?: Record<string, any>;
  description?: string;
}

/**
 * The slice of `buildFinancialContext()` the projection reads.
 *
 * `clients` carries `billedCents` (lifetime billings, which `lose_client`
 * divides by 12) because that is the field `buildFinancialContext` actually
 * produces. `monthlyRevenueCents` is accepted as an alternative for callers
 * that already hold a monthly figure.
 */
export interface FinancialBase {
  totalRevenueCents: number;
  monthlyBurnCents: number;
  cashBalanceCents: number;
  jurisdiction: string;
  region: string | null;
  currency: string;
  clients?: Array<{ name: string; billedCents?: number; monthlyRevenueCents?: number }>;
}

export interface CashProjectionPoint {
  month: number;
  cashCents: number;
  positiveFlow: boolean;
}

export interface ScenarioResult {
  scenario: string;
  scenarioInput: ScenarioInput;
  current: {
    monthlyRevenueCents: number;
    monthlyExpensesCents: number;
    monthlyNetCents: number;
    cashCents: number;
    annualTaxCents: number;
    runwayMonths: number;
  };
  projected: {
    monthlyRevenueCents: number;
    monthlyExpensesCents: number;
    monthlyNetCents: number;
    cashCents: number;
    annualTaxCents: number;
    runwayMonths: number;
    oneTimeCostCents: number;
  };
  impact: {
    monthlyNetChangeCents: number;
    annualTaxChangeCents: number;
    runwayChangemonths: number;
    cashDangerMonth: number | null;
  };
  cashProjection12Months: CashProjectionPoint[];
  /**
   * Set when the projection ran but did NOT model what was asked.
   *
   * `'client_not_found'`: a `lose_client` scenario naming somebody who is not
   * in the books. Every figure below is then the untouched baseline, which
   * renders as "Monthly net: $6,000.00 → $6,000.00 ($0.00/mo)" — a confident
   * answer to a question nothing computed. The old code recorded this only in
   * the free-text `scenario` string, which the chat reply never printed, so a
   * caller had no way to tell the two apart. Callers MUST check this before
   * showing any number.
   *
   * `'missing_parameters'`: the scenario has a TYPE but no figure — `hire`
   * with no salary, `add_expense`/`add_revenue` with no amount,
   * `buy_equipment` with no price, `lose_client` with no client. The
   * interpreter emits exactly this whenever the user did not state a number
   * ("what if I hired someone?"), and `params?.monthlyCostCents || 0` then
   * adds nothing: the same untouched baseline, the same $0.00 impact printed
   * as a projection. Callers must branch on the FIELD, not on one of its
   * values — a new reason a caller does not know about is a lie it prints by
   * default.
   */
  notModelled?: 'client_not_found' | 'missing_parameters';
}

/** The narrow LLM contract this module needs: prompt in, text or nothing out. */
export type CallGemini = (systemPrompt: string, userMessage: string, maxTokens?: number) => Promise<string | null>;

export type CalcScenarioTax = (
  netCents: number,
  jurisdiction: string,
  region: string | null,
  year: number,
) => number;

const INTERPRET_SYSTEM_PROMPT =
  'Convert a financial scenario description to JSON. Types: add_expense (monthly recurring), add_revenue (monthly), lose_client (clientName), hire (monthlyCostCents), buy_equipment (amountCents, depreciationYears). Respond with ONLY valid JSON: {"type": "...", "params": {...}}';

/**
 * Turn free text into a structured scenario.
 *
 * Never throws and never returns null: an unavailable or babbling LLM yields
 * `{ type: 'custom', description }`, which the projection handles by reporting
 * the unchanged baseline rather than refusing to answer.
 */
export async function interpretScenario(text: string, callGemini: CallGemini): Promise<ScenarioInput> {
  let scenarioObj: ScenarioInput | null = null;
  const llmResult = await callGemini(INTERPRET_SYSTEM_PROMPT, text, 200).catch(() => null);
  if (llmResult) {
    try {
      const cleaned = llmResult.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);
      scenarioObj = parsed && typeof parsed === 'object' ? (parsed as ScenarioInput) : null;
    } catch {
      scenarioObj = null;
    }
  }
  if (!scenarioObj) scenarioObj = { type: 'custom', description: text };
  return scenarioObj;
}

/**
 * A scenario figure the projection can actually apply, or `null`.
 *
 * `null` covers absent, non-numeric, non-finite AND zero. Zero is on that list
 * because `{"type":"hire","params":{"monthlyCostCents":0}}` is what the model
 * emits for a sentence with no number in it — and a $0 hire projects the
 * untouched baseline exactly like a missing one does.
 */
function amountCents(raw: unknown): number | null {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n === 0) return null;
  return n;
}

/**
 * Project a scenario twelve months forward. Pure: no database, no clock, no
 * LLM — the caller supplies the base state, the tax function and the year.
 */
export function projectScenario(
  base: FinancialBase,
  scenarioObj: ScenarioInput,
  calcTax: CalcScenarioTax,
  year: number = new Date().getFullYear(),
): ScenarioResult {
  // Base state
  const monthlyRevenue = base.totalRevenueCents / 12;
  const monthlyExpenses = base.monthlyBurnCents;
  const currentCash = base.cashBalanceCents;
  const currentNetMonthly = monthlyRevenue - monthlyExpenses;

  // Apply scenario
  let newMonthlyExpenses = monthlyExpenses;
  let newMonthlyRevenue = monthlyRevenue;
  let oneTimeCost = 0;
  let scenarioDescription = '';
  let notModelled: ScenarioResult['notModelled'];

  switch (scenarioObj.type) {
    case 'add_expense':
      if (amountCents(scenarioObj.params?.monthlyCostCents) === null) {
        scenarioDescription = 'Add recurring expense (amount not given — no impact calculated)';
        notModelled = 'missing_parameters';
        break;
      }
      newMonthlyExpenses += (scenarioObj.params?.monthlyCostCents || 0);
      scenarioDescription = `Add recurring expense of $${((scenarioObj.params?.monthlyCostCents || 0) / 100).toLocaleString()}/month`;
      break;
    case 'add_revenue':
      // `monthlyRevenueCents` first, matching the description below: the two
      // read the fields in opposite orders, so a scenario carrying both
      // described one figure and projected another.
      if (
        amountCents(scenarioObj.params?.monthlyRevenueCents) === null
        && amountCents(scenarioObj.params?.monthlyCostCents) === null
      ) {
        scenarioDescription = 'Add revenue (amount not given — no impact calculated)';
        notModelled = 'missing_parameters';
        break;
      }
      newMonthlyRevenue += (scenarioObj.params?.monthlyRevenueCents || scenarioObj.params?.monthlyCostCents || 0);
      scenarioDescription = `Add revenue of $${((scenarioObj.params?.monthlyRevenueCents || scenarioObj.params?.monthlyCostCents || 0) / 100).toLocaleString()}/month`;
      break;
    case 'lose_client': {
      const named = String(scenarioObj.params?.clientName ?? '').trim();
      if (!named) {
        // No name at all is a different failure from a name nobody matches:
        // there is nothing to quote back, so the caller must not reach for
        // `I couldn't find a client named ""`.
        scenarioDescription = 'Lose a client (none named — no revenue impact calculated)';
        notModelled = 'missing_parameters';
        break;
      }
      const clientName = named;
      const client = (base.clients || []).find((c: any) => c.name.toLowerCase().includes(String(clientName).toLowerCase()));
      if (client) {
        const monthlyFromClient = Math.round((client.billedCents ?? 0) / 12);
        newMonthlyRevenue -= monthlyFromClient;
        scenarioDescription = `Lose client ${client.name} ($${(monthlyFromClient / 100).toLocaleString()}/month)`;
      } else {
        scenarioDescription = `Lose client ${clientName} (not found — no revenue impact calculated)`;
        notModelled = 'client_not_found';
      }
      break;
    }
    case 'hire':
      if (amountCents(scenarioObj.params?.monthlyCostCents) === null) {
        scenarioDescription = 'Hire (salary not given — no impact calculated)';
        notModelled = 'missing_parameters';
        break;
      }
      newMonthlyExpenses += (scenarioObj.params?.monthlyCostCents || 0);
      scenarioDescription = `Hire at $${((scenarioObj.params?.monthlyCostCents || 0) / 100).toLocaleString()}/month`;
      break;
    case 'buy_equipment': {
      if (amountCents(scenarioObj.params?.amountCents) === null) {
        scenarioDescription = 'Buy equipment (price not given — no impact calculated)';
        notModelled = 'missing_parameters';
        break;
      }
      oneTimeCost = scenarioObj.params?.amountCents || 0;
      const depYears = scenarioObj.params?.depreciationYears || 5;
      const monthlyDep = Math.round(oneTimeCost / (depYears * 12));
      newMonthlyExpenses += monthlyDep;
      scenarioDescription = `Buy equipment $${(oneTimeCost / 100).toLocaleString()} (depreciated over ${depYears} years: $${(monthlyDep / 100).toLocaleString()}/month)`;
      break;
    }
    default:
      scenarioDescription = scenarioObj.description || 'Custom scenario';
  }

  const newNetMonthly = newMonthlyRevenue - newMonthlyExpenses;
  const newCash = currentCash - oneTimeCost;
  const newRunway = newMonthlyExpenses > 0 ? newCash / newMonthlyExpenses : Infinity;

  // 12-month cash projection
  const projection: CashProjectionPoint[] = [];
  let runningCash = newCash;
  for (let m = 1; m <= 12; m++) {
    runningCash += newNetMonthly;
    projection.push({ month: m, cashCents: runningCash, positiveFlow: newNetMonthly > 0 });
  }

  // Tax impact estimate — real jurisdiction-aware calculation (PARITY-2),
  // matching the web What-If simulator instead of a flat 25% guess.
  const currentAnnualNet = currentNetMonthly * 12;
  const newAnnualNet = newNetMonthly * 12;
  const currentTax = calcTax(Math.round(currentAnnualNet), base.jurisdiction, base.region, year);
  const newTax = calcTax(Math.round(newAnnualNet), base.jurisdiction, base.region, year);

  // Cash danger month (when cash goes negative)
  const dangerMonth = projection.find((p) => p.cashCents < 0)?.month || null;

  return {
    scenario: scenarioDescription,
    scenarioInput: scenarioObj,
    current: {
      monthlyRevenueCents: Math.round(monthlyRevenue),
      monthlyExpensesCents: monthlyExpenses,
      monthlyNetCents: Math.round(currentNetMonthly),
      cashCents: currentCash,
      annualTaxCents: currentTax,
      runwayMonths: monthlyExpenses > 0 ? parseFloat((currentCash / monthlyExpenses).toFixed(1)) : Infinity,
    },
    projected: {
      monthlyRevenueCents: Math.round(newMonthlyRevenue),
      monthlyExpensesCents: newMonthlyExpenses,
      monthlyNetCents: Math.round(newNetMonthly),
      cashCents: newCash,
      annualTaxCents: newTax,
      runwayMonths: parseFloat(newRunway.toFixed(1)),
      oneTimeCostCents: oneTimeCost,
    },
    impact: {
      monthlyNetChangeCents: Math.round(newNetMonthly - currentNetMonthly),
      annualTaxChangeCents: newTax - currentTax,
      runwayChangemonths: parseFloat((newRunway - (monthlyExpenses > 0 ? currentCash / monthlyExpenses : 0)).toFixed(1)),
      cashDangerMonth: dangerMonth,
    },
    cashProjection12Months: projection,
    ...(notModelled ? { notModelled } : {}),
  };
}

/**
 * The LLM's assessment of a projection, with the deterministic fallback the
 * Express route already used when no model is configured.
 */
export async function scenarioNarrative(
  result: ScenarioResult,
  tenantId: string | undefined,
  callGemini: CallGemini,
  resolveAdvisorIdentity: (tenantId: string | undefined) => Promise<string>,
): Promise<string> {
  const { current, projected, impact } = result;
  const currentNetMonthly = current.monthlyNetCents;
  const newNetMonthly = projected.monthlyNetCents;
  const identity = await resolveAdvisorIdentity(tenantId).catch(() => '');
  const llmNarrative = await callGemini(
    `${identity} Given a what-if scenario simulation result, provide a 2-3 sentence assessment in the first person. Be direct about risks and opportunities. Use dollar amounts.`,
    `Scenario: ${result.scenario}\nCurrent monthly net: $${(currentNetMonthly / 100).toFixed(2)}\nProjected monthly net: $${(newNetMonthly / 100).toFixed(2)}\nCash now: $${(current.cashCents / 100).toFixed(2)}\nProjected cash: $${(projected.cashCents / 100).toFixed(2)}\nRunway change: ${impact.runwayChangemonths.toFixed(1)} months\nTax change: $${(impact.annualTaxChangeCents / 100).toFixed(2)}/year`,
    200,
  ).catch(() => null);
  if (llmNarrative) return llmNarrative;

  let narrative = newNetMonthly > currentNetMonthly
    ? `This scenario improves your monthly net by $${(Math.abs(newNetMonthly - currentNetMonthly) / 100).toLocaleString()}.`
    : `This scenario reduces your monthly net by $${(Math.abs(newNetMonthly - currentNetMonthly) / 100).toLocaleString()}.`;
  if (impact.cashDangerMonth) narrative += ` Warning: cash goes negative in month ${impact.cashDangerMonth}.`;
  return narrative;
}

/**
 * The chat reply.
 *
 * The numbers are emitted unconditionally — the narrative is the LLM's opinion
 * and may be absent, but a simulation that answers with prose alone is exactly
 * the failure this task was opened to fix.
 */
export function formatScenarioReply(
  r: ScenarioResult,
  narrative: string | null,
  money: (cents: number) => string,
  t: (k: string, p?: Record<string, string | number>) => string,
): string {
  const lines: string[] = [];
  if (narrative && narrative.trim()) lines.push(narrative.trim(), '');
  lines.push(t('skill.scenario_monthly_net', {
    before: money(r.current.monthlyNetCents),
    after: money(r.projected.monthlyNetCents),
    change: money(r.impact.monthlyNetChangeCents),
  }));
  lines.push(t('skill.scenario_runway', {
    before: Number.isFinite(r.current.runwayMonths) ? r.current.runwayMonths : '∞',
    after: Number.isFinite(r.projected.runwayMonths) ? r.projected.runwayMonths : '∞',
  }));
  lines.push(t('skill.scenario_tax', { change: money(r.impact.annualTaxChangeCents) }));
  if (r.impact.cashDangerMonth) {
    lines.push(t('skill.scenario_cash_negative', { month: r.impact.cashDangerMonth }));
  }
  return lines.join('\n');
}
