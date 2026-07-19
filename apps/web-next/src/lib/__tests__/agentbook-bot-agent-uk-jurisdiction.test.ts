/**
 * Regression coverage for the UK jurisdiction gap in the Telegram bot's own
 * `mileage.record` / `per_diem.record` step executors (agentbook-bot-agent.ts).
 * These duplicate the jurisdiction-resolution logic in the HTTP routes under
 * apps/web-next/src/app/api/v1/agentbook-expense/ — the routes were fixed
 * first, but the bot's independent code paths still hard-coded
 * 'us' | 'ca' | 'au' and silently defaulted UK tenants to US-shaped output
 * (mileage billed at the US rate; per-diem not declined at all).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const tenantConfigFindUnique = vi.fn();
const mileageEntryFindMany = vi.fn();
const mileageEntryCreate = vi.fn();
const journalEntryCreate = vi.fn();
const journalEntryUpdate = vi.fn();
const eventCreate = vi.fn();
const accountFindMany = vi.fn();
const expenseCreate = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    abMileageEntry: {
      findMany: (...a: unknown[]) => mileageEntryFindMany(...a),
      create: (...a: unknown[]) => mileageEntryCreate(...a),
    },
    abJournalEntry: {
      create: (...a: unknown[]) => journalEntryCreate(...a),
      update: (...a: unknown[]) => journalEntryUpdate(...a),
    },
    abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
    abAccount: { findMany: (...a: unknown[]) => accountFindMany(...a) },
    abExpense: { create: (...a: unknown[]) => expenseCreate(...a) },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        abJournalEntry: {
          create: (...a: unknown[]) => journalEntryCreate(...a),
          update: (...a: unknown[]) => journalEntryUpdate(...a),
        },
        abMileageEntry: { create: (...a: unknown[]) => mileageEntryCreate(...a) },
        abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
        abExpense: { create: (...a: unknown[]) => expenseCreate(...a) },
      }),
  },
}));

vi.mock('@/lib/agentbook-account-resolver', () => ({
  resolveVehicleAccounts: vi.fn(async () => null),
}));

import { executeStep, type BotContext, type PlanStep } from '../agentbook-bot-agent';

function ctx(): BotContext {
  return { tenantId: 'tenant-1', active: null, categories: [] };
}

function step(skill: string, args: Record<string, unknown>): PlanStep {
  return { id: 'step-1', skill, args, dependsOn: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mileageEntryFindMany.mockResolvedValue([]);
  mileageEntryCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({ id: 'entry-1', ...data }));
  eventCreate.mockResolvedValue({});
  accountFindMany.mockResolvedValue([]);
});

describe('executeStep — mileage.record — UK jurisdiction (Telegram bot path)', () => {
  it('a UK tenant books mileage at the HMRC AMAP 45p/mile rate, not the US 67¢/mi rate', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'uk' });
    const result = await executeStep(step('mileage.record', { miles: 100, purpose: 'Client visit' }), ctx());
    expect(result.success).toBe(true);
    expect((result as any).data.jurisdiction).toBe('uk');
    expect((result as any).data.unit).toBe('mi');
    expect((result as any).data.ratePerUnitCents).toBe(45);
    expect((result as any).data.deductibleAmountCents).toBe(4_500);
  });
});

describe('executeStep — per_diem.record — UK jurisdiction (Telegram bot path)', () => {
  it('a UK tenant gets the honest "not supported" decline, not silent US GSA per-diem rows', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'uk' });
    const result = await executeStep(
      step('per_diem.record', { cityHint: 'London', days: 2 }),
      ctx(),
    );
    expect(result.success).toBe(true);
    expect((result as any).data.kind).toBe('unsupported_jurisdiction');
    expect((result as any).data.message).toMatch(/UK/i);
    expect(expenseCreate).not.toHaveBeenCalled();
  });
});
