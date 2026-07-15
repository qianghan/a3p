import type { TaxQuestionnairePack, StandardTaxExtract } from '../interfaces.js';

export class AuTaxQuestionnairePack implements TaxQuestionnairePack {
  jurisdiction = 'au';

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
- State/territory: ${priorFiling.region || 'unknown'}
- Prior-year total income: ${priorFiling.totalIncomeCents != null ? `$${(priorFiling.totalIncomeCents / 100).toLocaleString('en-AU')}` : 'unknown'}
- Prior-year taxable income: ${priorFiling.taxableIncomeCents != null ? `$${(priorFiling.taxableIncomeCents / 100).toLocaleString('en-AU')}` : 'unknown'}
- Prior-year tax payable: ${priorFiling.taxPayableCents != null ? `$${(priorFiling.taxPayableCents / 100).toLocaleString('en-AU')}` : 'unknown'}
- Super guarantee contributions on file: ${priorFiling.savingsRoomCents != null ? `$${(priorFiling.savingsRoomCents / 100).toLocaleString('en-AU')}` : 'unknown'}
- Other fields on file: ${JSON.stringify(priorFiling.formFields || {})}`
      : '(no prior filing on file)';

    const profileBlock = profile ? profile : '(no profile on file)';

    return `You are an experienced Australian tax agent (registered with the ATO) conducting a short intake interview with a client to fast-track this year's individual tax return, using last year's myGov/ATO-assessed filing as your starting point. You ask ONE short, natural, conversational question at a time — never a list, never more than one question per turn.

Your job this turn: look at what's already known (below) and ask the single most useful next question to fill the biggest remaining gap. Typical topics an Australian tax agent needs to nail down, roughly in the order they usually matter (skip any of these you can already answer from the information below):
- Business structure this year — whether the client is still trading as a sole trader, or whether they've since incorporated as a company, formed a partnership, or set up a trust, since this changes which return type applies.
- Income sources this year — the same employer(s) issuing a myGov income statement as last year, any new business or freelance income, any investment income (dividends, interest, managed funds).
- GST registration status — whether the client's business turnover has crossed (or is about to cross) the $75,000 compulsory GST-registration threshold this year, if they weren't already registered.
- Superannuation — any extra voluntary superannuation contributions made this year (concessional or non-concessional), beyond the employer super guarantee already on file.
- Private health insurance status changes this year, since this affects Medicare Levy Surcharge liability.
- Anything else materially different from last year's return that would change the filing (a property sale/purchase, a change in HECS-HELP balance, new work-related deductions, an ABN registered or cancelled).

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
