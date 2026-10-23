#!/usr/bin/env node
/**
 * Performance budgets for the Next.js app.
 *
 * WHY THIS EXISTS
 * Nothing about performance was measured anywhere in this repo — no load test,
 * no Lighthouse budget, no bundle budget. An unmeasured dimension cannot
 * regress loudly; it just gets worse. This does two jobs at once: it PRINTS the
 * current numbers, so there is a baseline in the log of every build, and it
 * FAILS when they cross a line.
 *
 * WHAT IT MEASURES
 *   1. First Load JS per route, parsed from the `next build` route table.
 *   2. First Load JS shared by every route — the floor no page can beat.
 *   3. Total font payload in .next/static/media.
 *
 * WHAT IT DOES NOT MEASURE
 * Field metrics. LCP, CLS and INP depend on a real browser against a real
 * deployment, and asserting them from CI on a cold serverless function
 * measures the cold start, not the page. Those belong on the deployed preview,
 * and the numbers recorded in docs/performance-baseline.md were taken that way.
 *
 * KNOWN OFFENDERS ARE LISTED, NOT HIDDEN
 * `/settings` and `/admin/plugins` are far over the default budget today. They
 * are named in ROUTE_EXCEPTIONS with the measured value, so the guard passes on
 * the state of the world as it is while still refusing to let them grow — and
 * so the debt is written down somewhere that fails when it worsens, rather than
 * living in someone's memory.
 *
 * USAGE
 *   next build | tee build.log
 *   node bin/perf-budget.mjs build.log [--update]
 */

import fs from 'node:fs';
import path from 'node:path';

const KB = 1024;

/** Default ceiling for a route's First Load JS. */
const ROUTE_BUDGET_KB = 250;

/**
 * Routes already over the default, with the value measured on 2026-09-07.
 * The number is the CEILING, not a target: each is ~10% above what it
 * measured, so ordinary churn passes and real growth fails. Lowering these is
 * the work; raising one should need a reason in the PR.
 */
const ROUTE_EXCEPTIONS = {
  // Was 494 kB — the worst route in the app, and 445 kB of that was the whole
  // lucide icon library pulled in by a namespace import. Then 320 kB, then
  // 286 kB once the server-only translation namespaces stopped shipping to the
  // browser, and now 243 kB with only one locale in the bundle instead of
  // three. Still over the default because the page itself is 68 kB of tab
  // content. Lowered 340 -> 315 -> 270 as each saving landed, keeping the
  // ~10% margin rather than banking it as slack.
  '/settings': 270,
  // '/marketplace' had an exception at 275 for exactly one build. It sat at
  // 250 — the default, to the kilobyte — so eight translation keys added for a
  // Settings control tipped it over, and the exception bought room while the
  // catalog was split. The split landed: it measures 216 kB, comfortably under
  // the default, so the exception is deleted rather than left at a slack value.
  // An exception nobody needs is a ceiling nobody notices rising.
  // '/admin/plugins' was 405 kB for the same reason and is now 217 kB, under
  // the default. Its exception is deleted rather than kept at a slack value —
  // an exception nobody needs is a ceiling nobody notices rising.
};

/** First Load JS shared by every route. Measured 103 kB. */
const SHARED_BUDGET_KB = 115;

/**
 * A NOTE ON WHERE THE i18n CATALOG SHOWS UP, because it is not obvious from
 * these numbers and it cost a day to work out once.
 *
 * The translation catalog is NOT in the shared-by-all figure. It reaches page
 * routes through the root layout, which renders ShellProvider — so it is in
 * the First Load JS of all 35 page routes and none of the 530 API routes, and
 * `shared by all` never moves when it changes. A key added for one page is
 * therefore carried by every page, which is how /marketplace came to fail on
 * eight strings written for /settings.
 *
 * Nothing tree-shakes it: 97 kB gzipped, measured. Two savings have been taken
 * out of that, worth -35 and -43 kB on all 35 of those routes:
 *
 *   the server-only namespaces (bot, skill, proactive, rate) never reach the
 *   browser, and only the REFERENCE locale is in the bundle — fr-CA and zh-CN
 *   arrive as their own chunks when a user actually reads in them.
 *
 * What is left is roughly 20 kB of English UI strings, which is the floor for
 * a product that renders text without a round trip.
 *
 * `bin/i18n-bundle-guard.sh --shell` is what keeps both from regressing, and it
 * is the guard to reach for rather than this file: a regression here shows up
 * as a diffuse rise across many routes with no cause attached, which is how
 * this went unnoticed in the first place.
 */

/**
 * Total woff2/woff in .next/static/media. Measured 1156 kB.
 *
 * Note this counts every font FILE the build produced, which is not what any
 * one visitor downloads — the landing page fetches five of them (419 kB) and
 * app routes fetch a different, smaller subset. It is a payload ceiling for
 * the repo, not a page weight; the page-level number lives in
 * docs/performance-baseline.md where it can be compared against the field.
 */
const FONT_BUDGET_KB = 1250;

function parseSize(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (unit === 'MB') return n * 1024;
  if (unit === 'kB') return n;
  if (unit === 'B') return n / 1024;
  return null;
}

