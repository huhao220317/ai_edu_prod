/* ==========================================================================
   语文课堂提问系统 · Service Worker
   作用：把网站核心文件缓存到本机，让手机「添加到桌面」后离线也能正常上课。
   维护提示：改动 assets/ 里的文件后，把下面的 CACHE_VERSION 加 1，
             老师下次联网打开页面时会自动更新缓存（见 README「九」）。
   ========================================================================== */

'use strict';

const CACHE_VERSION = 'v4';
const CACHE_NAME = 'yw-quiz-' + CACHE_VERSION;

// 需要提前缓存的核心文件（用相对路径，部署到子目录也能正常工作）
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './使用教程.html',
  './assets/css/style.css',
  './assets/js/app.js',
  './assets/js/data.js',
  './assets/js/vendor/xlsx.full.min.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon.png'
];

/* 安装：逐个缓存核心文件（某个文件缺失不影响其它文件） */
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(CORE_ASSETS.map(url => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

/* 激活：清掉旧版本缓存 */
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* 取资源 */
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;   // 只处理本站资源

  // 页面导航：优先联网拿最新版本，断网时回落到缓存的首页
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        // 按「请求的 URL」缓存：如果把任何导航都写进 './index.html'，
        // 老师访问过一次《使用教程》之后，离线打开首页就会拿到教程页（已修，勿回退）
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      } catch (e) {
        const cached = (await caches.match('./index.html')) || (await caches.match('./'));
        if (cached) return cached;
        return new Response('离线状态下暂时打不开这个页面', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    })());
    return;
  }

  // 其它资源：先用缓存（秒开、离线可用），同时在后台更新
  event.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then(res => {
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => null);
    if (cached) { network.catch(() => {}); return cached; }
    const res = await network;
    return res || new Response('', { status: 504 });
  })());
});
