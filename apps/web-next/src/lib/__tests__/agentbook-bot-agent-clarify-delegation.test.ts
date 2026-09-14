// @vitest-environment node
/**
 * Regression coverage for the Telegram adapter swallowing bulk requests.
 *
 * Observed (nightly 34791458397, phase6b): the user said "Categorize them"
 * with no active expense draft. The adapter's own Gemini intent layer read
 * that as `categorize`, found no matching category name, downgraded itself to
 * `clarify`, and `evaluate()` answered "🤔 What would you like to categorize?"
 * with `delegatedToBrain: false` — so the brain's categorize-expenses skill
 * never ran at all.
 *
 * The adapter's intents are micro-flows around the ACTIVE expense draft
 * (confirm / reject / "that was Travel"). Bulk skills belong to the brain,
 * which holds the thread and 80+ skills. So: with no active expense and no
 * deliberate slot fill in flight, an unsure adapter delegates instead of
 * asking.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('server-only', () => ({}));

import {
  evaluate,
  type BotContext,
  type BotIntent,
  type ExecResult,
  type PlanStep,
} from '../agentbook-bot-agent';

const baseCtx: BotContext = { tenantId: 't1', active: null, categories: [] };

const activeExpense = {
  id: 'exp-1',
  vendorName: 'Starbucks',
  amountCents: 1250,
  categoryName: null,
  isPersonal: false,
  status: 'pending_review',
} as unknown as NonNullable<BotContext['active']>;

const clarifyIntent = (question: string): BotIntent => ({
  intent: 'clarify',
  slots: { clarifyingQuestion: question },
  confidence: 0.4,
  reason: 'unsure',
} as unknown as BotIntent);

const steps: PlanStep[] = [
  { id: 's1', skill: 'meta.clarify', args: { question: 'What would you like to categorize?', candidates: [] }, dependsOn: [] },
];

describe('evaluate() — clarify with no active expense delegates to the brain', () => {
  it('delegates "Categorize them" instead of asking back', () => {
    const results: ExecResult[] = [
      { stepId: 's1', success: true, data: { kind: 'clarify', question: 'What would you like to categorize?' } },
    ];

    const ev = evaluate(
      clarifyIntent('What would you like to categorize?'),
      steps,
      results,
      { ...baseCtx, active: null },
    );

    expect(ev.delegatedToBrain).toBe(true);
    expect(ev.reply).toBe('');
  });

  it('still asks when there IS an active expense — the adapter owns that draft', () => {
    const results: ExecResult[] = [
      { stepId: 's1', success: true, data: { kind: 'clarify', question: 'Which category — Meals or Travel?' } },
    ];

    const ev = evaluate(
      clarifyIntent('Which category — Meals or Travel?'),
      steps,
      results,
      { ...baseCtx, active: activeExpense },
    );

    expect(ev.delegatedToBrain).toBe(false);
    expect(ev.reply.startsWith('🤔')).toBe(true);
    expect(ev.reply).toContain('Which category');
  });

  it('still asks on a needs_clarify_partial slot fill even with no active expense', () => {
    const results: ExecResult[] = [
      {
        stepId: 's1',
        success: true,
        data: {
          kind: 'needs_clarify_partial',
          intent: 'create_invoice_from_chat',
          partialSlots: { clientNameHint: 'Acme' },
          awaiting: 'amountCents',
          question: 'Got <b>Acme</b> — how much?',
        },
      },
    ];

    const ev = evaluate(
      clarifyIntent('Got Acme — how much?'),
      steps,
      results,
      { ...baseCtx, active: null },
    );

    expect(ev.delegatedToBrain).toBe(false);
    expect(ev.reply.startsWith('🤔')).toBe(true);
    expect(ev.reply).toContain('how much');
  });

  it('still asks on a needs_clarify result even with no active expense', () => {
    const results: ExecResult[] = [
      {
        stepId: 's1',
        success: true,
        data: { kind: 'needs_clarify', question: 'Which client is "Acme"?' },
      },
    ];

    const ev = evaluate(
      clarifyIntent('Which client is "Acme"?'),
      steps,
      results,
      { ...baseCtx, active: null },
    );

    expect(ev.delegatedToBrain).toBe(false);
    expect(ev.reply.startsWith('🤔')).toBe(true);
  });

  it('still asks while a multi-turn slot fill is pending', () => {
    const results: ExecResult[] = [
      { stepId: 's1', success: true, data: { question: 'How much?' } },
    ];

    const ev = evaluate(
      clarifyIntent('How much?'),
      steps,
      results,
      {
        ...baseCtx,
        active: null,
        conversation: {
          pendingSlots: { intent: 'create_invoice_from_chat', filled: { clientNameHint: 'Acme' }, awaiting: 'amountCents' },
        },
      },
    );

    expect(ev.delegatedToBrain).toBe(false);
    expect(ev.reply.startsWith('🤔')).toBe(true);
  });
});

describe('adapter intent prompt — bulk categorize is not the categorize intent', () => {
  // apps/web-next/src/lib/__tests__ -> apps/web-next/src/lib
  const SRC = readFileSync(join(__dirname, '..', 'agentbook-bot-agent.ts'), 'utf8');

  it('RULES tells the model to route bulk categorize/review to the brain', () => {
    const rules = SRC.slice(SRC.indexOf('\nRULES'), SRC.indexOf('\nOUTPUT'));
    expect(rules.length).toBeGreaterThan(0);
    expect(rules).toContain('categorize them');
    expect(rules).toMatch(/NOT categorize/);
    expect(rules).toMatch(/use unrelated so the agent brain handles it/);
  });

  it('keeps the existing active-expense categorize rule', () => {
    expect(SRC).toContain('For categorize, slots.categoryName MUST be one of the available list above.');
  });
});
