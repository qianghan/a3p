/**
 * Manifest-driven skill routing (Wave 2 PR 10, closes G-011).
 *
 * Replaces the prior hardcoded per-skill regex exclusion chain in
 * classifyAndExecuteV1 (server.ts). Each AbSkillManifest now carries
 * three pattern arrays:
 *
 *   triggerPatterns — at least one must match for the skill to be a
 *                     candidate (existing behaviour, unchanged).
 *   requirePatterns — if non-empty, ALL must match. Used for slot-style
 *                     preconditions (e.g. record-expense requires a $
 *                     amount).
 *   excludePatterns — if any matches, the skill is rejected. Used to
 *                     defer to a more specific skill (e.g. query-finance
 *                     defers to tax-estimate on "how much tax").
 *
 * Invalid regex strings are silently skipped — they never throw, so a
 * single broken pattern can't take down the whole router.
 */

export interface SkillLike {
  name: string;
  triggerPatterns?: unknown;
  requirePatterns?: unknown;
  excludePatterns?: unknown;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function anyMatch(patterns: string[], lower: string): boolean {
  for (const p of patterns) {
    try {
      if (new RegExp(p, 'i').test(lower)) return true;
    } catch {
      // invalid regex — skip
    }
  }
  return false;
}

function allMatch(patterns: string[], lower: string): boolean {
  for (const p of patterns) {
    try {
      if (!new RegExp(p, 'i').test(lower)) return false;
    } catch {
      // invalid regex — treat as a non-match (conservative: require would fail)
      return false;
    }
  }
  return true;
}

/**
 * Returns true iff the skill should be selected for the given utterance.
 *
 * Order of checks:
 *   1. triggerPatterns must be non-empty AND at least one must match
 *   2. if requirePatterns non-empty, ALL must match
 *   3. if excludePatterns non-empty, NONE must match
 */
export function selectSkillByPatterns(
  skill: SkillLike,
  _text: string,
  lower: string,
): boolean {
  const triggers = toStringArray(skill.triggerPatterns);
  if (triggers.length === 0) return false;
  if (!anyMatch(triggers, lower)) return false;

  const requires = toStringArray(skill.requirePatterns);
  if (requires.length > 0 && !allMatch(requires, lower)) return false;

  const excludes = toStringArray(skill.excludePatterns);
  if (excludes.length > 0 && anyMatch(excludes, lower)) return false;

  return true;
}
