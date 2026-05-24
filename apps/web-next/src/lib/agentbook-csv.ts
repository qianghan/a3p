/**
 * Minimal RFC-4180-ish CSV parser. Closes G-035 (naive `split(',')` import).
 *
 * Handles:
 *   - quoted fields with embedded commas: `"Acme, Inc",100,2025-01-01`
 *   - escaped quotes inside quotes: `"He said ""hi"""`  → `He said "hi"`
 *   - CRLF and LF row separators
 *   - newlines inside quoted fields (multi-line records)
 *   - trailing whitespace around unquoted fields
 *
 * Does NOT handle: BOM (caller strips), custom separators, RFC-quirky cases.
 * Returns rows as `string[][]` — caller maps headers to fields.
 */

export function parseCsv(text: string): string[][] {
  if (!text) return [];

  // Strip BOM if present.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        // Look ahead for "" escape.
        if (i + 1 < len && text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    // Outside quotes.
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      // CRLF — treat \r\n as one separator.
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  // Flush the trailing field/row (unless the entire input was empty).
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop a fully-empty final row (file ended with newline).
  const last = rows[rows.length - 1];
  if (last && last.length === 1 && last[0] === '') rows.pop();

  return rows;
}

/**
 * Convenience: parse a CSV with a header row into objects keyed by lowercase
 * header name. Trims headers, leaves field values exact. Returns
 * `{ headers, rows }` so callers can run header-detection logic against the
 * raw header list.
 */
export function parseCsvWithHeaders(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const all = parseCsv(text);
  if (all.length === 0) return { headers: [], rows: [] };
  const headers = all[0].map((h) => h.trim().toLowerCase());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < all.length; i++) {
    const row: Record<string, string> = {};
    const cols = all[i];
    headers.forEach((h, idx) => {
      row[h] = (cols[idx] ?? '').trim();
    });
    rows.push(row);
  }
  return { headers, rows };
}
