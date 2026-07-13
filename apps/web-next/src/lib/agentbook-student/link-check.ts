/**
 * Real HTTP liveness check for a candidate's sourceUrl — the missing piece
 * that let hallucinated/dead grounded-search results (404s) reach students.
 * `extractGroundedCandidates` only validates URL syntax + a host-string
 * heuristic against grounding metadata; neither ever confirms the exact page
 * the model cited actually loads. This module does that confirmation.
 */

/** Timeout for a single link check — generous enough for slow sites, short enough to keep a batch of ~12 checks well under a route's time budget. */
const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Is this URL a real, currently-loadable page? Tries HEAD first (cheapest);
 * falls back to GET since some servers reject/misreport HEAD (405, or a 200
 * that doesn't reflect the real resource). Any 2xx/3xx counts as live —
 * redirects (e.g. to a login wall) are still a real, non-404 destination.
 */
export async function isUrlLive(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<boolean> {
  const tryMethod = async (method: 'HEAD' | 'GET'): Promise<number | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, redirect: 'follow', signal: controller.signal });
      return res.status;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const headStatus = await tryMethod('HEAD');
  if (headStatus !== null && headStatus < 400) return true;
  // HEAD failing outright (network error/timeout) or coming back 4xx/5xx isn't
  // conclusive — some servers don't implement HEAD correctly — so confirm
  // with GET before declaring the link dead.
  const getStatus = await tryMethod('GET');
  return getStatus !== null && getStatus < 400;
}

/**
 * Filter a candidate list down to those whose sourceUrl actually resolves,
 * checked concurrently (bounded) so a batch of ~12 candidates stays well
 * within a route's time budget. Preserves input order.
 */
export async function filterLiveCandidates<T>(
  candidates: T[],
  getUrl: (c: T) => string,
  opts: { concurrency?: number; timeoutMs?: number } = {},
): Promise<T[]> {
  const concurrency = opts.concurrency ?? 6;
  const live: (T | null)[] = new Array(candidates.length).fill(null);

  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= candidates.length) return;
      const ok = await isUrlLive(getUrl(candidates[i]), opts.timeoutMs);
      if (ok) live[i] = candidates[i];
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()));
  return live.filter((c): c is T => c !== null);
}
