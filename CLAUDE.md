# A3P — Agent as a Product

## AgentBook

AgentBook is an AI-powered accounting system for freelancers and small businesses. 4 plugins, 140 API endpoints, 41 Prisma models, 26 frontend pages, Gemini LLM integration, Telegram bot, Plaid bank sync.

### Context Files (load these when working on AgentBook)

| File | When to Load | What It Contains |
|------|-------------|-----------------|
| `agentbook/skills/architecture.md` | Architecture questions, adding endpoints/models, debugging | System overview, plugin structure, schema layout, API map, auth flow |
| `agentbook/skills/product.md` | Feature questions, user stories, competitive analysis | Target users, differentiators, feature inventory, key workflows |
| `agentbook/skills/workflows.md` | Implementation tasks, "how do I add X?" | File locations, dev patterns, testing guide, common operations |
| `agentbook/users.md` | Testing, login credentials | Test accounts, seed data commands, local dev startup |
| `agentbook/user-story.md` | Product planning, what users can do | 73 user stories across 10 categories, value scoring |

**Load the relevant skill file before answering questions or making changes.** This avoids re-exploring the codebase each session.

### Quick Start

```bash
docker compose up -d database
cd packages/database
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap" npx --no prisma db push --skip-generate

# Backends
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap" PORT=4050 npx tsx plugins/agentbook-core/backend/src/server.ts &
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap" PLAID_CLIENT_ID="69d02fa4f1949b000dbfc51e" PLAID_SECRET="59be40029c47288c4db4acfd79ae56" PLAID_ENV="sandbox" PORT=4051 npx tsx plugins/agentbook-expense/backend/src/server.ts &
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap" PORT=4052 npx tsx plugins/agentbook-invoice/backend/src/server.ts &
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap" PORT=4053 npx tsx plugins/agentbook-tax/backend/src/server.ts &

# Frontend (needs 4GB)
cd apps/web-next && NODE_OPTIONS="--max-old-space-size=4096" npm run dev
```

### Test Accounts

| Persona | Email | Password |
|---------|-------|----------|
| Maya (CA consultant) | `maya@agentbook.test` | `agentbook123` |
| Alex (US agency) | `alex@agentbook.test` | `agentbook123` |
| Jordan (side-hustle) | `jordan@agentbook.test` | `agentbook123` |
| Admin | `admin@a3p.io` | `a3p-dev` |

Re-seed: `npx tsx agentbook/seed-personas.ts`

### Telegram Bot

Bot: `@Agentbookdev_bot` → mapped to Maya's account (chat ID `5336658682` → Maya's user ID).

```bash
./agentbook/start-telegram.sh   # starts tunnel + registers webhook
```

Token in `apps/web-next/.env.local`. Chat-to-tenant mapping in `apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts` (`CHAT_TO_TENANT`).

### Plaid Sandbox

Client ID: `69d02fa4f1949b000dbfc51e` | Secret: `59be40029c47288c4db4acfd79ae56` | Creds: `user_good` / `pass_good`

### E2E Tests

```bash
cd tests/e2e && npx playwright test --config=playwright.config.ts
```

### Building Plugin Frontends

```bash
cd plugins/<name>/frontend && npm run build
cp dist/production/<name>.js ../../apps/web-next/public/cdn/plugins/<name>/<name>.js
cp dist/production/<name>.js ../../apps/web-next/public/cdn/plugins/<name>/1.0.0/<name>.js
```