/** Pull `route → First Load JS (kB)` out of the build's route table. */
export function parseRoutes(log) {
  const routes = [];
  for (const line of log.split('\n')) {
    // "├ ○ /settings    5.32 kB    494 kB"  — the LAST size is First Load JS.
    if (!/^[├└┌]\s/.test(line)) continue;
    const m = line.match(/^[├└┌]\s+[ƒ○●λ]?\s*(\S+)\s+([\d.]+)\s*(B|kB|MB)\s+([\d.]+)\s*(B|kB|MB)\s*$/);
    if (!m) continue;
    const firstLoad = parseSize(m[4], m[5]);
    if (firstLoad === null) continue;
    routes.push({ route: m[1], firstLoadKb: firstLoad });
  }
  return routes;
}

export function parseShared(log) {
  const m = log.match(/First Load JS shared by all\s+([\d.]+)\s*(B|kB|MB)/);
  return m ? parseSize(m[1], m[2]) : null;
}

function fontBytes(nextDir) {
  const media = path.join(nextDir, 'static', 'media');
  if (!fs.existsSync(media)) return null;
  let total = 0;
  for (const f of fs.readdirSync(media)) {
    if (!/\.(woff2?|ttf|otf)$/.test(f)) continue;
    total += fs.statSync(path.join(media, f)).size;
  }
  return total / KB;
}

/**
 * /app PWA budgets: the measured pre-redesign First Load JS + 40 kB (gzip, as
 * `next build` prints it), per spec 2026-10-07 section 8.3. The baseline lives
 * in bin/perf-baseline-mobile.json with the commit and method it was measured
 * by. Routes the redesign added (the viewer) borrow their parent's baseline.
 * The shared-by-all figure is bounded too: a bundle "fix" once moved cost out
 * of a route and into the shared runtime manifest, which a per-route check
 * alone cannot see.
 */
export const MOBILE_BASELINE_ROUTES = ['/app', '/app/capture', '/app/chat', '/app/docs'];

export function mobileBudgets(baseline) {
  // A route can carry its own allowance, but only with a written reason: raising a budget silently is the failure
  // mode this guard exists to prevent. The reason lives next to the number, in bin/perf-baseline-mobile.json.
  const overrides = baseline.overrides ?? {};
  for (const [route, o] of Object.entries(overrides)) {
    if (!(route in baseline.routes)) throw new Error(`perf-baseline-mobile: override for unknown route ${route}`);
    if (typeof o?.allowanceKb !== 'number' || typeof o?.reason !== 'string' || o.reason.trim() === '') {
      throw new Error(`perf-baseline-mobile: override for ${route} needs a numeric allowanceKb and a non-empty reason`);
    }
  }
  const allowanceFor = (route) => overrides[route]?.allowanceKb ?? baseline.allowanceKb;
  const out = {};
  for (const [route, kb] of Object.entries(baseline.routes)) out[route] = kb + allowanceFor(route);
  for (const [route, parent] of Object.entries(baseline.inheritFrom ?? {})) {
    out[route] = baseline.routes[parent] + allowanceFor(parent);
  }
  return out;
}

export function checkMobileRoutes(routes, baseline, sharedKb = null) {
  const failures = [];
  for (const [route, budget] of Object.entries(mobileBudgets(baseline))) {
    const r = routes.find((x) => x.route === route);
    if (!r) {
      failures.push(`${route}: missing from the build table — the mobile budget cannot be checked`);
      continue;
    }
    if (r.firstLoadKb > budget) {
      failures.push(`${route}: First Load JS ${r.firstLoadKb.toFixed(0)} kB exceeds mobile budget ${budget} kB`);
    }
  }
  if (typeof baseline.sharedKb === 'number') {
    const budget = baseline.sharedKb + baseline.allowanceKb;
    if (sharedKb === null) {
      failures.push('shared First Load JS: missing from the build table — the shared mobile budget cannot be checked');
    } else if (sharedKb > budget) {
      failures.push(`shared First Load JS ${sharedKb.toFixed(0)} kB exceeds mobile budget ${budget} kB`);
    }
  }
  return failures;
}

export function recordMobileBaseline(log, commit, measuredAt) {
  const routes = parseRoutes(log);
  const picked = {};
  for (const route of MOBILE_BASELINE_ROUTES) {
    const r = routes.find((x) => x.route === route);
    if (!r) throw new Error(`baseline log has no row for ${route}`);
    picked[route] = Math.round(r.firstLoadKb);
  }
  const shared = parseShared(log);
  return {
    commit,
    measuredAt,
    method: 'First Load JS from the `next build` route table of the last main commit before the mobile redesign (first parent of the commit that added apps/web-next/src/app/app/_kit/index.ts); CI Build-job log when available, else a local ./bin/vercel-build.sh in a git worktree of that commit.',
    unit: 'kB First Load JS (gzip) as printed by next build',
    allowanceKb: 40,
    routes: picked,
    ...(shared !== null ? { sharedKb: Math.round(shared) } : {}),
    inheritFrom: { '/app/docs/[id]': '/app/docs' },
  };
}

