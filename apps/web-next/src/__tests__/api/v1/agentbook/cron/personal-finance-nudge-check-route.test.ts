/**
 * Task 3b — nudge delivery cron route.
 *
 * Mocks: @naap/database (billAddOnSubscription + abTenantConfig lookups,
 * plus abPersonalNudgeLog.deleteMany for the both-channels-failed rollback
 * path), checkPersonalFinanceNudges() (Task 3a — its own dedup logic is
 * tested in agentbook-personal-nudges.test.ts, not re-tested here),
 * sendToAllChannels and createNotification (delivery — this test only
 * asserts BOTH were called with the right shape, not their internals), and
 * resolvePreference() (the tenant-preference gate that decides whether
 * sendToAllChannels is even attempted for a nudge's category — see review
 * Finding 2).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const billAddOnSubscriptionFindMany = vi.fn();
const abTenantConfigFindUnique = vi.fn();
const abPersonalNudgeLogDeleteMany = vi.fn();
const checkPersonalFinanceNudges = vi.fn();
const sendToAllChannels = vi.fn();
const createNotification = vi.fn();
const resolvePreference = vi.fn();
const reportError = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    billAddOnSubscription: { findMany: (...a: unknown[]) => billAddOnSubscriptionFindMany(...a) },
    abTenantConfig: { findUnique: (...a: unknown[]) => abTenantConfigFindUnique(...a) },
    abPersonalNudgeLog: { deleteMany: (...a: unknown[]) => abPersonalNudgeLogDeleteMany(...a) },
  },
}));
vi.mock('@/lib/agentbook-personal-nudges', () => ({
  checkPersonalFinanceNudges: (...a: unknown[]) => checkPersonalFinanceNudges(...a),
}));
vi.mock('@/lib/agentbook-chat-adapter', () => ({
  sendToAllChannels: (...a: unknown[]) => sendToAllChannels(...a),
}));
vi.mock('@/lib/notifications', () => ({
  createNotification: (...a: unknown[]) => createNotification(...a),
  resolvePreference: (...a: unknown[]) => resolvePreference(...a),
}));
vi.mock('@/lib/logger', () => ({
  reportError: (...a: unknown[]) => reportError(...a),
}));

import { GET } from '@/app/api/v1/agentbook/cron/personal-finance-nudge-check/route';

const TENANT = 'tenant-1';

function req(qs = ''): NextRequest {
  return new NextRequest(`http://x/api/v1/agentbook/cron/personal-finance-nudge-check${qs}`);
}

function reqWithAuth(secret: string, qs = ''): NextRequest {
  return new NextRequest(`http://x/api/v1/agentbook/cron/personal-finance-nudge-check${qs}`, {
    headers: { authorization: `Bearer ${secret}` },
  });
}

/** Builds an Intl-resolvable local hour for a given UTC "now" + timezone offset trick:
 * we just use 'America/New_York' and pick a `now` whose UTC hour, minus a fixed
 * offset, lands on the target hour — simplest is to mock Intl.DateTimeFormat's
 * format() indirectly by controlling `now` relative to a known-offset zone.
 * Since the route always resolves the hour via the real Intl.DateTimeFormat
 * (not mocked), we instead pick a real IANA zone/time combination. */
function utcDateForLocalHour(zone: string, localHour: number): Date {
  // Binary/linear search over a day of UTC hours for one whose local-hour
  // (per the real Intl.DateTimeFormat, same mechanism the route uses)
  // matches `localHour` in `zone`. Avoids hardcoding UTC offsets (which
  // drift with DST) directly in the test.
  const base = new Date(Date.UTC(2026, 6, 15, 0, 0, 0));
  for (let h = 0; h < 24; h++) {
    const candidate = new Date(base.getTime() + h * 60 * 60 * 1000);
    const fmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: zone });
    if (parseInt(fmt.format(candidate), 10) === localHour) return candidate;
  }
  throw new Error(`no UTC hour in test day maps to local hour ${localHour} in ${zone}`);
}

