/**
 * Constructs the REAL oidc-provider and drives a real Dynamic Client
 * Registration request through it.
 *
 * The sibling suite (oauth-provider.test.ts) mocks `oidc-provider` wholesale
 * and asserts the config object we pass in. That is why this bug shipped: the
 * defect was never in our object, it was in what oidc-provider DOES with it —
 * `refresh_token` is only an enabled grant type when `offline_access` is in
 * `scopes` or `issueRefreshToken` is overridden, and we had neither. A test
 * that asserts our own input can never see that.
 *
 * So this file constructs the genuine provider and asks it the question a
 * client asks: may I register for the refresh_token grant?
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

vi.mock('server-only', () => ({}));

// A memory adapter with oidc-provider's contract, so no database is involved.
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
  async consume(id: string) { const v = this.bucket.get(id); if (v) v.consumed = Math.floor(Date.now() / 1000); }
  async destroy(id: string) { this.bucket.delete(id); }
  async revokeByGrantId() { /* no grants in these tests */ }
}
vi.mock('@naap/database', () => ({ PrismaOidcAdapter: MemoryAdapter }));

async function registerClient(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const { getOAuthProvider } = await import('./oauth-provider');
  const provider = getOAuthProvider();

  // oidc-provider routes on the request URL, and its configured registration
  // route is the full '/api/v1/oauth/register' path, so the request has to
  // arrive at that exact URL — which is what the catch-all route handler
  // gives it in production.
  const server: Server = createServer(provider.callback());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    // node:http rather than fetch on purpose — this project's vitest setup
    // replaces global fetch with a mock that throws, and the point of this
    // suite is to make a REAL request to a REAL provider.
    return await new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/api/v1/oauth/register',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode ?? 0, json: JSON.parse(raw) as Record<string, unknown> });
            } catch (err) {
              reject(new Error(`non-JSON response (${res.statusCode}): ${raw.slice(0, 200)} / ${(err as Error).message}`));
            }
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

const BASE = {
  client_name: 'test client',
  redirect_uris: ['http://127.0.0.1:41234/callback'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

describe('the OAuth provider actually supports refresh tokens', () => {
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

  // The exact metadata Gemini CLI sends —
  // @google/gemini-cli-core/dist/src/mcp/oauth-provider.js:
  //   grant_types: ['authorization_code', 'refresh_token']
  // Before the `issueRefreshToken` override this returned
  // 400 invalid_client_metadata and the connector could not be added at all.
  it('accepts a client that registers for authorization_code AND refresh_token', async () => {
    const { status, json } = await registerClient({
      ...BASE,
      grant_types: ['authorization_code', 'refresh_token'],
    });

    expect(json.error_description ?? '').not.toContain('grant_types');
    expect(status).toBe(201);
    expect(json.grant_types).toEqual(expect.arrayContaining(['refresh_token']));
  });

  it('still accepts a client that only wants authorization_code', async () => {
    const { status } = await registerClient({ ...BASE, grant_types: ['authorization_code'] });
    expect(status).toBe(201);
  });

  it('rejects a grant we do not support, so the check is not vacuous', async () => {
    const { status, json } = await registerClient({
      ...BASE,
      grant_types: ['authorization_code', 'client_credentials'],
    });
    expect(status).toBe(400);
    expect(json.error).toBe('invalid_client_metadata');
  });
});
