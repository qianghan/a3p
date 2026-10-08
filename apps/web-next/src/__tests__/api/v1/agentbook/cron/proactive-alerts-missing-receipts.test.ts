// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
const sendToAllChannels = vi.fn();
vi.mock('@/lib/agentbook-chat-adapter', () => ({
  sendToAllChannels: (...a: unknown[]) => sendToAllChannels(...a),
}));
vi.mock('@/lib/web-push-send', () => ({ sendPush: vi.fn(async () => 'sent') }));
vi.mock('@/lib/logger', () => ({ reportError: vi.fn(async () => {}) }));

import { memDb, type Row } from '@/__tests__/helpers/mem-db';
import { cronRequest, setCronSecret, clearCronSecret } from '@/__tests__/helpers/cron-request';
import { missingReceiptWhere } from '@/lib/mobile/alerts';
import { GET } from '@/app/api/v1/agentbook/cron/proactive-alerts/route';

const NOW = new Date('2026-06-20T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const exp = (id: string, o: Row): Row => ({
  id, tenantId: 't1', amountCents: 5000, isPersonal: false, status: 'confirmed', categoryId: null,
  receiptUrl: null, receiptStatus: 'pending', deletedAt: null, archivedAt: null, date: daysAgo(60), ...o,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  setCronSecret();
  sendToAllChannels.mockReset().mockResolvedValue([{ delivered: true }]);
  memDb.reset({
    abTenantConfig: [{ id: 'cfg-1', userId: 't1', pushSubscription: null }],
    abExpense: [
      // Six missing receipts 60 days old: inside the shared 90-day window, outside the old 30-day one.
      ...[1, 2, 3, 4, 5, 6].map((i) => exp(`m${i}`, {})),
      // Recent rows the old definition counted but the shared one does not.
      exp('deleted', { date: daysAgo(5), deletedAt: daysAgo(1) }),
      exp('archived', { date: daysAgo(5), archivedAt: daysAgo(1) }),
      exp('skipped', { date: daysAgo(5), receiptStatus: 'skipped' }),
    ],
  });
});
afterEach(() => {
  vi.useRealTimers();
  clearCronSecret();
});

describe('cron/proactive-alerts — missing receipts', () => {
  it('uses the shared missingReceiptWhere definition (90 days; no deleted, archived or skipped rows)', async () => {
    const expected = await memDb.abExpense.count({ where: missingReceiptWhere('t1', NOW) });
    expect(expected).toBe(6);

    const res = await GET(cronRequest('http://x/api/v1/agentbook/cron/proactive-alerts'));
    expect(res.status).toBe(200);
    const messages = sendToAllChannels.mock.calls.map((c) => String(c[1]));
    const receipts = messages.filter((m) => m.includes('receipts missing'));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toContain(`${expected} receipts missing`);
  });
});
