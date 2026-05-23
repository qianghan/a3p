/**
 * Real PDF renderer for invoices (G-OLD-006 / PR 29).
 *
 * Closes the long-open gap where /invoices/:id/pdf served HTML masquerading
 * as a PDF. Customers receiving "invoice PDFs" via email got HTML files.
 *
 * Uses @react-pdf/renderer (Node-side, no Chromium) — same library already
 * shipped in agentbook-tax-pdf.ts. Produces a proper application/pdf
 * response that opens in any PDF viewer.
 */

import 'server-only';
import React from 'react';
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  renderToBuffer,
} from '@react-pdf/renderer';

const styles = StyleSheet.create({
  page: {
    paddingTop: 36,
    paddingBottom: 48,
    paddingHorizontal: 36,
    fontSize: 10,
    fontFamily: 'Helvetica',
    color: '#111',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  companyBlock: {
    flexDirection: 'column',
  },
  companyName: { fontSize: 16, fontWeight: 700, marginBottom: 2 },
  companyMeta: { fontSize: 9, color: '#666' },
  invoiceLabel: {
    fontSize: 22,
    fontWeight: 700,
    letterSpacing: 2,
    color: '#222',
    textAlign: 'right',
  },
  invoiceNumber: {
    fontSize: 10,
    color: '#666',
    textAlign: 'right',
  },
  metaGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#ddd',
  },
  metaBlock: { flexDirection: 'column' },
  metaLabel: { fontSize: 9, color: '#888', textTransform: 'uppercase' },
  metaValue: { fontSize: 11, marginTop: 2 },
  tableHeader: {
    flexDirection: 'row',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
    fontWeight: 700,
    fontSize: 9,
    textTransform: 'uppercase',
    color: '#444',
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 6,
    borderBottomWidth: 0.5,
    borderBottomColor: '#eee',
  },
  cellDesc: { flexGrow: 3, flexShrink: 1 },
  cellQty: { width: 50, textAlign: 'right' },
  cellRate: { width: 80, textAlign: 'right' },
  cellAmount: { width: 90, textAlign: 'right' },
  totalsBlock: {
    marginTop: 12,
    marginLeft: 'auto',
    width: 200,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 2,
  },
  grandTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 6,
    marginTop: 6,
    borderTopWidth: 1,
    borderTopColor: '#222',
    fontWeight: 700,
    fontSize: 12,
  },
  notesBlock: {
    marginTop: 24,
    fontSize: 9,
    color: '#555',
  },
  notesLabel: {
    fontSize: 9,
    fontWeight: 700,
    textTransform: 'uppercase',
    marginBottom: 4,
    color: '#888',
  },
  footer: {
    position: 'absolute',
    bottom: 24,
    left: 36,
    right: 36,
    fontSize: 8,
    color: '#999',
    textAlign: 'center',
  },
});

export interface InvoicePdfData {
  number: string;
  issuedDate: Date | string;
  dueDate: Date | string;
  status: string;
  amountCents: number;
  taxCents?: number | null;
  subtotalCents?: number | null;
  currency: string;
  notes?: string | null;
  client: {
    name: string;
    email?: string | null;
    address?: string | null;
  };
  lines: Array<{
    description: string;
    quantity: number;
    rateCents: number;
    amountCents: number;
  }>;
  company: {
    name: string;
    email?: string | null;
    address?: string | null;
    phone?: string | null;
  };
}

function fmtMoney(cents: number, currency: string): string {
  const sym = currency === 'USD' ? '$' : currency === 'CAD' ? 'CA$' : currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : `${currency} `;
  return `${sym}${(cents / 100).toFixed(2)}`;
}

function fmtDate(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().slice(0, 10);
}

