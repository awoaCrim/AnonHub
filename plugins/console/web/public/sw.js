// Cache only immutable build assets. Never cache conversations, credentials, API responses or HTML.
const CACHE = "yesimbot-assets-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || !/^\/assets\/[\w-]+-[\w-]+\.(js|css|woff2)$/.test(url.pathname)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const saved = await cache.match(request);
      if (saved) return saved;
      const response = await fetch(request);
      if (response.ok && response.type === "basic") {
        await cache.put(request, response.clone());
        const keys = await cache.keys();
        // Bound cache growth across deployments; tabs retain already-loaded modules.
        for (const old of keys.slice(0, Math.max(0, keys.length - 160))) await cache.delete(old);
      }
      return response;
    })(),
  );
});
