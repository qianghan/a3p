import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  specScope, planPrs, validateProgramme, traceability, parseVerdict, requirementStatus, programmeVerdict, renderProgramme,
  type Programme, type CoveringManifest, type ReqContext, type ProgrammeResult,
} from '../../../../../tests/scorecard/programme-lib';
import type { VitestSummary } from '../../../../../tests/scorecard/lib';

const SPEC = ['Goals', '- G1. Bills on the books.', '- G2. Tax codes.', '', 'Non-goals (v1)', '- not this', '', 'Anti-goals', '- A second expense row.', '- Double-counting AP.', '', '## 3. Constraints', '- x'].join('\n');
const PLAN = ['## PR 1 — one', 'x', '## PR 2a — two', '## PR 4 — employees', '## Cross-cutting acceptance'].join('\n');
const yes = () => true;

const prog = (over: Partial<Programme> = {}): Programme => ({
  spec: 's.md', plan: 'p.md',
  findings: [{ id: 'T1', text: 'unpaid bill', requirements: ['R1'] }],
  requirements: [
    { id: 'R1', spec: ['G1', 'A1'], text: 'bill on books', markets: ['us', 'au'], prs: ['pr1'] },
    { id: 'R2', spec: ['G2', 'A2'], text: 'tax', markets: ['au'], prs: ['pr2a', 'pr4a'], journeys: ['J1'] },
  ],
  prs: [{ id: 'pr1', plan: '1', manifest: 'm1.json' }, { id: 'pr2a', plan: '2a', manifest: 'm2.json' }, { id: 'pr4a', plan: '4a', manifest: 'm4.json' }],
  journeys: [{ id: 'J1', spec: 'j.spec.ts', personas: ['sydney'], requirements: ['R2'] }],
  ownerCalls: [{ id: 'O1', text: 'call', confirmed: true }],
  ...over,
});
const manifest = (covers: Record<string, string[]>, tests = ['src/a.test.ts']): CoveringManifest => ({
  id: 'm', title: 't', ux: { checklist: 'c.md' }, launch: { docs: [], rollback: 'r', prodPlaywright: [] },
  goals: Object.entries(covers).map(([id, c]) => ({ id, text: 't', tests, covers: c })),
});
const summary = (files: Record<string, [number, number, number]>): VitestSummary => {
  const s: VitestSummary = { total: 0, passed: 0, failed: 0, skipped: 0, files: {} };
  for (const [f, [p, fa, sk]] of Object.entries(files)) { s.files[`/abs/${f}`] = { passed: p, failed: fa, skipped: sk }; s.passed += p; s.failed += fa; s.skipped += sk; s.total += p + fa + sk; }
  return s;
};

describe('specScope / planPrs — scope is read from the documents, not retyped', () => {
  it('reads goal ids and numbers the anti-goal bullets in order, ignoring non-goals', () => {
    expect(specScope(SPEC)).toEqual({ goals: ['G1', 'G2'], antiGoals: ['A1', 'A2'] });
  });
  it('lists plan PR headings but not other level-2 headings', () => {
    expect(planPrs(PLAN)).toEqual(['1', '2a', '4']);
  });
});

describe('validateProgramme — nothing in scope may be unaccounted for', () => {
  it('a complete definition has no errors', () => {
    expect(validateProgramme(prog(), SPEC, PLAN, yes)).toEqual([]);
  });
  it('a spec goal or anti-goal no requirement covers is an error', () => {
    const p = prog({ requirements: [{ ...prog().requirements[0], spec: ['G1'] }, prog().requirements[1]] });
    expect(validateProgramme(p, SPEC, PLAN, yes)).toContain('spec A1 is not covered by any requirement');
  });
  it('a finding with no requirement, or an unknown one, is an error', () => {
    expect(validateProgramme(prog({ findings: [{ id: 'T1', text: 'x', requirements: [] }] }), SPEC, PLAN, yes)).toContain('finding T1 maps to no requirement');
    expect(validateProgramme(prog({ findings: [{ id: 'T1', text: 'x', requirements: ['R9'] }] }), SPEC, PLAN, yes)).toContain('finding T1: unknown requirement R9');
  });
  it('a plan PR with no programme entry, and a programme PR delivering nothing, are errors', () => {
    const p = prog({ prs: [...prog().prs.filter((x) => x.id !== 'pr2a'), { id: 'idle', plan: '9', manifest: 'x' }] });
    const e = validateProgramme(p, SPEC, PLAN, yes);
    expect(e).toContain('plan PR 2a has no programme entry');
    expect(e).toContain('PR idle delivers no requirement');
    expect(e).toContain('requirement R2: unknown PR pr2a');
  });
  it('a sub-lettered programme PR (4a) satisfies a plan heading (PR 4)', () => {
    expect(validateProgramme(prog(), SPEC, PLAN, yes).some((x) => x.includes('plan PR 4'))).toBe(false);
  });
  it('unknown journeys/personas, no markets, duplicate ids and missing files are errors', () => {
    const p = prog({
      requirements: [...prog().requirements, { id: 'R1', spec: [], text: 'dup', markets: [], prs: ['pr1'], journeys: ['J9'] }],
      journeys: [{ id: 'J1', spec: 'j', personas: ['bob'], requirements: ['R1'] }],
    });
    const e = validateProgramme(p, SPEC, PLAN, (f) => f !== 'p.md');
    expect(e).toEqual(expect.arrayContaining([
      'requirement id duplicated: R1', 'requirement R1 names no market', 'requirement R1: unknown journey J9',
      'journey J1: unknown persona bob', 'file not found: p.md',
    ]));
  });
  it('an empty spec (wrong path) cannot validate vacuously', () => {
    expect(validateProgramme(prog(), '', PLAN, yes)).toContain('spec has no "- G1." goals (wrong spec path?)');
  });
});

