/**
 * Executes every launch gate (spec §8) against a deployment and writes the
 * launch report. Run from the repo root:
 *   npx tsx tests/e2e/mobile-app/scorecard.ts [--base URL] [--results-dir DIR] [--out FILE]
 *
 *   --base         deployment under test (default https://agentbook.brainliber.com)
 *   --results-dir  READ-ONLY mode: run nothing, evaluate result files already in DIR
 *                  (Gn.json = Playwright JSON; Gn.cmd.json = {"ok":bool,"evidence":str} for
 *                  command gates G1,G2,G3,G6,G12). A missing file is FAIL "not run".
 *                  Default: run the gates and write raw results to tests/e2e/mobile-app/results/.
 *   --out          report path (default docs/superpowers/reports/2026-10-mobile-app-launch-report.md)
 *   --help         this text
 * Exit code 0 only on GO.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  checklistStatus, knownLimitations, missingResultGate, parseOverrides, personaBreakdown, playwrightStatus,
  renderReport, summarizePlaywright, verdict, type GateResult,
} from './scorecard-lib';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*\n|^ \* ?/gm, ''));
  process.exit(0);
}
const opt = (name: string) => { const i = args.indexOf(name); return i > -1 ? args[i + 1] : undefined; };

const ROOT = process.cwd();
if (!existsSync(join(ROOT, 'apps', 'web-next'))) throw new Error('run from the repo root');
const BASE = opt('--base') ?? 'https://agentbook.brainliber.com';
const READ_ONLY = opt('--results-dir') !== undefined;
const OUT = resolve(opt('--results-dir') ?? join(ROOT, 'tests', 'e2e', 'mobile-app', 'results'));
mkdirSync(OUT, { recursive: true });
const CONFIG = 'tests/e2e/mobile-app/playwright.config.ts';
const REPORT = resolve(opt('--out') ?? join(ROOT, 'docs', 'superpowers', 'reports', '2026-10-mobile-app-launch-report.md'));
const CHECKLIST = join(ROOT, 'docs', 'superpowers', 'reports', '2026-10-mobile-device-pass.md');
const OVERRIDES = join(ROOT, 'bin', 'perf-mobile-overrides.json');

function sh(cmd: string, args: string[], env: Record<string, string> = {}, cwd = ROOT) {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const tail = (s: string, n = 400) => s.trim().slice(-n);

const results: GateResult[] = [];
const add = (id: string, gate: string, rubric: string, status: GateResult['status'], evidence: string) =>
  results.push({ id, gate, rubric, status, evidence });

/** Playwright gate. In read-only mode a missing JSON is FAIL "not run". */
function playwright(id: string, files: string[]): { status: 'pass' | 'fail'; evidence: string; json: unknown; ran: boolean } {
  const jsonFile = join(OUT, `${id}.json`);
  if (!READ_ONLY) {
    sh('npx', ['playwright', 'test', `--config=${CONFIG}`, ...files, '--reporter=json'], {
      E2E_BASE_URL: BASE, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonFile,
    });
  }
  if (!existsSync(jsonFile)) return { status: 'fail', evidence: 'not run: no result file', json: null, ran: false };
  let json: unknown = null;
  try { json = JSON.parse(readFileSync(jsonFile, 'utf8')); } catch { /* unparsable counts as empty -> fail */ }
  const s = summarizePlaywright(json);
  return {
    status: playwrightStatus(s),
    evidence: `passed ${s.expected}, failed ${s.unexpected}, flaky ${s.flaky}, skipped ${s.skipped} (${files.join(', ')})`,
    json, ran: true,
  };
}
const pw = (id: string, gate: string, rubric: string, files: string[]) => {
  const r = playwright(id, files);
  add(id, gate, rubric, r.status, r.evidence);
  return r;
};