describe('GET /api/v1/agentbook/cron/personal-finance-nudge-check', () => {
  beforeEach(() => {
    billAddOnSubscriptionFindMany.mockReset();
    abTenantConfigFindUnique.mockReset();
    abPersonalNudgeLogDeleteMany.mockReset();
    checkPersonalFinanceNudges.mockReset();
    sendToAllChannels.mockReset();
    createNotification.mockReset();
    resolvePreference.mockReset();
    reportError.mockReset();

    billAddOnSubscriptionFindMany.mockResolvedValue([{ accountId: TENANT }]);
    abTenantConfigFindUnique.mockResolvedValue({ timezone: 'America/New_York' });
    abPersonalNudgeLogDeleteMany.mockResolvedValue({ count: 1 });
    checkPersonalFinanceNudges.mockResolvedValue([]);
    sendToAllChannels.mockResolvedValue([{ delivered: true }]);
    createNotification.mockResolvedValue({});
    resolvePreference.mockResolvedValue({ inApp: true, email: true });

    delete process.env.CRON_SECRET;
    vi.useRealTimers();
  });

  it('delivers a fired nudge via both createNotification and sendToAllChannels at the tenant local target hour', async () => {
    const now = utcDateForLocalHour('America/New_York', 9);
    vi.useFakeTimers();
    vi.setSystemTime(now);

    checkPersonalFinanceNudges.mockResolvedValue([
      {
        nudgeType: 'savings_warning',
        category: null,
        periodKey: '2026-07',
        message: 'You spent more than you earned this month.',
        alreadyFired: false,
      },
    ]);

    const r = await GET(req());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.nudgesFired).toBe(1);
    expect(j.checked).toBe(1);
    expect(j.skipped).toBe(0);

    expect(sendToAllChannels).toHaveBeenCalledWith(TENANT, 'You spent more than you earned this month.');
    expect(createNotification).toHaveBeenCalledTimes(1);
    const call = createNotification.mock.calls[0][0];
    expect(call.category).toBe('savings_warning');
    expect(call.severity).toBe('warning');
    expect(call.body).toBe('You spent more than you earned this month.');
    expect(call.createdByType).toBe('system');
    expect(call.audienceType).toBe('single');
    expect(call.audienceFilter).toEqual({ tenantId: TENANT });

    vi.useRealTimers();
  });

  it('skips a subscribed tenant when it is not their local target hour, without delivering anything', async () => {
    // Pick a local hour that is guaranteed to differ from the route's
    // target hour (9) — offset by 12 so it can never coincide.
    const now = utcDateForLocalHour('America/New_York', 21);
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const r = await GET(req());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.checked).toBe(0);
    expect(j.skipped).toBe(1);
    expect(j.nudgesFired).toBe(0);

    expect(checkPersonalFinanceNudges).not.toHaveBeenCalled();
    expect(sendToAllChannels).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('rejects an unauthenticated request with 401 and never queries the DB', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const r = await GET(req());
    expect(r.status).toBe(401);
    expect(billAddOnSubscriptionFindMany).not.toHaveBeenCalled();
    expect(checkPersonalFinanceNudges).not.toHaveBeenCalled();
  });

  it('rejects a request with the wrong bearer token', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const r = await GET(reqWithAuth('wrong-secret'));
    expect(r.status).toBe(401);
    expect(billAddOnSubscriptionFindMany).not.toHaveBeenCalled();
  });

  it('accepts a request with the correct bearer token', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const r = await GET(reqWithAuth('test-secret', '?hour=now'));
    expect(r.status).toBe(200);
  });

  it('?hour=now bypasses the local-hour gate regardless of actual local time', async () => {
    const now = utcDateForLocalHour('America/New_York', 21); // far from the target hour
    vi.useFakeTimers();
    vi.setSystemTime(now);

    checkPersonalFinanceNudges.mockResolvedValue([
      {
        nudgeType: 'net_worth_update',
        category: null,
        periodKey: '2026-07',
        message: 'Your net worth is up $1,000 this month.',
        alreadyFired: false,
      },
    ]);

    const r = await GET(req('?hour=now'));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.checked).toBe(1);
    expect(j.skipped).toBe(0);
    expect(j.nudgesFired).toBe(1);
    expect(checkPersonalFinanceNudges).toHaveBeenCalledWith(TENANT);
    expect(sendToAllChannels).toHaveBeenCalledWith(TENANT, 'Your net worth is up $1,000 this month.');
    expect(createNotification).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('falls back to America/New_York when AbTenantConfig has no timezone', async () => {
    abTenantConfigFindUnique.mockResolvedValue(null);
    const now = utcDateForLocalHour('America/New_York', 9);
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const r = await GET(req());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.checked).toBe(1); // reached the check, i.e. fell back correctly and matched local hour 9

    vi.useRealTimers();
  });

  it('does not write to AbPersonalNudgeLog on the happy path — dedup-writing is entirely checkPersonalFinanceNudges()\'s responsibility', async () => {
    const now = utcDateForLocalHour('America/New_York', 9);
    vi.useFakeTimers();
    vi.setSystemTime(now);

    checkPersonalFinanceNudges.mockResolvedValue([
      {
        nudgeType: 'budget_alert_80',
        category: 'Dining',
        periodKey: '2026-07',
        message: "You've spent 80% of your Dining budget this month.",
        alreadyFired: false,
      },
    ]);

    const r = await GET(req());
    const j = await r.json();
    // Both channels succeed (default mocks), so the route should never touch
    // AbPersonalNudgeLog — the compensating delete only fires when delivery
    // fails on both channels (see the "both channels fail" test below).
    expect(sendToAllChannels).toHaveBeenCalled();
    expect(createNotification).toHaveBeenCalled();
    expect(abPersonalNudgeLogDeleteMany).not.toHaveBeenCalled();
    expect(j.nudgesFired).toBe(1);
    expect(j.deliveryFailed).toBe(0);

    vi.useRealTimers();
  });

  it('deletes the AbPersonalNudgeLog row and counts deliveryFailed (not nudgesFired) when BOTH channels fail', async () => {
    const now = utcDateForLocalHour('America/New_York', 9);
    vi.useFakeTimers();
    vi.setSystemTime(now);

    checkPersonalFinanceNudges.mockResolvedValue([
      {
        nudgeType: 'budget_alert_100',
        category: 'Dining',
        periodKey: '2026-07',
        message: "You've gone over your Dining budget this month.",
        alreadyFired: false,
      },
    ]);
    sendToAllChannels.mockRejectedValue(new Error('telegram down'));
    createNotification.mockRejectedValue(new Error('db write failed'));

    const r = await GET(req());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.nudgesFired).toBe(0);
    expect(j.deliveryFailed).toBe(1);

    expect(abPersonalNudgeLogDeleteMany).toHaveBeenCalledTimes(1);
    expect(abPersonalNudgeLogDeleteMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, nudgeType: 'budget_alert_100', periodKey: '2026-07', category: 'Dining' },
    });
    expect(reportError).toHaveBeenCalledTimes(2); // one per failed channel

    vi.useRealTimers();
  });

  it('does NOT delete the log row and DOES count nudgesFired when only ONE channel fails', async () => {
    const now = utcDateForLocalHour('America/New_York', 9);
    vi.useFakeTimers();
    vi.setSystemTime(now);

    checkPersonalFinanceNudges.mockResolvedValue([
      {
        nudgeType: 'savings_warning',
        category: null,
        periodKey: '2026-07',
        message: 'You spent more than you earned this month.',
        alreadyFired: false,
      },
    ]);
    sendToAllChannels.mockRejectedValue(new Error('telegram down'));
    // createNotification still succeeds (default mock).

    const r = await GET(req());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.nudgesFired).toBe(1);
    expect(j.deliveryFailed).toBe(0);
    expect(abPersonalNudgeLogDeleteMany).not.toHaveBeenCalled();
    expect(createNotification).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('skips sendToAllChannels but still calls createNotification when the tenant has opted out of the nudge\'s category', async () => {
    const now = utcDateForLocalHour('America/New_York', 9);
    vi.useFakeTimers();
    vi.setSystemTime(now);

    checkPersonalFinanceNudges.mockResolvedValue([
      {
        nudgeType: 'budget_alert_80',
        category: 'Dining',
        periodKey: '2026-07',
        message: "You've spent 80% of your Dining budget this month.",
        alreadyFired: false,
      },
    ]);
    resolvePreference.mockResolvedValue({ inApp: false, email: false }); // fully opted out

    const r = await GET(req());
    expect(r.status).toBe(200);
    const j = await r.json();

    expect(resolvePreference).toHaveBeenCalledWith(TENANT, 'budget_alert');
    expect(sendToAllChannels).not.toHaveBeenCalled();
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(j.nudgesFired).toBe(1);
    expect(j.deliveryFailed).toBe(0);

    vi.useRealTimers();
  });

  it('still calls sendToAllChannels for a tenant with no opt-out', async () => {
    const now = utcDateForLocalHour('America/New_York', 9);
    vi.useFakeTimers();
    vi.setSystemTime(now);

    checkPersonalFinanceNudges.mockResolvedValue([
      {
        nudgeType: 'budget_alert_80',
        category: 'Dining',
        periodKey: '2026-07',
        message: "You've spent 80% of your Dining budget this month.",
        alreadyFired: false,
      },
    ]);
    resolvePreference.mockResolvedValue({ inApp: true, email: true });

    const r = await GET(req());
    expect(r.status).toBe(200);
    expect(sendToAllChannels).toHaveBeenCalledWith(TENANT, "You've spent 80% of your Dining budget this month.");

    vi.useRealTimers();
  });
});
