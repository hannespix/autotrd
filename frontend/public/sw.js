/**
 * autotrd Service Worker — bewusst minimal und Firestore-sicher:
 * NUR same-origin GET wird angefasst. Alles Richtung googleapis.com
 * (Firestore-Streams, Auth) läuft unberührt am SW vorbei.
 *
 *  - Navigationen:  network-first (frische Deploys gewinnen), offline
 *                   fällt auf die gecachte App-Shell zurück
 *  - /assets/*:     cache-first (Vite-Hashes sind unveränderlich)
 *  - Rest (Icons…): stale-while-revalidate
 *
 * VERSION bumpen ⇒ alte Caches werden beim Activate weggeräumt.
 */

// v3: NUR res.ok wird gecacht. Vorher wanderte ein Asset-404 (Race mit dem
// Deploy-Swap) in den Cache und wurde per cache-first FÜR IMMER serviert —
// „nur Hintergrund rendert", Reload und Browser-Cache-Leeren halfen nicht
// (CacheStorage bleibt), erst der nächste Deploy mit neuem Hash „heilte"
// (Live-Vorfall 20.08.). Der Bump räumt vergiftete Caches beim Activate weg.
const VERSION = 'v3';
const CACHE = `autotrd-${VERSION}`;
const SHELL = ['/', '/manifest.json', '/favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith('autotrd-') && k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // no-cache: der Browser-HTTP-Cache darf hier NIE ein altes index.html
    // liefern — sonst zeigen die Asset-Hashes auf ein veraltetes Bundle
    // (Live-Bug 25.07.: frischer Deploy kam beim User nicht an).
    event.respondWith(
      fetch(req, { cache: 'no-cache' })
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((cache) => cache.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      const refresh = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit ?? refresh;
    }),
  );
});
