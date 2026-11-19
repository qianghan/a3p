'use client';

import React from 'react';
import { useT, useShellLocale } from '@/hooks/use-t';
import type { TaxRow as TaxRowView } from '../../_lib/api';
import { Chip, moneyText, tokens } from '../../_kit';

export type TaxMode = 'inclusive' | 'exclusive';

/** Rate codes are acronyms (GST, HST, GST + QST); the worded ones are translated. */
export function useTaxCodeLabel(): (code: string) => string {
  const t = useT();
  return (code: string) => {
    switch (code) {
      case 'FRE': return t('mobile.capture.tax_code_gst_free');
      case 'INP': return t('mobile.capture.tax_code_input_taxed');
      case 'NTR': return t('mobile.capture.tax_code_no_gst');
      case 'CAP': return t('mobile.capture.tax_code_capital');
      case 'ZERO': return t('mobile.capture.tax_code_zero_rated');
      case 'EXEMPT': return t('mobile.capture.tax_code_exempt');
      case 'OUT_OF_SCOPE': return t('mobile.capture.tax_code_out_of_scope');
      default: return code.split('_').join(' + ');
    }
  };
}

const seg = (on: boolean): React.CSSProperties => ({
  flex: 1, minHeight: 44, borderRadius: 10, fontSize: 13,
  border: `1px solid ${on ? tokens.color.primary : tokens.color.border}`,
  background: on ? tokens.color.primary : tokens.color.card,
  color: on ? tokens.color.primaryFg : tokens.color.fg, fontWeight: on ? 600 : 500,
});

export interface TaxRowProps {
  view: TaxRowView;
  code: string | null;
  mode: TaxMode;
  currency: string | null;
  /** Tax printed on the receipt, as OCR read it. */
  printed?: { cents: number | null; label: string | null } | null;
  onCode: (code: string) => void;
  onMode: (mode: TaxMode) => void;
}

export function TaxRow({ view, code, mode, currency, printed, onCode, onMode }: TaxRowProps) {
  const t = useT();
  const locale = useShellLocale();
  const labelOf = useTaxCodeLabel();
  const p = view.preview;
  const money = (c: number) => (currency ? moneyText(c, currency, locale) : (c / 100).toFixed(2));
  return (
    <div data-testid="capture-tax-row" style={{ display: 'grid', gap: 8 }}>
      <div role="group" aria-label={t('mobile.capture.tax_code_label')} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {view.codes.map((c) => (
          <Chip key={c.code} testId={`capture-tax-code-${c.code}`} label={labelOf(c.code)} selected={code === c.code} onClick={() => onCode(c.code)} />
        ))}
      </div>
      <div role="radiogroup" aria-label={t('mobile.capture.tax_mode_label')} style={{ display: 'flex', gap: 8 }}>
        {(['inclusive', 'exclusive'] as const).map((m) => (
          <button key={m} type="button" role="radio" data-testid={`capture-tax-mode-${m}`} aria-checked={mode === m} style={seg(mode === m)} onClick={() => onMode(m)}>
            {m === 'inclusive' ? t('mobile.capture.tax_inclusive') : t('mobile.capture.tax_exclusive')}
          </button>
        ))}
      </div>
      {p && (
        <p data-testid="capture-tax-amount" style={{ margin: 0, fontSize: 13, color: tokens.color.muted }}>
          {t('mobile.capture.tax_amount', { tax: money(p.taxCents), total: money(p.grossCents) })}
        </p>
      )}
      {printed && printed.cents != null && printed.cents > 0 && (
        <p style={{ margin: 0, fontSize: 12, color: tokens.color.muted }}>
          {t('mobile.capture.tax_printed', { label: printed.label ?? '', amount: money(printed.cents) })}
        </p>
      )}
      {view.registrationPrompt && (
        <p data-testid="capture-tax-prompt" style={{ margin: 0, fontSize: 13 }}>
          {t('mobile.capture.tax_registration_prompt')}{' '}
          <a href="/settings" style={{ color: tokens.color.primary }}>{t('mobile.capture.tax_registration_link')}</a>
        </p>
      )}
    </div>
  );
}
