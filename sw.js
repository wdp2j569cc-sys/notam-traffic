// 앱 셸 캐시 (API 응답은 캐시하지 않음 — NOTAM 마지막 결과는 앱이 localStorage에 보관)
const CACHE = 'notam-traffic-v9';
const SHELL = [
  './', './index.html', './full.html', './notam.js', './manifest.webmanifest', './icon.svg', './icon-180.png',
  './vendor/leaflet/leaflet.css', './vendor/leaflet/leaflet.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  url.search = '';
  const isShell = url.origin === self.location.origin &&
    (SHELL.some(s => url.href === new URL(s, self.registration.scope).href) || url.pathname.includes('/vendor/leaflet/'));
  if (e.request.method !== 'GET' || !isShell) return; // 데이터·지도 타일은 네트워크 그대로
  // 네트워크 우선(브라우저 HTTP 캐시도 우회해 항상 최신), 실패 시 캐시
  e.respondWith(
    fetch(e.request.url, { cache: 'no-cache' }).then(r => {
      if (r.ok) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
