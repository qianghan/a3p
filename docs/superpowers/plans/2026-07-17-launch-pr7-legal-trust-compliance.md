# Launch-gap PR-7: Legal, Trust & Compliance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close five legal/trust gaps identified in the launch-gap audit: dead Terms/Privacy links with no footer entry point, an under-disclosed sub-processor list and missing jurisdiction language in the privacy policy, no minimum-age clause or signup gate, a "not tax advice" disclaimer missing from 7 of 8 tax-related pages, and a refund clause that doesn't address annual add-on pre-payment.

**Architecture:** Two kinds of change, handled differently per this session's standing legal-copy rule:
1. **Structural fixes** (Tasks 1–2): broken link repointing, a footer link, and one small shared React component (`TaxDisclaimer`) reusing text that is *already live in production* (`TaxDashboard.tsx`). These carry no new legal-copy risk and flow through the normal SDD → CI → merge pipeline.
2. **Copy changes** (Tasks 3–4): a new age-attestation checkbox + server-side gate (new short copy), and edits to the privacy policy and terms-of-service pages (new legal copy: jurisdiction language, a missing sub-processor, an age clause, and an expanded refund clause). These are implemented and tested in this branch like everything else, but the branch **must not be merged** until the user has explicitly reviewed the drafted copy — this is Task 4's own step, not deferred to Task 5.

**Tech Stack:** Next.js App Router (`apps/web-next`), a Vite-built plugin frontend (`plugins/agentbook-tax/frontend`), Vitest for API-route tests.

## Global Constraints

- Legal-copy changes (privacy policy, terms page, age-attestation copy) are implemented and tested in this branch but explicitly presented to the user for review before this branch merges to main — per this session's standing rule for PR-7, do not unilaterally finalize legal-document language. Task 4 ends with this checkpoint; do not proceed past it without an explicit go-ahead.
- No new legal infrastructure: no cookie-consent banner, no third-party age-verification service, no IP-based jurisdiction detection. This is copy and disclosure work plus one small presentational React component.
- Minimum age threshold used throughout this plan is **18** (standard age-of-majority baseline). Flag this explicitly at the Task 4 review checkpoint in case the user wants a different number given AgentBook's student persona.
- **Correction versus the roadmap's own framing:** the privacy policy *already* discloses "Google (Gemini)" as an LLM sub-processor (existing `page.tsx` section 3). Do not re-add or duplicate this disclosure — only **Supabase** is actually missing from the sub-processor list.
- **Correction versus the roadmap's own framing:** no reusable "not tax advice" disclaimer component exists today — the text is hand-inlined JSX in exactly one file (`TaxDashboard.tsx`). This plan creates one shared component and migrates `TaxDashboard.tsx` to use it too, so the same copy lives in exactly one place going forward.
- OAuth signup (Google) does not go through the email/password `register()` API route this plan gates — adding an equivalent age-check to the OAuth callback flow is a materially larger change to a different code path and is out of scope here. Note this as an explicit, accepted gap in Task 3, not something to silently skip past.
- Both legal pages' "Last updated" date bumps from `2026-05-24` to `2026-07-17` as part of Task 4 (the only task that changes their content).

---

### Task 1: Add Terms/Privacy links to the homepage footer

