import { describe, it, expect, vi } from 'vitest';

/**
 * How an auth failure reaches the caller.
 *
 * `resolveAgentbookTenant` signals failure by throwing a `Response`, and the
 * safe wrapper used to re-emit that response's body verbatim. That was safe:
 * every throw site in the module builds the body from a string literal.
 * CodeQL flagged it as stack-trace exposure regardless, because it cannot see
 * that — and it has a point about the pattern rather than the instance. A
 * future throw site that interpolated an exception into the body would start
 * leaking with no visible change at the re-wrap.
 *
 * The rewrap is now its own function, which is what makes the property
 * testable at all: a body piped straight through has nothing to assert on.
 */

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', () => ({ prisma: {} }));

import { rewrapAuthResponse } from '../agentbook-tenant';

const thrown = (body: string, status = 401, json = true) =>
  new Response(body, { status, headers: json ? { 'Content-Type': 'application/json' } : {} });

describe('the real auth messages still reach the caller', () => {
  it.each([
    [401, 'unauthorized'],
    [401, 'invalid session'],
    [401, 'session validation failed'],
    [400, 'cron request must specify x-tenant-id'],
  ])('preserves %s %s', async (status, error) => {
    const res = await rewrapAuthResponse(thrown(JSON.stringify({ error }), status));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
  });
});

describe('anything unexpected in a thrown body does not pass through', () => {
  it('replaces a non-JSON body rather than echoing it', async () => {
    const res = await rewrapAuthResponse(thrown(
      'Error: connect ECONNREFUSED 10.0.0.4:5432\n    at Socket.emit (node:events:518:28)',
      401, false,
    ));
    const raw = await res.text();
    expect(raw).not.toContain('ECONNREFUSED');
    expect(raw).not.toContain('at Socket.emit');
    expect(JSON.parse(raw)).toEqual({ error: 'unauthorized' });
  });

  it('replaces a JSON body whose error is not a string', async () => {
    const res = await rewrapAuthResponse(thrown(
      JSON.stringify({ error: { message: 'boom', stack: 'at /var/task/x.js' } }),
    ));
    const raw = await res.text();
    expect(raw).not.toContain('/var/task');
    expect(JSON.parse(raw)).toEqual({ error: 'unauthorized' });
  });

  it('keeps the status even when it discards the body', async () => {
    // The status is the part a caller branches on; only the prose is suspect.
    expect((await rewrapAuthResponse(thrown('nonsense', 403, false))).status).toBe(403);
  });
});
