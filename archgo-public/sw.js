/* 架构术语学习通 · Service Worker
   策略：
   - App Shell（HTML/CSS/JS/图标/manifest）：cache-first + 后台更新（stale-while-revalidate 变体）
   - Supabase API / CDN：network-only（不缓存动态数据与第三方 SDK）
*/
var CACHE = 'arch-term-v13';

var SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/css/style.css',
  './assets/js/terms.js',
  './assets/js/store.js',
  './assets/js/srs.js',
  './assets/js/config.js',
  './assets/js/sync.js',
  './assets/js/bgm.js',
  './assets/js/app.js',
  './assets/js/pwa.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(SHELL);
    })
  );
});

// 收到页面消息后跳过等待，立即激活新版本（配合页面「刷新使用新版」提示）
self.addEventListener('message', function (e) {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);

  // Supabase / 第三方 API：直连，不缓存
  if (url.hostname.indexOf('supabase') >= 0) return;

  // CDN 等跨域资源：network-first，失败兜底缓存
  if (url.origin !== location.origin) {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () {
        return caches.match(req);
      })
    );
    return;
  }

  // 同源 App Shell：SWR —— 先回缓存保证秒开与离线，同时后台刷新
  e.respondWith(
    caches.match(req).then(function (cached) {
      var fetching = fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || fetching;
    })
  );
});
