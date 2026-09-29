// Generated worker sources for the root-hosted export. Kept in a module with no
// side effects or top-level await so tests can import the exact strings.

export function serviceWorker(version, assets, shell) {
  return `/* Generated hosted app shell. No host data, API requests or relay traffic is cached. */
const CACHE = ${JSON.stringify(`paseo-shell-${version}`)};
const ASSETS = new Set(${JSON.stringify([...new Set([...assets, ...shell.filter((url) => url !== "/index.html")])])});
self.addEventListener("install", event => {
  // Populate this release's shell before activating. skipWaiting makes the new
  // worker take over as soon as it is ready; the page reloads at a safe moment.
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(${JSON.stringify(shell)}.map(url => new Request(url, { cache: "reload" })))).then(() => self.skipWaiting()));
});
// The page may drive activation directly for a waiting release.
self.addEventListener("message", event => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith("paseo-shell-") && key !== CACHE).map(key => caches.delete(key)));
    // Own every open window so the latest release answers for it after reload.
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname === "/api" || url.search) return;
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: "no-store" });
        if (!response.ok) throw new Error("Navigation unavailable");
        // Online HTML may refer to a newer release. The update controller reloads
        // at a safe moment; until then this worker keeps one release's shell and assets together.
        return response;
      } catch {
        return await caches.match("/index.html", { cacheName: CACHE }) || Response.error();
      }
    })());
  } else if (ASSETS.has(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === "basic") await cache.put(request, response.clone());
      return response;
    })());
  }
});
`;
}

export function serviceWorkerRegistration() {
  return `/* Generated hosted app update controller. Revalidates the offline shell and applies releases without a prompt. */
(function () {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  var SW_URL = "/sw.js";
  var UPDATE_INTERVAL_MS = 60 * 60 * 1000;
  var RELOAD_POLL_MS = 5 * 1000;
  var IDLE_MS = 60 * 1000;
  var hadController = Boolean(navigator.serviceWorker.controller);
  var registration = null;
  var updateReady = false;
  var reloading = false;
  var lastActivity = Date.now();

  function noteActivity() { lastActivity = Date.now(); }
  ["keydown", "keyup", "input", "pointerdown", "focusin", "scroll"].forEach(function (type) {
    window.addEventListener(type, noteActivity, { passive: true, capture: true });
  });

  function isEditing() {
    var element = document.activeElement;
    if (!element) return false;
    var tag = element.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || element.isContentEditable === true;
  }

  // Reload only when no work can be lost: hidden, or idle with nothing focused.
  // Drafts, saved operations and pending sends recover from their own storage.
  function isSafeToReload() {
    if (!updateReady) return false;
    if (document.visibilityState === "hidden") return true;
    if (isEditing()) return false;
    return Date.now() - lastActivity >= IDLE_MS;
  }

  function reloadForUpdate() {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  }

  function maybeReload() { if (isSafeToReload()) reloadForUpdate(); }

  function watchWorker(worker) {
    if (!worker) return;
    worker.addEventListener("statechange", function () {
      if (worker.state !== "installed" || !hadController) return;
      updateReady = true;
      if (registration && registration.waiting) registration.waiting.postMessage({ type: "SKIP_WAITING" });
      maybeReload();
    });
  }

  function observe(reg) {
    registration = reg;
    reg.addEventListener("updatefound", function () { watchWorker(reg.installing); });
    watchWorker(reg.installing);
    watchWorker(reg.waiting);
  }

  function checkForUpdate() {
    if (!registration) return;
    var updating = registration.update();
    if (updating && typeof updating.catch === "function") updating.catch(function () {});
    if (registration.waiting) {
      updateReady = true;
      registration.waiting.postMessage({ type: "SKIP_WAITING" });
    }
    maybeReload();
  }

  navigator.serviceWorker.addEventListener("controllerchange", function () {
    // The first controller claim is not an update; only reload a replaced release.
    if (!hadController) { hadController = true; return; }
    updateReady = true;
    maybeReload();
  });

  window.addEventListener("load", function () {
    navigator.serviceWorker.register(SW_URL, { updateViaCache: "none" }).then(observe).catch(function (error) {
      console.error("App offline support unavailable", error);
    });
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") maybeReload();
    else checkForUpdate();
  });
  window.addEventListener("focus", checkForUpdate);
  window.addEventListener("online", checkForUpdate);
  setInterval(checkForUpdate, UPDATE_INTERVAL_MS);
  setInterval(maybeReload, RELOAD_POLL_MS);
})();
`;
}
