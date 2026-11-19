// @vitest-environment node
/** PR 3bc final-review m1/m3: ops script excludes jordan always, aborts on unresolved emails. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const users: Record<string, string> = { 'alex@agentbook.test': 'u-alex', 'jordan@agentbook.test': 'u-jordan' };
const upsert = vi.fn();
vi.mock('@naap/database', () => ({
  prisma: {
    featureFlag: { findUnique: async () => null, upsert: (...a: unknown[]) => upsert(...a) },
    user: { findUnique: async ({ where }: { where: { email: string } }) => (users[where.email] ? { id: users[where.email] } : null) },
    abTenantConfig: { findUnique: async () => ({ accountingBasis: 'accrual' }) },
    $disconnect: async () => {},
  },
}));

// @ts-ignore script lives outside the web-next project
import { main } from '../../../../../agentbook/enable-purchases-at-entry';

let out: string[];
beforeEach(() => {
  upsert.mockReset(); process.exitCode = undefined; out = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
});

describe('enable-purchases-at-entry', () => {
  it('dry run reports jordan excluded', async () => {
    await main(['x', 'y', '--email', 'alex@agentbook.test']);
    expect(out.join('\n')).toContain('jordan@agentbook.test (u-jordan) excluded');
    expect(upsert).not.toHaveBeenCalled();
  });
  it('--global on --apply still writes excludeTenantIds with jordan', async () => {
    await main(['x', 'y', '--global', 'on', '--apply']);
    const arg = upsert.mock.calls[0][0];
    expect(arg.update.enabled).toBe(true);
    expect(arg.update.metadata.excludeTenantIds).toEqual(['u-jordan']);
  });
  it('any unresolved --email aborts with no write, even with --apply', async () => {
    await main(['x', 'y', '--email', 'alex@agentbook.test', '--email', 'typo@agentbook.test', '--apply']);
    expect(upsert).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(out.join('\n')).toContain('ABORT');
  });
});
