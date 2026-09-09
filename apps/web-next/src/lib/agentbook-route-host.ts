/**
 * Shared host helper for AgentBook plugin route handlers.
 *
 * Wraps the plugin's Express app so a failure to import it (Prisma binary
 * not shipped to the function bundle, a missing env var at module load) is
 * diagnosable instead of an empty Next.js 500.
 *
 * It used to be diagnosable BY THE CALLER: the 500 body carried
 * `error.message` and eight lines of `error.stack`. That is the class of
 * mistake #492 went through 266 route handlers to remove, and this one
 * survived it because the raw text is assembled here rather than at a
 * throw site. A module-load stack names file paths inside the deployment,
 * the bundler layout, and — for a Prisma failure — the host and database it
 * could not reach.
 *
 * The diagnosis now goes to the log, where the person debugging it can read
 * it and the person probing the endpoint cannot. `publicErrorMessage` is the
 * same helper every other route uses, so an error deliberately written for
 * the caller still reaches them and everything else becomes a fixed phrase.
 */

import 'server-only';
import type { NextRequest } from 'next/server';
import { dispatchToExpress } from '@/lib/express-adapter';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { publicErrorMessage } from '@/lib/api-error';

type ExpressApp = (req: unknown, res: unknown, next?: (err?: unknown) => void) => void;

interface AppLoader {
  loaded: ExpressApp | null;
  error: Error | null;
  promise: Promise<{ app?: ExpressApp; error?: Error }> | null;
}

export function makeRouteHandler(plugin: string, importApp: () => Promise<{ app: ExpressApp }>) {
  const cache: AppLoader = { loaded: null, error: null, promise: null };

  async function getApp(): Promise<ExpressApp> {
    if (cache.loaded) return cache.loaded;
    if (cache.error) throw cache.error;
    if (!cache.promise) {
      cache.promise = importApp()
        .then((mod) => {
          if (!mod.app) throw new Error(`module @naap/plugin-${plugin}-backend has no \`app\` export`);
          cache.loaded = mod.app;
          return { app: mod.app };
        })
        .catch((err) => {
          cache.error = err instanceof Error ? err : new Error(String(err));
          return { error: cache.error };
        });
    }
    const result = await cache.promise;
    if (result.error) throw result.error;
    return result.app!;
  }

  return async function handler(request: NextRequest): Promise<Response> {
    try {
      const app = await getApp();
      const __resolved = await safeResolveAgentbookTenant(request);
      if ('response' in __resolved) return __resolved.response;
      const { tenantId } = __resolved;
      return await dispatchToExpress(app, request, { extraHeaders: { 'x-tenant-id': tenantId } });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      // Full stack to the log, never to the response.
      console.error(`[route-host:${plugin}] handler failed:`, error);
      return new Response(
        JSON.stringify({
          success: false,
          plugin,
          error: publicErrorMessage(error),
          path: new URL(request.url).pathname,
          timestamp: new Date().toISOString(),
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  };
}
