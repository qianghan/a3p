import { describe, it, expect } from 'vitest';
import { scrubProperties, FUNNEL_EVENTS } from '../funnel.js';

describe('scrubProperties (PII safety)', () => {
  it('keeps allowlisted primitive properties', () => {
    expect(scrubProperties({ plan_code: 'pro', channel: 'web', ref: 'abc', interval: 'month' }))
      .toEqual({ plan_code: 'pro', channel: 'web', ref: 'abc', interval: 'month' });
  });
  it('drops non-allowlisted keys (emails, names, amounts, contents)', () => {
    expect(
      scrubProperties({ email: 'a@b.com', name: 'Jane', amount_cents: 5000, message: 'hi', plan_code: 'pro' }),
    ).toEqual({ plan_code: 'pro' });
  });
  it('drops non-primitive values even for allowlisted keys', () => {
    expect(scrubProperties({ plan_code: { nested: true }, channel: ['x'] } as never)).toEqual({});
  });
  it('handles undefined input', () => {
    expect(scrubProperties(undefined)).toEqual({});
  });
});

describe('FUNNEL_EVENTS', () => {
  it('covers the full revenue funnel in stage order', () => {
    expect(Object.values(FUNNEL_EVENTS)).toEqual([
      'funnel.signup_completed',
      'funnel.trial_started',
      'funnel.first_expense',
      'funnel.first_report',
      'funnel.card_added',
      'funnel.subscription_active',
      'funnel.subscription_cancelled',
    ]);
  });
});
