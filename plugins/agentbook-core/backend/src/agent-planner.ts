import { db } from './db/client.js';
import { PlanStep } from './agent-evaluator.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface UndoAction {
  stepId: string;
  description: string;
  reverseEndpoint: string;
  reverseMethod: string;
  reverseParams: any;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MULTI_INTENT_PATTERNS = [
  /and then/i,
  /then /i,
  /also /i,
  /after that/i,
  /first.+?then/i,
];

/**
 * Read-only / reporting skills that should never trigger the multi-step planner.
 * "Show March AND Jan spending" is a single advisor call, not a two-step plan.
 * Routing these through the planner causes HTTP self-calls with no auth,
 * leading to TypeError: fetch failed for every step.
 */
const REPORTING_SKILLS = new Set([
  'query-expenses',
  'query-finance',
  'expense-breakdown',
  'vendor-insights',
  'proactive-alerts',
  'general-question',
  'simulate-scenario',
  'review-queue',
  'manage-recurring',
]);

const CONDITIONAL_PATTERN = /if.+then/i;

const DESTRUCTIVE_WORDS = [
  /\bdelete\b/i,
  /\bremove\b/i,
  /\bedit\b/i,
  /\bupdate\b/i,
  /\bchange\b/i,
  /\bmodify\b/i,
  /\bsplit\b/i,
  /\brecord\b/i,
  /\bcreate\b/i,
  /\badd\b/i,
];

const DESTRUCTIVE_SKILLS = new Set([
  'edit-expense',
  'split-expense',
  'categorize-expenses',
  'record-expense',
  'create-invoice',
]);

// ─── assessComplexity ────────────────────────────────────────────────────────

export function assessComplexity(
  text: string,
  selectedSkill: { name: string; confirmBefore?: boolean } | null,
  confidence: number,
): 'simple' | 'complex' {
  // Read-only reporting skills never need multi-step planning — always execute directly.
  // Multi-intent phrases ("March AND also Jan") are valid single-call queries here.
  if (selectedSkill && REPORTING_SKILLS.has(selectedSkill.name)) return 'simple';

  // Multi-intent keywords (only relevant for write/action skills)
  if (MULTI_INTENT_PATTERNS.some((p) => p.test(text))) return 'complex';

  // Skill requires confirmation before execution
  if (selectedSkill?.confirmBefore) return 'complex';

  // Low confidence
  if (confidence < 0.6) return 'complex';

  // Destructive word + destructive skill
  if (
    selectedSkill &&
    DESTRUCTIVE_SKILLS.has(selectedSkill.name) &&
    DESTRUCTIVE_WORDS.some((p) => p.test(text))
  ) {
    return 'complex';
  }

  // Conditional phrasing
  if (CONDITIONAL_PATTERN.test(text)) return 'complex';

  return 'simple';
}

// ─── generatePlan ────────────────────────────────────────────────────────────

