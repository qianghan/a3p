import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUnique = vi.fn();
const create = vi.fn();
vi.mock('../db/client.js', () => ({
  db: { abAdvisorPersona: { findUnique: (...a: any[]) => findUnique(...a), create: (...a: any[]) => create(...a) } },
}));

import {
  pickFallbackName, generateAdvisorName, ensureAdvisorPersona,
  buildAdvisorVoice, buildIntroMessage, advisorAge, DEFAULT_STYLE, FALLBACK_NAMES,
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

describe('advisorAge', () => {
  it('computes whole years with birthday not yet reached', () => {
    // born 1998-06-15; on 2026-06-14 → 27, on 2026-06-15 → 28
    expect(advisorAge(new Date('1998-06-15'), new Date('2026-06-14'))).toBe(27);
    expect(advisorAge(new Date('1998-06-15'), new Date('2026-06-15'))).toBe(28);
  });
});
