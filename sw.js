// 앱 셸 캐시 + 지도 타일 캐시 + 푸시 알림
const CACHE = 'notam-traffic-v11';
const TILES = 'notam-tiles-v1';
const TILE_MAX = 3000; // 저장할 최대 타일 수 (약 50~60MB 이내)
const SHELL = [
  './', './index.html', './full.html', './notam.js', './nearby-core.js', './manifest.webmanifest', './icon.svg', './icon-180.png',
  './vendor/leaflet/leaflet.css', './vendor/leaflet/leaflet.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== TILES).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

let trimming = false;
async function trimTiles() {
  if (trimming) return; trimming = true;
  try {
    const c = await caches.open(TILES), ks = await c.keys();
    for (let i = 0; i < ks.length - TILE_MAX; i++) await c.delete(ks[i]);
  } finally { trimming = false; }
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // 지도 타일: 본 적 있는 타일은 저장해 두고, 통신이 안 되면 저장본 사용 (네트워크 우선)
  if (/(^|\.)tile\.openstreetmap\.org$/.test(url.hostname)) {
    e.respondWith(
      fetch(e.request).then(r => {
        if (r.ok) { const cp = r.clone(); caches.open(TILES).then(c => c.put(e.request, cp)).then(trimTiles); }
        return r;
      }).catch(() => caches.open(TILES).then(c => c.match(e.request)).then(r => r || Response.error()))
    );
    return;
  }
  url.search = '';
  const isShell = url.origin === self.location.origin &&
    (SHELL.some(s => url.href === new URL(s, self.registration.scope).href) || url.pathname.includes('/vendor/leaflet/'));
  if (!isShell) return; // 데이터는 네트워크 그대로 (앱이 마지막 결과를 따로 보관)
  // 네트워크 우선(브라우저 HTTP 캐시도 우회해 항상 최신), 실패 시 캐시
  e.respondWith(
    fetch(e.request.url, { cache: 'no-cache' }).then(r => {
      if (r.ok) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

// 푸시: GitHub Actions(scripts/notify.mjs)가 보냄 — {title, body, tag}
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || '새 NOTAM', {
    body: d.body || '', tag: d.tag || 'notam', icon: 'icon-180.png', badge: 'icon-180.png', data: { url: './' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    for (const w of ws) if ('focus' in w) return w.focus();
    return self.clients.openWindow(self.registration.scope);
  }));
});
