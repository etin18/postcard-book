/* ==========================================================================
   Service Worker — 讓 App 加到主畫面後即使沒網路也開得起來

   只快取自己的靜態檔案。往 Google Apps Script 的請求一律放行，
   絕對不快取，否則會讀到過期的地址。
   ========================================================================== */

// 改動 www/ 裡的檔案後記得把版號 +1，
// 否則手機會一直吃舊快取，看不到新版
const VERSION = 'v4';
const CACHE = `postcard-book-${VERSION}`;

const SHELL = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 跨網域（Apps Script API）直接走網路，不碰快取
  if (url.origin !== self.location.origin) return;

  // 導覽請求：先試網路拿最新版，失敗才用快取 —— 離線時照樣開得起來
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('index.html', copy));
          return res;
        })
        .catch(() => caches.match('index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // 靜態資源：先用快取（開啟速度），背景更新
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);

      return cached || network;
    })
  );
});
