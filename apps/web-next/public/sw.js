/**
 * AgentBook Service Worker — Offline support.
 *
 * Strategies:
 * - Cache-first: static assets (CSS, JS, images)
 * - Network-first with cache fallback: API data (expenses, invoices, trial balance)
 * - Background sync: queued operations (receipt upload, expense recording)
 */

// Bump these on every change that affects caching behavior. Next.js's HTML
// shell references content-hashed JS chunk filenames that change on every
// deploy — a service worker that never busts its own cache names will
// eventually serve a shell whose chunk references no longer exist after a
// new deploy, which is what causes an infinite loading loop (the client
// keeps trying to fetch/hydrate against chunks that 404). Bumping the
// version here forces `activate` to purge every old cache below.
const CACHE_NAME = 'agentbook-v3';
const STATIC_CACHE = 'agentbook-static-v4';
const API_CACHE = 'agentbook-api-v4';

// Static assets to pre-cache. Deliberately does NOT include '/agentbook' —
// precaching a navigable HTML document is exactly the risky part, since its
// chunk references go stale on every deploy. '/manifest.json' is static
// metadata, safe to precache.
const PRECACHE_URLS = [
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

// Routes that must never be served from (or written into) API_CACHE,
// even though they match the /api/v1/agentbook prefix below:
//
//  - Compute-on-read GETs recompute live from the ledger on every call —
//    a cached/stale fallback could show numbers that no longer match
//    reality after new expenses/invoices land, which is actively
//    misleading, not harmlessly stale.
//  - Binary file downloads (PDF/CSV) don't belong in a cache meant for
//    small JSON offline-fallback bodies — caching them bloats API_CACHE
//    with large blobs, and the same URL can later be regenerated from
//    different underlying data (e.g. a corrected pay run), so a cached
//    copy risks serving stale bytes under a URL that looks unchanged.
//
// (The tax-package feature's PDF/CSV links point directly at Vercel Blob
// storage — a different origin — so they're never intercepted by the
// same-origin prefix match below and don't need listing here.)
const NEVER_CACHE_PATHS = [
  '/api/v1/agentbook-tax/tax/estimate', // live tax estimate, recomputed every call
];

const BINARY_DOWNLOAD_PATTERNS = [
  /^\/api\/v1\/agentbook-expense\/mileage\/export/, // mileage CSV export
  /^\/api\/v1\/agentbook-invoice\/invoices\/[^/]+\/pdf/, // invoice PDF
  /^\/api\/v1\/agentbook-payroll\/tax-deposits\/[^/]+\/pdf/, // payroll tax-deposit PDF
  /^\/api\/v1\/agentbook-payroll\/year-end\/pdf/, // W-2/T4/P60/Payment Summary PDF
  /^\/api\/v1\/agentbook-tax\/past-filings\/[^/]+\/download/, // uploaded prior-year filing PDF
  /^\/api\/v1\/agentbook-tax\/reports\/contractor-1099\/pdf/, // 1099-NEC PDF
];

function isExcludedFromApiCache(pathname) {
  if (NEVER_CACHE_PATHS.includes(pathname)) return true;
  return BINARY_DOWNLOAD_PATTERNS.some((re) => re.test(pathname));
}

// Fetch: strategy based on request type
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API requests: network-first with cache fallback — except the
  // excluded compute-on-read/binary-download routes above, which always
  // go straight to the network with no caching at all.
  if (url.pathname.startsWith('/api/v1/agentbook')) {
    if (isExcludedFromApiCache(url.pathname)) {
      event.respondWith(fetch(event.request));
      return;
    }
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

  // Navigation: network-only. Auth state (via the naap_auth_token cookie)
  // can flip between visits to the same URL — serving a stale cached
  // response here (e.g. an old pre-auth redirect to /login) is exactly the
  // failure mode that caused the PWA Google-sign-in loop. Navigations get
  // no offline fallback; everything else below still does.
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request));
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
    // Only GET responses are cacheable. Cache.put() THROWS on a POST/PUT/etc.
    // request ("Request method 'POST' is unsupported"); if that throw escapes
    // it lands in the catch below and we'd return the synthetic offline
    // response — telling the client a mutation failed when the server in fact
    // succeeded. That both hid the result (receipt scan never prefilled) and
    // caused duplicate writes (the "offline" expense got queued and later
    // replayed). So: never cache non-GET, and swallow any cache error so it
    // can never be mistaken for a network failure.
    if (response.ok && request.method === 'GET') {
      caches.open(API_CACHE).then((cache) => cache.put(request, response.clone())).catch(() => {});
    }
    return response;
  } catch {
    // Genuine network failure. Only GETs have a meaningful cached fallback.
    if (request.method === 'GET') {
      const cached = await caches.match(request);
      if (cached) return cached;
    }
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
