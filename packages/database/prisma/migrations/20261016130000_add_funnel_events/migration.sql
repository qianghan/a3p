-- Migration: AbFunnelEvent — product funnel analytics (P0-7)
--
-- One row per funnel transition (signup, trial start, first expense/report,
-- card added, paid, cancelled). properties is PII-free by construction —
-- trackFunnelEvent() allowlists keys (see packages/billing/src/funnel.ts).
--
-- NOT APPLIED — the owner must apply this to agentbook-db (Supabase) via
-- `prisma migrate deploy` or the Supabase SQL editor before funnel tracking
-- routes are exercised. Purely additive: one new table.
--
-- Idempotent: uses IF NOT EXISTS / guarded index creation so re-running
-- is safe.

CREATE TABLE IF NOT EXISTS "plugin_agentbook_core"."AbFunnelEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "anonymousId" TEXT,
    "event" TEXT NOT NULL,
    "properties" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbFunnelEvent_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'AbFunnelEvent_event_createdAt_idx') THEN
        CREATE INDEX "AbFunnelEvent_event_createdAt_idx"
            ON "plugin_agentbook_core"."AbFunnelEvent"("event", "createdAt");
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'AbFunnelEvent_tenantId_createdAt_idx') THEN
        CREATE INDEX "AbFunnelEvent_tenantId_createdAt_idx"
            ON "plugin_agentbook_core"."AbFunnelEvent"("tenantId", "createdAt");
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'AbFunnelEvent_anonymousId_idx') THEN
        CREATE INDEX "AbFunnelEvent_anonymousId_idx"
            ON "plugin_agentbook_core"."AbFunnelEvent"("anonymousId");
    END IF;
END
$$;
