/**
 * Pure logic for the per-PR merge scorecard (tests/scorecard/run.ts).
 *
 * A PR in the bills/tax-codes/inventory/payroll programme merges only when four
 * groups of gates all PASS: Functional (every design goal has a passing test),
 * Regression (nothing that worked stopped working), UX (consistent with the rest
 * of the product), Launch (CI, docs, rollback, and — after deploy — prod proof).
 * A gate that did not run, was skipped, was flaky, or ran zero tests is a FAIL,
 * never a pass.
 */
export type GateStatus = 'pass' | 'fail' | 'pending' | 'accepted';
export type Group = 'F' | 'R' | 'U' | 'L';
export type Phase = 'pre' | 'post';
export interface Gate { id: string; group: Group; phase: Phase; name: string; rubric: string; status: GateStatus; evidence: string }

/** covers: programme requirement ids (docs/superpowers/scorecards/programme.json) this goal proves. */
export interface Goal { id: string; text: string; tests: string[]; covers?: string[] }
export interface Manifest {
  id: string;
  title: string;
  goals: Goal[];
  regression?: { vitest?: string[] };
  /** checklist: reviewed before merge (code-level consistency); postChecklist: visual checks in a real browser on the deployed build. */
  ux: { vitest?: string[]; playwright?: string[]; checklist: string; postChecklist?: string };
  /** docs: files this PR updates; docsNone: reason (>=20 chars) when it genuinely changes none. Exactly one. */
  /** Only R3/R2 may be accepted, and only for load-timeout failures (see acceptGate). */
  acceptedGates?: Record<string, { reason: string; isolationEvidence: string; approvedBy: string }>;
  launch: { docs?: string[]; docsNone?: string; rollback: string; prodPlaywright: string[]; playwrightConfig?: string };
}

export interface VitestFile { passed: number; failed: number; skipped: number; failureMessages?: string[] }
export interface VitestSummary { total: number; passed: number; failed: number; skipped: number; files: Record<string, VitestFile> }

/** Reads a `vitest --reporter=json` report (jest-compatible shape). */
export function summarizeVitest(report: unknown): VitestSummary {
  const files: Record<string, VitestFile> = {};
  const out: VitestSummary = { total: 0, passed: 0, failed: 0, skipped: 0, files };
  const results = ((report as { testResults?: unknown[] } | null)?.testResults ?? []) as Array<{ name?: string; message?: string; assertionResults?: Array<{ status?: string; failureMessages?: string[] }> }>;
  for (const r of results) {
    const f: VitestFile = { passed: 0, failed: 0, skipped: 0 };
    for (const a of r.assertionResults ?? []) {
      if (a.status === 'passed') f.passed += 1;
      else if (a.status === 'failed') { f.failed += 1; (f.failureMessages ??= []).push((a.failureMessages ?? []).join(' ')); }
      else f.skipped += 1; // pending | skipped | todo | disabled
    }
    if (!r.assertionResults?.length && r.message) { f.failed += 1; (f.failureMessages ??= []).push(r.message); } // suite-level failure (e.g. collect timeout)
    files[String(r.name ?? '')] = f;
    out.passed += f.passed; out.failed += f.failed; out.skipped += f.skipped;
  }
  out.total = out.passed + out.failed + out.skipped;
  return out;
}

/** Deterministic or not a gate: failed, skipped and empty all fail. */
export function strictStatus(s: { total: number; failed: number; skipped: number }): 'pass' | 'fail' {
  return s.total > 0 && s.failed === 0 && s.skipped === 0 ? 'pass' : 'fail';
}

/** A design goal passes only if every test file mapped to it ran, with tests, none failed or skipped. */
export function goalGate(goal: Goal, summary: VitestSummary): Pick<Gate, 'status' | 'evidence'> {
  const problems: string[] = [];
  let ran = 0;
  for (const want of goal.tests) {
    const hit = Object.entries(summary.files).find(([name]) => { const n = name.replace(/\\/g, '/'); return n === want || n.endsWith(`/${want}`); });
    if (!hit) { problems.push(`${want}: not run`); continue; }
    const [, f] = hit;
    const n = f.passed + f.failed + f.skipped;
    if (n === 0) problems.push(`${want}: zero tests`);
    else if (f.failed > 0) problems.push(`${want}: ${f.failed} failed`);
    else if (f.skipped > 0) problems.push(`${want}: ${f.skipped} skipped`);
    else ran += n;
  }
  return problems.length
    ? { status: 'fail', evidence: problems.join('; ') }
    : { status: 'pass', evidence: `${ran} tests passed in ${goal.tests.length} file(s)` };
}

