-- Turn AgentBook's i18n translated strings OFF (rollback).
--
-- WHY THE CREATE IS HERE
--
-- The first attempt failed with 'relation "public.FeatureFlag" does not exist'.
-- The model is `@@schema("public")` with no `@@map`, so the name was right —
-- production simply has not got this table. That matters beyond this one flag:
-- isI18nLocalesEnabled() wraps its lookup in try/catch and fails CLOSED, so a
-- missing table means the flag reads false forever, with no error surfaced
-- anywhere. Same for the /api/v1/admin/feature-flags endpoints.
--
-- The DDL below is not hand-written. It is dumped from a database that Prisma
-- itself created from this exact schema, index names included, so a later
-- `prisma db push` sees no drift and will not try to alter it.
--
-- Idempotent end to end: safe to run twice, and safe whether the table and/or
-- the row already exist.

-- 1. What does this database actually have? Read this before trusting the rest.
SELECT
  current_database()                                   AS database,
  to_regclass('public."FeatureFlag"') IS NOT NULL       AS table_exists;

-- 2. Create it if absent, matching Prisma's own DDL exactly.
CREATE TABLE IF NOT EXISTS public."FeatureFlag" (
    id          text NOT NULL,
    key         text NOT NULL,
    enabled     boolean DEFAULT false NOT NULL,
    description text,
    metadata    jsonb,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS "FeatureFlag_key_key"
  ON public."FeatureFlag" USING btree (key);

-- 3. Flip the flag.
--
-- "id" and "updatedAt" are supplied explicitly: both are NOT NULL with no
-- database default, because Prisma's @default(uuid()) and @updatedAt are
-- generated in application code rather than by the database.
INSERT INTO public."FeatureFlag" (id, key, enabled, description, "createdAt", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'agentbook.i18n.locales.enabled',
  false,
  'Renders translated UI strings for tenants on fr-CA / zh-CN. Date and money formatting is NOT gated by this.',
  now(),
  now()
)
ON CONFLICT (key) DO UPDATE
  SET enabled = false,
      "updatedAt" = now()
RETURNING key, enabled, "updatedAt";
