/**
 * AgentBook Invoice — Vercel Function host for the plugin Express app.
 *
 * The Express backend in `plugins/agentbook-invoice/backend/src/server.ts` is
 * imported and run inside this Node Function via the express-adapter.
 * No separate service deployment is required.
 */

import 'server-only';
import type { NextRequest } from 'next/server';
import { dispatchToExpress } from '@/lib/express-adapter';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

let appPromise: Promise<unknown> | null = null;

async function getApp(): Promise<(req: unknown, res: unknown, next?: (err?: unknown) => void) => void> {
  if (!appPromise) {
    appPromise = import('@naap/plugin-agentbook-invoice-backend').then((m) => m.app);
  }
  return appPromise as Promise<(req: unknown, res: unknown, next?: (err?: unknown) => void) => void>;
}

async function handler(request: NextRequest): Promise<Response> {
  const app = await getApp();
  const tenantId = await resolveAgentbookTenant(request);
  return dispatchToExpress(app, request, { extraHeaders: { 'x-tenant-id': tenantId } });
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
