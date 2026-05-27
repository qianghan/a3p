/**
 * AgentBook i18n scaffolding (PR 62).
 *
 * Foundation for translating agent-side static strings without
 * committing to a full translation pipeline yet. Two functions:
 *
 *   t(key, locale?, vars?)        Resolve a translation key. Returns
 *                                  the English fallback when the locale
 *                                  has no entry.
 *
 *   parseLocaleHeader(header)     Pick the best-supported locale from
 *                                  an Accept-Language header. Returns
 *                                  the default ('en') when nothing matches.
 *
 * Translation tables are inline below. Each key has an `en` default —
 * required — and optional entries for supported locales. Adding a
 * locale is "add a sibling field"; no toolchain changes needed.
 *
 * Variable interpolation: `{name}` in the source string is replaced by
 * `vars.name`. Missing vars render as the literal `{name}` for visibility.
 *
 * Why inline tables rather than a JSON/po pipeline:
 *   - Zero dependencies — works in serverless without bundling assets
 *   - Type-safe key access via the AgentI18nKey union
 *   - Trivial to swap for a real translation backend later (the public
 *     surface is just `t(key, locale, vars)`)
 *
 * Adding a translation:
 *   1. Add a key to `TRANSLATIONS` with the English default
 *   2. Update the AgentI18nKey union type below
 *   3. Optionally add ja / es / fr / ... entries
 *
 * Plus a small library of currently-translated user-facing strings used
 * by the agent's reply formatter and the rate-limit / error paths.
 */

import 'server-only';

export type AgentI18nLocale = 'en' | 'es' | 'fr' | 'ja' | 'zh-CN';

const SUPPORTED_LOCALES: AgentI18nLocale[] = ['en', 'es', 'fr', 'ja', 'zh-CN'];

/**
 * Translation table. Every key MUST have an `en` entry — the others are
 * optional. The `t()` function falls back to `en` when the requested
 * locale doesn't have the key.
 */
const TRANSLATIONS: Record<AgentI18nKey, Partial<Record<AgentI18nLocale, string>>> = {
  // Rate limiter (PR 61)
  'rate.minute_exceeded': {
    en: "You're sending messages very fast. Try again in a minute.",
    es: 'Estás enviando mensajes muy rápido. Intenta de nuevo en un minuto.',
    fr: 'Vous envoyez des messages très rapidement. Réessayez dans une minute.',
    ja: 'メッセージの送信が速すぎます。1分後にもう一度お試しください。',
    'zh-CN': '您发送消息的速度过快，请一分钟后再试。',
  },
  'rate.day_exceeded': {
    en: 'Daily message ceiling reached. Try again tomorrow, or upgrade your plan for a higher limit.',
    es: 'Se alcanzó el límite diario de mensajes. Inténtalo mañana o actualiza tu plan.',
    fr: 'Limite quotidienne atteinte. Réessayez demain ou passez à un plan supérieur.',
    ja: '本日のメッセージ上限に達しました。明日もう一度お試しいただくか、プランをアップグレードしてください。',
    'zh-CN': '已达每日消息上限。请明天再试或升级套餐以提高上限。',
  },

  // Confirm gate (PR 9 / PR 42)
  'agent.confirm_lead': {
    en: "I'd like to do this:",
    es: 'Me gustaría hacer esto:',
    fr: "J'aimerais faire ceci :",
    ja: 'これを実行します:',
    'zh-CN': '我想执行以下操作：',
  },
  'agent.low_confidence_lead': {
    en: "I'm not entirely sure I understood — does this look right?",
    es: 'No estoy del todo seguro de haber entendido — ¿se ve bien esto?',
    fr: "Je ne suis pas entièrement sûr d'avoir compris — est-ce que cela vous semble correct ?",
    ja: '完全に理解できているか自信がありません — これで合っていますか？',
    'zh-CN': '我不太确定我理解对了 — 这样可以吗？',
  },

  // Undo (PR 24 / G-028)
  'agent.undo_success': {
    en: 'Undone: {description}',
    es: 'Deshecho: {description}',
    fr: 'Annulé : {description}',
    ja: '取り消しました: {description}',
    'zh-CN': '已撤销：{description}',
  },
  'agent.undo_failed': {
    en: "I couldn't undo \"{description}\" — the reverse step failed. Try again, or contact support.",
    es: 'No se pudo deshacer "{description}" — el paso inverso falló. Inténtalo de nuevo o contacta a soporte.',
    fr: "Impossible d'annuler \"{description}\" — l'étape inverse a échoué. Réessayez ou contactez le support.",
    ja: '「{description}」を取り消せませんでした。再試行するかサポートにお問い合わせください。',
    'zh-CN': '无法撤销 "{description}" — 反向操作失败。请重试或联系支持。',
  },

  // Catch-all fallback
  'agent.unknown_intent': {
    en: 'I\'m not sure what you mean. Try "Spent $45 on lunch" or "How much on travel?"',
    es: 'No estoy seguro de qué quieres decir. Intenta "Gasté $45 en almuerzo" o "¿Cuánto en viajes?"',
    fr: 'Je ne suis pas sûr de comprendre. Essayez « Dépensé 45 $ pour le déjeuner » ou « Combien en voyages ? »',
    ja: 'ご質問の意図がわかりません。例：「昼食に45ドル使った」「旅費はいくら？」',
    'zh-CN': '我不太确定您的意思。试试 "午餐花了 $45" 或者 "差旅花了多少？"',
  },
};

