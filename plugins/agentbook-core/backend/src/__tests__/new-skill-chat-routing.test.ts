import { describe, it, expect, vi } from 'vitest';

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


/**
 * Prod finding (PR 5A): Maya (fr-CA, trackInventory on) asked
 * "Qu’est-ce qui est bas en stock ?" and the consultative advisor answered
 * "je n'ai pas d'informations sur les stocks" — query-stock was never reached.
 * Same cause as #653: triageTurn runs first and sends "…?" / "What is…" to the
 * advisor unless a DATA_QUESTION pattern claims it. This audits every skill
 * added in the PR 4e / 5A programme through the real pipeline.
 */
const NEW_SKILLS: Array<[string, string]> = [
  // restatement-preview / restatement-apply (PR 2c)
  ['Preview the tax restatement for 2026', 'restatement-preview'],
  ['What would restating my 2026 purchases change?', 'restatement-preview'],
  ['How much GST would the restatement move?', 'restatement-preview'],
  ['Restate my GST for 2026', 'restatement-apply'],
  ['Apply the restatement for 2026', 'restatement-apply'],
  ['Restate my 2025–2026 purchases', 'restatement-apply'],
  ['Preview the restatement for FY2025-26', 'restatement-preview'],
  ['Aperçu du retraitement de la TPS pour 2026', 'restatement-preview'],
  ['Que changerait le retraitement de 2026 ?', 'restatement-preview'],
  ['Retraiter ma TPS pour 2026', 'restatement-apply'],
  ['Appliquer le retraitement pour 2026', 'restatement-apply'],
  ['预览 2026 年的重述', 'restatement-preview'],
  ['重述会改变多少？', 'restatement-preview'],
  ['重述 2026 年的 GST', 'restatement-apply'],
  ['应用重述', 'restatement-apply'],
  // query-cogs (PR 5B)
  ["What's my COGS this quarter?", 'query-cogs'],
  ['What is my cost of goods sold this year?', 'query-cogs'],
  ['How much was cost of sales last quarter?', 'query-cogs'],
  ['Quel est mon coût des marchandises vendues ce trimestre ?', 'query-cogs'],
  ['Quels sont mes coûts des marchandises vendues cette année ?', 'query-cogs'],
  ['本季度的销售成本是多少？', 'query-cogs'],
  ['今年销货成本多少？', 'query-cogs'],
  // query-stock (PR 5A)
  ['Qu’est-ce qui est bas en stock ?', 'query-stock'],
  ["Qu'est-ce qui est en rupture de stock ?", 'query-stock'],
  ['Quelle est la valeur de mon inventaire ?', 'query-stock'],
  ['Combien de stock disponible pour les tasses ?', 'query-stock'],
  ['Quels articles dois-je commander à nouveau ?', 'query-stock'],
  ['What is low on stock?', 'query-stock'],
  ['What is low in stock?', 'query-stock'],
  ["What's out of stock?", 'query-stock'],
  ['What is my stock on hand?', 'query-stock'],
  ['What is my inventory worth?', 'query-stock'],
  ['What is the total inventory value?', 'query-stock'],
  ['How many mugs do I have left?', 'query-stock'],
  ['How many mugs do I have in stock?', 'query-stock'],
  ['What should I reorder?', 'query-stock'],
  ['Which items are running low?', 'query-stock'],
  ['哪些商品库存不足？', 'query-stock'],
  ['什么缺货了？', 'query-stock'],
  ['低库存的有哪些？', 'query-stock'],
  ['杯子还有多少库存？', 'query-stock'],
  ['库存价值是多少？', 'query-stock'],
  // query-employee / update-employee / generate-pay-run-drafts (PR 4e)
  ["What is Jane's pay frequency?", 'query-employee'],
  ['Quelle est la fréquence de paie de Jane ?', 'query-employee'],
  ['Jane 的发薪频率是什么？', 'query-employee'],
  ["Can you change Jane to weekly?", 'update-employee'],
  ["Could you set Jane's rate to $60k?", 'update-employee'],
  ['Can you set up the next pay runs?', 'generate-pay-run-drafts'],
  ['Generate draft pay runs?', 'generate-pay-run-drafts'],
  // manage-bills (bills / payables)
  ['What bills are due this week?', 'manage-bills'],
  ['Which bills are due?', 'manage-bills'],
  ['What is my accounts payable?', 'manage-bills'],
  ['Any overdue bills?', 'manage-bills'],
  // record-expense with tax-inclusive amounts
  ['Bought a printer $113 incl GST', 'record-expense'],
  ['Staples $56.50 incl HST', 'record-expense'],
];

const REGRESSION: Array<[string, string]> = [
  ['How much did I pay Shell?', 'triage-only'],
  ['Acme paid the invoice', 'triage-only'],
  ['run payroll', 'run-payroll'],
  ['who is on payroll?', 'payroll-status'],
  ['how many employees do I have', 'payroll-status'],
  ['what is my tax estimate?', 'triage-only'],
  ['how much did I spend on travel last month?', 'triage-only'],
];

const ADVISOR = [
  'What is a capital gain?',
  'What is the difference between FIFO and weighted average cost?',
  'Should I track inventory?',
  'Est-ce que je devrais suivre mon inventaire ?',
  'What is a T4?',
  'How does GST work?',
  '什么是资本利得？',
];

describe('new-skill questions reach their skill through the real pipeline', () => {
  for (const [text, want] of NEW_SKILLS) {
    it(text, async () => {
      expect(await route(text)).toEqual({ triage: 'transactional', skill: want });
    });
  }
});

describe('existing intents keep their skill', () => {
  for (const [text, want] of REGRESSION) {
    it(text, async () => {
      const r = await route(text);
      expect(r.triage).toBe('transactional');
      expect(r.skill).not.toBe('query-stock');
      if (want !== 'triage-only') expect(r.skill).toBe(want);
    });
  }
});

describe('rule/concept questions still go to the advisor', () => {
  for (const text of ADVISOR) {
    it(text, () => {
      expect(triageTurn(text).kind).toBe('consultative');
    });
  }
});
