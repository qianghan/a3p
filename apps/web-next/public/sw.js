/**
 * AgentBook Service Worker — Offline support.
 *
 * Strategies:
 * - Cache-first: static assets (CSS, JS, images)
 * - Network-first with cache fallback: API data (expenses, invoices, trial balance)
 * - Background sync: queued operations (receipt upload, expense recording)
 */

const CACHE_NAME = 'agentbook-v1';
const STATIC_CACHE = 'agentbook-static-v1';
const API_CACHE = 'agentbook-api-v1';

// Static assets to pre-cache
const PRECACHE_URLS = [
  '/agentbook',
  '/manifest.json',
];

// Install: pre-cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== STATIC_CACHE && k !== API_CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: strategy based on request type
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API requests: network-first with cache fallback
  if (url.pathname.startsWith('/api/v1/agentbook')) {
    event.respondWith(networkFirstWithCache(event.request));
    return;
  }

  // CDN plugin bundles: cache-first (immutable)
  if (url.pathname.startsWith('/cdn/plugins/')) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // Static assets: cache-first
  if (url.pathname.match(/\.(js|css|png|jpg|svg|woff2?)$/)) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // Navigation: network-first
  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirstWithCache(event.request));
    return;
  }

  // Default: network
  event.respondWith(fetch(event.request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function networkFirstWithCache(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(API_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    // X-Agentbook-Offline lets callers (e.g. the capture page) tell "the
    // device has no connection" apart from a real 503 the server sent on
    // purpose — `fetch()` never throws for this response since the SW
    // itself is what's answering, so a plain instanceof-TypeError check on
    // the client can't tell the difference without this marker.
    return new Response(JSON.stringify({ success: false, error: 'Offline', cached: false }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'X-Agentbook-Offline': '1' },
    });
  }
}

// Background sync: replay queued operations when back online
self.addEventListener('sync', (event) => {
  if (event.tag === 'agentbook-expense-sync') {
    event.waitUntil(replayExpenseQueue());
  }
  if (event.tag === 'agentbook-receipt-sync') {
    event.waitUntil(replayReceiptQueue());
  }
});

// Offline-queue schema shared with src/lib/offline-queue.ts. This file is a
// plain static asset (not bundled through webpack), so the IndexedDB access
// is duplicated here rather than imported — same DB name/version/stores.
const OFFLINE_DB_NAME = 'agentbook-offline';
const OFFLINE_DB_VERSION = 1;
const EXPENSE_STORE = 'expense-queue';
const RECEIPT_STORE = 'receipt-queue';

function openOfflineDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(EXPENSE_STORE)) db.createObjectStore(EXPENSE_STORE, { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains(RECEIPT_STORE)) db.createObjectStore(RECEIPT_STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getAll(db, store) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function deleteItem(db, store, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function replayExpenseQueue() {
  const db = await openOfflineDb();
  const items = await getAll(db, EXPENSE_STORE);
  for (const item of items) {
    try {
      const res = await fetch('/api/v1/agentbook-expense/expenses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(item.payload),
      });
      // A real rejection (validation error, auth expired) needs the user's
      // attention, not a silent drop — leave it queued either way and let
      // the next sync (or the in-app fallback) try again.
      if (res.ok) await deleteItem(db, EXPENSE_STORE, item.id);
    } catch {
      break; // still offline — the next sync event will retry from here
    }
  }
}

async function replayReceiptQueue() {
  const db = await openOfflineDb();
  const items = await getAll(db, RECEIPT_STORE);
  for (const item of items) {
    try {
      const form = new FormData();
      form.append('file', item.file, item.fileName);
      const res = await fetch('/api/v1/agentbook-expense/receipts/scan', { method: 'POST', body: form });
      if (res.ok) await deleteItem(db, RECEIPT_STORE, item.id);
    } catch {
      break;
    }
  }
}

// Push notifications
self.addEventListener('push', (event) => {
  const data = event.data?.json() || {};
  const title = data.title || 'AgentBook';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: data.url ? { url: data.url } : {},
    actions: data.actions || [],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/agentbook';
  event.waitUntil(self.clients.openWindow(url));
});
