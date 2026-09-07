import 'server-only';
import type { NextRequest } from 'next/server';
import { validateSession } from '@/lib/api/auth';
import { PublicError } from '@/lib/api-error';

/**
 * `PublicError` so the message survives the API error sanitizer: "not
 * authenticated" / "not authorized" are for the caller, and a 401 carrying
 * "Something went wrong on our side." would be a worse answer than the truth.
 */
export class HttpError extends PublicError {
  // Narrows the base's optional `status` to required: callers do
  // `(err as HttpError).status` and pass it straight to NextResponse.
  constructor(public override readonly status: number, message: string) {
    super(message, status);
  }
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
