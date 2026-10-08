'use client';
import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

const getSnapshot = (): boolean => navigator.onLine !== false;
// The server (and the hydration pass) always render "online", so a client that
// hydrates while offline re-renders instead of mismatching.
const getServerSnapshot = (): boolean => true;

export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
