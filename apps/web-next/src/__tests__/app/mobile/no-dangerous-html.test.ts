import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The mobile app renders server and LLM text; it must never hand it to the HTML parser. */
const ROOT = join(__dirname, '..', '..', '..', 'app', 'app');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|jsx?)$/.test(e) ? [p] : [];
  });
}

describe('app/app never uses raw HTML injection', () => {
  it('scans a real tree', () => {
    expect(files(ROOT).length).toBeGreaterThan(5);
  });
  it.each(['dangerouslySetInnerHTML', '.innerHTML =', 'insertAdjacentHTML', 'document.write('])(
    'no %s',
    (needle) => {
      const hits = files(ROOT).filter((f) => readFileSync(f, 'utf8').includes(needle));
      expect(hits).toEqual([]);
    },
  );
});
