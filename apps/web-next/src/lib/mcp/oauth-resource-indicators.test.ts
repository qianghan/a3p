/**
 * RFC 8707 Resource Indicators.
 *
 * oidc-provider turns `resourceIndicators` on by default and ships a
 * `getResourceServerInfo` that only throws. The MCP authorization spec requires
 * clients to send `resource`, so every compliant client reached login, got
 * through consent, and then failed the exchange with
 * `invalid_target: resource indicator is missing, or unknown` — the user having
 * done everything right, at the moment it looks like their sign-in was refused.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', () => ({ PrismaOidcAdapter: class {} }));

describe('resource server info', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.AGENTBOOK_MCP_ISSUER = 'https://agentbook.test';
  });
  afterEach(() => { delete process.env.AGENTBOOK_MCP_ISSUER; });

  it('accepts the MCP endpoint as a resource instead of throwing', async () => {
    const { resourceServerInfoFor, MCP_SCOPE } = await import('./oauth-provider');

    const info = await resourceServerInfoFor('https://agentbook.test/api/v1/mcp');
    expect(info.scope).toBe(MCP_SCOPE);
  });

  // If this ever becomes 'jwt', the OAuth flow keeps working and every MCP
  // call starts returning 401: authenticateMcpRequest resolves bearer tokens
  // with provider.AccessToken.find(), which only finds opaque ones.
  it('issues opaque tokens, because that is what the MCP route can validate', async () => {
    const { resourceServerInfoFor } = await import('./oauth-provider');
    const info = await resourceServerInfoFor('https://agentbook.test/api/v1/mcp');
    expect(info.accessTokenFormat).toBe('opaque');
  });

  it('refuses a resource that is not ours, so the check is not vacuous', async () => {
    const { resourceServerInfoFor } = await import('./oauth-provider');

    await expect(resourceServerInfoFor('https://elsewhere.example/api')).rejects.toMatchObject({
      message: 'invalid_target',
    });
    // A near miss on the same host must fail too — a prefix match here would
    // hand out tokens scoped to an API nobody asked about.
    await expect(resourceServerInfoFor('https://agentbook.test/api/v1/mcp/extra')).rejects.toMatchObject({
      message: 'invalid_target',
    });
  });

  it('is actually wired into the provider, not merely exported', async () => {
    const ProviderMock = vi.fn().mockImplementation(function (this: unknown, issuer: string, config: unknown) {
      return { issuer, config, proxy: false };
    });
    vi.doMock('oidc-provider', async () => {
      const actual = await vi.importActual<typeof import('oidc-provider')>('oidc-provider');
      return { default: ProviderMock, errors: actual.errors };
    });
    vi.resetModules();

    const { getOAuthProvider } = await import('./oauth-provider');
    getOAuthProvider();

    const config = ProviderMock.mock.calls[0][1] as {
      features: { resourceIndicators: { enabled: boolean; getResourceServerInfo: unknown; defaultResource: unknown } };
    };
    expect(config.features.resourceIndicators.enabled).toBe(true);
    expect(typeof config.features.resourceIndicators.getResourceServerInfo).toBe('function');
    expect(typeof config.features.resourceIndicators.defaultResource).toBe('function');
    vi.doUnmock('oidc-provider');
  });
});
