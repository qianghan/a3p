import { describe, it, expect } from 'vitest';
import {
  summarizeVitest, strictStatus, goalGate, regressionGate, touchedGate, docsGate, ciGate, checklistStatus,
  validateManifest, verdict, acceptGate, type VitestSummary, parseTsc, tscGate, renderReport, type Gate, type Manifest,
} from '../../../../../tests/scorecard/lib';

const report = (files: Record<string, string[]>) => ({
  testResults: Object.entries(files).map(([name, st]) => ({ name, assertionResults: st.map((status) => ({ status })) })),
});
const gate = (status: Gate['status'], phase: Gate['phase'] = 'pre'): Gate => ({ id: 'X', group: 'F', phase, name: 'n', rubric: 'r', status, evidence: 'e' });

describe('summarizeVitest / strictStatus', () => {
  it('counts passed, failed and every non-pass status as skipped', () => {
    const s = summarizeVitest(report({ '/r/a.test.ts': ['passed', 'failed', 'pending', 'todo', 'skipped'] }));
    expect(s).toMatchObject({ total: 5, passed: 1, failed: 1, skipped: 3 });
  });
  it('an empty or unparsable report is zero tests and therefore a FAIL', () => {
    expect(strictStatus(summarizeVitest(null))).toBe('fail');
    expect(strictStatus(summarizeVitest({}))).toBe('fail');
  });
  it('skipped alone fails (deterministic or not a gate)', () => {
    expect(strictStatus(summarizeVitest(report({ a: ['passed', 'skipped'] })))).toBe('fail');
    expect(strictStatus(summarizeVitest(report({ a: ['passed', 'passed'] })))).toBe('pass');
  });
});

describe('goalGate — traceability from a design goal to a passing test file', () => {
  const goal = { id: 'G1', text: 't', tests: ['src/x/a.test.ts', 'src/x/b.test.ts'] };
  it('passes only when every mapped file ran, with tests, none failed or skipped', () => {
    const ok = summarizeVitest(report({ '/abs/src/x/a.test.ts': ['passed'], '/abs/src/x/b.test.ts': ['passed', 'passed'] }));
    expect(goalGate(goal, ok)).toMatchObject({ status: 'pass', evidence: expect.stringContaining('3 tests') });
  });
  it('a mapped file that did not run is a failure naming the file', () => {
    const r = goalGate(goal, summarizeVitest(report({ '/abs/src/x/a.test.ts': ['passed'] })));
    expect(r.status).toBe('fail');
    expect(r.evidence).toContain('src/x/b.test.ts: not run');
  });
  it('zero-test, failed and skipped files each fail with their own reason', () => {
    expect(goalGate(goal, summarizeVitest(report({ '/a/src/x/a.test.ts': [], '/a/src/x/b.test.ts': ['passed'] }))).evidence).toContain('zero tests');
    expect(goalGate(goal, summarizeVitest(report({ '/a/src/x/a.test.ts': ['failed'], '/a/src/x/b.test.ts': ['passed'] }))).evidence).toContain('1 failed');
    expect(goalGate(goal, summarizeVitest(report({ '/a/src/x/a.test.ts': ['passed', 'todo'], '/a/src/x/b.test.ts': ['passed'] }))).evidence).toContain('1 skipped');
  });
  it('matches on a path boundary: a different dir or a glued prefix is "not run"', () => {
    const g = { id: 'G', text: 't', tests: ['src/x/a.test.ts'] };
    expect(goalGate(g, summarizeVitest(report({ '/abs/src/y/a.test.ts': ['passed'] }))).evidence).toContain('not run');
    expect(goalGate(g, summarizeVitest(report({ '/abs/xsrc/x/a.test.ts': ['passed'] }))).evidence).toContain('not run');
    expect(goalGate(g, summarizeVitest(report({ '/abs/src/x/a.test.ts': ['passed'] }))).status).toBe('pass');
  });
});

