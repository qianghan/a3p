-- Migration: AbTelegramLink — one-click Telegram connect (P0-4)
--
-- Tenants link to the centrally-owned official AgentBook Telegram bot via a
-- deep link (t.me/<bot>?start=<linkCode>) instead of creating their own bot
-- via @BotFather. Mirrors AbWhatsAppLink. The BYO-bot path (AbTelegramBot)
-- is untouched and remains as the advanced option.
--
-- NOT APPLIED — the owner must apply this to agentbook-db (Supabase) via
-- `prisma migrate deploy` or the Supabase SQL editor before the link/unlink
-- API routes are exercised. Purely additive: one new table, no changes to
-- existing tables.
--
-- Idempotent: uses IF NOT EXISTS / guarded index creation so re-running
-- is safe.

CREATE TABLE IF NOT EXISTS "plugin_agentbook_core"."AbTelegramLink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "chatIds" JSONB NOT NULL DEFAULT '[]',
    "linkCode" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbTelegramLink_pkey" PRIMARY KEY ("id")
);

-- Unique constraints (guarded for idempotency)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'AbTelegramLink_tenantId_key'
    ) THEN
        ALTER TABLE "plugin_agentbook_core"."AbTelegramLink"
            ADD CONSTRAINT "AbTelegramLink_tenantId_key" UNIQUE ("tenantId");
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'AbTelegramLink_linkCode_key'
    ) THEN
        ALTER TABLE "plugin_agentbook_core"."AbTelegramLink"
            ADD CONSTRAINT "AbTelegramLink_linkCode_key" UNIQUE ("linkCode");
    END IF;
END
$$;