function main() {
  if (process.argv[2] === '--record-mobile-baseline') {
    const [, , , logFile, commit] = process.argv;
    if (!logFile || !commit) {
      console.error('usage: node bin/perf-budget.mjs --record-mobile-baseline <build-log> <commit-sha>');
      process.exit(2);
    }
    const b = recordMobileBaseline(fs.readFileSync(logFile, 'utf8'), commit, new Date().toISOString());
    process.stdout.write(JSON.stringify(b, null, 2) + '\n');
    return;
  }
  const logPath = process.argv[2];
  if (!logPath || !fs.existsSync(logPath)) {
    console.error('usage: node bin/perf-budget.mjs <next-build-log> ');
    console.error('  (produce it with: next build | tee build.log)');
    process.exit(2);
  }
  const log = fs.readFileSync(logPath, 'utf8');
  const routes = parseRoutes(log);
  const shared = parseShared(log);

  // A parse that finds nothing must fail. Next has changed this table's shape
  // before, and a guard that silently measures zero routes is worse than none.
  if (routes.length < 50) {
    console.error(
      `perf-budget: parsed only ${routes.length} routes from ${logPath} — ` +
        'the build table format has probably changed. Fix the parser rather ' +
        'than trusting this run.',
    );
    process.exit(2);
  }

  const failures = [];
  const worst = [...routes].sort((a, b) => b.firstLoadKb - a.firstLoadKb);

  console.log('=== First Load JS ===');
  console.log(`  routes measured:  ${routes.length}`);
  console.log(`  shared by all:    ${shared === null ? 'n/a' : shared.toFixed(0) + ' kB'} (budget ${SHARED_BUDGET_KB})`);
  console.log('  heaviest routes:');
  for (const r of worst.slice(0, 5)) {
    const budget = ROUTE_EXCEPTIONS[r.route] ?? ROUTE_BUDGET_KB;
    const flag = r.firstLoadKb > budget ? ' OVER' : '';
    console.log(`    ${r.route.padEnd(42)} ${r.firstLoadKb.toFixed(0).padStart(4)} kB  (budget ${budget})${flag}`);
  }

  if (shared !== null && shared > SHARED_BUDGET_KB) {
    failures.push(`shared First Load JS ${shared.toFixed(0)} kB exceeds ${SHARED_BUDGET_KB} kB`);
  }
  for (const r of routes) {
    const budget = ROUTE_EXCEPTIONS[r.route] ?? ROUTE_BUDGET_KB;
    if (r.firstLoadKb > budget) {
      failures.push(`${r.route}: First Load JS ${r.firstLoadKb.toFixed(0)} kB exceeds ${budget} kB`);
    }
  }

  const baselineFile = new URL('./perf-baseline-mobile.json', import.meta.url);
  if (fs.existsSync(baselineFile)) {
    const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
    const overridesFile = new URL('./perf-mobile-overrides.json', import.meta.url);
    if (fs.existsSync(overridesFile)) {
      const { _comment, ...overrides } = JSON.parse(fs.readFileSync(overridesFile, 'utf8'));
      baseline.overrides = overrides;
    }
    console.log('=== /app PWA routes (baseline + ' + baseline.allowanceKb + ' kB) ===');
    for (const [route, o] of Object.entries(baseline.overrides ?? {})) console.log(`    override ${route}: +${o.allowanceKb} kB — ${o.reason}`);
    for (const [route, budget] of Object.entries(mobileBudgets(baseline))) {
      const r = routes.find((x) => x.route === route);
      console.log(`    ${route.padEnd(24)} ${r ? r.firstLoadKb.toFixed(0).padStart(4) + ' kB' : '   n/a'}  (budget ${budget})`);
    }
    failures.push(...checkMobileRoutes(routes, baseline, shared));
  } else {
    failures.push(
      'bin/perf-baseline-mobile.json is missing — record the baseline first ' +
        '(node bin/perf-budget.mjs --record-mobile-baseline <baseline-build-log> <baseline-commit-sha> > bin/perf-baseline-mobile.json); ' +
        'the /app budget would otherwise be vacuous',
    );
  }

  const nextDir = path.join(process.cwd(), 'apps', 'web-next', '.next');
  const fonts = fontBytes(nextDir) ?? fontBytes(path.join(process.cwd(), '.next'));
  console.log('=== Fonts ===');
  if (fonts === null) {
    console.log('  .next/static/media not found — skipped (run after a build)');
  } else {
    console.log(`  total:            ${fonts.toFixed(0)} kB (budget ${FONT_BUDGET_KB})`);
    if (fonts > FONT_BUDGET_KB) {
      failures.push(`font payload ${fonts.toFixed(0)} kB exceeds ${FONT_BUDGET_KB} kB`);
    }
  }

  if (failures.length) {
    console.error('\nperf-budget FAILED:');
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error(
      '\nEither bring the number down, or raise the budget in bin/perf-budget.mjs\n' +
        'with a reason in the PR. Raising it silently is the failure mode this\n' +
        'guard exists to prevent.',
    );
    process.exit(1);
  }
  console.log('\nperf-budget OK');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
