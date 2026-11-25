// アプリの部品（HTML・CSS・JavaScript・アイコン）の受け渡し役（Service Worker）。
// いつも最新を取りに行き（更新がすぐ反映されるように）、取りに行けないとき（オフライン）だけ、前回保存した部品を使う。
// ノートのデータ（IndexedDB）には触らない。
const CACHE = 'notes-app-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = url.origin + url.pathname;
    try {
      // ブラウザの一時保存を使わず、サーバーに最新かどうか確かめる（変わっていなければ短い返事だけで済む）
      const res = await fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' });
      if (res.ok) cache.put(key, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(key);
      if (hit) return hit;
      throw err;
    }
  })());
});
