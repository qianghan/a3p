/**
 * Pure logic for the PROGRAMME scorecard (tests/scorecard/programme.ts).
 *
 * The per-PR scorecard (lib.ts / run.ts) proves one PR merges safely. This layer proves the
 * whole programme delivers its scope: every tester finding and every spec goal / anti-goal is a
 * requirement; every requirement is assigned to plan PRs; each of those PRs' manifests names the
 * goals (and so the test files) that cover it; a requirement is DELIVERED only when all of that is
 * true, its tests pass, every PR behind it is LAUNCH-READY on production, and its cross-PR journeys
 * pass in each market it applies to. Anything missing is "not delivered", never a silent pass.
 */
import type { GateStatus, Manifest, VitestSummary } from './lib';
import { goalGate } from './lib';

export type Market = 'us' | 'ca' | 'au';
export const PERSONA_MARKET: Record<string, Market> = { alex: 'us', maya: 'ca', sydney: 'au' };

export interface Finding { id: string; text: string; requirements: string[] }
export interface Requirement { id: string; spec: string[]; text: string; markets: Market[]; prs: string[]; journeys?: string[] }
export interface ProgrammePr { id: string; plan: string; manifest: string }
export interface Journey { id: string; spec: string; personas: string[]; requirements: string[] }
export interface OwnerCall { id: string; text: string; confirmed: boolean; by?: string; on?: string }
export interface Programme {
  spec: string;
  plan: string;
  findings: Finding[];
  requirements: Requirement[];
  prs: ProgrammePr[];
  journeys: Journey[];
  ownerCalls: OwnerCall[];
}
/** A per-PR manifest goal may declare which programme requirements it proves. */
export type CoveringManifest = Manifest & { goals: Array<Manifest['goals'][number] & { covers?: string[] }> };

export type PrVerdict = 'LAUNCH-READY' | 'MERGE-READY' | 'NO-GO' | 'NOT STARTED';
export type ReqStatus = 'delivered' | 'in-progress' | 'not-started';

