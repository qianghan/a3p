import type { FilingDraftPack, FilingDraftDeltas, FilingDraftSummary, StandardTaxExtract } from '../interfaces.js';

export class UsFilingDraftPack implements FilingDraftPack {
  jurisdiction = 'us';

  extractDeltasPrompt(input: {
    qaHistory: { question: string; answer: string }[];
    priorFiling: StandardTaxExtract;
  }): string {
    const { qaHistory, priorFiling } = input;
    const qaBlock = qaHistory.map((qa, i) => `${i + 1}. Q: ${qa.question}\n   A: ${qa.answer}`).join('\n');
    const priorFilingBlock = `- Form type: ${priorFiling.formType} (tax year ${priorFiling.taxYear})
- State: ${priorFiling.region || 'unknown'}
- Prior-year total income: ${priorFiling.totalIncomeCents != null ? `$${(priorFiling.totalIncomeCents / 100).toLocaleString('en-US')}` : 'unknown'}
- Prior-year taxable income: ${priorFiling.taxableIncomeCents != null ? `$${(priorFiling.taxableIncomeCents / 100).toLocaleString('en-US')}` : 'unknown'}
- Other fields on file: ${JSON.stringify(priorFiling.formFields || {})}`;

    return `You are an experienced US tax preparer reviewing a completed client intake interview to identify what's DIFFERENT about this year's filing compared to last year's confirmed return. You do NOT calculate any tax figures yourself — that happens separately from real bracket tables. Your only job is to extract structured signal from the interview answers below.

--- Prior year's confirmed filing (baseline) ---
${priorFilingBlock}

--- This year's intake interview ---
${qaBlock}

From the interview, determine:
- Roughly how this year's total income compares to last year's, as a signed percentage (e.g. +5 for "a little higher", -10 for "noticeably lower", omit entirely if the client gave no usable signal on income).
- Whether filing status changed, and if so what it changed to.
- The net change in number of dependents (a signed integer; 0 if explicitly unchanged, omit if not discussed).
- A short list of plain-language bullets describing what's materially different from last year (skip this if nothing changed).
- A short list of open questions this client's accountant should double-check before filing (things the interview didn't fully resolve, or that need professional judgment).

Respond with EXACTLY one JSON object and nothing else — no markdown code fences, no explanation. Shape it as:
{"incomeDeltaPercent": <number, optional>, "filingStatusChanged": <boolean, optional>, "newFilingStatus": "<string, optional>", "dependentsDelta": <number, optional>, "changesFromLastYear": ["<bullet>", ...], "openQuestions": ["<bullet>", ...]}`;
  }

  parseDeltas(parsed: unknown): FilingDraftDeltas {
    const r = parsed as any;
    if (!r || typeof r !== 'object') {
      throw new Error('Unexpected delta-extraction response shape: ' + JSON.stringify(parsed));
    }
    return {
      incomeDeltaPercent: typeof r.incomeDeltaPercent === 'number' ? r.incomeDeltaPercent : undefined,
      filingStatusChanged: typeof r.filingStatusChanged === 'boolean' ? r.filingStatusChanged : undefined,
      newFilingStatus: typeof r.newFilingStatus === 'string' ? r.newFilingStatus : undefined,
      dependentsDelta: typeof r.dependentsDelta === 'number' ? r.dependentsDelta : undefined,
      changesFromLastYear: Array.isArray(r.changesFromLastYear) ? r.changesFromLastYear.filter((x: unknown) => typeof x === 'string') : [],
      openQuestions: Array.isArray(r.openQuestions) ? r.openQuestions.filter((x: unknown) => typeof x === 'string') : [],
    };
  }

  clientLetterPrompt(input: {
    qaHistory: { question: string; answer: string }[];
    priorFiling: StandardTaxExtract;
    summary: FilingDraftSummary;
  }): string {
    const { summary } = input;
    const numbersBlock = summary.estimatedTaxPayableCents != null
      ? `- Estimated total income: ${summary.estimatedTotalIncomeCents != null ? `$${(summary.estimatedTotalIncomeCents / 100).toLocaleString('en-US')}` : 'not estimated'}
- Estimated taxable income: ${summary.estimatedTaxableIncomeCents != null ? `$${(summary.estimatedTaxableIncomeCents / 100).toLocaleString('en-US')}` : 'not estimated'}
- Estimated tax payable: $${(summary.estimatedTaxPayableCents / 100).toLocaleString('en-US')}
- Compared to last year's actual tax payable: ${summary.taxPayableDeltaVsLastYearCents != null ? `${summary.taxPayableDeltaVsLastYearCents >= 0 ? 'up' : 'down'} $${Math.abs(summary.taxPayableDeltaVsLastYearCents / 100).toLocaleString('en-US')}` : 'not available (no prior-year tax payable on file to compare against)'}
(Note: this does NOT account for withholding or estimated payments made this year, so it is not a refund-or-balance-owing figure — just how the underlying tax liability compares to last year.)`
      : '(no numeric estimate available — the prior filing on file did not have enough baseline data to compute one)';

    return `Write a short, professional cover letter from a freelance/self-employed taxpayer to their own accountant or bookkeeper, to accompany this year's tax documents. The letter should:
- Be addressed generically ("Dear [Accountant's name]," is fine as a placeholder)
- State plainly that this is a fast-tracked estimate prepared with the help of an AI assistant, based on last year's confirmed return plus this year's changes — not a final calculation
- Summarize what changed this year (below)
- Include the estimated figures (below), clearly labeled as estimates
- List the open questions the accountant should double-check
- Close politely, offering to answer any follow-up questions

--- What changed this year ---
${summary.changesFromLastYear.length ? summary.changesFromLastYear.map((c) => `- ${c}`).join('\n') : '- No material changes identified'}

--- Estimated figures ---
${numbersBlock}

--- Open questions for the accountant ---
${summary.openQuestions.length ? summary.openQuestions.map((q) => `- ${q}`).join('\n') : '- None identified'}

Respond with EXACTLY one JSON object and nothing else — no markdown code fences, no explanation. Shape it as:
{"letterBody": "<the full letter text, with \\n for paragraph breaks>"}`;
  }

  parseClientLetter(parsed: unknown): { letterBody: string } {
    const r = parsed as any;
    if (r && typeof r.letterBody === 'string' && r.letterBody.trim().length > 0) {
      return { letterBody: r.letterBody };
    }
    throw new Error('Unexpected client-letter response shape: ' + JSON.stringify(parsed));
  }
}
