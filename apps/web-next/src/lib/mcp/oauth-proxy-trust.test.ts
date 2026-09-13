/**
 * The provider must believe it is served over HTTPS when it is.
 *
 * `Provider extends Koa`. Without `proxy = true` Koa ignores
 * `x-forwarded-proto` and reads the scheme off the socket — always plaintext
 * inside a serverless function — so the provider minted `http://` URLs for an
 * `https://` issuer and left `Secure` off its interaction cookies. Both were
 * live in production and neither announced itself: browsers accept a
 * non-Secure cookie over HTTPS, so the flow worked.
 *
 * Asserted against the real oidc-provider over a real request, because the
 * behaviour under test belongs to the library, not to the object we pass it.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

vi.mock('server-only', () => ({}));

const store = new Map<string, Map<string, Record<string, unknown>>>();
class MemoryAdapter {
  private readonly bucket: Map<string, Record<string, unknown>>;
  constructor(type: string) {
    if (!store.has(type)) store.set(type, new Map());
    this.bucket = store.get(type)!;
  }
  async upsert(id: string, payload: Record<string, unknown>) { this.bucket.set(id, payload); }
  async find(id: string) { return this.bucket.get(id); }
  async findByUid() { return undefined; }
  async findByUserCode() { return undefined; }
  async consume() { /* unused */ }
  async destroy(id: string) { this.bucket.delete(id); }
  async revokeByGrantId() { /* unused */ }
}
vi.mock('@naap/database', () => ({ PrismaOidcAdapter: MemoryAdapter }));

async function register(forwardedProto?: string): Promise<Record<string, unknown>> {
  const { getOAuthProvider } = await import('./oauth-provider');
  const server: Server = createServer(getOAuthProvider().callback());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const payload = JSON.stringify({
      client_name: 'proxy test',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    return await new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/api/v1/oauth/register',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            // What Vercel's TLS terminator puts on every inbound request.
            ...(forwardedProto ? { 'x-forwarded-proto': forwardedProto } : {}),
          },
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { raw += c; });
          res.on('end', () => {
            try { resolve(JSON.parse(raw) as Record<string, unknown>); }
            catch (e) { reject(new Error(`${res.statusCode}: ${raw.slice(0, 200)} (${(e as Error).message})`)); }
          });
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('the OAuth provider trusts the TLS terminator in front of it', () => {
  beforeEach(() => {
    vi.resetModules();
    store.clear();
    process.env.AGENTBOOK_MCP_ISSUER = 'https://agentbook.test';
    delete process.env.AGENTBOOK_MCP_JWKS;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.AGENTBOOK_MCP_ISSUER;
    vi.restoreAllMocks();
  });

  it('hands a client an https URL for managing its own registration', async () => {
    const body = await register('https');
    const uri = String(body.registration_client_uri ?? '');

    expect(uri, `registration_client_uri was ${uri}`).toMatch(/^https:\/\//);
    // The specific regression: an http URL under an https issuer.
    expect(uri.startsWith('http://')).toBe(false);
  });

  it('still describes a genuinely plaintext request as plaintext', async () => {
    // Not merely cosmetic: if the provider claimed https for every request it
    // would be guessing rather than reading the proxy, and the assertion above
    // would pass for the wrong reason.
    const body = await register('http');
    expect(String(body.registration_client_uri ?? '')).toMatch(/^http:\/\//);
  });
});
