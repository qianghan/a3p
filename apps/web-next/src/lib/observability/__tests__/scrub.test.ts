import { describe, it, expect } from 'vitest';
import { scrubUrl, scrubContext, beforeSend, isSensitiveKey, REDACTED } from '../scrub';

/**
 * These assertions are about customer data leaving the process, so they are
 * written as "this specific thing must not appear", not "the scrubber ran".
 */

describe('isSensitiveKey', () => {
  it.each([
    'token', 'ACCESS_TOKEN', 'plaid_access_token', 'X-Api-Key', 'authorization',
    'stripe_secret', 'accountNumber', 'routingNumber', 'bsb', 'card_last4',
    'ssn', 'sin', 'tfn', 'abn', 'taxId', 'userEmail', 'phoneNumber', 'dob',
  ])('%s is sensitive', (k) => expect(isSensitiveKey(k)).toBe(true));

  it.each(['tenantId', 'period', 'invoiceId', 'status', 'skill', 'latencyMs'])(
    '%s is not sensitive',
    (k) => expect(isSensitiveKey(k)).toBe(false),
  );

  // A substring match over-redacts as badly as it under-redacts. Every name
  // below contains a sensitive abbreviation and is an ordinary field in this
  // codebase; `businessType` in particular is branched on throughout. Losing
  // these from a report makes it useless in exactly the cases someone reads it.
  it.each([
    'businessName', 'businessType', 'discardedAt', 'author', 'wildcard',
    'einvoice', 'cardinality', 'sortOrder',
  ])('%s is NOT redacted despite containing a sensitive abbreviation', (k) =>
    expect(isSensitiveKey(k)).toBe(false),
  );

  // ...but the abbreviations themselves, as whole words in any convention.
  it.each(['sin', 'SIN', 'taxFileNumber', 'tfn', 'user.abn', 'card-number', 'X-Auth', 'socialSecurityNumber'])(
    '%s is sensitive as a whole word',
    (k) => expect(isSensitiveKey(k)).toBe(true),
  );
});

describe('scrubUrl', () => {
  it('keeps the path and the parameter names, drops every value', () => {
    expect(scrubUrl('/api/v1/tax/estimate?tenantId=abc123&period=2026Q1')).toBe(
      `/api/v1/tax/estimate?tenantId=${REDACTED}&period=${REDACTED}`,
    );
  });

  it('drops a value even when the key looks harmless', () => {
    // A URL is where a caller's own naming decides what reaches a third
    // party, so "looks harmless" is not a judgement this code should make.
    expect(scrubUrl('/x?note=lunch%20with%20client%20re%20merger')).not.toContain('merger');
  });

  it('leaves a url with no query alone', () => {
    expect(scrubUrl('/api/health')).toBe('/api/health');
  });

  it('handles a fragment and an empty query without producing junk', () => {
    expect(scrubUrl('/x?#frag')).toBe('/x');
    expect(scrubUrl('/x?a=1#frag')).toBe(`/x?a=${REDACTED}`);
  });
});

describe('scrubContext', () => {
  it('redacts sensitive keys at depth', () => {
    const out = scrubContext({
      tenantId: 't1',
      bank: { plaid: { access_token: 'secret-value' }, name: 'Chase' },
    }) as any;
    expect(out.tenantId).toBe('t1');
    expect(out.bank.name).toBe('Chase');
    expect(out.bank.plaid.access_token).toBe(REDACTED);
    expect(JSON.stringify(out)).not.toContain('secret-value');
  });

  it('stops recursing rather than overflowing on a cyclic object', () => {
    // A Prisma result or a request object can be cyclic, and a stack overflow
    // inside the error reporter would take down the request it describes.
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => scrubContext(cyclic)).not.toThrow();
  });

  it('caps array width', () => {
    expect((scrubContext(Array.from({ length: 500 }, (_, i) => i)) as unknown[]).length).toBe(50);
  });
});

