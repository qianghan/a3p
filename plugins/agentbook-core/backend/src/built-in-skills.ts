import { BUSINESS_PHRASE_PATTERN } from './skill-routing.js';

export const BUILT_IN_SKILLS = [
  {
    // PR-1 (personal-finance parity), tightened post-review: array position
    // is NOT a reliable priority signal — `db.abSkillManifest.findMany(...)`
    // at every call site has no `orderBy`, so once skills are seeded into
    // the DB, row order (not this array's order) decides which skill a
    // first-match-wins loop sees first. Rather than depend on ordering, this
    // skill and record-expense are made mutually exclusive via patterns:
    // triggerPatterns here are narrow (checking/savings/paycheck/salary/
    // personal-account/deposited/withdrew signals only, never a bare spend/
    // pay verb), and record-expense's excludePatterns below mirror the same
    // cues (guarded so business-flagged language always wins record-expense
    // regardless of an incidental account mention). That way "I got paid
    // $5,000 salary" / "I spent $80 on groceries from checking" resolve to
    // this skill, and "I spent $80 on lunch" resolves to record-expense, no
    // matter which skill the DB happens to evaluate first. Also excludes
    // personal-snapshot's net-worth/savings-rate *query* phrasing (a
    // question, not a statement) so those keep routing correctly.
    name: 'record-personal-transaction',
    description: 'Record a personal (non-business) income or spending transaction against a personal account — a paycheck, a personal purchase, or a transfer into savings. Kept separate from the business books.',
    category: 'personal-finance',
    triggerPatterns: [
      '\\bi got paid\\b', 'got my paycheck', '\\bpaycheck\\b', '\\bsalary\\b',
      'personal account',
      'from (?:my )?checking', 'from (?:my )?savings',
      '\\bmy checking\\b', '\\bmy savings\\b',
      'into (?:my )?savings', 'to (?:my )?savings',
      '\\bdeposited\\b', '\\bwithdrew\\b', '\\bwithdrawal\\b',
    ],
    // Business-flagged language defers to record-expense (negation-aware —
    // "not a business expense" must NOT defer, see BUSINESS_PHRASE_PATTERN);
    // net-worth/savings-rate/spend-query phrasing defers to personal-snapshot
    // (it's a question about the data, not a statement recording a new
    // transaction).
    excludePatterns: [
      '\\bclient\\b', '\\binvoice\\b', BUSINESS_PHRASE_PATTERN, 'write.?off', 'deductible',
      'net worth', 'savings rate', 'how much.*(?:did|have) i.*spen', "what'?s my", 'household', 'family budget',
    ],
    parameters: {
      description: { type: 'string', required: true, extractHint: 'short description of the transaction' },
      amountCents: { type: 'number', required: true, extractHint: 'dollar amount times 100, signed: positive for income (paycheck/deposit), negative for spending — infer the sign from phrasing, never send an unsigned value' },
      category: { type: 'string', required: false, default: 'uncategorized', extractHint: 'best-effort spending/income category from context' },
      accountRef: { type: 'string', required: false, extractHint: 'raw text naming which personal account this is for, e.g. "checking" or "savings" — omit if not mentioned' },
      businessFlag: { type: 'boolean', required: false, default: false, extractHint: 'true only if the message explicitly says this personal-account charge is actually a business expense' },
    },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-personal/transactions' },
  },
  {
    name: 'record-expense', description: 'Record a business or personal expense', category: 'bookkeeping',
    triggerPatterns: ['\\$\\d', 'spent ', 'paid ', 'bought ', 'purchased '],
    requirePatterns: ['\\$\\s*[\\d,]+\\.?\\d{0,2}|\\d+\\s*(?:dollars|bucks)|(?:spent|paid|bought|purchased|cost)\\s+\\$?[\\d,]+\\.?\\d{0,2}'],
    // F4-03: '^invoice\\s' only caught the word at message start, so
    // "send an invoice to Acme for $500" / "I need to invoice Acme Corp
    // $500" fell through to record-expense's generic failure instead of
    // create-invoice. Match invoice-creation *intent* (a create/send verb
    // near "invoice", or "to invoice") anywhere in the message, without
    // excluding invoice-*paying* phrasing ("paid an invoice from the
    // plumber for $200"), which should still record as an expense.
    // Personal-account cues ("from checking", "salary", "paycheck", etc.)
    // defer to record-personal-transaction — mirrors that skill's own
    // triggerPatterns so the two are mutually exclusive regardless of which
    // one a DB-order-agnostic first-match-wins loop happens to see first
    // (see record-personal-transaction's comment above). Guarded with a
    // negative lookahead for BUSINESS_PHRASE_PATTERN so business-flagged
    // language ("...for the business from my checking account") still wins
    // record-expense even though it mentions a personal account.
    excludePatterns: ['\\bto\\s+invoice\\b|\\binvoice\\s+to\\b|\\b(?:send|create|issue|write|prepare|make|draft)\\s+(?:an?\\s+)?invoice\\b', 'what\\s*if\\b', 'got.*\\$.*from', 'alert.*when|notify.*when|automat', 'received.*payment', '^(?:estimate|quote|proposal)\\s', 'is.*taxable|scholarship|fellowship|grant.*taxable|t2202|1098-?t|aotc|american opportunity|lifetime learning|tuition.*credit|education.*credit|\\bresp\\b|\\b529\\b', 'nonresident alien|non-resident alien|1040-?nr|sprintax|glacier tax|1042-?s|fica exempt|international student.*tax|tax treaty',
      `^(?!.*(?:${BUSINESS_PHRASE_PATTERN})).*(?:from (?:my )?checking|from (?:my )?savings|\\bmy checking\\b|\\bmy savings\\b|into (?:my )?savings|to (?:my )?savings|personal account|\\bpaycheck\\b|\\bsalary\\b|\\bwithdrew\\b|\\bwithdrawal\\b|\\bdeposited\\b)`,
    ],
    parameters: { amountCents: { type: 'number', required: true, extractHint: 'dollar amount times 100' }, vendor: { type: 'string', required: false, extractHint: 'business name' }, description: { type: 'string', required: false }, date: { type: 'date', required: false, default: 'today' } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-expense/expenses' },
    responseTemplate: 'Recorded: {{amountFormatted}} — {{description}} [{{categoryName}}]',
  },
  {
    name: 'query-expenses', description: 'Query, search, list, or ask questions about expenses, spending, or vendors', category: 'bookkeeping',
    triggerPatterns: [
      'show.*expense', 'list.*expense', 'last \\d+ expense', 'how much.*spen', 'recent expense',
      'summary.*expense', 'expense.*summary', 'expense.*overview', 'spending.*summary',
      'top.*spend', 'spend.*most', 'most.*spend', 'biggest.*spend', 'highest.*spend',
      'spend.*in.*', 'spend.*by', 'spend.*month', 'spending.*month',
      'who.*spend', 'vendor.*spend', 'spending.*vendor', 'give.*spend',
      'top.*vendor', 'vendor.*most', 'show.*spend', 'my.*spend',
      // Bare continuation phrases ("list them", "show these") — no entity for
      // pronoun resolution to bind to (see agent-brain.ts resolveReferents),
      // so route them here as the most common "list X" intent in this bot
      // rather than dead-ending in a generic clarifying question. Heuristic,
      // not true conversational memory — may occasionally misfire if the
      // immediately preceding topic wasn't expenses.
      'list (them|these|those)\\b', 'show (them|these|those)\\b',
      'list.*so i can', 'list.*here',
    ],
    parameters: { question: { type: 'string', required: true, extractHint: 'the full user message' } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-expense/advisor/ask' },
  },
  {
    name: 'query-finance', description: 'Ask about cash balance, revenue, profit, tax (incl. combined W-2 + self-employment income), clients, or general financial questions', category: 'finance',
    triggerPatterns: ['balance', 'revenue', 'profit', 'loss', 'tax', 'client.*owe', 'outstanding', 'income', 'net '],
    // Tax / report / cash-flow / reconciliation / tax-filing utterances have
    // dedicated skills — exclude them here so query-finance doesn't shadow.
    excludePatterns: ['tax.*estimate|how much.*tax|tax.*owe|tax.*situation|tax.*liability|quarterly.*tax|quarterly.*payment|estimated.*payment|deduction|write.*off|tax.*saving|tax.*break|p.?&?.?l|profit.*loss|income.*statement|net.*income|how.*much.*profit|balance.*sheet|net.*worth|equity|cash.*flow|cash.*projection|runway|burn.*rate|how long.*cash.*last|financial.*summary|financial.*snapshot|how.*doing.*financially|financial.*health|money.*move|action.*item|what.*should.*do|advice.*money|reconcil|unmatched.*transaction|bank.*match|bank.*status|tax.*fil|start.*fil|file.*tax|review.*t[12]|t2125|schedule.*1|gst.*return|tax.*slip|validate.*tax|check.*tax.*error|verify.*return|tax.*ready|export.*tax|generate.*tax.*form|download.*return|create.*tax.*file|print.*tax|pdf.*tax|submit.*cra|efile|netfile|filing.*status.*cra|scholarship|fellowship|grant.*taxable|is.*grant.*tax|t2202|1098-?t|aotc|american opportunity|lifetime learning|tuition.*credit|education.*credit|\\bresp\\b|\\b529\\b|nonresident alien|non-resident alien|1040-?nr|sprintax|glacier tax|1042-?s|fica exempt|international student.*tax|tax treaty'],
    parameters: { question: { type: 'string', required: true, extractHint: 'the full user message' } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-core/ask' },
  },
  {
    name: 'scan-receipt', description: 'Scan and process a receipt photo', category: 'bookkeeping',
    triggerPatterns: [],
    parameters: { imageUrl: { type: 'string', required: true, extractHint: 'attachment URL' } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-expense/receipts/ocr' },
  },
  {
    name: 'scan-document', description: 'Process a PDF document (receipt or statement)', category: 'bookkeeping',
    triggerPatterns: [],
    parameters: { imageUrl: { type: 'string', required: true, extractHint: 'attachment URL' } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-expense/receipts/ocr' },
  },
  {
    name: 'create-invoice', description: 'Create an invoice for a client', category: 'invoicing',
    triggerPatterns: ['invoice .+ \\$'],
    parameters: { clientName: { type: 'string', required: true }, amountCents: { type: 'number', required: true }, description: { type: 'string', required: false, default: 'Services' } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-invoice/invoices' },
  },
  {
    name: 'simulate-scenario', description: 'Run a what-if financial simulation', category: 'planning',
    triggerPatterns: ['what if', 'what.?if', 'simulate', 'scenario', 'hire.*\\$', 'lose.*client'],
    parameters: { scenario: { type: 'string', required: true, extractHint: 'the full user message' } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-core/simulate' },
  },
  {
    name: 'proactive-alerts', description: 'Check for alerts, notifications, or things needing attention', category: 'insights',
    triggerPatterns: ['alert', 'notification', 'check.?up', 'anything.*know', 'what.?s new'],
    // "alert me when X" / "notify when X" / "automat..." are automation
    // creation, not proactive alert checks.
    excludePatterns: ['alert.*when|notify.*when|automat'],
    parameters: {},
    endpoint: { method: 'GET', url: '/api/v1/agentbook-expense/advisor/proactive-alerts', queryParams: [] },
  },
  {
    name: 'expense-breakdown', description: 'Show spending breakdown by category as a chart', category: 'insights',
    triggerPatterns: ['breakdown', 'categor.*chart', 'pie chart', 'bar chart', 'spending chart'],
    parameters: { chartType: { type: 'string', required: false, default: 'bar' } },
    endpoint: { method: 'GET', url: '/api/v1/agentbook-expense/advisor/chart', queryParams: ['startDate', 'endDate', 'chartType'] },
  },
  {
    name: 'categorize-expenses', description: 'Auto-categorize uncategorized expenses into the right expense categories', category: 'bookkeeping',
    triggerPatterns: ['categorize', 'classify', 'organize.*expense', 'fix.*categor', 'uncategorized', 'auto.?categor'],
    parameters: {},
    endpoint: { method: 'INTERNAL', url: '' },  // handled inline by agent brain
  },
  {
    name: 'edit-expense', description: 'Edit an existing expense — change amount, category, vendor, date, or description', category: 'bookkeeping',
    triggerPatterns: ['change.*expense', 'edit.*expense', 'update.*expense', 'fix.*expense', 'correct.*expense'],
    parameters: { expenseId: { type: 'string', required: false, extractHint: 'expense ID or "last"' } },
    endpoint: { method: 'PUT', url: '/api/v1/agentbook-expense/expenses/:id' },
    confirmBefore: true,
  },
  {
    // Description doubles as the LLM's only guide for both intent
    // classification and plan generation (neither prompt sees the
    // `parameters` schema below) — it must describe the endpoint's real
    // contract (an array of category/amount rows) or the LLM has nothing
    // accurate to extract from and reverts to inventing a shape like
    // { businessPercent: 50 } that the endpoint has never accepted.
    name: 'split-expense', description: "Split an expense into two or more parts — either across different categories (e.g. half Meals, half Travel) or between business and personal use, optionally by an explicit percentage (e.g. \"30% personal\"). Requires a splits array of { category, amountCents, isPersonal } entries whose amounts add up exactly to the expense's total; omit category on a part to keep the expense's existing category. If the user gives a percentage, compute amountCents from it; if they give categories but no ratio, split the total evenly.", category: 'bookkeeping',
    triggerPatterns: ['split.*expense', 'part.*business.*personal', 'half.*personal'],
    parameters: {
      expenseId: { type: 'string', required: false, extractHint: 'expense ID or "last"' },
      splits: { type: 'array', required: true, extractHint: 'at least 2 entries of { category, amountCents, isPersonal }, summing to the expense total' },
    },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-expense/expenses/:id/split' },
    confirmBefore: true,
  },
  {
    name: 'review-queue', description: 'Show expenses that need human review — low confidence, pending, or flagged', category: 'bookkeeping',
    triggerPatterns: ['review', 'pending.*review', 'need.*attention', 'flagged'],
    // Tax-form review utterances have dedicated CA tax skills (ca-t2125-review,
    // ca-t1-review, ca-gst-hst-review, ca-schedule-1-review).
    excludePatterns: ['review.*t[12]|t2125|t1.*general|t1.*review|gst.*review|hst.*review|schedule.*1|review.*gst|review.*hst', 'books|cpa|accountant'],
    parameters: {},
    endpoint: { method: 'GET', url: '/api/v1/agentbook-expense/review-queue' },
  },
  {
    name: 'manage-recurring', description: 'View or manage recurring expense patterns — subscriptions, rent, monthly charges', category: 'bookkeeping',
    triggerPatterns: ['recurring', 'subscription', 'monthly.*expense', 'regular.*payment'],
    parameters: {},
    endpoint: { method: 'GET', url: '/api/v1/agentbook-expense/recurring-suggestions' },
  },
  {
    name: 'vendor-insights', description: 'Show spending patterns by vendor — who you spend most with, trends, top vendors by amount', category: 'insights',
    triggerPatterns: ['vendor.*pattern', 'vendor.*trend', 'vendor.*insight'],
    parameters: { question: { type: 'string', required: true, extractHint: 'the full user message' } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-expense/advisor/ask' },
  },
  {
    name: 'query-invoices', description: 'List, search, or ask about invoices — outstanding, overdue, by client, by status', category: 'invoicing',
    triggerPatterns: ['show.*invoice', 'list.*invoice', 'outstanding.*invoice', 'unpaid.*invoice', 'overdue.*invoice', 'invoice.*status', 'my invoice'],
    parameters: { status: { type: 'string', required: false }, clientName: { type: 'string', required: false } },
    endpoint: { method: 'GET', url: '/api/v1/agentbook-invoice/invoices', queryParams: ['status', 'clientId', 'limit'] },
  },
  {
    name: 'aging-report', description: 'Show accounts receivable aging — who owes money and how overdue', category: 'invoicing',
    triggerPatterns: ['aging', 'who.*owe', 'accounts.*receivable', 'ar report', 'overdue.*client', 'owe.*money'],
    parameters: {},
    endpoint: { method: 'GET', url: '/api/v1/agentbook-invoice/aging-report' },
  },
  {
    name: 'query-estimates', description: 'List estimates — pending, approved, converted', category: 'invoicing',
    triggerPatterns: ['show.*estimate', 'list.*estimate', 'pending.*estimate', 'my estimate'],
    parameters: { status: { type: 'string', required: false } },
    endpoint: { method: 'GET', url: '/api/v1/agentbook-invoice/estimates', queryParams: ['status', 'clientId'] },
  },
  {
    name: 'query-clients', description: 'List clients or show client details — billing history, outstanding balance', category: 'invoicing',
    triggerPatterns: ['show.*client', 'list.*client', 'client.*detail', 'client.*balance', 'my client'],
    parameters: {},
    endpoint: { method: 'GET', url: '/api/v1/agentbook-invoice/clients' },
  },
  {
    name: 'timer-status', description: 'Check if a time tracking timer is running and how long', category: 'invoicing',
    triggerPatterns: ['timer.*status', 'timer.*running', 'is.*timer', 'how long.*timer'],
    parameters: {},
    endpoint: { method: 'GET', url: '/api/v1/agentbook-invoice/timer/status' },
  },
  {
    name: 'unbilled-summary', description: 'Show unbilled time by client — hours logged but not yet invoiced', category: 'invoicing',
    triggerPatterns: ['unbilled', 'not.*invoiced', 'billable.*time', 'hours.*not.*billed'],
    parameters: {},
    endpoint: { method: 'GET', url: '/api/v1/agentbook-invoice/unbilled-summary' },
  },
  {
    name: 'send-invoice', description: 'Send a draft or created invoice to the client via email', category: 'invoicing',
    triggerPatterns: ['send.*invoice', 'email.*invoice', 'deliver.*invoice', 'send.*that.*invoice'],
    parameters: { invoiceId: { type: 'string', required: false, extractHint: 'invoice ID, number like INV-YYYY-NNNN, or "last"' } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-invoice/invoices/:id/send' },
    confirmBefore: true,
  },
  {
    name: 'record-payment', description: 'Record a payment received for an invoice', category: 'invoicing',
    triggerPatterns: ['got.*paid', 'received.*payment', 'record.*payment', 'got.*\\$.*from', 'payment.*received'],
    parameters: { invoiceId: { type: 'string', required: false }, amountCents: { type: 'number', required: false }, clientName: { type: 'string', required: false }, method: { type: 'string', required: false, default: 'manual' } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-invoice/payments' },
    confirmBefore: true,
  },
  {
    name: 'create-estimate', description: 'Create a project estimate or quote for a client', category: 'invoicing',
    triggerPatterns: ['estimate.*\\$', 'quote.*\\$', 'proposal.*\\$', 'create.*estimate'],
    parameters: { clientName: { type: 'string', required: true }, amountCents: { type: 'number', required: true }, description: { type: 'string', required: true } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-invoice/estimates' },
  },
  {
    name: 'start-timer', description: 'Start a time tracking timer for a project or client', category: 'invoicing',
    triggerPatterns: ['start.*timer', 'track.*time', 'clock.*in', 'begin.*timer'],
    parameters: { description: { type: 'string', required: false }, clientName: { type: 'string', required: false }, projectName: { type: 'string', required: false } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-invoice/timer/start' },
  },
  {
    name: 'stop-timer', description: 'Stop the running time tracker', category: 'invoicing',
    triggerPatterns: ['stop.*timer', 'clock.*out', 'end.*timer', 'pause.*timer'],
    parameters: {},
    endpoint: { method: 'POST', url: '/api/v1/agentbook-invoice/timer/stop' },
  },
  {
    name: 'send-reminder', description: 'Send payment reminder for overdue invoices', category: 'invoicing',
    triggerPatterns: ['send.*remind', 'remind.*overdue', 'follow.*up.*invoice', 'chase.*payment', 'nudge.*client', 'remind.*payment'],
    parameters: { invoiceId: { type: 'string', required: false, extractHint: 'invoice ID or "all" for all overdue' } },
    endpoint: { method: 'INTERNAL', url: '' },
  },
  {
    name: 'tax-estimate', description: 'Show tax estimate — income tax, self-employment tax, effective rate', category: 'tax',
    triggerPatterns: ['tax.*estimate', 'how much.*tax', 'tax.*owe', 'tax.*situation', 'tax.*liability'],
    parameters: { period: { type: 'string', required: false, default: 'ytd' } },
    endpoint: { method: 'GET', url: '/api/v1/agentbook-tax/tax/estimate', queryParams: ['startDate', 'endDate'] },
  },
  {
    name: 'quarterly-payments', description: 'Show quarterly tax payment schedule and status', category: 'tax',
    triggerPatterns: ['quarterly.*payment', 'quarterly.*tax', 'estimated.*payment', 'quarterly.*due'],
    parameters: { year: { type: 'string', required: false } },
    endpoint: { method: 'GET', url: '/api/v1/agentbook-tax/tax/quarterly', queryParams: ['year'] },
  },
  {
    name: 'tax-deductions', description: 'Show potential tax deductions and savings opportunities', category: 'tax',
    triggerPatterns: ['deduction', 'tax.*saving', 'write.*off', 'deductible', 'tax.*break'],
    parameters: {},
    endpoint: { method: 'GET', url: '/api/v1/agentbook-tax/tax/deductions' },
  },
  {
    name: 'pnl-report', description: 'Show profit & loss report — revenue, expenses, net income', category: 'tax',
    triggerPatterns: ['\\bp\\s?&?\\s?l\\b', 'profit.*loss', 'income.*statement', 'net.*income', 'how.*much.*profit'],
    excludePatterns: ['notice of assessment', 'past.*filing', 'noa', 'my t1 from'],
    parameters: { startDate: { type: 'string', required: false }, endDate: { type: 'string', required: false } },
    endpoint: { method: 'GET', url: '/api/v1/agentbook-tax/reports/pnl', queryParams: ['startDate', 'endDate'] },
  },
  {
    name: 'balance-sheet', description: 'Show the business balance sheet — assets, liabilities, equity', category: 'tax',
    triggerPatterns: ['balance.*sheet', 'asset.*liabilit', 'equity'],
    excludePatterns: ['personal', 'household', 'my net worth'],
    parameters: {},
    endpoint: { method: 'GET', url: '/api/v1/agentbook-tax/reports/balance-sheet', queryParams: ['asOfDate'] },
  },
  {
    name: 'cashflow-report', description: 'Show cash flow statement or projection — inflows, outflows, runway', category: 'tax',
    triggerPatterns: ['cash.*flow', 'cash.*projection', 'runway', 'burn.*rate', 'how long.*cash.*last'],
    parameters: {},
    endpoint: { method: 'GET', url: '/api/v1/agentbook-tax/cashflow/projection' },
  },
  {
    name: 'financial-snapshot', description: 'Quick financial summary — cash, revenue, expenses, profit at a glance', category: 'finance',
    triggerPatterns: ['financial.*summary', 'financial.*snapshot', 'overview', 'dashboard', 'how.*doing.*financially', 'financial.*health'],
    parameters: {},
    endpoint: { method: 'GET', url: '/api/v1/agentbook-core/financial-snapshot' },
  },
  {
    name: 'money-moves', description: 'Proactive money moves and action items — things you should do with your money', category: 'finance',
    triggerPatterns: ['money.*move', 'action.*item', 'what.*should.*do', 'suggestion', 'recommend', 'advice.*money'],
    parameters: {},
    endpoint: { method: 'GET', url: '/api/v1/agentbook-core/money-moves' },
  },
  {
    name: 'bank-reconciliation', description: 'Check bank reconciliation status — matched vs unmatched transactions', category: 'bookkeeping',
    triggerPatterns: ['reconcil', 'unmatched.*transaction', 'bank.*match', 'bank.*status'],
    parameters: {},
    endpoint: { method: 'GET', url: '/api/v1/agentbook-expense/reconciliation-summary' },
  },
  {
    name: 'cpa-notes', description: 'Add or view notes for CPA/accountant — tax questions, review items', category: 'finance',
    triggerPatterns: ['cpa.*note', 'accountant.*note', 'note.*cpa', 'note.*accountant', 'tell.*cpa', 'ask.*cpa'],
    parameters: { note: { type: 'string', required: false, extractHint: 'the note content' } },
    endpoint: { method: 'GET', url: '/api/v1/agentbook-core/cpa/notes' },
  },
  {
    name: 'cpa-share', description: 'Generate a secure access link to share financial data with CPA/accountant', category: 'finance',
    triggerPatterns: ['share.*cpa', 'share.*accountant', 'cpa.*access', 'cpa.*link', 'give.*cpa.*access'],
    parameters: {},
    endpoint: { method: 'POST', url: '/api/v1/agentbook-core/cpa/generate-link' },
  },
  {
    name: 'create-automation', description: 'Create an automation rule from natural language — triggers, conditions, actions', category: 'finance',
    triggerPatterns: ['automat', 'when.*then', 'alert.*when', 'notify.*when', 'rule.*when'],
    // "show/list my automations" is list-automations, not create.
    excludePatterns: ['^(?:show|list|get|view|display|what|my)\\s.*automat|^automat.*(?:show|list|get)|show.*my.*automat|list.*automat|my.*automat|active.*rule'],
    parameters: { description: { type: 'string', required: true, extractHint: 'natural language rule description' } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-core/automations/from-description' },
  },
  {
    name: 'list-automations', description: 'Show active automation rules', category: 'finance',
    triggerPatterns: ['show.*automat', 'list.*automat', 'my.*automat', 'active.*rule'],
    parameters: {},
    endpoint: { method: 'GET', url: '/api/v1/agentbook-core/automations' },
  },
  {
    name: 'tax-filing-start', description: 'Start tax filing — create filing session, auto-populate from books, identify missing fields', category: 'tax',
    triggerPatterns: ['start.*tax.*fil', 'file.*my.*tax', 'begin.*return', 'prepare.*tax.*return', 'tax.*return'],
    parameters: { taxYear: { type: 'number', required: false, default: 2025 } },
    endpoint: { method: 'INTERNAL', url: '' },
  },
  {
    name: 'tax-filing-status', description: 'Check tax filing progress — completeness by form, what is missing', category: 'tax',
    triggerPatterns: ['tax.*filing.*status', 'filing.*progress', 'what.*missing.*tax', 'tax.*complete', 'filing.*complete'],
    parameters: { taxYear: { type: 'number', required: false, default: 2025 } },
    endpoint: { method: 'GET', url: '/api/v1/agentbook-tax/tax-filing/2025' },
  },
  {
    name: 'tax-slip-scan', description: 'Upload and scan a tax slip (T4, T5, RRSP, TFSA, bank statement) for OCR extraction', category: 'tax',
    triggerPatterns: ['upload.*slip', 'scan.*t4', 'scan.*t5', 'scan.*rrsp', 'scan.*slip', 'tax.*document'],
    parameters: { imageUrl: { type: 'string', required: false } },
    endpoint: { method: 'INTERNAL', url: '' },
  },
  {
    name: 'tax-slip-list', description: 'Show uploaded tax slips and their status', category: 'tax',
    triggerPatterns: ['show.*slip', 'list.*slip', 'uploaded.*slip', 'my.*slip', 'tax.*slip'],
    parameters: { taxYear: { type: 'number', required: false, default: 2025 } },
    endpoint: { method: 'GET', url: '/api/v1/agentbook-tax/tax-slips', queryParams: ['taxYear'] },
  },
  {
    name: 'ca-t2125-review', description: 'Review T2125 Statement of Business Income — revenue, expenses, vehicle, home office', category: 'tax',
    triggerPatterns: ['review.*t2125', 'business.*income.*form', 't2125', 'statement.*business'],
    parameters: {},
    endpoint: { method: 'GET', url: '/api/v1/agentbook-tax/tax-filing/2025' },
  },
  {
    name: 'ca-t1-review', description: 'Review T1 General personal income tax return — income sources, deductions, credits', category: 'tax',
    triggerPatterns: ['review.*t1', 'personal.*return', 't1.*general', 't1.*review'],
    parameters: {},
    endpoint: { method: 'GET', url: '/api/v1/agentbook-tax/tax-filing/2025' },
  },
  {
    name: 'ca-gst-hst-review', description: 'Review GST/HST return — collected tax, input tax credits, net tax', category: 'tax',
    triggerPatterns: ['review.*gst', 'review.*hst', 'sales.*tax.*return', 'gst.*hst.*review', 'gst.*return'],
    parameters: {},
    endpoint: { method: 'GET', url: '/api/v1/agentbook-tax/tax-filing/2025' },
  },
  {
    name: 'ca-schedule-1-review', description: 'Review Schedule 1 federal tax calculation', category: 'tax',
    triggerPatterns: ['schedule.*1', 'federal.*tax.*calc'],
    parameters: {},
    endpoint: { method: 'GET', url: '/api/v1/agentbook-tax/tax-filing/2025' },
  },
  {
    name: 'scholarship-taxability', description: 'Explain whether a scholarship, grant, RESP/529 withdrawal, or stipend is taxable, and whether AOTC/Lifetime Learning Credit or the Canadian tuition transfer applies', category: 'tax',
    triggerPatterns: ['scholarship', 'is.*grant.*taxable', 'fellowship', 'financial aid.*tax', 'tuition.*credit', 'education.*credit', 'AOTC', 'american opportunity', 'lifetime learning', '\\bresp\\b', '\\b529\\b', 't2202', '1098-?t', 'is.*taxable'],
    excludePatterns: ['\\b(find|search|look for)\\b.*\\bscholarships?\\b|\\bapply\\s+(to|for)\\b.*\\bscholarships?\\b'],
    parameters: { question: { type: 'string', required: true, extractHint: 'the full user question about the scholarship/grant/stipend/withdrawal' } },
    endpoint: { method: 'INTERNAL', url: '' },
  },
  {
    name: 'international-student-tax-help', description: 'Explain nonresident-alien tax status, tax treaty benefits, FICA exemption, and 1042-S for international students on a visa — hands off to Sprintax/GLACIER for actual 1040NR filing', category: 'tax',
    triggerPatterns: ['nonresident alien', 'non-resident alien', '\\bf-?1\\b.*visa|visa.*\\bf-?1\\b', '\\bj-?1\\b.*visa|visa.*\\bj-?1\\b', '1040-?nr', 'tax treaty', 'sprintax', 'glacier tax', '1042-?s', 'fica exempt', 'am i a resident for tax', 'international student.*tax', 'opt.*tax|cpt.*tax', 'form 8843'],
    parameters: { question: { type: 'string', required: true, extractHint: 'the full user question about nonresident/international-student tax status' } },
    endpoint: { method: 'INTERNAL', url: '' },
  },
  {
    name: 'tax-filing-field', description: 'Provide a value for a missing tax filing field', category: 'tax',
    triggerPatterns: [],
    parameters: { formCode: { type: 'string', required: true }, fieldId: { type: 'string', required: true }, value: { type: 'string', required: true } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-tax/tax-filing/2025/field' },
  },
  {
    name: 'tax-filing-validate', description: 'Run validation rules on tax return — check for errors before filing', category: 'tax',
    triggerPatterns: ['validate.*tax', 'check.*tax.*error', 'verify.*return', 'tax.*ready.*file', 'any.*error.*tax'],
    parameters: { taxYear: { type: 'number', required: false, default: 2025 } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-tax/tax-filing/2025/validate' },
  },
  {
    name: 'tax-filing-export', description: 'Generate and export tax forms — PDF or JSON format', category: 'tax',
    triggerPatterns: ['export.*tax', 'generate.*tax.*form', 'download.*return', 'create.*tax.*file', 'print.*tax', 'pdf.*tax'],
    parameters: { format: { type: 'string', required: false, default: 'json' } },
    endpoint: { method: 'INTERNAL', url: '' },
  },
  {
    name: 'tax-filing-submit', description: 'Submit tax return to CRA via certified partner API — e-file your return', category: 'tax',
    triggerPatterns: ['submit.*tax', 'submit.*cra', 'efile', 'netfile', 'submit.*return', 'file.*return.*cra', 'send.*cra'],
    parameters: { taxYear: { type: 'number', required: false, default: 2025 } },
    endpoint: { method: 'INTERNAL', url: '' },
    confirmBefore: true,
  },
  {
    name: 'tax-filing-check', description: 'Check e-filing status — accepted, rejected, or pending by CRA', category: 'tax',
    triggerPatterns: ['filing.*status.*cra', 'cra.*accept', 'return.*status.*cra', 'check.*filing.*status', 'did.*cra.*accept'],
    parameters: { taxYear: { type: 'number', required: false, default: 2025 } },
    endpoint: { method: 'GET', url: '/api/v1/agentbook-tax/tax-filing/2025/status' },
  },
  {
    name: 'telegram-setup', description: 'Configure Telegram bot — connect your own bot by providing the API token from @BotFather', category: 'finance',
    triggerPatterns: ['setup.*telegram', 'connect.*telegram', 'telegram.*bot.*token', 'configure.*telegram', 'my.*bot.*token'],
    parameters: { botToken: { type: 'string', required: false, extractHint: 'Telegram bot API token from @BotFather' } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-core/telegram/setup' },
  },
  {
    name: 'telegram-status', description: 'Check Telegram bot connection status', category: 'finance',
    triggerPatterns: ['telegram.*status', 'bot.*connected', 'telegram.*config'],
    parameters: {},
    endpoint: { method: 'GET', url: '/api/v1/agentbook-core/telegram/status' },
  },
  {
    name: 'convert-estimate', description: 'Convert an approved estimate into an invoice', category: 'invoicing',
    triggerPatterns: ['convert.*estimate', 'estimate.*invoice', 'turn.*estimate.*invoice'],
    parameters: { estimateId: { type: 'string', required: false, extractHint: 'estimate ID or "last"' } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-invoice/estimates/:id/convert' },
  },
  {
    name: 'void-invoice', description: 'Void/cancel an invoice — reverses journal entries', category: 'invoicing',
    triggerPatterns: ['void.*invoice', 'cancel.*invoice', 'delete.*invoice'],
    parameters: { invoiceId: { type: 'string', required: false, extractHint: 'invoice ID, number, or "last"' } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-invoice/invoices/:id/void' },
    confirmBefore: true,
  },
  {
    name: 'create-credit-note', description: 'Issue a credit note against an invoice — partial refund or adjustment', category: 'invoicing',
    triggerPatterns: ['credit.*note', 'credit.*invoice', 'issue.*credit', 'refund.*invoice'],
    parameters: { invoiceId: { type: 'string', required: false }, amountCents: { type: 'number', required: false }, reason: { type: 'string', required: false } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-invoice/credit-notes' },
    confirmBefore: true,
  },
  {
    name: 'create-payment-link', description: 'Generate a Stripe payment link for an invoice so clients can pay online', category: 'invoicing',
    triggerPatterns: ['payment.*link', 'pay.*link', 'stripe.*link', 'online.*pay', 'pay.*online', 'generate.*link'],
    parameters: { invoiceId: { type: 'string', required: false } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-invoice/invoices/:id/payment-link' },
  },
  {
    name: 'toggle-auto-reminders', description: 'Enable or disable automatic payment reminders for overdue invoices', category: 'invoicing',
    triggerPatterns: ['auto.*remind', 'automatic.*remind', 'enable.*remind', 'disable.*remind'],
    parameters: { enabled: { type: 'boolean', required: false } },
    endpoint: { method: 'PUT', url: '/api/v1/agentbook-core/tenant-config' },
  },
  {
    name: 'set-budget', description: 'Set a monthly budget — total or per category', category: 'bookkeeping',
    triggerPatterns: ['set.*budget', 'budget.*\\$', 'monthly.*budget', 'spending.*limit'],
    parameters: { amountCents: { type: 'number', required: true }, category: { type: 'string', required: false }, period: { type: 'string', required: false, default: 'monthly' } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-expense/budgets' },
  },
  {
    name: 'query-budget', description: 'Check budget status — spending vs budget by category', category: 'bookkeeping',
    triggerPatterns: ['budget.*status', 'over.*budget', 'under.*budget', 'how.*budget', 'spending.*vs.*budget', 'check.*budget'],
    parameters: {},
    endpoint: { method: 'GET', url: '/api/v1/agentbook-expense/budgets/status' },
  },
  {
    name: 'expense-report', description: 'Generate an expense report for a date range', category: 'bookkeeping',
    triggerPatterns: ['expense.*report', 'generate.*report', 'expense.*pdf', 'print.*expense', 'download.*expense'],
    parameters: { startDate: { type: 'string', required: false }, endDate: { type: 'string', required: false } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-expense/reports/expense-pdf' },
  },
  {
    // PR 16: receipt-expiry warnings.
    // The Telegram webhook owns the multi-message flow + skip path
    // (it needs to stash a pending-target memory key and apply the
    // next photo/PDF upload to that expense). The skill manifest is
    // here so the brain LLM classifier can route alternative phrasings
    // ("I'll send the receipt for AWS") to the right handler.
    name: 'manage_receipt_request', description: 'Send or skip a receipt for a specific expense (e.g. "send receipt for AWS October bill", "skip receipt for Stripe fee")', category: 'bookkeeping',
    triggerPatterns: ['^send\\s+receipt\\s+for\\s+', '^skip\\s+receipt\\s+for\\s+'],
    parameters: { target: { type: 'string', required: true, extractHint: 'expense description or vendor' } },
    endpoint: { method: 'INTERNAL', url: '' },
  },
  {
    // PR 14 / G-016: chat-discoverable per-skill metrics.
    // "skill metrics", "agent stats", "how is the agent doing" → GET the
    // metrics endpoint and return the top skills by usage + success rate.
    // Makes rubric #2 ("skills discoverable from chat") measurable too.
    name: 'show-skill-metrics', description: 'Show how the agent is performing across skills (success rate, latency, usage)', category: 'observability',
    triggerPatterns: ['skill\\s*metrics', 'agent\\s*stats', 'how.*agent.*doing', 'skill.*performance', 'agent\\s*performance'],
    parameters: { days: { type: 'number', required: false, extractHint: 'lookback window in days, default 7' } },
    endpoint: { method: 'GET', url: '/api/v1/agentbook-core/agent/skills/metrics' },
  },
  {
    name: 'record-invoice-payment',
    description: 'Record a payment received for an invoice. Use when user says they received payment for an invoice, a client paid them, or they want to mark an invoice as paid.',
    category: 'invoicing',
    triggerPatterns: ['paid.*invoice', 'invoice.*paid', 'got paid', 'received.*payment', 'mark.*paid'],
    examples: [
      'I got paid for invoice INV-2026-0004',
      'Acme paid the invoice',
      'Mark invoice 0004 as paid',
      'Received $1200 from client',
      'Client Beta LLC paid me',
      'invoice was paid',
    ],
    parameters: {
      invoiceRef: { type: 'string', description: 'Invoice number like INV-2026-0004, or partial like "0004"', required: false },
      clientName: { type: 'string', description: 'Client name if invoice number not provided', required: false },
      amountCents: { type: 'number', description: 'Amount paid in cents', required: false },
    },
    endpoint: { method: 'INTERNAL', url: '' },
  },
  {
    name: 'daily-briefing',
    description: 'Morning financial briefing — cash position, alerts, outstanding invoices, what needs attention today',
    category: 'finance',
    triggerPatterns: [
      'briefing', 'daily.*brief', 'morning.*update', 'catch.*me.*up',
      'what.*s.*up', 'update.*me', 'what.*s.*happening', 'quick.*update',
      'daily.*summary', 'morning.*brief',
    ],
    parameters: {},
    endpoint: { method: 'INTERNAL', url: '' },
  },
  {
    name: 'query-past-filings',
    description: "Retrieve user's uploaded past tax filings. Use when user asks about previous tax returns, T1 history, NOA, notice of assessment, past filing PDFs, or wants a download link.",
    category: 'tax',
    triggerPatterns: [
      'past.*filing', 'past filing', "last year.?s return", 'my t1 from', '\\bnoa\\b', 'notice of assessment',
      'tax return 20\\d\\d', 'show.*my.*filing', 'show my filing', 'download my.*return',
      'previous tax (filing|return|t1|noa|slip)',
      'filed in 20\\d\\d', 'my.*2023.*return', 'my.*2024.*return', 'my.*2022.*return',
      'uploaded.*tax', 'list.*past.*tax',
    ],
    excludePatterns: ['estimate', 'liability', 'how much.*owe', 'payment'],
    parameters: {
      year: { type: 'number', required: false, extractHint: '4-digit tax year if mentioned' },
      formType: { type: 'string', required: false, extractHint: 'form type like T1, NOA, 1040' },
    },
    endpoint: { method: 'INTERNAL', url: '' },
  },
  {
    name: 'manage-bills',
    description: 'Record bills owed to vendors, list bills that are due or overdue, and report accounts payable. Use when the user mentions owing money, rent due, vendor bills, or asks what bills are due.',
    category: 'bookkeeping',
    triggerPatterns: ['bills? due', 'what.*owe', 'owe ', 'payable', 'rent.*due', 'bill from', 'add.*bill', 'record.*bill', 'overdue bill'],
    excludePatterns: ['invoice', 'estimate'],
    parameters: {
      action: { type: 'string', required: false, extractHint: 'create or list (default list)' },
      vendorName: { type: 'string', required: false, extractHint: 'vendor name when creating' },
      amountCents: { type: 'number', required: false, extractHint: 'dollar amount times 100 when creating' },
      dueDate: { type: 'date', required: false, extractHint: 'due date when creating' },
    },
    endpoint: { method: 'INTERNAL', url: '' },
  },
  {
    name: 'personal-snapshot',
    description: 'Answer personal/household finance questions — net worth, monthly spending, income, savings rate (kept separate from the business books).',
    category: 'finance',
    triggerPatterns: ['net worth', 'personal finance', 'household', 'family budget', 'savings rate', 'how much.*saved', 'my personal'],
    excludePatterns: ['business'],
    parameters: {},
    endpoint: { method: 'INTERNAL', url: '' },
  },
  {
    name: 'payroll-status',
    description: 'Answer payroll questions — who is on payroll, how many employees, when the last pay run was and its totals.',
    category: 'finance',
    triggerPatterns: ['payroll', 'who.*payroll', 'employees', 'last payroll', 'pay run', 'who.*pay'],
    excludePatterns: ['run payroll', 'process payroll'],
    parameters: {},
    endpoint: { method: 'INTERNAL', url: '' },
  },
  {
    name: 'run-payroll',
    description: 'Prepare a payroll run for the current period — compute gross, withholding, and net for each employee as a draft to review and process on the Payroll page.',
    category: 'finance',
    triggerPatterns: ['run payroll', 'process payroll', 'pay.*employees', 'do payroll'],
    parameters: {},
    endpoint: { method: 'INTERNAL', url: '' },
  },
  {
    name: 'cpa-review',
    description: 'Run an AI accountant review of the books and list the top actionable findings with a health score.',
    category: 'finance',
    triggerPatterns: ['review my books', 'cpa review', 'check my books', 'are my books', 'accountant review', 'books health', 'review the books'],
    parameters: {},
    endpoint: { method: 'INTERNAL', url: '' },
  },
  {
    name: 'us-rd-credit-finder',
    description: 'Check whether the business likely qualifies for the US federal R&D tax credit, QSBS eligibility tracking, or Delaware franchise tax optimization, with an estimated dollar range',
    category: 'tax_benefits',
    triggerPatterns: ['r&d credit', 'r and d credit', 'research credit', 'research and development credit', 'startup tax benefit', 'qsbs', 'franchise tax'],
    parameters: {},
    endpoint: { method: 'GET', url: '/api/v1/agentbook-startup/recommendations' },
    responseTemplate: 'Based on your company profile, here is what you may qualify for: {{programs}}',
  },
  {
    name: 'find-scholarships', description: 'Search for scholarships, grants, or financial aid matching the student\'s program, school, and eligibility — a live grounded search, not tax advice on an existing award', category: 'student',
    triggerPatterns: ['find.*scholarship', 'scholarship.*for', 'search.*scholarship', 'look for.*scholarship', 'scholarship.*(my|as a).*(major|program)', 'apply.*for.*scholarship'],
    parameters: { query: { type: 'string', required: false, extractHint: 'optional free-text focus, e.g. "for computer science" or "need-based" — omit if the user gave no specifics' } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-scholarship/discover' },
  },
  {
    name: 'save-scholarship', description: 'Save/shortlist a scholarship the student just found (or one they describe directly) to their tracked opportunities list', category: 'student',
    triggerPatterns: ['save.*(scholarship|that|it|the .* one)', 'track.*scholarship', 'shortlist.*scholarship'],
    excludePatterns: ['co-?op|internship|job', '\\b(invoice|receipt|expense)\\b'],
    parameters: {
      title: { type: 'string', required: false, extractHint: 'scholarship name, only if the user is describing one directly rather than referring back to a search result' },
      amountText: { type: 'string', required: false, extractHint: 'the award amount as free text, e.g. "$2,000", only for a direct description' },
      deadlineText: { type: 'string', required: false, extractHint: 'the deadline as free text or ISO date, only for a direct description' },
      sourceUrl: { type: 'string', required: false, extractHint: 'a URL for the scholarship, only for a direct description' },
    },
    endpoint: { method: 'INTERNAL', url: '' },
  },
  {
    name: 'find-coop-opportunities', description: 'Search for co-op placements, internships, or student jobs matching the student\'s program, school, and work-authorization status', category: 'student',
    triggerPatterns: ['find.*(co-?op|internship)', 'find.*job.*(opportunit|posting|listing|search)', '(co-?op|internship).*for', 'search.*(co-?op|internship)', 'look for.*(co-?op|internship|job)'],
    parameters: { query: { type: 'string', required: false, extractHint: 'optional free-text focus, e.g. "remote" or "summer 2027" — omit if the user gave no specifics' } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-career/discover' },
  },
  {
    name: 'save-coop-opportunity', description: 'Save/shortlist a co-op or job opportunity the student just found (or one they describe directly) to their tracked opportunities list', category: 'student',
    triggerPatterns: ['save.*(co-?op|internship|job)', 'track.*(co-?op|internship|job)', 'shortlist.*(co-?op|internship|job)'],
    parameters: {
      title: { type: 'string', required: false, extractHint: 'job/co-op title, only if the user is describing one directly rather than referring back to a search result' },
      employer: { type: 'string', required: false },
      location: { type: 'string', required: false },
      compText: { type: 'string', required: false, extractHint: 'the pay as free text, only for a direct description' },
      deadlineText: { type: 'string', required: false },
      sourceUrl: { type: 'string', required: false },
    },
    endpoint: { method: 'INTERNAL', url: '' },
  },
  {
    name: 'find-roommate-matches', description: 'Find compatible roommate matches based on the student\'s roommate profile (budget, area, move-in date, lifestyle)', category: 'student',
    triggerPatterns: ['roommate', 'find.*roommate', 'compatible.*(student|roommate)', 'match.*roommate'],
    parameters: {},
    endpoint: { method: 'GET', url: '/api/v1/agentbook-housing/roommate/matches' },
  },
  {
    name: 'general-question', description: 'Answer any general financial or accounting question', category: 'finance',
    triggerPatterns: [],
    parameters: { question: { type: 'string', required: true, extractHint: 'the full user message' } },
    endpoint: { method: 'POST', url: '/api/v1/agentbook-core/ask' },
  },
];
