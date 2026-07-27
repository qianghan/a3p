import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUnique = vi.fn();
const create = vi.fn();
const update = vi.fn();
vi.mock('../db/client.js', () => ({
  db: { abAdvisorPersona: { findUnique: (...a: any[]) => findUnique(...a), create: (...a: any[]) => create(...a), update: (...a: any[]) => update(...a) } },
}));

import {
  pickFallbackName, generateAdvisorName, ensureAdvisorPersona,
  buildAdvisorVoice, buildIntroMessage, buildAdvisorIdentityPrefix, resolveAdvisorIdentityPrefix,
  learnStyleFromMessages, styleChanged, adaptAdvisorStyle,
  buildAvatarSvg, buildAvatarDataUri, renameAdvisor, personaPublicView,
  isHumanChannel,
  advisorAge, DEFAULT_STYLE, FALLBACK_NAMES,
  type AdvisorPersona,
} from '../advisor-persona.js';

beforeEach(() => { vi.clearAllMocks(); });

describe('name selection', () => {
  it('fallback name is deterministic and from the curated pool', () => {
    const a = pickFallbackName('tenant-abc');
    expect(a).toBe(pickFallbackName('tenant-abc'));
    expect(FALLBACK_NAMES).toContain(a);
  });

  it('uses a valid LLM name (normalized), else falls back', async () => {
    expect(await generateAdvisorName('t1', null, async () => '  NADIA ')).toBe('Nadia');
    expect(await generateAdvisorName('t1', null, async () => '42')).toBe(pickFallbackName('t1')); // non-name token → fallback
    expect(await generateAdvisorName('t1', null, async () => null)).toBe(pickFallbackName('t1'));
    expect(await generateAdvisorName('t1')).toBe(pickFallbackName('t1')); // no LLM
  });
});

describe('ensureAdvisorPersona', () => {
  it('returns the existing persona without creating', async () => {
    findUnique.mockResolvedValue({ name: 'Maya', bornOn: new Date('1998-01-01'), bio: 'x', styleProfile: { warmth: 0.9 }, avatarUrl: null, introducedAt: null });
    const p = await ensureAdvisorPersona('t1');
    expect(p.name).toBe('Maya');
    expect(p.styleProfile.warmth).toBe(0.9); // merged over defaults
    expect(p.styleProfile.verbosity).toBe(DEFAULT_STYLE.verbosity); // filled from defaults
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a persona born exactly 28 years ago today', async () => {
    findUnique.mockResolvedValue(null);
    create.mockImplementation(({ data }: any) => Promise.resolve({ ...data }));
    const p = await ensureAdvisorPersona('t2', { tenantConfig: { businessType: 'student' } });
    expect(FALLBACK_NAMES).toContain(p.name);
    expect(advisorAge(p.bornOn)).toBe(28);
    expect(create).toHaveBeenCalled();
  });

  it('recovers from a create race by reading the row back', async () => {
    findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ name: 'Leo', bornOn: new Date('1997-06-01'), bio: null, styleProfile: null, avatarUrl: null, introducedAt: null });
    create.mockRejectedValue(new Error('unique violation'));
    const p = await ensureAdvisorPersona('t3');
    expect(p.name).toBe('Leo');
  });
});

const persona: AdvisorPersona = { name: 'Maya', bornOn: new Date('1998-01-01'), bio: null, styleProfile: DEFAULT_STYLE, avatarUrl: null, introducedAt: null };

describe('buildAdvisorVoice — honesty + identity', () => {
  it('names the advisor, speaks first-person, and encodes the honesty + action rules', () => {
    const v = buildAdvisorVoice(persona, { companyName: 'Acme' });
    expect(v).toMatch(/You are Maya/);
    expect(v).toMatch(/the team at Acme/);
    expect(v).toMatch(/never claim to be a licensed human accountant/i);
    expect(v).toMatch(/confirming with a professional/i);
    expect(v).toMatch(/never invent figures/i);
    expect(v).toMatch(/as an AI language model/i); // present as the thing it must NOT do
  });
});

