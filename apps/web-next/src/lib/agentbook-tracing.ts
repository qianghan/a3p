/**
 * Vendor-agnostic OpenTelemetry-style trace export (PR 54 / Tier 4 #14).
 *
 * Emits OTLP/HTTP JSON spans when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 * Compatible with Datadog OTLP intake, Honeycomb, Grafana Tempo, New
 * Relic, AWS Distro, Uptrace — any OTLP receiver. Zero new
 * dependencies — uses fetch + crypto.randomUUID.
 *
 * Design:
 *   - `withSpan(name, ctx, fn)` wraps any async work, records duration,
 *     emits both a structured log line and an OTLP span on completion.
 *   - When OTEL is not configured, only the log line emits — same shape
 *     so log-based observability still gets trace_id / span_id fields
 *     for correlation in vendors like Loki / Datadog Logs.
 *   - Spans are sent synchronously fire-and-forget per call. Acceptable
 *     for serverless because the request handler awaits the span end and
 *     we never await the POST.
 *
 * Env vars:
 *   OTEL_EXPORTER_OTLP_ENDPOINT     OTLP/HTTP collector URL (no trailing /v1/traces)
 *   OTEL_EXPORTER_OTLP_HEADERS      "key1=val1,key2=val2" header pairs
 *   OTEL_SERVICE_NAME               defaults to "agentbook"
 */

import 'server-only';
import * as log from './logger';

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || 'agentbook';

function getEndpoint(): string | null {
  const ep = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!ep) return null;
  // OTLP/HTTP spec: append /v1/traces to the base endpoint per the
  // collector convention (Datadog, Honeycomb, Tempo all follow this).
  return ep.endsWith('/v1/traces') ? ep : `${ep.replace(/\/$/, '')}/v1/traces`;
}

function getHeaders(): Record<string, string> {
  const raw = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/** 16 random bytes (32 hex chars) for OTLP traceId. */
function newTraceId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** 8 random bytes (16 hex chars) for OTLP spanId. */
function newSpanId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

export interface SpanAttributes {
  tenantId?: string;
  skill?: string;
  channel?: string;
  status?: 'ok' | 'error' | 'timeout';
  errorType?: string;
  [key: string]: string | number | boolean | undefined;
}

export interface SpanHandle {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startNs: bigint;
}

function nowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

function toOtlpAttribute(key: string, value: string | number | boolean) {
  if (typeof value === 'string') return { key, value: { stringValue: value } };
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (Number.isInteger(value)) return { key, value: { intValue: value } };
  return { key, value: { doubleValue: value } };
}

function fireOtlpSpan(
  handle: SpanHandle,
  name: string,
  attributes: SpanAttributes,
  endNs: bigint,
): void {
  const endpoint = getEndpoint();
  if (!endpoint) return;

  const cleanedAttrs = Object.entries(attributes)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => toOtlpAttribute(k, v as string | number | boolean));

  const body = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            toOtlpAttribute('service.name', SERVICE_NAME),
            toOtlpAttribute('deployment.environment', process.env.VERCEL_ENV || 'unknown'),
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'agentbook' },
            spans: [
              {
                traceId: handle.traceId,
                spanId: handle.spanId,
                ...(handle.parentSpanId ? { parentSpanId: handle.parentSpanId } : {}),
                name,
                kind: 1, // SPAN_KIND_INTERNAL
                startTimeUnixNano: handle.startNs.toString(),
                endTimeUnixNano: endNs.toString(),
                attributes: cleanedAttrs,
                status:
                  attributes.status === 'error' || attributes.status === 'timeout'
                    ? { code: 2 } // STATUS_CODE_ERROR
                    : { code: 1 }, // STATUS_CODE_OK
              },
            ],
          },
        ],
      },
    ],
  };

  // Fire-and-forget. The endpoint is short-lived; even a slow OTLP
  // collector shouldn't block our user-facing handler.
  void fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders() },
    body: JSON.stringify(body),
  }).catch(() => {
    /* OTLP outages must never break the user flow */
  });
}

/**
 * Run an async function inside a span. The span is logged AND exported
 * via OTLP when configured. Errors thrown from `fn` are propagated after
 * the span is closed with status=error.
 *
 *   await withSpan('agent.message', { tenantId, channel: 'web' }, async (span) => {
 *     // ... do work ...
 *     span.attr('skill', 'record-expense');
 *   });
 */
export async function withSpan<T>(
  name: string,
  context: SpanAttributes,
  fn: (span: { attr: (k: string, v: string | number | boolean) => void; handle: SpanHandle }) => Promise<T>,
): Promise<T> {
  const handle: SpanHandle = {
    traceId: newTraceId(),
    spanId: newSpanId(),
    startNs: nowNs(),
  };
  const attributes: SpanAttributes = { ...context };
  const span = {
    handle,
    attr(k: string, v: string | number | boolean) {
      attributes[k] = v;
    },
  };

  let thrown: unknown;
  try {
    const result = await fn(span);
    attributes.status = (attributes.status as 'ok' | 'error' | 'timeout' | undefined) || 'ok';
    return result;
  } catch (err) {
    attributes.status = 'error';
    attributes.errorType = (err as { name?: string })?.name || 'error';
    thrown = err;
    throw err;
  } finally {
    const endNs = nowNs();
    const durationMs = Number((endNs - handle.startNs) / 1_000_000n);

    // Always emit the log line — gives Datadog/Loki the trace_id field
    // even when no OTLP collector is configured.
    log.info(`span:${name}`, {
      ...context,
      trace_id: handle.traceId,
      span_id: handle.spanId,
      latencyMs: durationMs,
      status: attributes.status,
      ...(attributes.skill ? { skill: attributes.skill as string } : {}),
      ...(attributes.errorType ? { errorType: attributes.errorType as string } : {}),
    });

    fireOtlpSpan(handle, name, attributes, endNs);

    if (thrown) {
      // re-thrown above; this branch is unreachable but explicit for the reader
    }
  }
}

/**
 * Record a single trace-correlated event without wrapping a function.
 * Useful for cron handlers that already manage their own timing.
 */
export function recordSpan(
  name: string,
  attributes: SpanAttributes,
  durationMs: number,
): void {
  const handle: SpanHandle = {
    traceId: newTraceId(),
    spanId: newSpanId(),
    startNs: nowNs() - BigInt(durationMs) * 1_000_000n,
  };
  log.info(`span:${name}`, {
    ...attributes,
    trace_id: handle.traceId,
    span_id: handle.spanId,
    latencyMs: durationMs,
  });
  fireOtlpSpan(handle, name, attributes, nowNs());
}

export function isOtelConfigured(): boolean {
  return Boolean(getEndpoint());
}
