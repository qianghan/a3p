# Startup Tax Benefits — PR 7.1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the foundation for the `agentbook-startup` plugin (5th AgentBook plugin, roadmap Phase 7) — plugin scaffold, 7 new Prisma models, and a `TaxBenefitProvider` jurisdiction interface with a real US implementation — with zero UI and zero billing gate, safe to merge and deploy dark.

**Architecture:** New sibling plugin directory (`plugins/agentbook-startup/`) with an empty Express backend registered via the existing `plugin.json` auto-discovery mechanism (`bin/sync-plugin-registry.ts`) — no code in any other plugin touched. New Prisma models live in a new `plugin_agentbook_startup` schema, additive to the datasource. Jurisdiction generalization goes through one new optional field (`taxBenefits`) on the existing `JurisdictionPack` interface, implemented only for `us/` in this PR; `ca`/`uk`/`au` packs are untouched (their turn is PR 7.7/7.8, out of scope here).

**Tech Stack:** TypeScript, Express (via `@naap/plugin-server-sdk`), Prisma (PostgreSQL, `multiSchema` preview), Vitest.

## Global Constraints

- Source of truth: `startup.html` §8 (Architecture) and §10 (PR 7.1 card). Do not diverge without calling it out.
- Additive only: no existing plugin backend, no existing Prisma model, no existing skill row may be modified.
- PR 7.1 scope is exactly: plugin scaffold (plugin.json + empty backend), 7 Prisma models, `TaxBenefitProvider` interface + US implementation, 3-program US catalog seed. No UI, no billing gate, no HTTP routes beyond the framework default `/healthz`.
- Naming: Prisma models use the literal `StartupBenefit*` names from §8.3 (not the `Ab*` prefix convention used by the other 4 plugins — the design's §8.2 callout deliberately reserves `Ab*`/plugin-prefix-free naming for this plugin's own concrete models, vs. `TaxBenefit*` for the reusable jurisdiction-interface layer).
- Dev port 4054 / prod-internal port 4154 (next free slot after 4050–4053, following the existing `devPort + 100 = port` convention).
- API prefix `/api/v1/agentbook-startup`.
- All money fields are integer cents, matching every other plugin.
- Local verification only — the local docker Postgres (`postgresql://postgres:postgres@localhost:5432/naap`) is used for `prisma db push`/tests. **Never** touch Supabase/Neon prod credentials in this plan; no step here deploys or touches production.

## Known deviation from the design doc's literal file list

§10's PR 7.1 card says "Touches (additive-only): `agentbook-jurisdictions/src/interfaces.ts`, `us/index.ts`". In the actual codebase, the `JurisdictionPack` interface (the thing that needs the new `taxBenefits` field) is defined in `packages/agentbook-jurisdictions/src/loader.ts`, not `interfaces.ts` — `interfaces.ts` holds only the individual trait-provider interfaces (`TaxBracketProvider`, `SalesTaxEngine`, etc.). This plan adds `TaxBenefitProvider` (and its supporting types) to `interfaces.ts` as the design shows, but adds the `taxBenefits?` field to `JurisdictionPack` in `loader.ts`. Net effect and blast radius are identical to what the design intends — this is a file-location correction, not a scope change.

---

## Task 1: Prisma schema — 7 new models + new schema namespace

**Files:**
- Modify: `packages/database/prisma/schema.prisma` (datasource `schemas` array + new model block)
- Modify: `docker/init-schemas.sql` (add `CREATE SCHEMA IF NOT EXISTS plugin_agentbook_startup;` for documentation/first-boot parity with the other schemas already listed there)

**Interfaces:**
- Produces: 7 Prisma models — `StartupBenefitProfile`, `StartupBenefitProgram`, `StartupBenefitEligibilityAssessment`, `StartupBenefitApplication`, `StartupBenefitDocument`, `StartupBenefitDecisionPoint`, `StartupBenefitAuditReview` — all in schema `plugin_agentbook_startup`. Later tasks (2, 5, 6) read/write these via the generated `@naap/database` Prisma client (e.g. `db.startupBenefitProgram`).

- [ ] **Step 1: Add the new schema name to the datasource block**

In `packages/database/prisma/schema.prisma`, find:
```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DATABASE_URL_UNPOOLED")
  schemas   = ["public", "plugin_community", "plugin_service_gateway", "plugin_agentbook_core", "plugin_agentbook_expense", "plugin_agentbook_invoice", "plugin_agentbook_tax", "plugin_agentbook_billing", "plugin_agentbook_personal", "plugin_agentbook_cpa", "plugin_agentbook_payroll"]
}
```
Append `"plugin_agentbook_startup"` to the end of the `schemas` array (keep every existing entry unchanged).

- [ ] **Step 2: Append the 7 new models at the end of the file**

Add this block at the end of `packages/database/prisma/schema.prisma`:

```prisma
// ============================================
// AGENTBOOK STARTUP TAX BENEFITS PLUGIN
// Discover/draft/audit/track government tax-benefit programs for startups.
// See startup.html §8.3 for the full design.
// ============================================

model StartupBenefitProfile {
  tenantId           String    @id
  addOnStatus        String    @default("trial_discovery") // trial_discovery | active | canceled
  companyType        String?   // c_corp | ccpc | ltd | llc ...
  incorporatedAt     DateTime?
  headcount          Int?
  annualRdSpendCents Int?
  equityRaisedCents  Int?
  lastAssessedAt     DateTime?

  @@schema("plugin_agentbook_startup")
}

model StartupBenefitProgram {
  id                    String   @id @default(uuid())
  jurisdiction          String   // "us" | "ca" | "uk"
  programCode           String   // "us_rd_credit_41" | "ca_sred" | "uk_seis" ...
  name                  String
  authority             String   // "IRS" | "CRA" | "HMRC"
  typicalValueLowCents  Int?
  typicalValueHighCents Int?
  eligibilityCriteria   Json
  requiredDocuments     Json
  sourceUrl             String
  lastVerifiedAt        DateTime
  enabled               Boolean  @default(true)

  @@unique([jurisdiction, programCode])
  @@schema("plugin_agentbook_startup")
}

model StartupBenefitEligibilityAssessment {
  id                String   @id @default(uuid())
  tenantId          String
  programId         String
  status            String   // not_qualified | possibly_qualified | qualified
  confidence        Float
  reasoning         String
  estValueLowCents  Int?
  estValueHighCents Int?
  assessedAt        DateTime @default(now())

  @@index([tenantId, programId])
  @@schema("plugin_agentbook_startup")
}

model StartupBenefitApplication {
  id              String    @id @default(uuid())
  tenantId        String
  programId       String
  status          String    // recommended|docs_pending|drafting|decision_pending|
                             // ready_for_review|audit_reviewed|submitted|monitoring|closed
  draft           Json      // structured, provenance-tagged draft content
  auditRiskLevel  String?   // low | medium | high
  submittedAt     DateTime?
  confirmationRef String?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@index([tenantId, status])
  @@schema("plugin_agentbook_startup")
}

model StartupBenefitDocument {
  id            String   @id @default(uuid())
  applicationId String
  docType       String
  blobUrl       String
  extractedData Json?
  status        String   @default("uploaded") // requested|uploaded|verified|rejected
  uploadedAt    DateTime @default(now())

  @@index([applicationId])
  @@schema("plugin_agentbook_startup")
}

model StartupBenefitDecisionPoint {
  id             String    @id @default(uuid())
  applicationId  String
  sequenceOrder  Int
  kind           String    // approval | key_input
  prompt         String
  options        Json?
  response       Json?
  respondedAt    DateTime?
  blocksProgress Boolean   @default(true)

  @@index([applicationId, sequenceOrder])
  @@schema("plugin_agentbook_startup")
}

model StartupBenefitAuditReview {
  id            String   @id @default(uuid())
  applicationId String   @unique
  riskLevel     String   // low | medium | high
  findings      Json     // [{severity, issue, recommendation, ruleRef}]
  reviewedAt    DateTime @default(now())
  modelVersion  String

  @@schema("plugin_agentbook_startup")
}
```

