import { test, expect } from '@playwright/test';

test('OAuth discovery documents are reachable and well-formed', async ({ request }) => {
  const asMeta = await request.get('/.well-known/oauth-authorization-server');
  expect(asMeta.ok()).toBe(true);
  const asBody = await asMeta.json();
  expect(asBody.authorization_endpoint).toContain('/api/v1/oauth/authorize');
  expect(asBody.code_challenge_methods_supported).toContain('S256');

  const prMeta = await request.get('/.well-known/oauth-protected-resource');
  expect(prMeta.ok()).toBe(true);
  const prBody = await prMeta.json();
  expect(prBody.resource).toContain('/api/v1/mcp');
});
