/**
 * Code is authoritative for global built-in skill definitions.
 *
 * The agent read skills from AbSkillManifest and let DB rows win, so every edit
 * to BUILT_IN_SKILLS was a silent no-op in production until someone remembered
 * to POST /api/v1/admin/seed-skills. A routing fix could merge, pass CI, deploy,
 * and change nothing — code and data disagreeing with no signal anywhere. It
 * cost a real misroute that stayed live after its fix had shipped: "how much
 * will I owe in taxes this quarter?" answered with accounts payable.
 *
 * The reconciliation has four properties, and getting any of them wrong would
 * be worse than the footgun it replaces:
 *
 *   1. definition fields for global built-in rows come from CODE
 *   2. a skill the admin disabled stays gone — that toggle is the DB's
 *   3. tenant-scoped and non-built-in rows are untouched
 *   4. a built-in with no row at all is still usable
 *
 * These now run against the real `reconcileSkills`. They used to run against a
 * hand-written mirror of it declared in this file, which is the reason the
 * whole mechanism could be dead in production while this suite stayed green:
 * the mirror was correct, and nothing here ever touched the code that shipped.
 * Property 4 is new and is the one the mirror could never have caught —
 * `set-vendor-alias` had no row, so it was invisible to the classifier.
 */
import { describe, it, expect } from 'vitest';
import { reconcileSkills } from '@agentbook-core/skill-source';
import { BUILT_IN_SKILLS } from '@agentbook-core/built-in-skills';

type Row = Record<string, any>;

const CODE_MANAGE_BILLS = BUILT_IN_SKILLS.find((s) => s.name === 'manage-bills') as Row;

function row(over: Partial<Row> = {}): Row {
  return {
    id: 'row-1',
    name: 'manage-bills',
    tenantId: null,
    source: 'built_in',
    enabled: true,
    description: 'stale',
    category: 'stale',
    triggerPatterns: ['stale-db-pattern'],
    requirePatterns: [],
    excludePatterns: [],
    parameters: {},
    endpoint: null,
    responseTemplate: null,
    confirmBefore: false,
    ...over,
  };
}
const only = (rows: Row[], name = 'manage-bills') =>
  reconcileSkills(rows).filter((s) => s.name === name);

describe('code wins for global built-ins', () => {
  it('takes the definition from code, not the stale row', () => {
    const [out] = only([row()]);
    expect(out.triggerPatterns).toEqual(CODE_MANAGE_BILLS.triggerPatterns);
    expect(out.triggerPatterns).not.toContain('stale-db-pattern');
    expect(out.description).toBe(CODE_MANAGE_BILLS.description);
  });

  it('keeps the row identity — this is an override, not a replacement', () => {
    const [out] = only([row({ id: 'row-xyz' })]);
    expect(out.id).toBe('row-xyz');
  });
});

describe('what the DB still owns', () => {
  it('a skill the admin disabled does not come back', () => {
    // The row is dropped rather than returned with enabled:false. Nothing
    // downstream re-checks the flag — classification routes to anything in the
    // array — so returning it would be the same as ignoring the toggle.
    expect(only([row({ enabled: false })])).toEqual([]);
  });

  it('and is not resurrected by the code fallback either', () => {
    // The subtle half of #427: "disabled" and "no row" must not look alike to
    // the fallback, or switching a skill off silently switches it back on.
    const out = reconcileSkills([row({ enabled: false })]);
    expect(out.map((s) => s.name)).not.toContain('manage-bills');
  });

  it('leaves a tenant-scoped row completely alone', () => {
    const r = row({ tenantId: 'tenant-7', triggerPatterns: ['tenant custom'] });
    expect(only([r])[0]).toEqual(r);
  });

  it('leaves a non-built-in row completely alone', () => {
    const r = row({ source: 'custom', triggerPatterns: ['hand written'] });
    expect(only([r])[0]).toEqual(r);
  });

  it('leaves a row with no code counterpart alone', () => {
    const r = row({ name: 'some-removed-skill', triggerPatterns: ['still here'] });
    expect(only([r], 'some-removed-skill')[0]).toEqual(r);
  });
});

describe('a built-in with no row is still usable', () => {
  it('is present, enabled, and carries its code definition', () => {
    const out = reconcileSkills([]);
    const names = out.map((s) => s.name);
    for (const s of BUILT_IN_SKILLS) expect(names).toContain(s.name);

    const added = out.find((s) => s.name === 'manage-bills')!;
    expect(added.enabled).toBe(true);
    expect(added.source).toBe('built_in');
    expect(added.tenantId).toBeNull();
    expect(added.triggerPatterns).toEqual(CODE_MANAGE_BILLS.triggerPatterns);
  });

  it('does not duplicate a built-in that already has a row', () => {
    const out = reconcileSkills([row()]);
    expect(out.filter((s) => s.name === 'manage-bills')).toHaveLength(1);
  });
});
