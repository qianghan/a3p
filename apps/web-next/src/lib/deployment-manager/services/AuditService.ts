import { prisma } from '@/lib/db';
import type { AuditEntry } from '../types';

export class AuditService {
  async log(entry: AuditEntry): Promise<void> {
    try {
      await prisma.dmAuditLog.create({
        data: {
          deploymentId: entry.deploymentId,
          action: entry.action,
          resource: entry.resource,
          resourceId: entry.resourceId,
          userId: entry.userId,
          ipAddress: entry.ipAddress,
          userAgent: entry.userAgent,
          details: entry.details as any,
          status: entry.status,
          errorMsg: entry.errorMsg,
        },
      });
    } catch (err) {
      console.error('[audit] Failed to persist audit log:', err);
    }

    const level = entry.status === 'failure' ? 'warn' : 'info';
    console[level](
      `[audit] ${entry.action} ${entry.resource}${entry.resourceId ? `:${entry.resourceId}` : ''} by=${entry.userId} status=${entry.status}${entry.errorMsg ? ` error="${entry.errorMsg}"` : ''}`,
    );
  }

  async query(filters: {
    deploymentId?: string;
    userId?: string;
    action?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ data: (AuditEntry & { id: string; createdAt: Date })[]; total: number }> {
    const where: any = {};
    if (filters.deploymentId) where.deploymentId = filters.deploymentId;
    if (filters.userId) where.userId = filters.userId;
    if (filters.action) where.action = filters.action;

    const limit = filters.limit || 50;
    const offset = filters.offset || 0;

    const [records, total] = await prisma.$transaction([
      prisma.dmAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.dmAuditLog.count({ where }),
    ]);

    return {
      data: records.map((r) => ({
        id: r.id,
        deploymentId: r.deploymentId ?? undefined,
        action: r.action,
        resource: r.resource,
        resourceId: r.resourceId ?? undefined,
        userId: r.userId,
        ipAddress: r.ipAddress ?? undefined,
        userAgent: r.userAgent ?? undefined,
        details: (r.details as Record<string, unknown>) ?? undefined,
        status: r.status as 'success' | 'failure',
        errorMsg: r.errorMsg ?? undefined,
        createdAt: r.createdAt,
      })),
      total,
    };
  }
}
