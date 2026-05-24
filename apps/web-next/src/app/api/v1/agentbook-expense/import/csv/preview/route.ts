/**
 * CSV expense import preview — returns headers, auto-detected column
 * mapping, and the first 5 rows.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { parseCsvWithHeaders } from '@/lib/agentbook-csv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface ColumnMapping {
  date: string;
  amount: string;
  description: string;
  vendor?: string;
  category?: string;
}

// Delegates to shared parseCsvWithHeaders for RFC-4180-ish parsing
// (quoted commas, escaped quotes, CRLF). Closes G-035.
function parseCSV(csvText: string): Record<string, string>[] {
  return parseCsvWithHeaders(csvText).rows;
}

function detectMapping(headers: string[]): ColumnMapping {
  const lower = headers.map((h) => h.toLowerCase());
  const find = (...names: string[]): string | undefined => lower.find((h) => names.includes(h));
  const findContains = (substr: string): string | undefined => lower.find((h) => h.includes(substr));

  return {
    date: find('date', 'transaction date', 'trans date', 'posted date') || lower[0],
    amount: find('amount', 'debit', 'transaction amount', 'total') || findContains('amount') || lower[1],
    description:
      find('description', 'memo', 'transaction description', 'details', 'name') ||
      findContains('desc') ||
      lower[2],
    vendor: find('vendor', 'merchant', 'payee', 'merchant name'),
    category: find('category', 'type', 'expense type'),
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const body = (await request.json().catch(() => ({}))) as { csv?: string };
    const { csv } = body;

    if (!csv) {
      return NextResponse.json({ success: false, error: 'csv field is required' }, { status: 400 });
    }
    const rows = parseCSV(csv);
    if (rows.length === 0) {
      return NextResponse.json({ success: false, error: 'No data rows' }, { status: 400 });
    }

    const headers = Object.keys(rows[0]);
    const mapping = detectMapping(headers);

    const preview = rows.slice(0, 5).map((row, i) => ({
      row: i + 2,
      date: row[mapping.date],
      amount: row[mapping.amount],
      description: row[mapping.description],
      vendor: mapping.vendor ? row[mapping.vendor] : undefined,
      category: mapping.category ? row[mapping.category] : undefined,
    }));

    return NextResponse.json({
      success: true,
      data: { headers, mapping, totalRows: rows.length, preview },
    });
  } catch (err) {
    console.error('[agentbook-expense/import/csv/preview] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
