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
  // lucide icon library pulled in by a namespace import. Then 320 kB, and now
  // 286 kB after the i18n catalog split took 35 kB off every page route (the
  // server-only namespaces — Telegram and agent-skill copy — no longer ship to
  // the browser). Still over the default because the page itself is 68 kB of
  // tab content. Lowered from 340 to keep the ~10% margin over what it
  // actually measures rather than banking the saving as slack.
  '/settings': 315,
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
 * Nothing tree-shakes it: 97 kB gzipped, measured. Splitting the server-only
 * namespaces out took 35 kB off each of those 35 routes. The remaining lever
 * is the locale axis — a browser needs one locale and ships three, worth
 * another ~42 kB — which needs lazy loading and has not been done.
 * `bin/i18n-bundle-guard.sh --shell` is what keeps the first half from
 * regressing; this file would only show it as a diffuse rise.
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

function main() {
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
