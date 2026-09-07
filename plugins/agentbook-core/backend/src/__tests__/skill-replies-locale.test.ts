import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { replyT } from '../reply-locale';

/**
 * The query-expenses answers — "You have 12 expenses totaling $1,240.00 for
 * last month", the top-vendor list, the nothing-found states. All interface
 * copy: labels, counts and empty states, no tax or money advice, so all three
 * locales carry a real translation.
 *
 * Advice-shaped replies are deliberately NOT in this namespace. The catalog
 * invariants keep a separate ENGLISH_ONLY_KEYS list for those, because a
 * fluent mistranslation of tax guidance is a liability rather than a cosmetic
 * bug.
 */

const CATALOG_DIR = join(__dirname, '../../../../../packages/agentbook-i18n/src/locales');
const load = (loc: string) =>
  JSON.parse(readFileSync(join(CATALOG_DIR, loc, 'skill.json'), 'utf8')) as Record<string, string>;

describe('the query-expenses answers speak the tenant language', () => {
  it('answers a populated query in each locale', () => {
    const params = { count: 12, amount: '$1,240.00', period: 'last month' };
    expect(replyT({ locale: 'en-US' })('skill.expenses_summary', params)).toBe(
      'You have 12 expenses totaling $1,240.00 for last month.',
    );
    expect(replyT({ locale: 'fr-CA' })('skill.expenses_summary', params)).toBe(
      'Vous avez 12 dépenses totalisant $1,240.00 pour last month.',
    );
    expect(replyT({ locale: 'zh-CN' })('skill.expenses_summary', params)).toContain('12 笔支出');
  });

  it('selects the singular for one expense, in every locale', () => {
    const p = { count: 1, amount: '$42.00', period: 'today' };
    expect(replyT({ locale: 'en-US' })('skill.expenses_summary', p)).toContain('1 expense totaling');
    expect(replyT({ locale: 'fr-CA' })('skill.expenses_summary', p)).toContain('1 dépense totalisant');
  });

  it('French treats zero as singular — the reason plural variants exist', () => {
    // fr uses the singular for 0 where English uses the plural. A single
    // count-bearing string would be wrong in French from the first render.
    const p = { count: 0, amount: '$0.00', period: 'today' };
    expect(replyT({ locale: 'en-US' })('skill.expenses_summary', p)).toContain('0 expenses');
    expect(replyT({ locale: 'fr-CA' })('skill.expenses_summary', p)).toContain('0 dépense ');
  });

  it('the list lead-in agrees in number', () => {
    expect(replyT({ locale: 'en-US' })('skill.here_it_is', { count: 1 })).toBe('Here it is:');
    expect(replyT({ locale: 'en-US' })('skill.here_it_is', { count: 3 })).toBe('Here they are:');
    expect(replyT({ locale: 'fr-CA' })('skill.here_it_is', { count: 1 })).toBe('La voici :');
    expect(replyT({ locale: 'fr-CA' })('skill.here_it_is', { count: 3 })).toBe('Les voici :');
  });

  it('never leaks a key to the user when a locale is unknown', () => {
    const out = replyT({ locale: 'xx-YY' })('skill.expenses_none_for_period', { period: 'today' });
    expect(out).toBe('No expenses found for today.');
    expect(out).not.toContain('skill.');
  });
});

