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
| | baseline | now | budget | guard |
|---|---:|---:|---:|---|
| First Load JS shared by all | 103 kB | 103 kB | 115 kB | `bin/perf-budget.mjs` |
| `/settings` | **494 kB** | **308 kB** | 340 kB | exception, see below |
| `/admin/plugins` | **405 kB** | **217 kB** | 250 kB | default — exception removed |
| `/marketplace` | 238 kB | 238 kB | 250 kB | default |
| `/plugins/[pluginName]` | 231 kB | 231 kB | 250 kB | default |
| `/[...slug]` | 226 kB | 226 kB | 250 kB | default |
| Fonts in `.next/static/media` | 1146 kB | 1121 kB | 1250 kB | total payload |

The two outliers turned out to be one bug in two places. Both pages resolved a
plugin's icon from a runtime string by indexing a namespace import of
lucide-react, which cannot be tree-shaken — so both shipped all ~1,500 icons to
draw one. Replacing it with a static map of the 26 icons the registry actually
names took `/settings` to 308 kB and `/admin/plugins` to 217 kB, under the
default, and its exception was deleted rather than left at a slack value.

`/settings` keeps an exception at 340 kB. What remains is genuinely the page:
68 kB of tab content, not a bundling mistake.

### The fix that looked right and wasn't

lucide ships `DynamicIcon` for exactly this case, and it made both pages much
cheaper — `/settings` 330 kB, `/admin/plugins` 260 kB — while making the app
as a whole worse. Its name map is ~1,500 separate dynamic imports, and webpack
records every one in the **global runtime manifest that ships on every page**:
the runtime chunk went from 3 kB with 0 chunk-id entries to 44 kB with 1,659,
and the shared baseline rose 103 kB → 126 kB. Every one of 598 routes paid
23 kB to fix two of them. Wrapping it in `next/dynamic` changes nothing — the
manifest is emitted because the imports exist, not because they are reached.

Worth recording because the intermediate state passes a per-route budget while
regressing the number that matters most.

## Field — real browser, production

Landing page (`/`), cold:

| | |
|---|---:|
| TTFB | 539 ms |
| DOMContentLoaded | 1018 ms |
| Load | 2559 ms |
| Requests | 23 |
| **Fonts** | **501 kB across 7 woff2 files** → **419 kB across 5** |
| JS | ~255 kB |

`/guides`, warm: TTFB 54 ms, load 454 ms, 19 kB CSS, 87 kB fonts.

Server response, 5 samples each, median: `/` 245 ms · `/guides` 144 ms ·
`/login` 258 ms · `/api/health` 267 ms. One `/login` sample hit 1.29 s, which
is a cold serverless start rather than a page problem.

## What the numbers say

**Fonts were the largest single cost on the landing page** — seven woff2
files, 501 kB, more than the JS, and every one with `initiatorType: "link"`,
meaning the browser was told to fetch all seven before it knew whether a glyph
needed them. Mapping each file to its family showed 87 kB was dead weight:

| kB | family | verdict |
|---:|---|---|
| 146 + 118 | Fraunces italic + normal | used — both `SOFT` and `opsz` axes are set by `.ab-landing .ital` |
| 63 + 57 | Newsreader italic + normal | used |
| 31 | JetBrains Mono | used |
| 47 | **Inter** | **root layout — no element on `/` renders it** |
| 40 | **JetBrains Mono, second copy** | **root layout — same family, declared twice** |

Both wasted files came from the root layout, which puts its fonts in the
preload manifest for *every* route including the one marketing page that uses
neither. `preload: false` on both removes them from `/` without stopping the
app routes that do use them — the `@font-face` rules still ship in
render-blocking CSS, so the fetch starts about one parse later, and next/font's
metrics-matched fallback means no layout shift. The cost is a slightly later
swap behind the login wall; the gain is 87 kB off the first page every visitor
loads.

The duplicate was subtler. Newsreader and JetBrains Mono are *variable* fonts:
one file spans the whole weight axis, so the `weight: ['400','500']` list saved
no bytes at all — 400 and 500 resolved to identical files. What it did do was
make the landing page's JetBrains declaration differ from the root layout's, so
next/font emitted two files for one family. Setting both to `weight: 'variable'`
collapsed them, and incidentally restored the full weight range: discrete
descriptors clamp the font to the values named, so a later `font-semibold` on
body copy would have snapped back to 500 instead of rendering at 600.

Landing page fonts: **501 kB → 419 kB, 7 files → 5**. Guarded by
`apps/web-next/src/__tests__/font-payload.test.ts`, because both facts are a
one-line edit away from being undone by someone with no reason to know the
cost.

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
