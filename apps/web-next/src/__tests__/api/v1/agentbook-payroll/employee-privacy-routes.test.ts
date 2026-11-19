/**
 * PR 4b — employee API + privacy (spec §5.5).
 *
 * GET employees/[id] (masked), strict zod PUT, POST employees/[id]/reveal.
 * The DB mock APPLIES the where clause (a fixed-array mock cannot fail on a
 * tenant-scoping bug), and every "absent" assertion searches for the actual
 * plaintext / ciphertext string, not for the shape of the response.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('server-only', () => ({}));

type Row = Record<string, any>;
const store: { employees: Row[]; sensitive: Row[]; changes: Row[] } = { employees: [], sensitive: [], changes: [] };
const matches = (row: Row, where: Row = {}) => Object.entries(where).every(([k, v]) => row[k] === v);

const db = {
  abEmployee: {
    findFirst: vi.fn(async ({ where, include }: any) => {
      const e = store.employees.find((r) => matches(r, where));
      if (!e) return null;
      return include?.sensitive ? { ...e, sensitive: store.sensitive.find((s) => s.employeeId === e.id) ?? null } : { ...e };
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const rows = store.employees.filter((r) => matches(r, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    }),
  },
  abEmployeeSensitive: {
    findUnique: vi.fn(async ({ where }: any) => store.sensitive.find((s) => matches(s, where)) ?? null),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const s = store.sensitive.find((r) => matches(r, where));
      if (s) { Object.assign(s, update); return s; }
      store.sensitive.push({ ...create }); return create;
    }),
  },
  abEmployeeChange: {
    create: vi.fn(async ({ data }: any) => { store.changes.push(data); return data; }),
  },
  $transaction: vi.fn(async (fn: any) => fn(db)),
};
vi.mock('@naap/database', () => ({ get prisma() { return db; } }));

const sessions: Record<string, { id: string }> = { 'tok-t1': { id: 't1' }, 'tok-t2': { id: 't2' } };
vi.mock('@/lib/api/auth', () => ({ validateSession: vi.fn(async (tok: string) => sessions[tok] ?? null) }));

const rate = vi.fn(async () => ({ allowed: true }));
vi.mock('@/lib/agentbook-rate-limit', () => ({ checkAndIncrement: (...a: unknown[]) => rate(...(a as [])) }));

const reportError = vi.fn();
vi.mock('@/lib/logger', () => ({ reportError: (...a: unknown[]) => reportError(...a) }));

import { NextRequest } from 'next/server';
import { GET, PUT } from '@/app/api/v1/agentbook-payroll/employees/[id]/route';
import { POST as REVEAL } from '@/app/api/v1/agentbook-payroll/employees/[id]/reveal/route';
import { encryptPii } from '@/lib/agentbook-employee-pii';

const TFN = '123456782';
const SIN = '046454286';
const SSN = '123-45-6789';
const BANK = '06200012345678'; // AU BSB 062-000 + account 12345678 (also valid US length)
const MEMBER = 'MEM77881';

function req(method: string, id: string, body?: unknown, opts: { token?: string | null; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
  const token = opts.token === undefined ? 'tok-t1' : opts.token;
  if (token) headers.cookie = `naap_auth_token=${token}`;
  const path = method === 'POST' ? `${id}/reveal` : id;
  return new NextRequest(`https://x.test/api/v1/agentbook-payroll/employees/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

let logged = '';
const ORIGINAL_ENV = { ...process.env };

function seed() {
  store.employees = [
    { id: 'e-au', tenantId: 't1', name: 'Sydney AU', jurisdiction: 'au', payRateCents: 9_000_000, payFrequency: 'biweekly', isActive: true },
    { id: 'e-ca', tenantId: 't1', name: 'Maya CA', jurisdiction: 'ca', payRateCents: 8_000_000, payFrequency: 'biweekly', isActive: true },
    { id: 'e-us', tenantId: 't1', name: 'Alex US', jurisdiction: 'us', payRateCents: 7_000_000, payFrequency: 'biweekly', isActive: true },
    { id: 'e-other', tenantId: 't2', name: 'Other Tenant', jurisdiction: 'us', payRateCents: 1, payFrequency: 'weekly', isActive: true },
  ];
  store.sensitive = [];
  store.changes = [];
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.EMPLOYEE_PII_ENCRYPTION_KEY;
  delete process.env.VERCEL_ENV;
  logged = '';
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged += a.map((x) => (x instanceof Error ? x.message : JSON.stringify(x))).join(' '); });
  }
  rate.mockImplementation(async () => ({ allowed: true }));
});
afterEach(() => { vi.restoreAllMocks(); process.env = { ...ORIGINAL_ENV }; });

const allSecrets = () => [TFN, '123 456 782', SIN, '123456789', SSN, BANK, MEMBER,
  ...store.sensitive.flatMap((s) => [s.taxIdEnc, s.bankAccountEnc, s.superMemberNumberEnc]).filter(Boolean)];
function expectNoSecrets(text: string) {
  for (const v of allSecrets()) expect(text).not.toContain(v);
}

describe('PUT employees/[id] — strict, per-jurisdiction', () => {
  it('rejects unknown keys with 400 and changes nothing', async () => {
    const res = await PUT(req('PUT', 'e-us', { name: 'X', isAdmin: true }), ctx('e-us'));
    expect(res.status).toBe(400);
    expect(store.employees.find((e) => e.id === 'e-us')!.name).toBe('Alex US');
  });

  it('AU: valid TFN is encrypted, last4 kept, plaintext never stored or returned', async () => {
    const res = await PUT(req('PUT', 'e-au', { taxId: TFN, superFundUsi: 'STA0100AU', superMemberNumber: MEMBER }), ctx('e-au'));
    expect(res.status).toBe(200);
    const s = store.sensitive.find((r) => r.employeeId === 'e-au')!;
    expect(s.taxIdLast4).toBe('6782');
    expect(s.taxIdEnc).not.toContain(TFN);
    expect(JSON.stringify(s)).not.toContain(TFN);
    expect(JSON.stringify(s)).not.toContain(MEMBER);
    const text = await res.text();
    expectNoSecrets(text);
    expect(JSON.parse(text).data.sensitive.taxIdLast4).toBe('6782');
  });

  it('AU: bad TFN checksum → 400', async () => {
    const res = await PUT(req('PUT', 'e-au', { taxId: '123456789' }), ctx('e-au'));
    expect(res.status).toBe(400);
    expect(store.sensitive).toHaveLength(0);
  });

  it('CA: SIN Luhn — valid accepted, invalid 400', async () => {
    expect((await PUT(req('PUT', 'e-ca', { taxId: '046454287' }), ctx('e-ca'))).status).toBe(400);
    const ok = await PUT(req('PUT', 'e-ca', { taxId: SIN, td1Federal: 1612900 }), ctx('e-ca'));
    expect(ok.status).toBe(200);
    expect(store.sensitive[0].taxIdLast4).toBe('4286');
  });

  it('US: full SSN stored encrypted with last4; masked echo does not overwrite', async () => {
    await PUT(req('PUT', 'e-us', { taxId: SSN }), ctx('e-us'));
    const enc = store.sensitive[0].taxIdEnc;
    expect(store.sensitive[0].taxIdLast4).toBe('6789');
    const res = await PUT(req('PUT', 'e-us', { taxId: '***-**-6789', name: 'Alex U.' }), ctx('e-us'));
    expect(res.status).toBe(200);
    expect(store.sensitive[0].taxIdEnc).toBe(enc);
    expect(store.employees.find((e) => e.id === 'e-us')!.name).toBe('Alex U.');
    expect(store.changes.at(-1)!.fields).toEqual(['name']);
  });

  it('cross-tenant id → 404 and nothing written', async () => {
    const res = await PUT(req('PUT', 'e-other', { name: 'pwned', taxId: SSN }), ctx('e-other'));
    expect(res.status).toBe(404);
    expect(store.employees.find((e) => e.id === 'e-other')!.name).toBe('Other Tenant');
    expect(store.sensitive).toHaveLength(0);
  });

  it('scopes the update by tenantId', async () => {
    await PUT(req('PUT', 'e-us', { name: 'N' }), ctx('e-us'));
    expect(db.abEmployee.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'e-us', tenantId: 't1' } }));
  });

  it('writes AbEmployeeChange with field names only, never values', async () => {
    await PUT(req('PUT', 'e-au', { payRateCents: 9_500_000, taxId: TFN, bankAccount: BANK, bankRoutingLabel: 'BSB 062-000' }), ctx('e-au'));
    const c = store.changes.at(-1)!;
    expect(c).toMatchObject({ tenantId: 't1', employeeId: 'e-au', actorId: 't1', action: 'update' });
    expect(c.fields.sort()).toEqual(['bankAccount', 'bankRoutingLabel', 'payRateCents', 'taxId']);
    const text = JSON.stringify(store.changes);
    expectNoSecrets(text);
    expect(text).not.toContain('9500000');
    expect(text).not.toContain('062-000');
  });

  it('production without key: sensitive write → 503 pii_key_unconfigured, nothing stored', async () => {
    process.env.VERCEL_ENV = 'production';
    const res = await PUT(req('PUT', 'e-us', { taxId: SSN, name: 'Changed' }), ctx('e-us'));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('pii_key_unconfigured');
    expect(store.sensitive).toHaveLength(0);
    expect(store.employees.find((e) => e.id === 'e-us')!.name).toBe('Alex US');
    expectNoSecrets(logged + JSON.stringify(reportError.mock.calls));
  });

  it('preview without key: non-sensitive edit still works', async () => {
    process.env.VERCEL_ENV = 'preview';
    const res = await PUT(req('PUT', 'e-us', { payFrequency: 'weekly' }), ctx('e-us'));
    expect(res.status).toBe(200);
    expect(store.employees.find((e) => e.id === 'e-us')!.payFrequency).toBe('weekly');
  });

  it('a failing DB write logs nothing sensitive', async () => {
    db.abEmployeeSensitive.upsert.mockRejectedValueOnce(new Error('db down'));
    const res = await PUT(req('PUT', 'e-us', { taxId: SSN, bankAccount: BANK }), ctx('e-us'));
    expect(res.status).toBe(500);
    const text = await res.text();
    expectNoSecrets(text + logged + JSON.stringify(reportError.mock.calls));
  });
});

describe('PUT — masked echoes, bank length, labels, jurisdiction (review I1/I2)', () => {
  it('a real member number containing X is saved (not mistaken for a mask)', async () => {
    const res = await PUT(req('PUT', 'e-au', { superMemberNumber: 'MX12345' }), ctx('e-au'));
    expect(res.status).toBe(200);
    expect(store.sensitive[0].superMemberNumberEnc).toBeTruthy();
    expect(store.changes.at(-1)!.fields).toEqual(['superMemberNumber']);
  });

  it.each(['***-**-6789', '•••• 6789', '****6789', '••••••'])('exact masked echo %s does not overwrite the SSN', async (echo) => {
    await PUT(req('PUT', 'e-us', { taxId: SSN }), ctx('e-us'));
    const enc = store.sensitive[0].taxIdEnc;
    const n = store.changes.length;
    expect((await PUT(req('PUT', 'e-us', { taxId: echo }), ctx('e-us'))).status).toBe(200);
    expect(store.sensitive[0].taxIdEnc).toBe(enc);
    expect(store.changes.length).toBe(n);
  });

  it('a masked string that is not the stored rendering is rejected, not ignored', async () => {
    await PUT(req('PUT', 'e-us', { taxId: SSN }), ctx('e-us'));
    expect((await PUT(req('PUT', 'e-us', { taxId: '***-**-1111' }), ctx('e-us'))).status).toBe(400);
  });

  it.each(['5678', '…5678', '12345'])('bank last-4 / short echo %s → 400, real account kept', async (echo) => {
    await PUT(req('PUT', 'e-au', { bankAccount: BANK }), ctx('e-au'));
    const enc = store.sensitive[0].bankAccountEnc;
    expect((await PUT(req('PUT', 'e-au', { bankAccount: echo }), ctx('e-au'))).status).toBe(400);
    expect(store.sensitive[0].bankAccountEnc).toBe(enc);
  });

  it('unchanged label fields are not logged as changed', async () => {
    await PUT(req('PUT', 'e-au', { bankRoutingLabel: 'BSB 062-000', superFundName: 'AustralianSuper' }), ctx('e-au'));
    const n = store.changes.length;
    await PUT(req('PUT', 'e-au', { bankRoutingLabel: 'BSB 062-000', superFundName: 'AustralianSuper' }), ctx('e-au'));
    expect(store.changes.length).toBe(n);
    await PUT(req('PUT', 'e-au', { bankRoutingLabel: 'BSB 062-001', superFundName: 'AustralianSuper' }), ctx('e-au'));
    expect(store.changes.at(-1)!.fields).toEqual(['bankRoutingLabel']);
  });

  it('jurisdiction change with a stored tax id requires re-entry', async () => {
    await PUT(req('PUT', 'e-us', { taxId: SSN }), ctx('e-us'));
    const res = await PUT(req('PUT', 'e-us', { jurisdiction: 'ca' }), ctx('e-us'));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('tax_id_reentry_required');
    expect(store.employees.find((e) => e.id === 'e-us')!.jurisdiction).toBe('us');
    expect((await PUT(req('PUT', 'e-us', { jurisdiction: 'ca', taxId: SIN }), ctx('e-us'))).status).toBe(200);
    expect(store.sensitive[0].taxIdLast4).toBe('4286');
  });
});

describe('GET employees/[id] — masked', () => {
  it('returns last4 and flags, never ciphertext or plaintext', async () => {
    await PUT(req('PUT', 'e-au', { taxId: TFN, bankAccount: BANK, superMemberNumber: MEMBER }), ctx('e-au'));
    const res = await GET(req('GET', 'e-au'), ctx('e-au'));
    expect(res.status).toBe(200);
    const text = await res.text();
    expectNoSecrets(text);
    expect(text).not.toMatch(/Enc"/);
    const s = JSON.parse(text).data.sensitive;
    expect(s).toMatchObject({ hasTaxId: true, taxIdLast4: '6782', hasBankAccount: true, bankLast4: '5678', hasSuperMemberNumber: true });
  });

  it('cross-tenant id → 404', async () => {
    expect((await GET(req('GET', 'e-other'), ctx('e-other'))).status).toBe(404);
  });
});

describe('POST employees/[id]/reveal', () => {
  beforeEach(async () => {
    await PUT(req('PUT', 'e-us', { taxId: SSN, bankAccount: BANK }), ctx('e-us'));
    store.changes = [];
  });

  it('owner gets the plaintext and the reveal is audited (field name only)', async () => {
    const res = await REVEAL(req('POST', 'e-us', { field: 'taxId' }), ctx('e-us'));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ field: 'taxId', value: '123456789' });
    expect(store.changes).toEqual([expect.objectContaining({ tenantId: 't1', employeeId: 'e-us', actorId: 't1', action: 'reveal', fields: ['taxId'] })]);
    expectNoSecrets(JSON.stringify(store.changes) + logged);
  });

  it('audit write failure → no value revealed', async () => {
    db.abEmployeeChange.create.mockRejectedValueOnce(new Error('audit down'));
    const res = await REVEAL(req('POST', 'e-us', { field: 'taxId' }), ctx('e-us'));
    expect(res.status).toBe(500);
    expectNoSecrets(await res.text());
  });

  it('is rate-limited per tenant → 429, not revealed, not audited', async () => {
    rate.mockImplementation(async () => ({ allowed: false, reason: 'minute', retryAfterMs: 30_000 }));
    const res = await REVEAL(req('POST', 'e-us', { field: 'taxId' }), ctx('e-us'));
    expect(res.status).toBe(429);
    expect(rate).toHaveBeenCalledWith('t1', 'employee-pii-reveal', expect.any(Object));
    expectNoSecrets(await res.text());
    expect(store.changes).toHaveLength(0);
  });

  it('role-gated: a service (cron) caller is not the owner → 403', async () => {
    process.env.CRON_SECRET = 'cron-secret-value';
    const res = await REVEAL(req('POST', 'e-us', { field: 'taxId' }, { token: null, headers: { authorization: 'Bearer cron-secret-value', 'x-tenant-id': 't1' } }), ctx('e-us'));
    expect(res.status).toBe(403);
    expectNoSecrets(await res.text());
    expect(store.changes).toHaveLength(0);
  });

  it('unauthenticated → 401', async () => {
    expect((await REVEAL(req('POST', 'e-us', { field: 'taxId' }, { token: null }), ctx('e-us'))).status).toBe(401);
  });

  it('cross-tenant id → 404 (another owner cannot reach it)', async () => {
    const res = await REVEAL(req('POST', 'e-us', { field: 'taxId' }, { token: 'tok-t2' }), ctx('e-us'));
    expect(res.status).toBe(404);
    expect(store.changes).toHaveLength(0);
  });

  it('unknown field → 400', async () => {
    expect((await REVEAL(req('POST', 'e-us', { field: 'taxIdEnc' }), ctx('e-us'))).status).toBe(400);
  });

  it('production without key → 503 pii_key_unconfigured, nothing revealed', async () => {
    process.env.VERCEL_ENV = 'production';
    const res = await REVEAL(req('POST', 'e-us', { field: 'taxId' }), ctx('e-us'));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('pii_key_unconfigured');
    expectNoSecrets(JSON.stringify(body));
  });

  it('decrypts values written under the configured key', async () => {
    process.env.EMPLOYEE_PII_ENCRYPTION_KEY = 'ab'.repeat(32);
    store.sensitive[0].bankAccountEnc = encryptPii(BANK);
    const res = await REVEAL(req('POST', 'e-us', { field: 'bankAccount' }), ctx('e-us'));
    expect((await res.json()).data.value).toBe(BANK);
  });
});