describe('beforeSend', () => {
  it('removes the user block entirely', () => {
    const out = beforeSend({ user: { id: 'u1', email: 'maya@example.com', ip_address: '1.2.3.4' } });
    expect(out?.user).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('maya@example.com');
  });

  it('removes the request body and cookies', () => {
    const out = beforeSend({
      request: {
        url: '/api/v1/expense?tenantId=t1',
        data: { amountCents: 4200, vendor: 'Acme', receipt: 'base64...' },
        cookies: { session: 'abc' },
        headers: { 'content-type': 'application/json', authorization: 'Bearer xyz' },
        query_string: 'tenantId=t1',
      },
    });
    expect(out?.request.data).toBeUndefined();
    expect(out?.request.cookies).toBeUndefined();
    expect(out?.request.headers.authorization).toBe(REDACTED);
    // A non-sensitive header is diagnostic and stays.
    expect(out?.request.headers['content-type']).toBe('application/json');
    expect(out?.request.query_string).toBe(REDACTED);
    const serialized = JSON.stringify(out);
    for (const leaked of ['4200', 'Acme', 'base64', 'Bearer xyz', 'abc']) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it('scrubs extra and contexts', () => {
    const out = beforeSend({ extra: { apiKey: 'k' }, contexts: { plaid: { token: 't' } } });
    expect(out?.extra.apiKey).toBe(REDACTED);
    expect(out?.contexts.plaid.token).toBe(REDACTED);
  });

  it('passes an event with nothing sensitive through unharmed', () => {
    const out = beforeSend({ message: 'boom', tags: { tenantId: 't1', skill: 'record-expense' } });
    expect(out?.message).toBe('boom');
    expect(out?.tags.tenantId).toBe('t1');
  });
});

describe('against the real schema', () => {
  /**
   * The pattern lists are a judgement call, and both ways of getting it wrong
   * are invisible in review: too narrow leaks a credential, too broad empties
   * the report of the fields someone needs. So run them over every field name
   * the database actually has and pin the outcome.
   */
  const fields = (() => {
    try {
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      const { join } = require('node:path') as typeof import('node:path');
      const schema = readFileSync(
        join(__dirname, '..', '..', '..', '..', '..', '..', 'packages', 'database', 'prisma', 'schema.prisma'),
        'utf8',
      );
      return [...new Set(
        schema.split('\n')
          .map((l) => l.match(/^ {2}([a-zA-Z][a-zA-Z0-9_]*)/)?.[1])
          .filter((v): v is string => Boolean(v)),
      )];
    } catch {
      return [];
    }
  })();

  it('scans a real schema, not an empty list', () => {
    expect(fields.length).toBeGreaterThan(500);
  });

  it('catches every field that actually holds a credential', () => {
    const mustCatch = [
      'passwordHash', 'accessToken', 'refreshToken', 'tokenHash', 'secretHash',
      'secretKey', 'botToken', 'webhookSecret', 'apiKey', 'apiKeyEnc',
      'accessTokenEnc', 'credentials', 'dateOfBirth', 'email', 'ipAddress',
    ];
    for (const f of mustCatch) {
      expect(fields, `${f} is no longer a schema field — update this list`).toContain(f);
      expect(isSensitiveKey(f), `${f} must be redacted`).toBe(true);
    }
  });

  it('does not redact the fields diagnostics depend on', () => {
    const mustKeep = [
      'tenantId', 'businessType', 'status', 'createdAt', 'amountCents',
      'currency', 'jurisdiction', 'category', 'invoiceId',
    ];
    for (const f of mustKeep) expect(isSensitiveKey(f), `${f} must survive`).toBe(false);
  });

  it('redacts a small minority of fields, not most of them', () => {
    // Pins the blast radius: a pattern edit that suddenly redacts a third of
    // the schema is a bug, and would otherwise pass every test above.
    const flagged = fields.filter(isSensitiveKey).length;
    const pct = (flagged / fields.length) * 100;
    expect(pct, `${flagged}/${fields.length} fields redacted (${pct.toFixed(1)}%)`).toBeLessThan(10);
    expect(pct).toBeGreaterThan(1);
  });
});
