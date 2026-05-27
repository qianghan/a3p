# Building AgentBook Plugins

This guide walks through writing a plugin that adds **a new agent skill** —
something the user can invoke through natural-language chat (web, Telegram,
or any future channel) and have routed to your backend.

You'll build:

1. A plugin server with a single endpoint
2. A skill manifest the agent uses to route to it
3. A registration script that calls the SDK helper from PR 60

The example: a `track-mileage` skill that lets the user say *"I drove 45
miles to client Acme today"* and have it logged.

---

## Architecture

```
┌───────────────────┐      ┌───────────────────────┐      ┌──────────────────┐
│  User chat        │      │  AgentBook agent       │      │  Your plugin     │
│  "drove 45 mi..." │ ───→ │  classifier (regex →  │ ───→ │  POST /run       │
│                   │      │  LLM) picks skill     │      │  inserts row     │
└───────────────────┘      └───────────────────────┘      └──────────────────┘
                                    ↑
                                    │
                              SkillManifest row in DB
                              (registered by your plugin at install time)
```

When a user message arrives:

1. The agent looks up its **enabled** SkillManifest rows for the tenant
   (built-in + plugin-registered + tenant-specific).
2. The classifier tries to match the message against each skill's
   `triggerPatterns` (regex). On match it extracts the declared
   `parameters` and routes to the skill's `endpoint`.
3. Your plugin endpoint receives a normal HTTP request with the extracted
   params in the body. It does the work and returns JSON.

The classifier is fully data-driven — no agent core code change is
needed to add a skill.

---

## Step 1: Write the plugin server

Your plugin runs as a separate Express service (or a Next.js route, or a
serverless function — any HTTP server). Endpoint contract:

```ts
// POST /api/v1/my-mileage-plugin/run
// body: { miles: number, vendorOrClient?: string }
// headers: x-tenant-id (set by the agent for tenant isolation)
// returns: { success: boolean, data?: { entryId: string }, error?: string }

import express from 'express';

const app = express();
app.use(express.json());

app.post('/api/v1/my-mileage-plugin/run', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'] as string;
  const { miles, vendorOrClient } = req.body;

  if (!miles || typeof miles !== 'number') {
    return res.status(400).json({ success: false, error: 'miles is required' });
  }

  // Insert into your plugin's own table (or AbMileageEntry directly).
  const entry = await db.myMileageEntry.create({
    data: { tenantId, miles, clientName: vendorOrClient ?? null },
  });

  return res.json({
    success: true,
    data: { entryId: entry.id, miles, vendorOrClient },
  });
});

app.listen(4060);
```

Key points:

- **Trust `x-tenant-id`**: the agent sets this from its own auth-verified
  session before calling your endpoint. Don't accept a tenantId from the
  body.
- **Return `{ success, data, error }`**: the response template uses this
  shape to render the agent's reply.
- **No agent dependencies**: your plugin doesn't need to import the
  agent's code. It's a vanilla HTTP service.

---

## Step 2: Register the skill at install time

Create an install script that calls the SDK helper from
`@naap/plugin-sdk`:

```ts
// scripts/register-skill.ts
import { registerAgentSkill } from '@naap/plugin-sdk';

await registerAgentSkill({
  baseUrl: process.env.NAAP_BASE_URL!,           // e.g. https://my-deploy.com
  internalAdminSecret: process.env.INTERNAL_ADMIN_SECRET!,
  skill: {
    name: 'track-mileage',
    description: 'Log a business-mileage entry',
    category: 'expense',
    triggerPatterns: [
      'drove\\s+\\d+\\s*(miles?|mi|km)',
      'log\\s+\\d+\\s*(miles?|mi)',
    ],
    parameters: {
      miles: {
        type: 'number',
        required: true,
        extractHint: 'the number of miles in the message',
      },
      vendorOrClient: {
        type: 'string',
        required: false,
        extractHint: 'the client/vendor name after "to" or "for", if present',
      },
    },
    endpoint: {
      method: 'POST',
      url: 'https://my-plugin-host.example.com/api/v1/my-mileage-plugin/run',
    },
    responseTemplate: 'Logged {{miles}} miles{{vendorOrClient}}',
    confirmBefore: false,    // not destructive
  },
});
```

Run it once after deployment. The helper is idempotent — re-running upserts.