export type AgentI18nKey =
  | 'rate.minute_exceeded'
  | 'rate.day_exceeded'
  | 'agent.confirm_lead'
  | 'agent.low_confidence_lead'
  | 'agent.undo_success'
  | 'agent.undo_failed'
  | 'agent.unknown_intent';

function isSupported(locale: string): locale is AgentI18nLocale {
  return (SUPPORTED_LOCALES as string[]).includes(locale);
}

/**
 * Translate a key. Variable interpolation: `{name}` is replaced by
 * `vars.name`. Falls back to English when the locale is missing or
 * doesn't have an entry.
 */
export function t(
  key: AgentI18nKey,
  locale: AgentI18nLocale | string = 'en',
  vars?: Record<string, string | number>,
): string {
  const table = TRANSLATIONS[key];
  if (!table) return key;
  const normalizedLocale = isSupported(locale) ? locale : 'en';
  const template = table[normalizedLocale] ?? table.en ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (literal, name: string) => {
    const v = vars[name];
    return v === undefined ? literal : String(v);
  });
}

/**
 * Parse an Accept-Language header (RFC 7231) and return the best-supported
 * AgentBook locale. Walks the comma-separated q-weighted list, normalizes
 * language tags (lowercase except for region in zh-CN), and picks the
 * highest-weighted match that we support. Returns 'en' when nothing
 * matches.
 *
 * Examples:
 *   parseLocaleHeader('en-US,en;q=0.9') → 'en'
 *   parseLocaleHeader('ja-JP, en;q=0.8') → 'ja'
 *   parseLocaleHeader('de-DE,de;q=0.9,en-US;q=0.8') → 'en'
 *   parseLocaleHeader('zh-CN,zh;q=0.9') → 'zh-CN'
 *   parseLocaleHeader(null) → 'en'
 */
export function parseLocaleHeader(header: string | null | undefined): AgentI18nLocale {
  if (!header) return 'en';
  const candidates = header
    .split(',')
    .map((entry) => {
      const [tag, ...params] = entry.trim().split(';').map((s) => s.trim());
      let q = 1;
      for (const p of params) {
        const match = p.match(/^q=([0-9.]+)$/);
        if (match) q = Number(match[1]);
      }
      return { tag, q };
    })
    .filter((c) => c.tag)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of candidates) {
    // Try exact match (zh-CN).
    const exact = tag.toLowerCase() === 'zh-cn' ? 'zh-CN' : tag.toLowerCase();
    if (isSupported(exact)) return exact;
    // Try the language part only (en-US → en).
    const base = tag.split('-')[0].toLowerCase();
    if (isSupported(base)) return base as AgentI18nLocale;
  }
  return 'en';
}

export const SUPPORTED_LOCALE_LIST = SUPPORTED_LOCALES;
