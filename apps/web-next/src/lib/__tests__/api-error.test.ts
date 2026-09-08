import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `publicErrorMessage` is called from 226 route modules and had no test.
 *
 * The contract it has to keep is unusual: it returns a string to the caller
 * AND, as a side effect, has to make that exact string traceable. The string
 * half was covered by nothing; the side-effect half did not exist — the
 * reference was written to console.error and nowhere else, so the promise the
 * message makes ("quote this reference") depended on log retention and never
 * reached the error tracker the app already depends on.
 */

const reportError = vi.fn(async () => {});
const after = vi.fn((task: unknown) => { void task; });

vi.mock('@/lib/logger', () => ({ reportError }));
vi.mock('next/server', () => ({ after }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const load = async () => await import('../api-error');

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('reference format', () => {
  it('is always eight characters, never empty', async () => {
    const { publicErrorMessage } = await load();
    // The old implementation was Math.random().toString(36).slice(2, 8),
    // which is usually six chars and occasionally fewer — 0 yields '0',
    // whose slice is ''. "Reference: " with nothing after it is a support
    // dead end, so this pins the width.
    for (let i = 0; i < 200; i++) {
      const msg = publicErrorMessage(new Error('boom'));
      const ref = msg.match(/Reference: ([0-9a-f]+)$/)?.[1];
      expect(ref, `no reference in: ${msg}`).toBeDefined();
      expect(ref).toHaveLength(8);
    }
  });

  it('is different every time', async () => {
    const { publicErrorMessage } = await load();
    const refs = new Set(
      Array.from({ length: 100 }, () =>
        publicErrorMessage(new Error('x')).match(/Reference: (\w+)$/)?.[1]),
    );
    expect(refs.size).toBe(100);
  });
});

describe('correlation', () => {
  it('reports the error under the SAME reference the caller is given', async () => {
    const { publicErrorMessage } = await load();
    const err = new Error('database exploded');
    const msg = publicErrorMessage(err);
    const ref = msg.match(/Reference: (\w+)$/)![1];

    await vi.waitFor(() => expect(reportError).toHaveBeenCalledTimes(1));
    const [reportMsg, reportedErr, ctx] = reportError.mock.calls[0] as unknown as
      [string, unknown, Record<string, unknown>];

    // This is the whole point: a support report quoting the reference has to
    // land on the tracked event. If these two ever diverge, the reference is
    // decoration again and nothing else in the suite would notice.
    expect(reportMsg).toContain(ref);
    expect(ctx.errorRef).toBe(ref);
    expect(reportedErr).toBe(err);
  });

  it('keeps the invocation alive with after() so the report can flush', async () => {
    // Fire-and-forget races the response: the platform may freeze the
    // instance once the response is sent, losing the event for exactly the
    // fast failures worth seeing.
    const { publicErrorMessage } = await load();
    publicErrorMessage(new Error('x'));
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('still reports when there is no request scope for after()', async () => {
    // Cron workers, scripts and tests have no scope; after() throws there.
    after.mockImplementationOnce(() => { throw new Error('no request scope'); });
    const { publicErrorMessage } = await load();
    expect(() => publicErrorMessage(new Error('x'))).not.toThrow();
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledTimes(1));
  });

  it('never lets a failing reporter break the request', async () => {
    reportError.mockRejectedValueOnce(new Error('sentry is down'));
    const { publicErrorMessage } = await load();
    expect(() => publicErrorMessage(new Error('x'))).not.toThrow();
    // Give the swallowed rejection a tick to surface as unhandled if it would.
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe('public errors are untouched', () => {
  it('returns its own message and reports nothing', async () => {
    const { publicErrorMessage, PublicError } = await load();
    const msg = publicErrorMessage(new PublicError('You already have an application in progress.'));
    // A deliberate product message must not be replaced by a reference, and
    // must not be reported as a system fault — it is the system working.
    expect(msg).toBe('You already have an application in progress.');
    expect(msg).not.toContain('Reference:');
    expect(reportError).not.toHaveBeenCalled();
  });
});
