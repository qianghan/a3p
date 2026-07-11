import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', () => ({
  PrismaOidcAdapter: class FakeAdapter {},
}));

const ProviderMock = vi.fn().mockImplementation(function (this: unknown, _issuer: string, config: unknown) {
  return { issuer: _issuer, config };
});
vi.mock('oidc-provider', () => ({ default: ProviderMock }));

const ORIGINAL_ENV = { ...process.env };

describe('mcp/oauth-provider', () => {
  beforeEach(() => {
    vi.resetModules();
    ProviderMock.mockClear();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.AGENTBOOK_MCP_JWKS;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('resolveJwks', () => {
    it('parses a valid AGENTBOOK_MCP_JWKS and returns it', async () => {
      const jwkSet = { keys: [{ kty: 'OKP', crv: 'Ed25519', kid: 'test-key-1' }] };
      process.env.AGENTBOOK_MCP_JWKS = JSON.stringify(jwkSet);

      const { resolveJwks } = await import('./oauth-provider');
      expect(resolveJwks()).toEqual(jwkSet);
    });

    it('falls back gracefully and warns once when unset', async () => {
      delete process.env.AGENTBOOK_MCP_JWKS;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { resolveJwks } = await import('./oauth-provider');
      expect(resolveJwks()).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('AGENTBOOK_MCP_JWKS');

      // A second call in the same process should not warn again.
      resolveJwks();
      expect(warnSpy).toHaveBeenCalledTimes(1);

      warnSpy.mockRestore();
    });

    it('throws on malformed JSON', async () => {
      process.env.AGENTBOOK_MCP_JWKS = '{not valid json';

      const { resolveJwks } = await import('./oauth-provider');
      expect(() => resolveJwks()).toThrow(/not valid JSON/);
    });

    it('throws when parsed JSON is not a plausible JWK Set (no keys array)', async () => {
      process.env.AGENTBOOK_MCP_JWKS = JSON.stringify({ notKeys: [] });

      const { resolveJwks } = await import('./oauth-provider');
      expect(() => resolveJwks()).toThrow(/JWK Set/);
    });
  });

  describe('getOAuthProvider', () => {
    it('passes the parsed jwks through to the Provider config when set', async () => {
      const jwkSet = { keys: [{ kty: 'OKP', crv: 'Ed25519', kid: 'test-key-1' }] };
      process.env.AGENTBOOK_MCP_JWKS = JSON.stringify(jwkSet);

      const { getOAuthProvider } = await import('./oauth-provider');
      getOAuthProvider();

      expect(ProviderMock).toHaveBeenCalledTimes(1);
      const config = ProviderMock.mock.calls[0][1] as { jwks?: unknown };
      expect(config.jwks).toEqual(jwkSet);
    });

    it('omits jwks from the Provider config when unset (ephemeral fallback)', async () => {
      delete process.env.AGENTBOOK_MCP_JWKS;
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { getOAuthProvider } = await import('./oauth-provider');
      getOAuthProvider();

      expect(ProviderMock).toHaveBeenCalledTimes(1);
      const config = ProviderMock.mock.calls[0][1] as { jwks?: unknown };
      expect(config.jwks).toBeUndefined();
    });
  });
});