**Files:**
- Modify: `apps/web-next/src/app/page.tsx:781-785` (add Terms/Privacy links to the footer's bottom bar)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed by later tasks.

Note: the OTHER dead-link half of this gap — `register-form.tsx`'s `/terms`/`/privacy` links — is fixed in Task 3, not here. Task 3 replaces that entire paragraph (not just its two `href`s) with a required checkbox, so fixing the links here first would just be overwritten a task later; doing it once, correctly, in Task 3 avoids that redundant edit. This task only covers the footer, which nothing else in this plan touches.

- [ ] **Step 1: Add Terms/Privacy links to the homepage footer**

Find (in `apps/web-next/src/app/page.tsx`):
```tsx
        <Hairline className="my-7" />
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-[11.5px] num uppercase tracking-[0.16em] text-[var(--muted)]">
          <span>© {new Date().getFullYear()} AgentBook · A folio of one ledger</span>
          <span>Built quietly. Yours plainly.</span>
        </div>
      </footer>
```
Replace with:
```tsx
        <Hairline className="my-7" />
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-[11.5px] num uppercase tracking-[0.16em] text-[var(--muted)]">
          <span>© {new Date().getFullYear()} AgentBook · A folio of one ledger</span>
          <div className="flex items-center gap-4 normal-case tracking-normal">
            <Link href="/legal/terms" className="ab-link">Terms</Link>
            <Link href="/legal/privacy" className="ab-link">Privacy</Link>
          </div>
          <span>Built quietly. Yours plainly.</span>
        </div>
      </footer>
```

- [ ] **Step 2: Build check**

Run: `cd apps/web-next && npx tsc --noEmit 2>&1 | grep -i "app/page.tsx"`
Expected: no output (no new type errors).

- [ ] **Step 3: Commit**

```bash
git add apps/web-next/src/app/page.tsx
git commit -m "fix(legal): add missing Terms/Privacy footer links"
```

---

### Task 2: Shared `TaxDisclaimer` component, applied to all 8 tax-related pages

**Files:**
- Create: `plugins/agentbook-tax/frontend/src/components/TaxDisclaimer.tsx`
- Modify: `plugins/agentbook-tax/frontend/src/pages/TaxDashboard.tsx` (replace inline JSX with the shared component — pure DRY, same visual output)
- Modify: `plugins/agentbook-tax/frontend/src/pages/WhatIf.tsx`, `Reports.tsx`, `PastFilings.tsx`, `TaxPackage.tsx`, `Quarterly.tsx`, `Analytics.tsx`, `CashFlow.tsx` (add the disclaimer, currently absent from all 7)

**Interfaces:**
- Produces: `export function TaxDisclaimer(): JSX.Element` — no props, no state. Renders the exact text already live in production on `TaxDashboard.tsx`.
- Consumes: `lucide-react`'s `AlertCircle` icon (already a project dependency, already imported in `TaxDashboard.tsx`).

- [ ] **Step 1: Create the shared component**

Create `plugins/agentbook-tax/frontend/src/components/TaxDisclaimer.tsx`:
```tsx
import { AlertCircle } from 'lucide-react';

/**
 * "Not tax advice" disclaimer. Same text and layout already live on
 * TaxDashboard.tsx — extracted here so every tax-figure-producing page
 * shows it, not just one.
 */
export function TaxDisclaimer() {
  return (
    <div className="rounded-xl border border-border bg-muted/30 p-4 text-xs text-muted-foreground">
      <AlertCircle className="inline w-3.5 h-3.5 mr-1 text-yellow-400" />
      Tax calculations are estimates for planning purposes only. Consult a licensed tax professional for filing advice.
    </div>
  );
}
```

- [ ] **Step 2: Migrate `TaxDashboard.tsx` to use it**

Find (in `plugins/agentbook-tax/frontend/src/pages/TaxDashboard.tsx`, near the top import block):
```tsx
import { formatMoney } from '@agentbook/i18n';
import { useTenantCurrency } from '../hooks/useTenantCurrency';
```
Replace with:
```tsx
import { formatMoney } from '@agentbook/i18n';
import { useTenantCurrency } from '../hooks/useTenantCurrency';
import { TaxDisclaimer } from '../components/TaxDisclaimer';
```

Find (further down in the same file):
```tsx
      <div className="rounded-xl border border-border bg-muted/30 p-4 text-xs text-muted-foreground">
        <AlertCircle className="inline w-3.5 h-3.5 mr-1 text-yellow-400" />
        Tax calculations are estimates for planning purposes only. Consult a licensed tax professional for filing advice.
      </div>
```
Replace with:
```tsx
      <TaxDisclaimer />
```

Leave the `AlertCircle` import in this file's `lucide-react` import block as-is even though it may now be otherwise unused here — check with `grep -n "AlertCircle" plugins/agentbook-tax/frontend/src/pages/TaxDashboard.tsx` after this edit; if the only remaining reference was the one just removed, delete `AlertCircle` from the `lucide-react` import list to avoid an unused-import lint warning. If any other JSX in the file still uses `<AlertCircle`, leave the import untouched.

- [ ] **Step 3: Add the disclaimer to `WhatIf.tsx`**

Find (in `plugins/agentbook-tax/frontend/src/pages/WhatIf.tsx`):
```tsx
import React, { useState } from 'react';
import { Calculator, ArrowRight, DollarSign } from 'lucide-react';
import { ChatCTA } from '@naap/plugin-sdk';
```
Replace with:
```tsx
import React, { useState } from 'react';
import { Calculator, ArrowRight, DollarSign } from 'lucide-react';
import { ChatCTA } from '@naap/plugin-sdk';
import { TaxDisclaimer } from '../components/TaxDisclaimer';
```

Find:
```tsx
          <div className={`p-4 rounded-lg text-center ${result.savingsCents > 0 ? 'bg-green-500/10 text-green-600' : 'bg-red-500/10 text-red-500'}`}>
            <p className="text-2xl font-bold">{result.savingsCents > 0 ? '-' : '+'}{fmt(result.savingsCents)}</p>
            <p className="text-sm mt-1">{result.explanation}</p>
          </div>
        </div>
      )}
    </div>
  );
};
```
Replace with:
```tsx
          <div className={`p-4 rounded-lg text-center ${result.savingsCents > 0 ? 'bg-green-500/10 text-green-600' : 'bg-red-500/10 text-red-500'}`}>
            <p className="text-2xl font-bold">{result.savingsCents > 0 ? '-' : '+'}{fmt(result.savingsCents)}</p>
            <p className="text-sm mt-1">{result.explanation}</p>
          </div>
        </div>
      )}

      <div className="mt-6">
        <TaxDisclaimer />
      </div>
    </div>
  );
};
```
(Placed after the results block rather than at the top, since `WhatIf.tsx` is exactly the "synthetic what-if figures with zero caveat" page the roadmap calls out by name — the disclaimer belongs right next to the numbers it qualifies. Renders whether or not `result` is set, which is correct: even before a calculation is run, the page is presenting itself as a tax-estimation tool.)

- [ ] **Step 4: Add the disclaimer to `Reports.tsx`**

Find (in `plugins/agentbook-tax/frontend/src/pages/Reports.tsx`):
```tsx
import { ChatCTA } from '@naap/plugin-sdk';
import { formatMoney } from '@agentbook/i18n';
import { useTenantCurrency } from '../hooks/useTenantCurrency';
```
Replace with:
```tsx
import { ChatCTA } from '@naap/plugin-sdk';
import { formatMoney } from '@agentbook/i18n';
import { useTenantCurrency } from '../hooks/useTenantCurrency';
import { TaxDisclaimer } from '../components/TaxDisclaimer';
```

Find:
```tsx
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          Generate and view financial reports for your business
        </p>
      </div>

      {/* PR 45 / Tier 1 #1: chat-first escape hatch */}
      <ChatCTA example="show me my P&L for this quarter" />
```
Replace with:
```tsx
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          Generate and view financial reports for your business
        </p>
      </div>

      <div className="mb-6">
        <TaxDisclaimer />
      </div>

      {/* PR 45 / Tier 1 #1: chat-first escape hatch */}
      <ChatCTA example="show me my P&L for this quarter" />
```

- [ ] **Step 5: Add the disclaimer to `PastFilings.tsx`**

Find (in `plugins/agentbook-tax/frontend/src/pages/PastFilings.tsx`, top imports):
```tsx
import { FileUp, Loader2, CheckCircle2, AlertCircle, RefreshCw, Download } from 'lucide-react';
import { useTenantCurrency } from '../hooks/useTenantCurrency';
```
Replace with:
```tsx
import { FileUp, Loader2, CheckCircle2, AlertCircle, RefreshCw, Download } from 'lucide-react';
import { useTenantCurrency } from '../hooks/useTenantCurrency';
import { TaxDisclaimer } from '../components/TaxDisclaimer';
```

Find:
```tsx
  return (
    <div className="px-4 py-5 sm:p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Past Tax Filings</h1>

      {/* Upload card */}
```
Replace with:
```tsx
  return (
    <div className="px-4 py-5 sm:p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Past Tax Filings</h1>

      <div className="mb-6">
        <TaxDisclaimer />
      </div>

      {/* Upload card */}
```

- [ ] **Step 6: Add the disclaimer to `TaxPackage.tsx`**

Find (in `plugins/agentbook-tax/frontend/src/pages/TaxPackage.tsx`, top imports):
```tsx
import React, { useEffect, useMemo, useState } from 'react';
import { Download, FileText, Loader2, RefreshCw } from 'lucide-react';
import { PastFilingsPage } from './PastFilings';
import { FastTrackTab } from './FastTrackTab';
```
Replace with:
```tsx
import React, { useEffect, useMemo, useState } from 'react';
import { Download, FileText, Loader2, RefreshCw } from 'lucide-react';
import { PastFilingsPage } from './PastFilings';
import { FastTrackTab } from './FastTrackTab';
import { TaxDisclaimer } from '../components/TaxDisclaimer';
```

Find:
```tsx
    <div className="px-4 py-5 sm:p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <FileText className="w-6 h-6 text-primary" />
          <h1 className="text-2xl font-bold">Year-end Tax Package</h1>
        </div>
      </div>

      {/* Generate panel */}
```
Replace with:
```tsx
    <div className="px-4 py-5 sm:p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <FileText className="w-6 h-6 text-primary" />
          <h1 className="text-2xl font-bold">Year-end Tax Package</h1>
        </div>
      </div>

      <div className="mb-6">
        <TaxDisclaimer />
      </div>

      {/* Generate panel */}
```

- [ ] **Step 7: Add the disclaimer to `Quarterly.tsx`**

Find (in `plugins/agentbook-tax/frontend/src/pages/Quarterly.tsx`, top imports):
```tsx
import { ChatCTA } from '@naap/plugin-sdk';
import { formatMoney } from '@agentbook/i18n';
import { useTenantCurrency } from '../hooks/useTenantCurrency';
```
Replace with:
```tsx
import { ChatCTA } from '@naap/plugin-sdk';
import { formatMoney } from '@agentbook/i18n';
import { useTenantCurrency } from '../hooks/useTenantCurrency';
import { TaxDisclaimer } from '../components/TaxDisclaimer';
```

Find:
```tsx
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          Track and manage quarterly tax installment payments
        </p>
      </div>

      {/* PR 44 / Tier 1 #1: chat-first escape hatch */}
      <ChatCTA example="how much do I owe in quarterly taxes this quarter?" />
```
Replace with:
```tsx
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          Track and manage quarterly tax installment payments
        </p>
      </div>

      <div className="mb-6">
        <TaxDisclaimer />
      </div>

      {/* PR 44 / Tier 1 #1: chat-first escape hatch */}
      <ChatCTA example="how much do I owe in quarterly taxes this quarter?" />
```

- [ ] **Step 8: Add the disclaimer to `Analytics.tsx`**

Find (in `plugins/agentbook-tax/frontend/src/pages/Analytics.tsx`, top imports):
```tsx
import React, { useEffect, useState } from 'react';
import { PieChart, BarChart3, TrendingUp, TrendingDown, Zap } from 'lucide-react';
```
Replace with:
```tsx
import React, { useEffect, useState } from 'react';
import { PieChart, BarChart3, TrendingUp, TrendingDown, Zap } from 'lucide-react';
import { TaxDisclaimer } from '../components/TaxDisclaimer';
```

Find:
```tsx
      <div className="flex items-center gap-3 mb-6">
        <BarChart3 className="w-6 h-6 text-primary" />
        <h1 className="text-2xl font-bold">Expense Analytics</h1>
      </div>

      {loading && <p className="text-muted-foreground">Loading analytics...</p>}
```
Replace with:
```tsx
      <div className="flex items-center gap-3 mb-6">
        <BarChart3 className="w-6 h-6 text-primary" />
        <h1 className="text-2xl font-bold">Expense Analytics</h1>
      </div>

      <div className="mb-6">
        <TaxDisclaimer />
      </div>

      {loading && <p className="text-muted-foreground">Loading analytics...</p>}
```

- [ ] **Step 9: Add the disclaimer to `CashFlow.tsx`**

Find (in `plugins/agentbook-tax/frontend/src/pages/CashFlow.tsx`, top imports):
```tsx
import React, { useState, useEffect, useCallback } from 'react';
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  Wallet,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { formatMoney } from '@agentbook/i18n';
import { useTenantCurrency } from '../hooks/useTenantCurrency';
```
Replace with:
```tsx
import React, { useState, useEffect, useCallback } from 'react';
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  Wallet,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { formatMoney } from '@agentbook/i18n';
import { useTenantCurrency } from '../hooks/useTenantCurrency';
import { TaxDisclaimer } from '../components/TaxDisclaimer';
```

Find:
```tsx
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          Forecast and analyze cash flow with scenario modeling
        </p>
      </div>

      {/* Current balance */}
```
Replace with:
```tsx
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          Forecast and analyze cash flow with scenario modeling
        </p>
      </div>

      <div className="mb-6">
        <TaxDisclaimer />
      </div>

      {/* Current balance */}
```

- [ ] **Step 10: Build check**

Run: `cd plugins/agentbook-tax/frontend && npm run build`
Expected: build succeeds with no new TypeScript/Vite errors. Confirm the bundle size grew only slightly (one small new component, referenced from 8 places).

- [ ] **Step 11: Commit**

```bash
git add plugins/agentbook-tax/frontend/src/components/TaxDisclaimer.tsx plugins/agentbook-tax/frontend/src/pages/TaxDashboard.tsx plugins/agentbook-tax/frontend/src/pages/WhatIf.tsx plugins/agentbook-tax/frontend/src/pages/Reports.tsx plugins/agentbook-tax/frontend/src/pages/PastFilings.tsx plugins/agentbook-tax/frontend/src/pages/TaxPackage.tsx plugins/agentbook-tax/frontend/src/pages/Quarterly.tsx plugins/agentbook-tax/frontend/src/pages/Analytics.tsx plugins/agentbook-tax/frontend/src/pages/CashFlow.tsx
git commit -m "feat(legal): shared TaxDisclaimer component on all 8 tax-figure pages"
```

---

### Task 3: Age-attestation checkbox on signup (email/password path)

**Files:**
- Modify: `apps/web-next/src/app/(auth)/register/register-form.tsx`
- Modify: `apps/web-next/src/app/api/v1/auth/register/route.ts`
- Test: `apps/web-next/src/__tests__/api/v1/auth/register-route.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: the `POST /api/v1/auth/register` request body gains a required `ageConfirmed: boolean` field; the route 400s if it's not `true`.

**Context:** today the only "consent" UI is a static, unlinked sentence below the form ("By creating an account, you agree to our Terms and Privacy Policy") — not a checkbox, not required, not wired to submission. There is no age field or age check anywhere in the signup flow. This task turns that static sentence into a required checkbox that both confirms age (18+) and carries the existing Terms/Privacy consent language, gated both client-side (UX) and server-side (defense in depth, since the client check alone can be bypassed by calling the API directly). **OAuth signup (the "Continue with Google" button) does not go through this route and is not gated by this task** — flagging this as an accepted, out-of-scope gap rather than silently ignoring it; closing it would require changes to the OAuth callback flow, a materially different code path.

- [ ] **Step 1: Add `ageConfirmed` to form state**

Find (in `apps/web-next/src/app/(auth)/register/register-form.tsx`):
```tsx
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    confirmPassword: '',
    displayName: '',
  });
