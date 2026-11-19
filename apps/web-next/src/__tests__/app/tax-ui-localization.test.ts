/** Tax row cents + localized tax-code chips + Business Profile labels (per jurisdiction x locale). */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/hooks/use-t', () => ({ useShellLocale: () => 'en-US', useT: () => (k: string) => k }));
import { moneyText, moneyTextExact } from '@/app/app/_kit/Money';

const cat = (loc: string, f: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(__dirname, '../../../../../packages/agentbook-i18n/src/locales', loc, `${f}.json`), 'utf8'));
const fmt = (loc: string, ccy: string, n: number) =>
  new Intl.NumberFormat(loc, { style: 'currency', currency: ccy, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

describe('moneyTextExact', () => {
  it('keeps cents (AU)', () => {
    expect(moneyTextExact(1000, 'AUD', 'en-AU')).toBe(fmt('en-AU', 'AUD', 10));
    expect(moneyTextExact(11000, 'AUD', 'en-AU')).toBe(fmt('en-AU', 'AUD', 110));
    expect(moneyTextExact(1000, 'AUD', 'en-AU')).toMatch(/10\.00$/);
  });
  it('keeps cents (fr-CA, CAD)', () => {
    expect(moneyTextExact(1211, 'CAD', 'fr-CA')).toBe(fmt('fr-CA', 'CAD', 12.11));
    expect(moneyTextExact(1211, 'CAD', 'fr-CA')).toContain('12,11');
    expect(moneyTextExact(11300, 'CAD', 'fr-CA')).toContain('113,00');
  });
  it('KPI moneyText still rounds to whole units', () => {
    expect(moneyText(1211, 'CAD', 'fr-CA')).not.toContain('12,11');
  });
});

describe('tax-code chip labels', () => {
  const FR = { gst: 'TPS', hst: 'TVH', gst_pst: 'TPS + TVP', gst_qst: 'TPS + TVQ' };
  for (const f of ['mobile', 'expenses_ui'] as const) {
    const get = (loc: string, k: string) => {
      const c = cat(loc, f) as Record<string, any>;
      return (f === 'mobile' ? c.capture : c)[`tax_code_${k}`];
    };
    it(`${f}: fr-CA CA codes use TPS/TVH/TVP/TVQ; AU GST stays GST`, () => {
      for (const [k, v] of Object.entries(FR)) expect(get('fr-CA', `ca_${k}`)).toBe(v);
      expect(get('fr-CA', 'au_gst')).toBe('GST (Australie)');
    });
    it(`${f}: en acronyms, zh-CN translated`, () => {
      expect(get('en', 'ca_gst_pst')).toBe('GST + PST');
      expect(get('en', 'ca_gst_qst')).toBe('GST + QST');
      expect(get('en', 'au_gst')).toBe('GST');
      expect(get('zh-CN', 'ca_gst_qst')).toBe('GST + 魁北克销售税（QST）');
      expect(get('zh-CN', 'au_gst')).toBe('商品服务税（GST）');
    });
  }
});

describe('Business Profile labels', () => {
  const core = (loc: string) => cat(loc, 'core_ui') as Record<string, string>;
  it('CA reporting basis is per-jurisdiction and not mixed-language in fr-CA', () => {
    expect(core('fr-CA').gst_basis_label_ca).toBe('Méthode de déclaration de la TPS/TVH');
    expect(core('fr-CA').gst_basis_label).toBe('Méthode de déclaration de la GST');
    expect(core('en').gst_basis_label_ca).toBe('GST/HST reporting basis');
    expect(core('zh-CN').gst_basis_label_ca).toBe('GST/HST 申报基础');
  });
  it('AU registration label does not repeat the Australia hint', () => {
    for (const loc of ['en', 'fr-CA', 'zh-CN']) {
      const c = core(loc);
      expect(c.gst_registered_label).not.toMatch(/Australia|australienne|澳大利亚/);
      expect(c.gst_registered_au_hint).toMatch(/Australia|Australie|澳大利亚/);
    }
  });
});
