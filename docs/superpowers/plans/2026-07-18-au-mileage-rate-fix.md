# AU Mileage Rate Fix (Roadmap PR AU-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An AU tenant's mileage deduction uses the real 88¢/km ATO cents-per-km rate, at every place mileage can be recorded (web API, Telegram bot skill, and the edit/PATCH path) — not the US 67¢/mi rate it silently gets coerced to today.

**Architecture:** `apps/web-next/src/lib/agentbook-mileage-rates.ts`'s `getMileageRate()` is the single rate-lookup helper already shared by all three mileage-recording call sites (`mileage/route.ts` POST, `agentbook-mileage-service.ts`'s PATCH/edit path, and `agentbook-bot-agent.ts`'s Telegram record-mileage skill). It currently only branches on `'us' | 'ca'` and throws for anything else — each call site defensively coerces any non-`'ca'` jurisdiction to `'us'` before calling it, which is what silently mis-rates AU tenants. This PR widens the helper to accept `'au'`, reusing the already-correct, already-published ATO rate from `packages/agentbook-jurisdictions/src/au/mileage-rate.ts` (imported via the existing `@agentbook/jurisdictions` package — already a working cross-package import elsewhere in `apps/web-next`, e.g. `agentbook-startup/discovery.ts`), then updates each of the three call sites' jurisdiction resolution to pass through `'au'` instead of defaulting it to `'us'`.

**Tech Stack:** TypeScript, Next.js API routes, Vitest.

## Global Constraints

- **Reuse before rewrite:** do not hand-roll new ATO rate constants — import `auPack.mileageRate` (or `auMileageRate` directly) from `@agentbook/jurisdictions`, the same package every other jurisdiction-pack fix this roadmap has used.
- **US/CA mileage behavior is unchanged.** Every existing test for `'us'`/`'ca'` must still pass unmodified.
- **No new abstraction layers.** Do not consolidate the three call sites' pre-existing duplicated jurisdiction-resolution logic into a shared helper — that's a separate refactor, out of scope for this fix. Make the minimal parallel change at each site.
- **No schema migration.** `AbMileageEntry.jurisdiction` is already a free-text `String` column; no Prisma change needed.

---

### Task 1: Widen `getMileageRate` to support `'au'`

**Files:**
- Modify: `apps/web-next/src/lib/agentbook-mileage-rates.ts`
- Test: `apps/web-next/src/lib/agentbook-mileage-rates.test.ts`

**Interfaces:**
- Consumes: `auMileageRate` from `@agentbook/jurisdictions` — `auMileageRate.getRate(taxYear: number, totalKm: number): { rate: number; unit: 'mile' | 'km'; tierDescription?: string }`, where `rate` is a **dollar** amount per km (e.g. `0.88`), not cents.
- Produces: `getMileageRate(jurisdiction: 'us' | 'ca' | 'au', year: number, milesOrKmThisYear: number): RateLookup` — the `jurisdiction` parameter type widens from `'us' | 'ca'` to `'us' | 'ca' | 'au'`. Existing `RateLookup` shape (`{ ratePerUnitCents: number; unit: 'mi' | 'km'; reason: string }`) is unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web-next/src/lib/agentbook-mileage-rates.test.ts`, inside a new `describe('AU (ATO cents-per-km method)', ...)` block (after the existing `describe('getMileageRate', ...)` block, before the CRA backdating describe block):

```typescript
import { auMileageRate } from '@agentbook/jurisdictions';

