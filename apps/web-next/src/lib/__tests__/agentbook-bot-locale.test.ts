/**
 * The Telegram bot's per-update locale scope.
 *
 * The bug this closes: the webhook formatted every amount with a literal '$'
 * and every date with a hardcoded 'en-US', while reading AbTenantConfig in
 * nine separate places without ever looking at `locale`. A GBP tenant was
 * shown a dollar sign on a pound amount.
 *
 * The bug this AVOIDS is the more dangerous one. The obvious fix — a
 * module-level `let currentLocale` — is silently wrong on Vercel: Fluid
 * Compute serves concurrent requests from one instance, so tenant B's update
 * can start while tenant A's is awaiting the database. Last writer wins, and
 * tenant A is shown tenant B's currency.
 *
 * That failure is invisible to any test that sends one update at a time, so
 * the isolation cases below deliberately interleave two.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { runWithBotLocale, botLoc, hasBotLocale } from '../agentbook-bot-locale';
import { OUTBOUND_FALLBACK } from '../agentbook-outbound-format';

const CA_FR = { locale: 'fr-CA', currency: 'CAD', timezone: 'America/Toronto' };
const AU_EN = { locale: 'en-AU', currency: 'AUD', timezone: 'Australia/Sydney' };
const CN_ZH = { locale: 'zh-CN', currency: 'CNY', timezone: 'Asia/Shanghai' };

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('runWithBotLocale', () => {
  it('puts the tenant locale in scope for the whole call tree', () => {
    runWithBotLocale(CA_FR, () => {
      expect(botLoc()).toEqual(CA_FR);
    });
  });

  it('survives awaits, however deep — the shape the webhook actually has', async () => {
    await runWithBotLocale(AU_EN, async () => {
      await tick();
      const deep = async () => {
        await tick();
        const deeper = async () => {
          await tick();
          return botLoc();
        };
        return deeper();
      };
      expect(await deep()).toEqual(AU_EN);
    });
  });

  it('falls back to en-US outside any scope, rather than throwing', () => {
    // An unwrapped path must degrade to the old behaviour. Throwing here
    // would mean a crash inside composing a reply — a silent bot.
    expect(hasBotLocale()).toBe(false);
    expect(botLoc()).toEqual(OUTBOUND_FALLBACK);
  });

  it('falls back per field when the config row is partial', () => {
    runWithBotLocale({ locale: 'fr-CA' }, () => {
      expect(botLoc().locale).toBe('fr-CA');
      expect(botLoc().currency).toBe(OUTBOUND_FALLBACK.currency);
    });
  });

  it('falls back when there is no config row at all', () => {
    runWithBotLocale(null, () => expect(botLoc()).toEqual(OUTBOUND_FALLBACK));
  });
});

describe('isolation between concurrent updates', () => {
  it('two interleaved updates never see each other locale', async () => {
    // Each "update" yields to the event loop between reads, so if the value
    // lived in a module variable the second run() would overwrite the first
    // and both would report the same locale.
    const seen: string[] = [];

    const update = (row: typeof CA_FR, label: string) =>
      runWithBotLocale(row, async () => {
        seen.push(`${label}:${botLoc().currency}`);
        await tick();
        seen.push(`${label}:${botLoc().currency}`);
        await tick();
        seen.push(`${label}:${botLoc().currency}`);
      });

    await Promise.all([update(CA_FR, 'A'), update(CN_ZH, 'B'), update(AU_EN, 'C')]);

    expect(seen.filter((s) => s.startsWith('A:'))).toEqual(['A:CAD', 'A:CAD', 'A:CAD']);
    expect(seen.filter((s) => s.startsWith('B:'))).toEqual(['B:CNY', 'B:CNY', 'B:CNY']);
    expect(seen.filter((s) => s.startsWith('C:'))).toEqual(['C:AUD', 'C:AUD', 'C:AUD']);
    // And they really did interleave — otherwise this test proves nothing
    // about concurrency, only about sequential calls.
    expect(seen.slice(0, 3)).toEqual(['A:CAD', 'B:CNY', 'C:AUD']);
  });

  it('an inner scope does not leak out to the enclosing one', async () => {
    await runWithBotLocale(CA_FR, async () => {
      await runWithBotLocale(CN_ZH, async () => {
        await tick();
        expect(botLoc().currency).toBe('CNY');
      });
      await tick();
      expect(botLoc().currency).toBe('CAD');
    });
  });

  it('the scope is gone after the update finishes', async () => {
    await runWithBotLocale(CA_FR, async () => {
      await tick();
    });
    expect(hasBotLocale()).toBe(false);
  });

  it('a throwing update does not leave its locale behind', async () => {
    await expect(
      runWithBotLocale(CN_ZH, async () => {
        await tick();
        throw new Error('handler blew up');
      }),
    ).rejects.toThrow('handler blew up');
    expect(hasBotLocale()).toBe(false);
  });
});
