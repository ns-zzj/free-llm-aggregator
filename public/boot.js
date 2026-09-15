'use strict';

/**
 * 页面启动探针（原来内联在 admin.html 里，2026-09-13 外置成独立文件）。
 *
 * 为什么外置：审计 M3 要给页面加 CSP，而严格的 `script-src 'self'` 不允许内联脚本。
 * 外置之后 /admin 的响应头可以收紧成 script-src 'self'，同时保留这套诊断通道。
 *
 * 作用：把浏览器里发生的 JS 报错回传到服务端日志（/api/client-log），
 * 免得排查问题时要人工去复制控制台。
 */

// 诊断探针：错误回传服务端日志 + 打到控制台（页面上不再显示诊断行）
window.__diag = function (text) {
  console.log('[LLM 聚合网关] ' + text);
};

window.__report = function (kind, payload) {
  try {
    var body = Object.assign({ kind: kind, page: location.href }, payload || {});
    fetch('/api/client-log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(function () {});
  } catch (e) {
    /* 上报失败就算了，别把页面搞崩 */
  }
};

window.addEventListener(
  'error',
  function (e) {
    var detail = (e.message || e.type) + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0);
    window.__diag('JS 报错：' + detail);
    console.error('[LLM 聚合网关] JS 报错：' + detail, e.error || '');
    window.__report('error', {
      message: e.message || String(e.type),
      source: e.filename,
      line: e.lineno,
      column: e.colno,
      stack: e.error && e.error.stack,
    });
  },
  true
);

window.addEventListener('unhandledrejection', function (e) {
  var reason = (e.reason && (e.reason.stack || e.reason.message)) || String(e.reason);
  window.__diag('JS 未处理的 Promise 错误：' + reason);
  console.error('[LLM 聚合网关] 未处理的 Promise 错误：' + reason, e.reason || '');
  window.__report('unhandledrejection', {
    message: (e.reason && e.reason.message) || String(e.reason),
    stack: e.reason && e.reason.stack,
  });
});

window.__diag('HTML 已加载，正在等 app.js…');
window.__report('页面已打开', { note: 'HTML 解析完成' });
