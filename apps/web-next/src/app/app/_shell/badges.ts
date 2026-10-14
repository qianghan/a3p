/**
 * Which tab badges are live. Dependency-free on purpose: the e2e suite imports
 * it to know which badge behaviour to expect.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ FLIP POINTS (both flipped; kept so a future gate is made the same way)   │
 * │   home → true since PR 3, with the Home screen rewrite (shows the alerts │
 * │          behind the critical dot and lets the user act on them).         │
 * │   docs → true since PR 4, with the Docs screen rewrite: the Needs review │
 * │          chip lists exactly the pending_review rows the count points at  │
 * │          (same DOC_FILTER_PARAMS table, server-side).                     │
 * │ Flip a flag in the same PR as the screen; also update the gate test that │
 * │ pins these values (shell.test.tsx) and the e2e badge journeys.           │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * A badge may only be on when its screen can show and clear what it points
 * at. With home on, the shell's /mobile/home request on the Home tab IS the
 * screen's own (getHome() shares it). A disabled badge renders nothing and
 * leaves the tab's plain label as its accessible name; with BOTH disabled the
 * shell makes no /mobile/home request and registers no revalidation listeners
 * at all.
 *
 * What the Docs count is: the `review_needed` alert's `params.count` — the size
 * of the pending_review list. Known limits (not hidden by this flag): the alert
 * is one of at most 5 the server ranks, so a tenant with five higher-ranked
 * alerts shows no count while the chip is > 0; and `review_needed` also fires
 * for AI picks alone (count 0), which shows no badge but links to an empty
 * Needs review list (Task 4.7b alignment).
 */
export interface BadgeGate {
  home: boolean;
  docs: boolean;
}

export const BADGES_ENABLED: Readonly<BadgeGate> = Object.freeze({ home: true, docs: true });

/**
 * How old the Home data may get before a resume (visibilitychange → visible)
 * refetches it. Shared by the shell's badge revalidation (useShellBadges) and
 * the Home screen itself, so the dot and the screen go stale — and refresh —
 * together; getHome() shares the in-flight request, so that costs one fetch.
 */
export const BADGE_MAX_AGE_MS = 2 * 60 * 1000;