/** Command gate: runs `fn` (live) or reads Gn.cmd.json (read-only). Missing => FAIL not run. */
function cmdGate(id: string, gate: string, rubric: string, fn: () => { ok: boolean | 'pending'; evidence: string }) {
  const f = join(OUT, `${id}.cmd.json`);
  let r: { ok: boolean | 'pending'; evidence: string } | null = null;
  if (READ_ONLY) {
    if (existsSync(f)) { try { r = JSON.parse(readFileSync(f, 'utf8')); } catch { r = null; } }
  } else {
    r = fn();
    writeFileSync(f, JSON.stringify(r));
  }
  if (!r) { results.push(missingResultGate(id, gate, rubric)); return; }
  add(id, gate, rubric, r.ok === 'pending' ? 'pending' : r.ok === true ? 'pass' : 'fail', r.evidence);
}

const GATE_SPECS = new Set(['i18n-browser.spec.ts', 'perf.spec.ts', 'a11y.spec.ts', 'resilience.spec.ts', 'pwa.spec.ts', 'security.spec.ts', 'chat-replay.spec.ts']);
const JOURNEY_SPECS = readdirSync(join(ROOT, 'tests', 'e2e', 'mobile-app'))
  .filter((f) => f.endsWith('.spec.ts') && !GATE_SPECS.has(f));
const WEB = join(ROOT, 'apps', 'web-next');

