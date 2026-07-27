/**
 * The AgentBook advisor persona — the single human-named "face" the user
 * talks to on every channel. Lazily created on first contact, then reused.
 *
 * Design principles:
 *  - Human, but honest: a warm first name + voice, but it always discloses
 *    it's an AI and never claims to be a licensed professional.
 *  - One voice, everywhere: because every channel funnels through
 *    handleAgentMessage, injecting the voice here reaches chatbot, web, and
 *    (future) MCP uniformly.
 *  - Fallback-guarded: callers must treat persona failures as non-fatal and
 *    fall back to the default voice, so this can never break chat.
 */
import { db } from './db/client.js';

export interface StyleProfile {
  warmth: number; // 0..1
  verbosity: 'brief' | 'balanced' | 'detailed';
  formality: number; // 0..1 (0 casual, 1 formal)
  emoji: boolean;
  humor: number; // 0..1
}

export const DEFAULT_STYLE: StyleProfile = {
  warmth: 0.7,
  verbosity: 'brief',
  formality: 0.4,
  emoji: true,
  humor: 0.3,
};

export interface AdvisorPersona {
  name: string;
  bornOn: Date;
  bio: string | null;
  styleProfile: StyleProfile;
  avatarUrl: string | null;
  introducedAt: Date | null;
}

// Curated, warm, easy-to-say, gender- and culture-varied fallback pool used
// when the LLM is unavailable. Deterministic pick keeps a tenant's name stable.
export const FALLBACK_NAMES = [
  'Maya', 'Alex', 'Sofia', 'Kai', 'Nadia', 'Leo', 'Priya', 'Sam', 'Elena', 'Noah',
  'Amara', 'Ravi', 'Clara', 'Theo', 'Yuki', 'Mateo', 'Iris', 'Jonas', 'Lena', 'Omar',
];

/** Deterministic fallback name from the tenantId, so it's stable across retries. */
export function pickFallbackName(tenantId: string): string {
  let h = 0;
  for (let i = 0; i < tenantId.length; i++) h = (Math.imul(h, 31) + tenantId.charCodeAt(i)) >>> 0;
  return FALLBACK_NAMES[h % FALLBACK_NAMES.length];
}

type GeminiFn = (sys: string, user: string, max?: number) => Promise<string | null>;
type TenantConfigLite = { locale?: string | null; jurisdiction?: string | null; businessType?: string | null; companyName?: string | null } | null;

/** Choose a warm, professional first name. LLM-picked (locale-aware) with a deterministic fallback. */
export async function generateAdvisorName(tenantId: string, tenantConfig?: TenantConfigLite, callGemini?: GeminiFn): Promise<string> {
  if (callGemini) {
    try {
      const sys =
        'You name a friendly, professional AI accounting assistant. Reply with ONE first name only — warm, easy to say, and natural for the user\'s locale. No surname, no punctuation, no quotes, no explanation.';
      const user = `Locale: ${tenantConfig?.locale || 'en-US'}. Region: ${tenantConfig?.jurisdiction || 'us'}. Business type: ${tenantConfig?.businessType || 'freelancer'}. Give one first name.`;
      const raw = (await callGemini(sys, user, 12))?.trim().split(/\s+/)[0] ?? '';
      if (/^[A-Za-z][A-Za-z'-]{1,14}$/.test(raw)) {
        return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
      }
    } catch {
      /* fall through to deterministic pick */
    }
  }
  return pickFallbackName(tenantId);
}

function buildBio(name: string, tenantConfig?: TenantConfigLite): string {
  const who = tenantConfig?.companyName
    ? `${tenantConfig.companyName}`
    : tenantConfig?.businessType === 'student'
      ? 'a student'
      : 'a small business';
  return `${name} — your AI accounting agent for ${who}.`;
}

/** Age in whole years today, given the anchored bornOn. */
export function advisorAge(bornOn: Date, now: Date = new Date()): number {
  let age = now.getFullYear() - bornOn.getFullYear();
  const m = now.getMonth() - bornOn.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < bornOn.getDate())) age--;
  return age;
}

function normalize(row: { name: string; bornOn: Date; bio: string | null; styleProfile: unknown; avatarUrl: string | null; introducedAt: Date | null }): AdvisorPersona {
  const sp = (row.styleProfile && typeof row.styleProfile === 'object') ? row.styleProfile as Partial<StyleProfile> : {};
  return {
    name: row.name,
    bornOn: row.bornOn,
    bio: row.bio,
    styleProfile: { ...DEFAULT_STYLE, ...sp },
    avatarUrl: row.avatarUrl,
    introducedAt: row.introducedAt,
  };
}

