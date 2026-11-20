import { describe, it, expect, vi } from 'vitest';

/**
 * Prod finding (PR 4e e2e, real LLM): "What is <tag> Chatworker's pay frequency?"
 * was answered by the consultative advisor ("I can't tell you about specific pay
 * frequencies…"). The skill unit tests called selectSkillByPatterns directly; the
 * real pipeline runs triageTurn FIRST, and an English question ending in "?" (or
 * opening "What is"), every French "…?" and every Chinese "…？" was triaged
 * consultative, so query-employee was never reached.
 *
 * These go through the real triage, the real reconcileSkills(BUILT_IN_SKILLS)
 * and the real classifyOnly (shortcuts → regex), with only the DB and LLM stubbed.
 */
vi.mock('../db/client.js', () => {
  // Any model, any method: reads return nothing. Routing must not depend on rows.
  const model = new Proxy({}, { get: (_t, m) => async () => (String(m) === 'findMany' ? [] : String(m) === 'count' ? 0 : null) });
  return { db: new Proxy({}, { get: () => model }) };
});

import { triageTurn } from '../consultation-triage.js';
import { reconcileSkills } from '../skill-source.js';
import { classifyOnly } from '../server';

const skills = reconcileSkills([] as any[]);
const route = async (text: string) => {
  const triage = triageTurn(text);
  const cls = await classifyOnly(text, 't1', 'web', [], [], skills, [], {});
  return { triage: triage.kind, skill: cls?.selectedSkill?.name };
};

const TAG = 'E2EEMPCHAT7F3K2Q Chatworker';
const EMPLOYEE: Array<[string, string]> = [
  [`What is ${TAG}'s pay frequency?`, 'query-employee'],
  [`What's Jane's pay frequency?`, 'query-employee'],
  [`whats Jane's pay rate?`, 'query-employee'],
  ['How often do I pay Jane?', 'query-employee'],
  ['How often is Jane paid?', 'query-employee'],
  ['Is Jane paid fortnightly?', 'query-employee'],
  ['When is Jane paid next?', 'query-employee'],
  ['List my employees', 'query-employee'],
  ['Show me my employees?', 'query-employee'],
  [`Change ${TAG} to weekly`, 'update-employee'],
  [`Set ${TAG}'s rate to $60k`, 'update-employee'],
  ['change Jane to weekly', 'update-employee'],
  ["set Jane's rate to $60k", 'update-employee'],
  ['Quelle est la fréquence de paie de Jane ?', 'query-employee'],
  ['À quelle fréquence Jane est-elle payée ?', 'query-employee'],
  ['Liste mes employés', 'query-employee'],
  ['Jane 的发薪频率是什么？', 'query-employee'],
  ['Jane 多久发一次工资？', 'query-employee'],
  ['列出我的员工', 'query-employee'],
];

const REGRESSION: Array<[string, string]> = [
  ['How much did I pay Shell?', 'triage-only'],
  ['run payroll', 'run-payroll'],
  ['who is on payroll?', 'payroll-status'],
  ['how many employees do I have', 'payroll-status'],
  ['Acme paid the invoice', 'triage-only'],
  ['paid Shell $40 for gas', 'triage-only'],
  ['工资到账 5000 元', 'triage-only'],
  ['员工餐 50 元', 'triage-only'],
  ['set my monthly budget to $500', 'triage-only'],
  ['what is my tax estimate?', 'triage-only'],
];

describe('employee intents reach the employee skills through the real pipeline', () => {
  for (const [text, want] of EMPLOYEE) {
    it(text, async () => {
      expect(await route(text)).toEqual({ triage: 'transactional', skill: want });
    });
  }
});

describe('existing intents keep their skill', () => {
  for (const [text, want] of REGRESSION) {
    it(text, async () => {
      const r = await route(text);
      // No LLM here: these rely on the classifier stage, so only their triage is pinned.
      if (want !== 'triage-only') expect(r.skill).toBe(want);
      if (want !== 'triage-only') expect(r.skill).not.toMatch(/employee/);
      else expect(r.skill).not.toMatch(/employee/);
      expect(r.triage).toBe('transactional');
    });
  }
  it('advice about employees stays consultative', () => {
    expect(triageTurn('Should I hire an employee or a contractor?').kind).toBe('consultative');
  });
});

describe('LLM classifier sees the employee skills', () => {
  it('the reconciled list (what classifyOnly builds its prompt from) carries both, with examples', () => {
    for (const n of ['query-employee', 'update-employee']) expect(skills.some((s: any) => s.name === n)).toBe(true);
    expect(skills.find((s: any) => s.name === 'query-employee').description).toMatch(/pay frequency.*Jane/s);
  });
});
