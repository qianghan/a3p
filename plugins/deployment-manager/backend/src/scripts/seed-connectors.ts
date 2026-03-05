#!/usr/bin/env tsx

const GATEWAY_ADMIN_BASE = process.env.GATEWAY_ADMIN_URL || 'http://localhost:3000/api/v1/gateway/admin';
const AUTH_TOKEN = process.env.ADMIN_AUTH_TOKEN || '';

interface ConnectorSeed {
  slug: string;
  displayName: string;
  description: string;
  upstreamBaseUrl: string;
  authType: string;
  authConfig: Record<string, unknown>;
  healthCheckPath?: string | null;
  allowedHosts: string[];
  secretRefs: string[];
  endpoints: Array<{
    method: string;
    path: string;
    upstreamPath?: string;
    bodyTransform?: string;
  }>;
}

const CONNECTORS: ConnectorSeed[] = [
  {
    slug: 'fal-ai-serverless',
    displayName: 'fal.ai Serverless GPU',
    description: 'Serverless GPU inference with sub-second cold starts on fal.ai',
    upstreamBaseUrl: 'https://rest.fal.ai',
    authType: 'header',
    authConfig: { headers: { 'Authorization': 'Key {{secrets.api-key}}' } },
    healthCheckPath: null,
    allowedHosts: ['rest.fal.ai', 'fal.run'],
    secretRefs: ['api-key'],
    endpoints: [
      { method: 'GET', path: '/applications/:id', bodyTransform: 'passthrough' },
      { method: 'POST', path: '/applications', bodyTransform: 'passthrough' },
      { method: 'PUT', path: '/applications/:id', bodyTransform: 'passthrough' },
      { method: 'DELETE', path: '/applications/:id', bodyTransform: 'passthrough' },
    ],
  },
  {
    slug: 'runpod-serverless',
    displayName: 'RunPod Serverless GPU',
    description: 'Deploy serverless GPU endpoints on RunPod',
    upstreamBaseUrl: 'https://api.runpod.io/v2',
    authType: 'bearer',
    authConfig: { tokenRef: 'api-key' },
    healthCheckPath: null,
    allowedHosts: ['api.runpod.io', 'api.runpod.ai'],
    secretRefs: ['api-key'],
    endpoints: [
      { method: 'GET', path: '/gpu-types', bodyTransform: 'passthrough' },
      { method: 'GET', path: '/endpoints/:id', bodyTransform: 'passthrough' },
      { method: 'GET', path: '/endpoints/:id/health', bodyTransform: 'passthrough' },
      { method: 'POST', path: '/endpoints', bodyTransform: 'passthrough' },
      { method: 'PUT', path: '/endpoints/:id', bodyTransform: 'passthrough' },
      { method: 'DELETE', path: '/endpoints/:id', bodyTransform: 'passthrough' },
    ],
  },
  {
    slug: 'replicate-serverless',
    displayName: 'Replicate Deployments',
    description: 'Deploy custom models as scalable endpoints on Replicate',
    upstreamBaseUrl: 'https://api.replicate.com/v1',
    authType: 'bearer',
    authConfig: { tokenRef: 'api-key' },
    healthCheckPath: null,
    allowedHosts: ['api.replicate.com'],
    secretRefs: ['api-key'],
    endpoints: [
      { method: 'GET', path: '/deployments/:owner/:name', bodyTransform: 'passthrough' },
      { method: 'POST', path: '/deployments', bodyTransform: 'passthrough' },
      { method: 'PATCH', path: '/deployments/:owner/:name', bodyTransform: 'passthrough' },
      { method: 'DELETE', path: '/deployments/:owner/:name', bodyTransform: 'passthrough' },
    ],
  },
  {
    slug: 'modal-serverless',
    displayName: 'Modal Serverless GPU',
    description: 'Serverless GPU infrastructure on Modal with elastic scaling',
    upstreamBaseUrl: 'https://api.modal.com/v1',
    authType: 'bearer',
    authConfig: { tokenRef: 'token' },
    healthCheckPath: null,
    allowedHosts: ['api.modal.com'],
    secretRefs: ['token'],
    endpoints: [
      { method: 'GET', path: '/apps/:id', bodyTransform: 'passthrough' },
      { method: 'POST', path: '/apps', bodyTransform: 'passthrough' },
      { method: 'PUT', path: '/apps/:id', bodyTransform: 'passthrough' },
      { method: 'DELETE', path: '/apps/:id', bodyTransform: 'passthrough' },
    ],
  },
  {
    slug: 'baseten-serverless',
    displayName: 'Baseten Model Deployment',
    description: 'Deploy ML models as scalable API endpoints on Baseten',
    upstreamBaseUrl: 'https://api.baseten.co/v1',
    authType: 'header',
    authConfig: { headers: { 'Authorization': 'Api-Key {{secrets.api-key}}' } },
    healthCheckPath: null,
    allowedHosts: ['api.baseten.co'],
    secretRefs: ['api-key'],
    endpoints: [
      { method: 'GET', path: '/models/:id', bodyTransform: 'passthrough' },
      { method: 'POST', path: '/models', bodyTransform: 'passthrough' },
      { method: 'PATCH', path: '/models/:id', bodyTransform: 'passthrough' },
      { method: 'DELETE', path: '/models/:id', bodyTransform: 'passthrough' },
    ],
  },
  {
    slug: 'ssh-bridge',
    displayName: 'SSH Bridge (Bare-Metal / VM)',
    description: 'Deploy Docker containers directly to GPU machines via SSH',
    upstreamBaseUrl: 'http://localhost:3000',
    authType: 'none',
    authConfig: {},
    healthCheckPath: null,
    allowedHosts: ['*'],
    secretRefs: ['ssh-key'],
    endpoints: [
      { method: 'POST', path: '/connect', bodyTransform: 'passthrough' },
      { method: 'POST', path: '/exec', bodyTransform: 'passthrough' },
      { method: 'POST', path: '/exec/script', bodyTransform: 'passthrough' },
      { method: 'GET', path: '/jobs/:id', bodyTransform: 'passthrough' },
    ],
  },
];

