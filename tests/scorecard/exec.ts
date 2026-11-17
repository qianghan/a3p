/** Process helpers shared by the per-PR (run.ts) and programme (programme.ts) scorecards. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { summarizeVitest, type Gate, type VitestSummary } from './lib';

export function sh(cmd: string, a: string[], cwd: string, env: Record<string, string> = {}) {
  const r = spawnSync(cmd, a, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Nearest ancestor directory holding a vitest config: the workspace a test file must be run from. */
export function vitestRoot(root: string, file: string): string {
  let d = dirname(join(root, file));
  while (d.startsWith(root) && d !== root) {
    if (['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js'].some((c) => existsSync(join(d, c)))) return d;
    d = dirname(d);
  }
  return root;
}

/** Runs files grouped by workspace; `outBase` + an index names each JSON report. */
export function runVitest(root: string, files: string[], outBase: string): VitestSummary {
  const byRoot = new Map<string, string[]>();
  for (const f of files) byRoot.set(vitestRoot(root, f), [...(byRoot.get(vitestRoot(root, f)) ?? []), f]);
  const merged: VitestSummary = { total: 0, passed: 0, failed: 0, skipped: 0, files: {} };
  let i = 0;
  for (const [wsRoot, fs] of byRoot) {
    const out = `${outBase}.${i++}.json`;
    sh('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${out}`, ...fs.map((f) => relative(wsRoot, join(root, f)))], wsRoot, { NODE_OPTIONS: '--max-old-space-size=4096' });
    if (!existsSync(out)) continue; // nothing ran: every file reads "not run" and fails
    const s = summarizeVitest(JSON.parse(readFileSync(out, 'utf8')));
    merged.total += s.total; merged.passed += s.passed; merged.failed += s.failed; merged.skipped += s.skipped;
    Object.assign(merged.files, s.files);
  }
  return merged;
}

const playwrightSummary = (j: unknown) => { const s = ((j as { stats?: Record<string, number> } | null)?.stats ?? {}); return { expected: s.expected ?? 0, unexpected: s.unexpected ?? 0, flaky: s.flaky ?? 0, skipped: s.skipped ?? 0 }; };

/** Prod Playwright run; skipped, flaky or zero tests fail. */
export function runPlaywright(root: string, files: string[], out: string, config: string, base: string): Pick<Gate, 'status' | 'evidence'> {
  sh('npx', ['playwright', 'test', `--config=${config}`, ...files, '--reporter=json'], root, { E2E_BASE_URL: base, PLAYWRIGHT_JSON_OUTPUT_NAME: out });
  if (!existsSync(out)) return { status: 'fail', evidence: 'not run: no result file' };
  let j: unknown = null; try { j = JSON.parse(readFileSync(out, 'utf8')); } catch { /* empty => fail */ }
  const s = playwrightSummary(j);
  const ok = s.expected > 0 && s.unexpected === 0 && s.flaky === 0 && s.skipped === 0;
  return { status: ok ? 'pass' : 'fail', evidence: `passed ${s.expected}, failed ${s.unexpected}, flaky ${s.flaky}, skipped ${s.skipped}` };
}
