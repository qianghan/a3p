# How the i18n work is verified

Three layers. Each exists because the layer below it is *structurally* incapable
of catching a particular class of failure — not because more tests are better.

## The failure this is all designed around

The reported bug was: "when select lang switcher to chinese, or french, the UI
does not change the language." At that moment the repo had a passing i18n test
suite. The suite was not wrong; it was answering a different question.

The chain from a stored locale to a translated word on screen is:

```
tenant config (DB)
  → useShellI18n()            resolves locale, reads the feature flag
  → ShellContext.i18n         OPTIONAL field on the context
  → plugin useI18n()          reads shell?.i18n, FALLS BACK SILENTLY
  → t('invoice_ui.invoices')  renders
```

Two properties of that chain make silent failure the default:

1. `ShellContext.i18n` is declared `i18n?: ShellI18n` — optional. A context
   built without it compiles.
2. `useI18n()` never throws. If `shell?.i18n` is undefined it returns a
   fallback that *humanises the key* — `invoice_ui.total_outstanding` becomes
   "Total outstanding". Plausible English. No error, no warning.

And the wiring WAS broken. Two places build the plugin context by enumerating
services by hand — `PluginLoader.tsx`'s `baseContext` and `sandbox.ts`'s
`sandboxedContext`, the latter rebuilt from scratch rather than merged — and
neither included `i18n`. Every plugin page called `useI18n()`, got nothing, and
rendered humanised keys. That is the actual mechanism behind the report; the
feature flag and incomplete extraction were real but secondary. Fixed in both
places and guarded by
`apps/web-next/src/__tests__/architecture/i18n-plugin-context.test.ts`.

So when the wiring breaks, every plugin renders plausible English and
nothing fails. Worse: every component test still passes, because each one
constructs a `ShellProvider` **by hand** with a known-good i18n service. They
test the components against a shell that is correct by construction, and are
therefore blind to the shell being wrong in production.

That is the gap the layers below are organised around.

## Layer 1 — Component tests (vitest + jsdom)

`plugins/*/frontend/src/__tests__/i18n-*.test.tsx`

**Proves:** given a correct i18n service, each page renders translated strings,
leaks no raw key, and formats money/dates in the reader's locale.

**Cannot prove:** that the real shell supplies a correct i18n service. Every one
of these builds the shell itself.

Non-vacuity rules learned the hard way here, each from an assertion that passed
against broken code:

- Assert a **specific translated word**, never "the text differs". A whole-page
  inequality passed while money was still English, because the date already
  differed on its own.
- Assert the English word is **absent** too. Presence alone misses partial
  fallback.
- Require the page to have **rendered something**. A `waitFor` that only checks
  for the absence of "Loading" is satisfied instantly by an empty container, so
  two blank pages scored green on "no raw key leaked".
- For money, pick a currency where the locales actually **differ**. `en-US` and
  `zh-CN` render CAD byte-identically (`CA$1,234.56`), so a zh-CN assertion on
  CAD cannot detect a hardcoded `en-US`. CNY discriminates (`¥` vs `CN¥`).
- Verify each new assertion by **reverting the fix** and watching it fail. Three
  weak assertions were found this way, and only this way.

## Layer 2 — Wiring tests (vitest + jsdom)

`apps/web-next/src/__tests__/architecture/i18n-plugin-context.test.ts`
`apps/web-next/src/hooks/__tests__/use-shell-i18n.test.tsx`

**Proves:** the shell actually hands a working i18n service down the chain —
`ShellProvider` resolves it, `useShellServices` forwards it, `PluginLoader`
includes it in the plugin context, and the sandbox does not strip it.

The sandbox half is behavioural: `createSandboxedContext` is called with a real
service and the output's `t()` must return French. Presence alone would pass on
a stripped stub, so the assertion is on output. It also pins the skew case — an
absent `i18n` must stay `undefined` rather than becoming an empty object, or the
SDK's degrade path breaks.

The `PluginLoader` half is a source assertion, and deliberately so: the context
is a local inside a `useEffect` in a component with heavy runtime dependencies,
and there is no seam to observe it through without restructuring the component
purely for testability. A source check is the honest tool for "this hand-written
list of services is missing an entry".