/** Spec §2: "- G1. …" goal ids, and the anti-goal bullets numbered A1..An in document order. */
export function specScope(spec: string): { goals: string[]; antiGoals: string[] } {
  const goals = [...spec.matchAll(/^- (G\d+)\./gm)].map((m) => m[1]);
  const anti = spec.split(/^Anti-goals\s*$/m)[1]?.split(/^#/m)[0] ?? '';
  const antiGoals = [...anti.matchAll(/^- /gm)].map((_, i) => `A${i + 1}`);
  return { goals, antiGoals };
}

/** Plan "## PR 2a — …" headings → ['1', '2a', …]. */
export function planPrs(plan: string): string[] {
  return [...plan.matchAll(/^## PR (\S+)/gm)].map((m) => m[1]);
}

/** Structural completeness: every finding, goal, anti-goal and plan PR is accounted for. */
export function validateProgramme(p: Programme, spec: string, plan: string, exists: (f: string) => boolean): string[] {
  const e: string[] = [];
  const ids = (xs: Array<{ id: string }>, kind: string) => {
    const seen = new Set<string>();
    for (const x of xs) { if (seen.has(x.id)) e.push(`${kind} id duplicated: ${x.id}`); seen.add(x.id); }
    return seen;
  };
  const reqIds = ids(p.requirements, 'requirement');
  const prIds = ids(p.prs, 'pr');
  ids(p.findings, 'finding');
  ids(p.journeys, 'journey');

  if (p.findings.length === 0) e.push('no tester findings listed');
  for (const f of p.findings) {
    if (!f.requirements.length) e.push(`finding ${f.id} maps to no requirement`);
    for (const r of f.requirements) if (!reqIds.has(r)) e.push(`finding ${f.id}: unknown requirement ${r}`);
  }
  const { goals, antiGoals } = specScope(spec);
  if (!goals.length) e.push('spec has no "- G1." goals (wrong spec path?)');
  const covered = new Set(p.requirements.flatMap((r) => r.spec));
  for (const g of [...goals, ...antiGoals]) if (!covered.has(g)) e.push(`spec ${g} is not covered by any requirement`);
  for (const r of p.requirements) {
    if (!r.prs.length) e.push(`requirement ${r.id} is assigned to no PR`);
    for (const x of r.prs) if (!prIds.has(x)) e.push(`requirement ${r.id}: unknown PR ${x}`);
    if (!r.markets.length) e.push(`requirement ${r.id} names no market`);
    for (const j of r.journeys ?? []) if (!p.journeys.some((x) => x.id === j)) e.push(`requirement ${r.id}: unknown journey ${j}`);
  }
  for (const n of planPrs(plan)) {
    if (!p.prs.some((x) => x.plan === n || x.plan.startsWith(n))) e.push(`plan PR ${n} has no programme entry`);
  }
  for (const x of p.prs) if (!p.requirements.some((r) => r.prs.includes(x.id))) e.push(`PR ${x.id} delivers no requirement`);
  for (const j of p.journeys) {
    for (const r of j.requirements) if (!reqIds.has(r)) e.push(`journey ${j.id}: unknown requirement ${r}`);
    for (const who of j.personas) if (!PERSONA_MARKET[who]) e.push(`journey ${j.id}: unknown persona ${who}`);
  }
  for (const f of [p.spec, p.plan]) if (!exists(f)) e.push(`file not found: ${f}`);
  return e;
}

/** Per PR: its manifest's goals must cover exactly the requirements the programme assigns to it. */
export function traceability(p: Programme, pr: ProgrammePr, m: CoveringManifest | null): { status: GateStatus; evidence: string } {
  if (!m) return { status: 'pending', evidence: 'no manifest yet' };
  const assigned = p.requirements.filter((r) => r.prs.includes(pr.id)).map((r) => r.id);
  const covers = new Set(m.goals.flatMap((g) => g.covers ?? []));
  const missing = assigned.filter((r) => !covers.has(r));
  const unknown = [...covers].filter((r) => !assigned.includes(r));
  if (missing.length || unknown.length) {
    return { status: 'fail', evidence: [missing.length && `uncovered: ${missing.join(', ')}`, unknown.length && `not assigned to this PR: ${unknown.join(', ')}`].filter(Boolean).join('; ') };
  }
  return { status: 'pass', evidence: `${assigned.length} requirement(s) covered by named goals` };
}

/** Reads the verdict line run.ts writes into a post report. A missing report is NOT STARTED. */
export function parseVerdict(md: string | null): PrVerdict {
  if (!md) return 'NOT STARTED';
  const v = /\*\*Verdict: (LAUNCH-READY|MERGE-READY|NO-GO)\*\*/.exec(md)?.[1];
  return (v as PrVerdict | undefined) ?? 'NO-GO';
}

export interface ReqContext {
  manifests: Record<string, CoveringManifest | null>;
  verdicts: Record<string, PrVerdict>;
  tests: VitestSummary;
  journeys: Record<string, GateStatus>;
  programme: Programme;
}

/** One requirement: delivered only when every leg of the chain holds. */
export function requirementStatus(r: Requirement, ctx: ReqContext): { status: ReqStatus; reasons: string[]; markets: Market[] } {
  const reasons: string[] = [];
  let started = false;
  for (const pr of r.prs) {
    const m = ctx.manifests[pr];
    const v = ctx.verdicts[pr] ?? 'NOT STARTED';
    if (m || v !== 'NOT STARTED') started = true;
    if (!m) { reasons.push(`${pr}: no manifest`); continue; }
    const goals = m.goals.filter((g) => g.covers?.includes(r.id));
    if (!goals.length) reasons.push(`${pr}: no goal covers it`);
    for (const g of goals) {
      const t = goalGate(g, ctx.tests);
      if (t.status !== 'pass') reasons.push(`${pr}/${g.id}: ${t.evidence}`);
    }
    if (v !== 'LAUNCH-READY') reasons.push(`${pr}: ${v}`);
  }
  const markets = new Set<Market>();
  for (const jid of r.journeys ?? []) {
    const j = ctx.programme.journeys.find((x) => x.id === jid)!;
    const s = ctx.journeys[jid] ?? 'pending';
    if (s !== 'pass') reasons.push(`journey ${jid}: ${s === 'pending' ? 'not run' : 'failed'}`);
    else for (const who of j.personas) markets.add(PERSONA_MARKET[who]);
  }
  // Without a cross-PR journey, a market is evidenced by the PR's own prod e2e (three personas by rule).
  if (!r.journeys?.length && r.prs.every((pr) => ctx.verdicts[pr] === 'LAUNCH-READY')) r.markets.forEach((x) => markets.add(x));
  const gaps = r.markets.filter((x) => !markets.has(x));
  if (gaps.length) reasons.push(`no prod evidence in: ${gaps.join(', ')}`);
  const status: ReqStatus = reasons.length === 0 ? 'delivered' : started ? 'in-progress' : 'not-started';
  return { status, reasons, markets: [...markets] };
}

export interface ProgrammeResult {
  scopeErrors: string[];
  trace: Record<string, { status: GateStatus; evidence: string }>;
  reqs: Record<string, ReturnType<typeof requirementStatus>>;
  ownerOpen: string[];
}

/** COMPLETE needs: no scope error, every PR traced, every requirement delivered, every owner call confirmed. */
export function programmeVerdict(r: ProgrammeResult): 'COMPLETE' | 'IN PROGRESS' | 'BROKEN' {
  if (r.scopeErrors.length || Object.values(r.trace).some((t) => t.status === 'fail')) return 'BROKEN';
  const all = Object.values(r.reqs);
  const done = all.length > 0 && all.every((x) => x.status === 'delivered')
    && Object.values(r.trace).every((t) => t.status === 'pass') && r.ownerOpen.length === 0;
  return done ? 'COMPLETE' : 'IN PROGRESS';
}

const cell = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
const MARK: Record<ReqStatus, string> = { delivered: 'DELIVERED', 'in-progress': 'IN PROGRESS', 'not-started': 'NOT STARTED' };

export function renderProgramme(p: Programme, r: ProgrammeResult, verdicts: Record<string, PrVerdict>, meta: { commit: string; runAt: string; phase: string }): string {
  const v = programmeVerdict(r);
  const reqs = p.requirements;
  const done = reqs.filter((x) => r.reqs[x.id]?.status === 'delivered').length;
  const out = [
    '# Programme scorecard — bills, tax codes, one-step entry, inventory, payroll', '',
    `phase: **${meta.phase}** · commit \`${meta.commit}\` · run ${meta.runAt}`,
    'Generated by tests/scorecard/programme.ts. A requirement is DELIVERED only when its PRs are LAUNCH-READY, the goals that cover it pass, and it has prod evidence in every market it applies to.', '',
    `**Verdict: ${v}** — ${done}/${reqs.length} requirements delivered`, '',
  ];
  if (r.scopeErrors.length) out.push('## Scope errors (the programme definition itself is incomplete)', '', ...r.scopeErrors.map((x) => `- ${x}`), '');
  out.push('## Tester findings', '', '| # | Finding | Requirements | Status |', '|---|---|---|---|');
  for (const f of p.findings) {
    const st = f.requirements.map((id) => r.reqs[id]?.status ?? 'not-started');
    const s: ReqStatus = st.every((x) => x === 'delivered') ? 'delivered' : st.some((x) => x !== 'not-started') ? 'in-progress' : 'not-started';
    out.push(`| ${f.id} | ${cell(f.text)} | ${f.requirements.join(', ')} | ${MARK[s]} |`);
  }
  out.push('', '## Requirements', '', '| Req | Spec | What must be true | Markets | PRs | Status | Open items |', '|---|---|---|---|---|---|---|');
  for (const x of reqs) {
    const s = r.reqs[x.id];
    const mk = x.markets.map((m) => (s?.markets.includes(m) ? `${m}✓` : m)).join(' ');
    out.push(`| ${x.id} | ${x.spec.join(' ')} | ${cell(x.text)} | ${mk} | ${x.prs.join(', ')} | ${MARK[s?.status ?? 'not-started']} | ${cell((s?.reasons ?? []).slice(0, 4).join('; ') || '—')} |`);
  }
  out.push('', '## Plan PRs', '', '| PR | Plan | Post-deploy verdict | Traceability |', '|---|---|---|---|');
  for (const x of p.prs) out.push(`| ${x.id} | ${x.plan} | ${verdicts[x.id] ?? 'NOT STARTED'} | ${r.trace[x.id]?.status.toUpperCase() ?? 'PENDING'}: ${cell(r.trace[x.id]?.evidence ?? '')} |`);
  out.push('', '## Owner calls (spec §10)', '', '| # | Call | Confirmed |', '|---|---|---|');
  for (const c of p.ownerCalls) out.push(`| ${c.id} | ${cell(c.text)} | ${c.confirmed ? `yes${c.by ? ` (${c.by}${c.on ? `, ${c.on}` : ''})` : ''}` : 'NO'} |`);
  out.push('');
  return out.join('\n');
}