export interface Baseline { total: number; skipped: number; dbIntegration?: string[]; tscByFile?: Record<string, number> }

/**
 * Full-suite regression: no failures, the suite did not shrink, skips did not grow.
 * Files in `base.dbIntegration` need a real Postgres. Without one (`dbAvailable` false) their failures are
 * excluded here and proved by CI's "Shell Tests" job instead, which the CI gate then requires.
 */
export function regressionGate(s: VitestSummary, base: Baseline, dbAvailable = true): Pick<Gate, 'status' | 'evidence'> {
  const dbFiles = base.dbIntegration ?? [];
  const isDb = (name: string) => dbFiles.some((d) => { const n = name.replace(/\\/g, '/'); return n === d || n.endsWith(`/${d}`); });
  const deferred = dbAvailable ? 0 : Object.entries(s.files).filter(([n]) => isDb(n)).reduce((a, [, f]) => a + f.failed, 0);
  const failed = s.failed - deferred;
  const why: string[] = [];
  if (failed > 0) why.push(`${failed} failed`);
  if (s.total < base.total) why.push(`suite shrank: ${s.total} < baseline ${base.total} (tests removed?)`);
  if (s.skipped > base.skipped) why.push(`skips grew: ${s.skipped} > baseline ${base.skipped}`);
  const note = deferred ? `; ${deferred} DB-integration failures deferred to CI Shell Tests (no DATABASE_URL)` : '';
  return why.length
    ? { status: 'fail', evidence: why.join('; ') + note }
    : { status: 'pass', evidence: `${s.passed} passed, ${s.skipped} skipped (baseline ${base.total}/${base.skipped})${note}` };
}

/** Per-file TypeScript error counts from `tsc --noEmit` output run in apps/web-next, keyed by repo-root path. */
export function parseTsc(out: string, cwdPrefix = 'apps/web-next'): Record<string, number> {
  const by: Record<string, number> = {};
  for (const line of out.split('\n')) {
    const m = /^(.+?)\(\d+,\d+\): error TS\d+/.exec(line);
    if (!m) continue;
    const parts = `${cwdPrefix}/${m[1]}`.split('/');
    const norm: string[] = [];
    for (const p of parts) { if (p === '..') norm.pop(); else if (p !== '.') norm.push(p); }
    const k = norm.join('/');
    by[k] = (by[k] ?? 0) + 1;
  }
  return by;
}

/** CI's typecheck is non-blocking (pre-existing errors), so the gate is "no new errors": no file may exceed its baseline count. */
export function tscGate(now: Record<string, number>, base: Record<string, number> = {}): Pick<Gate, 'status' | 'evidence'> {
  const worse = Object.entries(now).filter(([f, n]) => n > (base[f] ?? 0));
  const total = Object.values(now).reduce((a, b) => a + b, 0);
  const baseTotal = Object.values(base).reduce((a, b) => a + b, 0);
  return worse.length
    ? { status: 'fail', evidence: `new type errors in: ${worse.map(([f, n]) => `${f} (${n} > ${base[f] ?? 0})`).join(', ')}` }
    : { status: 'pass', evidence: `${total} errors, none new (baseline ${baseTotal})` };
}

export function checklistStatus(md: string): { status: GateStatus; done: number; total: number } {
  const done = (md.match(/^\s*- \[[xX]\]/gm) ?? []).length;
  const open = (md.match(/^\s*- \[ \]/gm) ?? []).length;
  const total = done + open;
  return { status: total > 0 && open === 0 ? 'pass' : 'pending', done, total };
}

/** Every required path must appear in the PR's changed-file list. */
export function touchedGate(changed: string[], required: string[]): Pick<Gate, 'status' | 'evidence'> {
  const missing = required.filter((r) => !changed.some((c) => c === r || c.startsWith(r.endsWith('/') ? r : `${r}/`)));
  return missing.length
    ? { status: 'fail', evidence: `not updated in this PR: ${missing.join(', ')}` }
    : { status: 'pass', evidence: `updated: ${required.join(', ')}` };
}