describe('traceability — a PR manifest covers exactly what the programme assigns it', () => {
  const p = prog();
  it('no manifest yet is pending, never a pass', () => {
    expect(traceability(p, p.prs[0], null).status).toBe('pending');
  });
  it('passes when its goals cover every assigned requirement', () => {
    expect(traceability(p, p.prs[0], manifest({ G1: ['R1'] })).status).toBe('pass');
  });
  it('fails on an uncovered requirement and on covering one not assigned to it', () => {
    expect(traceability(p, p.prs[0], manifest({ G1: [] }))).toMatchObject({ status: 'fail', evidence: 'uncovered: R1' });
    expect(traceability(p, p.prs[0], manifest({ G1: ['R1', 'R2'] }))).toMatchObject({ status: 'fail', evidence: 'not assigned to this PR: R2' });
  });
});

describe('parseVerdict', () => {
  it('reads the verdict run.ts writes; no report is NOT STARTED; an unreadable one is NO-GO', () => {
    expect(parseVerdict('x\n**Verdict: LAUNCH-READY**\n')).toBe('LAUNCH-READY');
    expect(parseVerdict(null)).toBe('NOT STARTED');
    expect(parseVerdict('garbage')).toBe('NO-GO');
  });
});

describe('requirementStatus — delivered only when the whole chain holds', () => {
  const p = prog();
  const ctx = (over: Partial<ReqContext> = {}): ReqContext => ({
    programme: p,
    manifests: { pr1: manifest({ G1: ['R1'] }), pr2a: manifest({ G: ['R2'] }), pr4a: manifest({ G: ['R2'] }) },
    verdicts: { pr1: 'LAUNCH-READY', pr2a: 'LAUNCH-READY', pr4a: 'LAUNCH-READY' },
    tests: summary({ 'src/a.test.ts': [3, 0, 0] }),
    journeys: { J1: 'pass' },
    ...over,
  });
  it('delivered: covered, tests green, PR launch-ready, prod evidence in every market', () => {
    expect(requirementStatus(p.requirements[0], ctx())).toMatchObject({ status: 'delivered', reasons: [], markets: ['us', 'au'] });
    expect(requirementStatus(p.requirements[1], ctx())).toMatchObject({ status: 'delivered', markets: ['au'] });
  });
  it('not started when no PR behind it has a manifest or a report', () => {
    const r = requirementStatus(p.requirements[0], ctx({ manifests: { pr1: null }, verdicts: {} }));
    expect(r.status).toBe('not-started');
    expect(r.reasons).toContain('pr1: no manifest');
  });
  it('merged but not launch-ready keeps it in progress', () => {
    const r = requirementStatus(p.requirements[0], ctx({ verdicts: { pr1: 'NO-GO' } }));
    expect(r.status).toBe('in-progress');
    expect(r.reasons).toEqual(expect.arrayContaining(['pr1: NO-GO', 'no prod evidence in: us, au']));
  });
  it('a failing, skipped or missing covering test blocks delivery', () => {
    expect(requirementStatus(p.requirements[0], ctx({ tests: summary({ 'src/a.test.ts': [2, 1, 0] }) })).status).toBe('in-progress');
    expect(requirementStatus(p.requirements[0], ctx({ tests: summary({ 'src/a.test.ts': [2, 0, 1] }) })).status).toBe('in-progress');
    expect(requirementStatus(p.requirements[0], ctx({ tests: summary({}) })).reasons.join()).toContain('not run');
  });
  it('one of several PRs not delivered blocks it', () => {
    expect(requirementStatus(p.requirements[1], ctx({ verdicts: { pr2a: 'LAUNCH-READY', pr4a: 'MERGE-READY' } })).reasons).toContain('pr4a: MERGE-READY');
  });
  it('a journey that has not run or failed blocks it, and its markets are not evidenced', () => {
    const r = requirementStatus(p.requirements[1], ctx({ journeys: {} }));
    expect(r.reasons).toEqual(expect.arrayContaining(['journey J1: not run', 'no prod evidence in: au']));
    expect(requirementStatus(p.requirements[1], ctx({ journeys: { J1: 'fail' } })).reasons).toContain('journey J1: failed');
  });
  it('a journey that misses one of the requirement\'s markets leaves a market gap', () => {
    const p2 = prog({ journeys: [{ id: 'J1', spec: 'j', personas: ['alex'], requirements: ['R2'] }] });
    expect(requirementStatus(p2.requirements[1], ctx({ programme: p2 })).reasons).toContain('no prod evidence in: au');
  });
});