```
Replace with:
```tsx
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    confirmPassword: '',
    displayName: '',
    ageConfirmed: false,
  });
```

- [ ] **Step 2: Validate it in `handleSubmit`, and send it to the API**

Find:
```tsx
    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (formData.password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch(`${API_BASE}/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: formData.email,
          password: formData.password,
          displayName: formData.displayName,
          ...(ref ? { ref } : {}),
        }),
      });
```
Replace with:
```tsx
    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (formData.password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (!formData.ageConfirmed) {
      setError('Please confirm you are at least 18 and agree to the Terms and Privacy Policy');
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch(`${API_BASE}/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: formData.email,
          password: formData.password,
          displayName: formData.displayName,
          ageConfirmed: formData.ageConfirmed,
          ...(ref ? { ref } : {}),
        }),
      });
```

- [ ] **Step 3: Replace the static disclosure paragraph with a required checkbox, inside the form**

Find:
```tsx
        <button
          type="submit"
          disabled={isLoading}
          className="w-full py-2.5 bg-gradient-to-b from-brand-bright to-brand-primary text-[#04231b] rounded-lg text-sm font-semibold transition hover:brightness-105 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {isLoading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Creating account...
            </>
          ) : (
            'Create account'
          )}
        </button>
      </form>
```
Replace with:
```tsx
        <label className="flex items-start gap-2 text-[11px] text-muted-foreground/60 cursor-pointer">
          <input
            type="checkbox"
            name="ageConfirmed"
            checked={formData.ageConfirmed}
            onChange={(e) => setFormData(prev => ({ ...prev, ageConfirmed: e.target.checked }))}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-muted-foreground/40 accent-brand-primary"
            required
          />
          <span>
            I confirm I am at least 18 years old and agree to the{' '}
            <Link href="/legal/terms" className="hover:text-muted-foreground transition-colors">
              Terms
            </Link>{' '}
            and{' '}
            <Link href="/legal/privacy" className="hover:text-muted-foreground transition-colors">
              Privacy Policy
            </Link>
            .
          </span>
        </label>

        <button
          type="submit"
          disabled={isLoading}
          className="w-full py-2.5 bg-gradient-to-b from-brand-bright to-brand-primary text-[#04231b] rounded-lg text-sm font-semibold transition hover:brightness-105 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {isLoading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Creating account...
            </>
          ) : (
            'Create account'
          )}
        </button>
      </form>