/**
 * Get-or-create the tenant's advisor persona. Idempotent; safe to call every
 * turn. On first creation the advisor is "born" 28 years ago today.
 */
export async function ensureAdvisorPersona(
  tenantId: string,
  opts?: { callGemini?: GeminiFn; tenantConfig?: TenantConfigLite },
): Promise<AdvisorPersona> {
  const existing = await db.abAdvisorPersona.findUnique({ where: { tenantId } });
  if (existing) return normalize(existing);

  const name = await generateAdvisorName(tenantId, opts?.tenantConfig, opts?.callGemini);
  const bornOn = new Date();
  bornOn.setFullYear(bornOn.getFullYear() - 28);
  const bio = buildBio(name, opts?.tenantConfig);

  try {
    const created = await db.abAdvisorPersona.create({
      data: { tenantId, name, bornOn, bio, styleProfile: DEFAULT_STYLE as unknown as object },
    });
    return normalize(created);
  } catch {
    // Race: another concurrent turn created it — read it back.
    const row = await db.abAdvisorPersona.findUnique({ where: { tenantId } });
    if (row) return normalize(row);
    // Last resort: return an in-memory persona so callers never break.
    return { name, bornOn, bio, styleProfile: DEFAULT_STYLE, avatarUrl: null, introducedAt: null };
  }
}

/**
 * The identity + voice instruction line injected at the top of a reply's
 * system prompt. Encodes the name, first-person voice, the honesty rules, and
 * the action rule. Pure — takes a persona, returns a string.
 */
export function buildAdvisorVoice(persona: AdvisorPersona, tenantConfig?: TenantConfigLite): string {
  const audience = tenantConfig?.companyName ? `the team at ${tenantConfig.companyName}` : 'the user';
  const s = persona.styleProfile;
  const depth = s.verbosity === 'detailed' ? 'thorough but never rambling' : s.verbosity === 'balanced' ? 'clear and adequately detailed' : 'concise and to the point';
  const warmth = s.warmth >= 0.6 ? 'warm and personable' : 'friendly and businesslike';
  const tone = s.formality >= 0.6 ? 'lean a little more formal and polished' : s.formality <= 0.3 ? 'keep it casual and relaxed' : 'keep a natural, everyday tone';
  const emoji = s.emoji ? 'a well-placed emoji is fine when it fits' : 'skip emoji';
  const humor = s.humor >= 0.5 ? 'a touch of light humor is welcome' : 'keep humor minimal';
  return [
    `You are ${persona.name}, ${audience}'s ${warmth} AI accounting agent at AgentBook, talking in chat.`,
    `Speak in the first person as ${persona.name}; be ${depth}; ${tone}; ${emoji}; ${humor}.`,
    `It's fine to mention you're an AI naturally, but never use robotic disclaimers like "as an AI language model", and never claim to be a licensed human accountant — for legal or tax decisions, suggest confirming with a professional.`,
    `Ground every reply in what you actually did or in the real numbers; never invent figures.`,
  ].join(' ');
}

// ============================================================
// Style learning — the persona mirrors the user's own tone over time, so the
// voice grows more personal the more they chat. Pure & deterministic (no LLM):
// free, fast, testable, and stable (bounded steps, writes only on real change).
// ============================================================

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u;
const CASUAL_RE = /\b(lol|lmao|haha+|hah|gonna|wanna|gotta|yeah|yep|nope|u|ur|thx|pls|plz|sup|hey)\b|!{2,}/i;
const FORMAL_RE = /\b(please|kindly|regards|dear|therefore|however|regarding|furthermore|appreciate)\b/i;
const HUMOR_RE = /\b(lol|lmao|haha+|joke|kidding)\b|[\u{1F602}\u{1F923}\u{1F605}]/u;

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }

/**
 * Learn a style profile by mirroring the USER's recent messages. Numeric traits
 * move by a bounded step toward the observed signal so the voice drifts smoothly
 * rather than lurching. Returns the current style unchanged if there's too
 * little signal.
 */
