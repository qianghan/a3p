import { test, expect } from '@playwright/test';

const CORE = 'http://localhost:4050';
const TAX = 'http://localhost:4053';
const MAYA = '2e2348b6-a64c-44ad-907e-4ac120ff06f2';
const H = { 'x-tenant-id': MAYA, 'Content-Type': 'application/json' };

test.describe.serial('Tax Filing Agent', () => {
  test('seed forms creates 4 Canadian templates', async ({ request }) => {
    const res = await request.post(`${TAX}/api/v1/agentbook-tax/tax-forms/seed`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.created + body.data.updated).toBe(4);
  });

  test('tax-filing-start: "start my tax filing"', async ({ request }) => {
    const res = await request.post(`${CORE}/api/v1/agentbook-core/agent/message`, {
      headers: H, data: { text: 'start my tax filing for 2025', channel: 'api' },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.data.skillUsed).toBe('tax-filing-start');
    expect(body.data.message).toContain('Tax Filing');
  });

  test('tax-filing-status: "what is missing?"', async ({ request }) => {
    const res = await request.post(`${CORE}/api/v1/agentbook-core/agent/message`, {
      headers: H, data: { text: 'what is missing for my tax filing?', channel: 'api' },
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).data.skillUsed).toBe('tax-filing-status');
  });

  test('tax-slip-list: "show my tax slips"', async ({ request }) => {
    const res = await request.post(`${CORE}/api/v1/agentbook-core/agent/message`, {
      headers: H, data: { text: 'show my tax slips', channel: 'api' },
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).data.skillUsed).toBe('tax-slip-list');
  });

  test('ca-t2125-review: "review T2125"', async ({ request }) => {
    const res = await request.post(`${CORE}/api/v1/agentbook-core/agent/message`, {
      headers: H, data: { text: 'review T2125', channel: 'api' },
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).data.skillUsed).toBe('ca-t2125-review');
  });

  test('ca-t1-review: "review T1 general"', async ({ request }) => {
    const res = await request.post(`${CORE}/api/v1/agentbook-core/agent/message`, {
      headers: H, data: { text: 'review my T1 general return', channel: 'api' },
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).data.skillUsed).toBe('ca-t1-review');
  });

  test('ca-gst-hst-review: "review GST return"', async ({ request }) => {
    const res = await request.post(`${CORE}/api/v1/agentbook-core/agent/message`, {
      headers: H, data: { text: 'review my GST return', channel: 'api' },
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).data.skillUsed).toBe('ca-gst-hst-review');
  });

  test('filing endpoint returns completeness', async ({ request }) => {
    const res = await request.get(`${TAX}/api/v1/agentbook-tax/tax-filing/2025`, { headers: H });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.data.completeness).toBeGreaterThanOrEqual(0);
    expect(body.data.forms.length).toBe(4);
  });

  test('auto-population fills revenue from books', async ({ request }) => {
    const res = await request.get(`${TAX}/api/v1/agentbook-tax/tax-filing/2025`, { headers: H });
    const body = await res.json();
    const t2125 = body.data.forms.find((f: any) => f.formCode === 'T2125');
    expect(t2125).toBeTruthy();
    expect(t2125.completeness).toBeGreaterThan(0);
  });

  test('field update works', async ({ request }) => {
    const updateRes = await request.post(`${TAX}/api/v1/agentbook-tax/tax-filing/2025/field`, {
      headers: H,
      data: { formCode: 'T2125', fieldId: 'industry_code', value: '541611' },
    });
    expect(updateRes.ok()).toBeTruthy();
    expect((await updateRes.json()).data.updated).toBe(true);
  });
});