const InvoiceDocument: React.FC<{ inv: InvoicePdfData }> = ({ inv }) => {
  const subtotal = inv.subtotalCents ?? inv.amountCents - (inv.taxCents ?? 0);
  return React.createElement(
    Document,
    null,
    React.createElement(
      Page,
      { size: 'LETTER', style: styles.page },
      // Header
      React.createElement(
        View,
        { style: styles.headerRow },
        React.createElement(
          View,
          { style: styles.companyBlock },
          React.createElement(Text, { style: styles.companyName }, inv.company.name),
          inv.company.address &&
            React.createElement(Text, { style: styles.companyMeta }, inv.company.address),
          inv.company.email &&
            React.createElement(Text, { style: styles.companyMeta }, inv.company.email),
          inv.company.phone &&
            React.createElement(Text, { style: styles.companyMeta }, inv.company.phone),
        ),
        React.createElement(
          View,
          null,
          React.createElement(Text, { style: styles.invoiceLabel }, 'INVOICE'),
          React.createElement(Text, { style: styles.invoiceNumber }, inv.number),
        ),
      ),
      // Meta grid: Bill To | Issued | Due | Status
      React.createElement(
        View,
        { style: styles.metaGrid },
        React.createElement(
          View,
          { style: styles.metaBlock },
          React.createElement(Text, { style: styles.metaLabel }, 'Bill To'),
          React.createElement(Text, { style: styles.metaValue }, inv.client.name),
          inv.client.email &&
            React.createElement(Text, { style: styles.companyMeta }, inv.client.email),
          inv.client.address &&
            React.createElement(Text, { style: styles.companyMeta }, inv.client.address),
        ),
        React.createElement(
          View,
          { style: styles.metaBlock },
          React.createElement(Text, { style: styles.metaLabel }, 'Issued'),
          React.createElement(Text, { style: styles.metaValue }, fmtDate(inv.issuedDate)),
        ),
        React.createElement(
          View,
          { style: styles.metaBlock },
          React.createElement(Text, { style: styles.metaLabel }, 'Due'),
          React.createElement(Text, { style: styles.metaValue }, fmtDate(inv.dueDate)),
        ),
        React.createElement(
          View,
          { style: styles.metaBlock },
          React.createElement(Text, { style: styles.metaLabel }, 'Status'),
          React.createElement(Text, { style: styles.metaValue }, inv.status.toUpperCase()),
        ),
      ),
      // Line items table
      React.createElement(
        View,
        { style: styles.tableHeader },
        React.createElement(Text, { style: styles.cellDesc }, 'Description'),
        React.createElement(Text, { style: styles.cellQty }, 'Qty'),
        React.createElement(Text, { style: styles.cellRate }, 'Rate'),
        React.createElement(Text, { style: styles.cellAmount }, 'Amount'),
      ),
      ...inv.lines.map((line, i) =>
        React.createElement(
          View,
          { style: styles.tableRow, key: i },
          React.createElement(Text, { style: styles.cellDesc }, line.description),
          React.createElement(Text, { style: styles.cellQty }, String(line.quantity)),
          React.createElement(Text, { style: styles.cellRate }, fmtMoney(line.rateCents, inv.currency)),
          React.createElement(Text, { style: styles.cellAmount }, fmtMoney(line.amountCents, inv.currency)),
        ),
      ),
      // Totals
      React.createElement(
        View,
        { style: styles.totalsBlock },
        React.createElement(
          View,
          { style: styles.totalRow },
          React.createElement(Text, null, 'Subtotal'),
          React.createElement(Text, null, fmtMoney(subtotal, inv.currency)),
        ),
        (inv.taxCents ?? 0) > 0 &&
          React.createElement(
            View,
            { style: styles.totalRow },
            React.createElement(Text, null, 'Tax'),
            React.createElement(Text, null, fmtMoney(inv.taxCents!, inv.currency)),
          ),
        React.createElement(
          View,
          { style: styles.grandTotalRow },
          React.createElement(Text, null, 'Total'),
          React.createElement(Text, null, fmtMoney(inv.amountCents, inv.currency)),
        ),
      ),
      // Notes
      inv.notes &&
        React.createElement(
          View,
          { style: styles.notesBlock },
          React.createElement(Text, { style: styles.notesLabel }, 'Notes'),
          React.createElement(Text, null, inv.notes),
        ),
      // Footer
      React.createElement(
        Text,
        { style: styles.footer, fixed: true },
        `${inv.number} · Generated by AgentBook · ${new Date().toISOString().slice(0, 10)}`,
      ),
    ),
  );
};

/**
 * Render an invoice to a real application/pdf Buffer.
 *
 * Usage:
 *   const buf = await renderInvoicePdf(invoiceData);
 *   return new Response(buf, {
 *     headers: {
 *       'Content-Type': 'application/pdf',
 *       'Content-Disposition': `attachment; filename="${invoice.number}.pdf"`,
 *     },
 *   });
 */
export async function renderInvoicePdf(inv: InvoicePdfData): Promise<Buffer> {
  const doc = React.createElement(InvoiceDocument, { inv });
  // renderToBuffer is the @react-pdf Node-side render API.
  return (await renderToBuffer(doc as any)) as Buffer;
}
