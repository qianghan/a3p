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

// The billing/admin-auth import pulls in `server-only`, whose browser build
// throws. Stub it rather than reconfiguring the shared vitest environment.
vi.mock('server-only', () => ({}));
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

/**
 * A response field whose value is a raw caught value.
 *
 * The first version of this anchored on `error:` and on the locals named
 * `err`/`e`, which meant it certified the shape the codemod had already
 * rewritten rather than the invariant in this file's title. It missed, in
 * production code: `message:` carrying the raw text beside a generic `error`
 * (the single prod chat endpoint did exactly that), a nested
 * `error: { message, stack }` returning eight lines of stack trace, and a
 * local named `error` rather than `err`.
 */
/**
 * Only identifiers that name an error. A first attempt matched any
 * `<ident>.message`, which flagged a digest item's `message`, a DB row's
 * `message`, and a `message:` field inside a `console.error` object -- four
 * false positives out of six. A guard that cries wolf gets deleted.
 */
const ERR_IDENT = String.raw`(?:err|e|error|\w*[eE]rror)`;
const RAW_VALUE = String.raw`(?:${ERR_IDENT} instanceof Error \?\s*${ERR_IDENT}\.message|String\(${ERR_IDENT}\)|\(${ERR_IDENT} as Error\)\.message|${ERR_IDENT}\.message)`;
const RAW_ECHO = new RegExp(
  [
    // error: <raw>   /   message: <raw>
    String.raw`(?:error|message):\s*${RAW_VALUE}`,
    // error: { message: <raw>, ... }
    String.raw`error:\s*\{[^}]*message:\s*${RAW_VALUE}`,
  ].join('|'),
);

/**
 * Lines that cannot be a response body: log calls, and any line a human has
 * marked. The marker exists because not every `error:` key is a response --
 * the gateway records one on a telemetry row -- and a guard with no auditable
 * escape hatch gets weakened or deleted the first time it is wrong. Grep
 * `api-error-ok` to review every exemption.
 */
function responseLines(src: string): string {
  // Filter on the raw lines and strip comments afterwards. Stripping first
  // does not preserve line numbers -- it deletes block comments along with
  // their newlines -- so the marker's index no longer matches its code.
  const lines = src.split('\n');
  const skip = new Set<number>();
  lines.forEach((l, i) => {
    if (l.includes('api-error-ok')) {
      skip.add(i);
      skip.add(i + 1);
    }
  });
  const kept = lines.filter(
    (l, i) => !skip.has(i) && !/console\.(error|warn|log|info|debug)|logger\.|reportError\(/.test(l),
  );
  return stripComments(kept.join('\n'));
}

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
      .filter((f) => RAW_ECHO.test(responseLines(readFileSync(f, 'utf8'))))
      .map((f) => f.slice(ROOT.length + 1));

    expect(
      offenders,
      `These routes echo a raw error message to the caller. Use publicErrorMessage(err), ` +
        `or throw a PublicError if the text is written for the caller:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('no route returns a stack trace, in any field', () => {
    const offenders = files
      .filter((f) => /stack:\s*\w+\.stack|\.stack\?\.split/.test(responseLines(readFileSync(f, 'utf8'))))
      .map((f) => f.slice(ROOT.length + 1));
    expect(offenders, `These routes return a stack trace:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it('the domain error classes surfaced by an instanceof branch are public', async () => {
    // The route-level contract test injects a PublicError of its own, which
    // proves the sanitizer is wired but not that the real classes opt in.
    // These four are surfaced at 400/404/422 by a typed branch, so if any
    // stops being public its message becomes a generic line under a
    // deliberate status -- which is what #492 did to three of them.
    const [{ isPublicError }, bank, invoice, admin] = await Promise.all([
      import('@/lib/api-error'),
      import('@/lib/agentbook-bank-match'),
      import('@/lib/invoice-connect'),
      import('@/lib/billing/admin-auth'),
    ]);
    expect(isPublicError(new bank.BankMatchError('No such transaction.', 'txn_not_found'))).toBe(true);
    expect(isPublicError(new invoice.InvoicePayLinkError('Connect account not ready.'))).toBe(true);
    expect(isPublicError(new admin.HttpError(403, 'not authorized'))).toBe(true);
  });

  it('no route passes a raw-derived message to the platform error helpers', () => {
    // A third shape, on the inherited platform routes: a local built from the
    // caught value, then handed to errors.badRequest/forbidden/conflict/
    // internal. The text-based branching above those calls is fine -- it
    // inspects a local and three branches deliberately map "not found" to 403
    // for anti-enumeration -- but the value must not reach the response.
    const offenders = files
      .filter((f) => {
        const src = responseLines(readFileSync(f, 'utf8'));
        if (!/const message = \w+ instanceof Error \?/.test(src)) return false;
        return /errors\.[a-zA-Z]+\(message\)/.test(src);
      })
      .map((f) => f.slice(ROOT.length + 1));
    expect(
      offenders,
      `These routes hand a raw-derived message to an error helper:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the team-management copy is public, so a 403/409 still says why', async () => {
    // lib/api/teams.ts reports its rules by throwing them ("Team slug is
    // already taken", "Only admins can invite members"), and the routes
    // surface those at 400/403/409. If they stop being public those statuses
    // start answering with a generic line -- the #492 regression, again.
    const [{ isPublicError }, teams] = await Promise.all([
      import('@/lib/api-error'),
      import('@/lib/api/teams'),
    ]);
    expect(typeof teams.validateTeamAccess).toBe('function');
    const src = readFileSync(join(ROOT, 'apps/web-next/src/lib/api/teams.ts'), 'utf8');
    expect(stripComments(src)).not.toMatch(/throw new Error\(/);
    expect(isPublicError(new (class extends (await import('@/lib/api-error')).PublicError {})('x'))).toBe(true);
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
