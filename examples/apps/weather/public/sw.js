// Service worker for the installed (home-screen) app.
//
// Bump CACHE whenever a shell asset changes — the binary embeds these files at
// build time, so a deploy with a stale cache name would keep serving the old UI.
var CACHE = "weather-v2";

// Relative to the SW's scope, so this works under nginx's /weather/ subpath.
var SHELL = [
  "./",
  "./style.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches
      .open(CACHE)
      .then(function (c) {
        return c.addAll(SHELL);
      })
      .then(function () {
        return self.skipWaiting();
      }),
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.map(function (k) {
            return k === CACHE ? null : caches.delete(k);
          }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  // Forecast data (weather.gov) and geocoding are cross-origin — let them go
  // straight to the network so we never serve a stale temperature.
  var url;
  try {
    url = new URL(req.url);
  } catch (err) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // City lookups: network first, cache as a fallback so the search box still
  // works offline for anything already typed once.
  if (url.pathname.indexOf("/api/cities") !== -1) {
    e.respondWith(
      fetch(req)
        .then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) {
            c.put(req, copy);
          });
          return res;
        })
        .catch(function () {
          return caches.match(req);
        }),
    );
    return;
  }

  // Shell: network first, falling back to cache when offline.
  //
  // Cache-first would serve a stale UI for one full load after every deploy —
  // which is exactly how a shipped feature appears "missing". The assets have
  // no content hash to bust, so freshness has to come from the request.
  e.respondWith(
    fetch(req)
      .then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) {
            c.put(req, copy);
          });
        }
        return res;
      })
      .catch(function () {
        return caches.match(req);
      }),
  );
});
