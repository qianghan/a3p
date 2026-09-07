/**
 * Deciding what an API error is allowed to say to its caller.
 *
 * Route handlers used to echo `err.message` straight back — 266 sites of a
 * ternary on the caught value, spelled four different ways. Most
 * of the time that message is ours to read, not the caller's: a Prisma error
 * names tables, columns, the database host and port; a fetch failure names
 * internal hostnames; a bug names variables. The same instinct leaked the
 * production database URL out of `/api/health` (#490).
 *
 * But some of those messages are the product's own copy. The sales-rep
 * application flow reports "You already have an application in progress." by
 * throwing it, and the route surfaces it as a 400. Blanket-replacing every
 * message would have silently turned real validation copy into "something
 * went wrong", which is a worse product with no security gain.
 *
 * So the message has to be marked safe at the point it is written, where the
 * author knows. `PublicError` is that mark, and the domain error classes that
 * already existed for this purpose extend it instead of a new parallel
 * mechanism being introduced beside them.
 *
 * The check is duck-typed rather than a bare `instanceof`. Next bundles the
 * same module more than once across route/runtime boundaries, and two copies
 * of a class fail `instanceof` against each other — an error thrown in a lib
 * and caught in a route would then be treated as internal and its message
 * dropped. A marker property survives that.
 */

const PUBLIC_MARKER = 'isPublicApiError';

/**
 * An error whose `message` is written for the caller and is safe to return.
 *
 * Throw this (or a subclass) for anything the user should read: validation
 * failures, "not found", "already submitted", quota and eligibility rules.
 * Never put a database detail, an internal hostname, or a stack in one.
 */
export class PublicError extends Error {
  readonly [PUBLIC_MARKER] = true;

  constructor(
    message: string,
    /** Optional HTTP status the route may use. */
    readonly status?: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** True iff `err` carries a message written for the caller. */
export function isPublicError(err: unknown): err is PublicError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as Record<string, unknown>)[PUBLIC_MARKER] === true
  );
}

/**
 * A short reference shared between the log line and the caller's message, so
 * a support report ("it said reference k3f9qa") can be traced to the actual
 * error without the caller ever seeing it.
 */
function newRef(): string {
  return Math.random().toString(36).slice(2, 8);
}

export const GENERIC_MESSAGE = 'Something went wrong on our side.';

/**
 * The message an API response may carry for `err`.
 *
 * A public error returns its own message. Anything else is logged with a
 * reference and reduced to a generic message carrying that reference. The
 * caller's existing `console.error` above the response is left alone — it is
 * the detailed record; this adds the reference that ties the two together.
 */
export function publicErrorMessage(err: unknown): string {
  if (isPublicError(err)) return err.message;
  const ref = newRef();
  console.error(`[api-error] ref=${ref}`, err);
  return `${GENERIC_MESSAGE} Reference: ${ref}`;
}
