import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The tax plugin's own modules must form a DAG.
 *
 * #513 added `tax-export -> tax-review-agent` without noticing that
 * `tax-efiling` already imported `validateFiling` from `tax-export`, closing:
 *
 *     tax-export -> tax-review-agent -> tax-efiling -> tax-export
 *
 * Under ESM, one binding in a cycle is still uninitialised while the other
 * module's body runs, so the symptom depends on load order. Here the confirm
 * step of the tax review silently stopped calling `submitFiling` — a filing
 * the user approved was never submitted, and no error was raised anywhere.
 *
 * Nothing caught it: the only failing test lived in agentbook-core, and CI
 * path-filters that job away on a PR touching only the tax plugin. Static
 * structure is the right place to catch this, because it needs no fixture and
 * no runtime.
 */
const SRC = join(__dirname, '..');

function moduleGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const f of readdirSync(SRC)) {
    if (!f.endsWith('.ts') || f.endsWith('.d.ts')) continue;
    const src = readFileSync(join(SRC, f), 'utf8');
    // Only same-directory relative imports; a cycle through a package would be
    // a different (and much louder) problem.
    const deps = [...src.matchAll(/from\s+'\.\/([A-Za-z0-9._-]+)\.js'/g)].map((m) => m[1]);
    graph.set(f.replace(/\.ts$/, ''), [...new Set(deps)]);
  }
  return graph;
}

function findCycle(graph: Map<string, string[]>): string[] | null {
  const state = new Map<string, 0 | 1 | 2>(); // 0 unvisited, 1 on stack, 2 done
  const stack: string[] = [];
  let found: string[] | null = null;

  const visit = (n: string): void => {
    if (found || state.get(n) === 2) return;
    if (state.get(n) === 1) {
      found = [...stack.slice(stack.indexOf(n)), n];
      return;
    }
    state.set(n, 1);
    stack.push(n);
    for (const d of graph.get(n) || []) {
      if (graph.has(d)) visit(d);
      if (found) return;
    }
    stack.pop();
    state.set(n, 2);
  };

  for (const n of graph.keys()) { visit(n); if (found) break; }
  return found;
}

describe('tax plugin module graph', () => {
  it('scans a real graph, not an empty one', () => {
    const g = moduleGraph();
    expect(g.size).toBeGreaterThan(5);
    expect([...g.values()].flat().length).toBeGreaterThan(5);
  });

  it('is acyclic', () => {
    const cycle = findCycle(moduleGraph());
    expect(
      cycle,
      cycle ? `import cycle: ${cycle.join(' -> ')}` : '',
    ).toBeNull();
  });
});