export async function generatePlan(
  text: string,
  skills: Array<{ name: string; description?: string; endpoint?: string; method?: string }>,
  tenantConfig: Record<string, any>,
  recentConvo: string,
  relevantMemories: string,
  callGemini: (sys: string, user: string, max?: number) => Promise<string | null>,
): Promise<PlanStep[]> {
  const skillList = skills
    .map(
      (s) =>
        `- ${s.name}: ${s.description ?? '(no description)'}${s.endpoint ? ` [${s.method ?? 'GET'} ${s.endpoint}]` : ''}`,
    )
    .join('\n');

  const system = `You are an AI accounting assistant planner for AgentBook.
Your task is to decompose a user request into an ordered list of discrete steps.

Available skills:
${skillList}

Tenant configuration:
${JSON.stringify(tenantConfig, null, 2)}

Recent conversation context:
${recentConvo || '(none)'}

Relevant memories:
${relevantMemories || '(none)'}

Rules:
1. Return ONLY valid JSON — an array of step objects, nothing else.
2. Each step must have: action (string), description (string), params (object), dependsOn (array of step IDs), canUndo (boolean).
3. The last step MUST always be: { "action": "evaluate-results", "description": "Evaluate results", "params": {}, "dependsOn": [...all previous step ids...], "canUndo": false }
4. Use only actions from the available skills list, plus "evaluate-results".
5. dependsOn should reference actual step IDs from the same plan.
6. To use a previous step's result in a later step's params, use EXACTLY this
   placeholder syntax: {{steps[N].output.<path>}}, where N is the 0-based
   index of that step in this array. Example: if step 0 looks up an expense
   and returns { "expenses": [{ "id": "abc123" }] }, a later step referencing
   it must write "expenseId": "{{steps[0].output.expenses[0].id}}" — do not
   invent any other placeholder format (no step names, no "results", no
   different bracket style).`;

  const user = `User request: "${text}"

Return a JSON array of steps to fulfil this request. Remember to end with an evaluate-results step.`;

  let raw: string | null = null;
  try {
    raw = await callGemini(system, user, 1024);
  } catch {
    return [];
  }

  if (!raw) return [];

  // Extract JSON array from the response (LLM may wrap in markdown)
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  let parsed: any[];
  try {
    parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
  } catch {
    return [];
  }

  // Assign sequential IDs, ignoring whatever the LLM provided
  const idMap = new Map<string, string>();
  const steps: PlanStep[] = parsed.map((raw: any, i: number) => {
    const newId = `step-${i + 1}`;
    const oldId: string = raw.id ?? String(i + 1);
    idMap.set(oldId, newId);
    return {
      id: newId,
      action: String(raw.action ?? ''),
      description: String(raw.description ?? ''),
      params: raw.params && typeof raw.params === 'object' ? raw.params : {},
      dependsOn: [],
      canUndo: Boolean(raw.canUndo),
      status: 'pending' as const,
    };
  });

  // Fix dependsOn references to use the newly assigned IDs
  parsed.forEach((raw: any, i: number) => {
    const deps: string[] = Array.isArray(raw.dependsOn) ? raw.dependsOn : [];
    steps[i].dependsOn = deps
      .map((d: string) => idMap.get(d) ?? d)
      .filter((d: string) => steps.some((s) => s.id === d));
  });

  return steps;
}

// ─── formatPlan ──────────────────────────────────────────────────────────────

export function formatPlan(steps: PlanStep[]): string {
  const lines: string[] = ["Here's my plan:\n"];
  steps.forEach((step, i) => {
    const irreversible = !step.canUndo && step.action !== 'evaluate-results' ? ' (irreversible)' : '';
    lines.push(`${i + 1}. ${step.description}${irreversible}`);
  });
  lines.push('\nProceed? (yes/no)');
  return lines.join('\n');
}

// ─── createSession ───────────────────────────────────────────────────────────

export async function createSession(
  tenantId: string,
  trigger: string,
  plan: PlanStep[],
): Promise<any> {
  // Expire any existing active sessions for this tenant
  await db.abAgentSession.updateMany({
    where: { tenantId, status: 'active' },
    data: { status: 'expired' },
  });

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  return db.abAgentSession.create({
    data: {
      tenantId,
      trigger,
      plan: plan as any,
      status: 'active',
      currentStep: 0,
      stepResults: [],
      undoStack: [],
      expiresAt,
    },
  });
}

// ─── getActiveSession ─────────────────────────────────────────────────────────

export async function getActiveSession(tenantId: string): Promise<any | null> {
  return db.abAgentSession.findFirst({
    where: {
      tenantId,
      status: 'active',
      expiresAt: { gt: new Date() },
    },
  });
}

// ─── updateSession ────────────────────────────────────────────────────────────

