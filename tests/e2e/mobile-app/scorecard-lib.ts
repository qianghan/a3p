export type GateStatus = 'pass' | 'fail' | 'pending';
export interface GateResult { id: string; gate: string; rubric: string; status: GateStatus; evidence: string }
export interface PwSummary { expected: number; unexpected: number; flaky: number; skipped: number }
export interface Limitation { id: string; title: string; text: string }
export interface PerfOverride { route: string; allowanceKb: number; reason: string }
export interface ReportMeta { base: string; commit: string; runAt: string; knownLimitations?: Limitation[] }

export function summarizePlaywright(report: unknown): PwSummary {
  const s = ((report as { stats?: Record<string, unknown> } | null)?.stats ?? {}) as Record<string, unknown>;
  return {
    expected: Number(s.expected ?? 0), unexpected: Number(s.unexpected ?? 0),
    flaky: Number(s.flaky ?? 0), skipped: Number(s.skipped ?? 0),
  };
}

/** Launch gates are deterministic or they are not gates: skipped/flaky/empty all fail. */
export function playwrightStatus(s: PwSummary): 'pass' | 'fail' {
  if (s.unexpected > 0 || s.flaky > 0 || s.skipped > 0) return 'fail';
  return s.expected > 0 ? 'pass' : 'fail';
}

/** A gate whose result file is absent did not run; that is a failure, not a pass. */
export function missingResultGate(id: string, gate: string, rubric: string): GateResult {
  return { id, gate, rubric, status: 'fail', evidence: 'not run: no result file' };
}

export function checklistStatus(md: string): { status: GateStatus; done: number; total: number } {
  const done = (md.match(/^\s*- \[[xX]\]/gm) ?? []).length;
  const open = (md.match(/^\s*- \[ \]/gm) ?? []).length;
  const total = done + open;
  return { status: total > 0 && open === 0 ? 'pass' : 'pending', done, total };
}

/**
 * Verdict rule: GO only if there is at least one gate and EVERY gate is PASS.
 * FAIL and PENDING (manual, unticked) both give NO-GO. There is no CONDITIONAL.
 */
export function verdict(results: GateResult[]): 'GO' | 'NO-GO' {
  return results.length > 0 && results.every((r) => r.status === 'pass') ? 'GO' : 'NO-GO';
}

type Suite = { title?: string; suites?: Suite[]; specs?: Array<{ tests?: Array<{ results?: Array<{ status?: string }> }> }> };
export function personaBreakdown(report: unknown): Record<string, { passed: number; failed: number }> {
  const out: Record<string, { passed: number; failed: number }> = {};
  const walk = (s: Suite, persona: string | null) => {
    const m = /^matrix — (\w+)$/.exec(s.title ?? '');
    const p = m ? m[1] : persona;
    for (const spec of s.specs ?? []) {
      for (const t of spec.tests ?? []) {
        if (!p) continue;
        const last = t.results?.[t.results.length - 1]?.status;
        out[p] ??= { passed: 0, failed: 0 };
        if (last === 'passed') out[p].passed += 1; else out[p].failed += 1;
      }
    }
    for (const child of s.suites ?? []) walk(child, p);
  };
  for (const s of ((report as { suites?: Suite[] } | null)?.suites ?? [])) walk(s, null);
  return out;
}

/** Reads bin/perf-mobile-overrides.json; keys starting with "_" are comments. */
export function parseOverrides(json: unknown): PerfOverride[] {
  if (!json || typeof json !== 'object') return [];
  return Object.entries(json as Record<string, unknown>)
    .filter(([k, v]) => !k.startsWith('_') && v && typeof v === 'object')
    .map(([route, v]) => {
      const o = v as { allowanceKb?: unknown; reason?: unknown };
      return { route, allowanceKb: Number(o.allowanceKb ?? 0), reason: String(o.reason ?? '(no reason recorded)') };
    });
}

/**
 * Typed list of accepted/known issues. Rendered in every report. They are
 * disclosures: they never flip the verdict by themselves (gates do that), and
 * they are never omitted when the verdict is GO.
 */
export function knownLimitations(
  overrides: PerfOverride[],
  device: { status: GateStatus; done: number; total: number },
): Limitation[] {
  const perf = overrides.length
    ? overrides.map((o) => `${o.route}: allowance +${o.allowanceKb} kB over baseline. ${o.reason}`).join(' ')
    : 'No overrides are recorded in bin/perf-mobile-overrides.json.';
  return [
    {
      id: 'K1', title: 'Foreign-currency seed data shows in tenant currency',
      text: "A seeded USD expense on Maya's CAD tenant displays as \"CA$25\". Amounts are shown in the tenant currency with no conversion; fixing it needs an API change.",
    },
    {
      id: 'K2', title: 'Chat shows the plan twice',
      text: 'Chat renders the plan twice in one bubble: the server text and the localized plan card.',
    },
    {
      id: 'K3', title: 'First Load JS over baseline + 40 kB (accepted overrides)',
      text: `/app and /app/chat exceed baseline + 40 kB and are accepted via reasoned overrides in bin/perf-mobile-overrides.json. ${perf}`,
    },
    {
      id: 'K4', title: 'No real-device pass',
      text: device.status === 'pass'
        ? `Manual iOS Safari / Android Chrome checklist complete (${device.done}/${device.total}).`
        : `No real iOS Safari or Android Chrome pass yet: NOT YET DONE (${device.done}/${device.total} manual checks ticked). Gate G13 is PENDING, which makes the verdict NO-GO.`,
    },
  ];
}

// Backslashes first: escaping only '|' lets a trailing backslash in the input un-escape it ('\\|' -> '\\\\|') and split the row.
const cell = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();

export function renderReport(results: GateResult[], meta: ReportMeta): string {
  const v = verdict(results);
  const rows = results.map((r) => `| ${r.id} | ${cell(r.gate)} | ${cell(r.rubric)} | ${r.status.toUpperCase()} | ${cell(r.evidence)} |`);
  const lims = meta.knownLimitations ?? [];
  return [
    '# AgentBook mobile app (/app PWA) — launch report',
    '',
    `Run: ${meta.runAt} · Target: ${meta.base} · main @ \`${meta.commit}\``,
    'Spec: docs/superpowers/specs/2026-10-07-mobile-app-ux-design.md §8 (rubric). Generated by tests/e2e/mobile-app/scorecard.ts.',
    '',
    `**Verdict: ${v}**`,
    '',
    '| Gate | What | Spec | Status | Evidence |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    v === 'GO'
      ? 'All gates passed, including the manual device pass.'
      : 'NO-GO until every row is PASS. PENDING rows are manual items; FAIL rows have evidence above and artifacts in tests/e2e/mobile-app/results/. A gate passes only if it ran clean: skipped, flaky, zero-test and not-run all count as FAIL.',
    '',
    ...(lims.length ? ['## Known limitations', '', 'Disclosed, not hidden. These do not change the verdict by themselves.', '', ...lims.map((l) => `- **${l.id} ${l.title}.** ${l.text}`), ''] : []),
  ].join('\n');
}
