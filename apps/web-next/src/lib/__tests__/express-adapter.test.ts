import { describe, it, expect, vi } from 'vitest';
// Stub `server-only` so we can import the adapter under test.
vi.mock('server-only', () => ({}));
import express from 'express';
import compression from 'compression';
import { dispatchToExpress } from '../express-adapter';

function makeRequest(url: string, init: RequestInit = {}): any {
  // Minimal NextRequest-like shim
  const u = new URL(url);
  const headers = new Headers(init.headers);
  return {
    url,
    method: init.method || 'GET',
    headers,
    arrayBuffer: async () => new ArrayBuffer(0),
    nextUrl: { pathname: u.pathname, search: u.search },
    cookies: { get: () => undefined },
  } as any;
}

describe('dispatchToExpress', () => {
  it('returns the JSON body Express writes', async () => {
    const app = express();
    app.get('/hello', (_req, res) => {
      res.json({ ok: true, value: 'hello' });
    });

    const response = await dispatchToExpress(app as any, makeRequest('http://x/hello'));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('hello');
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({ ok: true, value: 'hello' });
  });

  it('returns 404 with body when no route matches', async () => {
    const app = express();
    app.get('/known', (_req, res) => res.json({ ok: true }));

    const response = await dispatchToExpress(app as any, makeRequest('http://x/unknown'));
    expect(response.status).toBe(404);
    const text = await response.text();
    // Express finalhandler writes "Cannot GET /unknown" in the HTML body
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('Cannot GET');
  });

  it('returns body even when compression middleware is registered (accept-encoding identity)', async () => {
    const app = express();
    app.use(compression());
    app.get('/hello', (_req, res) => {
      res.json({ ok: true });
    });

    const response = await dispatchToExpress(app as any, makeRequest('http://x/hello'));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe('{"ok":true}');
  });

  it('returns 500 with body when route throws', async () => {
    const app = express();
    app.get('/boom', (_req, _res, next) => { next(new Error('kaboom')); });

    const response = await dispatchToExpress(app as any, makeRequest('http://x/boom'));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text.length).toBeGreaterThan(0);
  });

  it('handles a complex middleware stack with route-level catch', async () => {
    const app = express();
    app.use(compression());
    app.use(express.json());
    const router = express.Router();
    router.get('/api/echo/:value', async (req: any, res) => {
      res.json({ value: req.params.value });
    });
    app.use(router);

    const response = await dispatchToExpress(app as any, makeRequest('http://x/api/echo/test123'));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('test123');
  });
});
