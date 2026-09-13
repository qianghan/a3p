import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The nightly e2e drives the bot through ONE synthetic chat id (555555555,
 * tests/e2e/nightly/helpers/telegram.ts). `resolveTenantId` used to bind that
 * chat to whichever tenant owns the bot token, before ever consulting
 * CHAT_TO_TENANT_FALLBACK — so every nightly run wrote its test expenses into
 * a real user's books ("Spent $25 at Uber…" against Maya's, in prod).
 *
 * Source-reading rather than behavioural: `resolveTenantId` is module-private
 * and talks to Prisma on the first line of the path under test.
 */
const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const ROUTE = readFileSync(join(ROOT, 'apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts'), 'utf8');
const fn = ROUTE.slice(ROUTE.indexOf('async function resolveTenantId('), ROUTE.indexOf('\n}\n', ROUTE.indexOf('async function resolveTenantId(')) + 3);

describe('resolveTenantId', () => {
  it('maps the e2e capture chat to its own tenant BEFORE the bot-token lookup', () => {
    const capture = fn.indexOf('isE2eCaptureChat(chatId)');
    const lookup = fn.indexOf('abTelegramBot.findFirst');
    expect(capture).toBeGreaterThan(-1);
    expect(lookup).toBeGreaterThan(capture);
    expect(fn).toMatch(/isE2eCaptureChat\(chatId\)[\s\S]{0,200}CHAT_TO_TENANT_FALLBACK\[chatStr\]/);
  });
});