An earlier attempt mounted the real `ShellProvider` around a probe component
calling `useI18n()`. It was abandoned: web-next's provider and the plugin SDK's
provider are *different React contexts*, bridged at runtime by
`mountUMDPlugin`, so the probe read the SDK context and always saw the fallback.
The test was measuring its own harness. The two files above cover the same chain
without pretending to span that bridge — and Layer 3 covers the bridge itself.

Both halves verified by deleting `i18n` from each constructor and confirming
four assertions fail.

**Cannot prove:** anything that only exists in a browser — that clicking the
switcher changes the page, that the choice survives a reload, that CJK
codepoints have glyphs rather than tofu boxes.

## Layer 3 — Browser test (Playwright, deployed app)

`tests/e2e/i18n-language-switcher.spec.ts`

**Proves** the things that are only true at runtime:

| Assertion | Why a browser is required |
|---|---|
| Clicking the switcher changes rendered copy | This was the literal bug report |
| The choice persists across a reload | Needs real persistence + real cookies |
| Flag OFF ⇒ English despite a fr-CA tenant | Needs the real flag reader, fail-closed |
| Flag ON ⇒ French/Chinese | Needs the real flag reader |
| `<html lang>` follows the locale | Drives screen readers and CJK font choice |
| CJK renders as glyphs, not `.notdef` boxes | Font availability is a browser property |
| The CDN plugin bundle receives the i18n service | Plugins load as UMD at runtime, not via import; this is the bridge Layer 2 cannot span |

The last row is the important one: Layer 2 imports plugin pages as modules,
whereas production loads them as UMD bundles from `/cdn`. Only a browser
exercises that path.

**Design decisions, and why:**

- **The test drives the flag itself** via `/api/v1/admin/feature-flags`, asserts
  both states, and restores the original value. Asserting against whatever the
  flag happens to be would make the result depend on unrelated environment
  state, and "translations did not appear" would be indistinguishable from
  "the flag was off".
- **It skips loudly without credentials** rather than passing. A spec that
  silently passes when it could not run is worse than no spec.
- **It never writes a password to disk.** The admin password comes from
  `E2E_ADMIN_PW` in the environment; CI holds the secret.
- **Net-clean.** The flag is restored even on failure, following the existing
  `admin-feature-flags.spec.ts` convention.

### The CJK check needed its own self-check

`tests/e2e/tofu-selfcheck.spec.ts` — runs with no credentials and no server.

A missing CJK font renders every codepoint as the same `.notdef` box, so the
text is present in the DOM and unreadable on screen; no `textContent` assertion
can see it. The first detector written here compared glyph WIDTHS — and that
does not work, because CJK is full-width: 发 and 一 both measure exactly 1em
whether the font covers them or not. Measured in headless Chromium: 16px and
16px. The assertion demanded they differ, so it would have **failed on a
perfectly healthy page** while claiming to detect missing fonts.

`document.fonts.check()` does not work either: it reports whether the font
FAMILY is available, not whether a codepoint is covered, and returns `true` even
for private-use codepoints no font has.

What works is counting ink — rasterise and count non-blank pixels:

```
real glyphs      发=249   一=44   票=326    (all distinct)
.notdef boxes       162      162            (identical)
```

Both cases are pinned in the self-check, so the heuristic has a test rather than
being an assertion nobody has watched fail. This matters more than it looks:
the credentialed spec above cannot run without secrets, so its assertions are
unexercised until CI runs them — the self-check is the part that runs today.

## What none of the three layers covers

Stated so it is not mistaken for covered:

- **Translation quality.** The invariants check that fr-CA differs from English,
  carries accents, and does not confuse *télécharger* (download) with
  *téléverser* (upload). They cannot tell good French from stilted French. The
  LLM-authored fr-CA and zh-CN packs still need a native-speaker review — the
  agreed D3 gate.
- **Server-rendered output.** Emails, PDFs and Telegram messages are not
  covered by any layer here; PDF rendering additionally needs a CJK font
  embedded, which is a separate piece of work.
- **The ratchets are not censuses.** Four separate measures exist, and three
  blind spots have been found in them so far (JSX-expression strings, comment
  lines being counted as hits, and `formatMoney` hiding locale-inference behind
  a helper). Each was found by trying to break the measure, never by reading it.
  Treat the counts as direction-of-travel only.