**Auth model**: the `/skills/register` endpoint is gated by the
`x-internal-admin` header. In dev when `INTERNAL_ADMIN_SECRET` is unset
the route is open; in production it requires the matching secret. Pass it
in via `process.env.INTERNAL_ADMIN_SECRET`.

---

## Step 3: Verify it works

Run the agent locally, log in, and try:

```
> drove 45 miles to client Acme today
```

The agent should:

1. Match your `triggerPatterns` (regex fast path), bypassing the LLM.
2. Extract `miles=45` and `vendorOrClient='Acme'`.
3. POST to your endpoint.
4. Render your `responseTemplate` filled with the params:
   *"Logged 45 miles Acme"*.

Inspect the skill's manifest via the read API to confirm it's live:

```bash
curl -s -b "naap_auth_token=$TOKEN" \
  https://my-deploy.com/api/v1/agentbook-core/skills | jq '.data.skills[] | select(.name == "track-mileage")'
```

You should see the skill listed with `source: "plugin"`.

---

## Optional: per-tenant skills

If your plugin only makes sense for some tenants, pass a `tenantId` when
you register:

```ts
await registerAgentSkill({
  baseUrl: '...',
  internalAdminSecret: '...',
  skill: {
    name: 'my-tenant-specific-action',
    tenantId: 'tenant-abc-uuid',
    // ...
  },
});
```

The agent will only surface this skill for that tenant.

---

## Optional: confirm-before-execute

For destructive actions (sending an invoice, voiding a payment), set
`confirmBefore: true`. The agent will show a plan preview with
Proceed / Cancel buttons before calling your endpoint. The user has to
explicitly confirm.

```ts
skill: {
  name: 'archive-quarter',
  confirmBefore: true,
  description: 'Archive all transactions in a closed quarter (irreversible)',
  // ...
}
```

The agent's PlanPreview (web) and inline keyboard (Telegram) both handle
this — no plugin-side code change needed.

---

## Removing a skill

To soft-disable a skill (preserves metric history):

```ts
import { unregisterAgentSkill } from '@naap/plugin-sdk';

await unregisterAgentSkill({
  baseUrl: '...',
  internalAdminSecret: '...',
  name: 'track-mileage',
});
```

Disabled skills don't match new utterances but still appear in
admin tooling. To re-enable, call `registerAgentSkill` again with
the same name.

---

## Reference

- **Endpoint**: `POST/DELETE /api/v1/agentbook-core/skills/register`
- **SDK**: `@naap/plugin-sdk` exports `registerAgentSkill`,
  `unregisterAgentSkill`, and typed specs (`AgentSkillSpec`,
  `AgentSkillParameter`, `AgentSkillEndpoint`).
- **Read-side**: `GET /api/v1/agentbook-core/skills` — list capabilities,
  filterable by `category` / `source` / `enabled`.
- **Metrics**: `GET /api/v1/agentbook-core/agent/skills/metrics` —
  per-skill success rate / p50 / p95 / avg confidence (admin-gated).

---

## When NOT to write a skill

A skill is the right surface when the user wants to **do** something
(record an expense, send an invoice). It's not the right surface for:

- **Read-only queries** — those are better served by the
  `general-question` skill which routes to `/ask`. The agent's LLM
  composes a natural answer from the existing data context.
- **Background jobs** — Vercel cron is a better fit. Skills are
  request/response; cron is fire-and-forget.
- **Webhooks from external services** — those have their own routes;
  the agent doesn't need to be in the loop.

---

## Troubleshooting

**Skill registered but the agent doesn't route to it**:

1. Check `enabled: true` in the manifest (`GET /skills`).
2. Verify the `triggerPatterns` regex actually matches the test
   utterance. Try it in a Node REPL: `new RegExp(pattern).test(message)`.
3. Confirm a built-in skill isn't matching FIRST. The classifier walks
   skills in DB order; specific patterns should come first.

**`/skills/register` returns 401**:

Either `INTERNAL_ADMIN_SECRET` is set in the deployment but you didn't
pass it, or you passed the wrong value. The header must be
`x-internal-admin: <secret>` exactly.

**Endpoint receives the request but the user sees an error message**:

The agent's reply formatter expects `{ success: boolean, data?, error? }`.
Returning a 500 or a body without `success: true` triggers the error
copy. Check the error payload renders something user-friendly.
