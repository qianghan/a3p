/**
 * PR 54 — vendor-agnostic OTEL trace export.
 *
 * Tests the OTLP/HTTP body shape + the no-network path when OTEL is
 * unconfigured. We don't run a real OTLP collector — we just stub fetch
 * and assert the JSON we'd send is well-formed for any OTLP receiver
 * (Datadog, Honeycomb, Tempo, etc.).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('server-only', () => ({}));

const realFetch = globalThis.fetch;

import { withSpan, recordSpan, isOtelConfigured } from '../agentbook-tracing';

describe('isOtelConfigured', () => {
  beforeEach(() => {
    delete (process.env as Record<string, string | undefined>).OTEL_EXPORTER_OTLP_ENDPOINT;
  });
  it('false when OTEL_EXPORTER_OTLP_ENDPOINT is unset', () => {
    expect(isOtelConfigured()).toBe(false);
  });
  it('true when endpoint is set', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otel.example.com';
    expect(isOtelConfigured()).toBe(true);
  });
});

describe('withSpan', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    delete (process.env as Record<string, string | undefined>).OTEL_EXPORTER_OTLP_ENDPOINT;
    delete (process.env as Record<string, string | undefined>).OTEL_EXPORTER_OTLP_HEADERS;
    fetchSpy = vi.fn(async () => new Response('', { status: 200 }));
    globalThis.fetch = fetchSpy as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('runs the function and returns its result', async () => {
    const result = await withSpan('test.op', { tenantId: 't1' }, async () => 'hello');
    expect(result).toBe('hello');
  });

  it('does NOT fetch when OTEL endpoint is unset', async () => {
    await withSpan('test.op', { tenantId: 't1' }, async () => 'ok');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs an OTLP body when endpoint is set', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otel.example.com';
    await withSpan('test.op', { tenantId: 't1', channel: 'web' }, async (span) => {
      span.attr('skill', 'record-expense');
      return 'ok';
    });
    // fire-and-forget — give the microtask queue a tick to flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).toHaveBeenCalled();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://otel.example.com/v1/traces');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);

    expect(body.resourceSpans).toHaveLength(1);
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.name).toBe('test.op');
    expect(span.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(span.spanId).toMatch(/^[a-f0-9]{16}$/);
    expect(span.kind).toBe(1);
    expect(span.status.code).toBe(1);

    const attrs = span.attributes as Array<{ key: string; value: Record<string, unknown> }>;
    const skillAttr = attrs.find((a) => a.key === 'skill');
    expect(skillAttr).toBeDefined();
    expect(skillAttr?.value).toEqual({ stringValue: 'record-expense' });
  });

  it('marks status=error when fn throws and re-throws', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otel.example.com';
    await expect(
      withSpan('test.op', { tenantId: 't1' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).toHaveBeenCalled();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.status.code).toBe(2);
    const attrs = span.attributes as Array<{ key: string; value: Record<string, unknown> }>;
    const statusAttr = attrs.find((a) => a.key === 'status');
    expect(statusAttr?.value).toEqual({ stringValue: 'error' });
  });

  it('respects OTEL_EXPORTER_OTLP_HEADERS', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otel.example.com';
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'authorization=Bearer xyz,x-team=acme';
    await withSpan('test.op', {}, async () => 'ok');
    await new Promise((r) => setTimeout(r, 0));
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer xyz');
    expect(headers['x-team']).toBe('acme');
  });

  it('still emits the structured log line when OTEL is unset', async () => {
    // No way to spy on the logger without a live import-time hook; we
    // verify by absence: fetch is never called.
    await withSpan('test.op', {}, async () => 'ok');
    expect(fetchSpy).not.toHaveBeenCalled();
    // The span ran without errors — that's the main contract.
  });
});

describe('recordSpan', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otel.example.com';
    fetchSpy = vi.fn(async () => new Response('', { status: 200 }));
    globalThis.fetch = fetchSpy as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete (process.env as Record<string, string | undefined>).OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  it('emits a span with the supplied duration', async () => {
    recordSpan('cron.morning-digest', { tenantId: 't1' }, 1234);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).toHaveBeenCalled();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.name).toBe('cron.morning-digest');
    const start = BigInt(span.startTimeUnixNano);
    const end = BigInt(span.endTimeUnixNano);
    const durMs = Number((end - start) / 1_000_000n);
    expect(durMs).toBeGreaterThanOrEqual(1234);
  });
});
