/**
 * Every skill fetch that feeds routing or execution goes through one query.
 *
 * Skill routing tries skills in array order and takes the first match — see
 * "Skills are tried in array order — first match wins" in server.ts and the
 * collision comments in skill-routing.ts. Without `orderBy`, that array is in
 * whatever order Postgres happened to return, so when two skills' trigger
 * patterns both match an utterance, the winner is undefined and can change
 * between deploys, between replicas, or after a VACUUM.
 *
 * The previous version of this file guarded the wrong three files, for a
 * reason worth recording. Its header read:
 *
 *   "agent-brain only runs that fetch when the caller did NOT pass `skills`,
 *    and all three production channel routes DO pass `skills` — so the tested
 *    guarantee covered a path production never takes"
 *
 * The observation was right and the direction was backwards. agent-brain's
 * fetch is unconditional, and ITS array is the one handed to the classifier;
 * the arrays the three routes build reach executeStep and nothing else. So the
 * guard sat on the dead path either way — first on agent-brain, when everyone
 * believed the routes mattered, then on the routes, when everyone believed
 * agent-brain didn't run. `set-vendor-alias` is what finally showed it: a
 * built-in with no DB row, unroutable in production while every test was
 * green. See skill-source.ts.
 *
 * There is now a single query, so the invariant is asserted once on the query
 * itself, and each call site is checked for delegating to it rather than
 * hand-rolling an equivalent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_QUERY, reconcileSkills } from '@agentbook-core/skill-source';

const APP = join(__dirname, '../../../../app/api/v1');
const CORE = join(__dirname, '../../../../../../../plugins/agentbook-core/backend/src');

/**
 * Everywhere AbSkillManifest is read for the agent. agent-brain is listed
 * first because it is the one that feeds the classifier — the omission that
 * cost this invariant twice.
 */
const FETCH_SITES = [
  ['agent-brain (feeds the classifier)', join(CORE, 'agent-brain.ts')],
  ['web chat', join(APP, 'agentbook-core/agent/message/route.ts')],
  ['telegram', join(APP, 'agentbook/telegram/webhook/route.ts')],
  ['whatsapp', join(APP, 'agentbook/whatsapp/webhook/route.ts')],
] as const;

/** Text of each `abSkillManifest.findMany(...)` argument list, paren-matched. */
function findManyArgs(src: string): string[] {
  const out: string[] = [];
  const marker = 'abSkillManifest.findMany(';
  let from = 0;
  for (;;) {
    const call = src.indexOf(marker, from);
    if (call === -1) return out;
    let i = call + marker.length - 1;
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) break;
    }
    out.push(src.slice(call + marker.length, i));
    from = i;
  }
}

describe('the shared skill query', () => {
  it('asks for a deterministic row order', () => {
    expect(SKILL_QUERY('t-1').orderBy).toEqual({ name: 'asc' });
  });

  it('scopes to global rows plus this tenant', () => {
    expect(SKILL_QUERY('t-1').where).toEqual({ OR: [{ tenantId: null }, { tenantId: 't-1' }] });
  });

  it('does NOT filter on enabled — reconcileSkills needs to see disabled rows', () => {
    // Filtering in the query is what let a disabled skill be silently
    // re-enabled by the code fallback (#427): the fallback could not tell
    // "switched off" from "no row at all".
    expect(JSON.stringify(SKILL_QUERY('t-1').where)).not.toContain('enabled');
    const rows = [{ name: 'daily-briefing', tenantId: null, source: 'built_in', enabled: false }];
    expect(reconcileSkills(rows).map((s) => s.name)).not.toContain('daily-briefing');
  });
});

describe('every skill fetch delegates to it', () => {
  for (const [site, file] of FETCH_SITES) {
    it(`${site} uses SKILL_QUERY`, () => {
      const args = findManyArgs(readFileSync(file, 'utf8'));
      // A file that stopped fetching skills would otherwise pass vacuously.
      expect(args.length, `${site} no longer reads AbSkillManifest`).toBeGreaterThan(0);
      for (const arg of args) {
        expect(
          arg.trim(),
          `${site} hand-rolls its own query; ordering and the enabled rule then ` +
            'have to be re-derived correctly at every call site, which is how ' +
            'this invariant was lost twice',
        ).toMatch(/^SKILL_QUERY\(/);
      }
    });
  }

  it('covers every caller that passes skills to the brain', () => {
    // A fourth channel inherits the same hazard — this list has to grow with it.
    const routes = FETCH_SITES.slice(1);
    for (const [, file] of routes) {
      expect(readFileSync(file, 'utf8')).toContain('handleAgentMessage');
    }
    expect(routes.length).toBe(3);
  });
});
