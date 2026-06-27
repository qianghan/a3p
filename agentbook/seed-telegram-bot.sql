-- Register the live Telegram bot binding for Maya in the naap DB.
--
-- AgentBook's webhook (apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts)
-- resolves chatId → tenantId by:
--   1. db.abTelegramBot.findFirst({ botToken, enabled }) — preferred
--   2. Scanning all enabled bots for one whose chatIds array contains the chatId
--   3. Falling back to a hardcoded CHAT_TO_TENANT_FALLBACK map (old UUIDs;
--      do not rely on these for new tenants — add a DB row instead)
--
-- This script inserts the binding for @Agentbookdev_bot ↔ chat 5336658682
-- (Qiang) ↔ tenant usr_maya_seed_001 (maya@agentbook.test).
--
-- The botToken value below is a placeholder — replace it with the real token
-- before running, or set `:bot_token` via psql -v.

\set bot_token `echo "${TELEGRAM_BOT_TOKEN:-PLACEHOLDER_SET_TELEGRAM_BOT_TOKEN_BEFORE_RUNNING}"`

BEGIN;

INSERT INTO plugin_agentbook_core."AbTelegramBot"
  (id, "tenantId", "botToken", "botUsername", "chatIds", "webhookUrl", enabled, "createdAt", "updatedAt")
VALUES (
  'tgbot_maya_001',
  'usr_maya_seed_001',
  :'bot_token',
  'Agentbookdev_bot',
  '["5336658682"]'::jsonb,
  'https://a3book.brainliber.com/api/v1/agentbook/telegram/webhook',
  true,
  now(),
  now()
)
ON CONFLICT ("tenantId") DO UPDATE
SET "botToken"    = EXCLUDED."botToken",
    "botUsername" = EXCLUDED."botUsername",
    "chatIds"     = EXCLUDED."chatIds",
    "webhookUrl"  = EXCLUDED."webhookUrl",
    enabled       = true,
    "updatedAt"   = now();

COMMIT;

SELECT id, "tenantId", "botUsername", "chatIds", enabled
FROM plugin_agentbook_core."AbTelegramBot";
