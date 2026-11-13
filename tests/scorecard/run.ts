/**
 * Per-PR merge scorecard for the bills / tax-codes / inventory / payroll programme.
 * Run from the repo root:
 *   npx tsx tests/scorecard/run.ts --manifest docs/superpowers/scorecards/<pr>.json [--phase pre|post]
 *        [--pr N] [--merge-sha SHA] [--base URL] [--skip-full] [--reuse-full FILE] [--out FILE]
 *
 *   --phase pre   (default) before merge: Functional, Regression, UX, Launch-pre gates. Verdict MERGE-READY | NO-GO.
 *   --phase post  after merge + deploy: reads the saved pre result, then proves the deploy and runs the prod e2e.
 *                 Verdict LAUNCH-READY | NO-GO. Needs --merge-sha for the deploy check.
 *   --pr N        PR number, for the CI-checks gate (absent => that gate is PENDING => NO-GO).
 *   --skip-full   do not run the full suite; the regression gate is PENDING (NO-GO), never a silent pass.
 *   --reuse-full  evaluate a vitest JSON report from an earlier full run instead of re-running.
 * Exit code 0 only on MERGE-READY / LAUNCH-READY.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  checklistStatus, ciGate, goalGate, parseTsc, tscGate, regressionGate, renderReport, strictStatus, summarizeVitest, touchedGate,
  validateManifest, verdict, type Gate, type Group, type Manifest, type Phase, type VitestSummary,
} from './lib';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*\n|^ \* ?/gm, ''));
  process.exit(0);
}
const opt = (n: string) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : undefined; };
const ROOT = process.cwd();
if (!existsSync(join(ROOT, 'apps', 'web-next'))) throw new Error('run from the repo root');
const manifestPath = opt('--manifest');
if (!manifestPath) throw new Error('--manifest is required');
const PHASE = (opt('--phase') ?? 'pre') as Phase;
if (PHASE !== 'pre' && PHASE !== 'post') throw new Error('--phase must be pre or post');
const BASE = opt('--base') ?? 'https://agentbook.brainliber.com';
const RESULTS = join(ROOT, 'tests', 'scorecard', 'results');
mkdirSync(RESULTS, { recursive: true });

const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8')) as Manifest;
const common = JSON.parse(readFileSync(join(ROOT, 'tests/scorecard/common.json'), 'utf8')) as { regressionCore: string[]; uxGuards: string[] };
const baseline = JSON.parse(readFileSync(join(ROOT, 'tests/scorecard/baseline.json'), 'utf8')) as { total: number; skipped: number; dbIntegration?: string[]; tscByFile?: Record<string, number> };

const exists = (p: string) => existsSync(join(ROOT, p));
const errors = validateManifest(manifest, exists);
for (const f of [...common.regressionCore, ...common.uxGuards]) if (!exists(f)) errors.push(`common guard missing (renamed or deleted?): ${f}`);
if (errors.length) { console.error(`Manifest/guard errors:\n - ${errors.join('\n - ')}`); process.exit(2); }

function sh(cmd: string, a: string[], cwd = ROOT, env: Record<string, string> = {}) {
  const r = spawnSync(cmd, a, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const tail = (s: string, n = 300) => s.trim().slice(-n);
const commit = sh('git', ['rev-parse', '--short', 'HEAD']).out.trim();

/** Nearest ancestor directory holding a vitest config: the workspace a test file must be run from. */
function vitestRoot(file: string): string {
  let d = dirname(join(ROOT, file));
  while (d.startsWith(ROOT) && d !== ROOT) {
    if (['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js'].some((c) => existsSync(join(d, c)))) return d;
    d = dirname(d);
  }
  return ROOT;
}
function runVitest(files: string[], tag: string): VitestSummary {
  const byRoot = new Map<string, string[]>();
  for (const f of files) byRoot.set(vitestRoot(f), [...(byRoot.get(vitestRoot(f)) ?? []), f]);
  const merged: VitestSummary = { total: 0, passed: 0, failed: 0, skipped: 0, files: {} };
  let i = 0;
  for (const [root, fs] of byRoot) {
    const out = join(RESULTS, `${manifest.id}.${tag}.${i++}.json`);
    sh('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${out}`, ...fs.map((f) => relative(root, join(ROOT, f)))], root, { NODE_OPTIONS: '--max-old-space-size=4096' });
    if (!existsSync(out)) continue; // nothing ran: every file reads "not run" and fails
    const s = summarizeVitest(JSON.parse(readFileSync(out, 'utf8')));
    merged.total += s.total; merged.passed += s.passed; merged.failed += s.failed; merged.skipped += s.skipped;
    Object.assign(merged.files, s.files);
  }
  return merged;
}

const gates: Gate[] = [];
const add = (id: string, group: Group, phase: Phase, name: string, rubric: string, r: Pick<Gate, 'status' | 'evidence'>) =>
  gates.push({ id, group, phase, name, rubric, ...r });
const playwrightSummary = (j: unknown) => { const s = ((j as { stats?: Record<string, number> } | null)?.stats ?? {}); return { expected: s.expected ?? 0, unexpected: s.unexpected ?? 0, flaky: s.flaky ?? 0, skipped: s.skipped ?? 0 }; };
function runPlaywright(files: string[], tag: string): Pick<Gate, 'status' | 'evidence'> {
  const out = join(RESULTS, `${manifest.id}.${tag}.json`);
  sh('npx', ['playwright', 'test', `--config=${manifest.launch.playwrightConfig ?? 'tests/e2e/mobile-app/playwright.config.ts'}`, ...files, '--reporter=json'], ROOT, { E2E_BASE_URL: BASE, PLAYWRIGHT_JSON_OUTPUT_NAME: out });
  if (!existsSync(out)) return { status: 'fail', evidence: 'not run: no result file' };
  let j: unknown = null; try { j = JSON.parse(readFileSync(out, 'utf8')); } catch { /* empty => fail */ }
  const s = playwrightSummary(j);
  const ok = s.expected > 0 && s.unexpected === 0 && s.flaky === 0 && s.skipped === 0;
  return { status: ok ? 'pass' : 'fail', evidence: `passed ${s.expected}, failed ${s.unexpected}, flaky ${s.flaky}, skipped ${s.skipped}` };
}

if (PHASE === 'pre') {
  // F — one gate per design goal, traceable to the test files that prove it.
  const goalFiles = [...new Set(manifest.goals.flatMap((g) => g.tests))];
  const fsum = runVitest(goalFiles, 'functional');
  for (const g of manifest.goals) add(`F-${g.id}`, 'F', 'pre', g.id, g.text, goalGate(g, fsum));

  // R — typecheck, curated core guards, then the whole suite against the floor.
  const tc = sh('npx', ['tsc', '--noEmit'], join(ROOT, 'apps/web-next'));
  add('R1', 'R', 'pre', 'Typecheck: no new errors', 'no file has more TypeScript errors than on main (CI typecheck is non-blocking)', tc.out.includes('error TS') || tc.code === 0 ? tscGate(parseTsc(tc.out), baseline.tscByFile) : { status: 'fail', evidence: `tsc did not run: ${tail(tc.out)}` });
  const core = runVitest([...new Set([...common.regressionCore, ...(manifest.regression?.vitest ?? [])])], 'regression-core');
  add('R2', 'R', 'pre', 'Core ledger/tax/payroll guards', 'books, tax and payroll invariants still hold', { status: strictStatus(core), evidence: `${core.passed} passed, ${core.failed} failed, ${core.skipped} skipped` });
  const reuse = opt('--reuse-full');
  if (args.includes('--skip-full') && !reuse) {
    add('R3', 'R', 'pre', 'Full suite vs floor', 'no failures, no tests removed, no new skips', { status: 'pending', evidence: 'full suite not run (--skip-full)' });
  } else {
    const file = reuse ?? join(RESULTS, `${manifest.id}.full.json`);
    if (!reuse) sh('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${file}`], join(ROOT, 'apps/web-next'), { NODE_OPTIONS: '--max-old-space-size=4096' });
    add('R3', 'R', 'pre', 'Full suite vs floor', 'no failures, no tests removed, no new skips',
      existsSync(file) ? regressionGate(summarizeVitest(JSON.parse(readFileSync(file, 'utf8'))), baseline, Boolean(process.env.DATABASE_URL)) : { status: 'fail', evidence: 'not run: no result file' });
  }

  // U — shared design/i18n/a11y guards plus the human consistency review.
  const ux = runVitest([...new Set([...common.uxGuards, ...(manifest.ux.vitest ?? [])])], 'ux');
  add('U1', 'U', 'pre', 'Kit, hygiene and i18n guards', 'tokens, copy, catalogs (en/fr-CA/zh-CN) and contrast match the rest of the product', { status: strictStatus(ux), evidence: `${ux.passed} passed, ${ux.failed} failed, ${ux.skipped} skipped` });
  const cl = checklistStatus(readFileSync(join(ROOT, manifest.ux.checklist), 'utf8'));
  add('U2', 'U', 'pre', 'Consistency review', 'each screen reviewed against a named sibling screen', { status: cl.status, evidence: `${cl.done}/${cl.total} boxes ticked` });

  // L — CI, docs, rollback.
  const pr = opt('--pr');
  if (pr) {
    const r = sh('gh', ['pr', 'checks', pr, '--json', 'name,bucket']);
    let rows: Array<{ name: string; bucket: string }> = []; try { rows = JSON.parse(r.out); } catch { /* gate fails below */ }
    add('L1', 'L', 'pre', 'CI checks', 'Quality Gates, CodeQL and Shell Tests (DB-backed full suite) are green on the PR', rows.length ? ciGate(rows) : { status: 'fail', evidence: tail(r.out) });
  } else add('L1', 'L', 'pre', 'CI checks', 'Quality Gates, CodeQL and Shell Tests (DB-backed full suite) are green on the PR', { status: 'pending', evidence: 'no --pr given' });
  const changed = sh('git', ['diff', '--name-only', 'origin/main...HEAD']).out.split('\n').filter(Boolean);
  add('L2', 'L', 'pre', 'Docs updated', 'the PR updates the docs it declares', touchedGate(changed, manifest.launch.docs));
  add('L3', 'L', 'pre', 'Rollback stated', 'how this PR is undone is written down', { status: 'pass', evidence: manifest.launch.rollback });
  writeFileSync(join(RESULTS, `${manifest.id}.pre.json`), JSON.stringify(gates, null, 2));
} else {
  const preFile = join(RESULTS, `${manifest.id}.pre.json`);
  if (!existsSync(preFile)) gates.push({ id: 'L0', group: 'L', phase: 'pre', name: 'Pre-merge scorecard', rubric: 'a passing pre run exists', status: 'fail', evidence: 'no saved pre result: run --phase pre first' });
  else gates.push(...(JSON.parse(readFileSync(preFile, 'utf8')) as Gate[]));
  const sha = opt('--merge-sha');
  if (sha) {
    const r = sh('gh', ['api', `repos/{owner}/{repo}/commits/${sha}/status`, '--jq', '[.statuses[]|select(.context|test("vercel";"i"))|.state]|join(",")']);
    const states = r.out.trim();
    add('L4', 'L', 'post', 'Deployed', 'the merge commit is live on production', states.includes('success') ? { status: 'pass', evidence: `Vercel status for ${sha.slice(0, 8)}: ${states}` } : { status: 'pending', evidence: states ? `Vercel status: ${states}` : 'no Vercel status found yet' });
  } else add('L4', 'L', 'post', 'Deployed', 'the merge commit is live on production', { status: 'pending', evidence: 'no --merge-sha given' });
  if (manifest.ux.playwright?.length) add('U3', 'U', 'post', 'Prod a11y / locale / layout', 'axe, fr-CA/zh-CN and layout on the touched screens', runPlaywright(manifest.ux.playwright, 'ux-prod'));
  add('L5', 'L', 'post', 'Prod e2e, three markets', 'create → verify → clean up on CA, US, AU personas; books return to start', runPlaywright(manifest.launch.prodPlaywright, 'prod'));
}

const report = renderReport(manifest, PHASE, gates, { commit, runAt: new Date().toISOString(), base: PHASE === 'post' ? BASE : undefined });
const out = resolve(opt('--out') ?? join(ROOT, 'docs', 'superpowers', 'reports', 'scorecards', `${manifest.id}-${PHASE}.md`));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, report);
const v = verdict(PHASE, gates);
console.log(report);
console.log(`\nVerdict: ${v}  (report: ${relative(ROOT, out)})`);
process.exit(v === 'NO-GO' ? 1 : 0);
