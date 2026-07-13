import { describe, expect, it, vi } from 'vitest';

const mockIsMcpEnabled = vi.fn(async () => true);
vi.mock('@/lib/mcp/mcp-flag', () => ({
  isMcpEnabled: () => mockIsMcpEnabled(),
}));

vi.mock('@/lib/mcp/oauth-provider', () => ({
  getOAuthProvider: () => ({ issuer: 'https://agentbook.example.test' }),
}));

const { GET } = await import('./route');

describe('GET /.well-known/oauth-authorization-server (Finding 1: flag must gate discovery too)', () => {
  it('returns the discovery document when MCP is enabled', async () => {
    mockIsMcpEnabled.mockResolvedValueOnce(true);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuer).toBe('https://agentbook.example.test');
    expect(body.registration_endpoint).toContain('/api/v1/oauth/register');
  });

  it('returns a clean 503 instead of advertising a live issuer when MCP is disabled', async () => {
    mockIsMcpEnabled.mockResolvedValueOnce(false);
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/not enabled/i);
  });
});
