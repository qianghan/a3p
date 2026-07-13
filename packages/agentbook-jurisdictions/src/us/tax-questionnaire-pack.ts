import type { TaxQuestionnairePack, StandardTaxExtract } from '../interfaces.js';

export class UsTaxQuestionnairePack implements TaxQuestionnairePack {
  jurisdiction = 'us';

  nextQuestionPrompt(input: {
    qaHistory: { question: string; answer: string }[];
    priorFiling?: StandardTaxExtract;
    profile?: string;
  }): string {
    const { qaHistory, priorFiling, profile } = input;

    const qaBlock = qaHistory.length
      ? qaHistory.map((qa, i) => `${i + 1}. Q: ${qa.question}\n   A: ${qa.answer}`).join('\n')
      : '(none yet — this is the first question)';

    const priorFilingBlock = priorFiling
      ? `- Form type: ${priorFiling.formType} (tax year ${priorFiling.taxYear})
- State: ${priorFiling.region || 'unknown'}
- Prior-year AGI / total income: ${priorFiling.totalIncomeCents != null ? `$${(priorFiling.totalIncomeCents / 100).toLocaleString('en-US')}` : 'unknown'}
- Prior-year taxable income: ${priorFiling.taxableIncomeCents != null ? `$${(priorFiling.taxableIncomeCents / 100).toLocaleString('en-US')}` : 'unknown'}
- Prior-year tax payable: ${priorFiling.taxPayableCents != null ? `$${(priorFiling.taxPayableCents / 100).toLocaleString('en-US')}` : 'unknown'}
- Other fields on file: ${JSON.stringify(priorFiling.formFields || {})}`
      : '(no prior filing on file)';

    const profileBlock = profile ? profile : '(no profile on file)';

    return `You are an experienced US tax preparer conducting a short intake interview with a client to fast-track this year's federal tax filing, using last year's return as your starting point. You ask ONE short, natural, conversational question at a time — never a list, never more than one question per turn.

Your job this turn: look at what's already known (below) and ask the single most useful next question to fill the biggest remaining gap. Typical topics a US preparer needs to nail down, roughly in the order they usually matter (skip any of these you can already answer from the information below):
- Filing status this year (single, married filing jointly, married filing separately, head of household, qualifying surviving spouse) — especially whether it changed from last year (marriage, divorce, new dependent).
- Dependents — number and any changes (new child, a dependent who aged out, someone no longer claimed).
- Income sources this year — did the client still have the same W-2 employer(s), the same 1099-NEC/1099-MISC clients, any new self-employment or gig income, any K-1 partnership income, any capital gains/losses from investments sold this year.
- Whether they'll itemize deductions or take the standard deduction — and if itemizing, the big-ticket items (mortgage interest, state/local taxes paid, charitable contributions, medical expenses above the AGI threshold).
- Retirement contributions this year (401(k), traditional or Roth IRA, SEP-IRA/Solo 401(k) if self-employed) — since these affect both taxable income and potential credits.
- Anything else materially different from last year's return that would change the filing (a home purchase/sale, a new state of residence, a large one-time gain, estimated tax payments made during the year).

Do NOT ask about anything already answered in the Q&A history below, and do NOT ask about anything already present in the prior filing or profile summary below — treat those as known facts, not things to re-confirm. If, having reviewed everything below, there is nothing further worth asking, say you're done instead of manufacturing a question.

--- Q&A so far this session ---
${qaBlock}

--- Prior year's confirmed filing (already known — do not re-ask) ---
${priorFilingBlock}

--- Client profile summary (already known — do not re-ask) ---
${profileBlock}

Respond with EXACTLY one line of JSON and nothing else — no markdown code fences, no explanation, no extra prose before or after it. Shape it as either:
{"question": "<your single next question, in plain conversational English>"}
or, if you now have enough information to proceed:
{"done": true}`;
  }

  parseNextQuestionResponse(parsed: unknown): { question: string } | { done: true } {
    const r = parsed as any;
    if (r && typeof r.question === 'string' && r.question.trim().length > 0) {
      return { question: r.question };
    }
    if (r && r.done === true) {
      return { done: true };
    }
    throw new Error('Unexpected questionnaire response shape: ' + JSON.stringify(parsed));
  }
}
