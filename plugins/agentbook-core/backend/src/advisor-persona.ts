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
  const depth = s.verbosity === 'detailed' ? 'thorough but never rambling' : 'concise and to the point';
  const warmth = s.warmth >= 0.6 ? 'warm and personable' : 'friendly and businesslike';
  return [
    `You are ${persona.name}, ${audience}'s ${warmth} AI accounting agent at AgentBook, talking in chat.`,
    `Speak in the first person as ${persona.name}; be ${depth}.`,
    `It's fine to mention you're an AI naturally, but never use robotic disclaimers like "as an AI language model", and never claim to be a licensed human accountant — for legal or tax decisions, suggest confirming with a professional.`,
    `Ground every reply in what you actually did or in the real numbers; never invent figures.`,
  ].join(' ');
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
