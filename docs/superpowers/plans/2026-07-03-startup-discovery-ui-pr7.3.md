# Startup Tax Benefits — PR 7.3 (Discovery & Recommendation UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the free, pre-purchase "Phase 1" discovery flow for `agentbook-startup`: a company-details intake form, a recommendation engine that dispatches through the `TaxBenefitProvider` built in PR 7.1, a first-ever frontend for this plugin, and the `us-rd-credit-finder` skill manifest row — so a founder can see what they likely qualify for (with plain-language reasoning and a dollar range) before paying anything.

**Architecture:** Two new Express routes on the existing (currently route-less) `agentbook-startup` backend — `GET/PUT /profile` (persists `StartupBenefitProfile`) and `GET /recommendations` (dispatches through `getJurisdictionPack(jurisdiction).taxBenefits`, exactly the call site PR 7.1's architecture exists to support). The pure scoring/formatting logic lives in a new `discovery.ts` module, unit-tested directly — the Express handlers stay thin, untested wiring, matching this codebase's existing convention (`agentbook-tax`'s handlers are untested; its calculation logic is). The frontend is the plugin's first-ever UI: a small React app modeled on `agentbook-billing/frontend` (the simplest existing plugin frontend — no tailwind/framer-motion dependency bloat), built as a UMD bundle and wired into `plugin.json`'s now-added `frontend` key.

**Tech Stack:** Express (`@naap/plugin-server-sdk`), Prisma, React 19 + `react-router-dom` (MemoryRouter) + Vite (UMD build via `@naap/plugin-build/vite`), Vitest + `@testing-library/react` (`happy-dom`).

## Global Constraints

- This branch (`feat/startup-discovery-ui`) is cut from `feat/startup-tax-benefits` (PR #199) with `feat/startup-billing-addon` (PR #200) merged in — PR 7.3 needs both the plugin scaffold/jurisdiction interface (7.1) and, for the pricing teaser, `resolveAddOnPrice` (7.2). Verify `git log --oneline -5` shows both branches' commits before starting.
- Phase 1 (discovery) is explicitly **free, pre-purchase** per startup.html §7 — `GET /recommendations` and `GET/PUT /profile` are **not** gated behind `hasAddOn()`. Only drafting (PR 7.4+) is add-on gated.
- The recommendations endpoint must call the real jurisdiction dispatch (`getJurisdictionPack(jurisdiction).taxBenefits`), not import `usTaxBenefits` directly — this is the one and only reason PR 7.1's generalized interface exists; bypassing it here would silently defeat the architecture.
- No auto-prefill from the tenant's existing ledger in this PR (deferred — see the tenant/entity model note in project memory: ledger-derived numbers must be a reviewable suggestion, never silent auto-fill, given AgentBook's 1-user-1-tenant model). The intake form is manual-entry only, matching story A1 exactly.
- No Stripe Elements / payment collection in this PR — the discovery page shows the founding-member/standard price as **informational text only** (via `resolveAddOnPrice`), not a live purchase button. The purchase flow itself remains deliberately deferred from PR 7.2.
- Frontend package has no `tsconfig.json`-driven typecheck step in this repo's existing convention (confirmed: no plugin frontend runs `tsc --noEmit` as part of its build; Vite/esbuild transpiles without type-checking) — don't invent one; follow the same pattern (a standalone, `noEmit: true` tsconfig exists only for editor support).
- Per feedback memory: rebuild and **commit** the UMD bundle to `apps/web-next/public/cdn/plugins/agentbook-startup/`, and verify the actual feature in a real browser (Preview tools) — not by curling the CDN path.
- Per feedback memory: the local docker Postgres (`naap`) is shared across worktrees and currently has drift from other unmerged branches. Use an isolated verification database for all schema/seed operations in this plan; never pass `--accept-data-loss` to reconcile.

---

## Task 1: `discovery.ts` — pure recommendation logic (TDD)

**Files:**
- Create: `plugins/agentbook-startup/backend/src/discovery.ts`
- Test: `plugins/agentbook-startup/backend/src/__tests__/discovery.test.ts`

**Interfaces:**
- Consumes: `getJurisdictionPack`, `loadBuiltInPacks` from `@agentbook/jurisdictions` (existing, PR 7.1); a `CatalogEntry` shape matching the subset of `StartupBenefitProgram` fields needed for display (`programCode`, `name`, `authority`, `sourceUrl`).
- Produces: `computeRecommendations(jurisdiction: string, profile: StartupProfile, catalog: CatalogEntry[]): RecommendationsResult` — consumed by Task 2's Express route.

- [ ] **Step 1: Write the failing test**

Create `plugins/agentbook-startup/backend/src/__tests__/discovery.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { loadBuiltInPacks } from '@agentbook/jurisdictions';
import { computeRecommendations, type CatalogEntry } from '../discovery.js';

beforeAll(() => {
  loadBuiltInPacks();
});

const CATALOG: CatalogEntry[] = [
  { programCode: 'us_rd_credit_41', name: 'Federal R&D Tax Credit (IRC §41)', authority: 'IRS', sourceUrl: 'https://www.irs.gov/forms-pubs/about-form-6765' },
  { programCode: 'us_qsbs_tracking', name: 'QSBS Eligibility Tracking (IRC §1202)', authority: 'IRS', sourceUrl: 'https://www.irs.gov/pub/irs-pdf/i1202.pdf' },
  { programCode: 'us_de_franchise_optimization', name: 'Delaware Franchise Tax Optimization', authority: 'Delaware Division of Corporations', sourceUrl: 'https://corp.delaware.gov/frtaxcalc/' },
];

describe('computeRecommendations', () => {
  it('marks the R&D credit as qualified with a dollar range for meaningful R&D spend, using catalog display fields', () => {
    const result = computeRecommendations('us', { annualRdSpendCents: 40_000_000 }, CATALOG);
    const rd = result.programs.find((p) => p.programCode === 'us_rd_credit_41');
    expect(rd?.status).toBe('qualified');
    expect(rd?.name).toBe('Federal R&D Tax Credit (IRC §41)');
    expect(rd?.sourceUrl).toBe('https://www.irs.gov/forms-pubs/about-form-6765');
    expect(rd?.estValueLowCents).toBe(4_000_000);
    expect(rd?.estValueHighCents).toBe(8_000_000);
  });

  it('does not list Delaware franchise optimization for a non-C-corp', () => {
    const result = computeRecommendations('us', { companyType: 'llc' }, CATALOG);
    expect(result.programs.map((p) => p.programCode)).not.toContain('us_de_franchise_optimization');
  });

  it('lists all 3 catalog programs for a fully-qualifying Delaware C-corp with R&D spend', () => {
    const result = computeRecommendations('us', { companyType: 'c_corp', annualRdSpendCents: 40_000_000, incorporatedAt: new Date('2026-01-01') }, CATALOG);
    expect(result.programs.map((p) => p.programCode).sort()).toEqual([
      'us_de_franchise_optimization', 'us_qsbs_tracking', 'us_rd_credit_41',
    ]);
  });

  it('returns an empty list with an explanatory message for a jurisdiction with no TaxBenefitProvider yet', () => {
    const result = computeRecommendations('ca', {}, []);
    expect(result.programs).toHaveLength(0);
    expect(result.message).toMatch(/not yet available/i);
  });

  it('returns an empty list with an explanatory message for a completely unknown jurisdiction', () => {
    const result = computeRecommendations('de', {}, []);
    expect(result.programs).toHaveLength(0);
    expect(result.message).toMatch(/not yet available/i);
  });

  it('never returns a silent empty state — a supported jurisdiction with zero matching programs still gets a message (story A6)', () => {
    // Empty profile: no R&D spend, no companyType — roughlyApplies() is false for all 3 US programs.
    const result = computeRecommendations('us', {}, CATALOG);
    expect(result.programs).toHaveLength(0);
    expect(result.message).toBeDefined();
    expect(result.message).not.toMatch(/not yet available/i); // distinct from the unsupported-jurisdiction message
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd plugins/agentbook-startup/backend && npx vitest run src/__tests__/discovery.test.ts`
Expected: FAIL — `Cannot find module '../discovery.js'`.

- [ ] **Step 3: Implement `discovery.ts`**

Create `plugins/agentbook-startup/backend/src/discovery.ts`:
```ts
import { getJurisdictionPack } from '@agentbook/jurisdictions';
import type { StartupProfile } from '@agentbook/jurisdictions';

export interface CatalogEntry {
  programCode: string;
  name: string;
  authority: string;
  sourceUrl: string;
}

export interface ProgramRecommendation {
  programCode: string;
  name: string;
  authority: string;
  sourceUrl: string;
  status: string;
  confidence: number;
  reasoning: string;
  estValueLowCents: number | null;
  estValueHighCents: number | null;
}

export interface RecommendationsResult {
  jurisdiction: string;
  programs: ProgramRecommendation[];
  message?: string;
}

export function computeRecommendations(
  jurisdiction: string,
  profile: StartupProfile,
  catalog: CatalogEntry[],
): RecommendationsResult {
  const pack = getJurisdictionPack(jurisdiction);
  if (!pack?.taxBenefits) {
    return {
      jurisdiction,
      programs: [],
      message: 'Startup tax benefits are not yet available for your jurisdiction.',
    };
  }

  const taxBenefits = pack.taxBenefits;
  const summaries = taxBenefits.listPrograms(profile);
  const programs = summaries.map((summary): ProgramRecommendation => {
    const assessment = taxBenefits.assessEligibility(summary.programCode, profile);
    const catalogEntry = catalog.find((c) => c.programCode === summary.programCode);
    return {
      programCode: summary.programCode,
      name: catalogEntry?.name ?? summary.name,
      authority: catalogEntry?.authority ?? summary.authority,
      sourceUrl: catalogEntry?.sourceUrl ?? '',
      status: assessment.status,
      confidence: assessment.confidence,
      reasoning: assessment.reasoning,
      estValueLowCents: assessment.estValueLowCents,
      estValueHighCents: assessment.estValueHighCents,
    };
  });

  // Story A6: never a silent empty state. Distinct from the
  // unsupported-jurisdiction message above — this profile's jurisdiction
  // IS supported, it just doesn't roughly match any tracked program yet.
  if (programs.length === 0) {
    return {
      jurisdiction,
      programs,
      message: "No tracked programs match your profile yet — as your company grows (R&D spend, incorporation, headcount), check back for new recommendations.",
    };
  }

  return { jurisdiction, programs };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd plugins/agentbook-startup/backend && npx vitest run src/__tests__/discovery.test.ts`
Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/agentbook-startup/backend/src/discovery.ts plugins/agentbook-startup/backend/src/__tests__/discovery.test.ts
git commit -m "feat(startup): add computeRecommendations discovery logic"
```

---

## Task 2: Express routes — profile CRUD + recommendations

**Files:**
- Modify: `plugins/agentbook-startup/backend/src/server.ts` (currently only registers `createPluginServer` with no routes)

**Interfaces:**
- Consumes: `computeRecommendations` (Task 1); `db.startupBenefitProfile`, `db.startupBenefitProgram`, `db.startupBenefitEligibilityAssessment`, `db.abTenantConfig` (all existing Prisma models — the last one belongs to `agentbook-core` but is reachable through the same shared `@naap/database` client, exactly how `agentbook-tax` already reads other plugins' models).
- Produces: `GET /api/v1/agentbook-startup/profile`, `PUT /api/v1/agentbook-startup/profile`, `GET /api/v1/agentbook-startup/recommendations` — the second is the endpoint Task 3's skill manifest row points at, and the same one Task 5's frontend calls.

- [ ] **Step 1: Read the current file**

`plugins/agentbook-startup/backend/src/server.ts` currently ends after `createPluginServer(...)` with no `router`/tenant-middleware setup (PR 7.1 built it as a genuinely empty backend). Confirm this before editing.

- [ ] **Step 2: Add tenant middleware and the 3 routes**

Replace the body of `plugins/agentbook-startup/backend/src/server.ts` from the `createPluginServer` call onward with:
```ts
const server = createPluginServer({
  name: 'agentbook-startup',
  port: parseInt(process.env.PORT || String(pluginConfig.backend?.devPort || 4054), 10),
  prisma: db,
  requireAuth: process.env.NODE_ENV === 'production',
  publicRoutes: ['/healthz', '/api/v1/agentbook-startup'],
});

const { router } = server;

function getTenantId(req: any): string {
  return (req.headers['x-tenant-id'] as string) || req.user?.id || 'default';
}

router.use((req: any, _res, next) => {
  req.tenantId = getTenantId(req);
  next();
});

server.app.get('/api/v1/agentbook-startup/profile', async (req: any, res) => {
  const profile = await db.startupBenefitProfile.findUnique({ where: { tenantId: req.tenantId } });
  res.json({ profile });
});

server.app.put('/api/v1/agentbook-startup/profile', async (req: any, res) => {
  const { companyType, incorporatedAt, headcount, annualRdSpendCents, equityRaisedCents } = req.body ?? {};
  const data = {
    companyType: companyType ?? null,
    incorporatedAt: incorporatedAt ? new Date(incorporatedAt) : null,
    headcount: typeof headcount === 'number' ? headcount : null,
    annualRdSpendCents: typeof annualRdSpendCents === 'number' ? annualRdSpendCents : null,
    equityRaisedCents: typeof equityRaisedCents === 'number' ? equityRaisedCents : null,
    lastAssessedAt: new Date(),
  };
  const profile = await db.startupBenefitProfile.upsert({
    where: { tenantId: req.tenantId },
    create: { tenantId: req.tenantId, ...data },
    update: data,
  });
  res.json({ profile });
});

server.app.get('/api/v1/agentbook-startup/recommendations', async (req: any, res) => {
  const profile = await db.startupBenefitProfile.findUnique({ where: { tenantId: req.tenantId } });
  if (!profile) {
    return res.status(400).json({ error: 'complete your company profile first' });
  }

  const tenantConfig = await db.abTenantConfig.findUnique({ where: { userId: req.tenantId } });
  const jurisdiction = tenantConfig?.jurisdiction ?? 'us';

  const catalogRows = await db.startupBenefitProgram.findMany({ where: { jurisdiction, enabled: true } });
  const catalog = catalogRows.map((row) => ({
    programCode: row.programCode, name: row.name, authority: row.authority, sourceUrl: row.sourceUrl,
  }));

  const result = computeRecommendations(jurisdiction, {
    companyType: profile.companyType ?? undefined,
    incorporatedAt: profile.incorporatedAt ?? undefined,
    headcount: profile.headcount ?? undefined,
    annualRdSpendCents: profile.annualRdSpendCents ?? undefined,
    equityRaisedCents: profile.equityRaisedCents ?? undefined,
  }, catalog);

  // Audit-trail log, non-blocking — never let a logging failure break the response.
  for (const program of result.programs) {
    const catalogRow = catalogRows.find((c) => c.programCode === program.programCode);
    if (!catalogRow) continue;
    db.startupBenefitEligibilityAssessment.create({
      data: {
        tenantId: req.tenantId, programId: catalogRow.id, status: program.status,
        confidence: program.confidence, reasoning: program.reasoning,
        estValueLowCents: program.estValueLowCents, estValueHighCents: program.estValueHighCents,
      },
    }).catch((err: unknown) => console.error('[agentbook-startup] failed to log eligibility assessment', err));
  }

  res.json(result);
});

export const app = server.app;
```

Also add these two imports near the top of the file, alongside the existing `import { db } from './db/client.js';`:
```ts
import { loadBuiltInPacks } from '@agentbook/jurisdictions';
import { computeRecommendations } from './discovery.js';
```
And call `loadBuiltInPacks();` once, immediately after the imports (before `createPluginServer(...)`) — this is the first consumer of the jurisdiction pack registry in the whole codebase, so nothing else populates it.

Add `@agentbook/jurisdictions` to `plugins/agentbook-startup/backend/package.json`'s `dependencies` (it currently only has `@naap/database`, `@naap/plugin-server-sdk`, `cors`, `dotenv`, `express`):
```json
"@agentbook/jurisdictions": "*",
```

- [ ] **Step 3: Install the new dependency**

Run: `npm install` (from repo root).

- [ ] **Step 4: Start the server and manually verify all 3 routes**

Create an isolated verification database (per the shared-DB hazard in project memory):
```bash
docker exec naap-db psql -U postgres -c "CREATE DATABASE naap_pr73_verify;"
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap_pr73_verify" \
DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap_pr73_verify" \
npx --no prisma db push --skip-generate --schema packages/database/prisma/schema.prisma
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap_pr73_verify" \
DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap_pr73_verify" \
npx tsx bin/seed-startup-benefit-programs.ts
```
Expected: clean push (no data-loss prompt — this is a brand-new isolated DB), then `{"created":3,"updated":0,"total":3}`.

Start the backend:
```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap_pr73_verify" \
DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap_pr73_verify" \
PORT=4054 npx tsx plugins/agentbook-startup/backend/src/server.ts
```
In another shell:
```bash
curl -s http://localhost:4054/api/v1/agentbook-startup/profile -H "x-tenant-id: t1"
# Expected: {"profile":null}

curl -s -X PUT http://localhost:4054/api/v1/agentbook-startup/profile -H "x-tenant-id: t1" -H "content-type: application/json" \
  -d '{"companyType":"c_corp","annualRdSpendCents":40000000,"headcount":4}'
# Expected: {"profile":{...,"companyType":"c_corp","annualRdSpendCents":40000000,"headcount":4,...}}

curl -s http://localhost:4054/api/v1/agentbook-startup/recommendations -H "x-tenant-id: t1"
# Expected: {"jurisdiction":"us","programs":[{"programCode":"us_rd_credit_41","name":"Federal R&D Tax Credit (IRC §41)",...,"status":"qualified","estValueLowCents":4000000,"estValueHighCents":8000000},{"programCode":"us_qsbs_tracking",...},{"programCode":"us_de_franchise_optimization",...}]}
```
Stop the server afterward.

- [ ] **Step 5: Commit**

```bash
git add plugins/agentbook-startup/backend/src/server.ts plugins/agentbook-startup/backend/package.json package-lock.json
git commit -m "feat(startup): add profile CRUD and recommendations endpoints"
```

---

## Task 3: `us-rd-credit-finder` skill manifest entry

**Files:**
- Modify: `plugins/agentbook-core/backend/src/built-in-skills.ts` (append one entry before the final `general-question` entry — the sanctioned, additive way to register a skill per this repo's own convention: only a new array entry, no existing entry touched)
- Test: `plugins/agentbook-core/backend/src/__tests__/built-in-skills.test.ts` (new file — none existed before)

**Interfaces:**
- Consumes: nothing new — matches the existing `BUILT_IN_SKILLS` array shape exactly (`name`, `description`, `category`, `triggerPatterns`, `parameters`, `endpoint`).
- Produces: one skill manifest object the agent brain can route to Task 2's `GET /api/v1/agentbook-startup/recommendations` — actual DB seeding happens later via the existing `POST /agent/seed-skills` endpoint in a real environment, not as part of this plan (no code change needed there — it already iterates `BUILT_IN_SKILLS` generically).

- [ ] **Step 1: Write the failing test**

Create `plugins/agentbook-core/backend/src/__tests__/built-in-skills.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { BUILT_IN_SKILLS } from '../built-in-skills.js';

describe('BUILT_IN_SKILLS — us-rd-credit-finder', () => {
  it('is registered with an HTTP endpoint pointing at the startup plugin', () => {
    const skill = BUILT_IN_SKILLS.find((s) => s.name === 'us-rd-credit-finder');
    expect(skill).toBeDefined();
    expect(skill?.endpoint).toEqual({ method: 'GET', url: '/api/v1/agentbook-startup/recommendations' });
  });

  it('triggers on common R&D-credit and startup-tax-benefit phrasing', () => {
    const skill = BUILT_IN_SKILLS.find((s) => s.name === 'us-rd-credit-finder')!;
    const patterns = skill.triggerPatterns.map((p) => new RegExp(p, 'i'));
    for (const phrase of ['do we qualify for the r&d credit', 'startup tax benefits', 'qsbs eligibility', 'delaware franchise tax']) {
      expect(patterns.some((re) => re.test(phrase))).toBe(true);
    }
  });

  it('is registered before the general-question fallback', () => {
    const names = BUILT_IN_SKILLS.map((s) => s.name);
    expect(names.indexOf('us-rd-credit-finder')).toBeLessThan(names.indexOf('general-question'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/built-in-skills.test.ts`
Expected: FAIL — first assertion fails (`skill` is `undefined`).

- [ ] **Step 3: Add the skill entry**

In `plugins/agentbook-core/backend/src/built-in-skills.ts`, insert immediately before the `general-question` entry:
```ts
  {
    name: 'us-rd-credit-finder',
    description: 'Check whether the business likely qualifies for the US federal R&D tax credit, QSBS eligibility tracking, or Delaware franchise tax optimization, with an estimated dollar range',
    category: 'tax_benefits',
    triggerPatterns: ['r&d credit', 'r and d credit', 'research credit', 'research and development credit', 'startup tax benefit', 'qsbs', 'franchise tax'],
    parameters: {},
    endpoint: { method: 'GET', url: '/api/v1/agentbook-startup/recommendations' },
    responseTemplate: 'Based on your company profile, here is what you may qualify for: {{programs}}',
  },
  {
    name: 'general-question', description: 'Answer any general financial or accounting question', category: 'finance',
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/built-in-skills.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 5: Run the full agentbook-core backend suite to confirm no regressions**

Run: `cd plugins/agentbook-core/backend && npx vitest run`
Expected: all pre-existing tests still pass (this change only appends one array entry — nothing else in the file changed).

- [ ] **Step 6: Commit**

```bash
git add plugins/agentbook-core/backend/src/built-in-skills.ts plugins/agentbook-core/backend/src/__tests__/built-in-skills.test.ts
git commit -m "feat(startup): register us-rd-credit-finder skill manifest entry"
```

---

## Task 4: Frontend scaffold — package config, UMD entry, routing shell

**Files:**
- Modify: `plugins/agentbook-startup/plugin.json` (add the `frontend` key — the plugin goes from dark to discoverable/routable in this task)
- Create: `plugins/agentbook-startup/frontend/package.json`
- Create: `plugins/agentbook-startup/frontend/tsconfig.json`
- Create: `plugins/agentbook-startup/frontend/vite.config.ts`
- Create: `plugins/agentbook-startup/frontend/vitest.config.ts`
- Create: `plugins/agentbook-startup/frontend/tailwind.config.js`
- Create: `plugins/agentbook-startup/frontend/index.html`
- Create: `plugins/agentbook-startup/frontend/src/globals.css`
- Create: `plugins/agentbook-startup/frontend/src/mount.tsx`
- Create: `plugins/agentbook-startup/frontend/src/App.tsx`

**Interfaces:**
- Produces: a buildable, mountable plugin frontend shell with one route (`/`) that Task 5's `StartupDiscoveryPage` fills in. `App.tsx`'s `plugin` export is what `mount.tsx` re-exports as the UMD global `NaapPluginAgentbookStartup`.

- [ ] **Step 1: Add the `frontend` key to `plugin.json`**

In `plugins/agentbook-startup/plugin.json`, add (after `"backend": {...}`, before `"integrations"`):
```json
  "frontend": {
    "entry": "./frontend/dist/production/agentbook-startup.js",
    "devPort": 3055,
    "routes": [
      "/agentbook/startup",
      "/agentbook/startup/*"
    ],
    "navigation": {
      "label": "Startup Tax Benefits",
      "icon": "Rocket",
      "order": 20,
      "group": "finance"
    }
  },
```

- [ ] **Step 2: Write the frontend `package.json`**

Create `plugins/agentbook-startup/frontend/package.json`:
```json
{
  "name": "@naap/plugin-agentbook-startup-frontend",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --port 3055",
    "build": "vite build --mode production",
    "test": "vitest run"
  },
  "dependencies": {
    "@naap/plugin-sdk": "*",
    "@naap/plugin-build": "*",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.0.0"
  },
  "devDependencies": {
    "@testing-library/react": "^16.0.0",
    "@testing-library/jest-dom": "^6.5.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "happy-dom": "^15.0.0",
    "typescript": "^5.5.0",
    "vite": "^7.0.0",
    "vitest": "^4.0.0"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json` (editor support only — not part of the build)**

Create `plugins/agentbook-startup/frontend/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: Write `vite.config.ts`**

Create `plugins/agentbook-startup/frontend/vite.config.ts`:
```ts
import { createPluginConfig } from '@naap/plugin-build/vite';

export default createPluginConfig({
  name: 'agentbook-startup',
  displayName: 'Startup Tax Benefits',
  globalName: 'NaapPluginAgentbookStartup',
  defaultCategory: 'finance',
});
```

- [ ] **Step 5: Write `vitest.config.ts`**

Create `plugins/agentbook-startup/frontend/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // @ts-expect-error - vitest/vite version mismatch
  plugins: [react()],
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
  },
});
```

- [ ] **Step 6: Write `tailwind.config.js`**

Create `plugins/agentbook-startup/frontend/tailwind.config.js`:
```js
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const typography = require('@tailwindcss/typography');
const forms = require('@tailwindcss/forms');
import tailwindExtend from '../../../packages/theme/tailwind-extend.cjs';

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    '../../../packages/ui/src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: tailwindExtend,
  },
  plugins: [typography, forms],
};
```

- [ ] **Step 7: Write `index.html`**

Create `plugins/agentbook-startup/frontend/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Startup Tax Benefits - AgentBook</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Note: this references `src/main.tsx`, a standalone dev-mode entry, which is not needed for this plan's browser verification (Task 6 verifies through the full shell, not Vite's own dev server) and is not built as part of the UMD bundle (`mount.tsx` is). Skip creating `main.tsx` — it's a dev convenience other plugins have for isolated component work, not a requirement.

- [ ] **Step 8: Write `src/globals.css`**

Create `plugins/agentbook-startup/frontend/src/globals.css`:
```css
@import '../../../../packages/theme/src/shell-variables.css';

@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  font-family: 'Inter', system-ui, sans-serif;
  background-color: hsl(var(--background));
  color: hsl(var(--foreground));
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
```

- [ ] **Step 9: Write `src/App.tsx`**

Create `plugins/agentbook-startup/frontend/src/App.tsx`:
```tsx
import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { createPlugin } from '@naap/plugin-sdk';
import { StartupDiscoveryPage } from './pages/StartupDiscoveryPage';
import './globals.css';

function getInitialPath(): string {
  if (typeof window === 'undefined') return '/';
  const path = window.location.pathname.replace(/^\/agentbook\/startup/, '') || '/';
  return path === '' ? '/' : path;
}

const AgentbookStartupApp: React.FC = () => (
  <MemoryRouter initialEntries={[getInitialPath()]}>
    <Routes>
      <Route path="/*" element={<StartupDiscoveryPage />} />
    </Routes>
  </MemoryRouter>
);

const plugin = createPlugin({
  name: 'agentbook-startup',
  version: '1.0.0',
  routes: ['/agentbook/startup', '/agentbook/startup/*'],
  App: AgentbookStartupApp,
});

export const mount = plugin.mount;
export const unmount = plugin.unmount;
export default plugin;
```

This references `./pages/StartupDiscoveryPage` which Task 5 creates — this task's own build/test verification happens together with Task 5's (a router with no page component isn't independently useful to verify).

- [ ] **Step 10: Write `src/mount.tsx`**

Create `plugins/agentbook-startup/frontend/src/mount.tsx`:
```tsx
import plugin from './App';

const PLUGIN_GLOBAL_NAME = 'NaapPluginAgentbookStartup';

export const mount = plugin.mount;
export const unmount = plugin.unmount;
export const metadata = (plugin as { metadata?: unknown }).metadata ?? { name: 'agentbook-startup', version: '1.0.0' };

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>)[PLUGIN_GLOBAL_NAME] = {
    mount, unmount, metadata,
  };
}

export default { mount, unmount, metadata };
```

This task has no standalone commit — its files don't build without Task 5's page component (App.tsx imports it). Commit happens at the end of Task 5.

---

## Task 5: `StartupDiscoveryPage` — intake form, recommendations, pricing teaser

**Files:**
- Create: `plugins/agentbook-startup/frontend/src/lib/api.ts`
- Create: `plugins/agentbook-startup/frontend/src/pages/StartupDiscoveryPage.tsx`
- Test: `plugins/agentbook-startup/frontend/src/__tests__/StartupDiscoveryPage.test.tsx`

**Interfaces:**
- Consumes: Task 2's 3 backend routes; PR 7.2's `GET /api/v1/agentbook-billing/me/addons` (for the price teaser only — read-only, no purchase action wired).
- Produces: the page component `App.tsx` (Task 4) routes to.

- [ ] **Step 1: Write the API client module**

Create `plugins/agentbook-startup/frontend/src/lib/api.ts`:
```ts
export interface StartupBenefitProfile {
  tenantId: string;
  companyType: string | null;
  incorporatedAt: string | null;
  headcount: number | null;
  annualRdSpendCents: number | null;
  equityRaisedCents: number | null;
}

export interface ProfileInput {
  companyType?: string;
  incorporatedAt?: string;
  headcount?: number;
  annualRdSpendCents?: number;
  equityRaisedCents?: number;
}

export interface ProgramRecommendation {
  programCode: string;
  name: string;
  authority: string;
  sourceUrl: string;
  status: string;
  confidence: number;
  reasoning: string;
  estValueLowCents: number | null;
  estValueHighCents: number | null;
}

export interface RecommendationsResponse {
  jurisdiction: string;
  programs: ProgramRecommendation[];
  message?: string;
}

export interface AddOnPriceTeaser {
  active: boolean;
  price: { tier: string; priceCents: number; currency: string } | null;
}

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

export const startupApi = {
  getProfile: async (): Promise<StartupBenefitProfile | null> =>
    (await json<{ profile: StartupBenefitProfile | null }>(await fetch('/api/v1/agentbook-startup/profile'))).profile,
  saveProfile: async (input: ProfileInput): Promise<StartupBenefitProfile> =>
    (await json<{ profile: StartupBenefitProfile }>(await fetch('/api/v1/agentbook-startup/profile', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    }))).profile,
  getRecommendations: async (): Promise<RecommendationsResponse> =>
    json<RecommendationsResponse>(await fetch('/api/v1/agentbook-startup/recommendations')),
  getAddOnTeaser: async (): Promise<AddOnPriceTeaser> =>
    json<AddOnPriceTeaser>(await fetch('/api/v1/agentbook-billing/me/addons?code=startup_tax_benefits&region=us')),
};

export function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString()}`;
}
```

- [ ] **Step 2: Write the failing component test**

Create `plugins/agentbook-startup/frontend/src/__tests__/StartupDiscoveryPage.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { StartupDiscoveryPage } from '../pages/StartupDiscoveryPage';

const getProfile = vi.fn();
const saveProfile = vi.fn();
const getRecommendations = vi.fn();
const getAddOnTeaser = vi.fn();

vi.mock('../lib/api', () => ({
  startupApi: {
    getProfile: () => getProfile(),
    saveProfile: (input: unknown) => saveProfile(input),
    getRecommendations: () => getRecommendations(),
    getAddOnTeaser: () => getAddOnTeaser(),
  },
  formatCents: (cents: number) => `$${(cents / 100).toLocaleString()}`,
}));

beforeEach(() => {
  getProfile.mockReset(); saveProfile.mockReset(); getRecommendations.mockReset(); getAddOnTeaser.mockReset();
  getProfile.mockResolvedValue(null);
  getAddOnTeaser.mockResolvedValue({ active: false, price: { tier: 'founding_member', priceCents: 9900, currency: 'usd' } });
});

describe('StartupDiscoveryPage', () => {
  it('renders the intake form when no profile is saved yet', async () => {
    render(<StartupDiscoveryPage />);
    await waitFor(() => expect(getProfile).toHaveBeenCalled());
    expect(screen.getByLabelText(/company type/i)).toBeTruthy();
    expect(screen.getByLabelText(/annual r&d spend/i)).toBeTruthy();
  });

  it('saves the profile and shows recommendations on submit', async () => {
    saveProfile.mockResolvedValue({ tenantId: 't1', companyType: 'c_corp', incorporatedAt: null, headcount: 4, annualRdSpendCents: 40_000_000, equityRaisedCents: null });
    getRecommendations.mockResolvedValue({
      jurisdiction: 'us',
      programs: [{
        programCode: 'us_rd_credit_41', name: 'Federal R&D Tax Credit (IRC §41)', authority: 'IRS',
        sourceUrl: 'https://www.irs.gov/forms-pubs/about-form-6765', status: 'qualified', confidence: 0.75,
        reasoning: 'Likely qualifies under the four-part test.', estValueLowCents: 4_000_000, estValueHighCents: 8_000_000,
      }],
    });
    render(<StartupDiscoveryPage />);
    await waitFor(() => expect(getProfile).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/company type/i), { target: { value: 'c_corp' } });
    fireEvent.change(screen.getByLabelText(/headcount/i), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText(/annual r&d spend/i), { target: { value: '400000' } });
    fireEvent.click(screen.getByRole('button', { name: /see what i qualify for/i }));

    await waitFor(() => expect(saveProfile).toHaveBeenCalledWith(expect.objectContaining({ companyType: 'c_corp', headcount: 4, annualRdSpendCents: 40_000_000 })));
    await waitFor(() => expect(screen.getByText('Federal R&D Tax Credit (IRC §41)')).toBeTruthy());
    expect(screen.getByText(/\$40,000 – \$80,000/)).toBeTruthy();
    expect(screen.getByText(/qualified/i)).toBeTruthy();
  });

  it('shows the jurisdiction-unsupported message when the backend returns one', async () => {
    saveProfile.mockResolvedValue({ tenantId: 't1', companyType: null, incorporatedAt: null, headcount: null, annualRdSpendCents: null, equityRaisedCents: null });
    getRecommendations.mockResolvedValue({ jurisdiction: 'ca', programs: [], message: 'Startup tax benefits are not yet available for your jurisdiction.' });
    render(<StartupDiscoveryPage />);
    await waitFor(() => expect(getProfile).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /see what i qualify for/i }));
    await waitFor(() => expect(screen.getByText(/not yet available for your jurisdiction/i)).toBeTruthy());
  });

  it('shows the founding-member price teaser without a purchase button', async () => {
    render(<StartupDiscoveryPage />);
    await waitFor(() => expect(getAddOnTeaser).toHaveBeenCalled());
    expect(screen.getByText(/\$99/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /subscribe|buy|purchase/i })).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd plugins/agentbook-startup/frontend && npx vitest run src/__tests__/StartupDiscoveryPage.test.tsx`
Expected: FAIL — `Cannot find module '../pages/StartupDiscoveryPage'`.

- [ ] **Step 4: Implement the page component**

Create `plugins/agentbook-startup/frontend/src/pages/StartupDiscoveryPage.tsx`:
```tsx
import React, { useEffect, useState } from 'react';
import { startupApi, formatCents, type ProgramRecommendation, type AddOnPriceTeaser } from '../lib/api';

const STATUS_LABEL: Record<string, string> = {
  qualified: 'Qualified',
  possibly_qualified: 'Possibly qualified',
  not_qualified: 'Not qualified yet',
};

function ProgramCard({ program }: { program: ProgramRecommendation }) {
  const range = program.estValueLowCents !== null && program.estValueHighCents !== null
    ? `${formatCents(program.estValueLowCents)} – ${formatCents(program.estValueHighCents)}`
    : null;
  return (
    <div className="glass-card p-4 mb-3 border">
      <div className="flex justify-between items-baseline">
        <h3 className="font-semibold">{program.name}</h3>
        <span className="text-sm">{STATUS_LABEL[program.status] ?? program.status}</span>
      </div>
      <p className="text-sm text-gray-600">{program.authority}</p>
      {range && <p className="text-sm font-medium">{range}</p>}
      <p className="text-sm mt-1">{program.reasoning}</p>
      {program.sourceUrl && (
        <a href={program.sourceUrl} target="_blank" rel="noreferrer" className="text-sm underline">
          Learn more
        </a>
      )}
    </div>
  );
}

export function StartupDiscoveryPage() {
  const [companyType, setCompanyType] = useState('');
  const [headcount, setHeadcount] = useState('');
  const [annualRdSpend, setAnnualRdSpend] = useState('');
  const [equityRaised, setEquityRaised] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ programs: ProgramRecommendation[]; message?: string } | null>(null);
  const [teaser, setTeaser] = useState<AddOnPriceTeaser | null>(null);

  useEffect(() => {
    startupApi.getProfile().then((profile) => {
      if (!profile) return;
      setCompanyType(profile.companyType ?? '');
      setHeadcount(profile.headcount != null ? String(profile.headcount) : '');
      setAnnualRdSpend(profile.annualRdSpendCents != null ? String(profile.annualRdSpendCents / 100) : '');
      setEquityRaised(profile.equityRaisedCents != null ? String(profile.equityRaisedCents / 100) : '');
    });
    startupApi.getAddOnTeaser().then(setTeaser).catch(() => setTeaser(null));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await startupApi.saveProfile({
        companyType: companyType || undefined,
        headcount: headcount ? Number(headcount) : undefined,
        annualRdSpendCents: annualRdSpend ? Math.round(Number(annualRdSpend) * 100) : undefined,
        equityRaisedCents: equityRaised ? Math.round(Number(equityRaised) * 100) : undefined,
      });
      const recs = await startupApi.getRecommendations();
      setResult(recs);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Startup Tax Benefits</h1>
      <p className="text-sm text-gray-600 mb-4">
        Answer a few questions about your company to see what government tax-benefit programs you likely qualify for — free, no commitment.
      </p>

      <form onSubmit={handleSubmit} className="space-y-3 mb-6">
        <div>
          <label htmlFor="companyType">Company type</label>
          <select id="companyType" value={companyType} onChange={(e) => setCompanyType(e.target.value)}>
            <option value="">Select...</option>
            <option value="c_corp">C-corp</option>
            <option value="llc">LLC</option>
            <option value="ccpc">CCPC (Canada)</option>
            <option value="ltd">Ltd (UK)</option>
          </select>
        </div>
        <div>
          <label htmlFor="headcount">Headcount</label>
          <input id="headcount" type="number" value={headcount} onChange={(e) => setHeadcount(e.target.value)} />
        </div>
        <div>
          <label htmlFor="annualRdSpend">Annual R&D spend ($)</label>
          <input id="annualRdSpend" type="number" value={annualRdSpend} onChange={(e) => setAnnualRdSpend(e.target.value)} />
        </div>
        <div>
          <label htmlFor="equityRaised">Equity raised ($)</label>
          <input id="equityRaised" type="number" value={equityRaised} onChange={(e) => setEquityRaised(e.target.value)} />
        </div>
        <button type="submit" disabled={loading}>
          {loading ? 'Checking…' : 'See what I qualify for'}
        </button>
      </form>

      {result?.message && <p className="text-sm text-amber-700">{result.message}</p>}
      {result?.programs.map((program) => <ProgramCard key={program.programCode} program={program} />)}

      {teaser?.price && !teaser.active && (
        <p className="text-sm text-gray-500 mt-6 border-t pt-4">
          Ready to draft an application? Startup Tax Benefits starts at {formatCents(teaser.price.priceCents)}/year.
        </p>
      )}
    </div>
  );
}
```

Note: this deliberately renders the price teaser as plain text, not a `<button>` — the test in Step 2 explicitly asserts no purchase button exists yet.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd plugins/agentbook-startup/frontend && npx vitest run src/__tests__/StartupDiscoveryPage.test.tsx`
Expected: all 4 tests PASS. If the dollar-range text assertion fails, check the em-dash character in the test (`–`, U+2013) matches exactly what `formatCents` interpolation produces in the component's template string (`${formatCents(...)} – ${formatCents(...)}`).

- [ ] **Step 6: Install dependencies and run the full frontend suite**

```bash
npm install
cd plugins/agentbook-startup/frontend && npx vitest run
```
Expected: all tests pass (4 from this task).

- [ ] **Step 7: Commit**

```bash
git add plugins/agentbook-startup/plugin.json plugins/agentbook-startup/frontend package-lock.json
git commit -m "feat(startup): add discovery intake form + recommendations frontend"
```

---

## Task 6: Build the bundle, sync the registry, verify in a real browser

**Files:**
- Create (build output, committed per this repo's convention): `apps/web-next/public/cdn/plugins/agentbook-startup/agentbook-startup.js` and `apps/web-next/public/cdn/plugins/agentbook-startup/1.0.0/agentbook-startup.js` (+ any `.css`/`manifest.json` the build produces alongside)

**Interfaces:** none — this task builds and verifies Tasks 1–5's output end-to-end; it does not introduce new application code.

- [ ] **Step 1: Build the production UMD bundle**

```bash
cd plugins/agentbook-startup/frontend && npm run build
```
Expected: `dist/production/agentbook-startup.js` created, console prints `✅ Validated: no bundled React internals`.

- [ ] **Step 2: Copy the bundle to the CDN path (both the unversioned and versioned location, matching every other plugin)**

```bash
mkdir -p apps/web-next/public/cdn/plugins/agentbook-startup/1.0.0
cp plugins/agentbook-startup/frontend/dist/production/agentbook-startup.js apps/web-next/public/cdn/plugins/agentbook-startup/agentbook-startup.js
cp plugins/agentbook-startup/frontend/dist/production/agentbook-startup.js apps/web-next/public/cdn/plugins/agentbook-startup/1.0.0/agentbook-startup.js
# If a .css file was produced:
if [ -f plugins/agentbook-startup/frontend/dist/production/*.css ]; then
  cp plugins/agentbook-startup/frontend/dist/production/*.css apps/web-next/public/cdn/plugins/agentbook-startup/1.0.0/
fi
```

- [ ] **Step 3: Seed a full local environment against the isolated verification DB**

Reuse `naap_pr73_verify` from Task 2 (or recreate it if it was dropped):
```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap_pr73_verify" \
DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap_pr73_verify" \
npx tsx agentbook/seed-users.ts
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap_pr73_verify" \
DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap_pr73_verify" \
npx tsx agentbook/seed-personas.ts
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap_pr73_verify" \
DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap_pr73_verify" \
npx tsx bin/sync-plugin-registry.ts
```
Expected: `sync-plugin-registry` now reports `agentbook-startup` with **non-empty** routes (`/agentbook/startup`, `/agentbook/startup/*`) — this is the moment the plugin stops being dark, since Task 4 added the `frontend` key.

- [ ] **Step 4: Start all 4 existing backends + the new one, plus the frontend, against the isolated DB**

Run each in the background (5 separate processes):
```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap_pr73_verify" DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap_pr73_verify" PORT=4050 npx tsx plugins/agentbook-core/backend/src/server.ts &
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap_pr73_verify" DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap_pr73_verify" PLAID_CLIENT_ID="69d02fa4f1949b000dbfc51e" PLAID_SECRET="59be40029c47288c4db4acfd79ae56" PLAID_ENV="sandbox" PORT=4051 npx tsx plugins/agentbook-expense/backend/src/server.ts &
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap_pr73_verify" DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap_pr73_verify" PORT=4052 npx tsx plugins/agentbook-invoice/backend/src/server.ts &
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap_pr73_verify" DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap_pr73_verify" PORT=4053 npx tsx plugins/agentbook-tax/backend/src/server.ts &
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap_pr73_verify" DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap_pr73_verify" PORT=4054 npx tsx plugins/agentbook-startup/backend/src/server.ts &
```
Then start the Next.js frontend using the Preview tool's launch config (`mcp__Claude_Preview__preview_start`), pointed at the same `DATABASE_URL`/`DATABASE_URL_UNPOOLED` env vars, with `NODE_OPTIONS="--max-old-space-size=4096"`.

- [ ] **Step 5: Log in and navigate to the discovery page in a real browser**

Use the Preview tools: navigate to the login page, sign in as `maya@agentbook.test` / `agentbook123`, then navigate to `/agentbook/startup`. Use `preview_snapshot` to confirm the intake form renders (company type select, headcount/R&D-spend/equity inputs, "See what I qualify for" button), fill in `companyType=c_corp`, `headcount=4`, `annualRdSpend=400000`, click submit, and use `preview_snapshot`/`preview_screenshot` again to confirm 3 program cards render with the R&D credit showing a `$40,000` `$80,000`-range and "Qualified" status. Check `preview_console_logs` for any errors and `preview_network` for any failed (4xx/5xx) requests to `/api/v1/agentbook-startup/*`.

- [ ] **Step 6: Stop all backends and the frontend**

Kill the 5 background `tsx` processes and stop the Preview server.

- [ ] **Step 7: Commit the CDN bundle**

```bash
git add apps/web-next/public/cdn/plugins/agentbook-startup
git commit -m "build(startup): commit agentbook-startup UMD bundle to CDN"
```

---

## Task 7: Full verification pass

**Files:** none — verification only.

- [ ] **Step 1: Run every test suite touched by this PR**

```bash
cd plugins/agentbook-startup/backend && npx vitest run
cd ../../../plugins/agentbook-startup/frontend && npx vitest run
cd ../../agentbook-core/backend && npx vitest run
```
Expected: all pass.

- [ ] **Step 2: Drop the isolated verification database**

```bash
docker exec naap-db psql -U postgres -c "DROP DATABASE naap_pr73_verify;"
```

- [ ] **Step 3: Confirm the shared `naap` DB was never touched by this plan**

```bash
docker exec naap-db psql -U postgres -d naap -c "\dt plugin_agentbook_startup.*"
```
Expected: unchanged from before this plan started (only PR #199's original 7 tables, no new ones — this plan added no new Prisma models).

- [ ] **Step 4: Review the diff against origin/main**

```bash
git diff origin/main --stat
```
Expected: PR #199's and PR #200's files (already merged in), plus this plan's additions — `plugins/agentbook-startup/backend/src/{discovery.ts,server.ts,package.json,__tests__/discovery.test.ts}`, `plugins/agentbook-core/backend/src/{built-in-skills.ts,__tests__/built-in-skills.test.ts}`, `plugins/agentbook-startup/plugin.json`, `plugins/agentbook-startup/frontend/**`, `apps/web-next/public/cdn/plugins/agentbook-startup/**`. Nothing under any other plugin's `src/` beyond the single `built-in-skills.ts` append.

This task has no commit step — pure verification.
