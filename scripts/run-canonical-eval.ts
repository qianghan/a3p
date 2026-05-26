#!/usr/bin/env tsx
/**
 * Offline canonical-eval harness (PR 47 / Tier 1 #4).
 *
 * Replays the canonical-utterance suite (tests/e2e/nightly/canonical-utterances.ts)
 * against a running AgentBook deployment and produces a JSON report:
 *
 *   {
 *     total, passed, failed, intentAccuracy, hallucinationRate,
 *     byCategory: { bookkeeping: {n, passRate}, ... },
 *     bySkill:    { 'record-expense': {n, passRate}, ... },
 *     failures:   [{ id, text, expectedSkill, actualSkill, reasons }]
 *   }
 *
 * Usage:
 *   tsx scripts/run-canonical-eval.ts \
 *     [--base-url=http://localhost:3000] \
 *     [--cookie="naap_auth_token=..."] \
 *     [--filter=bookkeeping] \
 *     [--out=./eval-report.json]
 *
 * Auth: pass a session cookie via --cookie. Logging in is out of scope —
 * use the e2e seed user (E2E_USER_EMAIL / E2E_USER_PASSWORD) and capture
 * its cookie once via the browser dev tools, or wire the harness into
 * the Playwright suite which already handles login.
 *
 * The harness is intentionally a thin runner. The same canonical set
 * powers the Playwright nightly suite at phase8-canonical-agent.spec.ts —
 * this script is for ad-hoc runs against a staging or local agent
 * without the Playwright dependency.
 */

import { CANONICAL, type CanonicalUtterance } from '../tests/e2e/nightly/canonical-utterances';
import * as fs from 'node:fs';

interface CliArgs {
  baseUrl: string;
  cookie: string | null;
  filter: string | null;
  out: string | null;
  verbose: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    baseUrl: 'http://localhost:3000',
    cookie: null,
    filter: null,
    out: null,
    verbose: false,
  };
  for (const arg of argv) {
    if (arg.startsWith('--base-url=')) out.baseUrl = arg.slice('--base-url='.length);
    else if (arg.startsWith('--cookie=')) out.cookie = arg.slice('--cookie='.length);
    else if (arg.startsWith('--filter=')) out.filter = arg.slice('--filter='.length);
    else if (arg.startsWith('--out=')) out.out = arg.slice('--out='.length);
    else if (arg === '--verbose' || arg === '-v') out.verbose = true;
  }
  return out;
}

interface AgentMessageResponse {
  success?: boolean;
  data?: {
    message?: string;
    skillUsed?: string;
    confidence?: number;
    citations?: unknown[];
  };
}

