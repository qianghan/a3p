import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/client.js', () => {
  const model = new Proxy({}, { get: (_t, m) => async () => (String(m) === 'findMany' ? [] : String(m) === 'count' ? 0 : null) });
  return { db: new Proxy({}, { get: () => model }) };
});

import { triageTurn } from '../consultation-triage.js';
import { reconcileSkills } from '../skill-source.js';
import { classifyOnly } from '../server';
import { BUILT_IN_SKILLS } from '../built-in-skills';

/**
 * PR 3d.3 — record-bill / pay-bill / query-payables reached through the REAL
 * consultation triage (a question-shaped phrasing goes to the advisor unless
 * a DATA_QUESTION pattern claims it, #653/#656) and the real classifier, in
 * en / fr-CA / zh-CN. Run twice: code-only order (fresh tenant, unseeded
 * manifests appended after the DB rows) and the prod DB order (name asc),
 * so neither ordering lets record-expense or manage-bills steal a bill turn.
 * Channel parity: web, telegram and mcp all route identically.
 */
const codeOrder = reconcileSkills([] as any[]);
const dbOrder = reconcileSkills(
  [...BUILT_IN_SKILLS].sort((a: any, b: any) => a.name.localeCompare(b.name))
    .map((s: any) => ({ ...s, id: s.name, tenantId: null, source: 'built_in', enabled: true })),
);
/** Prod right after deploy, before seed-skills: the new manifests are code-only, appended AFTER every DB row. */
const NEW = new Set(['record-bill', 'pay-bill', 'query-payables']);
const unseededOrder = reconcileSkills(
  [...BUILT_IN_SKILLS].filter((s: any) => !NEW.has(s.name)).sort((a: any, b: any) => a.name.localeCompare(b.name))
    .map((s: any) => ({ ...s, id: s.name, tenantId: null, source: 'built_in', enabled: true })),
);

const CASES: Array<[string, string]> = [
  // record-bill
  ['Add a bill from Hydro One $84.50 due Dec 15', 'record-bill'],
  ['Record a bill from Staples for $230 due in 30 days', 'record-bill'],
  ['add a $800 rent bill due Friday', 'record-bill'],
  ['Can you record a bill from Telus $95 due 2026-12-20?', 'record-bill'],
  ['Ajouter une facture fournisseur de Bell 120 $ échéance 15 décembre', 'record-bill'],
  ['Enregistrer une facture à payer de Hydro-Québec 84 $', 'record-bill'],
  ['记录一笔来自电力公司的账单 300 元，12月15日到期', 'record-bill'],
  ['添加账单 Telstra 89 元 周五到期', 'record-bill'],
  // pay-bill
  ['Pay the Hydro One bill', 'pay-bill'],
  ['Paid the Staples bill $100', 'pay-bill'],
  ['Mark the Telus bill as paid', 'pay-bill'],
  ['Can you pay the rent bill?', 'pay-bill'],
  ['Payer la facture fournisseur de Bell', 'pay-bill'],
  ['J’ai réglé la facture à payer de Hydro-Québec', 'pay-bill'],
  ['支付 Telstra 的账单', 'pay-bill'],
  ['电费账单已付', 'pay-bill'],
  // query-payables
  ['What bills are due this week?', 'query-payables'],
  ['Which bills are due?', 'query-payables'],
  ['What is my accounts payable?', 'query-payables'],
  ['Any overdue bills?', 'query-payables'],
  ['Show my unpaid bills', 'query-payables'],
  ['Who do I owe?', 'query-payables'],
  ['Quelles factures à payer sont en retard ?', 'query-payables'],
  ['Quels sont mes comptes fournisseurs ?', 'query-payables'],
  ['Combien je dois à mes fournisseurs ?', 'query-payables'],
  ['我的应付账款是多少？', 'query-payables'],
  ['哪些账单快到期了？', 'query-payables'],
  ['有逾期账单吗？', 'query-payables'],
];

/** Must NOT become a bill skill. */
const NOT_BILLS: Array<[string, string | null]> = [
  ['Spent $45 on lunch at Subway', 'record-expense'],
  ['Paid $120 for printer ink', 'record-expense'],
  ['Acme paid the invoice', null],
  ['how much will I owe in taxes this quarter?', null],
  ['Bill Acme $500 for consulting', null],
];

for (const [label, skills] of [['code order', codeOrder], ['db order', dbOrder], ['prod unseeded', unseededOrder]] as const) {
  describe(`bill skills route through triage + classifier (${label})`, () => {
    for (const [text, want] of CASES) {
      it(text, async () => {
        expect(triageTurn(text).kind).toBe('transactional');
        for (const ch of ['web', 'telegram', 'mcp']) {
          const cls = await classifyOnly(text, 't1', ch, [], [], skills, [], {});
          expect([ch, cls?.selectedSkill?.name]).toEqual([ch, want]);
        }
      });
    }
    for (const [text, want] of NOT_BILLS) {
      it(`not a bill: ${text}`, async () => {
        const cls = await classifyOnly(text, 't1', 'web', [], [], skills, [], {});
        const name = cls?.selectedSkill?.name;
        expect(['record-bill', 'pay-bill', 'query-payables']).not.toContain(name);
        if (want) expect(name).toBe(want);
      });
    }
  });
}

const ADVISOR = ['What is accounts payable?', 'How do bills work in accrual accounting?', 'Qu’est-ce qu’un compte fournisseur ?', '什么是应付账款的定义？'];
describe('definition questions stay with the advisor', () => {
  for (const text of ADVISOR) it(text, () => expect(triageTurn(text).kind).toBe('consultative'));
});

describe('manifests', () => {
  it('record-bill, pay-bill, query-payables precede general-question; manage-bills kept', () => {
    const names = BUILT_IN_SKILLS.map((s: any) => s.name);
    const gq = names.indexOf('general-question');
    for (const n of ['record-bill', 'pay-bill', 'query-payables', 'manage-bills']) {
      expect(names.indexOf(n)).toBeGreaterThan(-1);
      expect(names.indexOf(n)).toBeLessThan(gq);
    }
  });
});