export async function updateSession(
  id: string,
  version: number,
  data: {
    plan?: PlanStep[];
    stepResults?: any[];
    currentStep?: number;
    undoStack?: any[];
    pendingConfirmation?: any;
    status?: string;
    evaluation?: any;
  },
): Promise<boolean> {
  const {
    plan,
    stepResults,
    currentStep,
    undoStack,
    pendingConfirmation,
    status,
    evaluation,
  } = data;

  const result = await db.$executeRaw`
    UPDATE "plugin_agentbook_core"."AbAgentSession"
    SET "version" = "version" + 1, "updatedAt" = NOW(),
        "plan" = COALESCE(${plan ? JSON.stringify(plan) : null}::jsonb, "plan"),
        "stepResults" = COALESCE(${stepResults ? JSON.stringify(stepResults) : null}::jsonb, "stepResults"),
        "currentStep" = COALESCE(${currentStep ?? null}, "currentStep"),
        "undoStack" = COALESCE(${undoStack ? JSON.stringify(undoStack) : null}::jsonb, "undoStack"),
        "pendingConfirmation" = ${pendingConfirmation !== undefined ? (pendingConfirmation ? JSON.stringify(pendingConfirmation) : null) : null}::jsonb,
        "status" = COALESCE(${status ?? null}, "status"),
        "evaluation" = COALESCE(${evaluation ? JSON.stringify(evaluation) : null}::jsonb, "evaluation")
    WHERE "id" = ${id} AND "version" = ${version}`;

  return result > 0;
}

// ─── Step output templating ─────────────────────────────────────────────────

/**
 * Walk a dotted/bracket path like "expenses[0].id" against a plan step's
 * `result` object. Returns undefined on any missing segment.
 */
function walkPath(obj: any, path: string): any {
  const tokens = path.match(/[^.[\]]+/g) || [];
  let cur = obj;
  for (const t of tokens) {
    if (cur == null) return undefined;
    cur = /^\d+$/.test(t) ? cur[parseInt(t, 10)] : cur[t];
  }
  return cur;
}

/**
 * Resolve `{{steps[N].output.<path>}}` / `{{steps[N].result.<path>}}` template
 * strings in a plan step's params against prior steps' results. The planner's
 * LLM-generated plans use this syntax to pass data between steps (e.g. "find
 * the last expense" -> "edit that expense"), but nothing was substituting it
 * before execution, so downstream steps received the literal template string.
 * Returns the resolved params plus any template that couldn't be resolved
 * (prior step missing/failed) so the caller can fail fast instead of sending
 * garbage IDs to a skill endpoint.
 */
export function resolveStepParams(
  params: Record<string, any>,
  plan: PlanStep[],
): { params: Record<string, any>; unresolved: string[] } {
  const unresolved: string[] = [];

  function resolve(value: any): any {
    if (typeof value === 'string') {
      // Preferred, prompt-instructed form: {{steps[N].output.<path>}}.
      const byIndex = value.match(/^\{\{\s*steps\[(\d+)\]\.(?:output|result|results)\.(.+?)\s*\}\}$/);
      // Observed LLM variant: {{steps.<action-name>.output.<path>}} — the
      // model sometimes names the step by its action instead of its index
      // despite the prompt instructing otherwise. Fall back to a name lookup.
      const byName = value.match(/^\{\{\s*steps\.([\w-]+)\.(?:output|result|results)\.(.+?)\s*\}\}$/);
      if (!byIndex && !byName) return value;

      let source: any;
      if (byIndex) {
        source = plan[parseInt(byIndex[1], 10)]?.result;
      } else {
        const actionName = byName![1];
        source = plan.find((s) => s.action === actionName)?.result;
      }
      const path = (byIndex ?? byName)![2];
      const resolved = walkPath(source, path);
      if (resolved === undefined) unresolved.push(value);
      return resolved;
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === 'object') {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) out[k] = resolve(v);
      return out;
    }
    return value;
  }

  const resolvedParams: Record<string, any> = {};
  for (const [k, v] of Object.entries(params || {})) resolvedParams[k] = resolve(v);
  return { params: resolvedParams, unresolved };
}

// ─── executeStep ─────────────────────────────────────────────────────────────

