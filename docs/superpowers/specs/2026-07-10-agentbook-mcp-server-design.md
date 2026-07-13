# AgentBook MCP Server — Design

## Goal

Let any MCP-capable AI client (Claude Desktop/Code, and best-effort ChatGPT/Codex)
use AgentBook the same way a user would use its own chat interface — ask
questions, record expenses, create invoices — authenticated via OAuth 2.1 so
onboarding is "add a connector, log in, approve" with no manual API-key
management.

## Context

AgentBook (`apps/web-next` + Express plugin backends) already has a single
conversational entry point, agent-brain's `POST /api/v1/agentbook-core/agent/message`
(`plugins/agentbook-core/backend/src/agent-brain.ts:445`), which routes free
text across all 77 built-in skills and already implements a preview-then-confirm
gate for destructive actions: a response can carry `data.plan = { steps, requiresConfirmation: true }`
with the human-readable preview in `data.message`, and the write only executes
once a follow-up call passes `sessionAction: 'confirm'` (matched against text
like "yes"/"confirm" via `CONFIRM_RE`, `agent-brain.ts:191,205,480`). Auth today is a custom session-cookie system
(`apps/web-next/src/lib/api/auth.ts`) — OAuth exists only as a *client*
(login via Google/GitHub/Microsoft), never as an *issuer*. There is no existing
MCP code anywhere in the repo. Tenancy is 1:1 (`tenantId === user.id`,
`apps/web-next/src/lib/agentbook-tenant.ts:13`).

Full research findings are in the design conversation this doc was extracted
from; the load-bearing facts are captured above and inline below.

## Decisions

1. **Tool surface**: one MCP tool, `ask_agentbook(message, conversationId?)`,
   thin-wrapping agent-brain's existing endpoint. No per-capability tools in
   v1 — agent-brain's classifier already covers the full skill set and its
   confirm-gate semantics would be lost/duplicated by structured tools.
2. **Write scope**: full read+write (same capability as web/Telegram today),
   but every destructive action requires a **human-visible** confirmation,
   not just an AI-client-relayed one (see Confirmation Flow below).
3. **Client priority**: build to the MCP spec generically; validate
   end-to-end (OAuth + tool calls + elicitation) against Claude Desktop/Code
   for v1. ChatGPT and Codex are tested best-effort; gaps become a later
   phase once their remote-MCP/OAuth support matures.
4. **Architecture**: build the OAuth 2.1 authorization server and MCP
   endpoint natively inside `apps/web-next`, using the `oidc-provider` npm
   library for OAuth protocol correctness (PKCE, token lifecycle, Dynamic
   Client Registration) rather than hand-rolling it. Rejected alternatives:
   a third-party OAuth vendor (unnecessary vendor lock — the protocol is
   already well-served by a vetted library) and a standalone microservice
   (duplicates infra the main app already has — DB, tenant resolution,
   session validation — for a thin façade).

## Architecture

New components, all additive to the existing codebase:

- **OAuth 2.1 authorization server**: `oidc-provider`-backed, mounted under
  `/api/v1/oauth/*` (`authorize`, `token`, `register` for Dynamic Client
  Registration) — deliberately kept under the existing `/api` prefix so it
  needs **no** middleware change. Only the two spec-mandated discovery
  documents, `/.well-known/oauth-authorization-server` and
  `/.well-known/oauth-protected-resource`, sit outside `/api` and need one
  middleware allowlist addition (see Regression risk assessment).
- **New Prisma tables** (via a thin adapter satisfying `oidc-provider`'s
  storage interface): a single generic `OidcModel` table (type+id keyed,
  mirroring `oidc-provider`'s own adapter contract — one table serves every
  token/code/client/grant kind, matching how the library's reference
  adapters work) plus a persisted `McpConsentGrant` table for "skip consent
  on reconnect." All new; zero changes to existing schema. (A tool-call
  audit log was considered and deferred — see Out of scope.)
- **MCP server endpoint**: `apps/web-next/src/app/api/v1/mcp/route.ts`, using
  `@modelcontextprotocol/sdk`'s Streamable HTTP transport, exposing the one
  `ask_agentbook` tool.
