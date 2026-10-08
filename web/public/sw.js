// App shell, hashed assets and question images, so a session works with no signal.
// Bank and progress data are cached by the app itself in IndexedDB (src/store.ts).
const CACHE = "examprep-v5";

// Precache the shell and the hashed bundles it references, so the very first offline launch works.
self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(["/", "/manifest.webmanifest", "/icon.svg"]);
      const html = await (await cache.match("/")).text();
      const assets = [...new Set(html.match(/\/assets\/[^"']+/g) ?? [])];
      await cache.addAll(assets);
    })(),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

const cacheFirst = async (req) => {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
  return res;
};

const staleWhileRevalidate = async (req, e) => {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const refresh = fetch(req, { cache: "no-cache" }) // revalidate past the HTTP cache too
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => hit);
  if (hit) {
    e.waitUntil(refresh);
    return hit;
  }
  return refresh;
};

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return; // sign-in redirects pass straight through

  // Opening a full-size screenshot is a navigation too; it belongs in the image cache.
  if (e.request.mode === "navigate" && !url.pathname.startsWith("/img/")) {
    e.respondWith(
      fetch(e.request)
        .then(async (res) => {
          const html = res.headers.get("content-type")?.startsWith("text/html");
          if (res.ok && res.type === "basic" && html) (await caches.open(CACHE)).put("/", res.clone());
          return res;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }
  // Hashed bundles never change; images can be re-uploaded under the same name, so serve the
  // cached copy at once and refresh it in the background.
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icon")) e.respondWith(cacheFirst(e.request));
  else if (url.pathname.startsWith("/img/")) e.respondWith(staleWhileRevalidate(e.request, e));
});