export async function executeStep(
  step: PlanStep,
  tenantId: string,
  skills: Array<{
    name: string;
    endpoint?: string;
    method?: string;
  }>,
  baseUrls: Record<string, string>,
): Promise<any> {
  // Internal evaluate-results step — handled by caller
  if (step.action === 'evaluate-results') {
    return { success: true, data: { evaluated: true } };
  }

  const skill = skills.find((s) => s.name === step.action);

  if (!skill) {
    return { success: false, error: `Unknown skill: ${step.action}` };
  }

  let endpoint = skill.endpoint as any;

  // query-expenses is wired to the NL advisor endpoint (`question` param), but
  // planner-generated "find the last expense" steps pass limit/count instead —
  // there's no free-text question to ask. Route those to the structured list
  // endpoint so a following step can read output.expenses[0].id.
  if (step.action === 'query-expenses' && !step.params?.question) {
    const limit = step.params?.limit ?? step.params?.count ?? 1;
    endpoint = { method: 'GET', url: `/api/v1/agentbook-expense/expenses?limit=${encodeURIComponent(String(limit))}` };
    step = { ...step, params: {} };
  }

  if (!endpoint || !endpoint.url) {
    return { success: false, error: `Skill "${step.action}" has no endpoint` };
  }

  if (endpoint.method === 'INTERNAL') {
    return { success: false, error: `Skill "${step.action}" is internal and cannot be executed via HTTP` };
  }

  // Resolve base URL: find the base URL key whose prefix matches the skill endpoint URL
  let baseUrl = '';
  for (const [prefix, url] of Object.entries(baseUrls)) {
    if (endpoint.url.startsWith(prefix)) {
      baseUrl = url;
      break;
    }
  }

  if (!baseUrl) {
    // Fallback: try to find by partial prefix match
    const entries = Object.entries(baseUrls);
    for (const [prefix, url] of entries) {
      if (endpoint.url.includes(prefix.replace(/^\/api\/v1\//, ''))) {
        baseUrl = url;
        break;
      }
    }
  }

  // edit-expense/split-expense steps generated as a single-step plan (no
  // separate "find the last expense" step ahead of them — the LLM doesn't
  // always produce the 3-step shape) carry the literal string "last"/"that"
  // as expenseId, which the target endpoint can't resolve to a real row.
  // Mirrors the identical "resolve last expense" pre-processing server.ts's
  // direct-execution path already has for these two skills — that logic
  // only covers the non-planner path, so plans reaching here via the
  // planner never got it.
  if ((step.action === 'edit-expense' || step.action === 'split-expense')) {
    const currentExpenseId = step.params?.expenseId;
    if (!currentExpenseId || currentExpenseId === 'last' || currentExpenseId === 'that') {
      try {
        const res = await fetch(`${baseUrl}/api/v1/agentbook-expense/expenses?limit=1`, {
          headers: { 'x-tenant-id': tenantId, ...(process.env.CRON_SECRET ? { Authorization: `Bearer ${process.env.CRON_SECRET}` } : {}) },
        });
        const data = await res.json() as any;
        if (data?.data?.[0]?.id) {
          step = { ...step, params: { ...step.params, expenseId: data.data[0].id } };
        }
      } catch (err) {
        console.warn(`${step.action} last-expense resolution failed:`, err);
      }
    }
  }

  const method = (endpoint.method ?? 'GET').toUpperCase();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    let url: string;
    let fetchOptions: RequestInit;

    // Build URL: substitute path params from step.params, remainder goes to query/body
    let endpointPath = endpoint.url;
    const unusedParams: Record<string, any> = { ...step.params };

    // Replace path parameters like {id} or :id
    endpointPath = endpointPath.replace(/\{(\w+)\}|:(\w+)/g, (_match: string, p1: string, p2: string) => {
      const key = p1 ?? p2;
      if (key in unusedParams) {
        const val = unusedParams[key];
        delete unusedParams[key];
        return encodeURIComponent(String(val));
      }
      // Skill manifests declare entity-specific param names (expenseId,
      // invoiceId, estimateId...) that don't always match their own
      // endpoint's generic :id path token — same alias fallback already
      // used by the direct-execution path in server.ts.
      if (key === 'id') {
        const aliasKey = ['expenseId', 'invoiceId', 'estimateId', 'clientId'].find((k) => k in unusedParams);
        if (aliasKey) {
          const val = unusedParams[aliasKey];
          delete unusedParams[aliasKey];
          return encodeURIComponent(String(val));
        }
      }
      return _match;
    });

    // Build service-to-service auth headers (same pattern as brainHeaders() in server.ts).
    // safeResolveAgentbookTenant requires CRON_SECRET bearer + x-tenant-id for non-cookie paths.
    const serviceHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-tenant-id': tenantId,
    };
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) serviceHeaders['Authorization'] = `Bearer ${cronSecret}`;

    // split-expense requires each split's amountCents, summing exactly to the
    // original expense — but the planner decides split params before step 1
    // has resolved the expense's actual amount, so a plan for "split between
    // Meals and Travel" (no explicit ratio) has nowhere to get real numbers
    // from. Default to an even split, remainder cents on the last row so the
    // sum matches exactly, rather than failing the whole step outright.
    if (step.action === 'split-expense' && Array.isArray(unusedParams.splits) && unusedParams.splits.length >= 2) {
      const splits = unusedParams.splits as Array<{ amountCents?: number }>;
      const hasRealAmounts = splits.some((s) => (s.amountCents || 0) > 0);
      if (!hasRealAmounts) {
        try {
          const expenseIdMatch = endpointPath.match(/\/expenses\/([^/]+)\/split$/);
          const expenseId = expenseIdMatch?.[1];
          if (expenseId) {
            const getRes = await fetch(`${baseUrl}/api/v1/agentbook-expense/expenses/${expenseId}`, { headers: serviceHeaders });
            const getJson = await getRes.json();
            const totalCents = getJson?.data?.amountCents;
            if (typeof totalCents === 'number' && totalCents > 0) {
              const share = Math.floor(totalCents / splits.length);
              unusedParams.splits = splits.map((s, i) => ({
                ...s,
                amountCents: i === splits.length - 1 ? totalCents - share * (splits.length - 1) : share,
              }));
            }
          }
        } catch (err) {
          console.warn('split-expense even-split default failed:', err);
        }
      }
    }

    if (method === 'GET') {
      const qs = new URLSearchParams(
        Object.entries(unusedParams)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => [k, String(v)]),
      ).toString();
      url = `${baseUrl}${endpointPath}${qs ? `?${qs}` : ''}`;
      fetchOptions = {
        method: 'GET',
        headers: serviceHeaders,
        signal: controller.signal,
      };
    } else {
      url = `${baseUrl}${endpointPath}`;
      fetchOptions = {
        method,
        headers: serviceHeaders,
        body: JSON.stringify(unusedParams),
        signal: controller.signal,
      };
    }

    const response = await fetch(url, fetchOptions);
    const json = await response.json();
    // Alias the list endpoint's `data` array as `expenses` so a following
    // step's {{steps[N].output.expenses[0].id}} template can resolve it —
    // see the query-expenses redirect above.
    if (step.action === 'query-expenses' && Array.isArray(json?.data)) {
      json.expenses = json.data;
    }
    return json;
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return { success: false, error: 'Step execution timed out after 30s' };
    }
    return { success: false, error: String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

// ─── buildUndoAction ─────────────────────────────────────────────────────────

export function buildUndoAction(step: PlanStep): UndoAction | null {
  switch (step.action) {
    case 'record-expense': {
      const id = step.result?.id ?? step.params?.id;
      if (!id) return null;
      return {
        stepId: step.id,
        description: `Undo: reject expense ${id}`,
        reverseEndpoint: `/api/v1/agentbook-expense/expenses/${id}/reject`,
        reverseMethod: 'POST',
        reverseParams: {},
      };
    }

    case 'categorize-expenses':
      // Not cleanly reversible
      return null;

    default:
      return null;
  }
}
