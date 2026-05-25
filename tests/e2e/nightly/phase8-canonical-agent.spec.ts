/**
 * Phase 8 — Canonical-utterance agent-quality eval (Tier 1 #4 measurement).
 *
 * Sends every entry from canonical-utterances.ts through
 * POST /api/v1/agentbook-core/agent/message and asserts:
 *   1. The expected skill was invoked (intent accuracy)
 *   2. `required` substrings appear in the response (correctness)
 *   3. `forbidden` substrings do NOT appear (hallucination guard)
 *
 * The suite is tagged @phase8-canonical so CI can opt-in via
 *   --grep "@phase8-canonical"
 *
 * The pass rate per category becomes the rubric's "intent accuracy" number.
 * Multi-turn utterances share a threadId; the runner replays them in order
 * within a single test so the agent has the prior turn in its context.
 */

import { test, expect } from '@playwright/test';
import { loginAsE2eUser } from './helpers/auth';
import { api } from './helpers/api';
import { CANONICAL, type CanonicalUtterance } from './canonical-utterances';

interface AgentResponse {
  success: boolean;
  data?: {
    message?: string;
    skillUsed?: string;
    needsConfirmation?: boolean;
    confidence?: number;
  };
}

async function send(page: import('@playwright/test').Page, text: string) {
  const r = await api(page).post<AgentResponse>(
    '/api/v1/agentbook-core/agent/message',
    { text, channel: 'web' },
  );
  return r;
}

function checkExpectations(
  cu: CanonicalUtterance,
  answer: string,
  skillUsed: string | undefined,
): string[] {
  const failures: string[] = [];

  if (cu.expectedSkill && skillUsed && skillUsed !== cu.expectedSkill) {
    // Only report a mismatch; fail-soft so the rest of the assertions still run.
    failures.push(`expected skill "${cu.expectedSkill}", got "${skillUsed}"`);
  }

  for (const must of cu.required ?? []) {
    if (!answer.includes(must)) {
      failures.push(`missing required substring: "${must}"`);
    }
  }
  for (const forbidden of cu.forbidden ?? []) {
    if (answer.includes(forbidden)) {
      failures.push(`forbidden substring present: "${forbidden}"`);
    }
  }
  return failures;
}

// Group the canonical set by thread so multi-turn utterances run sequentially.
function buildGroups(items: CanonicalUtterance[]) {
  const groups: Array<{ key: string; items: CanonicalUtterance[] }> = [];
  const seenThreads = new Set<string>();
  for (const cu of items) {
    if (cu.isMultiTurn && cu.threadId) {
      if (seenThreads.has(cu.threadId)) continue;
      seenThreads.add(cu.threadId);
      groups.push({
        key: cu.threadId,
        items: items.filter((x) => x.threadId === cu.threadId),
      });
    } else {
      groups.push({ key: cu.id, items: [cu] });
    }
  }
  return groups;
}

test.describe('@phase8-canonical', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsE2eUser(page);
  });

  // One test per (utterance OR multi-turn group). Multi-turn replays in
  // sequence and aggregates per-turn failures into the test result.
  for (const group of buildGroups(CANONICAL)) {
    const groupTitle =
      group.items.length === 1
        ? `${group.items[0].id} — ${group.items[0].text.slice(0, 60)}`
        : `${group.key} — ${group.items.length}-turn thread`;

    test(groupTitle, async ({ page }) => {
      const failures: string[] = [];
      for (const cu of group.items) {
        const res = await send(page, cu.text);
        expect(res.status, `HTTP ${res.status} for "${cu.text}"`).toBe(200);
        expect(res.data?.success, `agent returned success:false for "${cu.text}"`).toBe(true);

        const answer = res.data?.data?.message ?? '';
        const skillUsed = res.data?.data?.skillUsed;
        const turnFailures = checkExpectations(cu, answer, skillUsed);
        for (const f of turnFailures) failures.push(`${cu.id}: ${f}`);
      }
      if (failures.length > 0) {
        // Build a readable failure message — Playwright will surface this in
        // junit-xml + the HTML report so the rubric pass-rate computation can
        // parse it directly.
        const msg = failures.map((f) => `  - ${f}`).join('\n');
        throw new Error(`Canonical-utterance check failed:\n${msg}`);
      }
    });
  }
});
