import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The failure branch of `_executeClassificationCore` is the last thing a user
 * hears when a skill's HTTP call did not work, and it was handed the RAW turn
 * text rather than the resolved one.
 *
 * That matters because Step 2.5 of the brain rewrites the turn before
 * classification — pronouns, the time window, and (since the follow-up-topic
 * fix) the previous question's topic. The classifier extracts `question` from
 * THAT string, so `extractedParams.question` is the self-contained version and
 * `text` is the bare one the user typed. Passing `text` is why:
 *
 *   user: Give me more details
 *   bot:  More details about what?
 *
 * survived a fix whose entire purpose was to make that turn self-contained:
 * the resolved string existed, it just never reached the one function that
 * needed it.
 *
 * A source assertion rather than a behavioural one because the branch only
 * runs on a failed HTTP skill call, and the argument is the whole defect —
 * a test that stubbed the call would be asserting on its own stub.
 */
describe('the engagement fallback sees the resolved question', () => {
  const src = readFileSync(join(__dirname, '../server.ts'), 'utf8');

  it('passes extractedParams.question ahead of the raw text', () => {
    const call = src.slice(src.indexOf('message = await accountantEngagement({'));
    expect(
      call.slice(0, 1400),
      'the engagement fallback is still given the unresolved turn text',
    ).toMatch(/userText:\s*extractedParams\.question\s*\|\|\s*text\b/);
  });

  it('still reports the endpoint it actually attempted', () => {
    // The attempted action names the route, not the question — keeping these
    // two distinct is what lets the model say "I tried X" truthfully.
    const call = src.slice(src.indexOf('message = await accountantEngagement({'));
    expect(call.slice(0, 1400)).toMatch(/attemptedAction:\s*`\$\{endpoint\.method/);
  });
});
