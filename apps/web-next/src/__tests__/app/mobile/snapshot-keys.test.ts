import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SNAPSHOT_PREFIX,
  SNAPSHOT_OWNER_KEY,
  API_CACHE_PREFIX,
  claimMobileSnapshots,
  clearMobileSnapshots,
} from '@/lib/mobile/snapshot-keys';

beforeEach(() => {
  window.localStorage.clear();
});

describe('claimMobileSnapshots', () => {
  it('first claim with nothing stored just records the owner', () => {
    claimMobileSnapshots('u1');
    expect(window.localStorage.getItem(SNAPSHOT_OWNER_KEY)).toBe('u1');
  });

  it('keeps the owner\'s snapshots on a repeat claim', () => {
    claimMobileSnapshots('u1');
    window.localStorage.setItem(`${SNAPSHOT_PREFIX}home`, '{"x":1}');
    claimMobileSnapshots('u1');
    expect(window.localStorage.getItem(`${SNAPSHOT_PREFIX}home`)).toBe('{"x":1}');
  });

  it('drops snapshots saved for a different user and re-binds to the new one', () => {
    claimMobileSnapshots('u1');
    window.localStorage.setItem(`${SNAPSHOT_PREFIX}home`, '{"balance":1000}');
    claimMobileSnapshots('u2');
    expect(window.localStorage.getItem(`${SNAPSHOT_PREFIX}home`)).toBeNull();
    expect(window.localStorage.getItem(SNAPSHOT_OWNER_KEY)).toBe('u2');
  });

  it('drops snapshots whose owner is unknown', () => {
    window.localStorage.setItem(`${SNAPSHOT_PREFIX}home`, '{"balance":1000}');
    claimMobileSnapshots('u2');
    expect(window.localStorage.getItem(`${SNAPSHOT_PREFIX}home`)).toBeNull();
  });

  it('clearMobileSnapshots also forgets the owner, leaving unrelated keys alone', () => {
    claimMobileSnapshots('u1');
    window.localStorage.setItem('theme', 'dark');
    clearMobileSnapshots();
    expect(window.localStorage.getItem(SNAPSHOT_OWNER_KEY)).toBeNull();
    expect(window.localStorage.getItem('theme')).toBe('dark');
  });

  it('never throws when storage throws', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new Error('denied'); },
    });
    try {
      expect(() => claimMobileSnapshots('u1')).not.toThrow();
      expect(() => clearMobileSnapshots()).not.toThrow();
    } finally {
      Object.defineProperty(window, 'localStorage', original);
    }
  });
});

// sw.js keeps every successful /api/v1/agentbook* GET in `agentbook-api-vN` and
// serves it offline by URL alone. Clearing the snapshots without it would leave
// user A's expenses, accounts and chat turns for user B to read offline.
describe('clearMobileSnapshots also drops the service worker API cache', () => {
  const hadCaches = 'caches' in globalThis;
  const original = (globalThis as { caches?: unknown }).caches;

  function fakeCaches(names: string[], opts: { keysRejects?: boolean; deleteRejects?: boolean } = {}) {
    const store = new Set(names);
    const fake = {
      keys: vi.fn(() => (opts.keysRejects ? Promise.reject(new Error('denied')) : Promise.resolve([...store]))),
      delete: vi.fn((name: string) => {
        if (opts.deleteRejects) return Promise.reject(new Error('denied'));
        return Promise.resolve(store.delete(name));
      }),
    };
    (globalThis as { caches?: unknown }).caches = fake;
    return { fake, store };
  }

  const flush = () => new Promise((r) => setTimeout(r, 0));

  afterEach(() => {
    if (hadCaches) (globalThis as { caches?: unknown }).caches = original;
    else delete (globalThis as { caches?: unknown }).caches;
  });

  it('the prefix matches the cache name sw.js writes', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const sw = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf8');
    const apiCache = /const API_CACHE = '([^']+)'/.exec(sw)?.[1];
    expect(apiCache, 'sw.js declares API_CACHE').toBeTruthy();
    expect(apiCache!.startsWith(API_CACHE_PREFIX)).toBe(true);
  });

  it('deletes every agentbook-api-* cache and nothing else', async () => {
    const { fake, store } = fakeCaches(['agentbook-api-v6', 'agentbook-api-v5', 'agentbook-static-v6', 'other']);
    clearMobileSnapshots();
    await flush();
    expect(fake.delete.mock.calls.map((c) => c[0]).sort()).toEqual(['agentbook-api-v5', 'agentbook-api-v6']);
    expect([...store].sort()).toEqual(['agentbook-static-v6', 'other']);
  });

  it('runs for every reason, including a 401', async () => {
    const { store } = fakeCaches(['agentbook-api-v6']);
    clearMobileSnapshots('unauthorized');
    await flush();
    expect([...store]).toEqual([]);
  });

  it('no caches global (old browser, SSR, insecure origin): no throw', () => {
    delete (globalThis as { caches?: unknown }).caches;
    expect(() => clearMobileSnapshots()).not.toThrow();
  });

  it('keys() or delete() rejecting: no throw, no unhandled rejection, snapshots still cleared', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      window.localStorage.setItem(`${SNAPSHOT_PREFIX}home`, '{}');
      fakeCaches(['agentbook-api-v6'], { keysRejects: true });
      expect(() => clearMobileSnapshots()).not.toThrow();
      fakeCaches(['agentbook-api-v6'], { deleteRejects: true });
      expect(() => clearMobileSnapshots()).not.toThrow();
      await flush();
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
      expect(window.localStorage.getItem(`${SNAPSHOT_PREFIX}home`)).toBeNull();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('a caches accessor that throws synchronously: no throw', () => {
    Object.defineProperty(globalThis, 'caches', { configurable: true, get() { throw new Error('SecurityError'); } });
    try {
      expect(() => clearMobileSnapshots()).not.toThrow();
    } finally {
      delete (globalThis as { caches?: unknown }).caches;
    }
  });
});
