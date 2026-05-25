/**
 * Structured logger + Sentry-compatible error reporter (G-027 / PR 23).
 *
 * Replaces ad-hoc `console.log/warn/error` throughout the agent-side of the
 * codebase with consistent structured output. Adds an optional Sentry pipe
 * so production deployments can route errors to a real error-tracking
 * backend without forcing the dependency on dev / test installs.
 *
 * Design constraints:
 *   - Zero new runtime dependencies. Sentry is loaded via dynamic import
 *     only when SENTRY_DSN is set and `@sentry/nextjs` is installed.
 *   - JSON-line output in production for log aggregation (Datadog, Loki,
 *     Vercel log drains).
 *   - Human-readable output in dev so developers can read it.
 *   - Levels controlled by LOG_LEVEL env var (default: info).
 *   - Safe to import from server-only contexts (no client-bundle leakage).
 */

import 'server-only';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function activeLevel(): number {
  const env = (process.env.LOG_LEVEL || 'info').toLowerCase();
  const level = (LEVELS as Record<string, number>)[env];
  return typeof level === 'number' ? level : LEVELS.info;
}

function isProd(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
}

export interface LogContext {
  tenantId?: string;
  requestId?: string;
  channel?: string;
  skill?: string;
  source?: string;
  latencyMs?: number;
  [key: string]: unknown;
}

interface LogRecord extends LogContext {
  level: LogLevel;
  msg: string;
  timestamp: string;
  error?: {
    name?: string;
    message?: string;
    stack?: string;
  };
}

function buildRecord(
  level: LogLevel,
  msg: string,
  context: LogContext | undefined,
  err: unknown,
): LogRecord {
  const record: LogRecord = {
    level,
    msg,
    timestamp: new Date().toISOString(),
    ...(context || {}),
  };
  if (err) {
    if (err instanceof Error) {
      record.error = {
        name: err.name,
        message: err.message,
        stack: err.stack?.split('\n').slice(0, 12).join('\n'),
      };
    } else {
      record.error = { message: String(err) };
    }
  }
  return record;
}

function emit(record: LogRecord): void {
  if (LEVELS[record.level] < activeLevel()) return;

  if (isProd()) {
    const line = JSON.stringify(record);
    if (record.level === 'error') console.error(line);
    else if (record.level === 'warn') console.warn(line);
    else console.log(line);
    return;
  }

  const tags: string[] = [];
  if (record.tenantId) tags.push(`tenant=${record.tenantId}`);
  if (record.source) tags.push(`src=${record.source}`);
  if (record.skill) tags.push(`skill=${record.skill}`);
  if (record.latencyMs !== undefined) tags.push(`ms=${record.latencyMs}`);
  const tagStr = tags.length > 0 ? ` [${tags.join(' ')}]` : '';
  const errStr = record.error ? `\n  ${record.error.name}: ${record.error.message}` : '';
  const log =
    record.level === 'error'
      ? console.error
      : record.level === 'warn'
        ? console.warn
        : record.level === 'debug'
          ? console.debug
          : console.log;
  log(`[${record.timestamp}] ${record.level.toUpperCase().padEnd(5)} ${record.msg}${tagStr}${errStr}`);
}

export function debug(msg: string, context?: LogContext): void {
  emit(buildRecord('debug', msg, context, undefined));
}
export function info(msg: string, context?: LogContext): void {
  emit(buildRecord('info', msg, context, undefined));
}
export function warn(msg: string, context?: LogContext): void {
  emit(buildRecord('warn', msg, context, undefined));
}
export function error(msg: string, err?: unknown, context?: LogContext): void {
  emit(buildRecord('error', msg, context, err));
}

let sentryInitPromise: Promise<any | null> | null = null;

async function getSentry(): Promise<any | null> {
  if (!process.env.SENTRY_DSN) return null;
  if (!sentryInitPromise) {
    sentryInitPromise = (async () => {
      try {
        // Indirect string so vite's import-analysis can't statically resolve
        // the optional peer dependency — without this, vitest fails to even
        // load this file when @sentry/nextjs isn't installed. The indirect
        // form also satisfies TypeScript without `@ts-expect-error` since
        // the import target is `string`, not a known module specifier.
        const moduleName = '@sentry/nextjs';
        const mod = await import(/* @vite-ignore */ moduleName);
        return mod ?? null;
      } catch {
        return null;
      }
    })();
  }
  return sentryInitPromise;
}

/**
 * Report an error to both the structured log and Sentry (when configured).
 * Structured log always emits; Sentry is best-effort and never throws.
 */
export async function reportError(
  msg: string,
  err: unknown,
  context?: LogContext,
): Promise<void> {
  error(msg, err, context);

  const sentry = await getSentry();
  if (!sentry) return;

  try {
    if (typeof sentry.withScope === 'function') {
      sentry.withScope((scope: any) => {
        if (context) {
          for (const [k, v] of Object.entries(context)) {
            if (v !== undefined && v !== null) scope.setTag(k, String(v));
          }
        }
        if (err instanceof Error) sentry.captureException(err);
        else sentry.captureMessage(`${msg}: ${String(err)}`, 'error');
      });
    } else if (typeof sentry.captureException === 'function' && err instanceof Error) {
      sentry.captureException(err);
    }
  } catch {
    // Sentry must never break the user flow.
  }
}

/** Internal: reset module state. Tests only. */
export function __resetSentryForTests(): void {
  sentryInitPromise = null;
}
