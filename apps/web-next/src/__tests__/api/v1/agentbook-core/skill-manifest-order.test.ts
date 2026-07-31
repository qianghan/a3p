/**
 * Every skill fetch that feeds routing must ask the DB for a deterministic
 * row order (Launch-gap PR-5, G-5C).
 *
 * Skill routing tries skills in array order and takes the first match — see
 * "Skills are tried in array order — first match wins" in server.ts and the
 * collision comments in skill-routing.ts. Without `orderBy`, that array is in
 * whatever order Postgres happened to return, so when two skills' trigger
 * patterns both match an utterance, the winner is undefined and can change
 * between deploys, between replicas, or after a VACUUM.
 *
 * PR-5 added the `orderBy` to agent-brain.ts's own fetch and pinned it with
 * skill-manifest-query-order.test.ts. But agent-brain only runs that fetch when
 * the caller did NOT pass `skills`, and all three production channel routes DO
 * pass `skills` — so the tested guarantee covered a path production never
 * takes, and every real request routed against an unordered array.
 *
 * This is the guard for the routes that actually serve traffic. It is
 * deliberately structural: the Telegram webhook's `callAgentBrain` sits behind
 * grammy bot init, idempotency claims and rate limiting, so driving its POST to
 * reach the fetch would test the harness more than the invariant. Two of the
 * three also have behavioural coverage on the real handler —
 * agent-message-skills.test.ts and agentbook/whatsapp/webhook.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = join(__dirname, '../../../../app/api/v1');

/**
 * The channel routes that hand a pre-fetched `skills` array to
 * handleAgentMessage. Each one bypasses agent-brain's internal fetch, so each
 * one needs its own `orderBy`.
 */
const ROUTING_FETCH_SITES = [
  ['web chat', join(APP, 'agentbook-core/agent/message/route.ts')],
  ['telegram', join(APP, 'agentbook/telegram/webhook/route.ts')],
  ['whatsapp', join(APP, 'agentbook/whatsapp/webhook/route.ts')],
] as const;

/**
 * Extract the argument object of every `abSkillManifest.findMany(...)` call in
 * a source file, by walking braces from the call site. Regexing the whole file
 * for `orderBy` would pass on an `orderBy` belonging to some unrelated query.
 */
function skillManifestFindManyArgs(src: string): string[] {
  const out: string[] = [];
  const marker = 'abSkillManifest.findMany(';
  let from = 0;
  for (;;) {
    const call = src.indexOf(marker, from);
    if (call === -1) return out;
    const open = src.indexOf('{', call);
    let depth = 0;
    let i = open;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    out.push(src.slice(open, i + 1));
    from = i;
  }
}

const ORDER_BY_NAME_ASC = /orderBy:\s*\{\s*name:\s*'asc'\s*\}/;

describe('skill fetches that feed routing request a deterministic order', () => {
  for (const [channel, file] of ROUTING_FETCH_SITES) {
    it(`${channel} orders skills by name asc`, () => {
      const args = skillManifestFindManyArgs(readFileSync(file, 'utf8'));
      // A route that stopped fetching skills at all would otherwise pass vacuously.
      expect(args.length).toBeGreaterThan(0);
      for (const arg of args) {
        expect(arg).toMatch(ORDER_BY_NAME_ASC);
      }
    });
  }

  it('covers every channel route that passes skills to the brain', () => {
    // If a fourth channel appears and passes its own skills array, it inherits
    // the same hazard — this list has to grow with it.
    const covered = new Set(ROUTING_FETCH_SITES.map(([, f]) => f));
    for (const file of covered) {
      expect(readFileSync(file, 'utf8')).toContain('handleAgentMessage');
    }
    expect(covered.size).toBe(3);
  });
});