describe('regressionGate — the floor only moves the safe way', () => {
  const base = { total: 100, skipped: 2 };
  it('passes at or above the floor', () => expect(regressionGate({ total: 101, passed: 99, failed: 0, skipped: 2, files: {} }, base).status).toBe('pass'));
  it('fails on any failure', () => expect(regressionGate({ total: 100, passed: 97, failed: 1, skipped: 2, files: {} }, base).status).toBe('fail'));
  it('fails when tests disappear', () => expect(regressionGate({ total: 99, passed: 97, failed: 0, skipped: 2, files: {} }, base).evidence).toContain('shrank'));
  it('DB-integration failures are deferred only when no database is available, and only for listed files', () => {
    const b = { ...base, dbIntegration: ['src/lib/db.test.ts'] };
    const s = { total: 100, passed: 98, failed: 2, skipped: 2, files: { '/a/src/lib/db.test.ts': { passed: 0, failed: 2, skipped: 0 } } };
    expect(regressionGate(s, b, false)).toMatchObject({ status: 'pass', evidence: expect.stringContaining('deferred to CI Shell Tests') });
    expect(regressionGate(s, b, true).status).toBe('fail'); // with a DB they must pass
    const other = { ...s, files: { '/a/src/lib/other.test.ts': { passed: 0, failed: 2, skipped: 0 } } };
    expect(regressionGate(other, b, false).status).toBe('fail'); // unlisted file is never excused
  });
  it('fails when skips grow', () => expect(regressionGate({ total: 100, passed: 97, failed: 0, skipped: 3, files: {} }, base).evidence).toContain('skips grew'));
});

describe('touchedGate / ciGate / checklistStatus', () => {
  it('requires every declared doc to be in the diff, directories by prefix', () => {
    expect(touchedGate(['CLAUDE.md', 'agentbook/skills/workflows.md'], ['CLAUDE.md']).status).toBe('pass');
    expect(touchedGate(['a.ts'], ['CLAUDE.md']).evidence).toContain('CLAUDE.md');
    expect(touchedGate(['docs/x/y.md'], ['docs/x']).status).toBe('pass');
    expect(touchedGate(['docs/xy/y.md'], ['docs/x']).status).toBe('fail');
  });
  it('CI: required checks must exist; fail beats pending beats pass', () => {
    expect(ciGate([{ name: 'Quality Gates', bucket: 'pass' }]).status).toBe('fail'); // CodeQL, Shell Tests absent
    const both = [{ name: 'Quality Gates', bucket: 'pass' }, { name: 'CodeQL', bucket: 'pass' }, { name: 'Shell Tests', bucket: 'pass' }];
    expect(ciGate(both).status).toBe('pass');
    expect(ciGate([...both, { name: 'x', bucket: 'pending' }]).status).toBe('pending');
    expect(ciGate([...both, { name: 'x', bucket: 'fail' }, { name: 'y', bucket: 'pending' }]).status).toBe('fail');
  });
  it('checklist is pending until every box is ticked, and an empty checklist is not a pass', () => {
    expect(checklistStatus('- [x] a\n- [ ] b').status).toBe('pending');
    expect(checklistStatus('- [x] a\n- [X] b').status).toBe('pass');
    expect(checklistStatus('no boxes').status).toBe('pending');
  });
});

