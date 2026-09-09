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

## 280 -> 269 (guard wired into CI)

Lowered, not raised. The premise for this change was that main had drifted
6 errors ABOVE the 280 baseline. It has not: on a clean origin/main at
`5fd07b8c` with a lockfile-faithful install, the guard measures **269** — the
number is 11 BELOW the baseline, and 269 + 75 TS6307 = 344 raw, the same raw
total #515 recorded. So the drift was slack, not regression, and 11 errors of
unearned headroom is exactly the budget a later change could have spent in
silence.

Where a higher number comes from, since it cost time to chase: this repo has a
main checkout alongside its worktrees, and that checkout was 140 commits behind
with 981 dirty files. Running the guard there measures a tree that does not
exist anywhere — it gives 255. Neither tree reproduces 286. Run the guard in a
clean worktree at origin/main, or the number describes someone else's work in
progress.

Checked before re-baselining that the fall is real and not files going missing
from the program: TS6307 is still 75, unchanged, and the only tsconfig edit
since 280 was locked (#515) ADDED two files to `include`. A narrowed include
would have hidden errors rather than fixed them, and would have shown up as a
TS6307 change.

The 269 above is a macOS measurement. CI runs Linux, whose case-sensitive
filesystem can resolve imports differently, so the CI run on the PR that wires
this guard in is the real confirmation of the figure.
