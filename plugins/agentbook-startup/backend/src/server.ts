/**
 * AgentBook Startup Tax Benefits Backend - v1.0 (foundation)
 *
 * PR 7.1: empty backend, registered via plugin.json so
 * bin/sync-plugin-registry.ts picks it up. No routes beyond the
 * standard /healthz yet — the recommendation engine (Phase 1 of the
 * 5-phase workflow) ships in PR 7.3. See startup.html §8 and §10.
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createPluginServer } from '@naap/plugin-server-sdk';
import { db } from './db/client.js';

let pluginConfig: { backend?: { devPort?: number } } = {};
try {
  pluginConfig = JSON.parse(
    readFileSync(new URL('../../plugin.json', import.meta.url), 'utf8'),
  );
} catch {
  /* bundled environment — defaults are fine */
}

const server = createPluginServer({
  name: 'agentbook-startup',
  port: parseInt(process.env.PORT || String(pluginConfig.backend?.devPort || 4054), 10),
  prisma: db,
  requireAuth: process.env.NODE_ENV === 'production',
  publicRoutes: ['/healthz', '/api/v1/agentbook-startup'],
});

export const app = server.app;

const isDirectRun =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  !!process.argv[1] &&
  import.meta.url === new URL(process.argv[1], 'file://').href;

if (isDirectRun) {
  server.start().catch((err) => {
    console.error('Failed to start agentbook-startup-svc:', err);
    process.exit(1);
  });
}
