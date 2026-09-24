// public/sw.js
//
// The service worker exists for ONE reason: iOS will not deliver a Web
// Push notification to a site, only to a page installed to the home
// screen, and it will not install a page that has no service worker. That
// is the whole of §7's platform dependency, and it is why this file is
// here before anything sends a push.
//
// IT DOES NOT CACHE. Not the shell, not the assets, nothing. A cached
// wibble is a wibble showing yesterday's canvas while the Mac it is a
// window onto has moved on, and §10's whole argument is that a stale
// answer is worse than an honest failure. When the Mac is unreachable the
// app says so; it does not show a copy.
//
// `fetch` is therefore not handled at all — with no fetch handler the
// browser goes to the network exactly as it would without a worker, and
// the page stays installable.

self.addEventListener("install", () => {
  // Take over immediately rather than waiting for every tab to close.
  // There is nothing to migrate, because nothing is cached.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// A push carries NO CONTENT (Ruling K, §7.2). What arrives is a nudge and
// a session to open, never a message, a diff, a filename or a prompt: the
// notification is rendered by the operating system, on a lock screen, in
// front of whoever is nearby — and this app holds a shell.
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = typeof payload.title === "string" ? payload.title : "wibble";
  const body = typeof payload.body === "string" ? payload.body : "Something needs you.";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon-256.png",
      badge: "/icon-256.png",
      // One notification at a time per session, replaced rather than
      // stacked: three prompts from one agent is one thing to come back
      // to, not three.
      tag: typeof payload.tag === "string" ? payload.tag : "wibble",
      renotify: true,
      data: { url: typeof payload.url === "string" ? payload.url : "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Reuse a tab that is already open rather than piling up windows:
      // the operator has one wibble, however many times they tap.
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
