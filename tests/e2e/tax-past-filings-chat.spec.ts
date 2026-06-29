import { test, expect } from '@playwright/test';

const CORE = 'http://localhost:4050';
const MAYA = '2e2348b6-a64c-44ad-907e-4ac120ff06f2';
const H = { 'x-tenant-id': MAYA, 'Content-Type': 'application/json' };

test.describe.serial('Past Tax Filings — chat skill', () => {
  test('query-past-filings: "show my past filings" routes to correct skill', async ({ request }) => {
    const res = await request.post(`${CORE}/api/v1/agentbook-core/agent/message`, {
      headers: H, data: { text: 'show my past tax filings', channel: 'api' },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.data.skillUsed).toBe('query-past-filings');
  });

  test('query-past-filings: "my T1 from 2023" routes to correct skill', async ({ request }) => {
    const res = await request.post(`${CORE}/api/v1/agentbook-core/agent/message`, {
      headers: H, data: { text: 'show me my T1 from 2023', channel: 'api' },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.data.skillUsed).toBe('query-past-filings');
  });

  test('query-past-filings: "NOA" routes to correct skill', async ({ request }) => {
    const res = await request.post(`${CORE}/api/v1/agentbook-core/agent/message`, {
      headers: H, data: { text: 'do I have a notice of assessment uploaded?', channel: 'api' },
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).data.skillUsed).toBe('query-past-filings');
  });

  test('query-past-filings: response contains PDF link or upload prompt', async ({ request }) => {
    const res = await request.post(`${CORE}/api/v1/agentbook-core/agent/message`, {
      headers: H, data: { text: 'show my past filings', channel: 'api' },
    });
    const body = await res.json();
    const msg: string = body.data.message || '';
    // Either shows filings with PDF link, or prompts to upload
    expect(msg.length).toBeGreaterThan(10);
    expect(msg.toLowerCase()).toMatch(/filing|past|upload|pdf|t1|noa/);
  });

  test('regression: tax-filing-start still works', async ({ request }) => {
    const res = await request.post(`${CORE}/api/v1/agentbook-core/agent/message`, {
      headers: H, data: { text: 'start my 2025 tax filing', channel: 'api' },
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).data.skillUsed).toBe('tax-filing-start');
  });

  test('regression: agent-brain.spec.ts existing skills unaffected', async ({ request }) => {
    const res = await request.post(`${CORE}/api/v1/agentbook-core/agent/message`, {
      headers: H, data: { text: 'spent $50 at Starbucks', channel: 'api' },
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).data.skillUsed).toBe('record-expense');
  });
});
