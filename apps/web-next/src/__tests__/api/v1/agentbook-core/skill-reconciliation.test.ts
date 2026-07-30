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
 * The reconciliation has three properties, and getting any of them wrong would
 * be worse than the footgun it replaces:
 *
 *   1. definition fields for global built-in rows come from CODE
 *   2. `enabled` still comes from the DB — it is the admin toggle
 *   3. tenant-scoped and non-built-in rows are untouched
 *
 * Asserted here as a pure function of the merge inputs, so the properties are
 * pinned without standing up Prisma or the whole agent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTE = readFileSync(
  join(__dirname, '../../../../app/api/v1/agentbook-core/agent/message/route.ts'),
  'utf8',
);

/** Mirror of the reconciliation in the route, exercised over crafted rows. */
type Row = {
  name: string;
  tenantId: string | null;
  source: string;
  enabled: boolean;
  triggerPatterns: string[];
  excludePatterns: string[];
};
function reconcile(rows: Row[], code: Record<string, Partial<Row>>): Row[] {
  const byName = new Map(Object.entries(code));
  return rows.map((row) => {
    if (row.tenantId !== null || row.source !== 'built_in') return row;
    const c = byName.get(row.name);
    if (!c) return row;
    return {
      ...row,
      triggerPatterns: (c.triggerPatterns as string[]) ?? row.triggerPatterns,
      excludePatterns: (c.excludePatterns as string[]) ?? row.excludePatterns,
    };
  });
}

const CODE = {
  'manage-bills': { triggerPatterns: ['bills?.*due'], excludePatterns: ['owe.*tax'] },
};

describe('skill reconciliation', () => {
  it('takes patterns from code for a global built-in row', () => {
    const [out] = reconcile(
      [{
        name: 'manage-bills', tenantId: null, source: 'built_in', enabled: true,
        triggerPatterns: ['bills? due'],       // the STALE DB value
        excludePatterns: [],                    // DB never had the tax exclude
      }],
      CODE,
    );
    expect(out.triggerPatterns).toEqual(['bills?.*due']);
    expect(out.excludePatterns).toEqual(['owe.*tax']);
  });

  it('does NOT override the admin enabled toggle', () => {
    // Someone disabled this skill in the admin UI. Code must not resurrect it.
    const [out] = reconcile(
      [{
        name: 'manage-bills', tenantId: null, source: 'built_in', enabled: false,
        triggerPatterns: ['old'], excludePatterns: [],
      }],
      CODE,
    );
    expect(out.enabled).toBe(false);
    expect(out.triggerPatterns).toEqual(['bills?.*due']); // definition still updated
  });

  it('leaves a tenant-scoped row completely alone', () => {
    const row: Row = {
      name: 'manage-bills', tenantId: 'tenant-7', source: 'built_in', enabled: true,
      triggerPatterns: ['tenant custom'], excludePatterns: ['tenant exclude'],
    };
    expect(reconcile([row], CODE)[0]).toEqual(row);
  });

  it('leaves a non-built-in row completely alone', () => {
    const row: Row = {
      name: 'manage-bills', tenantId: null, source: 'custom', enabled: true,
      triggerPatterns: ['hand written'], excludePatterns: [],
    };
    expect(reconcile([row], CODE)[0]).toEqual(row);
  });

  it('leaves a DB row with no code counterpart alone', () => {
    const row: Row = {
      name: 'some-removed-skill', tenantId: null, source: 'built_in', enabled: true,
      triggerPatterns: ['still here'], excludePatterns: [],
    };
    expect(reconcile([row], CODE)[0]).toEqual(row);
  });
});

describe('the route actually wires it', () => {
  it('reconciles rather than trusting dbSkills directly', () => {
    // The regression is literally spreading dbSkills into the skill list.
    expect(ROUTE).toMatch(/const skills = \[\.\.\.reconciled, \.\.\.fallbackSkills\]/);
    expect(ROUTE).not.toMatch(/const skills = \[\.\.\.dbSkills, \.\.\.fallbackSkills\]/);
  });

  it('guards on both tenantId and source before overriding', () => {
    expect(ROUTE).toMatch(/row\.tenantId !== null \|\| row\.source !== 'built_in'/);
  });

  it('never assigns enabled inside the reconciliation', () => {
    const i = ROUTE.indexOf('const reconciled =');
    const block = ROUTE.slice(i, ROUTE.indexOf('const seenNames', i));
    expect(block).not.toMatch(/^\s*enabled:/m);
  });
});
