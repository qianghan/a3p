import { vi } from 'vitest';

/** In-memory stand-in for POST /expenses/from-receipt with PR 1's contract: same key → same expense, duplicate:true. */
export function fakeServer() {
  const byKey = new Map<string, string>();
  const calls: Array<{ url: string; key: string; fields: Record<string, string>; fileName: string | null; fileSize: number }> = [];
  let mode: 'ok' | 'throw' | 'sw-offline' | 'http500' | 'http401' = 'ok';
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (mode === 'throw') throw new TypeError('Failed to fetch');
    if (mode === 'sw-offline') return new Response(JSON.stringify({ success: false, error: 'Offline' }), { status: 503, headers: { 'X-Agentbook-Offline': '1' } });
    if (typeof init?.body === 'string') return new Response(JSON.stringify({ success: true, data: { id: 'manual-1' } }), { status: 201 });
    const form = init!.body as FormData;
    const fields: Record<string, string> = {};
    form.forEach((v, k) => { if (k !== 'file' && k !== 'idempotencyKey') fields[k] = String(v); });
    const file = form.get('file') as File | null;
    const key = String(form.get('idempotencyKey') ?? '');
    calls.push({ url, key, fields, fileName: file?.name ?? null, fileSize: file?.size ?? 0 });
    if (mode === 'http500') return new Response(JSON.stringify({ success: false, error: 'boom' }), { status: 500 });
    if (mode === 'http401') return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 });
    const duplicate = byKey.has(key);
    if (!duplicate) byKey.set(key, `exp_${byKey.size + 1}`);
    return new Response(JSON.stringify({ success: true, data: { doc: { id: byKey.get(key) }, duplicate, ocr: { amountCents: null, vendor: null, date: null } } }), { status: duplicate ? 200 : 201 });
  });
  return { fetchImpl, byKey, calls, setMode: (m: typeof mode) => { mode = m; } };
}
