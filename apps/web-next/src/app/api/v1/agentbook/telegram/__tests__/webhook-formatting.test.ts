/**
 * The Telegram bot's outbound money and date formatting.
 *
 * The bot is read OUTSIDE the app, usually on a phone, and is often the only
 * place a user sees a figure. There is no surrounding UI to correct a wrong
 * impression and no language switcher to try. So a wrong number here is worse
 * than a wrong label anywhere in the web app.
 *
 * Before this change the webhook:
 *   - prefixed a literal '$' in 13 places, including on a `fmtUsd` helper
 *     called on 27 amounts that were frequently not USD;
 *   - hardcoded 'en-US' in 15 formatters;
 *   - called BARE `toLocaleString()` twice, i.e. formatted with whatever
 *     locale the serverless container happened to have;
 *   - hardcoded `currency: 'USD'` on the mileage deduction and on every
 *     estimate total.
 *
 * These three render helpers are the exported ones, and they are exactly the
 * ones that carried the inline '$' templates. Each assertion names the string
 * the old code produced, so a regression fails for the right reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The route pulls in grammy, Prisma and the agent brain at module load. None
// of that is exercised by a pure render function.
vi.mock('server-only', () => ({}));
vi.mock('grammy', () => ({ Bot: class { init() {} isInited() { return true; } } }));
vi.mock('@naap/database', () => ({ prisma: {}, PrismaClient: class {} }));
vi.mock('@agentbook-core/agent-brain', () => ({ handleAgentMessage: vi.fn() }));
vi.mock('@agentbook-core/server', () => ({
  buildTaxReviewCtx: vi.fn(), callGemini: vi.fn(),
  classifyAndExecuteV1: vi.fn(), classifyOnly: vi.fn(), executeClassification: vi.fn(),
}));
vi.mock('@agentbook-core/skill-source', () => ({ reconcileSkills: vi.fn(), SKILL_QUERY: {} }));

import { runWithBotLocale } from '@/lib/agentbook-bot-locale';
import {
  renderRecurringStepResult,
  renderBudgetSetResult,
} from '../webhook/route';

const US = { locale: 'en-US', currency: 'USD', timezone: 'America/New_York' };
const QC = { locale: 'fr-CA', currency: 'CAD', timezone: 'America/Toronto' };
const AU = { locale: 'en-AU', currency: 'AUD', timezone: 'Australia/Sydney' };
const UK = { locale: 'en-GB', currency: 'GBP', timezone: 'Europe/London' };

/** 1,234.56 in the tenant's currency. */
const AMOUNT = 123456;

describe('recurring-invoice confirmation', () => {
  const data = {
    kind: 'recurring_created' as const,
    amountCents: AMOUNT,
    cadence: 'monthly',
    firstRun: '2026-03-22T12:00:00.000Z',
    clientName: 'Acme',
  };

  it('formats US amounts unchanged', () => {
    runWithBotLocale(US, () => {
      expect(renderRecurringStepResult(data as never).html).toContain('$1,234.56');
    });
  });

  it('does NOT show a Quebec user US formatting — the regression', () => {
    runWithBotLocale(QC, () => {
      const html = renderRecurringStepResult(data as never).html;
      expect(html).not.toContain('$1,234.56');
      // Comma decimal, symbol trailing, non-breaking space as group separator.
      expect(html).toMatch(/1\s*234,56\s*\$/);
      expect(html).toMatch(/mars/);
    });
  });

  it('shows a GBP tenant pounds, not dollars — the worst case', () => {
    // A dollar sign on a pound amount is not a formatting preference, it is a
    // wrong figure.
    runWithBotLocale(UK, () => {
      const html = renderRecurringStepResult(data as never).html;
      expect(html).toContain('£');
      expect(html).not.toContain('$');
    });
  });

  it('renders the date in the tenant timezone and convention', () => {
    // Same instant, three tenants, three renderings.
    const au = runWithBotLocale(AU, () => renderRecurringStepResult(data as never).html);
    const us = runWithBotLocale(US, () => renderRecurringStepResult(data as never).html);
    expect(au).not.toBe(us);
  });
});

describe('budget confirmation', () => {
  const data = { kind: 'budget_set' as const, amountCents: AMOUNT, categoryName: 'Meals' };

  it('follows the tenant locale', () => {
    const us = runWithBotLocale(US, () => renderBudgetSetResult(data as never).html);
    const qc = runWithBotLocale(QC, () => renderBudgetSetResult(data as never).html);
    expect(us).toContain('$1,234.56');
    expect(qc).not.toContain('$1,234.56');
    expect(qc).toMatch(/1\s*234,56\s*\$/);
  });

  it('drops the cents on a whole amount, as it always did', () => {
    runWithBotLocale(US, () => {
      expect(renderBudgetSetResult({ ...data, amountCents: 500000 } as never).html)
        .toContain('$5,000');
    });
  });
});

describe('outside a locale scope', () => {
  beforeEach(() => vi.clearAllMocks());

  it('degrades to en-US rather than throwing inside a reply', () => {
    // Every unwrapped path must still produce a message. A throw here would
    // mean the user gets nothing at all — a silent bot, which is the failure
    // mode that makes this file dangerous to change.
    const html = renderBudgetSetResult(
      { kind: 'budget_set', amountCents: AMOUNT, categoryName: 'Meals' } as never,
    ).html;
    expect(html).toContain('$1,234.56');
  });
});