```

Then find and delete the now-redundant static paragraph further down in the same file (its links still point at the dead `/terms` / `/privacy` paths, since nothing earlier in this plan touches this file):
```tsx
      <p className="mt-3 text-center text-[11px] text-muted-foreground/60">
        By creating an account, you agree to our{' '}
        <Link href="/terms" className="hover:text-muted-foreground transition-colors">
          Terms
        </Link>{' '}
        and{' '}
        <Link href="/privacy" className="hover:text-muted-foreground transition-colors">
          Privacy Policy
        </Link>
      </p>
```
Delete it entirely — do not replace with anything; the checkbox added in this step already carries this exact consent language, with working `/legal/terms` and `/legal/privacy` links.

- [ ] **Step 4: Gate the API route on `ageConfirmed`**

Find (in `apps/web-next/src/app/api/v1/auth/register/route.ts`):
```ts
    const body = await request.json();
    const { email, password, displayName } = body;
    // Referral attribution: prefer an explicit body value, else the ab_ref cookie.
    const ref =
      (typeof body.ref === 'string' && body.ref) || request.cookies.get('ab_ref')?.value || undefined;

    if (!email || !password) {
      return errors.badRequest('Email and password are required');
    }

    await register(email, password, displayName, ref);
```
Replace with:
```ts
    const body = await request.json();
    const { email, password, displayName, ageConfirmed } = body;
    // Referral attribution: prefer an explicit body value, else the ab_ref cookie.
    const ref =
      (typeof body.ref === 'string' && body.ref) || request.cookies.get('ab_ref')?.value || undefined;

    if (!email || !password) {
      return errors.badRequest('Email and password are required');
    }
    if (ageConfirmed !== true) {
      return errors.badRequest('You must confirm you are at least 18 years old to register');
    }

    await register(email, password, displayName, ref);
