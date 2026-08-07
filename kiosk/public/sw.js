/*
 * App-shell service worker.
 *
 * In the Android APK the shell is loaded from the package itself, so it is offline by
 * construction. When the same build is served over HTTP (browser or PWA install on a
 * different panel) a reload with no network would otherwise show a browser error page,
 * which on an unattended kiosk means a dead display until someone notices. This worker
 * precaches the shell and serves it cache-first so a power-cycle or reload always works.
 *
 * Document PDFs are NOT handled here — they live in IndexedDB, keyed by immutable
 * version id, and are managed by lib/sync.ts.
 */
const CACHE = 'septona-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Assets are content-hashed, so the list is discovered at install time from the
      // manifest injected by the build rather than hard-coded here.
      let urls = ['./', './index.html'];
      try {
        const res = await fetch('./sw-assets.json', { cache: 'no-store' });
        if (res.ok) urls = urls.concat(await res.json());
      } catch {
        /* Shell still works from the two entries above. */
      }
      await Promise.allSettled(urls.map((u) => cache.add(new Request(u, { cache: 'reload' }))));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never intercept API traffic: sync must see real network state so the kiosk can
  // report "offline" honestly instead of replaying a stale manifest.
  if (url.pathname.startsWith('/api/')) return;
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req, { ignoreSearch: false });
      if (hit) return hit;

      try {
        const res = await fetch(req);
        if (res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
        return res;
      } catch (err) {
        // Navigations fall back to the cached shell; the app then renders from IndexedDB.
        if (req.mode === 'navigate') {
          const shell = (await cache.match('./index.html')) || (await cache.match('./'));
          if (shell) return shell;
        }
        throw err;
      }
    })()
  );
});