describe('AU (ATO cents-per-km method)', () => {
  it('2025/2026 → flat 88¢/km (ATO cents-per-km rate)', () => {
    const r = getMileageRate('au', 2026, 0);
    expect(r.unit).toBe('km');
    expect(r.ratePerUnitCents).toBe(88);
    expect(r.reason).toMatch(/ATO/i);
  });

  it('2024 → flat 85¢/km (ATO cents-per-km rate for 2024-25)', () => {
    const r = getMileageRate('au', 2024, 0);
    expect(r.unit).toBe('km');
    expect(r.ratePerUnitCents).toBe(85);
  });

  it('AU flat rate is invariant of accumulated km (no tiers, unlike CA)', () => {
    const a = getMileageRate('au', 2026, 0);
    const b = getMileageRate('au', 2026, 9_999);
    expect(a.ratePerUnitCents).toBe(b.ratePerUnitCents);
  });

  it('matches the real ATO rate published in the jurisdictions package directly', () => {
    // Cross-check against the source of truth this helper wraps, so the
    // two can't silently drift apart.
    const source = auMileageRate.getRate(2026, 0);
    const wrapped = getMileageRate('au', 2026, 0);
    expect(wrapped.ratePerUnitCents).toBe(Math.round(source.rate * 100));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-next && npx vitest run src/lib/agentbook-mileage-rates.test.ts`
Expected: FAIL — `getMileageRate('au', ...)` throws `Unknown jurisdiction "au"` (the current runtime guard), and the `@agentbook/jurisdictions` import path may also need confirming resolves in this test file (it already resolves fine elsewhere in `apps/web-next`, e.g. `agentbook-startup/discovery.ts`, so no new wiring is needed).

- [ ] **Step 3: Implement**

In `apps/web-next/src/lib/agentbook-mileage-rates.ts`:

1. Add the import at the top (after the existing `import 'server-only';`):

```typescript
import { auMileageRate } from '@agentbook/jurisdictions';
```

2. Change the `getMileageRate` signature's first parameter type from `jurisdiction: 'us' | 'ca'` to `jurisdiction: 'us' | 'ca' | 'au'`, and update the JSDoc line `@param jurisdiction \`'us'\` (mile-based, flat) or \`'ca'\` (km-based, tiered).` to:

```typescript
 * @param jurisdiction `'us'` (mile-based, flat), `'ca'` (km-based, tiered),
 *                      or `'au'` (km-based, flat ATO cents-per-km method).
```

3. Add an `'au'` branch immediately before the final `throw new Error(...)` line (after the existing `if (jurisdiction === 'ca') { ... }` block closes):

```typescript
  if (jurisdiction === 'au') {
    // ATO cents-per-km method — flat rate, no tiering (the jurisdictions
    // package's `tierDescription` carries an advisory note past 5,000 km
    // suggesting the logbook method instead; the rate itself doesn't
    // change, so we don't surface that distinction here).
    const ato = auMileageRate.getRate(year, milesOrKmThisYear);
    return {
      ratePerUnitCents: Math.round(ato.rate * 100),
      unit: 'km',
      reason: `ATO cents-per-km rate, ${year} (${Math.round(ato.rate * 100)}¢/km)`,
    };
  }
```

4. Update the final `throw new Error(...)` message from `` supported: 'us' | 'ca' `` to `` supported: 'us' | 'ca' | 'au' ``.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-next && npx vitest run src/lib/agentbook-mileage-rates.test.ts`
Expected: PASS, all tests including the pre-existing US/CA ones and the new AU ones (the `unknown jurisdiction throws` test still passes unmodified since it uses `'uk'`, still unsupported).

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/lib/agentbook-mileage-rates.ts apps/web-next/src/lib/agentbook-mileage-rates.test.ts
git commit -m "feat(mileage): add AU ATO cents-per-km rate to getMileageRate"
```

---

### Task 2: Wire `'au'` into the mileage API route, edit/PATCH service, and Telegram bot skill

**Files:**
- Modify: `apps/web-next/src/app/api/v1/agentbook-expense/mileage/route.ts`
- Modify: `apps/web-next/src/lib/agentbook-mileage-service.ts`
- Modify: `apps/web-next/src/lib/agentbook-bot-agent.ts` (only the record-mileage skill block, ~lines 2170-2320 — do not touch the unrelated SE-tax/label sections elsewhere in this file; those are a separate roadmap PR's scope)
- Test: new `apps/web-next/src/app/api/v1/agentbook-expense/mileage/__tests__/au-jurisdiction.test.ts` (or extend the existing route test file if one already covers POST — check `apps/web-next/src/__tests__/api/v1/agentbook-expense/mileage-route.test.ts` first; extend it if found, create the new path only if no existing route test covers this POST handler)

**Interfaces:**
- Consumes: `getMileageRate` (from Task 1, now accepting `'au'`).
- Produces: no new exports — this task only changes internal jurisdiction-resolution logic at three existing call sites so `'au'` is no longer silently coerced to `'us'`.

- [ ] **Step 1: Locate the existing route test file and write the failing test**

First run: `find apps/web-next/src -iname "*mileage*" -path "*test*"` to see what already covers `mileage/route.ts`'s POST handler. If a test file exists that mocks `db` and calls the route's `POST` directly, add the new test there. Otherwise create `apps/web-next/src/app/api/v1/agentbook-expense/mileage/__tests__/au-jurisdiction.test.ts` following the mocking pattern used by sibling route tests in this codebase (mock `@naap/database`'s `prisma`, mock `@/lib/agentbook-tenant`'s `safeResolveAgentbookTenant`, mock `@/lib/agentbook-account-resolver`'s `resolveVehicleAccounts` to return `null` so no journal-entry branch is exercised).

Add this test (adjust mock plumbing to match whatever pattern the located/created file uses):

```typescript
it('an AU tenant (jurisdiction resolved from tenant config) books mileage at the ATO 88¢/km rate, not the US 67¢/mi rate', async () => {
  // Arrange: tenant config resolves to AU jurisdiction, no override passed.
  tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au' });
  mileageEntryCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
    id: 'entry-au-1',
    ...data,
  }));

  const req = new NextRequest('http://x/mileage', {
    method: 'POST',
    body: JSON.stringify({ miles: 100, purpose: 'Client site visit' }),
  });
  const res = await POST(req);
  const body = await res.json();

  expect(res.status).toBe(201);
  expect(body.data.jurisdiction).toBe('au');
  expect(body.data.unit).toBe('km');
  expect(body.data.ratePerUnitCents).toBe(88);
  expect(body.data.deductibleAmountCents).toBe(8_800); // 100 km × 88¢
});

it('an AU tenant passing jurisdictionOverride is honored the same as us/ca', async () => {
  tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us' }); // config says US...
  mileageEntryCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
    id: 'entry-au-2',
    ...data,
  }));

  const req = new NextRequest('http://x/mileage', {
    method: 'POST',
    // ...but the caller (bot) explicitly overrides to AU, e.g. after
    // looking up the tenant's real jurisdiction itself.
    body: JSON.stringify({ miles: 50, purpose: 'Depot run', jurisdictionOverride: 'au' }),
  });
  const res = await POST(req);
  const body = await res.json();

  expect(res.status).toBe(201);
  expect(body.data.jurisdiction).toBe('au');
  expect(body.data.ratePerUnitCents).toBe(88);
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd apps/web-next && npx vitest run <the test file path>`
Expected: FAIL — both new tests currently get `jurisdiction: 'us'` in the response body (the route's coercion logic defaults anything non-`'ca'` to `'us'`), so `ratePerUnitCents` is `67` and `unit` is `'mi'`, not the expected AU values.

- [ ] **Step 3: Implement — `mileage/route.ts`**

In `apps/web-next/src/app/api/v1/agentbook-expense/mileage/route.ts`:

1. Widen the `CreateMileageBody` interface's `jurisdictionOverride` field from `'us' | 'ca'` to `'us' | 'ca' | 'au'`.

2. Replace the jurisdiction-resolution block:

```typescript
    // Jurisdiction snapshot: prefer override (the bot passes it after
    // looking it up), else read from tenant config, else default 'us'.
    let jurisdiction: 'us' | 'ca' = body.jurisdictionOverride === 'ca' ? 'ca' : 'us';
    if (!body.jurisdictionOverride) {
      const cfg = await db.abTenantConfig.findUnique({
        where: { userId: tenantId },
        select: { jurisdiction: true },
      });
      jurisdiction = cfg?.jurisdiction === 'ca' ? 'ca' : 'us';
    }
```

with:

```typescript
    // Jurisdiction snapshot: prefer override (the bot passes it after
    // looking it up), else read from tenant config, else default 'us'.
    let jurisdiction: 'us' | 'ca' | 'au' =
      body.jurisdictionOverride === 'ca' || body.jurisdictionOverride === 'au'
        ? body.jurisdictionOverride
        : 'us';
    if (!body.jurisdictionOverride) {
      const cfg = await db.abTenantConfig.findUnique({
        where: { userId: tenantId },
        select: { jurisdiction: true },
      });
      jurisdiction = cfg?.jurisdiction === 'ca' || cfg?.jurisdiction === 'au' ? cfg.jurisdiction : 'us';
    }
```

3. Update the `unit` default logic — change:

```typescript
    const unit: 'mi' | 'km' = body.unit === 'km' || body.unit === 'mi'
      ? body.unit
      : (jurisdiction === 'ca' ? 'km' : 'mi');
```

to:

```typescript
    const unit: 'mi' | 'km' = body.unit === 'km' || body.unit === 'mi'
      ? body.unit
      : (jurisdiction === 'ca' || jurisdiction === 'au' ? 'km' : 'mi');
```

4. Update the YTD-gate — change:

```typescript
    const ytd = jurisdiction === 'ca' ? await ytdMilesOrKm(tenantId, date, unit) : 0;
```

to:

```typescript
    // AU's ATO rate doesn't tier on YTD km (see Task 1), but we still
    // compute it for AU so the rate lookup's `reason`/tierDescription
    // stays accurate if a future rate table adds tiering.
    const ytd = jurisdiction === 'ca' || jurisdiction === 'au'
      ? await ytdMilesOrKm(tenantId, date, unit)
      : 0;
```

- [ ] **Step 4: Implement — `agentbook-mileage-service.ts`**

In `apps/web-next/src/lib/agentbook-mileage-service.ts`, the PATCH/edit path currently has:

```typescript
  let ratePerUnitCents = existing.ratePerUnitCents;
  if (existing.jurisdiction === 'ca') {
    const start = new Date(Date.UTC(tripYear, 0, 1));
    const others = await db.abMileageEntry.findMany({
      where: {
        tenantId,
        unit: existing.unit,
        date: { gte: start, lt: existing.date },
        NOT: { id: entryId },
        deletedAt: null,
      },
      select: { miles: true },
    });
    const ytd = others.reduce((s, r) => s + r.miles, 0);
    ratePerUnitCents = getMileageRate('ca', tripYear, ytd).ratePerUnitCents;
  } else {
    ratePerUnitCents = getMileageRate('us', tripYear, 0).ratePerUnitCents;
  }
```

Replace with:

```typescript
  let ratePerUnitCents = existing.ratePerUnitCents;
  if (existing.jurisdiction === 'ca' || existing.jurisdiction === 'au') {
    const start = new Date(Date.UTC(tripYear, 0, 1));
    const others = await db.abMileageEntry.findMany({
      where: {
        tenantId,
        unit: existing.unit,
        date: { gte: start, lt: existing.date },
        NOT: { id: entryId },
        deletedAt: null,
      },
      select: { miles: true },
    });
    const ytd = others.reduce((s, r) => s + r.miles, 0);
    ratePerUnitCents = getMileageRate(existing.jurisdiction, tripYear, ytd).ratePerUnitCents;
  } else {
    ratePerUnitCents = getMileageRate('us', tripYear, 0).ratePerUnitCents;
  }
```

(`existing.jurisdiction` is a DB-stored free-text `String`; TypeScript will need a narrowing cast or an `as 'ca' | 'au'` — use `existing.jurisdiction as 'ca' | 'au'` at the `getMileageRate` call since the `if` already guards the value.)

- [ ] **Step 5: Implement — `agentbook-bot-agent.ts` record-mileage skill**

In `apps/web-next/src/lib/agentbook-bot-agent.ts`, locate the record-mileage skill block (search for `const jurisdiction: 'us' | 'ca' = cfg?.jurisdiction === 'ca' ? 'ca' : 'us';` immediately followed by `const date = new Date();` and `const unit: 'mi' | 'km' = unitArg || (jurisdiction === 'ca' ? 'km' : 'mi');` — this is the ONLY block among several similar-looking `jurisdiction` resolutions in this file that belongs to the mileage-recording skill; do not touch the other `jurisdiction` blocks elsewhere in the file, they belong to a separate roadmap PR (AU-6)).

Replace:

```typescript
        const jurisdiction: 'us' | 'ca' = cfg?.jurisdiction === 'ca' ? 'ca' : 'us';
        const date = new Date();
        const year = date.getUTCFullYear();
        const unit: 'mi' | 'km' = unitArg || (jurisdiction === 'ca' ? 'km' : 'mi');

        let ytd = 0;
        if (jurisdiction === 'ca') {
```

with:

```typescript
        const jurisdiction: 'us' | 'ca' | 'au' =
          cfg?.jurisdiction === 'ca' || cfg?.jurisdiction === 'au' ? cfg.jurisdiction : 'us';
        const date = new Date();
        const year = date.getUTCFullYear();
        const unit: 'mi' | 'km' = unitArg || (jurisdiction === 'ca' || jurisdiction === 'au' ? 'km' : 'mi');

        let ytd = 0;
        if (jurisdiction === 'ca' || jurisdiction === 'au') {
```

(The `where: { tenantId: ctx.tenantId, unit, date: { gte: start, lt: date } }` query and `ytd = rows.reduce(...)` lines immediately below stay unchanged — they're not CA-specific in their logic, just gated by the `if`.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/web-next && npx vitest run <the test file path from Step 1> src/lib/agentbook-mileage-rates.test.ts`
Expected: PASS — both new route tests, plus all pre-existing US/CA tests across all touched files unchanged.

- [ ] **Step 7: Run the full affected-package test suite**

Run: `cd apps/web-next && npx vitest run src/lib/agentbook-mileage-rates.test.ts src/lib/agentbook-mileage-service.ts src/lib/agentbook-bot-agent.ts 2>&1 | tail -5` — adjust to the actual existing test files for `agentbook-mileage-service.ts` and `agentbook-bot-agent.ts` (search first with `find apps/web-next/src -iname "*mileage-service*test*" -o -iname "*bot-agent*test*"`) to confirm no regression in either file's existing US/CA test coverage.
Expected: PASS, zero regressions.

- [ ] **Step 8: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook-expense/mileage/route.ts \
        apps/web-next/src/lib/agentbook-mileage-service.ts \
        apps/web-next/src/lib/agentbook-bot-agent.ts \
        <test file path(s) touched>
git commit -m "fix(mileage): stop coercing AU tenants to the US mileage rate"
```
