/**
 * Which tab badges are live. Dependency-free on purpose: the e2e suite imports
 * it to know which badge behaviour to expect.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ FLIP POINTS                                                              │
 * │   home → true since PR 3, with the Home screen rewrite (shows the alerts │
 * │          behind the critical dot and lets the user act on them).         │
 * │   docs → true in PR 4, with the Docs screen rewrite (has the             │
 * │          needs-review filter the count points at).                       │
 * │ Flip the flag in the same PR as the screen; also update the gate test    │
 * │ that pins these values (shell.test.tsx) and the e2e badge journey.       │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Until its flip a legacy screen can neither show nor clear what its badge
 * would point at (Docs, until PR 4). With home on, the shell's /mobile/home
 * request on the Home tab IS the screen's own (getHome() shares it). A
 * disabled badge renders nothing and leaves the tab's plain label as its
 * accessible name; with BOTH disabled the shell makes no /mobile/home request
 * and registers no revalidation listeners at all.
 */
export interface BadgeGate {
  home: boolean;
  docs: boolean;
}

export const BADGES_ENABLED: Readonly<BadgeGate> = Object.freeze({ home: true, docs: false });
