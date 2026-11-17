// アプリ本体（HTML/JS/CSS）を端末に保存して、起動を速くしオフラインでも開けるようにする。
// 保存済みのものをすぐ返し、裏で最新版を取得する（更新は次回起動時に反映）。メモの中身は扱わない。
const CACHE = 'memue-shell-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const key = u.origin + u.pathname; // ?code=... などのクエリは無視
    const hit = await c.match(key);
    const net = fetch(key, { cache: 'no-cache' }).then((r) => { if (r.ok) c.put(key, r.clone()); return r; });
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net;
  }));
});
