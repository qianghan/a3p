/**
 * Dashboard Plugin Config API Routes
 * GET  /api/v1/dashboard/config - Get plugin configuration
 * PUT  /api/v1/dashboard/config - Update plugin configuration
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { validateSession } from '@/lib/api/auth';
import { success, errors, getAuthToken } from '@/lib/api/response';
import { validateCSRF } from '@/lib/api/csrf';
import { requireAdmin, HttpError } from '@/lib/billing/admin-auth';

/**
 * Read all DashboardPluginConfig rows into a key-value object.
 */
async function readConfig(): Promise<Record<string, string>> {
  const rows = await prisma.dashboardPluginConfig.findMany();
  const map: Record<string, string> = {};
  for (const row of rows) {
    map[row.key] = row.value;
  }
  return map;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const token = getAuthToken(request);
    if (!token) {
      return errors.unauthorized('No auth token provided');
    }

    const user = await validateSession(token);
    if (!user) {
      return errors.unauthorized('Invalid or expired session');
    }

    const config = await readConfig();

    // Report WHETHER a secret is set, never any of it. This used to return
    // `substring(0, 8)` of the key — eight real bytes of a signing secret to
    // every authenticated caller, which is the same shape as the connection
    // string /api/health used to publish (#490). The settings UI only needs
    // to know whether one is configured.
    const { metabaseSecretKey, ...rest } = config;
    return success({ ...rest, metabaseSecretKeyConfigured: Boolean(metabaseSecretKey) });
  } catch (err) {
    console.error('Error fetching config:', err);
    return errors.internal('Failed to fetch configuration');
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    const token = getAuthToken(request);
    if (!token) {
      return errors.unauthorized('No auth token provided');
    }

    const csrfError = validateCSRF(request, token);
    if (csrfError) {
      return csrfError;
    }

    // Admin, not merely authenticated. `dashboardPluginConfig` is upserted by
    // `key` alone with no tenant column, so this writes the Metabase URL and
    // secret key for the WHOLE installation. Any logged-in user could point
    // it at a server they controlled. requireAdmin throws an HttpError with
    // the right status, which the catch below maps.
    await requireAdmin(request);

    const body = await request.json();
    const { metabaseUrl, metabaseSecretKey, tokenExpiry, enableInteractive } = body;

    // Build updates map
    const updates: Record<string, string> = {};
    if (metabaseUrl !== undefined) updates.metabaseUrl = String(metabaseUrl);
    if (metabaseSecretKey !== undefined) updates.metabaseSecretKey = String(metabaseSecretKey);
    if (tokenExpiry !== undefined) updates.tokenExpiry = String(tokenExpiry);
    if (enableInteractive !== undefined) updates.enableInteractive = String(enableInteractive);

    // Upsert each config entry
    await prisma.$transaction(
      Object.entries(updates).map(([key, value]) =>
        prisma.dashboardPluginConfig.upsert({
          where: { key },
          update: { value },
          create: { key, value },
        }),
      ),
    );

    // Re-read and verify
    const config = await readConfig();
    const valid = !!(config.metabaseUrl && config.metabaseSecretKey);

    return success({
      saved: true,
      valid,
      ...(valid ? {} : { validationMessage: 'Metabase URL or Secret Key not set' }),
    });
  } catch (err) {
    // requireAdmin signals with an HttpError carrying 401 or 403; anything
    // else is unexpected and stays generic.
    if (err instanceof HttpError) {
      return err.status === 401 ? errors.unauthorized(err.message) : errors.forbidden(err.message);
    }
    console.error('Error saving config:', err);
    return errors.internal('Failed to save configuration');
  }
}
