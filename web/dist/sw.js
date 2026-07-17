import { classifyPwaRequest, isSafeCacheResponse, pushText, safePushPayload } from "./pwa-policy.mjs";

const CACHE_VERSION = "grok-build-shell-v2";
const INSTALL_ASSETS = ["/design-polish.css", "/design-polish.js", "/manifest.webmanifest", "/offline.html", "/grok-build-icon.svg", "/grok-build-maskable.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(INSTALL_ASSETS)));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("grok-build-shell-") && key !== CACHE_VERSION).map((key) => caches.delete(key)))),
    self.clients.claim(),
  ]));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "ACTIVATE_UPDATE") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const classification = classifyPwaRequest(event.request, self.location.origin);
  if (classification === "network-only") return;
  if (classification === "navigation-fallback") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/offline.html").then((response) => response || Response.error())));
    return;
  }
  event.respondWith(caches.open(CACHE_VERSION).then(async (cache) => {
    const cached = await cache.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (isSafeCacheResponse(response)) await cache.put(event.request, response.clone());
    return response;
  }));
});

self.addEventListener("sync", (event) => {
  if (event.tag !== "grok-build-refresh") return;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    for (const client of clients) client.postMessage({ type: "BACKGROUND_READ_ONLY_REFRESH" });
  }));
});

self.addEventListener("push", (event) => {
  let payload = null;
  try { payload = safePushPayload(event.data?.json()); } catch { payload = null; }
  if (!payload) return;
  const text = pushText(payload.kind);
  event.waitUntil(self.registration.showNotification(text.title, {
    body: text.body,
    icon: "/grok-build-icon.svg",
    badge: "/grok-build-icon.svg",
    tag: payload.eventId,
    renotify: false,
    data: { eventId: payload.eventId, taskId: payload.taskId },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const taskId = event.notification.data?.taskId;
  const target = taskId ? `/?task=${encodeURIComponent(taskId)}` : "/";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) { await existing.navigate(target); return existing.focus(); }
    return self.clients.openWindow(target);
  }));
});
