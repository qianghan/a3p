# Agent Skill Customization — Product & Architecture Design

**Date:** 2026-06-26  
**Status:** Proposed  
**Goal:** Each user grows a personalized accounting agent that learns their vocabulary, habits, and domain — while admins can curate shared skill libraries for all users.

---

## Problem

Today, AgentBook's 16 built-in skills are static and identical for every user. Maya (CA consultant) and Alex (US agency) use the same skill keywords and response patterns. Neither can teach the agent their terminology ("retainer" vs "project fee"), their client nicknames, or their preferred workflows. There is no way to add domain-specific shortcuts or load skills from a file.

---

## Product Design

### Three layers of skills

```
┌─────────────────────────────────────────┐
│  3. User Skills         (per-user)      │  ← "retainer = monthly invoice"
│  2. Tenant/Team Skills  (per-team)      │  ← "Acme = my biggest client"
│  1. Built-in Skills     (platform)      │  ← record-expense, create-invoice …
└─────────────────────────────────────────┘
```

Each layer **extends** the one below — user skills override tenant, which override built-in. The agent tries user → tenant → built-in in that order when classifying intent.

### What a skill is

A skill has:
- **trigger patterns** — phrases/regexes that activate it ("log", "spent", "paid for")
- **intent name** — maps to an executor (inline or HTTP call)
- **description** — shown to LLM as few-shot context
- **examples** — 2–5 natural language examples (used in classification prompt)
- **executor** — either a named built-in or a URL endpoint
- **scope** — `builtin` | `tenant` | `user`
- **owner** — userId or tenantId (null for built-ins)

### User-facing flows

#### 1. Teaching the agent via chat  
The agent captures corrections and habits automatically:
- "No, that should be Travel not Meals" → correction logged, weighting updated
- "I always call coffee 'client meetings'" → alias stored as user skill
- After 3 consistent uses of a term, the agent proposes formalizing it as a personal skill

#### 2. Skill Manager UI (in Core plugin settings tab)
- View all active skills (built-in + custom), toggle on/off per skill
- Edit trigger phrases, add examples for any skill
- Upload a skill YAML/JSON file
- Share a skill to the team (creates tenant-scoped copy)

#### 3. Admin Skill Library (in /admin/billing area or new /admin/skills)
- View all skills across all tiers
- Push a skill to all users (overrides user toggle)
- Create shared tenant skills from the library
- Import/export skill packs as JSON bundles

### Skill file format (user uploadable)

```yaml
# agentbook-skill.yaml
version: 1
skills:
  - name: retainer-invoice
    description: "Create a monthly retainer invoice for a client"
    triggers:
      - "retainer"
      - "monthly fee"
      - "send retainer to"
    examples:
      - "send retainer to TechCorp"
      - "log retainer $5000 for Acme"
    executor:
      type: builtin
      skill: create-invoice
      defaults:
        description: "Monthly retainer"
        interval: monthly
```

### Agent personalization (long-term)

Over time, the agent accumulates:
- **vocabulary map**: user terms → canonical terms ("retainer" → "monthly invoice")
- **client nicknames**: "big fish" → TechCorp Solutions
- **default behaviors**: Maya's expenses are always CAD; Jordan's are USD
- **communication style**: formal/casual, verbose/terse (from feedback patterns)

These are stored in `AbUserMemory` (already exists) with a `category: 'skill_personalization'` tag.

---

## Architecture Design

### New DB model: `AbCustomSkill`

```prisma
model AbCustomSkill {
  id          String   @id @default(cuid())
  tenantId    String?  // null = built-in, set = tenant, paired with userId = user
  userId      String?
  scope       String   // "builtin" | "tenant" | "user"
  name        String
  description String
  triggers    String[] // regex/phrase list
  examples    String[]
  executor    Json     // { type: "builtin"|"url", skill?: string, url?: string, defaults?: {} }
  isEnabled   Boolean  @default(true)
  isCore      Boolean  @default(false) // admin-forced, user cannot disable
  priority    Int      @default(0)     // higher = checked first
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([tenantId, userId])
  @@index([scope, isEnabled])
}
```

### Classification flow change (agent-brain.ts)

```
Current:  shortcuts → regex → LLM (built-in skills only)
New:      shortcuts → user-skills → tenant-skills → built-in skills → LLM

For each tier:
  1. Check trigger patterns (regex match, O(n) over active skills)
  2. If match: execute skill executor
  3. If no match: fall through to next tier
  4. If LLM: pass all 3 tiers as few-shot examples in the classification prompt
```

### API endpoints (new, in agentbook-core backend)

```
GET  /api/v1/agentbook-core/skills              → list effective skills (all tiers)
GET  /api/v1/agentbook-core/skills/user         → user skills only
POST /api/v1/agentbook-core/skills/user         → create user skill
PUT  /api/v1/agentbook-core/skills/user/:id     → update
DEL  /api/v1/agentbook-core/skills/user/:id     → delete
POST /api/v1/agentbook-core/skills/user/import  → upload YAML/JSON
GET  /api/v1/agentbook-core/skills/tenant       → (admin) tenant skills
POST /api/v1/agentbook-core/skills/tenant       → (admin) create tenant skill
POST /api/v1/agentbook-core/skills/tenant/push  → (admin) push skill to all users
```

### Skill Manager UI (new tab in Core plugin)

```
Core Plugin
  ├── Chat (current)
  ├── Setup (chatbot config — Telegram, WhatsApp)   ← issue #2
  └── Skills                                         ← new tab
        ├── Built-in skills (read-only, toggle on/off)
        ├── My Skills (CRUD, import from file)
        └── Team Skills (view shared skills)
```

### Personalization pipeline

```
User correction detected in chat
    ↓
AbUserMemory.upsert({ category: 'skill_personalization', key, value, confidence })
    ↓ (after 3 same corrections, confidence > 0.8)
Agent proposes: "Should I always call this Travel?"
    ↓ (user confirms)
AbCustomSkill.create({ scope: 'user', triggers: [...], executor: { type: 'builtin' } })
```

---

## Implementation Phases

### Phase 1 — Foundation (1 sprint)
- Add `AbCustomSkill` model, migrate schema
- API endpoints for user skill CRUD
- Agent-brain picks up user skills from DB before LLM classification
- Simple list UI in Core plugin "Skills" tab

### Phase 2 — Import/Export & Admin (1 sprint)
- YAML/JSON skill file upload API + UI
- Admin skill library page
- Push-to-all-users capability
- Skill pack format validator

### Phase 3 — Auto-personalization (1 sprint)
- Correction detection in chat → AbUserMemory
- Confidence decay + threshold
- Agent proposal flow ("Should I remember this?")
- Vocabulary/nickname map applied to LLM prompt context

---

## What this is NOT

- No custom code execution (skills call built-in executors or HTTPS endpoints you own — no eval)
- No per-user LLM fine-tuning (prompt injection only)
- No skill marketplace yet (Phase 4, out of scope)