- **Login/consent reuses the existing session system unmodified.** A user
  hitting `/api/v1/oauth/authorize` for the first time logs into AgentBook
  the normal way (existing cookie/login page, including its existing
  same-origin-only `?redirect=` guard), then sees a one-time consent screen
  ("Claude wants to access your AgentBook — Allow?"). Approval is persisted
  (`McpConsentGrant`) so reconnecting later skips the prompt.
- **New "Connected Apps" section in existing Settings** to list and revoke
  authorized MCP clients — revocation must actually invalidate the
  underlying `OidcModel` token rows immediately (by grant ID), not just mark
  consent revoked and let tokens expire on their own TTL.

## End-to-end flow

1. User adds a custom connector in Claude pointed at
   `https://agentbook.brainliber.com/api/v1/mcp`.
2. Claude discovers the `.well-known` OAuth metadata, then self-registers as
   a client via Dynamic Client Registration — no manual developer-portal step.
3. Claude opens a browser to `/api/v1/oauth/authorize` with a PKCE challenge.
   Login (if needed) uses the existing, unmodified login page; then the new
   consent screen.
4. On approval, AgentBook redirects back with an authorization code; Claude
   exchanges it (+ PKCE verifier) at `/api/v1/oauth/token` for a short-lived
   access token and a refresh token, scoped to a single `agentbook:full`
   scope (no granular per-skill scopes in v1).
5. Every MCP call carries `Authorization: Bearer <token>`. The MCP route
   validates the token, resolves `userId`/`tenantId` the same way existing
   proxy routes do, and returns `401` + `WWW-Authenticate` on an
   invalid/expired token so the client silently refreshes or re-prompts.
6. A tool call becomes: MCP route → the same internal call the existing
   web/Telegram paths already make to agent-brain, passing `channel: 'mcp'`
   (new, additive enum value) and the resolved `tenantId`. Agent-brain itself
   is untouched.
7. Revoking a connected app in Settings invalidates its tokens server-side
   immediately.

## Confirmation flow for destructive actions

1. `ask_agentbook` is annotated with MCP tool hints `destructiveHint: true`,
   `readOnlyHint: false` so spec-compliant clients apply their own native
   confirmation UI as a first layer of defense.
2. When a request maps to a destructive skill, agent-brain returns its
   existing preview-and-confirm shape unchanged: `data.plan.requiresConfirmation
   === true`, with the human-readable preview text in `data.message`.
3. Rather than handing that preview back as plain text (which a calling model
   could misinterpret and auto-confirm), the MCP route issues an
   **`elicitation/create`** request back to the client — a real MCP-spec
   mechanism for the server to collect a structured response from the
   *human*, not the model. Claude Desktop/Code support this today.
4. Only an explicit human "yes" via elicitation triggers a follow-up call to
   agent-brain with `sessionAction: 'confirm'`, which actually executes the
   write.
