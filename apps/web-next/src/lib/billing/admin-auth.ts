import 'server-only';
import type { NextRequest } from 'next/server';
import { validateSession } from '@/lib/api/auth';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

interface AdminUser { id: string; email: string; }

/**
 * Gate routes to admin operators. Reads ADMIN_EMAILS env (comma-
 * separated allowlist); rejects with 401 (no session) or 403 (not
 * in allowlist).
 */
export async function requireAdmin(request: NextRequest): Promise<AdminUser> {
  const token = request.cookies.get('naap_auth_token')?.value;
  if (!token) throw new HttpError(401, 'not authenticated');
  const user = await validateSession(token);
  if (!user?.email) throw new HttpError(401, 'invalid session');
  const allowlist = (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowlist.includes(user.email)) throw new HttpError(403, 'admin only');
  return { id: user.id, email: user.email };
}
