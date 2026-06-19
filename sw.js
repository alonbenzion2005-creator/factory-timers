// Service worker — lets the app install, load offline, and ring in the
// background via push notifications.
// Bump CACHE when you change the cached files to force an update.
const CACHE = "dt-v2";
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
  if (e.request.method !== "GET") return;
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api") || url.pathname === "/events" ||
      url.pathname === "/health" || url.pathname === "/vapidPublicKey") return;

  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request).then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

// Background alert: fired by the server when a timer hits zero.
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = {}; }
  const title = data.title || "Dudi Timer";
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || "A timer finished",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    vibrate: [300, 120, 300, 120, 500],
    tag: "timer-done",
    renotify: true,
    requireInteraction: true,
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    for (const c of cs) if ("focus" in c) return c.focus();
    if (self.clients.openWindow) return self.clients.openWindow("/");
  }));
});
