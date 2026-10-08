// App shell, hashed assets and question images, so a session works with no signal.
// Bank and progress data are cached by the app itself in IndexedDB (src/store.ts).
const CACHE = "examprep-v3";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/", "/manifest.webmanifest", "/icon.svg"])));
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
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/img/") || url.pathname.startsWith("/icon")) {
    e.respondWith(cacheFirst(e.request));
  }
});