export function learnStyleFromMessages(userMessages: string[], current: StyleProfile): StyleProfile {
  const msgs = userMessages.map((m) => (m || '').trim()).filter(Boolean);
  if (msgs.length < 3) return current;

  const words = msgs.map((m) => m.split(/\s+/).length);
  const avgWords = words.reduce((a, b) => a + b, 0) / words.length;
  const verbosity: StyleProfile['verbosity'] = avgWords < 8 ? 'brief' : avgWords > 24 ? 'detailed' : 'balanced';

  const frac = (re: RegExp) => msgs.filter((m) => re.test(m)).length / msgs.length;
  const emojiFrac = frac(EMOJI_RE);
  const casualFrac = frac(CASUAL_RE);
  const formalFrac = frac(FORMAL_RE);
  const humorFrac = frac(HUMOR_RE);

  const STEP = 0.18; // max move per reflection — keeps it stable
  const toward = (cur: number, target: number) => clamp01(cur + Math.max(-STEP, Math.min(STEP, target - cur)));

  const formalityTarget = clamp01(0.4 - casualFrac * 0.6 + formalFrac * 0.6);
  const humorTarget = clamp01(0.2 + humorFrac * 0.8);

  return {
    warmth: current.warmth, // the advisor's own trait — stays stable, not mirrored
    verbosity,
    formality: toward(current.formality, formalityTarget),
    emoji: emojiFrac >= 0.2 ? true : emojiFrac === 0 ? false : current.emoji,
    humor: toward(current.humor, humorTarget),
  };
}

/** Material-change detector — avoids a DB write when nothing meaningfully moved. */
export function styleChanged(a: StyleProfile, b: StyleProfile): boolean {
  return a.verbosity !== b.verbosity
    || a.emoji !== b.emoji
    || Math.abs(a.formality - b.formality) >= 0.05
    || Math.abs(a.humor - b.humor) >= 0.05;
}

/** Persist a new style profile for the tenant's persona. Guarded (non-fatal). */
export async function updateAdvisorStyle(tenantId: string, style: StyleProfile): Promise<void> {
  await db.abAdvisorPersona.update({
    where: { tenantId },
    data: { styleProfile: style as unknown as object },
  }).catch(() => { /* non-fatal — style learning must never break a reply */ });
}

/**
 * Reflect on the user's recent messages and adapt the persona's style, writing
 * only when it materially changed. Fully guarded — returns the (possibly
 * unchanged) persona and never throws.
 */
export async function adaptAdvisorStyle(
  tenantId: string,
  userMessages: string[],
  opts?: { callGemini?: GeminiFn; tenantConfig?: TenantConfigLite },
): Promise<AdvisorPersona> {
  const persona = await ensureAdvisorPersona(tenantId, opts);
  try {
    const next = learnStyleFromMessages(userMessages, persona.styleProfile);
    if (styleChanged(persona.styleProfile, next)) {
      await updateAdvisorStyle(tenantId, next);
      return { ...persona, styleProfile: next };
    }
  } catch { /* non-fatal — keep the existing persona */ }
  return persona;
}

/**
 * A compact identity clause for the specialized LLM prompts (Q&A, briefing,
 * expense advisor, student-tax) that keep their own domain instructions. Just
 * establishes WHO is speaking + the honesty guardrail, then the caller appends
 * the task-specific rules. Pure.
 */
export function buildAdvisorIdentityPrefix(persona: AdvisorPersona): string {
  return `You are ${persona.name}, AgentBook's AI accounting agent (an AI assistant — never a licensed human accountant; suggest a professional for legal or tax decisions and never invent figures).`;
}

/**
 * Safe, cached-friendly resolver: get-or-create the persona and return its
 * identity prefix, falling back to the generic line on any failure so a
 * specialized prompt can never break. Callers pass tenantId (may be undefined).
 */
export async function resolveAdvisorIdentityPrefix(
  tenantId: string | undefined,
  opts?: { callGemini?: GeminiFn; tenantConfig?: TenantConfigLite },
): Promise<string> {
  const generic = "You are AgentBook, an AI accounting agent (an AI assistant, not a licensed human accountant).";
  if (!tenantId) return generic;
  try {
    const persona = await ensureAdvisorPersona(tenantId, opts);
    return buildAdvisorIdentityPrefix(persona);
  } catch {
    return generic;
  }
}

/** The one-time self-introduction shown on first contact (human channels). */
export function buildIntroMessage(persona: AdvisorPersona): string {
  return [
    `Hi — I'm ${persona.name}, your accounting agent here at AgentBook. 👋`,
    `Think of me as the bookkeeper who never sleeps: snap me a receipt and it's booked, forward an invoice and I'll help you get paid, and I'll keep an eye on your tax so nothing sneaks up on you.`,
    `I'm an AI, so I'll always be straight with you — I'll tell you when I'm not sure and point you to a human for the big calls.`,
    `Want to connect your bank to start, or shall I log your first expense?`,
  ].join(' ');
}
