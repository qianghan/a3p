# Performance baseline

First measurement of anything performance-related in this repo. Taken
2026-09-07 against `main` at `47584e90`, production (`agentbook.brainliber.com`)
for field numbers and a local production build for bundle numbers.

Before this there was no load test, no Lighthouse budget and no bundle budget
anywhere. That is why the launch scorecard scored Performance 2/5 in all three
regions: not because the product is slow, but because nothing was known.

## Bundle — `next build`, 598 routes

| | measured | budget | guard |
|---|---:|---:|---|
| First Load JS shared by all | 103 kB | 115 kB | `bin/perf-budget.mjs` |
| `/settings` | **494 kB** | 540 kB | exception, see below |
| `/admin/plugins` | **405 kB** | 445 kB | exception, see below |
| `/marketplace` | 238 kB | 250 kB | default |
| `/plugins/[pluginName]` | 231 kB | 250 kB | default |
| `/[...slug]` | 226 kB | 250 kB | default |
| Fonts in `.next/static/media` | 1146 kB | 1250 kB | total payload |

`/settings` is the outlier: nearly **5× the shared baseline**, and 2× the next
worst route. It is listed as an exception rather than quietly excluded — the
budget passes on the world as it is, refuses to let it grow, and the debt is
written where a regression fails rather than in someone's memory.

## Field — real browser, production

Landing page (`/`), cold:

| | |
|---|---:|
| TTFB | 539 ms |
| DOMContentLoaded | 1018 ms |
| Load | 2559 ms |
| Requests | 23 |
| **Fonts** | **~471 kB across 7 woff2 files** |
| JS | ~255 kB |

`/guides`, warm: TTFB 54 ms, load 454 ms, 19 kB CSS, 87 kB fonts.

Server response, 5 samples each, median: `/` 245 ms · `/guides` 144 ms ·
`/login` 258 ms · `/api/health` 267 ms. One `/login` sample hit 1.29 s, which
is a cold serverless start rather than a page problem.

## What the numbers say

**Fonts are the largest single cost on the landing page** — seven woff2 files,
~471 kB, more than the JS. Two of them are 146 kB and 118 kB. That is a
subsetting and weight-count problem, and it is the cheapest large win
available: no architectural change, no risk to behaviour.

**`/settings` at 494 kB** is the worst route. Worth a look at what it imports
before launch; the settings page is not a place users expect to wait.

**Server latency is fine.** 144–270 ms medians on a serverless deployment are
unremarkable and not the bottleneck. Cold starts are visible in the tail.

## What is NOT measured, deliberately

**LCP, CLS, INP.** These need a real browser against a real deployment. Taken
from CI against a cold serverless function they would measure the cold start,
not the page, and would flake constantly. The field numbers above were taken
from a real browser session and are recorded here rather than asserted in CI.

**Throughput under load.** No load test exists. Adding one that hammers
production is not something to do casually on a product holding customer bank
connections; it belongs against a preview deployment with its own database,
which is a larger piece of work than this baseline.

## Raising a budget

Budgets live in `bin/perf-budget.mjs`. Raising one is allowed and sometimes
right — but it should carry a reason in the PR. The guard exists because an
unmeasured dimension cannot regress loudly; a budget raised silently
reintroduces exactly that.
