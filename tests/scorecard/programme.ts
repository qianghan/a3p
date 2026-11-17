/**
 * Programme scorecard: is the WHOLE bills / tax-codes / inventory / payroll scope delivered?
 * Run from the repo root:
 *   npx tsx tests/scorecard/programme.ts [--phase pre|post] [--base URL] [--out FILE]
 *
 *   pre  (default)  scope + traceability checks, runs every test file the PR manifests map to a
 *                   requirement, reads each PR's committed post-deploy report for its verdict.
 *   post            also runs the cross-PR prod journeys (tests/e2e/programme/*) on --base.
 * Reads docs/superpowers/scorecards/programme.json; writes
 * docs/superpowers/reports/scorecards/programme-<phase>.md.
 * Exit 0 only on COMPLETE; 2 when the programme definition itself is broken.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { runPlaywright, runVitest, sh } from './exec';
import type { GateStatus } from './lib';
import {
  parseVerdict, programmeVerdict, renderProgramme, requirementStatus, traceability, validateProgramme,
  type CoveringManifest, type Programme, type ProgrammeResult, type PrVerdict,
} from './programme-lib';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*\n|^ \* ?/gm, ''));
  process.exit(0);
}
const opt = (n: string) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : undefined; };
const ROOT = process.cwd();
if (!existsSync(join(ROOT, 'apps', 'web-next'))) throw new Error('run from the repo root');
const PHASE = opt('--phase') ?? 'pre';
if (PHASE !== 'pre' && PHASE !== 'post') throw new Error('--phase must be pre or post');
const BASE = opt('--base') ?? 'https://agentbook.brainliber.com';
const RESULTS = join(ROOT, 'tests', 'scorecard', 'results');
mkdirSync(RESULTS, { recursive: true });

const exists = (p: string) => existsSync(join(ROOT, p));
const read = (p: string) => (exists(p) ? readFileSync(join(ROOT, p), 'utf8') : null);
const p = JSON.parse(readFileSync(join(ROOT, 'docs/superpowers/scorecards/programme.json'), 'utf8')) as Programme;
const scopeErrors = validateProgramme(p, read(p.spec) ?? '', read(p.plan) ?? '', exists);

const manifests: Record<string, CoveringManifest | null> = {};
const verdicts: Record<string, PrVerdict> = {};
const trace: ProgrammeResult['trace'] = {};
for (const pr of p.prs) {
  const raw = read(pr.manifest);
  manifests[pr.id] = raw ? (JSON.parse(raw) as CoveringManifest) : null;
  verdicts[pr.id] = parseVerdict(read(`docs/superpowers/reports/scorecards/${pr.id}-post.md`));
  trace[pr.id] = traceability(p, pr, manifests[pr.id]);
}

// Every test file any covering goal names, run once, strictly.
const files = [...new Set(Object.values(manifests).flatMap((m) => (m?.goals ?? []).filter((g) => g.covers?.length).flatMap((g) => g.tests)))].filter(exists);
const tests = files.length ? runVitest(ROOT, files, join(RESULTS, 'programme.requirements')) : { total: 0, passed: 0, failed: 0, skipped: 0, files: {} };

const journeys: Record<string, GateStatus> = {};
for (const j of p.journeys) {
  if (PHASE !== 'post' || !exists(j.spec)) { journeys[j.id] = 'pending'; continue; }
  const cfg = j.spec.startsWith('tests/e2e/mobile-app/') ? 'tests/e2e/mobile-app/playwright.config.ts' : 'tests/e2e/programme/playwright.config.ts';
  journeys[j.id] = runPlaywright(ROOT, [j.spec], join(RESULTS, `programme.${j.id}.json`), cfg, BASE).status;
}

const reqs: ProgrammeResult['reqs'] = {};
for (const r of p.requirements) reqs[r.id] = requirementStatus(r, { manifests, verdicts, tests, journeys, programme: p });
const result: ProgrammeResult = { scopeErrors, trace, reqs, ownerOpen: p.ownerCalls.filter((c) => !c.confirmed).map((c) => c.id) };

const commit = sh('git', ['rev-parse', '--short', 'HEAD'], ROOT).out.trim();
const report = renderProgramme(p, result, verdicts, { commit, runAt: new Date().toISOString(), phase: PHASE });
const out = resolve(opt('--out') ?? join(ROOT, 'docs', 'superpowers', 'reports', 'scorecards', `programme-${PHASE}.md`));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, report);
const v = programmeVerdict(result);
console.log(report);
console.log(`\nVerdict: ${v}  (report: ${relative(ROOT, out)})`);
process.exit(v === 'COMPLETE' ? 0 : v === 'BROKEN' ? 2 : 1);