async function seedConnector(connector: ConnectorSeed): Promise<void> {
  console.log(`[seed] Provisioning connector: ${connector.slug}...`);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (AUTH_TOKEN) headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;

  const checkRes = await fetch(`${GATEWAY_ADMIN_BASE}/connectors/${connector.slug}`, { headers });

  if (checkRes.ok) {
    console.log(`[seed] Connector ${connector.slug} already exists, updating...`);
    const updateRes = await fetch(`${GATEWAY_ADMIN_BASE}/connectors/${connector.slug}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(connector),
    });
    if (!updateRes.ok) {
      console.warn(`[seed] Failed to update ${connector.slug}: ${updateRes.status}`);
    } else {
      console.log(`[seed] Updated connector: ${connector.slug}`);
    }
  } else {
    const createRes = await fetch(`${GATEWAY_ADMIN_BASE}/connectors`, {
      method: 'POST',
      headers,
      body: JSON.stringify(connector),
    });
    if (!createRes.ok) {
      const err = await createRes.text();
      console.warn(`[seed] Failed to create ${connector.slug}: ${createRes.status} ${err}`);
    } else {
      console.log(`[seed] Created connector: ${connector.slug}`);
    }
  }
}

async function main() {
  console.log('[seed] Starting connector provisioning...');
  console.log(`[seed] Gateway admin: ${GATEWAY_ADMIN_BASE}`);

  for (const connector of CONNECTORS) {
    try {
      await seedConnector(connector);
    } catch (err) {
      console.error(`[seed] Error provisioning ${connector.slug}:`, err);
    }
  }

  console.log('[seed] Connector provisioning complete.');
}

main().catch(console.error);
