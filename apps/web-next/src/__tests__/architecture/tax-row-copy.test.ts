/**
 * PR 2b.8 (T6a review minor 3) — tax-row copy that is shown to AU AND CA tenants.
 *  - The registration prompt must not name one country's tax: AU says GST, CA
 *    says GST/HST, so a GST-only sentence is wrong for an Ontario tenant.
 *  - fr-CA "input-taxed" (ATO concept: no GST credit on the purchase) was the
 *    literal « Imposé à l’entrée », which reads as "taxed on input" — the
 *    opposite of what the code means to a francophone bookkeeper.
 */
import { describe, it, expect } from 'vitest';
import { CATALOG } from '@agentbook/i18n/catalog';

const get = (loc: string, path: string): string =>
  path.split('.').reduce((o: any, k) => o?.[k], (CATALOG as any)[loc]) as string;
const PROMPTS = ['expenses_ui.tax_registration_prompt', 'mobile.capture.tax_registration_prompt'];

describe('tax row copy', () => {
  for (const loc of ['en', 'fr-CA', 'zh-CN']) {
    for (const key of PROMPTS) {
      it(`${loc} ${key} is jurisdiction-neutral`, () => {
        const s = get(loc, key);
        expect(s).toBeTruthy();
        expect(s).not.toMatch(/\bGST\b|\bTPS\b|\bHST\b|\bTVH\b/);
      });
    }
  }
  it('fr-CA input-taxed says "no credit", not "taxed on input"', () => {
    for (const key of ['expenses_ui.tax_code_input_taxed', 'mobile.capture.tax_code_input_taxed']) {
      const s = get('fr-CA', key);
      expect(s).not.toMatch(/Imposé à l’entrée/);
      expect(s).toMatch(/sans crédit/);
    }
  });
});
