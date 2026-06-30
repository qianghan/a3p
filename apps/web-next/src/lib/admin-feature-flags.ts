/**
 * Pure helpers for the admin Feature Flags screen — normalize/validate flag
 * keys and parse upsert input. Keys are lowercase slugs (letters, digits,
 * dot, dash, underscore) so they're safe to reference in code.
 */

const KEY_RE = /^[a-z0-9._-]+$/;

export function normalizeFlagKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  return key.length > 0 && KEY_RE.test(key) ? key : null;
}

export function parseFlagUpsert(
  body: unknown,
): { key: string; enabled: boolean; description?: string } | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const key = normalizeFlagKey(b.key);
  if (!key) return null;
  if (typeof b.enabled !== 'boolean') return null;
  const description =
    typeof b.description === 'string' && b.description.trim().length > 0 ? b.description.trim() : undefined;
  return { key, enabled: b.enabled, description };
}
