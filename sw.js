/* نسر البرية — Service Worker: تحميل فوري + كاش ذكي للصور والخطوط */
const CACHE_NAME = "nasr-albaria-shell-v9";
const IMG_CACHE = "nasr-img-v1";
const CDN_CACHE = "nasr-cdn-v1";
const PRESERVED_CACHES = new Set([CACHE_NAME, IMG_CACHE, CDN_CACHE, "nasr-device-id"]);
const MAX_IMG_ENTRIES = 220;
const PRECACHE_URLS = [
  "./",
  "./manifest.json",
  "./logo.webp",
  "./store-design-960.webp",
  "./pwa-192x192.png",
  "./pwa-512x512.png",
  "./favicon-48x48.png",
  "./apple-touch-icon.png",
  "./fawry.png?v=7",
  "./svc-wepay.png?v=7"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => Promise.all(PRECACHE_URLS.map((u) => cache.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => (PRESERVED_CACHES.has(k) ? null : caches.delete(k)))))
      .then(() => (self.registration.navigationPreload ? self.registration.navigationPreload.enable().catch(() => {}) : null))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event && event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

async function trim(cacheName, max) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length > max) await Promise.all(keys.slice(0, keys.length - max).map((k) => cache.delete(k)));
  } catch (e) {}
}

function isCacheable(res) {
  return res && (res.ok || res.type === "opaque");
}

/* كاش أولًا (للصور والخطوط: ما بتتغيرش) */
async function cacheFirst(req, cacheName, max) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (isCacheable(res)) {
    cache.put(req, res.clone()).then(() => max && trim(cacheName, max)).catch(() => {});
  }
  return res;
}

/* رجّع المحفوظ فورًا وحدّث في الخلفية */
async function staleWhileRevalidate(event, req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const net = fetch(req)
    .then((res) => {
      if (isCacheable(res)) cache.put(req, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  if (hit) {
    event.waitUntil(net);
    return hit;
  }
  return (await net) || Response.error();
}

/* الصفحة: الشبكة أولًا بمهلة قصيرة ثم النسخة المحفوظة (سريعة حتى مع النت الضعيف) */
function navigate(event) {
  const req = event.request;
  return (async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match("./");
    const preload = event.preloadResponse ? await event.preloadResponse.catch(() => null) : null;
    const network = preload
      ? Promise.resolve(preload)
      : fetch(req).catch(() => null);
    const timeout = new Promise((r) => setTimeout(() => r("timeout"), cached ? 2500 : 15000));
    const first = await Promise.race([network, timeout]);
    if (first && first !== "timeout" && first.ok) {
      cache.put("./", first.clone()).catch(() => {});
      return first;
    }
    if (cached) {
      event.waitUntil(network.then((r) => { if (r && r.ok) cache.put("./", r.clone()); }).catch(() => {}));
      return cached;
    }
    const late = await network;
    return late || Response.error();
  })();
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (!req || req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (!/^https?:$/.test(url.protocol)) return;
  if (req.headers.has("range")) return;

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith("/api/")) return;
    if (req.mode === "navigate") { event.respondWith(navigate(event)); return; }
    if (/\.(?:png|jpe?g|webp|gif|svg|ico|avif)$/i.test(url.pathname)) {
      event.respondWith(staleWhileRevalidate(event, req, CACHE_NAME));
      return;
    }
    event.respondWith(staleWhileRevalidate(event, req, CACHE_NAME));
    return;
  }

  /* صور المنتجات من مخزن Supabase: كاش أولًا = ظهور فوري في الزيارات التالية */
  if (/\.supabase\.co$/.test(url.hostname)) {
    if (/\/storage\/v1\/(?:object|render\/image)\/public\//.test(url.pathname) && req.destination === "image") {
      event.respondWith(cacheFirst(req, IMG_CACHE, MAX_IMG_ENTRIES));
    }
    return; /* بيانات المتجر والحسابات دايمًا من الشبكة */
  }
  if (url.hostname === "fonts.gstatic.com") { event.respondWith(cacheFirst(req, CDN_CACHE, 40)); return; }
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "cdn.jsdelivr.net") {
    event.respondWith(staleWhileRevalidate(event, req, CDN_CACHE));
  }
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    try { payload = { body: event.data ? event.data.text() : "" }; } catch (err) {}
  }
  const title = payload.title || "متجر نسر البرية الرسمي";
  const options = {
    body: payload.body || "تتوفر عروض ومنتجات جديدة الآن",
    icon: payload.icon || "./pwa-192x192.png",
    badge: payload.badge || "./favicon-48x48.png",
    tag: payload.tag || "nasr-notif",
    data: { url: payload.url || "./" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
