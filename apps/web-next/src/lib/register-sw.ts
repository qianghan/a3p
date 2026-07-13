/**
 * Register the AgentBook Service Worker for offline support and push notifications.
 * Call this from the root layout or a client component.
 */
export function registerServiceWorker(): void {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;

  // When a new service worker activates (skipWaiting + clients.claim in
  // sw.js), an already-open tab is left running its OLD JS bundle against
  // the NEW worker's caching rules with no way to reconcile — the tab never
  // gets to fetch the fresh HTML/chunks it needs, which is what produced
  // the infinite loading loop reported after a deploy. Reloading once
  // (guarded so it can only ever fire a single time per page load) lets the
  // tab pick up the deploy that just landed instead of getting stuck.
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });

  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      console.log('[AgentBook] Service Worker registered:', registration.scope);

      // Check for updates periodically
      setInterval(() => registration.update(), 60 * 60 * 1000); // hourly
    } catch (err) {
      console.warn('[AgentBook] Service Worker registration failed:', err);
    }
  });
}

/**
 * Request push notification permission.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false;
  const permission = await Notification.requestPermission();
  return permission === 'granted';
}

/**
 * Check if the app is currently offline.
 */
export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && !navigator.onLine;
}

/**
 * Listen for online/offline events.
 */
export function onConnectivityChange(callback: (online: boolean) => void): () => void {
  const onOnline = () => callback(true);
  const onOffline = () => callback(false);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  };
}
