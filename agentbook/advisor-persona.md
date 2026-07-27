# The AgentBook Advisor Persona

AgentBook's assistant is a **named, human-feeling advisor** — not an anonymous
bot. On first contact it introduces itself by name, keeps that name in every
conversation, speaks in a consistent honest voice, learns the user's tone over
time, and shows a friendly avatar in the web chat. The goal is a trust-building,
action-driven relationship — colorful and personal, but always honest.

## Design principles

1. **Human, but honest.** A warm first name and voice, but it *always* discloses
   it's an AI, never claims to be a licensed human accountant, defers big
   legal/tax calls to a professional, and never invents figures.
2. **One voice, everywhere.** Every channel funnels through
   `handleAgentMessage`, so the persona is injected in exactly one place and
   reaches all channels uniformly.
3. **Fallback-guarded.** Every persona touchpoint is non-fatal — if the lookup
   fails, the voice falls back to the generic line and chat keeps working.
4. **Self-iterative.** The persona mirrors the user's style (verbosity, emoji,
   formality, humor) from real conversations, so it grows more personal the more
   they chat.

## Data model

`AbAdvisorPersona` (one row per tenant): `name`, `bornOn` (first-intro − 28y, so
the advisor is "28" and ages), `bio`, `styleProfile`, `avatarUrl`,
`introducedAt`. Created lazily on first contact.

## Pipeline touchpoints (all in `plugins/agentbook-core/backend/src`)

| Concern | Where |
|---|---|
| Name + voice | `advisor-persona.ts` → `buildAdvisorVoice`, `buildAdvisorIdentityPrefix` |
| Self-introduction | `agent-brain.ts` `handleAgentMessage` wrapper (one-time, stamps `introducedAt`) |
| Style learning | `advisor-persona.ts` `learnStyleFromMessages` / `adaptAdvisorStyle`, called after each human-channel reply |
| Avatar | `advisor-persona.ts` `buildAvatarSvg` (deterministic, on-brand, no external image service) |
| Specialized prompts | `server.ts` `resolveAdvisorIdentity` (Q&A, briefing, expense advisor, student-tax, what-if) |
| Proactive tips | `apps/web-next/src/lib/agentbook-digest-tips.ts` (lazy-imports the persona) |
| Web chat UI | `plugins/agentbook-core/frontend/src/pages/Chat.tsx` (header + per-bubble avatar + rename) |
| Rename API | `apps/web-next/src/app/api/v1/agentbook-core/advisor/route.ts` (GET / PATCH) |

## Channel parity — by construction

Parity is not a per-channel feature; it's a property of the architecture.

- **Text-level identity** (name, self-introduction, voice) is baked into
  `data.message` by the brain, so **any** channel that renders the reply text
  gets it for free — including Telegram today, and WhatsApp/MCP/SMS the moment
  their adapter routes through `handleAgentMessage`.
- **UI chrome** (the avatar image, the rename pencil) is carried on
  `data.persona` for rich clients (the web chat). Text-only channels simply
  ignore it — nothing to implement, nothing to break.
- The one opt-out is the **`api`** machine channel (programmatic/tool calls),
  which skips the chatty self-introduction. This is encoded once, as a
  **denylist**, in `isHumanChannel(channel)` — so a newly added channel is
  "human" by default and inherits the full persona automatically.

**Consequence:** WhatsApp and MCP require *zero* persona-specific work. When (if)
those adapters are built, they call `handleAgentMessage` like every other
channel and the named, honest, style-learning advisor comes along for free. The
parity contract is locked by tests in `__tests__/advisor-persona.test.ts`
(`isHumanChannel — the channel-parity contract`).
