// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Raw error text on the chat and MCP surfaces.
 *
 * The route-level sanitizer (#492) covers `error:` fields in JSON responses.
 * Neither of these two was a JSON field, so neither was covered:
 *
 *   agent-brain.ts  interpolated the caught value's message into the reply
 *                   the user reads, and then persisted it as the stored
 *                   conversation answer.
 *   mcp/route.ts    carried a comment saying only AgentBrainError messages
 *                   are surfaced, above code that surfaced any Error's.
 *
 * These are structural because the code is not reachable in a unit test
 * without standing up the brain and an MCP transport; the defect in both
 * cases is which value is placed in a user-visible string, which the source
 * shows directly. Comments are stripped first — the fix's own comments quote
 * the shape being banned.
 */

const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const BRAIN = 'plugins/agentbook-core/backend/src/agent-brain.ts';
const MCP = 'apps/web-next/src/app/api/v1/mcp/route.ts';
const CORE = 'plugins/agentbook-core/backend/src/server.ts';

describe('the chat reply never carries a raw error message', () => {
  it('the correction reply does not interpolate the local failure', () => {
    const src = stripComments(read(BRAIN));
    // The exact shape of the bug: `${failure ?? ...}` inside the user's reply.
    expect(src).not.toMatch(/I couldn't update that expense\. \$\{failure/);
    // It still reports the skill's own reason, which is sanitized at the HTTP
    // boundary it comes from, so the reply stays useful.
    expect(src).toContain("I couldn't update that expense. ${result?.skillResponse?.error");
  });

  it('the local failure is still logged, so this is not a loss of diagnosability', () => {
    const src = stripComments(read(BRAIN));
    expect(src).toMatch(/console\.error\('\[agent-brain\] correction execution failed:'[\s\S]{0,80}failure/);
  });

  it('the skill-failure detail on the main write path is the sanitized HTTP field only', () => {
    const src = stripComments(read(CORE));
    // `errorDetail` is rendered to the user as `Error: <detail>` in the
    // record-expense, create-invoice and record-personal-transaction replies
    // -- the most-used write paths. It fell back to the local catch's raw
    // message, so a fetch failure surfaced as
    // "Error: connect ECONNREFUSED 127.0.0.1:4051".
    expect(src).toContain("const errorDetail = skillResponse?.error || '';");
    expect(src).not.toMatch(/errorDetail\s*=\s*skillResponse\?\.error \|\| skillErrorMessage/);
    // The variable is gone entirely; console.error above logs the full error.
    expect(src).not.toContain('skillErrorMessage');
  });

  it('the undo path stays generic too (it was already correct)', () => {
    const src = stripComments(read(BRAIN));
    expect(src).not.toMatch(/reverse step failed[^`]*\$\{reverseError/);
    expect(src).toMatch(/console\.warn\('\[agent-brain\] undo reverse-call failed:'/);
  });
});

describe('MCP surfaces only the message written for the caller', () => {
  it('gates the surfaced text on AgentBrainError, not on Error', () => {
    const src = stripComments(read(MCP));
    expect(src).toContain('err instanceof AgentBrainError ? err.message');
    // The old shape accepted any Error.
    expect(src).not.toMatch(/const errMessage\s*=\s*err instanceof Error \? err\.message/);
  });

  it('logs the unexpected error it declines to surface', () => {
    const src = stripComments(read(MCP));
    expect(src).toMatch(/if \(!\(err instanceof AgentBrainError\)\)[\s\S]{0,80}console\.error/);
  });

  it('imports the class it now branches on', () => {
    expect(read(MCP)).toMatch(/import \{[^}]*AgentBrainError[^}]*\} from '@\/lib\/mcp\/ask-agentbook-tool'/);
  });
});
