/**
 * Web review tab for the Tax Review Agent (PR 15).
 *
 * Talks directly to the review endpoints added in Task 13
 * (`/api/v1/agentbook-tax/tax-filing/:year/review/*`):
 *   • POST review/start    — grounded summary + critical fields to confirm.
 *   • POST review/edit-field — apply a correction (formCode/fieldId/valueCents).
 *   • POST review/message  — free-text Q&A about any number on the filing.
 *   • POST review/confirm  — submit the filing.
 *
 * First page in this plugin frontend to call `t()` — via the shell-injected
 * `useI18n()` hook, not a direct `@agentbook/i18n` import; every sibling tab
 * (TaxPackageContent, PastFilingsPage, FastTrackTab) stays hardcoded
 * English, unchanged by this task.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useI18n } from '@naap/plugin-sdk';
import { TaxDisclaimer } from '../components/TaxDisclaimer';
import { useTenantCurrency } from '../hooks/useTenantCurrency';

const API = '/api/v1/agentbook-tax';

interface CriticalField {
  formCode: string;
  fieldId: string;
  label: string;
  currentValue: number | string | boolean | null;
}
interface ComputedTotals {
  totalIncomeCents?: number;
  taxableIncomeCents?: number;
  taxPayableCents?: number;
}

export const TaxFilingReviewTab: React.FC<{ taxYear: number }> = ({ taxYear }) => {
  const { t, formatMoney } = useI18n();
  const [message, setMessage] = useState('');
  const [fields, setFields] = useState<CriticalField[]>([]);
  const [totals, setTotals] = useState<ComputedTotals>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const loadReview = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`${API}/tax-filing/${taxYear}/review/start`, { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      setMessage(json.data.message);
      setFields(json.data.criticalFields || []);
      setTotals(json.data.computedTotals || {});
    }
    setLoading(false);
  }, [taxYear]);

  useEffect(() => { loadReview(); }, [loadReview]);

  // Called after the review-load effect above so the initial `review/start`
  // request is always the first network call this component makes. The
  // tenant's real currency (rather than a hardcoded 'USD') only affects
  // display formatting below, so this ordering has no effect on users.
  const currency = useTenantCurrency();

  const saveField = async (field: CriticalField) => {
    const raw = edits[field.fieldId];
    if (raw === undefined) return;
    const valueCents = Math.round(Number(raw) * 100);
    if (!Number.isFinite(valueCents)) return;
    const res = await fetch(`${API}/tax-filing/${taxYear}/review/edit-field`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ formCode: field.formCode, fieldId: field.fieldId, valueCents }),
    });
    const json = await res.json();
    if (json.success) {
      setTotals(json.data.computedTotals || totals);
      setMessage(json.data.message);
    }
  };

  const askQuestion = async () => {
    if (!question.trim()) return;
    const res = await fetch(`${API}/tax-filing/${taxYear}/review/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: question }),
    });
    const json = await res.json();
    if (json.success) setAnswer(json.data.message);
    setQuestion('');
  };

  const submit = async () => {
    setSubmitting(true);
    const res = await fetch(`${API}/tax-filing/${taxYear}/review/confirm`, { method: 'POST' });
    const json = await res.json();
    if (json.success) setMessage(json.data.message);
    setSubmitting(false);
  };

  if (loading) return <div className="p-4 sm:p-6">{t('common.loading')}</div>;

  return (
    <div className="px-4 py-5 sm:p-6 max-w-2xl mx-auto">
      <TaxDisclaimer />
      <h2 className="text-lg font-semibold mt-4 mb-2">{t('tax.tax_review_title')}</h2>

      <div className="bg-card border border-border rounded-xl p-4 mb-4">
        <div className="text-sm font-medium text-muted-foreground mb-1">{t('tax.tax_review_summary_label')}</div>
        <p className="text-sm">{message}</p>
      </div>

      <div className="space-y-3 mb-4">
        {fields.map((field) => (
          <div key={`${field.formCode}:${field.fieldId}`} className="flex items-center gap-2">
            <label className="flex-1 text-sm">{field.label}</label>
            <input
              type="number"
              className="w-32 border border-border rounded px-2 py-1 text-sm"
              value={edits[field.fieldId] ?? (typeof field.currentValue === 'number' ? String(field.currentValue / 100) : '')}
              onChange={(e) => setEdits((prev) => ({ ...prev, [field.fieldId]: e.target.value }))}
            />
            <button onClick={() => saveField(field)} className="text-sm text-primary">{t('common.save')}</button>
          </div>
        ))}
      </div>

      {totals.taxPayableCents != null && (
        <div className="text-sm text-muted-foreground mb-4">{formatMoney(totals.taxPayableCents, currency)}</div>
      )}

      <div className="flex gap-2 mb-4">
        <input
          className="flex-1 border border-border rounded px-2 py-1 text-sm"
          placeholder={t('tax.tax_review_ask_placeholder')}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button onClick={askQuestion} className="text-sm text-primary">{t('tax.tax_review_ask_button')}</button>
      </div>
      {answer && <p className="text-sm mb-4">{answer}</p>}

      <button
        onClick={submit}
        disabled={submitting}
        className="w-full bg-primary text-primary-foreground rounded-lg py-2 text-sm font-medium disabled:opacity-50"
      >
        {t('tax.tax_review_submit_button')}
      </button>
    </div>
  );
};
