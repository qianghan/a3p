import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizePlaywright, playwrightStatus, checklistStatus, verdict, renderReport, personaBreakdown,
  knownLimitations, parseOverrides, missingResultGate, type GateResult,
} from './scorecard-lib';

test('playwright summary: only clean runs pass', () => {
  assert.equal(playwrightStatus(summarizePlaywright({ stats: { expected: 10, unexpected: 0, flaky: 0, skipped: 0 } })), 'pass');
  assert.equal(playwrightStatus(summarizePlaywright({ stats: { expected: 9, unexpected: 1, flaky: 0, skipped: 0 } })), 'fail');
  assert.equal(playwrightStatus(summarizePlaywright({ stats: { expected: 9, unexpected: 0, flaky: 1, skipped: 0 } })), 'fail');
  assert.equal(playwrightStatus(summarizePlaywright({ stats: { expected: 9, unexpected: 0, flaky: 0, skipped: 1 } })), 'fail');
  assert.equal(playwrightStatus(summarizePlaywright({ stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 } })), 'fail');
  assert.equal(playwrightStatus(summarizePlaywright(null)), 'fail');
});

test('missing result file is FAIL (not run), never pass', () => {
  const g = missingResultGate('G7', 'a11y', '§8.3');
  assert.equal(g.status, 'fail');
  assert.match(g.evidence, /not run/);
});

test('checklist: pending until every box is ticked', () => {
  assert.deepEqual(checklistStatus('- [x] a\n- [ ] b\n'), { status: 'pending', done: 1, total: 2 });
  assert.deepEqual(checklistStatus('- [x] a\n- [X] b\n'), { status: 'pass', done: 2, total: 2 });
  assert.deepEqual(checklistStatus('no boxes'), { status: 'pending', done: 0, total: 0 });
});

test('verdict: GO only when every gate passes', () => {
  const g = (status: GateResult['status']): GateResult => ({ id: 'x', gate: 'g', rubric: 'r', status, evidence: '' });
  assert.equal(verdict([g('pass'), g('pass')]), 'GO');
  assert.equal(verdict([g('pass'), g('pending')]), 'NO-GO');
  assert.equal(verdict([g('pass'), g('fail')]), 'NO-GO');
  assert.equal(verdict([]), 'NO-GO');
});

test('persona breakdown reads matrix describe titles', () => {
  const json = { suites: [{ title: 'matrix.spec.ts', suites: [
    { title: 'matrix — maya', specs: [{ tests: [{ results: [{ status: 'passed' }] }] }] },
    { title: 'matrix — alex', specs: [{ tests: [{ results: [{ status: 'failed' }] }] }] },
  ] }] };
  assert.deepEqual(personaBreakdown(json), { maya: { passed: 1, failed: 0 }, alex: { passed: 0, failed: 1 } });
});

test('report: table escapes pipes and states the verdict', () => {
  const md = renderReport(
    [{ id: 'G1', gate: 'CI', rubric: '§8.6', status: 'pass', evidence: 'a | b' }],
    { base: 'https://x', commit: 'abc', runAt: '2026-10-20T00:00:00Z' },
  );
  assert.match(md, /\| G1 \| CI \| §8\.6 \| PASS \| a \\\| b \|/);
  assert.match(md, /\*\*Verdict: GO\*\*/);
});

test('overrides are parsed from the json, ignoring _comment', () => {
  const o = parseOverrides({ _comment: 'x', '/app': { allowanceKb: 60, reason: 'why A' }, '/app/chat': { allowanceKb: 52, reason: 'why B' } });
  assert.deepEqual(o, [
    { route: '/app', allowanceKb: 60, reason: 'why A' },
    { route: '/app/chat', allowanceKb: 52, reason: 'why B' },
  ]);
  assert.deepEqual(parseOverrides(null), []);
});

test('known limitations: always rendered, do not change the verdict, overrides printed from data', () => {
  const overrides = parseOverrides({ '/app': { allowanceKb: 60, reason: 'REASON-FROM-FILE' } });
  const lims = knownLimitations(overrides, { status: 'pending', done: 0, total: 11 });
  assert.equal(lims.length, 4);
  const md = renderReport(
    [{ id: 'G1', gate: 'CI', rubric: 'r', status: 'pass', evidence: '' }],
    { base: 'b', commit: 'c', runAt: 't', knownLimitations: lims },
  );
  assert.match(md, /## Known limitations/);
  assert.match(md, /CA\$25/);
  assert.match(md, /twice in one bubble/);
  assert.match(md, /REASON-FROM-FILE/);
  assert.match(md, /NOT YET DONE/);
  // Known issues are disclosures: they do not by themselves flip the verdict either way.
  assert.match(md, /\*\*Verdict: GO\*\*/);
});

test('device-pass limitation reads DONE only when every box is ticked', () => {
  const done = knownLimitations([], { status: 'pass', done: 5, total: 5 }).find((l) => l.id === 'K4')!;
  assert.doesNotMatch(done.text, /NOT YET DONE/);
  const open = knownLimitations([], { status: 'pending', done: 1, total: 5 }).find((l) => l.id === 'K4')!;
  assert.match(open.text, /NOT YET DONE/);
});