describe('every skill.* key the reply path asks for exists', () => {
  // t() returns the KEY on a miss, so a typo ships to the user as
  // "skill.expenses_summry". Parity tests compare catalogs to each other and
  // cannot see a code-to-catalog miss.
  const SRC = readFileSync(join(__dirname, '../server.ts'), 'utf8');
  const en = load('en');
  const used = [...SRC.matchAll(/\bt\('skill\.([a-z0-9_]+)'/g)].map((m) => m[1]);

  it('finds the call sites (not vacuous)', () => {
    expect(new Set(used).size).toBeGreaterThanOrEqual(6);
  });

  it('resolves every key, counting plural variants', () => {
    const missing = used.filter(
      (k) => !(k in en) && !(`${k}_one` in en && `${k}_other` in en),
    );
    expect(missing, 'skill.* keys used in server.ts but absent from en/skill.json').toEqual([]);
  });

  it('leaves no English literal behind in the branch it replaced', () => {
    const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const gone of [
      'No expenses found for ${periodLabel}',
      'No business expenses found for ${periodLabel}',
      'Top vendors (${periodLabel})',
      "Here ${recentExpenses.length === 1 ? 'it is' : 'they are'}",
      // The skill failure cluster. Without these the catalog tests above pass
      // on a fully reverted server.ts — they exercise replyT, not the wiring.
      "I couldn't record that expense.",
      "I couldn't create that.",
      'I need a client name and amount.',
      "I couldn't record the payment.",
      "I couldn't record that transaction.",
      "I couldn't find an invoice to send. Try:",
      // The report-builder labels.
      '\\nGross Revenue: ',
      '\\nNet Income: ',
      '\\nSE Tax: ',
      '\\nIncome Tax: ',
      '**Total Tax: ',
      '\\nEffective Rate: ',
      '\\n\\nTotal Due: ',
      '**Total Unbilled:**',
      // Balance sheet, cash flow, snapshot, reconciliation.
      '\\nAssets: ',
      '\\nLiabilities: ',
      '**Equity: ',
      '\\nCurrent Cash: ',
      '\\nOutstanding Invoices: ',
      '\\nMonthly Recurring: ',
      '\\nCash: ',
      '\\nRevenue (this month): ',
      '\\nExpenses (this month): ',
      '**Profit: ',
      '\\nMatched Amount: ',
      '\\nUnmatched Amount: ',
      // Section headers.
      "message = '**Balance Sheet**",
      "message = '**Profit & Loss**",
      "message = '**Tax Estimate**",
      "message = '**Bank Reconciliation**",
      "message = '**Cash Flow Projection**",
      "message = '**Accounts Receivable Aging**",
      // Inline plural ternaries — the shape that cannot survive translation.
      "expense${data.length === 1 ? '' : 's'}",
      "recurring pattern${data.length === 1 ? '' : 's'}",
      "scholarship${data.candidates.length === 1 ? '' : 's'}",
      "opportunit${data.candidates.length === 1 ? 'y' : 'ies'}",
      "open bill${bills.length === 1 ? '' : 's'}",
      "employee${employees.length === 1 ? '' : 's'}",
      'Ready to run payroll for',
      // Final tranche: write confirmations and empty states.
      'message = `Recorded: ',
      'message = `Invoice ${data.number} created',
      'Timer stopped. Duration:',
      'No overdue invoices found.',
      'All your expenses are already categorized!',
      'Sent payment reminders for',
      'There are no active employees to pay.',
      'Payment recorded${amt',
      'Recorded a bill: **',
      'You have no open bills.',
      'No recurring patterns detected yet',
      'Overall completeness: **',
      'Tax return PDF generated!',
      'Expense split into ${parts.length} parts',
      'Applied **${applied}** categor',
      'Estimate created${amt',
      'Timer started${data.description',
      'Confidence: ${Math.round',
      'Net-worth trends are part of Personal Insights',
      'Tax Fast-Track is a paid add-on',
      "'No compatible students found yet.'",
      'Net worth: ${fmt(net)}',
      'Tax Filing ${taxYear}',
      'Tax Filing ${data.taxYear',
      'compatible student${data.matches',
      'Got everything I need from your last return',
      'Here are your past tax filings:',
      "I reviewed ${uncategorized.length} expense",
      'Invoice created${data.number',
    ]) {
      expect(stripped, gone).not.toContain(gone);
    }
  });
});

describe('the failure replies speak the tenant language', () => {
  it('gives the reason clause its own whole sentence per language', () => {
    // Composing "I couldn't record that expense." + "Error: X" from fragments
    // assumes English word order. Each variant is a complete sentence.
    expect(replyT({ locale: 'en-US' })('skill.expense_record_failed_reason', { detail: 'db down' })).toBe(
      "I couldn't record that expense. Error: db down",
    );
    expect(replyT({ locale: 'fr-CA' })('skill.expense_record_failed_reason', { detail: 'db down' })).toBe(
      "Je n'ai pas pu enregistrer cette dépense. Erreur : db down",
    );
    expect(replyT({ locale: 'zh-CN' })('skill.expense_record_failed')).toBe('无法记录这笔支出。请重试。');
  });

  it('keeps the worked examples usable in each language', () => {
    // These strings teach the user what to type. A French user typing the
    // English example would still work, but reading it should not require
    // English.
    const fr = replyT({ locale: 'fr-CA' })('skill.invoice_need_client');
    expect(fr).toContain('Facture Acme');
    expect(fr).toContain('5000 $');
    const zh = replyT({ locale: 'zh-CN' })('skill.payment_need_reference');
    expect(zh).toContain('INV-2026-0001');
  });

  it('preserves the bullet layout the chat surfaces render', () => {
    // Telegram runs these through mdToHtml; losing the newlines would run the
    // examples together into one line.
    for (const loc of ['en-US', 'fr-CA', 'zh-CN']) {
      const out = replyT({ locale: loc })('skill.send_invoice_not_found');
      expect(out.split('\n').length, loc).toBeGreaterThanOrEqual(3);
      expect(out, loc).toContain('•');
    }
  });
});

