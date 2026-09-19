/*
 * Service worker: keeps the app itself (page, scripts, styles, models, region OSM files) so the
 * simulator starts without a network. Tiles are not handled here: terrain and Sentinel-2 imagery
 * live in their own Cache API stores (src/ui/tileSource.ts), Esri imagery is never stored.
 *
 * Page — network first, cache as fallback. Hashed build files (assets/) — cache first. Other
 * same-origin files — network first, cache as fallback. Local region packs are skipped.
 */
const APP_CACHE = 'vtol-sim-app-v1';
// Servers send Vary: Origin; module scripts carry Origin, files cached by the page do not.
const MATCH = { ignoreVary: true };

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const put = async (req, res) => {
  if (!res.ok || res.type === 'opaque') return;
  const c = await caches.open(APP_CACHE);
  await c.put(req, res);
};

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.includes('/packs/')) return;
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          e.waitUntil(put(new Request(url.origin + url.pathname), copy));
          return res;
        })
        .catch(async () => (await caches.match(url.origin + url.pathname, MATCH)) ?? (await caches.match(new URL('./', self.registration.scope).href, MATCH)) ?? Response.error()),
    );
    return;
  }
  if (url.pathname.includes('/assets/')) {
    e.respondWith(
      caches.match(req, MATCH).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            e.waitUntil(put(req, res.clone()));
            return res;
          }),
      ),
    );
    return;
  }
  e.respondWith(
    fetch(req)
      .then((res) => {
        e.waitUntil(put(req, res.clone()));
        return res;
      })
      .catch(async () => (await caches.match(req, MATCH)) ?? Response.error()),
  );
});
