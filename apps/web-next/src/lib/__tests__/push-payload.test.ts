import { describe, it, expect } from 'vitest';
import { buildPushPayload } from '../push-payload';

describe('push payload', () => {
  it('serializes title and body with a default url', () => {
    const p = JSON.parse(buildPushPayload({ title: 'Tax due', body: 'Q2 estimate due in 7 days' }));
    expect(p.title).toBe('Tax due');
    expect(p.body).toBe('Q2 estimate due in 7 days');
    expect(p.url).toBe('/app');
  });
  it('keeps an explicit relative url', () => {
    const p = JSON.parse(buildPushPayload({ title: 'x', body: 'y', url: '/app/docs' }));
    expect(p.url).toBe('/app/docs');
  });
  it('rejects non-relative urls (open-redirect guard) and falls back to /app', () => {
    const p = JSON.parse(buildPushPayload({ title: 'x', body: 'y', url: 'https://evil.example/phish' }));
    expect(p.url).toBe('/app');
  });
});