Note: the design's §8.3 code sample omits `@@index` on a few models for brevity; this plan adds the obvious tenant/application-scoped indexes (`[tenantId, programId]`, `[applicationId]`, `[applicationId, sequenceOrder]`) since every other plugin model in this codebase indexes its tenant/parent lookup key and these tables will be queried that way starting in PR 7.3+.

- [ ] **Step 3: Add the new schema to the local docker init script**

In `docker/init-schemas.sql`, after the `CREATE SCHEMA IF NOT EXISTS plugin_agentbook_tax;` line, add:
```sql
CREATE SCHEMA IF NOT EXISTS plugin_agentbook_startup;
```

- [ ] **Step 4: Validate the schema syntax**

Run: `cd packages/database && npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid 🚀`

- [ ] **Step 5: Generate the Prisma client**

Run: `cd packages/database && npx prisma generate`
Expected: exits 0, prints "Generated Prisma Client" pointing at `src/generated/client`.

- [ ] **Step 6: Push the schema to the local docker Postgres and confirm the tables exist**

Run:
```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" \
DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap" \
npx --no prisma db push --skip-generate --schema packages/database/prisma/schema.prisma
```
Expected: "Your database is now in sync with your Prisma schema." — no `--accept-data-loss` prompt (this is a purely additive change).

Then confirm:
```bash
docker exec naap-db psql -U postgres -d naap -c "\dt plugin_agentbook_startup.*"
```
Expected: 7 rows listing `StartupBenefitProfile`, `StartupBenefitProgram`, `StartupBenefitEligibilityAssessment`, `StartupBenefitApplication`, `StartupBenefitDocument`, `StartupBenefitDecisionPoint`, `StartupBenefitAuditReview`.

- [ ] **Step 7: Commit**

```bash
git add packages/database/prisma/schema.prisma docker/init-schemas.sql
git commit -m "feat(startup): add 7 Prisma models for agentbook-startup plugin"
```

---

## Task 2: `TaxBenefitProvider` interface + supporting types

**Files:**
- Modify: `packages/agentbook-jurisdictions/src/interfaces.ts` (append new interface block)
- Modify: `packages/agentbook-jurisdictions/src/loader.ts` (add optional `taxBenefits?` field to `JurisdictionPack`)
- Modify: `packages/agentbook-jurisdictions/src/index.ts` (export the new types from the barrel)

**Interfaces:**
- Produces: `TaxBenefitProvider` and its supporting types (`StartupProfile`, `TaxBenefitProgramSummary`, `EligibilityAssessment`, `DocumentRequirement`, `ApplicationInputs`, `DraftField`, `DraftResult`, `DecisionPoint`, `AuditFinding`, `AuditRiskAssessment`, `SubmissionInstructions`, `Deadline`) — consumed by Task 3's `usTaxBenefits` implementation and by every later PR (7.3+) that builds the actual workflow.

- [ ] **Step 1: Append the interface block to `interfaces.ts`**

Add to the end of `packages/agentbook-jurisdictions/src/interfaces.ts`:

```ts
// ─── Startup Tax Benefits ────────────────────────────────────────────────────
// Jurisdiction-agnostic contract for the agentbook-startup plugin's 5-phase
// workflow (recommend → collect → draft → review → submit). One implementation
// per jurisdiction pack. See startup.html §8.2.

export interface StartupProfile {
  companyType?: string; // 'c_corp' | 'ccpc' | 'ltd' | 'llc' | ...
  incorporatedAt?: Date;
  headcount?: number;
  annualRdSpendCents?: number;
  equityRaisedCents?: number;
}

export interface TaxBenefitProgramSummary {
  programCode: string;
  name: string;
  authority: string;
  typicalValueLowCents: number | null;
  typicalValueHighCents: number | null;
}

export interface EligibilityAssessment {
  status: 'not_qualified' | 'possibly_qualified' | 'qualified';
  confidence: number; // 0–1
  reasoning: string;
  estValueLowCents: number | null;
  estValueHighCents: number | null;
}

export interface DocumentRequirement {
  docType: string;
  label: string;
  description: string;
  required: boolean;
}

export interface ApplicationInputs {
  profile: StartupProfile;
  documents?: Record<string, unknown>;
  answers?: Record<string, unknown>;
}

export interface DraftField {
  label: string;
  value: string | number;
  sourceType: 'book_entry' | 'document' | 'user_input' | 'computed';
  sourceRef?: string;
}

export interface DraftResult {
  programCode: string;
  sections: Record<string, DraftField[]>;
  completeness: number; // 0–1: fraction of fields populated without a pending decision point
}

export interface DecisionPoint {
  sequenceOrder: number;
  kind: 'approval' | 'key_input';
  prompt: string;
  options?: string[];
}

export interface AuditFinding {
  severity: 'low' | 'medium' | 'high';
  issue: string;
  recommendation: string;
  ruleRef: string;
}

export interface AuditRiskAssessment {
  riskLevel: 'low' | 'medium' | 'high';
  findings: AuditFinding[];
}

export interface SubmissionInstructions {
  channel: 'mail' | 'portal' | 'cpa_handoff';
  summary: string;
  steps: string[];
}

export interface Deadline {
  label: string;
  date: Date;
  urgency: 'critical' | 'important' | 'informational';
}

export interface TaxBenefitProvider {
  listPrograms(profile: StartupProfile): TaxBenefitProgramSummary[];
  assessEligibility(programCode: string, profile: StartupProfile): EligibilityAssessment;
  getRequiredDocuments(programCode: string): DocumentRequirement[];
  draftApplication(programCode: string, inputs: ApplicationInputs): DraftResult;
  getDecisionPoints(programCode: string, draft: DraftResult): DecisionPoint[];
  assessAuditRisk(programCode: string, draft: DraftResult): AuditRiskAssessment;
  getSubmissionInstructions(programCode: string): SubmissionInstructions;
  getFilingDeadlines(programCode: string, fiscalYearEnd: Date): Deadline[];
}
```

