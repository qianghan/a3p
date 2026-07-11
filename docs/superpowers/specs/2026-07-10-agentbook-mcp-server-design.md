# AgentBook MCP Server — Design

## Goal

Let any MCP-capable AI client (Claude Desktop/Code, and best-effort ChatGPT/Codex)
use AgentBook the same way a user would use its own chat interface — ask
questions, record expenses, create invoices — authenticated via OAuth 2.1 so
onboarding is "add a connector, log in, approve" with no manual API-key
management.

## Context

AgentBook (`apps/web-next` + Express plugin backends) already has a single
conversational entry point, agent-brain's `POST /agentbook-core/agent/message`
(`plugins/agentbook-core/backend/src/agent-brain.ts:445`), which routes free
text across all 77 built-in skills and already implements a preview-then-confirm
gate for destructive actions. Auth today is a custom session-cookie system
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

- **OAuth 2.1 authorization server**: `oidc-provider`-backed, mounted as new
  Next.js routes — `/oauth/authorize`, `/oauth/token`, `/oauth/register`
  (Dynamic Client Registration), `/.well-known/oauth-authorization-server`,
  `/.well-known/oauth-protected-resource`.
- **New Prisma tables** (via a thin adapter satisfying `oidc-provider`'s
  storage interface): OAuth clients, authorization codes, access/refresh
  tokens, consent grants, and a lightweight `McpToolCallAuditLog`. All new
  tables; zero changes to existing schema.
- **MCP server endpoint**: `apps/web-next/src/app/api/mcp/route.ts`, using
  `@modelcontextprotocol/sdk`'s Streamable HTTP transport, exposing the one
  `ask_agentbook` tool.
- **Login/consent reuses the existing session system unmodified.** A user
  hitting `/oauth/authorize` for the first time logs into AgentBook the
  normal way (existing cookie/login page), then sees a one-time consent
  screen ("Claude wants to access your AgentBook — Allow?"). Approval is
  persisted (`ConsentGrant`) so reconnecting later skips the prompt.
- **New "Connected Apps" section in existing Settings** to list and revoke
  authorized MCP clients.

## End-to-end flow

1. User adds a custom connector in Claude pointed at
   `https://agentbook.brainliber.com/api/mcp`.
2. Claude discovers the `.well-known` OAuth metadata, then self-registers as
   a client via Dynamic Client Registration — no manual developer-portal step.
3. Claude opens a browser to `/oauth/authorize` with a PKCE challenge. Login
   (if needed) uses the existing, unmodified login page; then the new consent
   screen.
4. On approval, AgentBook redirects back with an authorization code; Claude
   exchanges it (+ PKCE verifier) at `/oauth/token` for a short-lived access
   token and a refresh token, scoped to a single `agentbook:full` scope (no
   granular per-skill scopes in v1).
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
   existing preview-and-confirm shape unchanged.
3. Rather than handing that preview back as plain text (which a calling model
   could misinterpret and auto-confirm), the MCP route issues an
   **`elicitation/create`** request back to the client — a real MCP-spec
   mechanism for the server to collect a structured response from the
   *human*, not the model. Claude Desktop/Code support this today.
4. Only an explicit human "yes" via elicitation triggers the confirm call
   back to agent-brain that actually executes the write.
5. For clients without elicitation support (expected initially for
   ChatGPT/Codex), the tool falls back to returning the preview as text with
   an explicit instruction that the model must surface it and only re-call
   with confirmation after real user approval. This fallback is a weaker
   guarantee and will be documented as such, not advertised as fully safe
   until those clients add elicitation support.

## Error handling

- Invalid/expired token → `401` + `WWW-Authenticate: Bearer
  error="invalid_token"`; client silently refreshes or re-runs OAuth.
- Revoked consent → all outstanding tokens for that client/user invalidated
  immediately; next call gets the same `401` path.
- Agent-brain downstream failure (5xx/timeout) → MCP tool returns a proper
  MCP error result with a generic message and a logged correlation ID; no
  stack traces or internal URLs leaked.
- Rate limiting on `/oauth/token` and `/api/mcp` (simple per-token/per-IP
  sliding window; no new infra dependency for v1).
- The login page's post-login return-to param (needed so `/oauth/authorize`
  can resume after login) must be allowlisted to same-origin internal paths
  only — open-redirect is a real risk class here and worth explicit guarding.

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
- All new Prisma tables — no existing schema touched.
- All new routes (`/oauth/*`, `/.well-known/oauth-*`, `/api/mcp`) — nothing
  existing calls them; they call agent-brain's already-public endpoint the
  same way web/Telegram already do.
- Agent-brain (classification, skills, confirm-gate) — completely unchanged;
  MCP is a third caller using a new, additive `channel` value.
- Existing login page/session system — reused as-is (plus a same-origin
  allowlisted return-to param if not already present).

The one non-additive touch: `middleware.ts` gets a small, isolated addition
of `/oauth/*` and `/api/mcp` to the existing "handles its own auth" allowlist
— the same pattern already used for every other API route. The existing
web-login E2E suite passing unchanged is the direct proof nothing else
shifted.

The real risk isn't regression to the existing product — it's whether the
*new* OAuth surface is implemented correctly, since this is genuinely new
security-critical code for this codebase. Mitigations: use a vetted library
(`oidc-provider`) instead of hand-rolled crypto, scope v1 to human-confirmed
writes only, and ship behind an `AGENTBOOK_MCP_ENABLED` feature flag so the
entire surface can be killed instantly without a redeploy if an issue
surfaces post-launch — nothing else in the app depends on it.

## Out of scope for v1

- Per-skill/granular OAuth scopes (single `agentbook:full` scope only).
- Multi-tenant/team selection during consent (current model is 1:1
  `tenantId === user.id`; if that invariant changes later, the consent
  screen will need a tenant picker — not needed now).
- Structured per-capability tools (e.g. `list_expenses`, `create_invoice`) —
  possible future phase once the single conversational tool has live usage
  data to justify it.
- Full ChatGPT/Codex validation — best-effort only in v1.
