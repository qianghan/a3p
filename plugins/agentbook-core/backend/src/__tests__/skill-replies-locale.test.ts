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

