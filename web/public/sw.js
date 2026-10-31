/*
 * Sentinel service worker. Hand-written, no build step.
 *
 * What it does, and why:
 * - Pages are Clerk-gated and contain findings, so page HTML is never stored.
 *   Navigations go network-first and fall back to a precached /offline page.
 * - /_next/static/* is content-hashed, so it is safe to serve cache-first forever.
 *   Same for the icons, which only change with a CACHE_VERSION bump.
 * - /api/*, RSC/prefetch requests, Clerk routes, non-GET and cross-origin requests
 *   are left entirely to the network (no respondWith), so auth and data stay live.
 * - A new worker waits until the page posts SKIP_WAITING (the update toast), so
 *   open tabs never run a mix of old and new chunks.
 * - CLEAR_CACHES (posted on sign-out) wipes every sentinel- cache.
 *
 * Bump CACHE_VERSION whenever the precache list or caching rules change.
 */

const CACHE_VERSION = "v1";
const CACHE_PREFIX = "sentinel-";
const STATIC_CACHE = `${CACHE_PREFIX}static-${CACHE_VERSION}`;
const SHELL_CACHE = `${CACHE_PREFIX}shell-${CACHE_VERSION}`;
const CURRENT_CACHES = [STATIC_CACHE, SHELL_CACHE];

const OFFLINE_URL = "/offline";
const PRECACHE_URLS = [
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

const FONT_OR_IMAGE = /\.(?:woff2?|ttf|otf|png|jpe?g|gif|webp|avif|svg|ico)$/i;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Add one by one so a missing icon cannot fail the whole install.
      // The offline page is the only entry that matters; log if it is missing.
      await Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch((err) => {
            console.warn(`[sw] precache skipped ${url}`, err);
          }),
        ),
      );
      // No skipWaiting() here: the page decides when to activate (SKIP_WAITING).
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && !CURRENT_CACHES.includes(key))
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const type = event.data && event.data.type;
  if (type === "SKIP_WAITING") {
    self.skipWaiting();
  } else if (type === "CLEAR_CACHES") {
    event.waitUntil(
      (async () => {
        const keys = await caches.keys();
        await Promise.all(
          keys.filter((key) => key.startsWith(CACHE_PREFIX)).map((key) => caches.delete(key)),
        );
      })(),
    );
  }
});

function shouldBypass(request, url) {
  if (request.method !== "GET") return true;
  if (url.origin !== self.location.origin) return true;
  const path = url.pathname;
  if (path === "/sw.js") return true;
  if (path.startsWith("/api/")) return true;
  if (path.startsWith("/sign-in")) return true;
  if (path.startsWith("/__clerk")) return true;
  if (url.searchParams.has("_rsc")) return true;
  if (request.headers.has("RSC") || request.headers.has("Next-Router-Prefetch")) return true;
  return false;
}

function isStaticAsset(url) {
  if (url.pathname.startsWith("/_next/static/")) return true;
  if (url.pathname.startsWith("/icons/") && FONT_OR_IMAGE.test(url.pathname)) return true;
  return false;
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // Only store complete, same-origin successes (no opaque or partial responses).
  if (response.ok && response.status === 200 && response.type === "basic") {
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

async function networkFirstNavigation(request) {
  try {
    // Not stored: page HTML is per-user and holds findings.
    return await fetch(request);
  } catch (err) {
    const offline = await caches.match(OFFLINE_URL, { cacheName: SHELL_CACHE });
    if (offline) return offline;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  if (shouldBypass(request, url)) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request));
  }
  // Everything else: fall through to the network untouched.
});
