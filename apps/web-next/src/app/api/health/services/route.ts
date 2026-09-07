import { NextResponse } from 'next/server';
/**
 * These are the off-Vercel services inherited from the naap fork. AgentBook
 * does not deploy any of them, and `@/lib/env` defaults each URL to a
 * localhost port, so in production all six failed and this route returned a
 * permanent HTTP 503 -- an uptime monitor pointed here was red from the day
 * it was wired up, and the response published the internal service names and
 * ports to unauthenticated callers.
 *
 * Read the env vars directly rather than through the `@/lib/env` re-exports,
 * because those substitute a localhost default and we need to distinguish
 * "configured" from "defaulted".
 */
const OPTIONAL_SERVICES: { name: string; envVar: string }[] = [
  { name: 'base-svc', envVar: 'BASE_SVC_URL' },
  { name: 'plugin-server', envVar: 'PLUGIN_SERVER_URL' },
  { name: 'a3p-svc', envVar: 'A3P_SVC_URL' },
  { name: 'pipeline-gateway', envVar: 'PIPELINE_GATEWAY_URL' },
  { name: 'storage-svc', envVar: 'STORAGE_SVC_URL' },
  { name: 'infrastructure-svc', envVar: 'INFRASTRUCTURE_SVC_URL' },
];

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface ServiceHealth {
  name: string;
  url: string;
  status: 'healthy' | 'unhealthy' | 'degraded';
  latency?: number;
  message?: string;
}

interface ServicesHealthResponse {
  status: 'ok' | 'degraded' | 'error';
  timestamp: string;
  services: ServiceHealth[];
  summary: {
    total: number;
    healthy: number;
    unhealthy: number;
  };
}

const TIMEOUT_MS = 5000;

/**
 * Check health of a single service
 */
async function checkService(name: string, baseUrl: string): Promise<ServiceHealth> {
  const url = `${baseUrl}/healthz`;
  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
      },
    });

    clearTimeout(timeoutId);
    const latency = Date.now() - startTime;

    if (response.ok) {
      return {
        name,
        url: baseUrl,
        status: 'healthy',
        latency,
        message: 'OK',
      };
    }

    if (response.status === 503) {
      return {
        name,
        url: baseUrl,
        status: 'degraded',
        latency,
        message: 'Service degraded',
      };
    }

    return {
      name,
      url: baseUrl,
      status: 'unhealthy',
      latency,
      message: `HTTP ${response.status}`,
    };
  } catch (error) {
    const latency = Date.now() - startTime;
    const message =
      error instanceof Error
        ? error.name === 'AbortError'
          ? 'Timeout'
          : error.message
        : 'Unknown error';

    return {
      name,
      url: baseUrl,
      status: 'unhealthy',
      latency,
      message,
    };
  }
}

/**
 * Health check endpoint for all backend services
 * GET /api/health/services
 *
 * Returns health status of all off-Vercel services.
 * Used by monitoring systems and deployment validation.
 */
export async function GET(): Promise<NextResponse> {
  // Only check a service that someone actually configured. An unconfigured
  // service is not an unhealthy one, so it is left out of the report rather
  // than counted as a failure.
  const services = OPTIONAL_SERVICES.flatMap((svc) => {
    const url = process.env[svc.envVar];
    return url ? [{ name: svc.name, url }] : [];
  });

  // Check all services in parallel
  const results = await Promise.all(
    services.map((svc) => checkService(svc.name, svc.url))
  );

  const healthy = results.filter((r) => r.status === 'healthy').length;
  const unhealthy = results.filter((r) => r.status === 'unhealthy').length;

  // Determine overall status
  // With no services configured there is nothing failing, so 'ok'. This route
  // reports on the optional off-Vercel services only; `/api/health` is the
  // check that speaks for the app itself and its database.
  let status: 'ok' | 'degraded' | 'error';
  if (unhealthy === 0) {
    status = 'ok';
  } else if (healthy > 0) {
    status = 'degraded';
  } else {
    status = 'error';
  }

  const response: ServicesHealthResponse = {
    status,
    timestamp: new Date().toISOString(),
    services: results,
    summary: {
      total: results.length,
      healthy,
      unhealthy,
    },
  };

  const statusCode = status === 'ok' ? 200 : status === 'degraded' ? 207 : 503;

  return NextResponse.json(response, {
    status: statusCode,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    },
  });
}
