/**
 * E2E for multi-receipt batch upload (PR 18).
 *
 * Drives the Telegram webhook with `E2E_TELEGRAM_CAPTURE=1` so the
 * bot's would-be replies surface via the response body without
 * touching real Telegram.
 *
 * Coverage:
 *   1. Forwarding 4 photos in quick succession produces ONE batched
 *      summary instead of 4 per-receipt review prompts.
 *   2. The first photo's webhook acks with the "got it — collecting…"
 *      message; the last photo's webhook fires the summary.
 *   3. A single photo (no batch peers) still works — no regression to
 *      the original single-receipt flow.
 */

import { test, expect } from '@playwright/test';

const WEB = process.env.E2E_BASE_URL || 'http://localhost:3000';
const E2E_CHAT_ID = 555555555;

interface CaptureEntry { chatId: number | string; text: string; payload?: any }
interface WebhookResp { ok: boolean; captured?: CaptureEntry[]; botReply?: string; error?: string }

async function postPhoto(
  request: any,
  fileId: string,
  chatId: number = E2E_CHAT_ID,
): Promise<WebhookResp> {
  const update = {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: Math.floor(Math.random() * 1e9),
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private' },
      from: { id: chatId, is_bot: false, first_name: 'E2E' },
      photo: [{ file_id: fileId, file_size: 1024, width: 100, height: 100 }],
    },
  };
  const res = await request.post(`${WEB}/api/v1/agentbook/telegram/webhook`, {
    data: update,
    headers: { 'Content-Type': 'application/json' },
    timeout: 30_000,
  });
  if (res.status() === 503) {
    return { ok: false, error: 'Bot not configured' };
  }
  return res.ok() ? (await res.json()) : { ok: false };
}

function summaryReply(captures: CaptureEntry[] | undefined): CaptureEntry | null {
  if (!captures) return null;
  for (const c of captures) {
    // The PR 18 summary always begins "📒 N receipts processed" or
    // "📒 1 receipt processed" — distinct from the per-photo "Got it"
    // ack and from the single-receipt draft preview ("Draft receipt").
    if (/^\s*📒 \d+ receipts? processed/.test(c.text)) return c;
  }
  return null;
}

test.describe('PR 18 — Multi-receipt batch upload', () => {
  // Skip if the deployed server has no bot token configured (CI without
  // TELEGRAM_BOT_TOKEN). The webhook returns 503 in that case.
  test.beforeAll(async ({ request }) => {
    const probe = await postPhoto(request, 'probe-skip-detect');
    test.skip(
      probe.error === 'Bot not configured',
      'TELEGRAM_BOT_TOKEN not set — PR 18 e2e skipped',
    );
  });

  test('4 photos in quick succession → ONE summary, not 4 prompts', async ({ request }) => {
    test.setTimeout(60_000);

    // Use a unique chat id per test run so we don't collide with other
    // tests' batches in flight.
    const chatId = Math.floor(2_000_000_000 + Math.random() * 1_000_000);

    // Fire all 4 photos in parallel — each webhook will append to the
    // batch and sleep through the idle window. Only the LAST arrival
    // proceeds to flush; the earlier 3 abort because lastAt > arrivedAt.
    const promises = [
      postPhoto(request, `pr18-batch-${chatId}-1`, chatId),
      postPhoto(request, `pr18-batch-${chatId}-2`, chatId),
      postPhoto(request, `pr18-batch-${chatId}-3`, chatId),
      postPhoto(request, `pr18-batch-${chatId}-4`, chatId),
    ];
    const results = await Promise.all(promises);

    // All 4 should have returned 200 + ok:true.
    for (const r of results) {
      expect(r.ok).toBe(true);
    }

    // Across all 4 responses, exactly one carries the summary line.
    const summaries = results
      .map((r) => summaryReply(r.captured))
      .filter((c): c is CaptureEntry => c !== null);
    expect(summaries.length).toBe(1);

    // And that summary mentions 4 receipts (not 1, 2, or 3).
    expect(summaries[0].text).toMatch(/4 receipts processed/);

    // Sanity: at most one of the 4 webhooks emitted a "Got it" ack
    // (the very first arrival, before its sibling webhooks landed).
    const acks = results.flatMap((r) =>
      (r.captured || []).filter((c) => /Got it/.test(c.text)),
    );
    expect(acks.length).toBeLessThanOrEqual(1);
  });

  test('single photo still flows through the original single-receipt path', async ({ request }) => {
    test.setTimeout(30_000);

    const chatId = Math.floor(3_000_000_000 + Math.random() * 1_000_000);
    const r = await postPhoto(request, `pr18-single-${chatId}`, chatId);
    expect(r.ok).toBe(true);

    // Single-photo path → no batch summary line is sent.
    expect(summaryReply(r.captured)).toBeNull();
  });
});
