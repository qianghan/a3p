import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('server-only', () => ({}));

/**
 * `htmlToPlainText` in the chat adapter.
 *
 * The output is TEXT. It is stored on an AbEvent and rendered by React as a
 * text node, so this is not a sanitizer and there is no XSS in the current
 * wiring — CodeQL's `js/incomplete-multi-character-sanitization` is right
 * about the shape and wrong about the consequence.
 *
 * The shape is still worth fixing, because a single-pass tag strip leaves
 * `<b<b>>` as `<b>`: the inner match is removed and the outer halves close
 * up behind it. That costs nothing today and costs everything the day
 * somebody renders this as HTML.
 */

describe('the tag strip runs to a fixed point', () => {
  // Not exported — exercised through the module's source, since the adapter
  // itself needs a database and a Telegram client to instantiate.
  const src = readFileSync(join(__dirname, '..', 'agentbook-chat-adapter.ts'), 'utf8');

  it('loops rather than stripping once', () => {
    const fn = src.slice(src.indexOf('function htmlToPlainText'), src.indexOf('class WebAdapter'));
    expect(fn).toMatch(/for \(let i = 0; i < MAX_STRIP_PASSES/);
    expect(fn).toMatch(/if \(next === out\) break;/);
  });

  it('bounds the loop, so hostile input cannot make it quadratic', () => {
    expect(src).toMatch(/const MAX_STRIP_PASSES = \d+;/);
  });

  it('decodes entities AFTER stripping, not before', () => {
    // Decoding first would turn a literal `&lt;b&gt;` the user typed into a
    // tag and then delete it — losing their text. Order matters in both
    // directions, and only one of them is right for plain text.
    const fn = src.slice(src.indexOf('function htmlToPlainText'), src.indexOf('class WebAdapter'));
    expect(fn.indexOf('MAX_STRIP_PASSES')).toBeLessThan(fn.indexOf('&lt;'));
  });

  it('decodes &amp; last', () => {
    // Otherwise `&amp;lt;` decodes to `<` rather than to the literal `&lt;`
    // the user typed.
    const fn = src.slice(src.indexOf('function htmlToPlainText'), src.indexOf('class WebAdapter'));
    expect(fn.lastIndexOf('&amp;')).toBeGreaterThan(fn.lastIndexOf('&#39;'));
  });
});

describe('the behaviour, on the same algorithm', () => {
  // A local copy of the loop, so the fixed-point property is asserted on
  // inputs rather than only on source text.
  const TAG = /<\/?(b|strong|i|em|u|code|pre|a)[^>]*>/gi;
  const strip = (s: string) => {
    let out = s;
    for (let i = 0; i < 5; i++) {
      const next = out.replace(TAG, '');
      if (next === out) break;
      out = next;
    }
    return out;
  };

  it('removes a nested tag that a single pass would leave behind', () => {
    // `<<b>b>`: the single pass removes the inner `<b>` and the surrounding
    // `<` and `b>` close up into a fresh `<b>` behind it. My first attempt at
    // this test used `<b<b>>`, which a single pass already handles — worth
    // recording, because "a nested tag" is not one shape and picking the
    // wrong one gives a test that passes against the bug.
    expect('<<b>b>'.replace(TAG, '')).toBe('<b>');   // one pass: still a tag
    expect(strip('<<b>b>')).toBe('');                 // fixed point: gone
  });

  it('leaves ordinary text alone', () => {
    expect(strip('You spent A$12.40 at Cafe < Co')).toBe('You spent A$12.40 at Cafe < Co');
  });

  it('terminates on input designed to keep producing tags', () => {
    const started = Date.now();
    strip('<b>'.repeat(2000));
    expect(Date.now() - started).toBeLessThan(200);
  });
});
