/**
 * E2E for the year-end tax package generator (PR 5).
 *
 * The orchestrator (`apps/web-next/src/lib/agentbook-tax-package.ts`)
 * carries `import 'server-only'`, so we cannot load it from Playwright
 * directly. Instead we call the Next.js route over HTTP and use Prisma
 * to seed fixtures + assert side-effects.
 *
 * Coverage:
 *   1. POST tax-package/generate?year=2025 returns a ready package
 *      (DB-backed; skipped when @vercel/blob isn't reachable from the
 *       dev server — the dev fallback returns a `data:` URL so this
 *       suite is happy even without BLOB_READ_WRITE_TOKEN, but if
 *       /generate ever returns 5xx we skip with a clear reason)
 *   2. A second call to /generate is idempotent — same packageId,
 *      regenerated artifacts, AbTaxPackage row reused.
 *   3. The summary numbers match the seeded fixtures.
 */

import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3000';
const TENANT = `e2e-tax-pkg-${Date.now()}`;
const YEAR = 2025;

let prisma: typeof import('@naap/database').prisma;
let serverReachable = true;

async function fetchJson(
  request: import('@playwright/test').APIRequestContext,
  url: string,
  init: { method?: string; data?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: unknown }> {
  const res = await request.fetch(url, {
    method: init.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-id': TENANT,
      ...(init.headers || {}),
    },
    data: init.data ? JSON.stringify(init.data) : undefined,
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { body = await res.text(); }
  return { status: res.status(), body };
}

test.beforeAll(async ({ request }) => {
  const dbMod = await import('@naap/database');
  prisma = dbMod.prisma;

  // Probe — if the Next dev server isn't running, skip the whole suite
  // with a clear reason instead of dumping a connection-refused stack.
  try {
    const probe = await request.fetch(`${BASE}/api/v1/agentbook-tax/tax-package?year=${YEAR}`, {
      headers: { 'x-tenant-id': TENANT },
      timeout: 5000,
    });
    if (!probe.ok() && probe.status() >= 500) serverReachable = false;
  } catch {
    serverReachable = false;
  }

  // Seed the chart of accounts so the tax-line mapper has something to
  // bucket by, plus a couple of confirmed expenses + a mileage entry.
  const meals = await prisma.abAccount.upsert({
    where: { tenantId_code: { tenantId: TENANT, code: '5300' } },
    update: { accountType: 'expense', name: 'Meals' },
    create: { tenantId: TENANT, code: '5300', name: 'Meals', accountType: 'expense' },
  });
  const travel = await prisma.abAccount.upsert({
    where: { tenantId_code: { tenantId: TENANT, code: '5100' } },
    update: { accountType: 'expense', name: 'Travel' },
    create: { tenantId: TENANT, code: '5100', name: 'Travel', accountType: 'expense' },
  });

  await prisma.abTenantConfig.upsert({
    where: { userId: TENANT },
    update: { jurisdiction: 'us', currency: 'USD' },
    create: { userId: TENANT, jurisdiction: 'us', currency: 'USD' },
  });

  await prisma.abExpense.createMany({
    data: [
      {
        tenantId: TENANT,
        amountCents: 5000,
        currency: 'USD',
        date: new Date(Date.UTC(YEAR, 2, 15)),
        categoryId: meals.id,
        description: 'Lunch with client',
        status: 'confirmed',
        isPersonal: false,
      },
      {
        tenantId: TENANT,
        amountCents: 12000,
        currency: 'USD',
        date: new Date(Date.UTC(YEAR, 5, 1)),
        categoryId: travel.id,
        description: 'Flight to TechCorp',
        status: 'confirmed',
        isPersonal: false,
      },
    ],
  });

  await prisma.abMileageEntry.create({
    data: {
      tenantId: TENANT,
      date: new Date(Date.UTC(YEAR, 1, 10)),
      miles: 47,
      unit: 'mi',
      purpose: 'TechCorp meeting',
      jurisdiction: 'us',
      ratePerUnitCents: 67,
      deductibleAmountCents: 3149,
    },
  });
});

test.afterAll(async () => {
  if (!prisma) return;
  await prisma.abTaxPackage.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
  await prisma.abMileageEntry.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
  await prisma.abExpense.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
  await prisma.abAccount.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
  await prisma.abTenantConfig.deleteMany({ where: { userId: TENANT } }).catch(() => {});
  await prisma.$disconnect();
});

let firstPackageId = '';
let firstSummary: {
  expenseCount: number;
  deductionsCents: number;
  mileageDeductionCents: number;
  arTotalCents: number;
} | null = null;

test.describe.serial('Year-end tax package — HTTP', () => {
  test('1. POST /tax-package/generate returns a ready package', async ({ request }) => {
    test.skip(!serverReachable, 'Next dev server not reachable on :3000 — start with `npm run dev`.');

    const { status, body } = await fetchJson(request, `${BASE}/api/v1/agentbook-tax/tax-package/generate`, {
      method: 'POST',
      data: { year: YEAR },
    });

    if (status >= 500) {
      const errMsg = (body as { error?: string })?.error || 'unknown';
      // BLOB token missing: the lib falls back to a data: URL so this
      // path should NOT 500. Anything else here is a real failure.
      throw new Error(`generate failed: ${status} ${errMsg}`);
    }
    expect(status).toBe(200);
    const j = body as { success: boolean; data: { packageId: string; pdfUrl: string; csvUrls: { pnl: string; mileage: string; deductions: string }; summary: { expenseCount: number; deductionsCents: number; mileageDeductionCents: number; arTotalCents: number } } };
    expect(j.success).toBe(true);
    expect(j.data.packageId).toBeTruthy();
    expect(j.data.pdfUrl).toBeTruthy();
    expect(j.data.csvUrls.pnl).toBeTruthy();
    expect(j.data.csvUrls.mileage).toBeTruthy();
    expect(j.data.csvUrls.deductions).toBeTruthy();

    firstPackageId = j.data.packageId;
    firstSummary = j.data.summary;

    // DB row reaches status='ready'.
    const row = await prisma.abTaxPackage.findUnique({ where: { id: firstPackageId } });
    expect(row?.status).toBe('ready');
    expect(row?.tenantId).toBe(TENANT);
    expect(row?.year).toBe(YEAR);
  });

  test('2. Second /generate call is idempotent — same packageId', async ({ request }) => {
    test.skip(!serverReachable, 'dev server unavailable');
    test.skip(!firstPackageId, 'first call did not succeed; cannot test idempotency');

    const { status, body } = await fetchJson(request, `${BASE}/api/v1/agentbook-tax/tax-package/generate`, {
      method: 'POST',
      data: { year: YEAR },
    });
    expect(status).toBe(200);
    const j = body as { success: boolean; data: { packageId: string } };
    expect(j.data.packageId).toBe(firstPackageId);

    // Only one row exists for the (tenant, year, jurisdiction) tuple.
    const rows = await prisma.abTaxPackage.findMany({
      where: { tenantId: TENANT, year: YEAR, jurisdiction: 'us' },
    });
    expect(rows.length).toBe(1);
  });

  test('3. Summary numbers match the seeded fixtures', async () => {
    test.skip(!serverReachable, 'dev server unavailable');
    test.skip(!firstSummary, 'no summary captured');

    // Seeded: 5000 + 12000 = 17000¢ in expenses, 1 mileage entry @ 3149¢
    expect(firstSummary!.expenseCount).toBe(2);
    expect(firstSummary!.deductionsCents).toBe(17000);
    expect(firstSummary!.mileageDeductionCents).toBe(3149);
    expect(firstSummary!.arTotalCents).toBe(0); // no invoices seeded
  });
});
