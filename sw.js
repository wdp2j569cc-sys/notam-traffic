// 앱 셸 캐시 (API 응답은 캐시하지 않음 — NOTAM 마지막 결과는 앱이 localStorage에 보관)
const CACHE = 'notam-traffic-v2';
const SHELL = [
  './', './index.html', './notam.js', './manifest.webmanifest', './icon.svg', './icon-180.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const isShell = SHELL.some(s => e.request.url === new URL(s, self.registration.scope).href);
  if (e.request.method !== 'GET' || !isShell) return; // API·지도 타일은 네트워크 그대로
  // 네트워크 우선, 실패 시 캐시
  e.respondWith(
    fetch(e.request).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); return r; })
      .catch(() => caches.match(e.request))
  );
});