describe('the report labels speak the tenant language', () => {
  it('renders a P&L line per locale', () => {
    const p = { amount: '$1,240.00' };
    expect(replyT({ locale: 'en-US' })('skill.report_gross_revenue', p)).toBe('Gross Revenue: $1,240.00');
    expect(replyT({ locale: 'fr-CA' })('skill.report_gross_revenue', p)).toBe('Revenus bruts : $1,240.00');
    expect(replyT({ locale: 'zh-CN' })('skill.report_gross_revenue', p)).toBe('总收入：$1,240.00');
  });

  it('keeps the markdown emphasis the chat surfaces render', () => {
    // Telegram converts these with mdToHtml. A translation that drops the
    // asterisks loses the bold on the total, silently.
    for (const loc of ['en-US', 'fr-CA', 'zh-CN']) {
      const out = replyT({ locale: loc })('skill.report_total_tax', { amount: '$1.00' });
      expect(out.startsWith('**') && out.endsWith('**'), `${loc}: ${out}`).toBe(true);
    }
  });

  it('labels a quarter without assuming the English letter', () => {
    expect(replyT({ locale: 'en-US' })('skill.report_quarter_due', { quarter: 3, amount: '$1.00' })).toBe(
      'Q3: $1.00',
    );
    // French uses T for trimestre.
    expect(replyT({ locale: 'fr-CA' })('skill.report_quarter_due', { quarter: 3, amount: '$1.00' })).toBe(
      'T3 : $1.00',
    );
  });
});

describe('the balance sheet and cash flow labels', () => {
  it('renders each locale', () => {
    const p = { amount: '$100.00' };
    expect(replyT({ locale: 'fr-CA' })('skill.report_assets', p)).toBe('Actifs : $100.00');
    expect(replyT({ locale: 'fr-CA' })('skill.report_liabilities', p)).toBe('Passifs : $100.00');
    expect(replyT({ locale: 'zh-CN' })('skill.report_current_cash', p)).toBe('当前现金：$100.00');
  });

  it('keeps the bold on equity and profit, which mdToHtml renders', () => {
    for (const loc of ['en-US', 'fr-CA', 'zh-CN']) {
      for (const key of ['skill.report_equity', 'skill.report_profit']) {
        const out = replyT({ locale: loc })(key, { amount: '$1.00' });
        expect(out.startsWith('**') && out.endsWith('**'), `${loc} ${key}: ${out}`).toBe(true);
      }
    }
  });

  it('every skill.* key now in the catalog is reachable and non-empty', () => {
    // A key added to the catalog but spelled differently at the call site is
    // invisible to the parity invariants; this at least proves each resolves.
    const t = replyT({ locale: 'fr-CA' });
    for (const key of ['skill.report_assets', 'skill.report_profit', 'skill.report_matched_amount']) {
      const out = t(key, { amount: '$1.00', count: 1 });
      expect(out, key).not.toBe(key);
      expect(out.length, key).toBeGreaterThan(2);
    }
  });
});

describe('the report headers', () => {
  it('name the report in each language', () => {
    expect(replyT({ locale: 'fr-CA' })('skill.hdr_pnl')).toBe('**État des résultats**');
    expect(replyT({ locale: 'fr-CA' })('skill.hdr_balance_sheet')).toBe('**Bilan**');
    expect(replyT({ locale: 'zh-CN' })('skill.hdr_cash_flow')).toBe('**现金流预测**');
  });

  it('uses the accounting term, not a literal gloss', () => {
    // "Profit & Loss" is "État des résultats" in Québec accounting, not
    // "Profit et perte"; "Accounts Receivable Aging" is "Âge des comptes
    // clients". A literal translation reads as machine output to an
    // accountant.
    const fr = replyT({ locale: 'fr-CA' });
    expect(fr('skill.hdr_pnl')).not.toContain('Profit');
    expect(fr('skill.hdr_ar_aging')).toContain('comptes clients');
    expect(fr('skill.hdr_quarterly_tax')).toContain('Acomptes provisionnels');
  });

  it('keeps every header bold', () => {
    for (const loc of ['en-US', 'fr-CA', 'zh-CN']) {
      for (const k of ['hdr_pnl', 'hdr_balance_sheet', 'hdr_tax_slips', 'hdr_unbilled_time']) {
        const out = replyT({ locale: loc })(`skill.${k}`);
        expect(out.startsWith('**') && out.endsWith('**'), `${loc} ${k}: ${out}`).toBe(true);
      }
    }
  });
});

