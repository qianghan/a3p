// Versioned eval set for the nightly real-LLM agent-realism suite.
// Changes require explanation in commit message. See spec §6.2.
//
// Each utterance represents a real user phrase the agent must handle well.
// The runner sends each utterance through POST /agent/message and asserts:
//   - The expected skill was invoked (intent accuracy)
//   - `required` strings appear in the response (correctness signal)
//   - `forbidden` strings do NOT appear (hallucination guard)
//
// IDs are stable so a regression in cu-maya-001 is traceable across runs.
// Personas mirror the seed data: maya (CA consultant), alex (US agency),
// jordan (side-hustle).

export type Persona = 'maya' | 'alex' | 'jordan';

export interface CanonicalUtterance {
  id: string;          // stable: cu-maya-001
  persona: Persona;
  text: string;
  category: 'bookkeeping' | 'invoicing' | 'tax' | 'budget' | 'consultation' | 'onboarding';
  expectedSkill?: string;       // which skill SHOULD be invoked
  forbidden?: string[];          // strings the agent must NOT say
  required?: string[];           // strings the agent MUST include
  isMultiTurn?: boolean;         // if true, this is part of a thread
  threadId?: string;             // groups multi-turn utterances
}

export const CANONICAL: CanonicalUtterance[] = [
  // ============================================================
  // BOOKKEEPING — record expenses, query expenses, scan receipts
  // ============================================================
  {
    id: 'cu-maya-001',
    persona: 'maya',
    text: 'Spent $42 at Starbucks for client meeting today',
    category: 'bookkeeping',
    expectedSkill: 'record-expense',
    required: ['$42', 'Starbucks'],
    forbidden: ['error', 'sorry'],
  },
  {
    id: 'cu-maya-002',
    persona: 'maya',
    text: 'lunch with client glg yesterday $87',
    category: 'bookkeeping',
    expectedSkill: 'record-expense',
    required: ['$87'],
  },
  {
    id: 'cu-maya-003',
    persona: 'maya',
    text: 'how much did I spend on travel last month?',
    category: 'bookkeeping',
    expectedSkill: 'query-expenses',
    forbidden: ['NaN', 'undefined'],
  },
  {
    id: 'cu-alex-001',
    persona: 'alex',
    text: 'paid AWS $1240 for hosting',
    category: 'bookkeeping',
    expectedSkill: 'record-expense',
    required: ['$1,240'],
  },
  {
    id: 'cu-alex-002',
    persona: 'alex',
    text: 'show me top 5 vendors this quarter',
    category: 'bookkeeping',
    expectedSkill: 'vendor-insights',
  },
  {
    id: 'cu-jordan-001',
    persona: 'jordan',
    text: 'bought new monitor for $349 from Best Buy',
    category: 'bookkeeping',
    expectedSkill: 'record-expense',
    required: ['$349'],
  },
  {
    id: 'cu-jordan-002',
    persona: 'jordan',
    text: 'categorize my uncategorized expenses',
    category: 'bookkeeping',
    expectedSkill: 'categorize-expenses',
  },

  // ============================================================
  // INVOICING — create invoices, payments, estimates, timers
  // ============================================================
  {
    id: 'cu-maya-010',
    persona: 'maya',
    text: 'invoice TechCorp $5000 for January consulting',
    category: 'invoicing',
    expectedSkill: 'create-invoice',
    required: ['TechCorp', '$5,000'],
  },
  {
    id: 'cu-maya-011',
    persona: 'maya',
    text: 'estimate Acme $3000 for the new project',
    category: 'invoicing',
    expectedSkill: 'create-invoice',
  },
  {
    id: 'cu-maya-012',
    persona: 'maya',
    text: 'start timer for TechCorp project',
    category: 'invoicing',
    expectedSkill: 'create-invoice',
  },
  {
    id: 'cu-alex-010',
    persona: 'alex',
    text: 'got $7500 payment from BigCo',
    category: 'invoicing',
    expectedSkill: 'create-invoice',
    required: ['$7,500'],
  },
  {
    id: 'cu-alex-011',
    persona: 'alex',
    text: 'who owes me money?',
    category: 'invoicing',
    expectedSkill: 'query-finance',
    forbidden: ['NaN', 'undefined'],
  },

  // ============================================================
  // TAX — quarterly estimates, deductions, scenarios
  // ============================================================
  {
    id: 'cu-maya-020',
    persona: 'maya',
    text: 'how much will I owe in taxes this quarter?',
    category: 'tax',
    expectedSkill: 'query-finance',
    forbidden: ['NaN%', '2500%'],
  },
  {
    id: 'cu-maya-021',
    persona: 'maya',
    text: 'what deductions can I still claim for last year?',
    category: 'tax',
    expectedSkill: 'general-question',
  },
  {
    id: 'cu-alex-020',
    persona: 'alex',
    text: 'simulate raising my rate by 20%',
    category: 'tax',
    expectedSkill: 'simulate-scenario',
  },
  {
    id: 'cu-jordan-020',
    persona: 'jordan',
    text: 'what is my effective tax rate?',
    category: 'tax',
    expectedSkill: 'query-finance',
    forbidden: ['NaN%', 'undefined'],
  },

  // ============================================================
  // BUDGET / ADVISOR — runway, burn, alerts, recurring
  // ============================================================
  {
    id: 'cu-maya-030',
    persona: 'maya',
    text: 'what is my monthly burn?',
    category: 'budget',
    expectedSkill: 'query-finance',
    forbidden: ['NaN', 'undefined'],
  },
  {
    id: 'cu-maya-031',
    persona: 'maya',
    text: 'any alerts for me today?',
    category: 'budget',
    expectedSkill: 'proactive-alerts',
  },
  {
    id: 'cu-alex-030',
    persona: 'alex',
    text: 'show me a breakdown of my expenses',
    category: 'budget',
    expectedSkill: 'expense-breakdown',
  },
  {
    id: 'cu-alex-031',
    persona: 'alex',
    text: 'what subscriptions should I cancel?',
    category: 'budget',
    expectedSkill: 'manage-recurring',
  },

  // ============================================================
  // CONSULTATION — general Q&A, education
  // ============================================================
  {
    id: 'cu-maya-040',
    persona: 'maya',
    text: 'what counts as a business meal deduction?',
    category: 'consultation',
    expectedSkill: 'general-question',
  },
  {
    id: 'cu-maya-041',
    persona: 'maya',
    text: 'do I need to register for GST?',
    category: 'consultation',
    expectedSkill: 'general-question',
  },
  {
    id: 'cu-jordan-040',
    persona: 'jordan',
    text: 'should I incorporate?',
    category: 'consultation',
    expectedSkill: 'general-question',
  },
  {
    id: 'cu-jordan-041',
    persona: 'jordan',
    text: 'what is depreciation?',
    category: 'consultation',
    expectedSkill: 'general-question',
  },

  // ============================================================
  // MULTI-TURN — corrections, follow-ups, refinements
  // ============================================================
  {
    id: 'cu-maya-050a',
    persona: 'maya',
    text: 'lunch at Tim Hortons today $15',
    category: 'bookkeeping',
    expectedSkill: 'record-expense',
    isMultiTurn: true,
    threadId: 't-maya-tim-hortons',
  },
  {
    id: 'cu-maya-050b',
    persona: 'maya',
    text: 'no, that should be Travel category not Meals',
    category: 'bookkeeping',
    expectedSkill: 'edit-expense',
    isMultiTurn: true,
    threadId: 't-maya-tim-hortons',
    required: ['Travel'],
  },
  {
    id: 'cu-alex-050a',
    persona: 'alex',
    text: 'invoice BigCo $4000',
    category: 'invoicing',
    expectedSkill: 'create-invoice',
    isMultiTurn: true,
    threadId: 't-alex-bigco',
  },
  {
    id: 'cu-alex-050b',
    persona: 'alex',
    text: 'and add a line for $500 consulting',
    category: 'invoicing',
    isMultiTurn: true,
    threadId: 't-alex-bigco',
  },

  // ============================================================
  // ONBOARDING — agent-driven setup conversations
  // ============================================================
  {
    id: 'cu-onboard-001',
    persona: 'jordan',
    text: 'I want to set up my account',
    category: 'onboarding',
    expectedSkill: 'general-question',
  },
  {
    id: 'cu-onboard-002',
    persona: 'maya',
    text: 'I am a consultant in Toronto',
    category: 'onboarding',
    expectedSkill: 'general-question',
  },
];