describe('parseTsc / tscGate — no new type errors', () => {
  const out = [
    "src/a.ts(1,2): error TS2322: x", "src/a.ts(9,1): error TS2322: y",
    "../../plugins/p/server.ts(3,4): error TS7030: z", "noise line", "src/ok.ts: not an error",
  ].join('\n');
  it('keys errors by repo-root path, resolving ../ from apps/web-next', () => {
    expect(parseTsc(out)).toEqual({ 'apps/web-next/src/a.ts': 2, 'plugins/p/server.ts': 1 });
  });
  it('passes at baseline, passes when a file improves, fails when any file gets worse or a new file errs', () => {
    const base = { 'apps/web-next/src/a.ts': 2, 'plugins/p/server.ts': 1 };
    expect(tscGate(parseTsc(out), base).status).toBe('pass');
    expect(tscGate({ 'apps/web-next/src/a.ts': 1 }, base).status).toBe('pass');
    expect(tscGate({ 'apps/web-next/src/a.ts': 3 }, base).evidence).toContain('a.ts (3 > 2)');
    expect(tscGate({ 'apps/web-next/src/new.ts': 1 }, base).status).toBe('fail');
    expect(tscGate({}, base).status).toBe('pass');
  });
});

describe('validateManifest', () => {
  const ok: Manifest = {
    id: 'pr1', title: 'T',
    goals: [{ id: 'G1', text: 'goal', tests: ['t/a.test.ts'] }],
    ux: { checklist: 'c.md', playwright: ['e/ux.spec.ts'] },
    launch: { docs: ['CLAUDE.md'], rollback: 'revert the PR', prodPlaywright: ['e/prod.spec.ts'] },
  };
  const all = () => true;
  it('accepts a complete manifest', () => expect(validateManifest(ok, all)).toEqual([]));
  it('rejects a goal with no test, a duplicate goal id, and missing files', () => {
    const bad = { ...ok, goals: [{ id: 'G1', text: 'x', tests: [] }, { id: 'G1', text: '', tests: ['nope.ts'] }] };
    const e = validateManifest(bad, (p) => p !== 'nope.ts').join('|');
    expect(e).toContain('no test file maps to it');
    expect(e).toContain('duplicated');
    expect(e).toContain('text missing');
    expect(e).toContain('not found: nope.ts');
  });
  it('checks that a declared post-deploy checklist exists', () => {
    const m = { ...ok, ux: { ...ok.ux, postChecklist: 'missing.md' } };
    expect(validateManifest(m, (p) => p !== 'missing.md').join('|')).toContain('ux.postChecklist not found');
  });
  it('requires a rollback statement, docs and a prod e2e', () => {
    const e = validateManifest({ ...ok, launch: { docs: [], rollback: ' ', prodPlaywright: [] } }, all).join('|');
    expect(e).toContain('rollback');
    expect(e).toContain('docs');
    expect(e).toContain('prodPlaywright');
  });
  const reason = 'Schema-only PR: no docs changed at all.';
  it('accepts docsNone with a reason in place of docs', () => {
    expect(validateManifest({ ...ok, launch: { docsNone: reason, rollback: 'r', prodPlaywright: ['e/prod.spec.ts'] } }, all)).toEqual([]);
  });
  it('rejects both docs and docsNone, neither, and a short reason', () => {
    const l = { rollback: 'r', prodPlaywright: ['e/prod.spec.ts'] };
    expect(validateManifest({ ...ok, launch: { ...l, docs: ['CLAUDE.md'], docsNone: reason } }, all).join('|')).toContain('mutually exclusive');
    expect(validateManifest({ ...ok, launch: { ...l } }, all).join('|')).toContain('launch.docs');
    expect(validateManifest({ ...ok, launch: { ...l, docsNone: 'too short' } }, all).join('|')).toContain('20 characters');
  });
  it('docsGate passes docsNone with the reason as evidence', () => {
    const g = docsGate([], { docsNone: reason, rollback: 'r', prodPlaywright: [] });
    expect(g.status).toBe('pass');
    expect(g.evidence).toBe(`no docs changed: ${reason}`);
  });
});

