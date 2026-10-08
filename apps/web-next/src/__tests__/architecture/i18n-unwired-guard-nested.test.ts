/**
 * bin/i18n-unwired-key-guard.sh must SEE nested catalog namespaces.
 *
 * The `mobile` namespace is nested (mobile.tabs.home). The guard once walked
 * only top-level string values, so for `mobile` it saw nothing and reported a
 * clean zero — it could never have flagged a hardcoded "Retry" in app/app/**.
 * A hard-zero guard that cannot see a namespace is worse than none, because the
 * zero is believed. These tests point the guard at a fixture (GUARD_LOCALES_EN /
 * GUARD_ROOTS, which are inert when unset) and at the real catalog.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../../../..');
const GUARD = join(ROOT, 'bin/i18n-unwired-key-guard.sh');

let dir: string;
let enDir: string;
let srcDir: string;

function runGuard(env: Record<string, string>) {
  const r = spawnSync('bash', [GUARD, '--list'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return r.stdout + r.stderr;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'unwired-guard-'));
  enDir = join(dir, 'en');
  srcDir = join(dir, 'src');
  mkdirSync(enDir);
  mkdirSync(srcDir);
  writeFileSync(
    join(enDir, 'fixture.json'),
    JSON.stringify({
      flat_key: 'Flat fixture label',
      deep: { group: { leaf: 'Nested fixture label' } },
      with_param: { msg: 'Hello {name}' },
    }),
  );
  writeFileSync(
    join(srcDir, 'Probe.tsx'),
    [
      'export const A = () => <b>Flat fixture label</b>;',
      'export const B = () => <b>Nested fixture label</b>;',
      'export const C = () => <b>Hello {name}</b>;',
      'export const D = () => <b>Unrelated words here</b>;',
    ].join('\n'),
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('i18n-unwired-key-guard recurses into nested namespaces', () => {
  it('flags a literal equal to a top-level key (control)', () => {
    const out = runGuard({ GUARD_LOCALES_EN: enDir, GUARD_ROOTS: srcDir });
    expect(out).toContain(`"Flat fixture label"  -> t('fixture.flat_key')`);
  });

  it('flags a literal equal to a NESTED key, naming its full dotted path', () => {
    const out = runGuard({ GUARD_LOCALES_EN: enDir, GUARD_ROOTS: srcDir });
    expect(out).toContain(`"Nested fixture label"  -> t('fixture.deep.group.leaf')`);
  });

  it('still ignores unrelated text', () => {
    const out = runGuard({ GUARD_LOCALES_EN: enDir, GUARD_ROOTS: srcDir });
    expect(out).not.toContain('Unrelated words here');
  });

  it('sees the real mobile namespace: a literal "No receipt image" maps to mobile.kit.no_receipt', () => {
    const real = join(dir, 'real');
    mkdirSync(real);
    writeFileSync(join(real, 'Real.tsx'), 'export const R = () => <span>No receipt image</span>;\n');
    const out = runGuard({ GUARD_ROOTS: real });
    expect(out).toContain(`"No receipt image"  -> t('mobile.kit.no_receipt')`);
  });
});
