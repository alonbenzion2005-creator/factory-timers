// Service worker — lets the app install and load its shell offline.
// Bump CACHE when you change the cached files to force an update.
const CACHE = "ft-v1";
const ASSETS = [
  "/", "/index.html", "/styles.css", "/app.js", "/backend.js", "/config.js",
  "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Never intercept the live sync endpoints or non-GET requests.
  if (e.request.method !== "GET") return;
  if (url.origin !== location.origin) return;            // CDN etc. → network
  if (url.pathname.startsWith("/api") ||
      url.pathname === "/events" ||
      url.pathname === "/health") return;

  // Stale-while-revalidate for the app shell.
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
