import { describe, expect, it, vi } from 'vitest';

const mockIsMcpEnabled = vi.fn(async () => true);
vi.mock('@/lib/mcp/mcp-flag', () => ({ isMcpEnabled: () => mockIsMcpEnabled() }));
vi.mock('@/lib/mcp/oauth-provider', () => ({
  MCP_RESOURCE_PATH: '/api/v1/mcp',
  mcpIssuer: () => 'https://agentbook.example.test',
  mcpResourceUrl: () => 'https://agentbook.example.test/api/v1/mcp',
}));

const { GET } = await import('./route');

const call = (segments: string[]) =>
  GET(new Request('https://agentbook.example.test'), { params: Promise.resolve({ resource: segments }) });

describe('GET /.well-known/oauth-protected-resource/<resource path> (RFC 9728 §3.1)', () => {
  it('serves the metadata at the path-inserted URL clients actually request', async () => {
    mockIsMcpEnabled.mockResolvedValueOnce(true);
    const res = await call(['api', 'v1', 'mcp']);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: 'https://agentbook.example.test/api/v1/mcp',
      authorization_servers: ['https://agentbook.example.test'],
    });
  });

  // The whole point of this route. Before it existed the path fell through to
  // the client-side catch-all page, which answers 200 with HTML. The MCP SDK
  // only falls back to the root metadata URL on a 4xx, so 200-with-HTML ended
  // discovery in a JSON parse error instead of a retry — and the connector
  // could not be added at all.
  it('404s on any other path, so a client can fall back instead of parsing a page', async () => {
    for (const path of [['api', 'v1', 'something-else'], ['not-a-resource'], ['api'], ['api', 'v1', 'mcp', 'extra']]) {
      const res = await call(path);
      expect(res.status, `expected 404 for /${path.join('/')}`).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
    }
  });

  it('does not leak the resource while the connector is switched off', async () => {
    mockIsMcpEnabled.mockResolvedValueOnce(false);
    const res = await call(['api', 'v1', 'mcp']);
    expect(res.status).toBe(503);
  });

  it('404s an unrelated path even with the flag off, so the answer does not depend on config', async () => {
    mockIsMcpEnabled.mockResolvedValueOnce(false);
    const res = await call(['nope']);
    expect(res.status).toBe(404);
  });
});