describe('verdict / renderReport', () => {
  it('pre ignores post gates; post needs everything', () => {
    expect(verdict('pre', [gate('pass'), gate('fail', 'post')])).toBe('MERGE-READY');
    expect(verdict('post', [gate('pass'), gate('fail', 'post')])).toBe('NO-GO');
    expect(verdict('post', [gate('pass'), gate('pass', 'post')])).toBe('LAUNCH-READY');
  });
  it('pending and fail both mean NO-GO; no gates is NO-GO', () => {
    expect(verdict('pre', [gate('pass'), gate('pending')])).toBe('NO-GO');
    expect(verdict('pre', [])).toBe('NO-GO');
  });
  it('escapes pipes and backslashes so a hostile evidence string cannot split a row', () => {
    const md = renderReport({ id: 'p', title: 'T' }, 'pre', [{ ...gate('fail'), evidence: 'a|b\\' }], { commit: 'abc', runAt: 'now' });
    const row = md.split('\n').find((l) => l.startsWith('| X'))!;
    expect(row.match(/(?<!\\)\|/g)!.length).toBe(6); // 5 columns + trailing = 6 unescaped pipes
    expect(md).toContain('**Verdict: NO-GO**');
  });
});

describe('acceptGate — auditable accepted gate for load-timeout failures', () => {
  const acc = { reason: 'x'.repeat(40), approvedBy: 'user' };
  const raw = { status: 'fail' as const, evidence: '1 failed' };
  const sum = (msg: string, file = '/r/apps/web-next/src/a.test.ts'): VitestSummary => ({ total: 10, passed: 9, failed: 1, skipped: 0, files: { [file]: { passed: 0, failed: 1, skipped: 0, failureMessages: [msg] } } });
  const okRun = () => ({ total: 3, passed: 3, failed: 0, skipped: 0, files: {} });
  const badRun = () => ({ total: 3, passed: 2, failed: 1, skipped: 0, files: {} });
  const timeout = 'Error: Test timed out in 5000ms';

  it('all conditions met -> accepted, verdict passes, rendered ACCEPTED', () => {
    const r = acceptGate(raw, acc, sum(timeout), ['other.ts'], okRun);
    expect(r.status).toBe('accepted');
    const g: Gate = { ...gate('accepted'), ...r };
    expect(verdict('pre', [g])).toBe('MERGE-READY');
    expect(renderReport({ id: 'p', title: 'T' }, 'pre', [g], { commit: 'a', runAt: 'n' })).toContain('ACCEPTED');
  });
  it('non-timeout failure stays FAIL', () => expect(acceptGate(raw, acc, sum('expected 1 to be 2'), [], okRun).evidence).toContain('non-timeout'));
  it('failing file changed by the PR stays FAIL', () => {
    const r = acceptGate(raw, acc, sum(timeout), ['apps/web-next/src/a.test.ts'], okRun);
    expect(r.status).toBe('fail'); expect(r.evidence).toContain('changed by this PR');
  });
  it('isolation re-run failure stays FAIL', () => expect(acceptGate(raw, acc, sum(timeout), [], badRun).evidence).toContain('isolation re-run failed'));
  it('no acceptance entry, or a raw PASS, is untouched', () => {
    expect(acceptGate(raw, undefined, sum(timeout), [], okRun).status).toBe('fail');
    expect(acceptGate({ status: 'pass', evidence: 'ok' }, acc, sum(timeout), [], badRun).status).toBe('pass');
  });
  it('validateManifest: only R2/R3 and reason >= 40 chars', () => {
    const m: Manifest = { id: 'p', title: 'T', goals: [{ id: 'G', text: 't', tests: ['a'] }], ux: { checklist: 'c' }, launch: { docs: ['d'], rollback: 'r', prodPlaywright: ['e'] } };
    const a = { reason: 'x'.repeat(40), isolationEvidence: 'ok', approvedBy: 'u' };
    expect(validateManifest({ ...m, acceptedGates: { R3: a, R2: a } }, () => true)).toEqual([]);
    expect(validateManifest({ ...m, acceptedGates: { L1: a } }, () => true).join()).toContain('only R3/R2');
    expect(validateManifest({ ...m, acceptedGates: { R3: { ...a, reason: 'short' } } }, () => true).join()).toContain('40 characters');
  });
});
