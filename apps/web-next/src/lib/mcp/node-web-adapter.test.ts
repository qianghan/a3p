import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { nodeRequestResponseFromWeb } from './node-web-adapter';

describe('nodeRequestResponseFromWeb', () => {
  it('round-trips a JSON POST body and status/headers written via the Node response', async () => {
    const request = new NextRequest('http://localhost/api/v1/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=authorization_code&code=abc',
    });

    const { nodeReq, nodeRes, responsePromise } = await nodeRequestResponseFromWeb(request);
    expect(nodeReq.method).toBe('POST');
    expect(nodeReq.headers['content-type']).toBe('application/x-www-form-urlencoded');

    nodeRes.statusCode = 200;
    nodeRes.setHeader('content-type', 'application/json');
    nodeRes.end(JSON.stringify({ access_token: 'tok' }));

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ access_token: 'tok' });
  });

  it('lower-cases header names and preserves multiple Set-Cookie values, matching Node http semantics', async () => {
    const request = new NextRequest('http://localhost/api/v1/oauth/authorize', {
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer abc' },
    });
    const { nodeReq, nodeRes, responsePromise } = await nodeRequestResponseFromWeb(request);
    expect(nodeReq.headers['content-type']).toBe('application/json');
    expect(nodeReq.headers['authorization']).toBe('Bearer abc');

    nodeRes.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/']);
    nodeRes.end();
    const response = await responsePromise;
    expect(response.headers.get('set-cookie')).toContain('a=1');
    // The assertion above would still pass even if the two values were
    // collapsed into one comma-joined string (a real `Headers.set()`
    // quirk — see node-web-adapter.ts) since 'a=1' is a substring of that
    // joined value too. `getSetCookie()` is what actually distinguishes
    // "two Set-Cookie lines" from "one comma-joined line", matching what a
    // real HTTP client / oidc-provider's cookie jar would observe.
    expect(response.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });

  it('does not hang and buffers no body for a GET request with no body', async () => {
    const request = new NextRequest('http://localhost/api/v1/oauth/authorize?foo=bar', {
      method: 'GET',
    });

    const { nodeReq, nodeRes, responsePromise } = await nodeRequestResponseFromWeb(request);
    expect(nodeReq.method).toBe('GET');
    expect(nodeReq.url).toBe('/api/v1/oauth/authorize?foo=bar');

    const chunks: Buffer[] = [];
    for await (const chunk of nodeReq) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).length).toBe(0);

    nodeRes.statusCode = 302;
    nodeRes.end();
    const response = await responsePromise;
    expect(response.status).toBe(302);
    expect(await response.text()).toBe('');
  });

  it('resolves the response promise with default status/no headers when end() is called with nothing set', async () => {
    const request = new NextRequest('http://localhost/api/v1/oauth/register', { method: 'POST', body: '{}' });
    const { nodeRes, responsePromise } = await nodeRequestResponseFromWeb(request);

    nodeRes.end();
    const response = await responsePromise;
    expect(response.status).toBe(200);
  });
});
