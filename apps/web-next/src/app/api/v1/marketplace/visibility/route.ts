/**
 * Marketplace visibility check — lets a page decide whether to show the
 * plugin marketplace without needing admin rights to ask.
 *
 * The marketplace defaults to admin-only: `db.featureFlag` has no row for
 * `marketplace_visible_to_all` until an admin explicitly creates one via
 * the existing admin feature-flags screen (POST /api/v1/admin/feature-flags
 * { key: 'marketplace_visible_to_all', enabled: true }) — a missing flag
 * reads as disabled, so "invisible to everyone but admin" is the safe
 * out-of-the-box state, matching how it should behave before an admin ever
 * touches the setting.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { isAdminUser } from '@/lib/admin-guard';
import { validateSession } from '@/lib/api/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const MARKETPLACE_FLAG_KEY = 'marketplace_visible_to_all';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const authToken = request.cookies.get('naap_auth_token')?.value;
    if (!authToken) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    const user = await validateSession(authToken).catch(() => null);
    if (!user?.id) {
      return NextResponse.json({ error: 'invalid session' }, { status: 401 });
    }

    const roles = Array.isArray((user as { roles?: unknown }).roles)
      ? ((user as { roles: string[] }).roles)
      : [];
    const admin = isAdminUser({ roles, email: user.email ?? null });

    const flag = admin
      ? null // admins already see it — no need to spend a query on the flag
      : await db.featureFlag.findUnique({ where: { key: MARKETPLACE_FLAG_KEY }, select: { enabled: true } });

    const visible = admin || flag?.enabled === true;
    return NextResponse.json({ success: true, data: { visible, isAdmin: admin } });
  } catch (err) {
    console.error('[marketplace/visibility GET] failed:', err);
    // Fail closed — an error here should never accidentally expose the
    // marketplace to everyone.
    return NextResponse.json({ success: true, data: { visible: false, isAdmin: false } });
  }
}