describe('programmeVerdict', () => {
  const base = (): ProgrammeResult => ({ scopeErrors: [], trace: { pr1: { status: 'pass', evidence: '' } }, reqs: { R1: { status: 'delivered', reasons: [], markets: [] } }, ownerOpen: [] });
  it('COMPLETE only when everything is delivered, traced and every owner call confirmed', () => {
    expect(programmeVerdict(base())).toBe('COMPLETE');
    expect(programmeVerdict({ ...base(), ownerOpen: ['O1'] })).toBe('IN PROGRESS');
    expect(programmeVerdict({ ...base(), reqs: { R1: { status: 'in-progress', reasons: ['x'], markets: [] } } })).toBe('IN PROGRESS');
    expect(programmeVerdict({ ...base(), trace: { pr1: { status: 'pending', evidence: '' } } })).toBe('IN PROGRESS');
    expect(programmeVerdict({ ...base(), reqs: {} })).toBe('IN PROGRESS');
  });
  it('BROKEN when the definition is incomplete or a manifest contradicts it', () => {
    expect(programmeVerdict({ ...base(), scopeErrors: ['x'] })).toBe('BROKEN');
    expect(programmeVerdict({ ...base(), trace: { pr1: { status: 'fail', evidence: '' } } })).toBe('BROKEN');
  });
  it('the report rolls a finding up from its requirements and shows the count', () => {
    const md = renderProgramme(prog(), { ...base(), reqs: { R1: { status: 'delivered', reasons: [], markets: ['us'] } } }, { pr1: 'LAUNCH-READY' }, { commit: 'abc', runAt: 'now', phase: 'pre' });
    expect(md).toContain('1/2 requirements delivered');
    expect(md).toMatch(/\| T1 \| unpaid bill \| R1 \| DELIVERED \|/);
    expect(md).toMatch(/\| R2 .*NOT STARTED/);
  });
});

describe('the real programme definition', () => {
  const root = join(__dirname, '../../../../..');
  const p = JSON.parse(readFileSync(join(root, 'docs/superpowers/scorecards/programme.json'), 'utf8')) as Programme;
  const read = (f: string) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : '');

  it('covers all seven tester findings', () => {
    expect(p.findings.map((f) => f.id)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']);
  });
  it('is internally consistent; against the spec and plan once they are on this branch', () => {
    const onBranch = existsSync(join(root, p.spec)) && existsSync(join(root, p.plan));
    const errors = validateProgramme(p, read(p.spec), read(p.plan), (f) => existsSync(join(root, f)));
    // Before the spec PR lands only the spec-derived checks may fail; everything else must already hold.
    const specDerived = (e: string) => /^spec |^plan PR |^file not found: docs\/superpowers\/(specs|plans)\//.test(e);
    expect(onBranch ? errors : errors.filter((e) => !specDerived(e))).toEqual([]);
  });
  it('every existing PR manifest covers exactly its assigned requirements', () => {
    for (const pr of p.prs) {
      if (!existsSync(join(root, pr.manifest))) continue;
      const m = JSON.parse(read(pr.manifest)) as CoveringManifest;
      expect(traceability(p, pr, m), pr.id).toMatchObject({ status: 'pass' });
    }
  });
});
