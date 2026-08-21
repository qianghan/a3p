# typecheck-guard baseline history

The number in `i18n-typecheck-guard.baseline` counts REAL type errors
(TS6307 excluded — see the script header for why).

| value | when | why it moved |
|-------|------|--------------|
| 347   | initial measurement | raw count including TS6307 |
| 269   | TS6307 excluded | 75 of 344 were an include-path artifact, not type errors |
| 278   | rebased onto #460 | `plugins/agentbook-tax/backend/src/tax-review-agent.ts` arrived on main with the tax-review-agent PR and carries 9 errors. Verified NOT from the i18n work: the file is absent from this branch's diff and already present on origin/main. |

If this number grows, find out whose change did it before re-baselining. The
guard flagged the +9 above and the investigation is what established it was
upstream — re-baselining without checking would have silently absorbed someone
else's regression into the i18n budget.

## 278 -> 280 (post-merge of #471)

Investigated before re-baselining, per the instruction above. NOT caused by this
work: reverting the only apps/web-next change in flight (exporting
ShellContextReact) gives **283**, and with it **280** — so the change reduces
the count by 3. The 278 figure was locked on a branch before #471 merged; main
moved underneath it.

Also recorded because it cost time: this guard runs `npx tsc --noEmit` from
`apps/web-next`, NOT the repo root. Running it from the root compiles nothing —
the root tsconfig is composite with an empty file list and exits 0 — so a
root-level reproduction of the number silently reports zero errors and looks
like the problem vanished.