5. **v1 requires elicitation support to allow any destructive action** —
   consistent with Decision #3 (Claude first). A client that doesn't
   advertise elicitation capability gets a clear refusal from the tool
   ("this connection doesn't support secure confirmation for actions that
   write data — read-only questions still work") rather than a weaker
   text-relayed confirmation a calling model could auto-approve without a
   real human ever seeing it. A text-relay fallback would reopen exactly the
   gap Decision #2 exists to close, so it's deferred until a real
   non-elicitation client actually needs write access (see Out of scope).

## Error handling

- Invalid/expired token → `401` + `WWW-Authenticate: Bearer
  error="invalid_token"`; client silently refreshes or re-runs OAuth.
- Revoked consent → all outstanding tokens for that client/user invalidated
  immediately; next call gets the same `401` path.
- Agent-brain downstream failure (5xx/timeout) → MCP tool returns a proper
  MCP error result with a generic message and a logged correlation ID; no
  stack traces or internal URLs leaked.
- Rate limiting on `/api/v1/oauth/token` and `/api/v1/mcp` (simple
  per-token/per-IP sliding window; no new infra dependency for v1).
- The login page's post-login return-to param already has a same-origin-only
  guard (`raw.startsWith('/') && !raw.startsWith('//')`,
  `login-form.tsx:31-37`) from before this project — the new
  `/oauth-consent` flow reuses that existing param and guard as-is rather
  than introducing a new redirect mechanism, so open-redirect risk here is
  already covered by existing code, not new surface to secure.

## Testing & validation

- Unit: PKCE validation, token issuance/expiry/refresh/revocation,
  consent-grant persistence, the Prisma adapter feeding `oidc-provider`.
- Integration: a scripted OAuth client exercising the full
  authorize → consent → token → tool-call round trip against a preview
  deploy.
- Live validation: a real Claude Desktop/Code instance connected to a
  deployed preview, run through onboarding, a read-only query, and one full
  destructive-action-with-elicitation flow.
- Regression check: the existing web-login E2E suite must keep passing
  unchanged — the concrete proof the `middleware.ts` touch didn't affect any
  existing route's auth gating.

## Regression risk assessment

**Overall: low.**

Additive, zero-risk-to-existing-product surface:
- All new Prisma tables — no existing schema touched. (`middleware.ts`'s
  `publicRoutes` array already begins with a plain `/api` prefix match that
  runs before any cookie/session gating, so every route under
  `/api/v1/oauth/*` and `/api/v1/mcp` is exempt with zero changes — verified
  against the actual middleware logic, not assumed from the array's
  contents.)
- All new routes — nothing existing calls them; they call agent-brain's
  already-public endpoint the same way web/Telegram already do.
- Agent-brain (classification, skills, confirm-gate) — completely unchanged;
  MCP is a third caller using a new, additive `channel: 'mcp'` string value,
  which agent-brain stores as free-form text with no enum validation to
  break (confirmed in `agent-brain.ts`/`server.ts`).
- Existing login page/session system — reused as-is, including its
  pre-existing return-to redirect guard.

The one non-additive touch: `middleware.ts`'s `publicRoutes` array gets one
line added for `/.well-known` (the two OAuth/MCP discovery documents are the
only part of this design that can't live under the already-exempt `/api`
prefix, per RFC 8414/9728 convention). The existing web-login E2E suite
passing unchanged is the direct proof nothing else shifted.

The real risk isn't regression to the existing product — it's whether the
*new* OAuth surface is implemented correctly, since this is genuinely new
security-critical code for this codebase. Mitigations: use a vetted library
(`oidc-provider`) instead of hand-rolled crypto, scope v1 to human-confirmed
writes only, and ship behind the existing DB-backed `FeatureFlag` mechanism
(key `agentbook.mcp.enabled`) — the same already-tested dark-ship pattern
used elsewhere in this codebase — so the entire surface can be killed
instantly without a redeploy if an issue surfaces post-launch. Also worth
flagging even though it's not "regression" in the strict sense: adding
`oidc-provider` + `@modelcontextprotocol/sdk` to `apps/web-next`'s
dependency tree has a real but bounded cost — bundle size and cold-start
time for the functions that import them — worth an explicit check during
implementation, not just an additive-code argument.

## Out of scope for v1

- Per-skill/granular OAuth scopes (single `agentbook:full` scope only).
- Multi-tenant/team selection during consent (current model is 1:1
  `tenantId === user.id`; if that invariant changes later, the consent
  screen will need a tenant picker — not needed now).
- Structured per-capability tools (e.g. `list_expenses`, `create_invoice`) —
  possible future phase once the single conversational tool has live usage
  data to justify it.
- Full ChatGPT/Codex validation — best-effort only in v1.
- A tool-call audit log — genuinely useful eventually, but nothing in v1
  reads it (no admin view, nothing surfaced in Connected Apps), so it's
  premature: added scope with no v1 consumer. Revisit once there's a real
  need (support debugging, abuse investigation) to shape what it should
  actually capture.
- A text-relayed confirmation fallback for MCP clients without elicitation
  support — deferred per Decision #3/Confirmation Flow item 5 above, since
  it would reopen the exact safety gap Decision #2 exists to close. Build it
  only once a real non-elicitation client needs write access.
