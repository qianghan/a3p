/**
 * Pure aggregation of per-account Plaid sync results.
 *
 * `/transactions/sync` is cursor-based: a first-time connection pulls all
 * available history, paginated. syncTransactionsForAccount() drains up to a
 * safety cap per call and reports `hasMore: true` when the cap truncated the
 * pull (more history remains and will come on the next sync). This helper rolls
 * the per-account results into a single summary with a `complete` flag so an
 * onboarding "import my history" flow can loop sync until the backfill is done.
 */

export interface SyncRun {
  added: number;
  modified: number;
  removed: number;
  hasMore: boolean;
}

export interface SyncSummary {
  transactionsImported: number;
  modified: number;
  removed: number;
  /** True when no account still has un-pulled history (safe to stop syncing). */
  complete: boolean;
}

export function summarizeSyncRuns(runs: SyncRun[]): SyncSummary {
  return {
    transactionsImported: runs.reduce((sum, r) => sum + r.added, 0),
    modified: runs.reduce((sum, r) => sum + r.modified, 0),
    removed: runs.reduce((sum, r) => sum + r.removed, 0),
    complete: runs.every((r) => !r.hasMore),
  };
}