describe('the count-bearing replies pluralise per language', () => {
  it('agrees in number in French, where the noun and participle both inflect', () => {
    const fr = replyT({ locale: 'fr-CA' });
    expect(fr('skill.scholarships_found', { count: 1 })).toBe('**1 bourse trouvée**\n');
    expect(fr('skill.scholarships_found', { count: 4 })).toBe('**4 bourses trouvées**\n');
    // English hides this: "found" does not change, so a single string looks
    // fine in English and is wrong in French twice over.
    expect(fr('skill.recurring_detected', { count: 1 })).toContain('détectée');
    expect(fr('skill.recurring_detected', { count: 3 })).toContain('détectées');
  });

  it('treats zero as singular in French and plural in English', () => {
    expect(replyT({ locale: 'en-US' })('skill.review_queue', { count: 0 })).toContain('expenses need');
    expect(replyT({ locale: 'fr-CA' })('skill.review_queue', { count: 0 })).toContain('dépense à');
  });

  it('uses one form for Chinese, without special casing at the call site', () => {
    const zh = replyT({ locale: 'zh-CN' });
    expect(zh('skill.review_queue', { count: 1 })).toBe(zh('skill.review_queue', { count: 9 }).replace('9', '1'));
  });
});

describe('replies that point at a page in the web UI', () => {
  it('names the page in English, because the shell may not be translated', () => {
    // The shell's own translation is behind a feature flag. A French reply
    // telling the user to open « Paie » would name a tab that still reads
    // "Payroll" — an instruction they cannot follow.
    const fr = replyT({ locale: 'fr-CA' })('skill.payroll_ready_estimate', {
      count: 3,
      gross: '5 000,00 $',
      page: 'Payroll',
    });
    expect(fr).toContain('Ouvrez la page **Payroll**');
    expect(fr).not.toContain('Paie**');

    const zh = replyT({ locale: 'zh-CN' })('skill.payroll_ready_estimate', {
      count: 3,
      gross: '¥5,000.00',
      page: 'Payroll',
    });
    expect(zh).toContain('**Payroll**');
  });

  it('keeps the literal button label the user must click', () => {
    for (const loc of ['en-US', 'fr-CA', 'zh-CN']) {
      const out = replyT({ locale: loc })('skill.payroll_ready_exact', {
        count: 1, gross: 'x', withheld: 'y', net: 'z', page: 'Payroll',
      });
      expect(out, loc).toContain('Run payroll');
    }
  });

  it('still agrees in number around the untranslated page name', () => {
    const fr = replyT({ locale: 'fr-CA' });
    expect(fr('skill.payroll_on_payroll', { count: 1 })).toContain('1 employé**');
    expect(fr('skill.payroll_on_payroll', { count: 5 })).toContain('5 employés**');
  });
});

describe('the write confirmations', () => {
  it('confirm in the tenant language', () => {
    const fr = replyT({ locale: 'fr-CA' });
    expect(fr('skill.invoice_created', { number: 'INV-1', amount: '5 000,00 $' })).toBe(
      'Facture INV-1 créée — 5 000,00 $',
    );
    expect(fr('skill.timer_stopped', { minutes: 45 })).toBe('Minuteur arrêté. Durée : 45 minutes.');
    expect(replyT({ locale: 'zh-CN' })('skill.all_categorized')).toBe('您的所有支出都已分类完成！做得好。');
  });

  it('keeps the identifier and the page name findable', () => {
    // An invoice number is an identifier, and a page name is something the
    // user has to locate on a screen whose own translation is flag-gated.
    const fr = replyT({ locale: 'fr-CA' });
    expect(fr('skill.invoice_created', { number: 'INV-2026-0001', amount: 'x' })).toContain(
      'INV-2026-0001',
    );
    expect(fr('skill.payroll_no_employees', { page: 'Payroll' })).toContain('**Payroll**');
  });

  it('does not lose the emoji that carries the status', () => {
    // The cross is the only signal that this is a failure before the text is
    // read; a translation that drops it changes what the message looks like
    // at a glance.
    for (const loc of ['en-US', 'fr-CA', 'zh-CN']) {
      expect(replyT({ locale: loc })('skill.filing_failed', { error: 'x' }), loc).toContain('❌');
    }
  });
});

describe('the gated-feature messages', () => {
  it('translate the sentence but not the product names inside it', () => {
    // "Personal Insights", "Personal Finance", "Settings" and "Tax
    // Fast-Track" are things the user has to find on a screen whose own
    // translation is flag-gated. The sentence is French; the names are not.
    const fr = replyT({ locale: 'fr-CA' });
    const trend = fr('skill.net_worth_trend_gated');
    expect(trend).toContain('Personal Insights');
    expect(trend).toContain('Personal Finance');
    expect(trend).toContain('valeur nette');

    const ft = fr('skill.fast_track_gated');
    expect(ft).toContain('Tax Fast-Track');
    expect(ft).toContain('Settings');
    expect(ft).toContain('module payant');
  });

  it('agrees in number when reporting how many categories were applied', () => {
    const fr = replyT({ locale: 'fr-CA' });
    expect(fr('skill.categorized_all', { count: 1 })).toContain('catégorie appliquée');
    expect(fr('skill.categorized_all', { count: 6 })).toContain('catégories appliquées');
  });
});

