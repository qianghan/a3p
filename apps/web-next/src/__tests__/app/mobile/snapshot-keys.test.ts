import { describe, it, expect, beforeEach } from 'vitest';
import {
  SNAPSHOT_PREFIX,
  SNAPSHOT_OWNER_KEY,
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