- [ ] **Step 2: Add the optional field to `JurisdictionPack`**

In `packages/agentbook-jurisdictions/src/loader.ts`, change:
```ts
export interface JurisdictionPack {
  id: string;
  name: string;
  taxBrackets: import('./interfaces.js').TaxBracketProvider;
  selfEmploymentTax: import('./interfaces.js').SelfEmploymentTaxCalculator;
  salesTax: import('./interfaces.js').SalesTaxEngine;
  chartOfAccounts: import('./interfaces.js').ChartOfAccountsTemplate;
  installmentSchedule: import('./interfaces.js').InstallmentSchedule;
  contractorReport: import('./interfaces.js').ContractorReportGenerator;
  mileageRate: import('./interfaces.js').MileageRateProvider;
  deductions: import('./interfaces.js').DeductionRuleSet;
  calendarDeadlines: import('./interfaces.js').CalendarDeadlineProvider;
}
```
to (adding one optional line — `ca`/`uk`/`au` packs do not need to change since the field is optional):
```ts
export interface JurisdictionPack {
  id: string;
  name: string;
  taxBrackets: import('./interfaces.js').TaxBracketProvider;
  selfEmploymentTax: import('./interfaces.js').SelfEmploymentTaxCalculator;
  salesTax: import('./interfaces.js').SalesTaxEngine;
  chartOfAccounts: import('./interfaces.js').ChartOfAccountsTemplate;
  installmentSchedule: import('./interfaces.js').InstallmentSchedule;
  contractorReport: import('./interfaces.js').ContractorReportGenerator;
  mileageRate: import('./interfaces.js').MileageRateProvider;
  deductions: import('./interfaces.js').DeductionRuleSet;
  calendarDeadlines: import('./interfaces.js').CalendarDeadlineProvider;
  /** Optional — only jurisdictions with a shipped Startup Tax Benefits pack implement this (US in PR 7.1; CA/UK land in PR 7.7/7.8). */
  taxBenefits?: import('./interfaces.js').TaxBenefitProvider;
}
```

- [ ] **Step 3: Export the new types from the package barrel**

In `packages/agentbook-jurisdictions/src/index.ts`, add a new export line (after the existing `CalendarDeadlineProvider` export line):
```ts
export { type CalendarDeadlineProvider } from './interfaces.js';
export {
  type StartupProfile,
  type TaxBenefitProgramSummary,
  type EligibilityAssessment,
  type DocumentRequirement,
  type ApplicationInputs,
  type DraftField,
  type DraftResult,
  type DecisionPoint,
  type AuditFinding,
  type AuditRiskAssessment,
  type SubmissionInstructions,
  type Deadline,
  type TaxBenefitProvider,
} from './interfaces.js';
```

- [ ] **Step 4: Typecheck the package**

Run: `cd packages/agentbook-jurisdictions && npx tsc --noEmit`
Expected: exits 0, no errors (this also proves `ca`/`uk`/`au` packs still satisfy `JurisdictionPack` unchanged, since the new field is optional).

- [ ] **Step 5: Commit**

```bash
git add packages/agentbook-jurisdictions/src/interfaces.ts packages/agentbook-jurisdictions/src/loader.ts packages/agentbook-jurisdictions/src/index.ts
git commit -m "feat(jurisdictions): add TaxBenefitProvider interface"
```

---

## Task 3: US `TaxBenefitProvider` implementation (TDD)

**Files:**
- Create: `packages/agentbook-jurisdictions/src/us/tax-benefits.ts`
- Create: `packages/agentbook-jurisdictions/src/__tests__/us-tax-benefits.test.ts`
- Modify: `packages/agentbook-jurisdictions/src/us/index.ts` (wire `taxBenefits: usTaxBenefits` into `usPack`)

**Interfaces:**
- Consumes: `TaxBenefitProvider` and all supporting types from Task 2 (`packages/agentbook-jurisdictions/src/interfaces.js`).
- Produces: `usTaxBenefits: TaxBenefitProvider`, covering 3 program codes: `us_rd_credit_41`, `us_qsbs_tracking`, `us_de_franchise_optimization`. These exact program codes are consumed by Task 5's seed data and must match verbatim.

- [ ] **Step 1: Write the failing test file**

