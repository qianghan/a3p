-- Turn AgentBook's i18n translated strings ON.
--
-- Run in the Supabase SQL editor against the agentbook-db project.
--
-- Three things about this table that break naive SQL, all verified against the
-- live DDL rather than read off the Prisma schema:
--
--   1. "FeatureFlag" is camelCase. Unquoted, Postgres folds it to featureflag
--      and the statement fails with "relation does not exist".
--   2. "id" is text NOT NULL with NO database default — Prisma's
--      @default(uuid()) is generated in application code, so a raw INSERT has
--      to supply it.
--   3. "updatedAt" is likewise NOT NULL with no default; @updatedAt is a Prisma
--      feature, not a trigger.
--
-- Idempotent: safe to run twice, and safe whether or not the row already
-- exists. It returns the resulting row so the outcome is read back rather than
-- assumed.

INSERT INTO public."FeatureFlag" (id, key, enabled, description, "createdAt", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'agentbook.i18n.locales.enabled',
  true,
  'Renders translated UI strings for tenants on fr-CA / zh-CN. Date and money formatting is NOT gated by this.',
  now(),
  now()
)
ON CONFLICT (key) DO UPDATE
  SET enabled = true,
      "updatedAt" = now()
RETURNING key, enabled, "updatedAt";