/** L2: a declared docs list must be touched; docsNone passes with its stated reason. */
export function docsGate(changed: string[], launch: Manifest['launch']): Pick<Gate, 'status' | 'evidence'> {
  if (launch.docsNone !== undefined) return { status: 'pass', evidence: `no docs changed: ${launch.docsNone}` };
  return touchedGate(changed, launch.docs ?? []);
}

export interface CheckRow { name: string; bucket: string }
/** gh `pr checks --json name,bucket`. Quality Gates, CodeQL and Shell Tests (the DB-backed full suite) are mandatory. */
export function ciGate(rows: CheckRow[], required = ['Quality Gates', 'CodeQL', 'Shell Tests']): Pick<Gate, 'status' | 'evidence'> {
  const missing = required.filter((r) => !rows.some((c) => c.name.includes(r)));
  if (missing.length) return { status: 'fail', evidence: `required check absent: ${missing.join(', ')}` };
  const bad = rows.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel');
  if (bad.length) return { status: 'fail', evidence: `failing: ${bad.map((c) => c.name).join(', ')}` };
  const wait = rows.filter((c) => c.bucket === 'pending');
  if (wait.length) return { status: 'pending', evidence: `still running: ${wait.map((c) => c.name).join(', ')}` };
  return { status: 'pass', evidence: `${rows.length} checks green` };
}

const ACCEPTABLE_GATES = ['R3', 'R2'];
const TIMEOUT_RE = /timed out|STACK_TRACE_ERROR/;
const norm = (p: string) => p.replace(/\\/g, '/');

/**
 * User-approved 2026-11-21: a R2/R3 FAIL caused ONLY by load timeouts in files this PR does not touch, every one of which
 * passes when re-run alone, may be ACCEPTED (CI's Shell Tests must still be green via L1). Anything else stays FAIL.
 * `rerun(file)` runs that single file alone. A raw PASS ignores the acceptance.
 */
export function acceptGate(
  raw: Pick<Gate, 'status' | 'evidence'>,
  acc: { reason: string; approvedBy: string } | undefined,
  summary: VitestSummary,
  changed: string[],
  rerun: (file: string) => VitestSummary,
): Pick<Gate, 'status' | 'evidence'> {
  if (raw.status !== 'fail' || !acc) return raw;
  const failing = Object.entries(summary.files).filter(([, f]) => f.failed > 0);
  const stay = (why: string): Pick<Gate, 'status' | 'evidence'> => ({ status: 'fail', evidence: `${why}; ${raw.evidence}` });
  if (!failing.length) return stay('accepted gate has no failing files to accept (shrink/skip problems are never accepted)');
  const msgs = failing.flatMap(([, f]) => f.failureMessages ?? []);
  const nFailed = failing.reduce((a, [, f]) => a + f.failed, 0);
  if (msgs.length < nFailed || !msgs.every((m) => TIMEOUT_RE.test(m))) return stay('accepted gate has non-timeout failures');
  if (summary.total < 1 || raw.evidence.includes('shrank') || raw.evidence.includes('skips grew')) return stay('accepted gate also fails the floor');
  const touched = failing.map(([n]) => n).filter((n) => changed.some((c) => norm(n) === c || norm(n).endsWith(`/${c}`)));
  if (touched.length) return stay(`accepted gate: failing files are changed by this PR: ${touched.join(', ')}`);
  const results = failing.map(([n]) => [n, strictStatus(rerun(n))] as const);
  const bad = results.filter(([, st]) => st !== 'pass');
  if (bad.length) return stay(`accepted gate: isolation re-run failed: ${bad.map(([n]) => n).join(', ')}`);
  return {
    status: 'accepted',
    evidence: `ACCEPTED (approved by ${acc.approvedBy}): ${acc.reason}. Timed-out files: ${failing.map(([n]) => n).join(', ')}. Isolation re-runs: ${results.map(([n]) => `${n} PASS`).join(', ')}`,
  };
}

