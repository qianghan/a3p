import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toKebabCase, KNOWN_ICON_NAMES } from '@/components/ui/PluginIcon';

const REPO = join(__dirname, '..', '..', '..', '..');

describe('toKebabCase', () => {
  it.each([
    ['BrainCircuit', 'brain-circuit'],
    ['Trophy', 'trophy'],
    ['BarChart3', 'bar-chart-3'],   // digit splits, matching lucide's naming
    ['GraduationCap', 'graduation-cap'],
    ['rocket', 'rocket'],           // already-kebab registry rows pass through
    ['brain-circuit', 'brain-circuit'],
    ['XMLFile', 'xml-file'],        // acronym run followed by a word
    ['message_square', 'message-square'],
  ])('%s -> %s', (input, expected) => {
    expect(toKebabCase(input)).toBe(expected);
  });
});

describe('icon coverage', () => {
  /**
   * The map in PluginIcon is a closed set — that is the point of it, since the
   * open set is the ~1,500-icon bundle this component exists to avoid. The
   * risk that creates is a plugin naming an icon nobody added, which renders a
   * placeholder and looks like bad data rather than a missing entry.
   *
   * So: scan the repo for icon names the way the registry gets them, and fail
   * with the missing name. This is the guard that makes the closed set safe.
   */
  it('covers every icon name declared anywhere in the repo', () => {
    const grep = (pattern: string, globs: string[]) => {
      try {
        return execFileSync(
          'grep',
          ['-rhoE', pattern, ...globs.flatMap((g) => ['--include', g]),
           'plugins', 'bin', 'packages', 'apps/web-next/public/cdn/plugins'],
          { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
        ).split('\n');
      } catch {
        return []; // grep exits 1 on no matches
      }
    };

    const names = new Set<string>();
    for (const line of grep('"icon"[[:space:]]*:[[:space:]]*"[A-Za-z0-9_-]+"', ['manifest.json', '*.json', '*.ts', '*.tsx'])) {
      const m = line.match(/"icon"\s*:\s*"([A-Za-z0-9_-]+)"/);
      if (m) names.add(m[1]);
    }
    for (const line of grep("icon:[[:space:]]*'[A-Za-z0-9_-]+'", ['*.ts', '*.tsx'])) {
      const m = line.match(/icon:\s*'([A-Za-z0-9_-]+)'/);
      if (m) names.add(m[1]);
    }

    // Guard the guard: if the scan finds nothing the assertion below passes
    // vacuously and this test becomes decoration.
    expect(names.size).toBeGreaterThan(15);

    const missing = [...names]
      .filter((n) => !/^(icon|text-[a-z]+-\d+)$/.test(n))          // not icon names
      .filter((n) => !KNOWN_ICON_NAMES.includes(toKebabCase(n)));

    expect(
      missing,
      `Add these to ICONS in src/components/ui/PluginIcon.tsx (as kebab-case keys): ${missing.join(', ')}`,
    ).toEqual([]);
  });
});

describe('no route re-introduces the whole icon library', () => {
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it.each([
    'src/app/(dashboard)/settings/page.tsx',
    'src/app/(dashboard)/admin/plugins/page.tsx',
  ])('%s does not namespace-import lucide', (rel) => {
    const src = strip(readFileSync(join(__dirname, '..', '..', rel), 'utf8'));
    // `import * as X from 'lucide-react'` defeats tree-shaking outright; the
    // dynamic entrypoint is cheap per-page but adds ~1,500 entries to the
    // global webpack runtime manifest, which every route pays for.
    expect(src).not.toMatch(/import\s+\*\s+as\s+\w+\s+from\s+['"]lucide-react['"]/);
    expect(src).not.toMatch(/from\s+['"]lucide-react\/dynamic['"]/);
  });
});
