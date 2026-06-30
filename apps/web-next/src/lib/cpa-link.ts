/** Shared helper: resolve a CPA review link by token (active + unexpired). */

import 'server-only';
import { prisma as db } from '@naap/database';

export interface ResolvedLink { id: string; tenantId: string; token: string }

export async function resolveActiveLink(token: string): Promise<ResolvedLink | null> {
  if (!token) return null;
  const link = await db.abCpaReviewLink.findUnique({ where: { token } });
  if (!link) return null;
  if (link.status !== 'active') return null;
  if (link.expiresAt < new Date()) return null;
  return { id: link.id, tenantId: link.tenantId, token: link.token };
}
