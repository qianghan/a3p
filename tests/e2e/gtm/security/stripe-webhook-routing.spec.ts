import { test, expect } from '@playwright/test';

test.describe('GTM security — Stripe webhook routing', () => {
  test('plugin-level /stripe/webhook is deleted', async ({ request }) => {
    // Hit the plugin's old route — must be 404
    const r = await request.post('http://localhost:4051/stripe/webhook', {
      data: { type: 'payment_intent.succeeded', id: 'evt_fake' },
    });
    expect(r.status()).toBe(404);
  });

  test('plugin-level /stripe/checkout-completed is deleted', async ({ request }) => {
    const r = await request.post('http://localhost:4052/stripe/checkout-completed', {
      data: { type: 'checkout.session.completed', id: 'evt_fake' },
    });
    expect(r.status()).toBe(404);
  });
});