```

- [ ] **Step 5: Write the route test**

Create `apps/web-next/src/__tests__/api/v1/auth/register-route.test.ts`:
```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const registerFn = vi.fn();
const rateLimitFn = vi.fn();

vi.mock('@/lib/api/auth', () => ({
  register: (...a: unknown[]) => registerFn(...a),
}));

vi.mock('@/lib/api/rate-limit', () => ({
  enforceRateLimit: (...a: unknown[]) => rateLimitFn(...a),
}));

import { POST } from '@/app/api/v1/auth/register/route';

function req(body: unknown): NextRequest {
  return new NextRequest('http://x/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  registerFn.mockReset();
  rateLimitFn.mockReset();
  rateLimitFn.mockReturnValue(null); // no rate limiting in tests
  registerFn.mockResolvedValue(undefined);
});

describe('POST /api/v1/auth/register — age-attestation gate', () => {
  it('400s when ageConfirmed is missing entirely', async () => {
    const res = await POST(req({ email: 'a@example.com', password: 'password123' }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/18 years old/i);
    expect(registerFn).not.toHaveBeenCalled();
  });

  it('400s when ageConfirmed is explicitly false', async () => {
    const res = await POST(req({ email: 'a@example.com', password: 'password123', ageConfirmed: false }));
    expect(res.status).toBe(400);
    expect(registerFn).not.toHaveBeenCalled();
  });

  it('400s when ageConfirmed is a truthy non-boolean (e.g. the string "true")', async () => {
    // Strict `!== true` check — a client sending the string "true" instead of
    // the boolean must not slip through.
    const res = await POST(req({ email: 'a@example.com', password: 'password123', ageConfirmed: 'true' }));
    expect(res.status).toBe(400);
    expect(registerFn).not.toHaveBeenCalled();
  });

  it('succeeds when ageConfirmed is true and email/password are present', async () => {
    const res = await POST(req({ email: 'a@example.com', password: 'password123', displayName: 'A', ageConfirmed: true }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(registerFn).toHaveBeenCalledWith('a@example.com', 'password123', 'A', undefined);
  });

  it('still 400s on missing email/password before the age check runs', async () => {
    const res = await POST(req({ ageConfirmed: true }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/Email and password/i);
    expect(registerFn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run the tests**

Run: `cd apps/web-next && npx vitest run src/__tests__/api/v1/auth/register-route.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 7: Build check on the frontend file**

Run: `cd apps/web-next && npx tsc --noEmit 2>&1 | grep -i "register-form\|auth/register/route"`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add apps/web-next/src/app/\(auth\)/register/register-form.tsx apps/web-next/src/app/api/v1/auth/register/route.ts apps/web-next/src/__tests__/api/v1/auth/register-route.test.ts
git commit -m "feat(legal): required age-attestation checkbox + server-side gate on signup"
```

---

### Task 4: Privacy policy and Terms of Service copy updates (review checkpoint before merge)

**Files:**
- Modify: `apps/web-next/src/app/legal/privacy/page.tsx`
- Modify: `apps/web-next/src/app/legal/terms/page.tsx`

**Interfaces:** none — these are freestanding pages with no props, no data fetching, no consumers elsewhere in the codebase besides the links fixed in Tasks 1 and 3.

**This task carries the Global Constraint's review checkpoint.** Implement and commit the copy below exactly as specified (so the diff is concrete and reviewable, not a vague future promise), but **do not proceed to Task 5 (final verification / PR / merge) until this task's last step — presenting the diff to the user — has actually happened and the user has responded.** If the user requests changes to the copy, make them, re-commit, and re-present before moving on.

- [ ] **Step 1: Add Supabase to the privacy policy's sub-processor list, and add jurisdiction + minimum-age language**

Find (in `apps/web-next/src/app/legal/privacy/page.tsx`):
```tsx
      <h1>Privacy Policy</h1>
      <p className="text-sm text-muted-foreground">Last updated: 2026-05-24</p>
```
Replace with:
```tsx
      <h1>Privacy Policy</h1>
      <p className="text-sm text-muted-foreground">Last updated: 2026-07-17</p>
```

Find:
```tsx
        <li>
          <strong>Google (Gemini)</strong> — LLM inference. Conversation
          excerpts are sent for classification; we do not opt into training
          data sharing.
        </li>
        <li>
          <strong>Vercel</strong> — application hosting and edge delivery.
        </li>
      </ul>
```
Replace with:
```tsx
        <li>
          <strong>Google (Gemini)</strong> — LLM inference. Conversation
          excerpts are sent for classification; we do not opt into training
          data sharing.
        </li>
        <li>
          <strong>Vercel</strong> — application hosting and edge delivery.
        </li>
        <li>
          <strong>Supabase</strong> — primary database. All financial records,
          account information, and agent-conversation history are stored
          here.
        </li>
      </ul>
```

Find:
```tsx
      <h2>4. Your rights</h2>
```
Replace with:
```tsx
      <h2>4. Regional privacy rights</h2>
      <p>
        Depending on where you live, additional laws may apply to how we
        handle your data — for example, the Personal Information Protection
        and Electronic Documents Act (PIPEDA) in Canada, and the Privacy Act
        1988 in Australia. The rights described in the next section (export,
        deletion, and disconnecting a connected service) are available to
        every AgentBook user regardless of jurisdiction, and are intended to
        satisfy the access and deletion rights those laws provide.
      </p>

      <h2>5. Your rights</h2>
```

Find (the remaining headings need renumbering by one, since a new "4. Regional privacy rights" section was inserted before what was "4. Your rights"):
```tsx
      <h2>5. Retention</h2>
```
Replace with:
```tsx
      <h2>6. Retention</h2>
```

Find:
```tsx
      <h2>6. Security</h2>
```
Replace with:
```tsx
      <h2>7. Security</h2>
```

Find:
```tsx
      <h2>7. Contact</h2>
```
Replace with:
```tsx
      <h2>8. Contact</h2>
```

Find (append a new minimum-age section right before Contact, which is now section 8):
```tsx
      <h2>8. Contact</h2>
      <p>
        Email <a href="mailto:privacy@agentbook.io">privacy@agentbook.io</a>{' '}
        for any privacy question or to request a deletion outside the
        self-serve endpoint.
      </p>
    </main>
  );
}
```
Replace with:
```tsx
      <h2>8. Children's privacy</h2>
      <p>
        AgentBook is not directed to, and is not intended for use by, anyone
        under the age of 18. We do not knowingly collect personal information
        from anyone under 18. If you believe a child has provided us with
        personal information, contact us at the address below and we will
        delete it.
      </p>

      <h2>9. Contact</h2>
      <p>
        Email <a href="mailto:privacy@agentbook.io">privacy@agentbook.io</a>{' '}
        for any privacy question or to request a deletion outside the
        self-serve endpoint.
      </p>
    </main>
  );
}
```

- [ ] **Step 2: Add an age clause and expand the refund clause on the Terms page**

Find (in `apps/web-next/src/app/legal/terms/page.tsx`):
```tsx
      <h1>Terms of Service</h1>
      <p className="text-sm text-muted-foreground">Last updated: 2026-05-24</p>
```
Replace with:
```tsx
      <h1>Terms of Service</h1>
      <p className="text-sm text-muted-foreground">Last updated: 2026-07-17</p>
```

Find:
```tsx
      <h2>2. Account</h2>
      <p>
        You are responsible for keeping your login credentials secure. You may
        not use the service in violation of any applicable law, or to process
        data on behalf of third parties without their consent.
      </p>
```
Replace with:
```tsx
      <h2>2. Account</h2>
      <p>
        You are responsible for keeping your login credentials secure. You may
        not use the service in violation of any applicable law, or to process
        data on behalf of third parties without their consent. You must be at
        least 18 years old, or the age of majority in your jurisdiction if
        that is older than 18, to create an account or use AgentBook. By
        registering, you represent that you meet this requirement.
      </p>
```

Find:
```tsx
      <h2>3. Subscriptions and billing</h2>
      <p>
        Paid plans are billed monthly or annually through Stripe. Plans renew
        automatically at the end of each period. You can cancel at any time
        from Settings; access continues until the end of the paid period and
        no refund is issued for the remainder. Past-due accounts may be
        suspended after a 7-day grace window.
      </p>
```
Replace with:
```tsx
      <h2>3. Subscriptions and billing</h2>
      <p>
        Paid plans are billed monthly or annually through Stripe. Plans renew
        automatically at the end of each period. You can cancel at any time
        from Settings; access continues until the end of the paid period and
        no refund is issued for the remainder. Past-due accounts may be
        suspended after a 7-day grace window.
      </p>
      <p>
        Add-on subscriptions (for example, Student Success, Tax Fast-Track,
        Startup Tax Benefits, and Personal Insights) are billed annually in
        advance, with no monthly option. The same no-refund policy applies:
        canceling an add-on stops the next year's renewal, but access
        continues for the remainder of the year you already paid for, and no
        partial-year refund is issued.
      </p>
```

- [ ] **Step 3: Build check**

Run: `cd apps/web-next && npx tsc --noEmit 2>&1 | grep -i "legal/privacy\|legal/terms"`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add apps/web-next/src/app/legal/privacy/page.tsx apps/web-next/src/app/legal/terms/page.tsx
git commit -m "docs(legal): add Supabase disclosure, jurisdiction + age language, annual add-on refund clause"
```

- [ ] **Step 5: STOP — present the drafted copy to the user for review**

This step is not optional and is not satisfied by anything automated. Show the user:
- The full rendered diff of both files from this task (`git diff` for exactly the two commits in this task, or the two files' final content).
- A short summary of what changed and why, matching the Global Constraints section above (Supabase disclosure, PIPEDA/Privacy Act 1988 mention, new "Children's privacy" section, age clause on Terms, expanded add-on refund clause).
- An explicit call-out that the age threshold used is 18, and an invitation to change it if a different number is wanted given AgentBook's student user base.

Wait for the user's explicit response before proceeding to Task 5. If they request wording changes, make them, commit again, and re-present. Do not merge, push, or open a PR before this checkpoint clears.

---

### Task 5: Full verification, PR, and rollout

**Files:** none (verification-only task).

- [ ] **Step 1: Confirm Task 4's review checkpoint cleared**

Before doing anything else in this task, confirm the user has explicitly approved (or approved-with-edits, already applied) the Task 4 copy. If not, stop and go back to Task 4 — do not proceed.

- [ ] **Step 2: Run the full affected test suites**

Run: `cd apps/web-next && npx vitest run`
Expected: no failures beyond the same pre-existing/unrelated pattern already established this session (confirm any failure exists on a clean `origin/main` checkout, and isn't in a file this branch touches, before treating it as pre-existing).

- [ ] **Step 3: Typecheck**

Run: `cd apps/web-next && npx tsc --noEmit`
Expected: no new errors in any file this branch touches.

- [ ] **Step 4: Build the tax plugin frontend and copy it to the CDN path**

```bash
cd plugins/agentbook-tax/frontend && npm run build
cp dist/production/agentbook-tax.js ../../../apps/web-next/public/cdn/plugins/agentbook-tax/agentbook-tax.js
cp dist/production/agentbook-tax.js ../../../apps/web-next/public/cdn/plugins/agentbook-tax/1.0.0/agentbook-tax.js
```
Commit the rebuilt CDN bundle alongside the source (per this session's established "Plugin frontend deploy" practice — the built artifact must be committed, not just the source). If `git add` on files under `public/cdn` or `dist/production` is refused due to `.gitignore`, use `git add -f` (these paths are already-tracked, gitignored-by-default build artifacts — this repo's established pattern for committing plugin bundle rebuilds).

- [ ] **Step 5: Manual local verification**

Start the local dev servers (see this repo's `CLAUDE.md` Quick Start). Confirm, against `localhost`:
- The homepage footer shows working Terms/Privacy links that land on `/legal/terms` and `/legal/privacy` with the updated content.
- The register page shows the new checkbox, is unchecked by default, and clicking "Create account" without checking it shows the "Please confirm you are at least 18..." error and does not submit.
- Checking the box and submitting a real signup succeeds normally (same as before this branch).
- Each of `WhatIf.tsx`'s (`/agentbook/tax` → What If tab), `Reports.tsx`, `PastFilings.tsx`, `TaxPackage.tsx`, `Quarterly.tsx`, `Analytics.tsx`, and `CashFlow.tsx`'s pages render the disclaimer box, and `TaxDashboard.tsx`'s settings tab still renders it exactly as before (now via the shared component).

- [ ] **Step 6: Final whole-branch review**

Dispatch a code-reviewer subagent pointed at the full diff from `origin/main` to this branch's HEAD. Ask it to specifically verify: (a) both legal pages' heading numbers are internally consistent after the Task 4 renumbering (no duplicate or skipped section numbers); (b) the `ageConfirmed !== true` check in the API route can't be bypassed by a non-boolean truthy value (e.g., the string `"true"`) — confirm the test in Task 3 actually proves this; (c) `register-form.tsx` has no leftover reference to the deleted static Terms/Privacy paragraph or to the old `/terms` / `/privacy` link targets anywhere in the file; (d) every one of the 8 tax pages imports `TaxDisclaimer` from the correct relative path (`../components/TaxDisclaimer`) and none accidentally duplicated the disclaimer JSX inline instead of using the import.

- [ ] **Step 7: Push, open PR, wait for CI**

Follow this session's established pattern: push the branch, open a PR describing the fix (explicitly noting in the PR description that the legal copy was reviewed and approved by the user before merge — reference how/when that happened), wait for CI. The chronic pre-existing `Audit`/`Build`/`Quality-Gates`/`Shell-Tests` failure pattern (confirmed unrelated to this branch's diff) is expected and safe to merge past once independently re-confirmed via `gh run view --job --log` for this specific PR's run.

- [ ] **Step 8: Production rollout**

This PR has no schema migration and no production-data write of any kind — it's a pure code/content deploy. After merge: deploy via the established `vercel build --prod` + `vercel deploy --prebuilt --prod` flow. Manually verify in production: visit `agentbook.brainliber.com`, confirm the footer Terms/Privacy links work and show the updated copy, confirm the register page shows the checkbox and blocks submission when unchecked, and spot-check at least 2 of the 7 previously-missing tax pages for the disclaimer.
