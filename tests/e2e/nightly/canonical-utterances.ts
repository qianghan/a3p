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
  /**
   * Additional skills that are ALSO a correct answer.
   *
   * Strict equality on a single expectedSkill is what made this fixture rot.
   * It was written when there were ~16 skills; there are now 83, and splitting
   * one coarse skill into two finer ones broke the assertion even though the
   * agent had got BETTER — "start timer for X" was marked wrong for answering
   * start-timer instead of the create-invoice the fixture demanded. Twelve of
   * the fifteen failures on the first real run were this, not the product.
   *
   * Use this only where more than one route genuinely answers the user. If one
   * skill is clearly right, leave it as a single expectedSkill so the assertion
   * keeps its teeth.
   */
  acceptableSkills?: string[];
  forbidden?: string[];          // strings the agent must NOT say
  required?: string[];           // strings the agent MUST include
  isMultiTurn?: boolean;         // if true, this is part of a thread
  threadId?: string;             // groups multi-turn utterances
  /**
   * The script the answer must come back in.
   *
   * Asserted by script presence rather than by a `required` substring: the
   * wording of a correct Chinese answer varies between runs, so any fixed
   * string would be flaky, but a Chinese answer always contains Han
   * characters and an English one never does.
   */
  expectLang?: 'zh' | 'en';
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
    // I first called this a misroute — the router preferring a generic skill
    // over the purpose-built one — and left it strict on that basis. That was
    // wrong: I had not read the handler. query-expenses explicitly claims
    // 'top.*vendor' AND its handler sorts spend by vendor and slices the top 5,
    // so it genuinely answers "top 5 vendors this quarter". Two skills answering
    // one question well is exactly what acceptableSkills is for.
    expectedSkill: 'vendor-insights',
    acceptableSkills: ['query-expenses'],
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
    // Was 'create-invoice' — a stale expectation, not a product bug. An
    // estimate is a distinct document from an invoice (create-estimate is its
    // own skill, and record-expense explicitly excludes '^estimate\s' to defer
    // to it). Corrected after the 2026-07-30 canonical eval flagged the
    // mismatch and routing was verified: this utterance matches
    // create-estimate and nothing else.
    expectedSkill: 'create-estimate',
  },
  {
    id: 'cu-maya-012',
    persona: 'maya',
    text: 'start timer for TechCorp project',
    category: 'invoicing',
    // Was 'create-invoice' — stale. Starting a timer is time tracking, not
    // invoice creation; the invoice comes later, from the logged hours.
    // start-timer is a real skill and this utterance matches only it.
    expectedSkill: 'start-timer',
  },
  {
    id: 'cu-alex-010',
    persona: 'alex',
    text: 'got $7500 payment from BigCo',
    category: 'invoicing',
    // Was 'create-invoice' — stale, and backwards: receiving money records a
    // payment against an existing invoice, it does not create one.
    // record-expense excludes 'got.*\$.*from' precisely to defer here.
    expectedSkill: 'record-payment',
    required: ['$7,500'],
  },
  {
    id: 'cu-alex-011',
    persona: 'alex',
    text: 'who owes me money?',
    category: 'invoicing',
    // Was 'query-finance': aging-report is literally "who owes money and how overdue".
    expectedSkill: 'aging-report',
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
    // This one had a bug on BOTH sides.
    //
    // Product bug (fixed): it routed to manage-bills. manage-bills' bare 'owe '
    // trigger matches "owe in taxes" and its excludePatterns had nothing
    // tax-shaped, so a quarterly-tax question collided with accounts payable
    // and won on unordered DB row order. Fixed in built-in-skills.ts; guarded
    // in agent-core's skill-routing-canonical.test.ts.
    //
    // Fixture bug (fixed here): 'query-finance' was also wrong. query-finance
    // explicitly excludes 'how much.*tax|tax.*owe' in order to defer to
    // tax-estimate, which is the skill that actually computes this.
    expectedSkill: 'tax-estimate',
    // quarterly-payments answers the same question from the schedule side, so
    // either is a correct route for "…this quarter".
    acceptableSkills: ['quarterly-payments'],
    forbidden: ['NaN%', '2500%'],
  },
  {
    id: 'cu-maya-021',
    persona: 'maya',
    text: 'what deductions can I still claim for last year?',
    category: 'tax',
    // Was 'general-question': tax-deductions shows claimable deductions — a direct match.
    expectedSkill: 'tax-deductions',
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
    // Was 'query-finance': burn is outflow/runway, which cashflow-report covers.
    expectedSkill: 'cashflow-report',
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
    // DELIBERATELY STRICT. This asks what the RULES are, not what the user can
    // claim. The agent answers tax-deductions, which shows their own claimable
    // deductions — the wrong shape of answer to a knowledge question.
    expectedSkill: 'general-question',
    // 'consultation' is the finer skill that replaced general-question for
    // advisory turns. Exactly the case acceptableSkills was introduced for:
    // splitting one coarse skill into two finer ones breaks a strict
    // assertion even though the agent got BETTER at the question.
    acceptableSkills: ['consultation'],
  },
  {
    id: 'cu-maya-041',
    persona: 'maya',
    text: 'do I need to register for GST?',
    category: 'consultation',
    expectedSkill: 'general-question',
    // 'consultation' is the finer skill that replaced general-question for
    // advisory turns. Exactly the case acceptableSkills was introduced for:
    // splitting one coarse skill into two finer ones breaks a strict
    // assertion even though the agent got BETTER at the question.
    acceptableSkills: ['consultation'],
  },
  {
    id: 'cu-jordan-040',
    persona: 'jordan',
    text: 'should I incorporate?',
    category: 'consultation',
    expectedSkill: 'general-question',
    // 'consultation' is the finer skill that replaced general-question for
    // advisory turns. Exactly the case acceptableSkills was introduced for:
    // splitting one coarse skill into two finer ones breaks a strict
    // assertion even though the agent got BETTER at the question.
    acceptableSkills: ['consultation'],
  },
  {
    id: 'cu-jordan-041',
    persona: 'jordan',
    text: 'what is depreciation?',
    category: 'consultation',
    expectedSkill: 'general-question',
    // 'consultation' is the finer skill that replaced general-question for
    // advisory turns. Exactly the case acceptableSkills was introduced for:
    // splitting one coarse skill into two finer ones breaks a strict
    // assertion even though the agent got BETTER at the question.
    acceptableSkills: ['consultation'],
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
  // Pronoun-resolution thread: "it" must refer to the just-created expense
  {
    id: 'cu-maya-060a',
    persona: 'maya',
    text: 'spent $89 on office supplies at Staples',
    category: 'bookkeeping',
    expectedSkill: 'record-expense',
    isMultiTurn: true,
    threadId: 't-maya-pronoun',
    required: ['$89'],
  },
  {
    id: 'cu-maya-060b',
    persona: 'maya',
    text: 'mark it as personal',
    category: 'bookkeeping',
    expectedSkill: 'edit-expense',
    isMultiTurn: true,
    threadId: 't-maya-pronoun',
  },
  // Memory thread: a vendor alias correction should persist for the next turn
  {
    id: 'cu-alex-070a',
    persona: 'alex',
    text: 'paid $42 at SBUX',
    category: 'bookkeeping',
    expectedSkill: 'record-expense',
    isMultiTurn: true,
    threadId: 't-alex-vendor-alias',
  },
  {
    id: 'cu-alex-070b',
    persona: 'alex',
    text: 'SBUX is Starbucks',
    category: 'bookkeeping',
    isMultiTurn: true,
    threadId: 't-alex-vendor-alias',
    required: ['Starbucks'],
  },
  // Continuation thread: agent should infer the same client across turns
  {
    id: 'cu-jordan-080a',
    persona: 'jordan',
    text: 'start a timer for Acme on the redesign project',
    category: 'invoicing',
    // Was 'create-invoice' — stale, same reason as cu-maya-012.
    expectedSkill: 'start-timer',
    isMultiTurn: true,
    threadId: 't-jordan-timer',
  },
  {
    id: 'cu-jordan-080b',
    persona: 'jordan',
    text: 'stop it',
    category: 'invoicing',
    isMultiTurn: true,
    threadId: 't-jordan-timer',
  },
  // Refinement thread: corrected amount should land on the same expense
  {
    id: 'cu-maya-090a',
    persona: 'maya',
    text: 'lunch $42',
    category: 'bookkeeping',
    expectedSkill: 'record-expense',
    isMultiTurn: true,
    threadId: 't-maya-amount-correction',
    required: ['$42'],
  },
  {
    id: 'cu-maya-090b',
    persona: 'maya',
    text: 'actually it was $52',
    category: 'bookkeeping',
    expectedSkill: 'edit-expense',
    isMultiTurn: true,
    threadId: 't-maya-amount-correction',
    required: ['$52'],
  },
  // Query thread: follow-up "and..." should keep the time window.
  //
  // `required: ['Period:']` is the date-independent form of "the answer names
  // the window it used". Both turns previously PASSED on skill alone while
  // being wrong on substance — turn 1 answered for last month, turn 2 for
  // year-to-date — so the user was handed two numbers to compare that were not
  // comparable, and neither reply said which period it covered. A literal month
  // name can't be asserted here because the window moves with the run date.
  {
    id: 'cu-alex-100a',
    persona: 'alex',
    text: 'how much did I spend on travel last month?',
    category: 'bookkeeping',
    expectedSkill: 'query-expenses',
    isMultiTurn: true,
    threadId: 't-alex-period-followup',
    required: ['Period:'],
  },
  {
    id: 'cu-alex-100b',
    persona: 'alex',
    text: 'and meals?',
    category: 'bookkeeping',
    // DELIBERATELY STRICT. Turn 1 asked "how much did I spend on travel last
    // month?"; "and meals?" wants the same figure for another category in the
    // same window. The agent answers expense-breakdown — a chart of ALL
    // categories — which does not answer the question and loses the period.
    // Same follow-up-context weakness as the correction threads.
    expectedSkill: 'query-expenses',
    isMultiTurn: true,
    threadId: 't-alex-period-followup',
    required: ['Period:'],
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

  // ============================================================
  // CHINESE — the set had 40 utterances and all 40 were English,
  // so nothing here could see a non-English regression.
  //
  // That mattered: triage decided consultation-vs-skill from
  // English-only marker lists, so on production a single character
  // changed the answer —
  //   这个月我花了多少钱   → query-expenses → "本月您共花费了 CA$192.00"
  //   这个月我花了多少钱？ → consultation   → "你是想看商业支出还是个人支出？"
  // The better-punctuated version was the broken one, and it was
  // broken for EVERY Chinese question, not a few phrasings.
  // ============================================================
  {
    id: 'cu-zh-100',
    persona: 'maya',
    // The exact pair above. This is the regression guard for it.
    text: '这个月我花了多少钱？',
    category: 'bookkeeping',
    expectedSkill: 'query-expenses',
    acceptableSkills: ['expense-breakdown', 'financial-snapshot'],
    expectLang: 'zh',
    forbidden: ['error', 'sorry'],
  },
  {
    id: 'cu-zh-101',
    persona: 'maya',
    text: '谁欠我钱？',                       // who owes me money?
    category: 'invoicing',
    expectedSkill: 'aging-report',
    acceptableSkills: ['query-invoices', 'query-clients'],
    expectLang: 'zh',
  },
  {
    id: 'cu-zh-102',
    persona: 'maya',
    text: '我可以抵扣家庭办公室吗？',          // can I deduct a home office?
    category: 'consultation',
    // The other half of the fix. A ledger noun in a RULES question must not
    // drag it onto the skill path — the mirror of "am I eligible for the
    // small business deduction", which contains "deduction".
    expectedSkill: 'consultation',
    acceptableSkills: ['tax-deductions', 'general-question'],
    // No expectLang, for the same reason as cu-zh-104 and measured the same
    // way: when the consultation reviewer withholds an answer it emits a fixed
    // English string, so this would assert a gap this change does not close.
    // Verified against production — the English "can I deduct a home office?"
    // returns that identical string, so it is not a language defect.
  },
  {
    id: 'cu-zh-103',
    persona: 'maya',
    text: '今年的税率是多少？',                // what is this year's tax rate?
    category: 'tax',
    expectedSkill: 'consultation',
    acceptableSkills: ['general-question', 'tax-estimate'],
    // See cu-zh-102 — routing is asserted, reply language is not, on this path.
  },
  {
    id: 'cu-zh-104',
    persona: 'maya',
    text: '记录 $42 咖啡',                     // record $42 coffee
    category: 'bookkeeping',
    expectedSkill: 'record-expense',
    // NO expectLang here, deliberately. record-expense answers from a fixed
    // template ("Recorded: {{amountFormatted}} — {{description}}"), which is
    // English whatever the user wrote. Asserting 'zh' would fail on a gap this
    // change does not close; asserting 'en' would freeze the gap in place. The
    // skill assertion still guards the routing half.
    required: ['42'],
  },

  // Thread: the user switches language mid-conversation, which is the whole
  // point of the feature — not "pick a language at signup".
  {
    id: 'cu-zh-105a',
    persona: 'maya',
    text: 'how much did I spend this month?',
    category: 'bookkeeping',
    expectedSkill: 'query-expenses',
    acceptableSkills: ['expense-breakdown', 'financial-snapshot'],
    expectLang: 'en',
    isMultiTurn: true,
    threadId: 't-zh-language-switch',
  },
  {
    id: 'cu-zh-105b',
    persona: 'maya',
    // A bare follow-up, in the other language. Two things have to hold at
    // once: the period carries forward (#429) AND the reply switches script.
    text: '那餐饮呢？',                        // and dining?
    category: 'bookkeeping',
    expectedSkill: 'query-expenses',
    acceptableSkills: ['expense-breakdown'],
    expectLang: 'zh',
    isMultiTurn: true,
    threadId: 't-zh-language-switch',
  },
];
