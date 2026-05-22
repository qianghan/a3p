import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  debug,
  info,
  warn,
  error,
  reportError,
  __resetSentryForTests,
} from '../logger';

describe('logger', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    delete (process.env as Record<string, string | undefined>).LOG_LEVEL;
    delete (process.env as Record<string, string | undefined>).SENTRY_DSN;
    delete (process.env as Record<string, string | undefined>).NODE_ENV;
    delete (process.env as Record<string, string | undefined>).VERCEL_ENV;
    __resetSentryForTests();
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    debugSpy.mockRestore();
  });

  describe('level filtering', () => {
    it('default level is info — debug is suppressed', () => {
      debug('hidden');
      info('visible');
      expect(debugSpy).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalled();
    });

    it('LOG_LEVEL=debug shows everything', () => {
      process.env.LOG_LEVEL = 'debug';
      debug('shown');
      info('shown');
      warn('shown');
      error('shown');
      // dev format: debug → console.debug, info → console.log, warn → console.warn, error → console.error
      expect(debugSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('LOG_LEVEL=error suppresses info/warn', () => {
      process.env.LOG_LEVEL = 'error';
      info('hidden');
      warn('hidden');
      error('shown');
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('invalid LOG_LEVEL falls back to info', () => {
      process.env.LOG_LEVEL = 'garbage';
      debug('hidden');
      info('shown');
      expect(debugSpy).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('production JSON output', () => {
    beforeEach(() => {
      (process.env as Record<string, string>).NODE_ENV = 'production';
    });

    it('emits JSON line with timestamp + level + msg', () => {
      info('hello world', { tenantId: 't1', source: 'test' });
      expect(logSpy).toHaveBeenCalledOnce();
      const line = logSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(line);
      expect(parsed.level).toBe('info');
      expect(parsed.msg).toBe('hello world');
      expect(parsed.tenantId).toBe('t1');
      expect(parsed.source).toBe('test');
      expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('error record includes name + message + truncated stack', () => {
      const e = new Error('boom');
      error('something failed', e, { tenantId: 't1' });
      const line = errorSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(line);
      expect(parsed.level).toBe('error');
      expect(parsed.error.name).toBe('Error');
      expect(parsed.error.message).toBe('boom');
      expect(parsed.error.stack).toContain('Error: boom');
      expect(parsed.error.stack.split('\n').length).toBeLessThanOrEqual(12);
    });

    it('non-Error thrown values are stringified', () => {
      error('fail', 'plain string', { source: 'x' });
      const line = errorSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(line);
      expect(parsed.error.message).toBe('plain string');
    });
  });

  describe('dev human-readable output', () => {
    beforeEach(() => {
      (process.env as Record<string, string>).NODE_ENV = 'development';
    });

    it('emits a single readable line', () => {
      info('hello', { tenantId: 't1', source: 'web' });
      const line = logSpy.mock.calls[0][0] as string;
      expect(line).toContain('INFO');
      expect(line).toContain('hello');
      expect(line).toContain('tenant=t1');
      expect(line).toContain('src=web');
    });

    it('includes latency tag when provided', () => {
      info('request done', { latencyMs: 123 });
      const line = logSpy.mock.calls[0][0] as string;
      expect(line).toContain('ms=123');
    });
  });

  describe('reportError', () => {
    it('always emits a structured log', async () => {
      await reportError('something broke', new Error('boom'), { tenantId: 't1' });
      expect(errorSpy).toHaveBeenCalledOnce();
    });

    it('does not throw when SENTRY_DSN is unset', async () => {
      // No DSN — should silently skip Sentry path.
      await expect(reportError('x', new Error('y'))).resolves.not.toThrow();
    });

    it('does not throw when @sentry/nextjs is missing', async () => {
      process.env.SENTRY_DSN = 'https://fake@sentry.io/1';
      // The import will throw (no package), which the helper catches.
      await expect(reportError('x', new Error('y'), { tenantId: 't1' })).resolves.not.toThrow();
    });
  });
});
