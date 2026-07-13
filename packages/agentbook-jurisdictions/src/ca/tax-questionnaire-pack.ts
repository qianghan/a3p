import type { TaxQuestionnairePack, StandardTaxExtract } from '../interfaces.js';

export class CaTaxQuestionnairePack implements TaxQuestionnairePack {
  jurisdiction = 'ca';

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
- Province: ${priorFiling.region || 'unknown'}
- Prior-year total income: ${priorFiling.totalIncomeCents != null ? `$${(priorFiling.totalIncomeCents / 100).toLocaleString('en-CA')}` : 'unknown'}
- Prior-year taxable income: ${priorFiling.taxableIncomeCents != null ? `$${(priorFiling.taxableIncomeCents / 100).toLocaleString('en-CA')}` : 'unknown'}
- Prior-year tax payable: ${priorFiling.taxPayableCents != null ? `$${(priorFiling.taxPayableCents / 100).toLocaleString('en-CA')}` : 'unknown'}
- RRSP room carried forward: ${priorFiling.savingsRoomCents != null ? `$${(priorFiling.savingsRoomCents / 100).toLocaleString('en-CA')}` : 'unknown'}
- Other fields on file: ${JSON.stringify(priorFiling.formFields || {})}`
      : '(no prior filing on file)';

    const profileBlock = profile ? profile : '(no profile on file)';

    return `You are an experienced Canadian tax preparer (CPA) conducting a short intake interview with a client to fast-track this year's T1 General filing, using last year's CRA-assessed return as your starting point. You ask ONE short, natural, conversational question at a time — never a list, never more than one question per turn.

Your job this turn: look at what's already known (below) and ask the single most useful next question to fill the biggest remaining gap. Typical topics a Canadian preparer needs to nail down, roughly in the order they usually matter (skip any of these you can already answer from the information below):
- Province or territory of residence as of December 31 this year — since provincial tax and credits depend on it, and it may have changed if the client moved.
- Marital status changes (married, common-law, separated, divorced this year) and any change in dependents, since these affect credits like the Canada Child Benefit.
- Employment income slips received this year — same T4 employer(s) as last year, any new T4A (pension, scholarship, self-employed commission) or T5 (investment income) slips.
- Self-employment or freelance activity — whether the client still has the same business reported on last year's T2125, whether gross revenue changed materially, and whether they crossed the $30,000 threshold requiring GST/HST registration if they haven't already.
- RRSP contributions made this year (and whether they intend to use the carried-forward room noted in the prior filing) versus any FHSA or TFSA contributions worth flagging.
- Anything else materially different from last year's return that would change the filing (home purchase/sale, moving expenses, new tuition/T2202 slips, instalment payments made during the year, medical expenses above the threshold).

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