export function validateManifest(m: Partial<Manifest> | null, exists: (p: string) => boolean): string[] {
  const e: string[] = [];
  if (!m) return ['manifest is not an object'];
  if (!m.id) e.push('id missing');
  if (!m.title) e.push('title missing');
  if (!m.goals?.length) e.push('at least one design goal is required');
  const seen = new Set<string>();
  for (const g of m.goals ?? []) {
    if (!g.id || seen.has(g.id)) e.push(`goal id missing or duplicated: ${g.id ?? '(none)'}`);
    seen.add(g.id);
    if (!g.text?.trim()) e.push(`goal ${g.id}: text missing`);
    if (!g.tests?.length) e.push(`goal ${g.id}: no test file maps to it`);
    for (const t of g.tests ?? []) if (!exists(t)) e.push(`goal ${g.id}: test file not found: ${t}`);
  }
  if (!m.ux?.checklist) e.push('ux.checklist missing');
  else if (!exists(m.ux.checklist)) e.push(`ux.checklist not found: ${m.ux.checklist}`);
  if (m.ux?.postChecklist && !exists(m.ux.postChecklist)) e.push(`ux.postChecklist not found: ${m.ux.postChecklist}`);
  if (!m.launch?.rollback?.trim()) e.push('launch.rollback must say how this PR is undone');
  const hasDocs = !!m.launch?.docs?.length;
  const hasNone = m.launch?.docsNone !== undefined;
  if (hasDocs && hasNone) e.push('launch.docs and launch.docsNone are mutually exclusive: give exactly one');
  else if (!hasDocs && !hasNone) e.push('launch.docs must list the docs this PR updates (or launch.docsNone must say why none changed)');
  else if (hasNone && (typeof m.launch.docsNone !== 'string' || m.launch.docsNone.trim().length < 20)) e.push('launch.docsNone must be a reason of at least 20 characters');
  for (const [id, a] of Object.entries(m.acceptedGates ?? {})) {
    if (!ACCEPTABLE_GATES.includes(id)) e.push(`acceptedGates.${id}: only ${ACCEPTABLE_GATES.join('/')} may be accepted`);
    if (typeof a?.reason !== 'string' || a.reason.trim().length < 40) e.push(`acceptedGates.${id}.reason must be at least 40 characters`);
    if (!a?.isolationEvidence?.trim()) e.push(`acceptedGates.${id}.isolationEvidence missing`);
    if (!a?.approvedBy?.trim()) e.push(`acceptedGates.${id}.approvedBy missing`);
  }
  if (!m.launch?.prodPlaywright?.length) e.push('launch.prodPlaywright needs at least one prod e2e file');
  for (const p of [...(m.launch?.prodPlaywright ?? []), ...(m.ux?.playwright ?? []), ...(m.regression?.vitest ?? []), ...(m.ux?.vitest ?? [])]) {
    if (!exists(p)) e.push(`file not found: ${p}`);
  }
  return e;
}

/** pre: MERGE-READY needs every pre gate. post: LAUNCH-READY needs every gate, pre and post. */
export function verdict(phase: Phase, gates: Gate[]): 'MERGE-READY' | 'LAUNCH-READY' | 'NO-GO' {
  const scope = phase === 'pre' ? gates.filter((g) => g.phase === 'pre') : gates;
  const ok = scope.length > 0 && scope.every((g) => g.status === 'pass' || g.status === 'accepted');
  if (!ok) return 'NO-GO';
  return phase === 'pre' ? 'MERGE-READY' : 'LAUNCH-READY';
}

// Backslashes first: escaping only '|' lets a trailing backslash un-escape it and split the row.
const cell = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
const GROUP: Record<Group, string> = { F: 'Functional — meets the design goals', R: 'Regression — nothing that worked broke', U: 'UX — consistent with the rest of the product', L: 'Launch — ready to ship' };

export function renderReport(m: Pick<Manifest, 'id' | 'title'>, phase: Phase, gates: Gate[], meta: { commit: string; runAt: string; base?: string }): string {
  const v = verdict(phase, gates);
  const out = [
    `# Merge scorecard — ${m.title}`, '',
    `Programme PR: \`${m.id}\` · phase: **${phase}** · commit \`${meta.commit}\` · run ${meta.runAt}${meta.base ? ` · target ${meta.base}` : ''}`,
    'Generated by tests/scorecard/run.ts. A gate that did not run, skipped, flaked or ran zero tests is FAIL.', '',
    `**Verdict: ${v}**`, '',
  ];
  for (const g of ['F', 'R', 'U', 'L'] as Group[]) {
    const rows = gates.filter((x) => x.group === g);
    if (!rows.length) continue;
    out.push(`## ${GROUP[g]}`, '', '| Gate | Phase | What it proves | Result | Evidence |', '|---|---|---|---|---|');
    for (const r of rows) out.push(`| ${r.id} ${cell(r.name)} | ${r.phase} | ${cell(r.rubric)} | ${r.status.toUpperCase()} | ${cell(r.evidence)} |`);
    out.push('');
  }
  return out.join('\n');
}
