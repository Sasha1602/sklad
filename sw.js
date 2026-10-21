/* Склад проката — service worker: работа без сети и push-уведомления. */
const CACHE = "sklad-v1";
const SHELL = ["./", "index.html", "style.css", "app.js", "config.js", "vendor/qrcode.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/favicon-64.png"];
const CDN = /(cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Ключ кэша без «?v=…», чтобы app.js?v=123 и app.js?v=456 были одним файлом.
const keyOf = url => { const u = new URL(url); return u.origin + u.pathname; };

self.addEventListener("fetch", e => {
  const req = e.request;
  if(req.method !== "GET") return;
  const url = new URL(req.url);
  if(url.origin === location.origin){
    // Свои файлы: сначала сеть (чтобы обновления приходили сразу), без сети — из кэша.
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      try {
        const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 5000);
        const res = await fetch(req, { signal:ctl.signal }); clearTimeout(t);
        if(res.ok) c.put(keyOf(req.url), res.clone());
        return res;
      } catch(_) {
        const hit = await c.match(keyOf(req.url)) || (req.mode === "navigate" ? await c.match(keyOf(new URL("index.html", self.registration.scope).href)) || await c.match(keyOf(self.registration.scope)) : null);
        return hit || new Response("Нет связи", { status:503, headers:{ "Content-Type":"text/plain; charset=utf-8" } });
      }
    })());
    return;
  }
  if(CDN.test(url.hostname)){
    // Библиотеки и шрифты: из кэша, параллельно обновляем.
    e.respondWith((async () => {
      const c = await caches.open(CACHE), hit = await c.match(req);
      const net = fetch(req).then(res => { if(res.ok || res.type === "opaque") c.put(req, res.clone()); return res; }).catch(() => null);
      return hit || await net || new Response("", { status:503 });
    })());
  }
  // Запросы к базе (Supabase) не трогаем — офлайн-данные хранит само приложение.
});

// ---------- push ----------
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch(_) { d = { title:"Склад проката", body:e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Склад проката", {
    body:d.body || "", tag:d.tag || undefined, renotify:!!d.tag,
    icon:"icons/icon-192.png", badge:"icons/favicon-64.png",
    data:{ url:d.url || "./#today" }
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const target = new URL(e.notification.data && e.notification.data.url || "./#today", self.registration.scope).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type:"window", includeUncontrolled:true });
    for(const c of all){ if(c.url.startsWith(self.registration.scope)){ await c.focus(); c.navigate ? c.navigate(target) : c.postMessage({ goto:target }); return; } }
    await self.clients.openWindow(target);
  })());
});
