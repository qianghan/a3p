import { describe, it, expect } from 'vitest';
import { summarizeSyncRuns } from '../plaid-sync-summary';

describe('plaid-sync-summary · summarizeSyncRuns', () => {
  it('no accounts → zeros and complete (nothing left to drain)', () => {
    expect(summarizeSyncRuns([])).toEqual({
      transactionsImported: 0,
      modified: 0,
      removed: 0,
      complete: true,
    });
  });

  it('a single fully-drained run is complete', () => {
    expect(summarizeSyncRuns([{ added: 12, modified: 2, removed: 1, hasMore: false }])).toEqual({
      transactionsImported: 12,
      modified: 2,
      removed: 1,
      complete: true,
    });
  });

  it('a run that hit the page cap is incomplete (more history remains)', () => {
    const s = summarizeSyncRuns([{ added: 2000, modified: 0, removed: 0, hasMore: true }]);
    expect(s.transactionsImported).toBe(2000);
    expect(s.complete).toBe(false);
  });

  it('sums across accounts and is incomplete if ANY account has more', () => {
    const s = summarizeSyncRuns([
      { added: 50, modified: 1, removed: 0, hasMore: false },
      { added: 2000, modified: 0, removed: 3, hasMore: true },
    ]);
    expect(s.transactionsImported).toBe(2050);
    expect(s.modified).toBe(1);
    expect(s.removed).toBe(3);
    expect(s.complete).toBe(false);
  });
});