Create `packages/agentbook-jurisdictions/src/__tests__/us-tax-benefits.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { usTaxBenefits } from '../us/tax-benefits.js';

describe('US Tax Benefits — R&D Credit (IRC §41)', () => {
  it('lists the R&D credit for a profile with R&D spend', () => {
    const programs = usTaxBenefits.listPrograms({ annualRdSpendCents: 40_000_000 });
    expect(programs.map((p) => p.programCode)).toContain('us_rd_credit_41');
  });

  it('does not list the R&D credit for a profile with zero R&D spend', () => {
    const programs = usTaxBenefits.listPrograms({ annualRdSpendCents: 0 });
    expect(programs.map((p) => p.programCode)).not.toContain('us_rd_credit_41');
  });

  it('marks a profile with no R&D spend as not_qualified', () => {
    const result = usTaxBenefits.assessEligibility('us_rd_credit_41', {});
    expect(result.status).toBe('not_qualified');
    expect(result.estValueLowCents).toBeNull();
  });

  it('marks a profile with significant R&D spend as qualified with a plausible dollar range', () => {
    // Marcus persona: $400K/yr eng spend -> $40K-$80K claim (startup.html §1)
    const result = usTaxBenefits.assessEligibility('us_rd_credit_41', { annualRdSpendCents: 40_000_000 });
    expect(result.status).toBe('qualified');
    expect(result.estValueLowCents).toBe(4_000_000); // 10% of spend
    expect(result.estValueHighCents).toBe(8_000_000); // 20% of spend
  });

  it('marks a small amount of R&D spend as only possibly_qualified', () => {
    const result = usTaxBenefits.assessEligibility('us_rd_credit_41', { annualRdSpendCents: 500_000 });
    expect(result.status).toBe('possibly_qualified');
  });

  it('lists payroll register and project time allocation as required documents', () => {
    const docs = usTaxBenefits.getRequiredDocuments('us_rd_credit_41');
    expect(docs.map((d) => d.docType)).toEqual(
      expect.arrayContaining(['payroll_register', 'project_time_allocation']),
    );
  });

  it('returns at least one decision point on the four-part test', () => {
    const draft = usTaxBenefits.draftApplication('us_rd_credit_41', { profile: { annualRdSpendCents: 40_000_000 } });
    const points = usTaxBenefits.getDecisionPoints('us_rd_credit_41', draft);
    expect(points.length).toBeGreaterThan(0);
    expect(points[0].kind).toBe('approval');
  });

  it('flags a low-completeness draft as at least medium audit risk', () => {
    const draft = usTaxBenefits.draftApplication('us_rd_credit_41', { profile: {} });
    const risk = usTaxBenefits.assessAuditRisk('us_rd_credit_41', draft);
    expect(['medium', 'high']).toContain(risk.riskLevel);
    expect(risk.findings.length).toBeGreaterThan(0);
  });

  it('gives CPA hand-off submission instructions', () => {
    const instructions = usTaxBenefits.getSubmissionInstructions('us_rd_credit_41');
    expect(instructions.channel).toBe('cpa_handoff');
    expect(instructions.steps.length).toBeGreaterThan(0);
  });

  it('computes a filing deadline after the fiscal year end', () => {
    const fiscalYearEnd = new Date('2026-12-31');
    const deadlines = usTaxBenefits.getFilingDeadlines('us_rd_credit_41', fiscalYearEnd);
    expect(deadlines.length).toBeGreaterThan(0);
    expect(deadlines[0].date.getTime()).toBeGreaterThan(fiscalYearEnd.getTime());
  });
});

describe('US Tax Benefits — QSBS Eligibility Tracking', () => {
  it('is not_qualified for a non-C-corp', () => {
    const result = usTaxBenefits.assessEligibility('us_qsbs_tracking', { companyType: 'llc' });
    expect(result.status).toBe('not_qualified');
  });

  it('is possibly_qualified for an incorporated C-corp', () => {
    const result = usTaxBenefits.assessEligibility('us_qsbs_tracking', {
      companyType: 'c_corp',
      incorporatedAt: new Date('2026-01-01'),
    });
    expect(result.status).toBe('possibly_qualified');
    // Value is realized at a future exit, not now — must not fabricate a number.
    expect(result.estValueLowCents).toBeNull();
    expect(result.estValueHighCents).toBeNull();
  });

  it('asks for the exact share issuance date as a key_input decision point', () => {
    const draft = usTaxBenefits.draftApplication('us_qsbs_tracking', { profile: { companyType: 'c_corp' } });
    const points = usTaxBenefits.getDecisionPoints('us_qsbs_tracking', draft);
    expect(points.some((p) => p.kind === 'key_input')).toBe(true);
  });
});

describe('US Tax Benefits — Delaware Franchise Tax Optimization', () => {
  it('roughly applies only to C-corps', () => {
    const programs = usTaxBenefits.listPrograms({ companyType: 'c_corp' });
    expect(programs.map((p) => p.programCode)).toContain('us_de_franchise_optimization');
    const notApplicable = usTaxBenefits.listPrograms({ companyType: 'llc' });
    expect(notApplicable.map((p) => p.programCode)).not.toContain('us_de_franchise_optimization');
  });

  it('requires authorized share count and gross assets as a key_input decision point', () => {
    const draft = usTaxBenefits.draftApplication('us_de_franchise_optimization', { profile: { companyType: 'c_corp' } });
    const points = usTaxBenefits.getDecisionPoints('us_de_franchise_optimization', draft);
    expect(points.some((p) => p.kind === 'key_input')).toBe(true);
  });

  it('gives a March 1 Delaware portal filing deadline', () => {
    const deadlines = usTaxBenefits.getFilingDeadlines('us_de_franchise_optimization', new Date('2026-12-31'));
    expect(deadlines[0].date.getUTCMonth()).toBe(2); // March = index 2
    expect(deadlines[0].date.getUTCDate()).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/agentbook-jurisdictions && npx vitest run src/__tests__/us-tax-benefits.test.ts`
