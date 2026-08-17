/**
 * Is this page running as the installed app, rather than in a browser tab?
 *
 * `display-mode: standalone` is the standards answer and covers Android/Chrome.
 * `navigator.standalone` is the iOS-only legacy flag, still the only signal
 * Safari gives for a home-screen launch. Both are needed; iOS has reported one
 * without the other across versions.
 *
 * Extracted because auth-context.tsx had this inline for the OAuth flow and two
 * more callers now need the same answer. A device predicate that disagrees with
 * itself between call sites is how a PWA ends up half-treated as mobile.
 */
export function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/**
 * Desktop-shell paths that an installed app should never *land* on.
 *
 * Entry points only. A deep link — a push notification pointing at
 * /agentbook/invoices, say — must still open the page it names; bouncing that
 * to the mobile home would lose the destination the user asked for, which is a
 * worse bug than the one being fixed.
 */
const DESKTOP_ENTRY_PATHS = new Set(['/agentbook', '/agentbook/']);

/** Where an installed app should go instead, or null to stay put. */
export function mobileEntryFor(pathname: string): string | null {
  return DESKTOP_ENTRY_PATHS.has(pathname) ? '/app' : null;
}