cmdGate('G1', 'All CI green on main (Quality Gates)', '§8.6, §8.1(8)', () => {
  const r = sh('gh', ['run', 'list', '--branch', 'main', '--workflow', 'ci.yml', '--limit', '1', '--json', 'conclusion,headSha', '--jq', '.[0].conclusion + " " + .[0].headSha']);
  return { ok: r.out.startsWith('success'), evidence: tail(r.out, 120) };
});
cmdGate('G2', 'Unit, component, API-client, route, invariant, offline-queue suites', '§8.1(1)-(5)', () => {
  const r = sh('npx', ['vitest', 'run', 'src/__tests__/app', 'src/__tests__/api/mobile', 'src/__tests__/architecture'], {}, WEB);
  return { ok: r.code === 0, evidence: tail(r.out, 200) };
});
cmdGate('G3', 'i18n parity/wiring + no hardcoded English in /app', '§8.1(6)', () => {
  const r = sh('npx', ['vitest', 'run', 'src/__tests__/architecture/mobile-app-i18n.test.ts', 'src/__tests__/architecture/i18n-catalog.test.ts', 'src/__tests__/architecture/i18n-shell-wiring.test.ts', 'src/__tests__/architecture/i18n-french-quality.test.ts', 'src/__tests__/app/mobile/chat-i18n.test.ts'], {}, WEB);
  return { ok: r.code === 0, evidence: tail(r.out, 200) };
});
pw('G4', 'fr-CA and zh-CN render in a real browser (4 screens)', '§8.1(6)', ['i18n-browser.spec.ts']);
{
  const r = playwright('G5', JOURNEY_SPECS);
  const per = personaBreakdown(r.json);
  const perText = ['maya', 'alex', 'sydney', 'fresh'].map((p) => `${p} ${per[p]?.passed ?? 0}✓/${per[p]?.failed ?? 0}✗`).join(', ');
  const allPersonas = ['maya', 'alex', 'sydney', 'fresh'].every((p) => (per[p]?.passed ?? 0) > 0 && (per[p]?.failed ?? 0) === 0);
  add('G5', 'E2E journeys 100% on the deployment, all four personas', '§8.1(7), §8.2', r.status === 'pass' && allPersonas ? 'pass' : 'fail', `${r.evidence}; ${perText}`);
}
{
  // G6: runtime (Slow-4G) + route-JS budget. Both must pass; the budget half is a command result.
  const r = playwright('G6', ['perf.spec.ts']);
  const bf = join(OUT, 'G6.budget.cmd.json');
  let budget: { ok: boolean; evidence: string } | null = null;
  if (READ_ONLY) {
    if (existsSync(bf)) { try { budget = JSON.parse(readFileSync(bf, 'utf8')); } catch { budget = null; } }
  } else {
    const run = sh('gh', ['run', 'list', '--branch', 'main', '--workflow', 'ci.yml', '--limit', '1', '--json', 'databaseId', '--jq', '.[0].databaseId']).out.trim();
    const job = sh('gh', ['run', 'view', run, '--json', 'jobs', '--jq', '.jobs[] | select(.name=="Build") | .databaseId']).out.trim();
    const log = sh('gh', ['run', 'view', run, '--job', job, '--log']).out
      .split('\n').map((l) => (l.split('\t')[2] ?? '').replace(/^[0-9-]+T[0-9:.]+Z /, '')).join('\n');
    const logFile = join(OUT, 'main-build.log');
    writeFileSync(logFile, log);
    const b = sh('node', ['bin/perf-budget.mjs', logFile]);
    budget = { ok: b.code === 0, evidence: tail(b.out.split('=== /app PWA routes')[1] ?? b.out, 300) };
    writeFileSync(bf, JSON.stringify(budget));
  }
  add('G6', 'Perf: Home KPIs ≤ 2.5 s Slow-4G; /app route JS ≤ baseline + 40 kB gz (see K3); Docs CLS/thumbs', '§8.3 Performance',
    r.status === 'pass' && budget?.ok === true ? 'pass' : 'fail',
    `${r.evidence}; budget: ${budget ? budget.evidence : 'not run: no result file'}`);
}
pw('G7', 'A11y: axe 0 serious/critical (light+dark), 44×44, focus, reduced motion', '§8.3 Accessibility', ['a11y.spec.ts']);
pw('G8', 'Resilience: offline, 3 s, 500, 429, empty per screen; zero console errors in journeys', '§8.3 Resilience', ['resilience.spec.ts']);
pw('G9', 'PWA: manifest/installable, SW update reaches stale clients', '§8.3 PWA', ['pwa.spec.ts']);
pw('G10', 'Security: cross-tenant 404, unauth 401, upload type/size', '§8.3 Security, §7', ['security.spec.ts']);
pw('G11', 'Chat transcript replay (no reviewer-rule regressions)', '§8.1(7d), §8.4', ['chat-replay.spec.ts']);
cmdGate('G12', 'Zero open P0/P1', '§8.6', () => {
  const labels = sh('gh', ['label', 'list', '--limit', '200', '--json', 'name', '--jq', '[.[].name] | join(",")']).out;
  if (!/\bP0\b/.test(labels) || !/\bP1\b/.test(labels)) {
    return { ok: 'pending', evidence: 'repo has no P0/P1 labels: triage open issues manually and record here' };
  }
  const n = (l: string) => Number(sh('gh', ['issue', 'list', '--state', 'open', '--label', l, '--json', 'number', '--jq', 'length']).out.trim() || 'NaN');
  const p0 = n('P0'); const p1 = n('P1');
  return { ok: p0 === 0 && p1 === 0, evidence: `open P0=${p0}, P1=${p1}` };
});
// G13 — manual device pass. Only a human ticks these boxes.
const device = existsSync(CHECKLIST) ? checklistStatus(readFileSync(CHECKLIST, 'utf8')) : { status: 'pending' as const, done: 0, total: 0 };
add('G13', 'Manual device pass (iOS Safari + Android Chrome)', '§8.6', device.status, `${device.done}/${device.total} checks ticked in docs/superpowers/reports/2026-10-mobile-device-pass.md`);

let overrides: ReturnType<typeof parseOverrides> = [];
try { overrides = parseOverrides(JSON.parse(readFileSync(OVERRIDES, 'utf8'))); } catch { /* reported as "no overrides recorded" */ }
const commit = READ_ONLY ? '(read-only mode)' : sh('git', ['rev-parse', 'origin/main']).out.trim();
mkdirSync(dirname(REPORT), { recursive: true });
writeFileSync(REPORT, renderReport(results, {
  base: BASE, commit, runAt: new Date().toISOString(), knownLimitations: knownLimitations(overrides, device),
}));
console.log(readFileSync(REPORT, 'utf8'));
process.exit(verdict(results) === 'GO' ? 0 : 1);