async function sendUtterance(args: CliArgs, text: string): Promise<AgentMessageResponse | null> {
  try {
    const res = await fetch(`${args.baseUrl}/api/v1/agentbook-core/agent/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(args.cookie ? { Cookie: args.cookie } : {}),
      },
      body: JSON.stringify({ text, channel: 'web' }),
    });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as AgentMessageResponse;
  } catch {
    return null;
  }
}

interface TurnResult {
  cu: CanonicalUtterance;
  passed: boolean;
  reasons: string[];
  skillUsed: string | undefined;
  hallucinated: boolean;
}

function evaluateTurn(cu: CanonicalUtterance, response: AgentMessageResponse | null): TurnResult {
  const reasons: string[] = [];
  if (!response || !response.success || !response.data) {
    return {
      cu,
      passed: false,
      reasons: ['agent returned no successful response'],
      skillUsed: undefined,
      hallucinated: false,
    };
  }
  const answer = response.data.message ?? '';
  const skillUsed = response.data.skillUsed;

  if (cu.expectedSkill && skillUsed && skillUsed !== cu.expectedSkill) {
    reasons.push(`expected skill "${cu.expectedSkill}", got "${skillUsed}"`);
  }
  for (const must of cu.required ?? []) {
    if (!answer.includes(must)) {
      reasons.push(`missing required substring: "${must}"`);
    }
  }
  let hallucinated = false;
  for (const forbidden of cu.forbidden ?? []) {
    if (answer.includes(forbidden)) {
      reasons.push(`forbidden substring present: "${forbidden}"`);
      hallucinated = true;
    }
  }
  return { cu, passed: reasons.length === 0, reasons, skillUsed, hallucinated };
}

interface CategoryStat {
  n: number;
  passed: number;
  passRate: number;
}

function summarize(results: TurnResult[]) {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const hallucinated = results.filter((r) => r.hallucinated).length;

  const byCategory: Record<string, CategoryStat> = {};
  const bySkill: Record<string, CategoryStat> = {};
  for (const r of results) {
    const c = r.cu.category;
    if (!byCategory[c]) byCategory[c] = { n: 0, passed: 0, passRate: 0 };
    byCategory[c].n += 1;
    if (r.passed) byCategory[c].passed += 1;
    const skillKey = r.cu.expectedSkill ?? 'unknown';
    if (!bySkill[skillKey]) bySkill[skillKey] = { n: 0, passed: 0, passRate: 0 };
    bySkill[skillKey].n += 1;
    if (r.passed) bySkill[skillKey].passed += 1;
  }
  for (const stat of Object.values(byCategory)) stat.passRate = stat.n ? stat.passed / stat.n : 0;
  for (const stat of Object.values(bySkill)) stat.passRate = stat.n ? stat.passed / stat.n : 0;

  return {
    total,
    passed,
    failed: total - passed,
    intentAccuracy: total ? passed / total : 0,
    hallucinationRate: total ? hallucinated / total : 0,
    byCategory,
    bySkill,
    failures: results
      .filter((r) => !r.passed)
      .map((r) => ({
        id: r.cu.id,
        text: r.cu.text,
        expectedSkill: r.cu.expectedSkill,
        actualSkill: r.skillUsed,
        reasons: r.reasons,
      })),
  };
}

function printSummary(summary: ReturnType<typeof summarize>): void {
  console.log('=== Canonical Eval Summary ===');
  console.log(`Total:              ${summary.total}`);
  console.log(`Passed:             ${summary.passed} (${(summary.intentAccuracy * 100).toFixed(1)}%)`);
  console.log(`Failed:             ${summary.failed}`);
  console.log(`Hallucination rate: ${(summary.hallucinationRate * 100).toFixed(1)}%`);
  console.log('');
  console.log('By category:');
  for (const [cat, stat] of Object.entries(summary.byCategory)) {
    console.log(`  ${cat.padEnd(14)} ${stat.passed}/${stat.n}  (${(stat.passRate * 100).toFixed(1)}%)`);
  }
  if (summary.failed > 0) {
    console.log('');
    console.log('Failures:');
    for (const f of summary.failures) {
      console.log(`  - [${f.id}] "${f.text.slice(0, 60)}"`);
      for (const r of f.reasons) console.log(`      · ${r}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const subset = args.filter
    ? CANONICAL.filter((u) => u.category === args.filter || u.persona === args.filter)
    : CANONICAL;

  if (subset.length === 0) {
    console.error(`No utterances matched filter "${args.filter}"`);
    process.exit(1);
  }

  console.log(`Running ${subset.length} canonical utterances against ${args.baseUrl} ...`);
  if (!args.cookie) {
    console.warn('Warning: no --cookie provided; the agent will reject unauthenticated requests.');
  }

  const results: TurnResult[] = [];
  for (const cu of subset) {
    if (args.verbose) {
      console.log(`  [${cu.id}] ${cu.text.slice(0, 60)}...`);
    }
    const resp = await sendUtterance(args, cu.text);
    results.push(evaluateTurn(cu, resp));
  }

  const summary = summarize(results);
  printSummary(summary);

  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(summary, null, 2));
    console.log(`\nReport written to ${args.out}`);
  }

  // Exit non-zero if intent accuracy < 80% so CI can gate on it.
  if (summary.intentAccuracy < 0.8) process.exit(2);
}

main().catch((err) => {
  console.error('Eval harness failed:', err);
  process.exit(1);
});
