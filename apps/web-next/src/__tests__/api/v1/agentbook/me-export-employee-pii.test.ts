/**
 * PR 4b — me/export must never carry employee PII ciphertext or plaintext.
 * The mock behaves like Prisma: the relation only appears if the route asks
 * for it via include/select, and AbEmployeeSensitive rows are returned if
 * the route ever queries that table.
 */
import { describe, it, expect, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/agentbook-tenant', () => ({ safeResolveAgentbookTenant: vi.fn(async () => ({ tenantId: 't1' })) }));

const CIPHER = 'Q0lQSEVSVEVYVC1UQVhJRC1BQkNERUZHSElKS0xNTk9Q';
const SENS = { id: 's1', tenantId: 't1', employeeId: 'e1', taxIdEnc: CIPHER, bankAccountEnc: CIPHER + 'B', superMemberNumberEnc: CIPHER + 'M', taxIdLast4: '6789' };
const EMP = { id: 'e1', tenantId: 't1', name: 'Alex US', jurisdiction: 'us' };

const model = (name: string) => ({
  findMany: async (args: any = {}) => {
    if (name === 'abEmployee') return [args.include?.sensitive || args.select?.sensitive ? { ...EMP, sensitive: SENS } : EMP];
    if (name === 'abEmployeeSensitive') return [SENS];
    if (name === 'abEmployeeChange') return [{ id: 'c1', tenantId: 't1', employeeId: 'e1', actorId: 't1', action: 'reveal', fields: ['taxId'] }];
    return [];
  },
  findFirst: async () => null,
  findUnique: async () => null,
  create: async () => ({}),
});
const db = new Proxy({}, { get: (_t, p: string) => (p.startsWith('$') ? undefined : model(p)) });
vi.mock('@naap/database', () => ({ get prisma() { return db; } }));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/agentbook/me/export/route';

describe('me/export — employee PII', () => {
  it('includes employees and the audit trail, but no ciphertext and no sensitive table', async () => {
    const res = await GET(new NextRequest('https://x.test/api/v1/agentbook/me/export'));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Alex US');
    expect(text).toContain('"reveal"');
    expect(text).not.toContain(CIPHER);
    expect(text).not.toMatch(/taxIdEnc|bankAccountEnc|superMemberNumberEnc/);
  });
});
