/* 架构术语学习通 · PWA 安装与动态视口 */
(function () {
  'use strict';

  /* ---- 动态视口高度：解决手机浏览器地址栏伸缩导致 100vh 抖动 ---- */
  function setVH() {
    document.documentElement.style.setProperty('--vh', (window.innerHeight * 0.01) + 'px');
  }
  setVH();
  window.addEventListener('resize', setVH);
  window.addEventListener('orientationchange', function () { setTimeout(setVH, 120); });

  /* ---- 主题色跟随 ---- */
  var meta = document.getElementById('metaTheme');
  function syncThemeColor() {
    if (!meta) return;
    var dark = document.documentElement.getAttribute('data-theme') !== 'light';
    meta.setAttribute('content', dark ? '#0e1117' : '#f4f6fb');
  }
  syncThemeColor();
  new MutationObserver(syncThemeColor).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  /* ---- Service Worker 注册（仅 https 或 localhost） ---- */
  if ('serviceWorker' in navigator) {
    var swOK = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (swOK) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').then(function (reg) {
          // 若已有一个等待中的新版，直接提示
          if (reg.waiting) promptUpdate(reg.waiting);
          reg.addEventListener('updatefound', function () {
            var nw = reg.installing;
            if (!nw) return;
            nw.addEventListener('statechange', function () {
              if (nw.state === 'installed' && navigator.serviceWorker.controller) promptUpdate(nw);
            });
          });
        }).catch(function (err) {
          console.warn('SW 注册失败（不影响使用）:', err);
        });

        // 用户同意更新后，新 SW 接管时刷新页面
        var updated = false;
        navigator.serviceWorker.addEventListener('controllerchange', function () {
          if (updated) window.location.reload();
        });

        function promptUpdate(sw) {
          if (document.getElementById('updateBar')) return;
          var el = document.createElement('div');
          el.className = 'update-bar';
          el.id = 'updateBar';
          el.innerHTML = '<p>发现新版本，点击刷新使用最新内容。</p>' +
            '<button class="btn primary">立即刷新</button>' +
            '<button class="x" aria-label="关闭">✕</button>';
          el.querySelector('.btn').addEventListener('click', function () { updated = true; sw.postMessage('skip-waiting'); });
          el.querySelector('.x').addEventListener('click', function () { el.remove(); });
          document.body.appendChild(el);
        }
      });
    }
  }

  /* ---- 安装提示（beforeinstallprompt） ---- */
  var deferredPrompt = null;
  var bar = null;

  function buildBar() {
    var el = document.createElement('div');
    el.className = 'install-bar';
    el.innerHTML =
      '<p><b>安装「架构术语学习通」</b>添加到主屏幕，全屏打开、离线可用。</p>' +
      '<button class="btn primary">安装</button>' +
      '<button class="x" aria-label="关闭">✕</button>';
    var ok = el.querySelector('.btn');
    var no = el.querySelector('.x');
    ok.addEventListener('click', function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt.userChoice.finally(function () {
        deferredPrompt = null;
        dismiss();
      });
    });
    no.addEventListener('click', function () { dismiss(true); });
    function dismiss(persist) {
      if (persist) { try { localStorage.setItem('install-dismissed', '1'); } catch (e) {} }
      if (bar) { bar.remove(); bar = null; }
    }
    return el;
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    var dismissed = false;
    try { dismissed = localStorage.getItem('install-dismissed') === '1'; } catch (err) {}
    var standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (!standalone && !dismissed && !bar) {
      bar = buildBar();
      document.body.appendChild(bar);
    }
  });

  window.addEventListener('appinstalled', function () {
    if (bar) { bar.remove(); bar = null; }
    try { localStorage.setItem('install-dismissed', '1'); } catch (e) {}
  });

  /* ---- 设置页「添加到主屏幕」按钮 ---- */
  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('btnInstall');
    var tip = document.getElementById('installTip');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
      if (standalone) {
        if (tip) tip.textContent = '当前已经以独立 App 模式运行，无需再次安装。';
        return;
      }
      if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.finally(function () { deferredPrompt = null; });
      } else {
        var ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
        if (tip) {
          tip.textContent = ios
            ? 'iOS 安装方法：点击浏览器底部「分享」按钮 → 选择「添加到主屏幕」。'
            : '当前浏览器不支持一键安装：Android 用 Chrome 菜单 →「添加到主屏幕」；iOS 用 Safari 分享 →「添加到主屏幕」。';
        }
      }
    });
  });
})();
