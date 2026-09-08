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

import { after } from 'next/server';

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
 * A short reference shared between the error report and the caller's message,
 * so a support report ("it said reference 3f9qa1c8") can be traced to the
 * actual error without the caller ever seeing it.
 *
 * Was `Math.random().toString(36).slice(2, 8)`, which is usually six chars and
 * occasionally fewer — `Math.random()` returning a value with a short decimal
 * expansion yields a short string, and 0 yields `'0'`, whose slice is the
 * empty string. "Reference: " with nothing after it is a support dead end, so
 * this uses a fixed-width hex slice of a UUID instead. `crypto` is a global in
 * both the Node and edge runtimes.
 */
function newRef(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

export const GENERIC_MESSAGE = 'Something went wrong on our side.';

/**
 * Send the error to the tracker under the same reference the user was given.
 *
 * WHY THIS EXISTS
 * The reference above was only ever written to `console.error`. That made the
 * promise in the user-facing message — that quoting the reference lets someone
 * find the failure — dependent on log retention, with no grouping, no alerting
 * and no link to an issue. It also meant this path, which #492 wired into 226
 * files, contributed nothing to the error tracker the app already depends on.
 *
 * Three details make this safe to call from a sync function on every error:
 *
 *  - The logger is imported dynamically. It is `server-only` and pulls in the
 *    Sentry SDK, and `publicErrorMessage` is called from route modules that
 *    should not have to carry either just to format a message.
 *  - `after()` keeps the serverless invocation alive until the report flushes.
 *    Without it a fire-and-forget promise races the response: the platform is
 *    free to freeze the instance once the response is sent, and the event is
 *    lost precisely for the fast failures that matter.
 *  - Every failure is swallowed. An error reporter that throws turns a handled
 *    500 into an unhandled one.
 */
function reportWithRef(ref: string, err: unknown): void {
  const task = (async () => {
    try {
      const { reportError } = await import('@/lib/logger');
      await reportError(`[api-error] ref=${ref}`, err, { errorRef: ref });
    } catch {
      // Reporting must never be the reason a request fails.
    }
  })();

  try {
    // Only available inside a request or a route handler; a cron worker,
    // script or unit test has no scope and throws synchronously here. The
    // promise above still runs in those contexts, which is all they need.
    after(task);
  } catch {
    void task;
  }
}

/**
 * The message an API response may carry for `err`.
 *
 * A public error returns its own message. Anything else is reported with a
 * reference and reduced to a generic message carrying that reference. The
 * caller's existing `console.error` above the response is left alone — it is
 * the detailed local record; this adds the reference that ties it to the
 * tracked event.
 */
export function publicErrorMessage(err: unknown): string {
  if (isPublicError(err)) return err.message;
  const ref = newRef();
  console.error(`[api-error] ref=${ref}`, err);
  reportWithRef(ref, err);
  return `${GENERIC_MESSAGE} Reference: ${ref}`;
}