Expected: FAIL — `Cannot find module '../us/tax-benefits.js'` (file doesn't exist yet).

- [ ] **Step 3: Implement `us/tax-benefits.ts`**

Create `packages/agentbook-jurisdictions/src/us/tax-benefits.ts`:

```ts
import type {
  TaxBenefitProvider,
  StartupProfile,
  TaxBenefitProgramSummary,
  EligibilityAssessment,
  DocumentRequirement,
  ApplicationInputs,
  DraftResult,
  DecisionPoint,
  AuditRiskAssessment,
  SubmissionInstructions,
  Deadline,
} from '../interfaces.js';

interface USProgramDef {
  summary: TaxBenefitProgramSummary;
  roughlyApplies(profile: StartupProfile): boolean;
  assess(profile: StartupProfile): EligibilityAssessment;
  documents: DocumentRequirement[];
  decisionPoints(draft: DraftResult): DecisionPoint[];
  submissionInstructions: SubmissionInstructions;
  filingDeadlines(fiscalYearEnd: Date): Deadline[];
}

// ─── US R&D Tax Credit (IRC §41) ─────────────────────────────────────────────

const rdTaxCredit41: USProgramDef = {
  summary: {
    programCode: 'us_rd_credit_41',
    name: 'Federal R&D Tax Credit (IRC §41)',
    authority: 'IRS',
    typicalValueLowCents: 1_000_000, // $10,000
    typicalValueHighCents: 25_000_000, // $250,000
  },
  roughlyApplies: (profile) => !!profile.annualRdSpendCents && profile.annualRdSpendCents > 0,
  assess: (profile) => {
    const spend = profile.annualRdSpendCents ?? 0;
    if (spend <= 0) {
      return {
        status: 'not_qualified',
        confidence: 0.9,
        reasoning: 'No R&D spend recorded yet. The credit requires qualified research expenses (QREs) under IRC §41.',
        estValueLowCents: null,
        estValueHighCents: null,
      };
    }
    if (spend < 1_000_000) {
      return {
        status: 'possibly_qualified',
        confidence: 0.4,
        reasoning: 'Some R&D spend is recorded, but it is small enough that a claim may not be worth the filing overhead yet.',
        estValueLowCents: Math.round(spend * 0.1),
        estValueHighCents: Math.round(spend * 0.2),
      };
    }
    return {
      status: 'qualified',
      confidence: 0.75,
      reasoning: `$${(spend / 100).toLocaleString()} in recorded R&D spend likely qualifies as qualified research expense under the four-part test (permitted purpose, technological in nature, elimination of uncertainty, process of experimentation).`,
      estValueLowCents: Math.round(spend * 0.1),
      estValueHighCents: Math.round(spend * 0.2),
    };
  },
  documents: [
    { docType: 'payroll_register', label: 'Payroll register', description: 'Wages paid to employees performing qualified research, by pay period.', required: true },
    { docType: 'project_time_allocation', label: 'Project time allocation', description: 'Percentage of time each employee/contractor spent on qualified research vs. other work.', required: true },
    { docType: 'contractor_agreement', label: 'Contractor agreements', description: 'Agreements with any contractors performing qualified research (65% of contract research costs are includible).', required: false },
  ],
  decisionPoints: () => [
    {
      sequenceOrder: 1,
      kind: 'approval',
      prompt: 'Confirm the described engineering/contractor work involved eliminating technical uncertainty through a process of experimentation (the "four-part test" under IRC §41) — not routine software maintenance or bug fixes.',
      options: ['approve', 'reject'],
    },
  ],
  submissionInstructions: {
    channel: 'cpa_handoff',
    summary: 'File Form 6765 attached to your federal income tax return. If pre-revenue with under $5M gross receipts, elect the payroll tax offset via Form 8974 instead.',
    steps: [
      'Complete Form 6765 (Credit for Increasing Research Activities).',
      'If electing the payroll tax offset, also complete Form 8974 and attach it to your quarterly Form 941.',
      'Attach both to your federal filing or hand off to your CPA with the supporting documents above.',
    ],
  },
  filingDeadlines: (fiscalYearEnd) => [
    {
      label: 'Form 6765 due with federal income tax return',
      date: addMonths(fiscalYearEnd, 4, 15),
      urgency: 'critical',
    },
  ],
};

// ─── QSBS Eligibility Tracking (IRC §1202) ───────────────────────────────────

const qsbsTracking: USProgramDef = {
  summary: {
    programCode: 'us_qsbs_tracking',
    name: 'QSBS Eligibility Tracking (IRC §1202)',
    authority: 'IRS',
    // Value is realized at a future exit (up to $10M or 10x basis exclusion) —
    // not a near-term dollar amount, so no typical range is quoted.
    typicalValueLowCents: null,
    typicalValueHighCents: null,
  },
  roughlyApplies: (profile) => profile.companyType === 'c_corp',
  assess: (profile) => {
    if (profile.companyType !== 'c_corp') {
      return {
        status: 'not_qualified',
        confidence: 0.9,
        reasoning: 'Qualified Small Business Stock status under IRC §1202 requires the issuing entity to be a domestic C-corporation.',
        estValueLowCents: null,
        estValueHighCents: null,
      };
    }
    return {
      status: 'possibly_qualified',
      confidence: profile.incorporatedAt ? 0.6 : 0.3,
      reasoning: 'As a C-corp you may qualify, subject to the $50M gross-assets-at-issuance cap, the active-business requirement, and a 5-year holding period starting from your share issuance date.',
      estValueLowCents: null,
      estValueHighCents: null,
    };
  },
  documents: [
    { docType: 'stock_issuance_record', label: 'Stock issuance record', description: 'Board consent and stock purchase agreement documenting the issuance date and price.', required: true },
    { docType: 'cap_table', label: 'Capitalization table', description: 'Current cap table to confirm gross assets did not exceed $50M immediately after issuance.', required: true },
  ],
  decisionPoints: () => [
    {
      sequenceOrder: 1,
      kind: 'key_input',
      prompt: 'Enter the exact date qualified small business stock was issued — this starts your 5-year holding period clock under IRC §1202.',
    },
  ],
  submissionInstructions: {
    channel: 'cpa_handoff',
    summary: 'No annual filing is required now. QSBS status is claimed on Form 8949/Schedule D when shares are eventually sold — track eligibility today so the exclusion is not lost for lack of records.',
    steps: [
      'Record the exact share issuance date and confirm gross assets were under $50M immediately after issuance.',
      'Re-confirm the active-business requirement annually until sale.',
      'Keep this file for your CPA to reference at the time of a future sale or exit.',
    ],
  },
  filingDeadlines: (fiscalYearEnd) => {
    const deadlines: Deadline[] = [];
    return deadlines.concat({
      label: 'Reconfirm QSBS active-business requirement still holds',
      date: addMonths(fiscalYearEnd, 12, 31),
      urgency: 'informational',
    });
  },
};

// ─── Delaware Franchise Tax Optimization ─────────────────────────────────────

const deFranchiseOptimization: USProgramDef = {
  summary: {
    programCode: 'us_de_franchise_optimization',
    name: 'Delaware Franchise Tax Optimization',
    authority: 'Delaware Division of Corporations',
    typicalValueLowCents: 50_000, // $500
    typicalValueHighCents: 5_000_000, // $50,000
  },
  roughlyApplies: (profile) => profile.companyType === 'c_corp',
  assess: (profile) => {
    if (profile.companyType !== 'c_corp') {
      return {
        status: 'not_qualified',
        confidence: 0.7,
        reasoning: 'Delaware franchise tax optimization applies to Delaware C-corporations.',
        estValueLowCents: null,
        estValueHighCents: null,
      };
    }
    return {
      status: 'qualified',
      confidence: 0.6,
      reasoning: 'Delaware defaults to the Authorized Shares Method, which is often far more expensive than the Assumed Par Value Capital Method for an early-stage company with many authorized shares but few assets. Most startups save money by switching methods.',
      estValueLowCents: deFranchiseOptimization.summary.typicalValueLowCents,
      estValueHighCents: deFranchiseOptimization.summary.typicalValueHighCents,
    };
  },
  documents: [
    { docType: 'annual_report_draft', label: 'Delaware annual report draft', description: 'The draft annual report as pre-filled by the state.', required: true },
    { docType: 'authorized_shares_certificate', label: 'Authorized shares certificate', description: 'Certificate of incorporation or amendment showing total authorized shares.', required: true },
  ],
  decisionPoints: () => [
    {
      sequenceOrder: 1,
      kind: 'key_input',
      prompt: 'Enter total authorized shares and total gross assets from your balance sheet — required to calculate whether the Assumed Par Value Capital Method saves more than the default Authorized Shares Method.',
    },
  ],
  submissionInstructions: {
    channel: 'portal',
    summary: "File Delaware's Annual Franchise Tax Report through the Delaware Division of Corporations portal (corp.delaware.gov), selecting the Assumed Par Value Capital Method if it produces a lower tax than the default.",
    steps: [
      'Log in to corp.delaware.gov with your business entity file number.',
      'Enter total authorized shares, issued shares, and total gross assets.',
      'Compare the two calculated amounts and select the lower one before submitting.',
      'Pay and retain the confirmation for your records.',
    ],
  },
  filingDeadlines: () => [
    {
      label: 'Delaware Annual Franchise Tax Report due',
      date: new Date(Date.UTC(new Date().getUTCFullYear() + 1, 2, 1)), // March 1 following the current year
      urgency: 'critical',
    },
  ],
};

const PROGRAM_REGISTRY: Record<string, USProgramDef> = {
  [rdTaxCredit41.summary.programCode]: rdTaxCredit41,
  [qsbsTracking.summary.programCode]: qsbsTracking,
  [deFranchiseOptimization.summary.programCode]: deFranchiseOptimization,
};

const ALL_PROGRAMS = [rdTaxCredit41, qsbsTracking, deFranchiseOptimization];

/** Add `months` calendar months to `date`, then set the day-of-month to `day`. */
function addMonths(date: Date, months: number, day: number): Date {
  const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, day));
  return result;
}

function requireProgram(programCode: string): USProgramDef {
  const program = PROGRAM_REGISTRY[programCode];
  if (!program) throw new Error(`Unknown US tax benefit program: ${programCode}`);
  return program;
}

/** Conservative, generic draft. Real drafting (reading books/documents) ships in PR 7.4 — this just proves the interface shape. */
function draftApplication(programCode: string, inputs: ApplicationInputs): DraftResult {
  const program = requireProgram(programCode);
  const hasProfile = Object.keys(inputs.profile ?? {}).length > 0;
  return {
    programCode: program.summary.programCode,
    sections: {},
    completeness: hasProfile ? 0.5 : 0,
  };
}

/** Conservative by design (bias toward flagging, per startup.html §11) — a low-completeness draft is never called low risk. */
function assessAuditRisk(programCode: string, draft: DraftResult) {
  requireProgram(programCode);
  if (draft.completeness >= 1) {
    return { riskLevel: 'low' as const, findings: [] };
  }
  return {
    riskLevel: (draft.completeness > 0 ? 'medium' : 'high') as 'medium' | 'high',
    findings: [
      {
        severity: (draft.completeness > 0 ? 'medium' : 'high') as 'medium' | 'high',
        issue: 'Draft is incomplete — one or more decision points have not been resolved.',
        recommendation: 'Resolve all outstanding decision points before marking this application ready for review.',
        ruleRef: 'internal:completeness-gate',
      },
    ],
  };
}

export const usTaxBenefits: TaxBenefitProvider = {
  listPrograms: (profile) => ALL_PROGRAMS.filter((p) => p.roughlyApplies(profile)).map((p) => p.summary),
  assessEligibility: (programCode, profile) => requireProgram(programCode).assess(profile),
  getRequiredDocuments: (programCode) => requireProgram(programCode).documents,
  draftApplication,
  getDecisionPoints: (programCode, draft) => requireProgram(programCode).decisionPoints(draft),
  assessAuditRisk: (programCode, draft) => assessAuditRisk(programCode, draft) as AuditRiskAssessment,
  getSubmissionInstructions: (programCode) => requireProgram(programCode).submissionInstructions,
  getFilingDeadlines: (programCode, fiscalYearEnd) => requireProgram(programCode).filingDeadlines(fiscalYearEnd),
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/agentbook-jurisdictions && npx vitest run src/__tests__/us-tax-benefits.test.ts`
Expected: all tests PASS. If the "possibly_qualified" or dollar-range assertions fail, check the exact cents math against the `assess` function above (10%/20% of `annualRdSpendCents`, integer cents, no floats).

- [ ] **Step 5: Wire `taxBenefits` into `usPack`**

In `packages/agentbook-jurisdictions/src/us/index.ts`, add the import and field:
```ts
import type { JurisdictionPack } from '../loader.js';
import { usTaxBrackets } from './tax-brackets.js';
import { usSelfEmploymentTax } from './self-employment-tax.js';
import { usSalesTax } from './sales-tax.js';
import { usChartOfAccounts } from './chart-of-accounts.js';
import { usInstallmentSchedule } from './installment-schedule.js';
import { usContractorReport } from './contractor-report.js';
import { usMileageRate } from './mileage-rate.js';
import { usDeductions } from './deductions.js';
import { usCalendarDeadlines } from './calendar-deadlines.js';
import { usTaxBenefits } from './tax-benefits.js';

export const usPack: JurisdictionPack = {
  id: 'us',
  name: 'United States',
  taxBrackets: usTaxBrackets,
  selfEmploymentTax: usSelfEmploymentTax,
  salesTax: usSalesTax,
  chartOfAccounts: usChartOfAccounts,
  installmentSchedule: usInstallmentSchedule,
  contractorReport: usContractorReport,
  mileageRate: usMileageRate,
  deductions: usDeductions,
  calendarDeadlines: usCalendarDeadlines,
  taxBenefits: usTaxBenefits,
};
```

- [ ] **Step 6: Run the full jurisdictions test suite to confirm no regressions**

Run: `cd packages/agentbook-jurisdictions && npx vitest run`
Expected: all existing suites (`us-pack.test.ts`, `ca-pack.test.ts`, the new `us-tax-benefits.test.ts`) PASS.

- [ ] **Step 7: Typecheck the whole package again**

Run: `cd packages/agentbook-jurisdictions && npx tsc --noEmit`
Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add packages/agentbook-jurisdictions/src/us/tax-benefits.ts packages/agentbook-jurisdictions/src/us/index.ts packages/agentbook-jurisdictions/src/__tests__/us-tax-benefits.test.ts
git commit -m "feat(jurisdictions): implement TaxBenefitProvider for the US pack"
```

---

## Task 4: Scaffold the `agentbook-startup` plugin (empty backend)

**Files:**
- Create: `plugins/agentbook-startup/plugin.json`
- Create: `plugins/agentbook-startup/backend/package.json`
- Create: `plugins/agentbook-startup/backend/tsconfig.json`
- Create: `plugins/agentbook-startup/backend/src/server.ts`
- Create: `plugins/agentbook-startup/backend/src/db/client.ts`

**Interfaces:**
- Produces: a running Express server on port 4054 (dev) responding to `GET /healthz`, discoverable by `bin/sync-plugin-registry.ts` via `plugin.json`. No other routes in this PR — Task 5's catalog is seeded directly via a script, not exposed over HTTP yet (that's PR 7.3).

- [ ] **Step 1: Write `plugin.json`**

Create `plugins/agentbook-startup/plugin.json`:
```json
{
  "$schema": "https://plugins.naap.io/schema/plugin.json",
  "name": "agentbook-startup",
  "displayName": "Startup Tax Benefits",
  "version": "1.0.0",
  "description": "Discovers government tax-benefit programs a startup qualifies for (R&D tax credit, QSBS tracking, Delaware franchise tax optimization, and more), drafts the application with human decision points, runs an audit-risk review, and tracks it through to a decision.",
  "isCore": false,
  "author": {
    "name": "A3P Team",
    "email": "team@a3p.io",
    "url": "https://a3p.io"
  },
  "repository": "https://github.com/a3p/plugins/tree/main/agentbook-startup",
  "license": "MIT",
  "keywords": ["startup", "tax-credit", "r&d-credit", "qsbs", "franchise-tax"],
  "category": "finance",

  "shell": {
    "minVersion": "0.1.0",
    "maxVersion": "2.x"
  },

  "backend": {
    "entry": "./backend/dist/server.js",
    "devPort": 4054,
    "port": 4154,
    "healthCheck": "/healthz",
    "apiPrefix": "/api/v1/agentbook-startup",
    "resources": {
      "memory": "256Mi",
      "cpu": "0.25"
    }
  },

  "integrations": {
    "required": [],
    "optional": []
  },

  "permissions": {
    "shell": ["navigation", "notifications", "theme"],
    "apis": [],
    "external": []
  },

  "config": {
    "schema": {}
  }
}
```

Note: there is deliberately no `"frontend"` key yet — `packages/database/src/plugin-discovery.ts` reads `manifest.frontend?.routes || []`, so omitting it means this plugin registers with zero routes and is not loaded by the frontend `PluginLoader` on any page. This is what makes the PR genuinely dark — nothing in the shell UI can reach it. A `"frontend"` block gets added when PR 7.3 ships the recommendation UI.

- [ ] **Step 2: Write the backend `package.json`**

Create `plugins/agentbook-startup/backend/package.json`:
```json
{
  "name": "@naap/plugin-agentbook-startup-backend",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "./src/server.ts",
  "exports": {
    ".": "./src/server.ts"
  },
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@naap/database": "*",
    "@naap/plugin-server-sdk": "*",
    "cors": "^2.8.6",
    "dotenv": "^16.6.1",
    "express": "^4.21.0"
  },
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/node": "^20.19.35",
    "tsx": "^4.19.0",
    "typescript": "~5.9.3",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 3: Write the backend `tsconfig.json`**

Create `plugins/agentbook-startup/backend/tsconfig.json`:
```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "noImplicitReturns": false,
    "noUnusedLocals": false
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: Write the db client**

Create `plugins/agentbook-startup/backend/src/db/client.ts`:
```ts
/**
 * Database client for agentbook-startup plugin
 *
 * Uses the unified @naap/database package (single DB, multi-schema).
 * StartupBenefit* models live in the "plugin_agentbook_startup" PostgreSQL schema.
 */

import { prisma } from '@naap/database';

export const db = prisma;

export default db;
```

- [ ] **Step 5: Write the minimal server**

Create `plugins/agentbook-startup/backend/src/server.ts`:
```ts
/**
 * AgentBook Startup Tax Benefits Backend - v1.0 (foundation)
 *
 * PR 7.1: empty backend, registered via plugin.json so
 * bin/sync-plugin-registry.ts picks it up. No routes beyond the
 * standard /healthz yet — the recommendation engine (Phase 1 of the
 * 5-phase workflow) ships in PR 7.3. See startup.html §8 and §10.
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createPluginServer } from '@naap/plugin-server-sdk';
import { db } from './db/client.js';

let pluginConfig: { backend?: { devPort?: number } } = {};
try {
  pluginConfig = JSON.parse(
    readFileSync(new URL('../../plugin.json', import.meta.url), 'utf8'),
  );
} catch {
  /* bundled environment — defaults are fine */
}

