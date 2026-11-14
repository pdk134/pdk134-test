/* =========================================================
 * 月记 - Service Worker
 * 策略：
 *   - 应用外壳（HTML/CSS/JS）采用「网络优先」，确保更新及时
 *   - 网络失败时回退到缓存，实现离线可用
 *   - 缓存名带版本号，升级时自动清理旧缓存
 * ========================================================= */

const CACHE_NAME = 'period-tracker-v4';

const APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/features.js',
  './js/config.js',
  './js/cloud.js',
  './manifest.webmanifest',
  './icons/favicon.svg'
];

/* ---------- 安装：预缓存应用外壳 ---------- */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache =>
        // 逐个添加，单个失败不影响整体（如图标缺失）
        Promise.all(
          APP_SHELL.map(url =>
            cache.add(url).catch(err => console.warn('[SW] 预缓存失败:', url, err))
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

/* ---------- 激活：清理旧版本缓存 ---------- */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] 清理旧缓存:', key);
            return caches.delete(key);
          })
      ))
      .then(() => self.clients.claim())
  );
});

/* ---------- 请求拦截：网络优先 + 离线回退 ---------- */
self.addEventListener('fetch', event => {
  const { request } = event;

  // 只处理同源 GET 请求
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  // 页面导航请求：网络优先，失败则回退到缓存的首页
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => {});
          return response;
        })
        .catch(() =>
          caches.match(request).then(hit => hit || caches.match('./index.html'))
        )
    );
    return;
  }

  // 静态资源：网络优先，失败回退缓存
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then(hit => {
          if (hit) return hit;
          // 资源确实不存在时返回明确的错误响应
          return new Response('', { status: 504, statusText: 'Offline' });
        })
      )
  );
});
