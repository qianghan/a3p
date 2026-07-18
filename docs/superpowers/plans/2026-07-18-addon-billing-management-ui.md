# Add-on Subscribe/View/Cancel UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the single highest-revenue-impact gap in the launch-readiness audit: a user can see every add-on they're subscribed to, subscribe to a new one, and cancel an existing one, entirely from the UI — replacing `BillingTab()`'s "contact support to cancel" text and complete absence of any add-on section.

**Architecture:** This turns out to be primarily a UI-wiring task, not new backend infrastructure — investigation found the full Stripe subscribe/cancel/reactivate backend for both core plans AND add-ons already exists and works (`me/subscription/{cancel,reactivate}`, `me/addons/[code]/{subscribe,cancel}`, `me/subscription/intent` for SetupIntent-based payment-method collection), and a complete, working `SubscribeModal` component (Stripe Elements `PaymentElement` + `confirmSetup` + real charge) already exists for core plans — it's just never been generalized to add-ons or actually rendered anywhere for them. This plan: (1) extends the one add-on route that's genuinely incomplete (`me/addons` GET only supports single-code lookup, no "list all"), (2) generalizes `SubscribeModal` into a shared component both core plans and add-ons can use, (3) adds a real add-ons section + a real cancel button to `BillingTab()`, and (4) fixes `personal/page.tsx`'s teaser (which currently calls the subscribe route directly with no `paymentMethodId`, and admits in its own code comment that it will fail) to use the same shared modal instead of its broken direct-fetch call.

**Tech Stack:** Next.js API routes, Prisma, Stripe (`@stripe/react-stripe-js`, `@stripe/stripe-js`), React.

## Global Constraints

- No new Stripe backend logic — every subscribe/cancel/reactivate route this plan wires into the UI already exists, is already correct, and is out of scope to modify (except the one GET route extension in Task 1).
- Reuse `SubscribeModal`'s existing Stripe Elements pattern for add-ons — don't build a second, parallel payment-collection component.
- `personal/page.tsx`'s broken teaser gets FIXED by reuse, not by patching its own direct-fetch call to add a payment form inline — that would duplicate the modal this plan is building anyway.
- This PR does not touch Stripe product/price configuration itself (already correctly set up per the prior roadmap's PR-4a) — purely the UI/API-wiring layer on top of it.

---

### Task 1: Extend `me/addons` GET to list all add-ons with the tenant's subscription status

**Files:**
- Modify: `apps/web-next/src/app/api/v1/agentbook-billing/me/addons/route.ts`
- Test: `apps/web-next/src/__tests__/api/v1/agentbook-billing/me-addons-route.test.ts` (check if a test file already exists for this route first)

**Interfaces:**
- Produces: `GET /api/v1/agentbook-billing/me/addons` (no query params) → `{ addons: Array<{ code: string; name: string; description: string; active: boolean; price: { priceCents: number; currency: string; tier: string } | null }> }`, consumed by Task 3 (BillingTab) and Task 4 (personal/page.tsx).

- [ ] **Step 1: Read the current file in full**, plus `apps/web-next/src/app/api/v1/agentbook-billing/addons/route.ts` (the catalog-listing route) and `packages/billing/src/addons.ts`'s `activeAddOnCodes`/`resolveAddOnPrice` functions, to confirm exact current shapes before changing anything.

- [ ] **Step 2: Write failing tests** covering: (a) a tenant with one active add-on and the catalog containing 3 add-ons gets a 3-item list with exactly one `active: true`; (b) a tenant with zero active add-ons gets all `active: false`; (c) each add-on's `price` reflects the tenant's own region (resolve region the same way the existing single-code branch already does — read that code first); (d) the tenant's region comes from `abTenantConfig.jurisdiction` (mirroring how other billing routes already resolve region — check `me/addons/[code]/subscribe/route.ts`'s `region` handling for the established convention, though that route receives it from the request body rather than looking it up — decide the most consistent approach after reading both).

