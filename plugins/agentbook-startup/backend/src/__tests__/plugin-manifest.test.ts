import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifestPath = fileURLToPath(new URL('../../../plugin.json', import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

describe('agentbook-startup plugin.json', () => {
  it('is non-core and ships with no frontend routes yet (PR 7.1 is a dark launch)', () => {
    expect(manifest.isCore).toBe(false);
    expect(manifest.frontend).toBeUndefined();
  });

  it('registers the backend on the expected dev port and API prefix', () => {
    expect(manifest.backend.devPort).toBe(4054);
    expect(manifest.backend.port).toBe(4154);
    expect(manifest.backend.apiPrefix).toBe('/api/v1/agentbook-startup');
    expect(manifest.backend.healthCheck).toBe('/healthz');
  });
});
