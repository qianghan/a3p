/**
 * The plugin info panel shows a publisher. The registry rows carry no author, so the fallback IS what users see:
 * it read "NAAP Team" (the project this repo was forked from) until it was renamed to AgentBook.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('plugin publisher brand', () => {
  it('the plugin page and plugin discovery fall back to AgentBook, never NAAP', () => {
    for (const f of ['apps/web-next/src/app/(dashboard)/plugins/[pluginName]/page.tsx', 'packages/database/src/plugin-discovery.ts']) {
      const src = read(f);
      expect(src, f).not.toMatch(/NAAP Team/);
      expect(src, f).toMatch(/'AgentBook'/);
    }
  });

  it('every agentbook plugin manifest names AgentBook as its author', () => {
    const dirs = readdirSync(join(ROOT, 'plugins')).filter((d) => d.startsWith('agentbook-'));
    expect(dirs.length).toBeGreaterThan(0);
    for (const d of dirs) {
      let manifest: { author?: string | { name?: string } };
      try { manifest = JSON.parse(read(`plugins/${d}/plugin.json`)); } catch { continue; }
      const name = typeof manifest.author === 'string' ? manifest.author : manifest.author?.name;
      expect(name, d).toBe('AgentBook');
    }
  });
});