- [ ] **Step 2: Run tests, confirm they fail** (the list branch doesn't exist yet).

- [ ] **Step 3: Implement the list branch**, keeping the existing single-`?code=` branch for backward compatibility (`personal/page.tsx`'s CURRENT behavior depends on it until Task 4 changes it in the same PR — order these tasks so nothing is broken mid-PR, or update both in the same commit):

```ts
export async function GET(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  if (!code) {
    // List all active add-ons with this tenant's subscription status.
    const cfg = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    const region = cfg?.jurisdiction || 'us';
    const [catalog, activeCodes] = await Promise.all([
      prisma.billAddOn.findMany({ where: { isActive: true } }),
      activeAddOnCodes(tenantId),
    ]);
    const addons = await Promise.all(catalog.map(async (a) => ({
      code: a.code,
      name: a.name,
      description: a.description,
      active: activeCodes.has(a.code),
      price: await resolveAddOnPrice(a.code, region),
    })));
    return NextResponse.json({ addons });
  }

  // Existing single-code lookup, unchanged.
  const active = await hasAddOn(tenantId, code);
  const price = await resolveAddOnPrice(code, region);
  return NextResponse.json({ active, price });
}
```

Adapt import names (`prisma`/`db`, whichever this file already uses) and the `billAddOn` field names (`name`/`description`) to match the real current schema — read `packages/database/prisma/schema.prisma`'s `BillAddOn` model first to confirm exact field names before assuming.

- [ ] **Step 4: Run tests, confirm they pass.**

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook-billing/me/addons/route.ts apps/web-next/src/__tests__/api/v1/agentbook-billing/me-addons-route.test.ts
git commit -m "feat(billing): extend me/addons GET to list all add-ons with tenant status"
```

---

### Task 2: Generalize `SubscribeModal` into a shared component for both core plans and add-ons

**Files:**
- Modify: `apps/web-next/src/components/settings/SubscribeModal.tsx`

**Interfaces:**
- Produces: `SubscribeModal` now accepts a `target` prop describing WHAT is being subscribed to and WHERE to POST — either a core plan (`{ kind: 'plan'; id: string; name: string; priceCents: number; interval: string }`) or an add-on (`{ kind: 'addon'; code: string; name: string; priceCents: number; interval: string; region: string }`) — and posts to the correct endpoint (`/me/subscription` with `{planId, paymentMethodId}`, or `/me/addons/{code}/subscribe` with `{region, paymentMethodId}`) based on `target.kind`.

- [ ] **Step 1: Read the current `SubscribeModal.tsx` in full** (already reviewed during planning — re-read for exact line numbers before editing).

- [ ] **Step 2: Widen the `Plan` interface into a discriminated union** and update `SubscribeForm`'s submit handler to branch on `target.kind`:

```tsx
interface PlanTarget {
  kind: 'plan';
  id: string;
  name: string;
  priceCents: number;
  interval: string;
}

interface AddonTarget {
  kind: 'addon';
  code: string;
  name: string;
  priceCents: number;
  interval: string;
  region: string;
}

type SubscribeTarget = PlanTarget | AddonTarget;

interface Props {
  target: SubscribeTarget;
  onClose: () => void;
  onSubscribed: () => void;
}
```

In `handleSubmit`, after obtaining `paymentMethodId`:

```tsx
      const endpoint = target.kind === 'plan'
        ? '/api/v1/agentbook-billing/me/subscription'
        : `/api/v1/agentbook-billing/me/addons/${target.code}/subscribe`;
      const body = target.kind === 'plan'
        ? { planId: target.id, paymentMethodId }
        : { region: target.region, paymentMethodId };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
```

Update every other reference to `plan.name`/`plan.priceCents`/`plan.interval` in the file to `target.name`/`target.priceCents`/`target.interval` (both union members share these three fields, so no further branching is needed for display).

- [ ] **Step 3: Update `BillingTab()`'s existing core-plan usage** (in `AgentBookSettingsPanel.tsx`) to pass `target={{ kind: 'plan', id: p.id, name: p.name, priceCents: p.priceCents, interval: p.interval }}` instead of `plan={p}` — this is a small, mechanical follow-on change within this same task since `SubscribeModal`'s prop name changed from `plan` to `target`.

- [ ] **Step 4: Manual verification** — no existing test file covers `SubscribeModal.tsx` (confirm by checking); this is a client-side Stripe Elements component that can't be meaningfully unit-tested without a live Stripe test-mode key, so verification here is a careful read-through confirming both branches compile and the existing core-plan flow's behavior is provably unchanged (same endpoint, same body shape, same success/error handling) — do this check explicitly and say so in the report.

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/components/settings/SubscribeModal.tsx apps/web-next/src/components/settings/AgentBookSettingsPanel.tsx
git commit -m "refactor(billing): generalize SubscribeModal to support both plans and add-ons"
```

---

### Task 3: Real add-ons section + real cancel button in `BillingTab()`

**Files:**
- Modify: `apps/web-next/src/components/settings/AgentBookSettingsPanel.tsx` (`BillingTab()`, ~lines 740-806)

**Interfaces:**
- Consumes: Task 1's extended `me/addons` GET, Task 2's generalized `SubscribeModal`.
- Produces: nothing consumed by a later task in this plan.

- [ ] **Step 1: Read the current `BillingTab()` in full** (already reviewed during planning — re-confirm exact current line numbers before editing, since Task 2 may have already shifted them).

- [ ] **Step 2: Add add-on state and a fetch call**, alongside the existing `plans`/`current` state:

```tsx
  const [addons, setAddons] = useState<Array<{ code: string; name: string; description: string; active: boolean; price: { priceCents: number; currency: string; tier: string } | null }>>([]);
  const [subscribeAddonTarget, setSubscribeAddonTarget] = useState<typeof addons[number] | null>(null);
  const [cancelingAddon, setCancelingAddon] = useState<string | null>(null);
```

Extend the existing `load()` callback's `Promise.all` to also fetch `/api/v1/agentbook-billing/me/addons` (no query string) and `setAddons(j.addons ?? [])`.

- [ ] **Step 3: Render an "Add-ons" section** below the existing core-plan grid, before the final `<p>` line:

```tsx
      {addons.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-1 mt-2">Add-ons</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {addons.map((a) => (
              <div key={a.code} className={`rounded-xl border p-4 ${a.active ? 'border-primary' : 'border-border'} bg-card`}>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-sm font-semibold text-foreground">{a.name}</p>
                  {a.active && <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary">Active</span>}
                </div>
                {a.description && <p className="text-xs text-muted-foreground mt-1">{a.description}</p>}
                {a.price && <p className="text-lg font-bold text-foreground mt-1.5">{fmt(a.price.priceCents)}<span className="text-xs font-normal text-muted-foreground">/mo</span></p>}
                {a.active ? (
                  <button
                    onClick={async () => {
                      setCancelingAddon(a.code);
                      await fetch(`/api/v1/agentbook-billing/me/addons/${a.code}/cancel`, { method: 'POST' });
                      setCancelingAddon(null);
                      load();
                    }}
                    disabled={cancelingAddon === a.code}
                    className="mt-3 w-full rounded-lg border border-destructive/30 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-60"
                  >
                    {cancelingAddon === a.code ? 'Canceling…' : 'Cancel'}
                  </button>
                ) : a.price ? (
                  <button
                    onClick={() => setSubscribeAddonTarget(a)}
                    className="mt-3 w-full rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                  >
                    Subscribe
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      )}
      {subscribeAddonTarget?.price && (
        <SubscribeModal
          target={{
            kind: 'addon',
            code: subscribeAddonTarget.code,
            name: subscribeAddonTarget.name,
            priceCents: subscribeAddonTarget.price.priceCents,
            interval: 'month',
            region: /* tenant's own region, resolved the same way Task 1's route resolved it — thread this value down from wherever BillingTab already has it, or fetch it once here */,
          }}
          onClose={() => setSubscribeAddonTarget(null)}
          onSubscribed={() => { setSubscribeAddonTarget(null); load(); }}
        />
      )}
```

Resolve the `region` value by checking whether `BillingTab` (or a parent component) already has the tenant's jurisdiction available (e.g. from a shared settings context) — read the surrounding component tree first rather than adding a redundant fetch if the value is already in scope.

- [ ] **Step 4: Replace the "contact support to cancel" text** with a real cancel/reactivate control for the core plan, using the already-correct `current.status`/`cancelAtPeriodEnd` data (extend the `current` state to also carry `cancelAtPeriodEnd` from the `/me/subscription` GET response, which `getCurrentPlan` already returns):

```tsx
      {current?.code && current.code !== 'free' && (
        current.cancelAtPeriodEnd ? (
          <div className="flex items-center gap-2">
            <p className="text-xs text-muted-foreground">Your plan cancels at the end of the current period.</p>
            <button onClick={async () => { await fetch('/api/v1/agentbook-billing/me/subscription/reactivate', { method: 'POST' }); load(); }}
              className="text-xs font-medium text-primary hover:underline">
              Reactivate
            </button>
          </div>
        ) : (
          <button onClick={async () => { await fetch('/api/v1/agentbook-billing/me/subscription/cancel', { method: 'POST' }); load(); }}
            className="text-xs font-medium text-destructive hover:underline">
            Cancel plan
          </button>
        )
      )}
```

Remove the old `<p className="text-xs text-muted-foreground">To cancel your plan, contact support...</p>` line entirely.

- [ ] **Step 5: Manual verification** — read through the full updated `BillingTab()` once more to confirm state flows correctly (loading states, the modal only opens when a real price exists, cancel/reactivate calls both trigger a `load()` refresh).

- [ ] **Step 6: Commit**

```bash
git add apps/web-next/src/components/settings/AgentBookSettingsPanel.tsx
git commit -m "feat(billing): real add-on subscribe/cancel UI + core-plan cancel/reactivate"
```

---

### Task 4: Fix `personal/page.tsx`'s broken upgrade teaser

**Files:**
- Modify: `apps/web-next/src/app/(dashboard)/personal/page.tsx`

**Interfaces:**
- Consumes: Task 1's extended `me/addons` list route, Task 2's generalized `SubscribeModal`.

- [ ] **Step 1: Read the current file's relevant section in full** (the `upgradeToPersonalInsights` function and its call site, already identified during planning at ~lines 364-393 and ~461).

- [ ] **Step 2: Replace the broken direct-fetch call with the shared modal.** Remove `upgradeToPersonalInsights`, `upgrading`, `upgradeError` entirely. Add:

```tsx
  const [showAddonSubscribe, setShowAddonSubscribe] = useState(false);
  const [addonPrice, setAddonPrice] = useState<{ priceCents: number } | null>(null);

  useEffect(() => {
    fetch('/api/v1/agentbook-billing/me/addons')
      .then((r) => r.json())
      .then((j) => {
        const pi = (j.addons ?? []).find((a: { code: string }) => a.code === 'personal_insights');
        if (pi?.price) setAddonPrice(pi.price);
      })
      .catch(() => {});
  }, []);
```

Update the teaser button's `onClick` to `() => setShowAddonSubscribe(true)` (only rendering the button when `addonPrice` is set, so a region with no configured price doesn't show a button that would fail), and render the modal conditionally:

```tsx
      {showAddonSubscribe && addonPrice && (
        <SubscribeModal
          target={{ kind: 'addon', code: 'personal_insights', name: 'Personal Insights', priceCents: addonPrice.priceCents, interval: 'month', region: jurisdiction }}
          onClose={() => setShowAddonSubscribe(false)}
          onSubscribed={() => { setShowAddonSubscribe(false); load(); }}
        />
      )}
```

Import `SubscribeModal` from `@/components/settings/SubscribeModal`. Reuse the page's existing `jurisdiction` variable for `region` (already referenced in the old broken call) and its existing `load` function to refresh the unlocked state on success.

- [ ] **Step 3: Manual verification** — confirm the teaser button no longer references the removed broken function, and that the new flow reuses the exact same modal Task 3 wired into Settings (one real subscribe path, not two).

- [ ] **Step 4: Commit**

```bash
git add "apps/web-next/src/app/(dashboard)/personal/page.tsx"
git commit -m "fix(personal): use the shared SubscribeModal instead of a broken direct-fetch upgrade"
```

## Self-Review

- Spec coverage: closes the roadmap's PR US-9 entry in full — every add-on is subscribable/viewable/cancelable from Settings, the core-plan "contact support" text is replaced with a real cancel/reactivate flow, and the one other broken subscribe call site (`personal/page.tsx`) is fixed by reuse rather than a second broken implementation.
- Placeholder scan: the one open item (Task 3 Step 3's region-resolution comment) is a real, disclosed judgment call for the implementer to resolve by reading the surrounding component — not a missing requirement, since the exact mechanism depends on what's already in scope in that file.
- Scope check: no changes to Stripe configuration, pricing, or the already-correct backend subscribe/cancel/reactivate routes (Task 1 only ADDS a list branch, doesn't change the existing single-code behavior other files might still rely on before Task 4 removes that dependency).
