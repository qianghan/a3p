import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Receipt custody — retention is a rule, not an accident.
 *
 * A receipt is the evidence behind a deduction. If it disappears, the deduction
 * becomes unsupportable at exactly the moment it matters, and the user cannot
 * tell until an auditor asks. So the requirement is absolute: once attached, a
 * receipt is never destroyed by the product.
 *
 * Today that holds only because nothing happens to call a delete. Two routes
 * made it worse than merely unguarded:
 *
 *   DELETE /api/v1/storage/delete — validated the session and the CSRF token,
 *     then called del(url) on WHATEVER URL the caller supplied. No ownership
 *     check, no tenant scoping.
 *   GET /api/v1/storage/list — accepted a caller-supplied `prefix` and listed
 *     blobs across every tenant.
 *
 * Together those are a complete discover-then-destroy chain against any
 * tenant's receipts, and the usual "blob URLs are unguessable" mitigation did
 * not apply because one endpoint enumerated them. Neither had a single caller
 * anywhere in the repo — inherited fork scaffolding. Both are removed.
 *
 * These assertions keep them gone and stop an equivalent returning.
 */
const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const API = join(ROOT, 'apps/web-next/src/app/api');

/** Every route.ts under the API tree. */
function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) routeFiles(p, out);
    else if (entry === 'route.ts') out.push(p);
  }
  return out;
}

/** Source with comments stripped — guards match code, not prose about code. */
function readCode(p: string): string {
  return readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the unscoped blob endpoints stay deleted', () => {
  it('there is no generic "delete any blob by URL" route', () => {
    expect(
      existsSync(join(API, 'v1/storage/delete/route.ts')),
      'storage/delete deleted any URL the caller passed, with no ownership check',
    ).toBe(false);
  });

  it('there is no cross-tenant blob listing route', () => {
    expect(
      existsSync(join(API, 'v1/storage/list/route.ts')),
      'storage/list enumerated every tenant\'s blobs from a caller-supplied prefix',
    ).toBe(false);
  });
});

describe('no route deletes a blob it has not proven the caller owns', () => {
  // The shape to prevent: importing `del` from @vercel/blob into a request
  // handler. Blob deletion belongs in server-side lifecycle code (superseding a
  // generated tax package), never on a path a client can invoke with a URL.
  const offenders: string[] = [];
  for (const file of routeFiles(API)) {
    const code = readCode(file);
    if (/from\s+'@vercel\/blob'/.test(code) && /\bdel\s*\(/.test(code)) {
      offenders.push(file.slice(ROOT.length + 1));
    }
  }

  it('no API route calls del() from @vercel/blob', () => {
    expect(
      offenders,
      'a request handler that deletes blobs is one missing authorization check away from ' +
      'destroying another tenant\'s receipts',
    ).toEqual([]);
  });
});

describe('the receipt trail survives deleting an expense', () => {
  const expenseRoute = join(API, 'v1/agentbook-expense/expenses/[id]/route.ts');
  const code = readCode(expenseRoute);

  it('DELETE soft-deletes rather than removing the row', () => {
    // A hard delete takes the receiptUrl with it, so the evidence is
    // unrecoverable even though the blob itself still exists.
    expect(code).toMatch(/deletedAt/);
    expect(code, 'the expense row must not be hard-deleted').not.toMatch(
      /abExpense\.delete\s*\(/,
    );
  });

  it('DELETE does not remove the receipt file', () => {
    expect(code).not.toMatch(/deleteBlobs|from\s+'@vercel\/blob'/);
  });
});
