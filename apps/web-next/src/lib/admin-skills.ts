/**
 * Pure helpers for the admin Skills screen: validate the enable/disable
 * (install/uninstall) input, and project an AbSkillManifest row down to the
 * admin-facing fields (never leak trigger patterns / endpoints to the UI).
 */

export interface SkillDTO {
  name: string;
  description: string;
  category: string;
  source: string;
  enabled: boolean;
}

/** Validate a PATCH body. Returns the normalized {name, enabled} or null. */
export function parseToggle(body: unknown): { name: string; enabled: boolean } | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.name !== 'string' || typeof b.enabled !== 'boolean') return null;
  const name = b.name.trim();
  if (name.length === 0) return null;
  return { name, enabled: b.enabled };
}

export function toSkillDTO(row: {
  name: string;
  description: string;
  category: string;
  source: string;
  enabled: boolean;
}): SkillDTO {
  return {
    name: row.name,
    description: row.description,
    category: row.category,
    source: row.source,
    enabled: row.enabled,
  };
}
