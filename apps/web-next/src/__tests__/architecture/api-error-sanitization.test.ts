/**
 * Architectural invariant: a production API response never carries the text of
 * an unexpected error.
 *
 * The recurring failure here is not a missing sanitizer, it is that the raw
 * echo is the path of least resistance when adding a route. It had grown to
 * 266 sites of a ternary on the caught value:
 *
 *   { success: false, error: err instanceof Error ? err.message : String(err) }
 *
 * A Prisma error message names tables, columns, the database host and port; a
 * fetch failure names internal hostnames; a bug names variables. #490 was the
 * same instinct with a worse blast radius -- /api/health returned 40-character
 * prefixes of four Postgres connection strings, stopping one byte before the
 * password.
 *
 * A unit test of the sanitizer cannot see this, because the sanitizer is fine
 * -- it just isn't called. So assert the wiring, the way the ledger and tax
 * invariants do.
 *
 * The escape hatch is deliberate and narrow: `PublicError` marks a message as
 * written for the caller, and the response returns it. Routes that already
 * branch on a typed domain error before the generic catch (RepAdminError,
 * BankMatchError, InvoicePayLinkError and friends) are unaffected -- their
 * message reaches the caller through that branch, not through the catch.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// apps/web-next/src/__tests__/architecture -> repo root
const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const API_DIR = join(ROOT, 'apps/web-next/src/app/api');
const HELPER = 'apps/web-next/src/lib/api-error.ts';

/**
 * Strip comments before matching. A doc comment that quotes the banned shape
 * -- like the one at the top of this file, and the one in api-error.ts -- must
 * not count as a violation. Getting this wrong makes the guard pass on its own
 * prose, which has already happened twice in this repo.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) routeFiles(p, out);
    else if (entry.name === 'route.ts') out.push(p);
  }
  return out;
}

/** An `error:` response field whose value is a raw caught value. */
const RAW_ECHO =
  /error:\s*(?:\w+ instanceof Error \?\s*\w+\.message|String\((?:err|e)\)|\(?\w+ as Error\)?\.message|(?:err|e)\.message)/;

describe('API responses do not echo unexpected error text', () => {
  const files = routeFiles(API_DIR);

  it('finds the route files (guard is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(150);
  });

  it('the sanitizer and its public-message escape hatch exist', () => {
    expect(existsSync(join(ROOT, HELPER))).toBe(true);
    const src = readFileSync(join(ROOT, HELPER), 'utf8');
    expect(src).toContain('export class PublicError');
    expect(src).toContain('export function publicErrorMessage');
  });

  it('no production route puts a raw caught value in an `error` response field', () => {
    const offenders = files
      .filter((f) => RAW_ECHO.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => f.slice(ROOT.length + 1));

    expect(
      offenders,
      `These routes echo a raw error message to the caller. Use publicErrorMessage(err), ` +
        `or throw a PublicError if the text is written for the caller:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every route that sanitizes actually imports the helper', () => {
    const missing = files
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        return src.includes('publicErrorMessage(') && !src.includes("from '@/lib/api-error'");
      })
      .map((f) => f.slice(ROOT.length + 1));
    expect(missing).toEqual([]);
  });

  it('the sanitizer keeps a PublicError message and drops everything else', async () => {
    // Cheap end-to-end check of the contract the guard above assumes, so a
    // future change to the helper cannot leave the structural test green while
    // the behaviour inverts.
    const { PublicError, publicErrorMessage } = await import('@/lib/api-error');
    expect(publicErrorMessage(new PublicError('You are already an approved partner.'))).toBe(
      'You are already an approved partner.',
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(publicErrorMessage(new Error('relation "AbExpense" does not exist'))).not.toContain(
      'AbExpense',
    );
    spy.mockRestore();
  });
});
