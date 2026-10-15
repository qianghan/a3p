import { vi } from 'vitest';

/** In-memory stand-in for POST /expenses/from-receipt with PR 1's contract: same key → same expense, duplicate:true. */
export function fakeServer() {
  const byKey = new Map<string, string>();
  const calls: Array<{ url: string; key: string; fields: Record<string, string>; fileName: string | null; fileSize: number }> = [];
  let mode: 'ok' | 'throw' | 'sw-offline' | 'http500' | 'http401' | 'http413' | 'http400' | 'http408' | 'http409' | 'http429' = 'ok';
  let userId: string | null = 'user-1';
  let meCalls = 0;
  let meFailure: null | 'http503' | 'html200' | 'http403' = null;
  const STATUS_MODES: Record<string, number> = { http413: 413, http400: 400, http408: 408, http409: 409, http429: 429 };
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (mode === 'throw') throw new TypeError('Failed to fetch');
    if (mode === 'sw-offline') return new Response(JSON.stringify({ success: false, error: 'Offline' }), { status: 503, headers: { 'X-Agentbook-Offline': '1' } });
    if (url === '/api/v1/auth/me') {
      meCalls += 1;
      // A transient server problem, a captive portal and a revoked session are three different answers.
      if (meFailure === 'http503') return new Response(JSON.stringify({ success: false, error: 'unavailable' }), { status: 503 });
      if (meFailure === 'html200') return new Response('<html>Sign in to the Wi-Fi</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      if (meFailure === 'http403') return new Response(JSON.stringify({ success: false, error: 'Forbidden' }), { status: 403 });
      if (userId === null) return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 });
      return new Response(JSON.stringify({ success: true, data: { user: { id: userId }, expiresAt: 'x', csrfToken: 'y' } }), { status: 200 });
    }
    if (typeof init?.body === 'string') return new Response(JSON.stringify({ success: true, data: { id: 'manual-1' } }), { status: 201 });
    const form = init!.body as FormData;
    const fields: Record<string, string> = {};
    form.forEach((v, k) => { if (k !== 'file' && k !== 'idempotencyKey') fields[k] = String(v); });
    const file = form.get('file') as File | null;
    const key = String(form.get('idempotencyKey') ?? '');
    calls.push({ url, key, fields, fileName: file?.name ?? null, fileSize: file?.size ?? 0 });
    if (mode === 'http500') return new Response(JSON.stringify({ success: false, error: 'boom' }), { status: 500 });
    if (STATUS_MODES[mode]) return new Response(JSON.stringify({ success: false, error: mode }), { status: STATUS_MODES[mode] });
    if (mode === 'http401') return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 });
    const duplicate = byKey.has(key);
    if (!duplicate) byKey.set(key, `exp_${byKey.size + 1}`);
    return new Response(JSON.stringify({ success: true, data: { doc: { id: byKey.get(key) }, duplicate, ocr: { amountCents: null, vendor: null, date: null } } }), { status: duplicate ? 200 : 201 });
  });
  return {
    fetchImpl, byKey, calls,
    get meCalls() { return meCalls; },
    setMode: (m: typeof mode) => { mode = m; },
    setUser: (id: string | null) => { userId = id; },
    setMeFailure: (f: typeof meFailure) => { meFailure = f; },
  };
}
