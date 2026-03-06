import { prisma } from '@/lib/db';

export class RequestUsageService {
  async record(deploymentId: string, outcome: string, responseTimeMs: number): Promise<void> {
    await prisma.dmUsageRecord.create({
      data: { deploymentId, outcome, responseTimeMs },
    });
  }

  async getStats(
    deploymentId: string,
    period: 'hour' | 'day' = 'hour',
  ): Promise<{ buckets: { timestamp: string; completed: number; failed: number; retried: number }[] }> {
    const now = new Date();
    const since = new Date(
      period === 'hour' ? now.getTime() - 3_600_000 : now.getTime() - 86_400_000,
    );
    const intervalMs = period === 'hour' ? 300_000 : 3_600_000; // 5min or 1h

    const records = await prisma.dmUsageRecord.findMany({
      where: {
        deploymentId,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'asc' },
    });

    const bucketMap = new Map<string, { completed: number; failed: number; retried: number }>();

    // Pre-fill buckets
    const bucketCount = period === 'hour' ? 12 : 24;
    for (let i = 0; i < bucketCount; i++) {
      const ts = new Date(since.getTime() + i * intervalMs);
      const key = ts.toISOString();
      bucketMap.set(key, { completed: 0, failed: 0, retried: 0 });
    }

    for (const r of records) {
      const bucketTime = new Date(
        Math.floor(r.createdAt.getTime() / intervalMs) * intervalMs,
      );
      const key = bucketTime.toISOString();
      const bucket = bucketMap.get(key) || { completed: 0, failed: 0, retried: 0 };
      if (r.outcome === 'completed') bucket.completed++;
      else if (r.outcome === 'failed') bucket.failed++;
      else if (r.outcome === 'retried') bucket.retried++;
      bucketMap.set(key, bucket);
    }

    return {
      buckets: Array.from(bucketMap.entries()).map(([timestamp, counts]) => ({
        timestamp,
        ...counts,
      })),
    };
  }
}