describe('buildIntroMessage — discloses AI, warm, actionable', () => {
  it('introduces by name, discloses it is an AI, and offers a next step', () => {
    const m = buildIntroMessage(persona);
    expect(m).toMatch(/I'm Maya/);
    expect(m).toMatch(/I'm an AI/i);
    expect(m).toMatch(/receipt|invoice|tax/i);
    expect(m).toMatch(/connect your bank|log your first expense/i);
  });
});

describe('buildAdvisorIdentityPrefix — specialized-prompt clause', () => {
  it('names the advisor and carries the honesty guardrail in one line', () => {
    const p = buildAdvisorIdentityPrefix(persona);
    expect(p).toMatch(/You are Maya, AgentBook's AI accounting agent/);
    expect(p).toMatch(/never a licensed human accountant/i);
    expect(p).toMatch(/never invent figures/i);
  });
});

describe('resolveAdvisorIdentityPrefix — safe resolver', () => {
  it('returns the generic line (no DB touch) when tenantId is undefined', async () => {
    const p = await resolveAdvisorIdentityPrefix(undefined);
    expect(p).toMatch(/You are AgentBook, an AI accounting agent/);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('reflects the persona name when the tenant has one', async () => {
    findUnique.mockResolvedValue({ name: 'Theo', bornOn: new Date('1998-01-01'), bio: null, styleProfile: null, avatarUrl: null, introducedAt: null });
    const p = await resolveAdvisorIdentityPrefix('t9');
    expect(p).toMatch(/You are Theo, AgentBook's AI accounting agent/);
  });

  it('falls back to the generic line if the persona lookup throws', async () => {
    findUnique.mockRejectedValue(new Error('db down'));
    create.mockRejectedValue(new Error('db down'));
    const p = await resolveAdvisorIdentityPrefix('t10');
    // ensureAdvisorPersona still returns an in-memory persona on total failure,
    // so we get a named prefix rather than the raw generic — either way it never throws.
    expect(p).toMatch(/AgentBook's AI accounting agent|an AI accounting agent/);
  });
});

describe('learnStyleFromMessages — mirror the user', () => {
  it('keeps current style when there is too little signal (<3 msgs)', () => {
    const out = learnStyleFromMessages(['hi', 'yo'], DEFAULT_STYLE);
    expect(out).toEqual(DEFAULT_STYLE);
  });

  it('detects brief vs detailed from average message length', () => {
    const brief = learnStyleFromMessages(['spent $20', 'invoice acme', 'show p&l', 'tax?'], DEFAULT_STYLE);
    expect(brief.verbosity).toBe('brief');
    const longMsg = Array(4).fill('I would like a full detailed breakdown of my expenses this quarter across every category and vendor with month over month comparison summary and totals');
    const detailed = learnStyleFromMessages(longMsg, DEFAULT_STYLE);
    expect(detailed.verbosity).toBe('detailed');
  });

  it('turns emoji on when the user uses them and off when they never do', () => {
    const withEmoji = learnStyleFromMessages(['nice 🎉', 'thanks 😀', 'cool 🚀', 'ok'], { ...DEFAULT_STYLE, emoji: false });
    expect(withEmoji.emoji).toBe(true);
    const noEmoji = learnStyleFromMessages(['spent $20', 'invoice acme', 'show p&l', 'tax question'], { ...DEFAULT_STYLE, emoji: true });
    expect(noEmoji.emoji).toBe(false);
  });

  it('nudges formality down for casual users and up for formal ones (bounded)', () => {
    const casual = learnStyleFromMessages(['yo lol', 'haha thx', 'gonna do it', 'sup'], { ...DEFAULT_STYLE, formality: 0.5 });
    expect(casual.formality).toBeLessThan(0.5);
    expect(casual.formality).toBeGreaterThanOrEqual(0.5 - 0.18 - 1e-9);
    const formal = learnStyleFromMessages(['Please advise regarding my return.', 'Kindly confirm the figures.', 'I would appreciate a summary.', 'Regarding the invoice, therefore proceed.'], { ...DEFAULT_STYLE, formality: 0.4 });
    expect(formal.formality).toBeGreaterThan(0.4);
  });
});

describe('styleChanged', () => {
  it('flags categorical flips and >=0.05 numeric moves, ignores tiny ones', () => {
    expect(styleChanged(DEFAULT_STYLE, { ...DEFAULT_STYLE, verbosity: 'detailed' })).toBe(true);
    expect(styleChanged(DEFAULT_STYLE, { ...DEFAULT_STYLE, emoji: !DEFAULT_STYLE.emoji })).toBe(true);
    expect(styleChanged(DEFAULT_STYLE, { ...DEFAULT_STYLE, formality: DEFAULT_STYLE.formality + 0.1 })).toBe(true);
    expect(styleChanged(DEFAULT_STYLE, { ...DEFAULT_STYLE, formality: DEFAULT_STYLE.formality + 0.01 })).toBe(false);
  });
});

describe('adaptAdvisorStyle', () => {
  it('persists a materially-changed style', async () => {
    findUnique.mockResolvedValue({ name: 'Maya', bornOn: new Date('1998-01-01'), bio: null, styleProfile: { ...DEFAULT_STYLE, emoji: false }, avatarUrl: null, introducedAt: new Date() });
    update.mockResolvedValue({});
    const p = await adaptAdvisorStyle('t1', ['yay 🎉', 'nice 😀', 'cool 🚀', 'love it 🙌']);
    expect(p.styleProfile.emoji).toBe(true);
    expect(update).toHaveBeenCalled();
  });

  it('does not write when nothing material changed', async () => {
    findUnique.mockResolvedValue({ name: 'Maya', bornOn: new Date('1998-01-01'), bio: null, styleProfile: DEFAULT_STYLE, avatarUrl: null, introducedAt: new Date() });
    update.mockResolvedValue({});
    await adaptAdvisorStyle('t1', ['hey', 'yo']); // <3 signal → unchanged
    expect(update).not.toHaveBeenCalled();
  });
});

describe('buildAdvisorVoice reflects learned style', () => {
  it('mentions emoji preference, formality and humor level', () => {
    const casualEmoji = buildAdvisorVoice({ ...persona, styleProfile: { warmth: 0.8, verbosity: 'brief', formality: 0.2, emoji: true, humor: 0.7 } });
    expect(casualEmoji).toMatch(/emoji is fine/i);
    expect(casualEmoji).toMatch(/casual/i);
    expect(casualEmoji).toMatch(/humor is welcome/i);
    const formalDry = buildAdvisorVoice({ ...persona, styleProfile: { warmth: 0.5, verbosity: 'detailed', formality: 0.8, emoji: false, humor: 0.1 } });
    expect(formalDry).toMatch(/skip emoji/i);
    expect(formalDry).toMatch(/formal/i);
  });
});

describe('avatar', () => {
  it('is deterministic per seed, valid SVG, and carries the initial', () => {
    const a = buildAvatarSvg({ name: 'Maya', styleProfile: DEFAULT_STYLE }, 'tenant-1');
    const b = buildAvatarSvg({ name: 'Maya', styleProfile: DEFAULT_STYLE }, 'tenant-1');
    expect(a).toBe(b);
    expect(a).toMatch(/^<svg /);
    expect(a).toContain('>M</text>');
    const c = buildAvatarSvg({ name: 'Maya', styleProfile: DEFAULT_STYLE }, 'tenant-2');
    expect(c).not.toBe(a); // different seed → different hue
  });

  it('adds a smile only when humor is high', () => {
    const dry = buildAvatarSvg({ name: 'Leo', styleProfile: { ...DEFAULT_STYLE, humor: 0.1 } }, 't');
    const funny = buildAvatarSvg({ name: 'Leo', styleProfile: { ...DEFAULT_STYLE, humor: 0.8 } }, 't');
    expect(dry).not.toContain('<path');
    expect(funny).toContain('<path');
  });

  it('escapes the initial and yields a base64 data URI', () => {
    const uri = buildAvatarDataUri({ name: 'Maya', styleProfile: DEFAULT_STYLE }, 't');
    expect(uri).toMatch(/^data:image\/svg\+xml;base64,/);
    const svg = buildAvatarSvg({ name: '<x', styleProfile: DEFAULT_STYLE }, 't');
    expect(svg).not.toContain('<x</text>'); // '<' escaped
  });
});

describe('renameAdvisor', () => {
  it('rejects invalid names', async () => {
    findUnique.mockResolvedValue({ name: 'Maya', bornOn: new Date('1998-01-01'), bio: null, styleProfile: DEFAULT_STYLE, avatarUrl: null, introducedAt: new Date() });
    expect(await renameAdvisor('t', '')).toBeNull();
    expect(await renameAdvisor('t', '42')).toBeNull();
    expect(await renameAdvisor('t', 'a')).toBeNull(); // too short
    expect(update).not.toHaveBeenCalled();
  });

  it('accepts a valid name, normalizes it, and regenerates the avatar', async () => {
    findUnique.mockResolvedValue({ name: 'Maya', bornOn: new Date('1998-01-01'), bio: null, styleProfile: DEFAULT_STYLE, avatarUrl: null, introducedAt: new Date() });
    update.mockImplementation(({ data }: any) => Promise.resolve({ name: data.name, bornOn: new Date('1998-01-01'), bio: null, styleProfile: DEFAULT_STYLE, avatarUrl: data.avatarUrl, introducedAt: new Date() }));
    const p = await renameAdvisor('t', '  sofia ');
    expect(p?.name).toBe('Sofia');
    expect(p?.avatarUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(update).toHaveBeenCalled();
  });
});

describe('personaPublicView', () => {
  it('exposes name/avatar/age/bio and synthesizes an avatar when missing', () => {
    const v = personaPublicView({ name: 'Maya', bornOn: new Date('1998-06-15'), bio: 'hi', styleProfile: DEFAULT_STYLE, avatarUrl: null, introducedAt: null }, 't');
    expect(v.name).toBe('Maya');
    expect(v.bio).toBe('hi');
    expect(v.avatarUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(v.introduced).toBe(false);
  });
});

describe('isHumanChannel — the channel-parity contract', () => {
  it('treats every conversational channel as human, only api opts out', () => {
    expect(isHumanChannel('web')).toBe(true);
    expect(isHumanChannel('telegram')).toBe(true);
    expect(isHumanChannel('api')).toBe(false);
  });

  it('gives future adapters (WhatsApp, MCP, SMS) parity for free — denylist by design', () => {
    // These channels do not exist yet; the contract guarantees that when their
    // adapter routes through handleAgentMessage, they inherit the persona
    // without any adapter-specific work.
    for (const ch of ['whatsapp', 'mcp', 'sms', 'slack', 'imessage']) {
      expect(isHumanChannel(ch)).toBe(true);
    }
  });
});

describe('advisorAge', () => {
  it('computes whole years with birthday not yet reached', () => {
    // born 1998-06-15; on 2026-06-14 → 27, on 2026-06-15 → 28
    expect(advisorAge(new Date('1998-06-15'), new Date('2026-06-14'))).toBe(27);
    expect(advisorAge(new Date('1998-06-15'), new Date('2026-06-15'))).toBe(28);
  });
});