const server = createPluginServer({
  name: 'agentbook-startup',
  port: parseInt(process.env.PORT || String(pluginConfig.backend?.devPort || 4054), 10),
  prisma: db,
  requireAuth: process.env.NODE_ENV === 'production',
  publicRoutes: ['/healthz', '/api/v1/agentbook-startup'],
});

export const app = server.app;

const isDirectRun =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  !!process.argv[1] &&
  import.meta.url === new URL(process.argv[1], 'file://').href;

if (isDirectRun) {
  server.start().catch((err) => {
    console.error('Failed to start agentbook-startup-svc:', err);
    process.exit(1);
  });
}
```

- [ ] **Step 6: Install workspace dependencies**

Run: `npm install` (from the monorepo root — the new `plugins/agentbook-startup/backend` workspace matches the existing `"plugins/*/backend"` glob in the root `package.json`, so this links `@naap/database` and `@naap/plugin-server-sdk`).
Expected: exits 0, no new top-level errors.

- [ ] **Step 7: Typecheck the new backend**

Run: `cd plugins/agentbook-startup/backend && npx tsc --noEmit`
Expected: exits 0.

- [ ] **Step 8: Start the server and confirm the health check responds**

Run (from repo root, in the background or a separate terminal):
```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" \
DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap" \
PORT=4054 npx tsx plugins/agentbook-startup/backend/src/server.ts
```
Then in another shell: `curl -s http://localhost:4054/healthz`
Expected: an HTTP 200 JSON health response (matching the shape every other plugin's `/healthz` returns). Stop the server afterward.

- [ ] **Step 9: Commit**

```bash
git add plugins/agentbook-startup/plugin.json plugins/agentbook-startup/backend
git commit -m "feat(startup): scaffold agentbook-startup plugin (empty backend)"
```

---

## Task 5: Seed the US program catalog (3 programs)

**Files:**
- Create: `plugins/agentbook-startup/backend/src/catalog/us-programs.ts`
- Create: `bin/seed-startup-benefit-programs.ts`

**Interfaces:**
- Consumes: `db.startupBenefitProgram` (Task 1), `usTaxBenefits.getRequiredDocuments`/`assessEligibility` reasoning is NOT reused here — the catalog is independent seed data (the design's own eligibility criteria text), not derived from the code in Task 3.
- Produces: 3 rows in `StartupBenefitProgram` with `programCode` values `us_rd_credit_41`, `us_qsbs_tracking`, `us_de_franchise_optimization` — these **must** match the program codes used in Task 3 verbatim, since PR 7.3 will join catalog rows to `usTaxBenefits` calls by `programCode`.

- [ ] **Step 1: Write the catalog data file**

Create `plugins/agentbook-startup/backend/src/catalog/us-programs.ts`:
```ts
export interface StartupBenefitProgramSeed {
  jurisdiction: string;
  programCode: string;
  name: string;
  authority: string;
  typicalValueLowCents: number | null;
  typicalValueHighCents: number | null;
  eligibilityCriteria: string[];
  requiredDocuments: { docType: string; label: string; description: string; required: boolean }[];
  sourceUrl: string;
}

export const US_STARTUP_BENEFIT_PROGRAMS: StartupBenefitProgramSeed[] = [
  {
    jurisdiction: 'us',
    programCode: 'us_rd_credit_41',
    name: 'Federal R&D Tax Credit (IRC §41)',
    authority: 'IRS',
    typicalValueLowCents: 1_000_000,
    typicalValueHighCents: 25_000_000,
    eligibilityCriteria: [
      'Expenses must be qualified research expenses (QREs): wages, supplies, and 65% of contract research costs.',
      'Research must pass the four-part test: permitted purpose, technological in nature, elimination of uncertainty, and a process of experimentation.',
      'To elect the payroll tax offset (Form 8974) instead of an income tax credit, the company must have under $5M in current-year gross receipts and no gross receipts for any year before the 5 preceding years.',
    ],
    requiredDocuments: [
      { docType: 'payroll_register', label: 'Payroll register', description: 'Wages paid to employees performing qualified research, by pay period.', required: true },
      { docType: 'project_time_allocation', label: 'Project time allocation', description: 'Percentage of time each employee/contractor spent on qualified research vs. other work.', required: true },
      { docType: 'contractor_agreement', label: 'Contractor agreements', description: 'Agreements with any contractors performing qualified research.', required: false },
    ],
    sourceUrl: 'https://www.irs.gov/forms-pubs/about-form-6765',
  },
  {
    jurisdiction: 'us',
    programCode: 'us_qsbs_tracking',
    name: 'QSBS Eligibility Tracking (IRC §1202)',
    authority: 'IRS',
    typicalValueLowCents: null,
    typicalValueHighCents: null,
    eligibilityCriteria: [
      'The issuing entity must be a domestic C-corporation.',
      "The corporation's gross assets must not have exceeded $50M at any time up to immediately after the stock issuance.",
      'At least 80% of the corporation\'s assets must be used in the active conduct of a qualified trade or business.',
      'Stock must be held for more than 5 years to claim the exclusion (up to $10M or 10x basis, whichever is greater) under IRC §1202.',
    ],
    requiredDocuments: [
      { docType: 'stock_issuance_record', label: 'Stock issuance record', description: 'Board consent and stock purchase agreement documenting the issuance date and price.', required: true },
      { docType: 'cap_table', label: 'Capitalization table', description: 'Current cap table to confirm gross assets did not exceed $50M immediately after issuance.', required: true },
    ],
    sourceUrl: 'https://www.irs.gov/pub/irs-pdf/i1202.pdf',
  },
  {
    jurisdiction: 'us',
    programCode: 'us_de_franchise_optimization',
    name: 'Delaware Franchise Tax Optimization',
    authority: 'Delaware Division of Corporations',
    typicalValueLowCents: 50_000,
    typicalValueHighCents: 5_000_000,
    eligibilityCriteria: [
      'Applies to any corporation incorporated in Delaware.',
      "Delaware's default calculation (Authorized Shares Method) can be dramatically higher than the alternative (Assumed Par Value Capital Method) for early-stage companies with many authorized shares but low assets.",
      'The lower of the two calculated amounts may be elected when filing the annual report.',
    ],
    requiredDocuments: [
      { docType: 'annual_report_draft', label: 'Delaware annual report draft', description: 'The draft annual report as pre-filled by the state.', required: true },
      { docType: 'authorized_shares_certificate', label: 'Authorized shares certificate', description: 'Certificate of incorporation or amendment showing total authorized shares.', required: true },
    ],
    sourceUrl: 'https://corp.delaware.gov/frtaxcalc/',
  },
];
```

- [ ] **Step 2: Write the seed script**

Create `bin/seed-startup-benefit-programs.ts`:
```ts
import { prisma as db } from '@naap/database';
import { US_STARTUP_BENEFIT_PROGRAMS } from '../plugins/agentbook-startup/backend/src/catalog/us-programs.js';

async function main() {
  let created = 0;
  let updated = 0;
  const now = new Date();

  for (const program of US_STARTUP_BENEFIT_PROGRAMS) {
    const existing = await db.startupBenefitProgram.findUnique({
      where: { jurisdiction_programCode: { jurisdiction: program.jurisdiction, programCode: program.programCode } },
    });

    const data = {
      jurisdiction: program.jurisdiction,
      programCode: program.programCode,
      name: program.name,
      authority: program.authority,
      typicalValueLowCents: program.typicalValueLowCents,
      typicalValueHighCents: program.typicalValueHighCents,
      eligibilityCriteria: program.eligibilityCriteria,
      requiredDocuments: program.requiredDocuments,
      sourceUrl: program.sourceUrl,
      lastVerifiedAt: now,
      enabled: true,
    };

    if (existing) {
      await db.startupBenefitProgram.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await db.startupBenefitProgram.create({ data });
      created++;
    }
  }

  console.log(JSON.stringify({ created, updated, total: US_STARTUP_BENEFIT_PROGRAMS.length }));
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: Run the seed script against the local docker Postgres**

Run:
```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" \
DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap" \
npx tsx bin/seed-startup-benefit-programs.ts
```
Expected: `{"created":3,"updated":0,"total":3}`.

- [ ] **Step 4: Verify idempotency by running it a second time**

Run the same command again.
Expected: `{"created":0,"updated":3,"total":3}` — proves the `@@unique([jurisdiction, programCode])` upsert path works and re-running the seed never duplicates rows.

- [ ] **Step 5: Spot-check one row directly in Postgres**

Run:
```bash
docker exec naap-db psql -U postgres -d naap -c "SELECT \"programCode\", \"name\", \"typicalValueLowCents\", \"typicalValueHighCents\" FROM plugin_agentbook_startup.\"StartupBenefitProgram\" ORDER BY \"programCode\";"
```
Expected: 3 rows — `us_de_franchise_optimization`, `us_qsbs_tracking`, `us_rd_credit_41` — with the values from Step 1's data file.

- [ ] **Step 6: Commit**

```bash
git add plugins/agentbook-startup/backend/src/catalog/us-programs.ts bin/seed-startup-benefit-programs.ts
git commit -m "feat(startup): seed US startup benefit program catalog"
```

---

## Task 6: Registry sync verification + full-repo sanity check

**Files:** none created/modified — this task only runs existing tooling to prove Task 4's plugin.json is discovered correctly and nothing else broke.

**Interfaces:** none — verification only.

- [ ] **Step 1: Run the plugin registry sync against the local DB**

Run:
```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" \
DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap" \
npx tsx bin/sync-plugin-registry.ts
```
Expected: log output includes `Discovered 5 plugins` (up from 4) and a `[created]`-style line for `agentbook-startup` the first time it runs (or "updated" on subsequent runs). No errors.

- [ ] **Step 2: Confirm the WorkflowPlugin row has zero routes (proves it's dark)**

Run:
```bash
docker exec naap-db psql -U postgres -d naap -c "SELECT name, routes, enabled FROM public.\"WorkflowPlugin\" WHERE name = 'agentbookStartup';"
```
Expected: one row, `routes` is `[]` (empty array/JSON), `enabled` is `true`. Empty routes confirms the frontend `PluginLoader` has nothing to match against, so the plugin cannot be reached from any page yet.

- [ ] **Step 3: Run the full jurisdictions and startup-backend test suites one more time**

Run:
```bash
cd packages/agentbook-jurisdictions && npx vitest run && cd ../../plugins/agentbook-startup/backend && npx vitest run
```
Expected: jurisdictions suite passes (no test files exist yet for the startup backend itself since it has no logic beyond `/healthz` — `vitest run` with zero test files exits 0 with "No test files found" is acceptable here since Task 4 added no business logic to test).

- [ ] **Step 4: Typecheck every package touched by this PR**

Run:
```bash
cd packages/agentbook-jurisdictions && npx tsc --noEmit && \
cd ../../plugins/agentbook-startup/backend && npx tsc --noEmit
```
Expected: both exit 0.

- [ ] **Step 5: Confirm no other plugin's tests regressed**

Run: `cd plugins/agentbook-tax/backend && npx vitest run` (the plugin the design flags as the closest precedent/risk).
Expected: unchanged pass/fail state vs. `main` (this PR touched none of its files).

- [ ] **Step 6: Final review of the diff**

Run: `git diff origin/main --stat`
Expected: only files from Tasks 1–5 appear — `packages/database/prisma/schema.prisma`, `docker/init-schemas.sql`, `packages/agentbook-jurisdictions/src/{interfaces.ts,loader.ts,index.ts,us/index.ts,us/tax-benefits.ts,__tests__/us-tax-benefits.test.ts}`, `plugins/agentbook-startup/**`, `bin/seed-startup-benefit-programs.ts`. Nothing under `plugins/agentbook-core`, `plugins/agentbook-expense`, `plugins/agentbook-invoice`, `plugins/agentbook-tax`, or any `ca`/`uk`/`au` jurisdiction file should appear.

This task intentionally has no commit step — it's pure verification of Tasks 1–5's commits.
