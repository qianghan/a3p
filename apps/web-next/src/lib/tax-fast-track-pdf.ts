import 'server-only';
import React from 'react';
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer';
import type { FilingDraftSummary } from '@agentbook/jurisdictions/interfaces';

const styles = StyleSheet.create({
  page: { paddingTop: 36, paddingBottom: 48, paddingHorizontal: 36, fontSize: 10, fontFamily: 'Helvetica', color: '#111' },
  header: { fontSize: 18, fontWeight: 700, marginBottom: 4 },
  subheader: { fontSize: 11, color: '#444', marginBottom: 12 },
  sectionTitle: { fontSize: 12, fontWeight: 700, marginTop: 14, marginBottom: 4, paddingBottom: 2, borderBottomWidth: 1, borderBottomColor: '#888' },
  row: { flexDirection: 'row', paddingVertical: 2 },
  cellLabel: { flexGrow: 1, flexShrink: 1, paddingRight: 8 },
  cellAmount: { width: 110, minWidth: 110, flexShrink: 0, textAlign: 'right' },
  bullet: { paddingVertical: 2 },
  small: { fontSize: 9, color: '#555' },
  caveat: { fontSize: 9, color: '#900', marginTop: 14, fontStyle: 'italic' },
  paragraph: { fontSize: 10, marginBottom: 8, lineHeight: 1.4 },
});

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

interface DraftDocProps { summary: FilingDraftSummary; taxYear: number; jurisdiction: string; }

const DraftDoc: React.FC<DraftDocProps> = ({ summary, taxYear, jurisdiction }) => {
  return React.createElement(
    Document,
    { title: `Tax fast-track draft ${taxYear}`, author: 'AgentBook' },
    React.createElement(
      Page,
      { size: 'LETTER', style: styles.page },
      React.createElement(Text, { style: styles.header }, `Tax Filing Draft — ${taxYear}`),
      React.createElement(Text, { style: styles.subheader }, `Fast-tracked estimate • ${jurisdiction.toUpperCase()}`),

      React.createElement(Text, { style: styles.sectionTitle }, 'Estimated figures'),
      ...(summary.estimatedTaxPayableCents != null
        ? [
          React.createElement(View, { key: 'row-income', style: styles.row },
            React.createElement(Text, { style: styles.cellLabel }, 'Estimated total income'),
            React.createElement(Text, { style: styles.cellAmount }, summary.estimatedTotalIncomeCents != null ? dollars(summary.estimatedTotalIncomeCents) : 'n/a')),
          React.createElement(View, { key: 'row-taxable', style: styles.row },
            React.createElement(Text, { style: styles.cellLabel }, 'Estimated taxable income'),
            React.createElement(Text, { style: styles.cellAmount }, summary.estimatedTaxableIncomeCents != null ? dollars(summary.estimatedTaxableIncomeCents) : 'n/a')),
          React.createElement(View, { key: 'row-payable', style: styles.row },
            React.createElement(Text, { style: styles.cellLabel }, 'Estimated tax payable'),
            React.createElement(Text, { style: styles.cellAmount }, dollars(summary.estimatedTaxPayableCents))),
          React.createElement(View, { key: 'row-delta', style: styles.row },
            React.createElement(Text, { style: styles.cellLabel }, "Vs. last year's actual tax payable"),
            React.createElement(Text, { style: styles.cellAmount },
              summary.taxPayableDeltaVsLastYearCents != null
                ? `${summary.taxPayableDeltaVsLastYearCents >= 0 ? '+' : '-'}${dollars(Math.abs(summary.taxPayableDeltaVsLastYearCents))}`
                : 'n/a')),
        ]
        : [React.createElement(Text, { key: 'no-numbers', style: styles.paragraph }, 'No numeric estimate available — the prior filing on file did not have enough baseline data to compute one.')]),

      React.createElement(Text, { style: styles.sectionTitle }, 'What changed this year'),
      ...(summary.changesFromLastYear.length
        ? summary.changesFromLastYear.map((c, i) => React.createElement(Text, { key: `change-${i}`, style: styles.bullet }, `• ${c}`))
        : [React.createElement(Text, { key: 'no-changes', style: styles.small }, 'No material changes identified.')]),

      React.createElement(Text, { style: styles.sectionTitle }, 'Open questions for your accountant'),
      ...(summary.openQuestions.length
        ? summary.openQuestions.map((q, i) => React.createElement(Text, { key: `q-${i}`, style: styles.bullet }, `• ${q}`))
        : [React.createElement(Text, { key: 'no-questions', style: styles.small }, 'None identified.')]),

      React.createElement(Text, { style: styles.caveat }, summary.caveat),
    ),
  );
};

interface LetterDocProps { letterBody: string; taxYear: number; }

const LetterDoc: React.FC<LetterDocProps> = ({ letterBody, taxYear }) => {
  const paragraphs = letterBody.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  return React.createElement(
    Document,
    { title: `Tax fast-track client letter ${taxYear}`, author: 'AgentBook' },
    React.createElement(
      Page,
      { size: 'LETTER', style: styles.page },
      React.createElement(Text, { style: styles.header }, `Client Letter — ${taxYear}`),
      ...paragraphs.map((p, i) => React.createElement(Text, { key: `p-${i}`, style: styles.paragraph }, p.trim())),
    ),
  );
};

export async function renderFilingDraftPdf(summary: FilingDraftSummary, taxYear: number, jurisdiction: string): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const element = React.createElement(DraftDoc, { summary, taxYear, jurisdiction }) as any;
  return (await renderToBuffer(element)) as Buffer;
}

export async function renderClientLetterPdf(letterBody: string, taxYear: number): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const element = React.createElement(LetterDoc, { letterBody, taxYear }) as any;
  return (await renderToBuffer(element)) as Buffer;
}
