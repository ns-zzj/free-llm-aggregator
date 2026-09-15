'use strict';

/* 管理后台（原生 JS，无框架） */

const BUILD_TAG = '2026-09-11-m8.0';
// 前端版本：登录后页面上那行「诊断：」就藏起来了（它在登录表单里），所以版本号走控制台。
// F12 → Console 就能看到；如果版本不是最新的，说明浏览器用了缓存的 app.js，Ctrl+F5 强刷。
if (typeof window !== 'undefined') {
  window.__webVersion = BUILD_TAG;
  console.log(
    `%c[LLM 聚合网关 · 管理后台] 前端版本 ${BUILD_TAG}`,
    'color:#6aa8ff;font-weight:600'
  );
  console.log('在控制台输入 __webVersion 可随时再查一次；不是最新版就按 Ctrl+F5 强制刷新。');
}
if (typeof window !== 'undefined' && typeof window.__diag === 'function') {
  window.__diag(`app.js 已加载（构建 ${BUILD_TAG}）`);
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const REJECT_POLICY_LABELS = {
  keep_trying: '不停用（失败也不停、不探测）',
  cooldown_probe: '倒计时检测（冷却后自动探测）',
  stop_manual: '停用不检测（人工恢复）',
};

// 表格里用的短标签（列窄，长文本会被挤成竖排）
const REJECT_POLICY_SHORT = {
  keep_trying: '不停用',
  cooldown_probe: '倒计时检测',
  stop_manual: '停用不检测',
};

const STATUS_LABELS = {
  available: '可用',
  cooldown: '冷却中',
  stopped: '已停用',
  quota_exhausted: '额度用尽',
};

/**
 * 适配器（上游协议）。列表要和后端 src/gateway/adapters/index.js 的注册表一致
 * —— 后端会拒绝不认识的值，所以这里少写一个只会"选项缺失"，不会出错。
 */
const ADAPTER_META = {
  'openai-compatible': {
    label: 'openai-compatible（OpenAI 兼容接口）',
    baseUrlHint: 'https://integrate.api.nvidia.com/v1',
  },
  anthropic: {
    label: 'anthropic（Anthropic Messages API）',
    baseUrlHint: 'https://api.anthropic.com/v1',
  },
  'cloudflare-workers-ai': {
    label: 'cloudflare-workers-ai（Cloudflare Workers AI）',
    baseUrlHint: 'https://api.cloudflare.com/client/v4',
    needsAccountId: true,
    defaultBaseUrl: 'https://api.cloudflare.com/client/v4',
  },
};

/**
 * 后端注册表返回的协议清单（`GET /api/admin/adapters`），登录后拉一次。
 * 下拉框以它为准 —— 这里只是**兜底**：接口拿不到时用上面那份硬编码的，界面不至于空掉。
 */
let ADAPTER_LIST = [];

function adapterOptions() {
  const list = ADAPTER_LIST.length
    ? ADAPTER_LIST.map((a) => [a.id, a.label || a.id])
    : Object.entries(ADAPTER_META).map(([id, meta]) => [id, meta.label]);
  return Object.fromEntries(list);
}

function adapterMeta(id) {
  const fromServer = ADAPTER_LIST.find((a) => a.id === id);
  if (fromServer) return fromServer;
  return ADAPTER_META[id] || {};
}

// 模型运行时状态（主页与编辑页统一用这四种）
const RUNTIME_LABELS = { enabled: '启用', disabled: '禁用', error: '故障', rate_limited: '限速' };
const RUNTIME_BADGE_CLASS = { enabled: 'ok', disabled: '', error: 'err', rate_limited: 'blue' };

function runtimeBadge(model) {
  const status = model.runtimeStatus || 'enabled';
  // 「故障」时鼠标悬停能看到原因（比如"这个模型需要 Workers Paid 计划"），不用去翻日志
  const reason = model.state && model.state.reason ? String(model.state.reason) : '';
  return h('span', {
    class: `badge ${RUNTIME_BADGE_CLASS[status] || ''}`.trim(),
    text: RUNTIME_LABELS[status] || status,
    title: reason || null,
  });
}

/** 单个模型的「测试」按钮（主页和编辑弹层共用）——测试按真实调用处理。
 *  type: 'button' 是必须的：编辑弹层里这块在 <form> 内，不写 type 的按钮会变成提交表单。 */
function modelTestButton(providerId, model, onDone) {
  return h('button', {
    type: 'button',
    class: 'tiny',
    text: '测试',
    onclick: async (event) => {
      event.target.disabled = true;
      try {
        const result = await api(`/providers/${providerId}/test`, {
          method: 'POST',
          body: { modelId: model.modelId },
        });
        alert(testResultMessage(result));
      } catch (err) {
        alert(err.message);
      } finally {
        event.target.disabled = false;
        if (typeof onDone === 'function') onDone();
      }
    },
  });
}

function testResultMessage(result) {
  if (result.rateLimited) return `本地限速中，本次测试没有发出：\n${result.message || ''}`;
  if (result.ok) {
    return `成功：${result.model}\n延迟 ${result.latencyMs}ms`;
  }
  let stateNote = '';
  if (result.state && result.state.status) {
    const label = STATUS_LABELS[result.state.status] || result.state.status;
    const extra = result.state.cooldownRemainingSeconds ? `，${result.state.cooldownRemainingSeconds}s 后自动重测` : '';
    stateNote = `\n该模型状态 → ${label}${extra}`;
  }
  return `失败（${result.errorType || 'HTTP ' + result.httpStatus}）：${result.message || ''}${stateNote}\n${result.raw || ''}`;
}

/**
 * 倒计时栏：文字在左（显示状态 + 剩余秒数），长条在右
 *   蓝色 = rpm 限速剩余（同一提供商的模型共享同一个限速窗口）
 *   红色 = 故障后"下次重测"剩余
 *   绿色 = 可用
 */
function countdownCell(model) {
  const cell = h('td', { class: 'countdown-cell' });
  const wrap = h('div', { class: 'cd-wrap' });
  cell.appendChild(wrap);
  const status = model.runtimeStatus || 'enabled';

  if (status === 'disabled') {
    wrap.appendChild(h('span', { class: 'cd muted', text: '禁用' }));
    wrap.appendChild(h('span', { class: 'bar muted' }));
    return cell;
  }

  if (status === 'error') {
    const seconds = model.state && model.state.cooldownRemainingSeconds ? model.state.cooldownRemainingSeconds : 0;
    if (seconds > 0) {
      cell.dataset.until = String(Date.now() + seconds * 1000);
      cell.dataset.label = '故障';
      wrap.appendChild(h('span', { class: 'cd red', text: `故障 ${seconds}s` }));
    } else {
      wrap.appendChild(h('span', { class: 'cd red', text: '故障（需人工）' }));
    }
    wrap.appendChild(h('span', { class: 'bar red' }));
    return cell;
  }

  if (status === 'rate_limited') {
    const seconds = model.rateEtaSeconds || 0;
    if (seconds > 0) {
      cell.dataset.until = String(Date.now() + seconds * 1000);
      cell.dataset.label = '限速';
      wrap.appendChild(h('span', { class: 'cd blue', text: `限速 ${seconds}s` }));
    } else {
      wrap.appendChild(h('span', { class: 'cd blue', text: '限速' }));
    }
    wrap.appendChild(h('span', { class: 'bar blue' }));
    return cell;
  }

  wrap.appendChild(h('span', { class: 'cd ok', text: '可用' }));
  wrap.appendChild(h('span', { class: 'bar ok' }));
  return cell;
}

/** 倒计时：后端给具体秒数 → 前端每秒走字；每 10 秒重新向后端校准一次 */
function startCountdownTicker() {
  if (window.__countdownTimer) return;

  // 1) 本地每秒递减（显示用；真实逻辑全在后端的时间戳上）
  window.__countdownTimer = setInterval(() => {
    let expired = false;
    for (const cell of $$('.countdown-cell[data-until]')) {
      const span = cell.querySelector('.cd');
      if (!span) continue;
      const remain = Math.ceil((Number(cell.dataset.until) - Date.now()) / 1000);
      if (remain <= 0) {
        expired = true;
        continue;
      }
      span.textContent = `${cell.dataset.label || ''} ${remain}s`.trim();
    }
    if (expired) refreshCurrentTab(); // 归零了就该问后端要新的真实值
  }, 1000);

  // 2) 每 10 秒向后端校准一次（避免长时间开着页面后数字漂移/状态过期）
  window.__calibrateTimer = setInterval(() => {
    if (window.__dragging || providerModal) return; // 拖拽中/弹层开着时别动 DOM
    refreshCurrentTab();
  }, 10 * 1000);
}

function refreshCurrentTab() {
  const active = $('#tabs button.active');
  if (!active) return;
  if (active.dataset.tab === 'overview') renderOverview().catch(() => {});
  else if (active.dataset.tab === 'all-order') renderAllOrder().catch(() => {});
  else if (active.dataset.tab === 'groups') renderModelGroups().catch(() => {});
  else if (active.dataset.tab === 'providers') renderProviders().catch(() => {});
}

function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = value;
    // 有意**不支持** { html: … }（审计 L2）：全仓没有调用点，留着就是一个"哪天有人把
    // 上游错误原文塞进来就变存储型 XSS"的雷。要插节点就用 children。
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
  return node;
}

function table(headers, rows) {
  return h('div', { class: 'table-scroll' }, [
    h('table', {}, [
      h('thead', {}, [h('tr', {}, headers.map((t) => h('th', { text: t })))]),
      h('tbody', {}, rows),
    ]),
  ]);
}

function fmtTime(ts) {
  if (!ts) return '-';
  return new Date(Number(ts)).toLocaleString('zh-CN', { hour12: false });
}

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`/api/admin${path}`, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // 请求根本没发出去（网络/服务未启动/被扩展拦了）
    if (typeof window.__report === 'function') {
      window.__report('fetch 失败', { message: `${method} ${path} → ${err.message}` });
    }
    throw new Error(`请求 ${path} 失败：${err.message}（服务还在运行吗？）`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (err) {
    if (typeof window.__report === 'function') {
      window.__report('响应不是 JSON', { message: `${method} ${path} → HTTP ${res.status}，前 200 字符：${text.slice(0, 200)}` });
    }
    throw new Error(`服务返回了非 JSON 内容（HTTP ${res.status}）`);
  }
  if (!res.ok) {
    const message = (data && data.error && data.error.message) || `HTTP ${res.status}`;
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  return data;
}

/* ------------------------------------------------------------------ 启动 */

async function init() {
  try {
    await api('/me');
    showApp();
    return;
  } catch (err) {
    if (err.status === 403) {
      // 还没设置管理密码 → 走首次设置（下面再确认一次状态，顺便看来源允不允许）
      const status = await api('/setup/status').catch(() => null);
      if (status && status.needsSetup) return showSetup(status);
      // 公网来源进了被挡住的后台：在登录页直接说清楚，别让他输完密码再吃一个 403
      if (status && status.adminAllowedHere === false) {
        showLogin();
        $('#login-error').textContent = `管理端只允许从本机或内网访问（你在 ${status.clientIp}）。要在外面管理，请从内网访问或用 SSH 隧道进来。`;
        return;
      }
    }
    if (err.status && err.status !== 401 && typeof window.__report === 'function') {
      window.__report('初始化异常', { message: err.message, stack: err.stack });
    }
    return showLogin();
  }
}

function showLogin() {
  $('#setup-view').hidden = true;
  $('#login-view').hidden = false;
  $('#app-view').hidden = true;
  $('#login-password').focus();
}

// 首次设置页「下游 apikey」这一格的状态：keeps = 已经有一条口令，默认沿用（显示成 sk-****）
let setupKeyState = { keeps: false, masked: '' };

function randomAccessKey() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const body = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `sk-agg-${body}`;
}

/** 这一格的三种样子：keep 沿用（只读 sk-**** + 更改）/ edit 正在换（可填 + 取消）/ fresh 全新（可填） */
function applySetupKeyView(mode) {
  const input = $('#setup-access-key');
  const button = $('#setup-key-change');
  const title = $('#setup-key-title');
  if (mode === 'keep') {
    input.value = setupKeyState.masked;
    input.readOnly = true;
    input.placeholder = '';
    title.textContent = '下游请求 apikey';
    button.textContent = '更改';
    button.hidden = false;
  } else if (mode === 'edit') {
    input.readOnly = false;
    input.value = '';
    input.placeholder = '填新的，留空则自动生成';
    title.textContent = '下游请求 apikey（换了之后旧口令立即失效）';
    button.textContent = '取消';
    button.hidden = false;
    input.focus();
  } else {
    input.readOnly = false;
    input.value = '';
    input.placeholder = '随便写，sk- 会自动补上';
    title.textContent = '下游请求 apikey（留空则自动生成）';
    button.hidden = true;
  }
}

function showSetup(status) {
  $('#login-view').hidden = true;
  $('#app-view').hidden = true;
  $('#setup-view').hidden = false;
  const error = $('#setup-error');
  error.textContent = status && status.allowedFromHere === false ? `${status.reason || ''}` : '';
  // 只重置过管理密码的情况：库里已经有一条下游口令，显示出来让用户决定改不改
  const hasKey = !!(status && status.hasAccessKey);
  setupKeyState = { keeps: hasKey, masked: (status && status.accessKeyMasked) || 'sk-********' };
  applySetupKeyView(hasKey ? 'keep' : 'fresh');
  $('#setup-password').focus();
}

$('#setup-key-change').addEventListener('click', () => {
  if (setupKeyState.keeps) applySetupKeyView($('#setup-access-key').readOnly ? 'edit' : 'keep');
});

/**
 * 右上角的"客户端填哪个地址"（用户 2026-09-15 要求）：
 * 按钮上写**客户端方言的名字**（右上角横着放得下，就写全），点一下复制完整 URL。
 * 路径与适用客户端写在 title 里（用户要求：多写点也没事）。
 */
function renderEndpoints() {
  const box = $('#endpoints');
  if (!box) return;
  box.textContent = '';
  const origin = location.origin;
  const entries = [
    [
      '/openai',
      'OpenAI (支持Responses)',
      'OpenAI 方言：chat/completions 与 responses 两个端点都走这个地址（OpenAI SDK、新版 SDK 默认的 Responses、Cherry Studio 这类能填自定义 OpenAI 地址的工具）。models、usage 也在它下面。',
    ],
    [
      '/anthropic',
      'Anthropic',
      'Anthropic 方言：messages 端点走这个地址（Claude Code、Anthropic SDK）。models 同样在它下面，模型名和 OpenAI 那边是同一套。',
    ],
  ];
  for (const [path, label, tip] of entries) {
    box.appendChild(
      h('button', {
        type: 'button',
        text: label,
        title: `${tip}\n\nURL：${origin}${path}\n（点一下复制）`,
        onclick: async () => {
          const url = `${origin}${path}`;
          const ok = await copyText(url);
          alert(ok ? `已复制 ${label}：\n${url}` : `浏览器不让自动复制（可能是 http 访问）：\n${url}`);
        },
      })
    );
  }
  // 标签放到按钮**右边**（用户 2026-09-15）：这样它正好把"客户端地址"和「退出」隔开，
  // 免得两个都像按钮、手一滑点到退出
  box.appendChild(h('span', { class: 'endpoints-label', text: '客户端地址' }));
}

function showApp() {
  $('#login-view').hidden = true;
  $('#setup-view').hidden = true;
  $('#app-view').hidden = false;
  switchTab('overview');
  renderEndpoints();
  // 上游协议清单（「提供商」表单的下拉框用它）。拿不到就用内置兜底那份，界面不受影响
  api('/adapters')
    .then((res) => {
      ADAPTER_LIST = (res && res.adapters) || [];
    })
    .catch(() => {
      ADAPTER_LIST = [];
    });
}

$('#setup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('#setup-error');
  error.textContent = '';
  const input = $('#setup-access-key');
  // 沿用现有口令时这个字段干脆不发（后端：留空 = 保持原样，不会顺手换掉）
  const accessKey = setupKeyState.keeps && input.readOnly ? undefined : input.value.trim() || (setupKeyState.keeps ? randomAccessKey() : '');
  try {
    const result = await api('/setup', {
      method: 'POST',
      body: { adminPassword: $('#setup-password').value, accessKey },
    });
    $('#setup-password').value = '';
    // 三种情况要说清（原来只分"改没改"，于是把"新生成"说成"沿用原来的"）：
    //   changed   用户自己填了口令
    //   generated 留空 + 库里本来没有 → 自动生成了一条
    //   kept      留空 + 库里本来就有 → 真的沿用了
    const action = result.accessKeyAction || (result.accessKeyChanged ? 'changed' : 'kept');
    const keyLabel =
      action === 'generated'
        ? '已自动生成一条下游 apikey：'
        : action === 'changed'
          ? '新的下游请求 apikey：'
          : '下游 apikey 沿用原来的：';
    const copied = result.accessKey ? await copyText(result.accessKey) : false;
    const lines = ['设置完成。'];
    if (result.accessKey) {
      lines.push(
        '',
        keyLabel,
        result.accessKey,
        '',
        copied ? '（已复制到剪贴板；之后可在「密码」页查看或更改）' : '（复制失败，请手动抄下来；之后可在「密码」页查看或更改）'
      );
    } else {
      lines.push('', `下游 apikey 沿用原来的（${result.accessKeyMasked || 'sk-********'}）——这条是早期版本建的，看不到明文；要换就在「密码」页点「更改 apikey」。`);
    }
    alert(lines.join('\n'));
    showApp();
  } catch (err) {
    error.textContent = err.message;
    const status = await api('/setup/status').catch(() => null);
    if (status && !status.needsSetup) showLogin();
  }
});

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#login-error').textContent = '';
  if (typeof window.__diag === 'function') window.__diag('正在提交登录请求…');
  try {
    await api('/login', { method: 'POST', body: { password: $('#login-password').value } });
    $('#login-password').value = '';
    if (typeof window.__diag === 'function') window.__diag('登录成功，正在进入后台…');
    showApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
    if (typeof window.__diag === 'function') window.__diag(`登录请求失败：${err.message}`);
    if (typeof window.__report === 'function') {
      window.__report('登录失败', { message: err.message, status: err.status || null });
    }
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  showLogin();
});

$$('#tabs button').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('main > section').forEach((section) => {
    section.hidden = section.id !== `tab-${tab}`;
  });
  const renderers = {
    overview: renderOverview,
    'all-order': renderAllOrder,
    groups: renderModelGroups,
    providers: renderProviders,
    password: renderPasswords,
    logs: renderLogs,
    settings: renderSettings,
  };
  if (renderers[tab]) {
    renderers[tab]().catch((err) => {
      if (typeof window.__report === 'function') {
        window.__report('页面渲染失败', { message: `tab=${tab} → ${err.message}`, stack: err.stack });
      }
      alert(`「${tab}」页渲染失败：${err.message}`);
    });
  }
}

/* ------------------------------------------------------------------ 主页 */

let providerStates = {};
let providerRates = {};
let providerById = {};

/** 各页都要用到的一份"提供商运行时状态"（倒计时/状态徽标/速率列） */
function loadProviderMaps(overview) {
  providerStates = {};
  providerRates = {};
  providerById = {};
  for (const item of overview.providers) {
    providerStates[item.id] = item.state;
    providerRates[item.id] = item.rate || [];
    providerById[item.id] = item;
  }
}

async function renderOverview() {
  const overview = await api('/overview');
  loadProviderMaps(overview);

  const container = $('#tab-overview');
  container.textContent = '';

  // 概览卡：只放"今天过得怎么样"这类会变的数据（今日数据按**服务器本地时区**算，所以把时区标出来）
  const stats = overview.stats || {};
  const models = stats.modelStats || { available: 0, total: 0, cooling: 0, erroring: 0, disabled: 0 };
  // token 卡片的主值/副行都用紧凑写法（46.4k / 6.8m），精确数字放悬停提示里
  const tz = stats.tzLabel ? ` · ${stats.tzLabel}` : '';
  const tokenCard = (label, pack) => {
    const p = (pack && pack.prompt) || 0;
    const c = (pack && pack.completion) || 0;
    return statCard(
      label,
      fmtTokens(p + c),
      `输入 ${fmtTokens(p)} · 输出 ${fmtTokens(c)}`,
      `输入 ${fmtNum(p)} · 输出 ${fmtNum(c)} · 共 ${fmtNum(p + c)} tokens`
    );
  };

  container.appendChild(
    h('div', { class: 'panel' }, [
      h('div', { class: 'grid' }, [
        statCard(`今日请求${tz}`, fmtNum(stats.requestsToday), `失败 ${fmtNum(stats.failuresToday)} 次`, '按后台「设置」里的时区切自然日（默认 UTC），和 rpd/tpd 日额度的重置同一个零点'),
        tokenCard('免费 token（今日）', stats.freeTokens),
        tokenCard('付费 token（今日）', stats.paidTokens),
        statCard(
          '可用模型',
          `${models.available} / ${models.total}`,
          `冷却中 ${models.cooling} · 故障 ${models.erroring} · 已禁用 ${models.disabled}`,
          '冷却中/额度用尽/限速中的都算可用（它们会自己恢复）；「故障（需人工）」不算'
        ),
      ]),
    ])
  );

  const logRows = overview.recentLogs.map((log) => {
    const tok = fmtTokenPair(log.promptTokens, log.completionTokens);
    return h('tr', {}, [
      h('td', { class: 'small mono', text: fmtTime(log.ts) }),
      // 后端把请求模型拆好了：「请求模型」只显示模型本身，「来源」显示 Pay/<来源id>（付费）或 Free/<来源id>
      h('td', { text: log.modelName || log.requestModel || log.realModel || '-' }),
      h('td', { text: log.sourceLabel || log.providerId || '-' }),
      h('td', {}, [logBadge(log)]),
      h('td', { class: 'small mono', text: tok.text, title: tok.title }),
      h('td', { text: log.ttfbMs ? `${log.ttfbMs}ms` : log.latencyMs ? `${log.latencyMs}ms` : '-' }),
      h('td', { class: 'small', text: log.isStream ? '流式' : '整包' }),
      h('td', { class: 'small muted', text: log.errorType || '' }),
    ]);
  });
  container.appendChild(
    h('div', { class: 'panel' }, [
      h('h2', { text: '最近调用（30 条）' }),
      table(['时间', '请求模型', '命中的来源', '结果', 'token（入/出）', '首字节', '模式', '错误类型'], logRows),
    ])
  );
  startCountdownTicker();
}

/* -------------------------------------------------- All 模型顺序 */

/** 下游填 `All` 时按这里的顺序选源（免费区在上、付费兜底在下，两区不能交叉拖） */
async function renderAllOrder() {
  const [overview, models] = await Promise.all([api('/overview'), api('/models')]);
  loadProviderMaps(overview);

  const container = $('#tab-all-order');
  container.textContent = '';
  container.appendChild(
    h('div', { class: 'panel' }, [
      h('h2', { text: 'All 的选源顺序（拖拽排序：越靠上越优先）' }),
      h('p', {
        class: 'hint',
        text: '下游填 All 就按这个顺序试：靠上的先来，免费区用完了才轮到付费区。',
      }),
      modelGroup('免费', 'model-group-free', models.filter((m) => !m.isPaid)),
      modelGroup('付费兜底', 'model-group-paid', models.filter((m) => m.isPaid)),
      models.length === 0
        ? h('p', { class: 'hint', text: '还没有模型：先去「提供商」页添加一个来源。' })
        : null,
    ])
  );
  startCountdownTicker();
}

/**
 * 主页模型表的列宽（免费表 / 付费表**共用同一套**）。
 * 两段是两张独立的 <table>，浏览器默认按各自内容分配列宽，"内容一样但列对不齐"
 * 就是这么来的；这里用固定布局 + 同一套 colgroup 把它们钉死。
 * 只有「模型」列留空 = 自适应：它吃掉剩下的宽度，名字长了就在自己这一列里换行，
 * 不会把右边的状态/速率/操作挤来挤去。
 */
const MODEL_TABLE_COLS = [
  '44px', // 拖拽手柄
  '', // 模型（自适应 + 换行）
  '200px', // 倒计时
  '150px', // 来源
  '76px', // 状态
  '150px', // 速率
  '92px', // 操作
];

function modelGroup(title, groupId, list) {
  const tbody = h('tbody', {}, list.map((m) => modelEntryRow(m)));
  const tbl = h('table', { class: 'model-table' }, [
    h(
      'colgroup',
      {},
      MODEL_TABLE_COLS.map((width) => h('col', width ? { style: `width:${width}` } : {}))
    ),
    h('thead', {}, [
      h('tr', {}, ['', '模型', '倒计时', '来源', '状态', '速率', '操作'].map((t) => h('th', { text: t }))),
    ]),
    tbody,
  ]);
  attachModelDragReorder(tbody);
  return h('div', { id: groupId }, [h('h3', { text: `${title}（${list.length}）` }), h('div', { class: 'table-scroll' }, [tbl])]);
}

/** 模型名旁边的小标记：这个模型标了「支持图片理解」 */
function visionBadge(model) {
  if (!model || !model.supportsVision) return null;
  return h('span', { class: 'badge blue', text: '图片', title: '标了「支持图片理解」：带图片的请求会走它' });
}

/**
 * 「图片」开关（提供商弹层的模型列表里）：能不能看图片由用户自己标，
 * 因为上游不会告诉我们，而且默认标成"能看"会让图片被静默丢掉（见 src/protocol/faces/openai-chat.js 的说明）。
 *
 * 用**滑动开关**（不是按钮）：一眼能看出"这里可以点"，而且当前状态就写在开关位置上
 * （用户 2026-09-15 的反馈：原来那个按钮长得像状态标签，不知道能点）。
 * 顺带一个隐患也一起躲了：这个弹层是一个 <form>，里面的 <button> 不写 type 就默认是
 * submit —— 原来点一下"图片"会把整个提供者表单提交掉，窗口就关了。
 * checkbox 不参与表单提交，天然没这个问题。
 */
function visionToggle(model, onDone) {
  const box = h('input', { type: 'checkbox', 'aria-label': '支持图片理解' });
  box.checked = !!model.supportsVision;
  box.addEventListener('change', async () => {
    box.disabled = true;
    try {
      await api(`/models/${model.id}`, { method: 'PATCH', body: { supportsVision: box.checked } });
      await onDone();
    } catch (err) {
      box.checked = !box.checked; // 改回去，别让界面显示一个没保存成功的状态
      box.disabled = false;
      alert(err.message);
    }
  });
  return h(
    'label',
    {
      class: 'switch',
      title: model.supportsVision
        ? '开：带图片的请求会走这个模型。点一下关掉'
        : '关：带图片的请求不会走它。点一下打开',
    },
    [box, h('span', { class: 'switch-track' }, [h('span', { class: 'switch-knob' })])]
  );
}

function modelEntryRow(m) {
  const provider = providerById[m.providerId] || {};
  // 下游要用的完整模型名（后端按 naming 规则算好：Free/<来源id>/<模型名> 或 Pay/…）
  const publishedId = m.publishedId || `${m.providerId}/${m.modelId}`;
  return h('tr', { draggable: 'true', dataset: { id: String(m.id) }, class: 'draggable-row' }, [
    h('td', { class: 'drag-handle', text: '⠿' }),
    h('td', { class: 'wrap' }, [
      h('strong', { class: m.enabled ? 'mono' : 'mono struck', text: publishedId }),
      visionBadge(m),
    ]),
    countdownCell(m),
    h('td', { class: 'small wrap', text: m.providerName || m.providerId }),
    h('td', {}, [runtimeBadge(m)]),
    h('td', { class: 'mono small wrap', text: rateSummaryFrom(providerRates[m.providerId], provider.rateLimits) }),
    h('td', {}, [modelTestButton(m.providerId, m, refreshCurrentTab)]),
  ]);
}

/** 模型条目拖拽：免费区 / 付费区各自拖，松手后把两区合并成完整顺序提交 */
function attachModelDragReorder(tbody) {
  enableRowDrag(tbody, async () => {
    const idsIn = (selector) => $$(`${selector} tbody tr[data-id]`).map((r) => r.dataset.id);
    const orderedIds = [...idsIn('#model-group-free'), ...idsIn('#model-group-paid')];
    try {
      await api('/models/reorder', { method: 'POST', body: { orderedIds } });
    } catch (err) {
      alert(err.message);
    }
    renderAllOrder();
  });
}

/** 行拖拽的通用实现：tbody 里的 tr 互相换位，松手时把新顺序交给 onDrop */
function enableRowDrag(tbody, onDrop) {
  let dragId = null;
  for (const row of $$('tr[draggable]', tbody)) {
    row.addEventListener('dragstart', (event) => {
      dragId = row.dataset.id;
      window.__dragging = true; // 拖拽期间暂停"每 10 秒校准"的自动重绘
      row.classList.add('dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', dragId);
      }
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      dragId = null;
      window.__dragging = false;
    });
    row.addEventListener('dragover', (event) => {
      event.preventDefault();
      const target = event.currentTarget;
      if (!dragId || target.dataset.id === dragId) return;
      const dragged = $(`tr[data-id="${dragId}"]`, tbody);
      if (!dragged) return;
      const rect = target.getBoundingClientRect();
      if (event.clientY > rect.top + rect.height / 2) target.after(dragged);
      else target.before(dragged);
    });
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      const orderedIds = $$('tr[data-id]', tbody).map((r) => r.dataset.id);
      onDrop(orderedIds);
    });
  }
}

function statCard(label, value, sub, title) {
  return h('div', { title: title || null }, [
    h('div', { class: 'muted small', text: label }),
    h('div', { class: 'stat-value', text: String(value) }),
    sub ? h('div', { class: 'muted small', text: sub }) : null,
  ]);
}

/** 大数字加千分位（要精确值时用，比如悬停提示、请求次数） */
function fmtNum(value) {
  const n = Number(value) || 0;
  return n.toLocaleString('zh-CN');
}

/**
 * token 用量：够 1000 就用 `46.4k`、够 100 万用 `6.8m`（用户 2026-09-12 指定的写法）。
 * 表格和卡片上位置有限，精确数字放 title 里，鼠标悬停就能看到。
 */
function fmtTokens(value) {
  const n = Math.round(Number(value) || 0);
  if (n < 1000) return String(n);
  let unit = 1000;
  let suffix = 'k';
  // 逐级升单位，避免出现 "1000.0k" 这种（999950 应该写成 1.0m）
  while (n / unit >= 999.95 && unit < 1e9) {
    unit *= 1000;
    suffix = unit === 1e6 ? 'm' : 'b';
  }
  return `${(n / unit).toFixed(1)}${suffix}`;
}

/**
 * 本次请求用了多少 token，表格里那一格的写法：「入 / 出」。
 * 上游没报 usage 时两边都是 null → 显示 `-`（不是 0：0 是"真没用"，- 是"上游没说"，
 * 这两件事在排查问题时完全不一样，不能混）。鼠标悬停给出精确数字。
 */
function fmtTokenPair(prompt, completion) {
  const toNum = (v) => (v === null || v === undefined ? null : Number(v));
  const p = toNum(prompt);
  const c = toNum(completion);
  if (p === null && c === null) {
    return { text: '-', title: '上游没返回 usage，这次用量没法统计' };
  }
  const one = (n) => (n === null ? '-' : fmtTokens(n));
  const total = (p || 0) + (c || 0);
  return {
    text: `${one(p)} / ${one(c)}`,
    title: `输入 ${p === null ? '-' : fmtNum(p)} · 输出 ${c === null ? '-' : fmtNum(c)} · 共 ${fmtNum(total)} tokens`,
  };
}

function statusBadge(state) {
  if (!state || !state.status) return h('span', { class: 'badge', text: '未知' });
  if (state.status === 'available') return h('span', { class: 'badge ok', text: '可用' });
  if (state.status === 'cooldown') {
    return h('span', { class: 'badge warn', text: `冷却中 ${state.cooldownRemainingSeconds || 0}s` });
  }
  return h('span', { class: 'badge err', text: STATUS_LABELS[state.status] || state.status });
}

/** 提供商行：[x/x 模型可用]（限速/故障/手动禁用都算不可用） */
function providerStatusCell(p) {
  const state = p.state || {};
  const total = state.modelsTotal || 0;
  const available = state.modelsAvailable || 0;
  const suffix =
    state.health === 'ok'
      ? h('span', { class: 'ok-text', text: `[${available}/${total} 模型可用]` })
      : state.health === 'partial'
        ? h('span', { class: 'field-hint', text: `[${available}/${total} 模型可用]` })
        : total === 0
          ? h('span', { class: 'muted small', text: '无模型' })
          : h('span', { class: 'error-text', text: `[${available}/${total} 模型可用]` });
  return h('div', { class: 'row' }, [
    p.enabled ? null : h('span', { class: 'badge', text: '来源已禁用' }),
    suffix,
  ]);
}

function logBadge(log) {
  if (log.status === 'ok') return h('span', { class: 'badge ok', text: '成功' });
  if (log.status === 'fallback') return h('span', { class: 'badge warn', text: '换源成功' });
  return h('span', { class: 'badge err', text: '失败' });
}

/* --------------------------------------------------------------- 模型组 */

/** 组内模型表的列宽（和「All模型顺序」那套一样钉死，避免每组表头对不齐） */
const GROUP_TABLE_COLS = [
  '44px', // 拖拽手柄
  '', // 模型（自适应 + 换行）
  '180px', // 来源
  '90px', // 状态
  '76px', // 操作
];

/** 哪些组是展开的（重绘后保持原样，不然加/删一个模型就把组收起来了） */
const expandedGroups = {};

/**
 * 模型组页：最上面是「＋ 添加模型组」（固定在列表上方，组多了也不会被挤到下面去），
 * 下面每组一行 [组名输入框][箭头]，箭头点开展开组内配置。
 * 组名随手改、失焦即存（没有"保存"按钮）；组内可加/删模型、拖拽排序。
 */
async function renderModelGroups() {
  const [groups, models, overview] = await Promise.all([api('/model-groups'), api('/models'), api('/overview')]);
  loadProviderMaps(overview);
  const modelById = new Map(models.map((m) => [m.id, m]));

  const container = $('#tab-groups');
  container.textContent = '';

  const list = h('div', { id: 'group-list' });
  container.appendChild(
    h('div', { class: 'panel' }, [
      h('div', { class: 'row' }, [
        h('h2', { style: 'margin:0', text: '模型组' }),
        h('div', { class: 'spacer' }),
        h('button', {
          type: 'button',
          class: 'primary',
          text: '＋ 添加模型组',
          onclick: async () => {
            try {
              const created = await api('/model-groups', { method: 'POST', body: {} });
              expandedGroups[created.id] = true; // 新建的直接展开，省一次点击
              await renderModelGroups();
            } catch (err) {
              alert(err.message);
            }
          },
        }),
      ]),
      h('p', {
        class: 'hint',
        text: '下游填 ModelGroup/<组名> 就按组内顺序试源，免费和付费可以混着排；组名随手改，不用保存。',
      }),
      groups.length === 0
        ? h('p', { class: 'hint', text: '还没有模型组 —— 点上面的「＋ 添加模型组」。' })
        : list,
    ])
  );

  for (const group of groups) list.appendChild(groupPanel(group, models, modelById));
}

function groupPanel(group, allModels, modelById) {
  const open = Boolean(expandedGroups[group.id]);
  const published = h('span', { class: 'muted mono small', text: group.publishedId });

  const nameInput = h('input', { class: 'group-name', value: group.name, placeholder: '组名', title: '随手改，失焦即存' });
  nameInput.addEventListener('input', () => {
    published.textContent = `ModelGroup/${nameInput.value.trim() || '…'}`;
  });
  nameInput.addEventListener('change', async () => {
    const next = nameInput.value.trim();
    const restore = () => {
      nameInput.value = group.name;
      published.textContent = group.publishedId;
    };
    if (!next || next === group.name) return restore();
    try {
      const updated = await api(`/model-groups/${group.id}`, { method: 'PATCH', body: { name: next } });
      group.name = updated.name;
      group.publishedId = updated.publishedId;
      nameInput.value = updated.name;
      published.textContent = updated.publishedId;
    } catch (err) {
      alert(err.message);
      restore();
    }
  });
  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') nameInput.blur(); // 回车 = 收工，change 照样会触发
  });

  const body = h('div', { class: 'group-body', hidden: open ? null : 'hidden' }, [
    groupItemsTable(group, modelById),
    groupAddRow(group, allModels),
  ]);

  const arrow = h('button', { type: 'button', class: 'tiny group-arrow', text: open ? '▾' : '▸', title: '展开/收起' });
  arrow.addEventListener('click', () => {
    body.hidden = !body.hidden;
    arrow.textContent = body.hidden ? '▸' : '▾';
    expandedGroups[group.id] = !body.hidden;
  });

  return h('div', { class: 'group-box' }, [
    h('div', { class: 'group-head' }, [
      nameInput,
      arrow,
      published,
      h('div', { class: 'spacer' }),
      h('span', { class: 'muted small', text: `${group.items.length} 个模型` }),
      h('button', {
        type: 'button',
        class: 'tiny danger',
        text: '删除该组',
        onclick: async () => {
          if (!confirm(`删除模型组「${group.name}」？（组里的模型本身不受影响）`)) return;
          try {
            await api(`/model-groups/${group.id}`, { method: 'DELETE' });
            delete expandedGroups[group.id];
            await renderModelGroups();
          } catch (err) {
            alert(err.message);
          }
        },
      }),
    ]),
    body,
  ]);
}

function groupItemsTable(group, modelById) {
  const tbody = h('tbody', {}, group.items.map((item) => groupItemRow(group, item, modelById)));
  const tbl = h('table', { class: 'model-table' }, [
    h(
      'colgroup',
      {},
      GROUP_TABLE_COLS.map((width) => h('col', width ? { style: `width:${width}` } : {}))
    ),
    h('thead', {}, [h('tr', {}, ['', '模型', '来源', '状态', '操作'].map((t) => h('th', { text: t })))]),
    tbody,
  ]);
  enableRowDrag(tbody, async (orderedIds) => {
    try {
      await api(`/model-groups/${group.id}/reorder`, { method: 'POST', body: { orderedIds } });
    } catch (err) {
      alert(err.message);
    }
    renderModelGroups();
  });
  const empty = group.items.length === 0 ? h('p', { class: 'hint', text: '组里还没有模型。' }) : null;
  return h('div', {}, [empty, group.items.length ? h('div', { class: 'table-scroll' }, [tbl]) : null]);
}

function groupItemRow(group, item, modelById) {
  const model = modelById.get(item.providerModelId);
  return h('tr', { draggable: 'true', dataset: { id: String(item.id) }, class: 'draggable-row' }, [
    h('td', { class: 'drag-handle', text: '⠿' }),
    h('td', { class: 'wrap' }, [
      h('strong', { class: 'mono', text: item.publishedId }),
      visionBadge(item),
    ]),
    h('td', { class: 'small wrap', text: item.providerName || item.providerId }),
    h('td', {}, [model ? runtimeBadge(model) : h('span', { class: 'muted small', text: '已删除' })]),
    h('td', {}, [
      h('button', {
        type: 'button',
        class: 'tiny danger',
        text: '删除',
        onclick: async () => {
          try {
            await api(`/model-groups/${group.id}/items/${item.id}`, { method: 'DELETE' });
            await renderModelGroups();
          } catch (err) {
            alert(err.message);
          }
        },
      }),
    ]),
  ]);
}

function groupAddRow(group, allModels) {
  const inGroup = new Set(group.items.map((item) => item.providerModelId));
  const candidates = allModels.filter((m) => !inGroup.has(m.id));
  if (candidates.length === 0) {
    return h('p', { class: 'hint', text: '所有模型都已经在这个组里了。' });
  }
  const select = h(
    'select',
    {},
    candidates.map((m) =>
      h('option', {
        value: String(m.id),
        text: `${m.enabled ? m.publishedId : `${m.publishedId}（已禁用）`}${m.supportsVision ? ' · 支持图片' : ''}`,
      })
    )
  );
  const add = h('button', {
    type: 'button',
    text: '＋ 添加这个模型',
    onclick: async () => {
      try {
        await api(`/model-groups/${group.id}/items`, {
          method: 'POST',
          body: { providerModelId: Number(select.value) },
        });
        await renderModelGroups();
      } catch (err) {
        alert(err.message);
      }
    },
  });
  return h('div', { class: 'row group-add' }, [select, add]);
}

/* --------------------------------------------------------------- 提供商 */

let providerCache = [];

async function renderProviders() {
  const [providers, overview] = await Promise.all([api('/providers'), api('/overview')]);
  providerCache = providers;
  providerStates = {};
  providerRates = {};
  providerById = {};
  for (const item of overview.providers) {
    providerStates[item.id] = item.state;
    providerRates[item.id] = item.rate || [];
    providerById[item.id] = item;
  }

  const container = $('#tab-providers');
  container.textContent = '';

  container.appendChild(
    h('div', { class: 'panel' }, [
      h('div', { class: 'row' }, [
        h('h2', { style: 'margin:0', text: '提供商' }),
        h('div', { class: 'spacer' }),
        h('button', { type: 'button', class: 'primary', text: '＋ 添加提供商', onclick: () => openProviderModal(null) }),
      ]),
      h('p', {
        class: 'hint',
        text: '模型和优先级在「主页」里管；这里管来源本身的配置。',
      }),
      table(
        ['提供商', '状态', '速率', '策略', '操作'],
        providers.map((p) => providerRow(p))
      ),
    ])
  );
}

function rateSummaryFrom(snapshot, limits) {
  const list = limits || [];
  if (!list.length) return '不限制';
  if (Array.isArray(snapshot) && snapshot.length) {
    return snapshot
      .map((item) => {
        if (item.mode === 'concurrency') return `${item.kind}=${item.value}（在途 ${item.active || 0}）`;
        // "还有几秒可发"已经有倒计时那一列在显示了，这里不再重复
        if (item.mode === 'pace') return `${item.kind}=${item.value}`;
        return `${item.kind}=${item.value}（已用 ${item.used || 0}/${item.value}）`;
      })
      .join(' · ');
  }
  return list.map((item) => `${item.kind}=${item.value}`).join(' · ');
}

function rateSummary(p) {
  return rateSummaryFrom(providerRates[p.id], p.rateLimits);
}

function providerRow(p) {
  const state = providerStates[p.id];
  return h('tr', {}, [
    h('td', { class: 'wrap' }, [
      h('div', { class: 'row' }, [
        h('strong', { text: p.name }),
        p.isPaid ? h('span', { class: 'badge paid', text: '付费' }) : h('span', { class: 'badge', text: '免费' }),
      ]),
      h('div', { class: 'muted small mono url-cell', text: `${p.id} · ${p.baseUrl}` }),
      p.hasApiKey ? null : h('div', { class: 'error-text small', text: '未配置 apiKey' }),
    ]),
    h('td', {}, [providerStatusCell(p)]),
    h('td', { class: 'mono small', text: rateSummary(p) }),
    h('td', { class: 'small', text: REJECT_POLICY_SHORT[p.rejectPolicy] || p.rejectPolicy }),
    h('td', {}, [
      h('div', { class: 'row' }, [
        h('button', { class: 'tiny', text: '编辑', onclick: () => openProviderModal(p) }),
        h('button', {
          type: 'button',
          class: 'tiny',
          text: '立即探测',
          onclick: async (event) => {
            event.target.disabled = true;
            try {
              const result = await api(`/providers/${p.id}/probe`, { method: 'POST', body: {} });
              alert(
                result.ok
                  ? `探测成功：${result.latencyMs}ms，已恢复可用`
                  : `探测未通过：${result.reason || '未知原因'}\n状态：${result.state ? result.state.status : '-'}`
              );
              renderProviders();
            } catch (err) {
              alert(err.message);
            } finally {
              event.target.disabled = false;
            }
          },
        }),
        p.enabled && state && state.status !== 'available'
          ? h('button', {
            type: 'button',
              class: 'tiny',
              text: '恢复可用',
              onclick: async () => {
                try {
                  await api(`/providers/${p.id}/state`, { method: 'POST', body: { status: 'available' } });
                  renderProviders();
                } catch (err) {
                  alert(err.message);
                }
              },
            })
          : null,
        h('button', {
          type: 'button',
          class: 'tiny danger',
          text: '删除',
          onclick: async () => {
            if (!confirm(`确定删除提供商「${p.name}」？它的模型配置会一并删除。`)) return;
            try {
              await api(`/providers/${p.id}`, { method: 'DELETE' });
              renderProviders();
            } catch (err) {
              alert(err.message);
            }
          },
        }),
      ]),
    ]),
  ]);
}

/* --------------------------------------------------------------- 表单 */

/* --------------------------------------------------- 提供商编辑弹层 */

let providerModal = null;

function closeProviderModal() {
  if (providerModal) {
    providerModal.remove();
    providerModal = null;
  }
  document.removeEventListener('keydown', escCloseProviderModal);
}

function escCloseProviderModal(event) {
  if (event.key === 'Escape') closeProviderModal();
}

function openProviderModal(provider) {
  const isEdit = !!provider;
  closeProviderModal();

  const idInput = h('input', {
    placeholder: 'nvidia-nim',
    value: isEdit ? provider.id : '',
    disabled: isEdit ? 'disabled' : null,
  });
  const nameInput = h('input', { placeholder: 'NVIDIA NIM', value: isEdit ? provider.name : '' });
  const baseUrlInput = h('input', {
    placeholder: 'https://integrate.api.nvidia.com/v1',
    value: isEdit ? provider.baseUrl : '',
  });
  const apiKeyInput = h('input', { type: 'password', placeholder: '留空则不变' });
  const apiKeyLabel = isEdit && provider.hasApiKey ? `apiKey（已保存 ${provider.apiKeyMasked}）` : 'apiKey';

  const adapterSelect = selectOf(
    adapterOptions(),
    isEdit ? provider.adapter : 'openai-compatible'
  );
  const accountIdInput = h('input', {
    placeholder: 'Cloudflare 账号 ID（32 位十六进制）',
    value: isEdit ? provider.accountId || '' : '',
  });
  const accountIdField = h('label', { class: 'block span-3' }, [
    h('span', { text: '账号 ID（Cloudflare Workers AI 专用）' }),
    accountIdInput,
  ]);
  const isPaidInput = h('input', { type: 'checkbox' });
  isPaidInput.checked = isEdit ? provider.isPaid : false;
  const enabledInput = h('input', { type: 'checkbox' });
  enabledInput.checked = isEdit ? provider.enabled : true;

  const rateValue = isEdit && provider.rateLimits && provider.rateLimits[0] ? provider.rateLimits[0].value : '';
  const rateInput = h('input', {
    type: 'number',
    min: '0',
    placeholder: '40（填 0 = 不做本地限制）',
    value: rateValue === '' || rateValue === undefined ? '' : String(rateValue),
  });
  const rateHint = h('p', {
    class: 'field-hint',
    text: '⚠️ 免费来源填 0：不做本地限速，会被反复优先选用，容易撞限流。',
  });

  const policySelect = selectOf(REJECT_POLICY_LABELS, isEdit ? provider.rejectPolicy : 'cooldown_probe');
  const policyHint = h('p', {
    class: 'field-hint',
    text: '⚠️ 免费来源选「不停用」：失败也不停用，下次还会选到它、反复撞错。',
  });

  // 免费 + 不停用 → 提示；其余留空
  function refreshHints() {
    const isFree = !isPaidInput.checked;
    const policy = policySelect.value;
    rateHint.hidden = !(isFree && String(rateInput.value).trim() === '0');
    policyHint.hidden = !(isFree && policy === 'keep_trying');

    // 适配器相关：需要账号 ID 的协议才显示那一格；baseUrl 占位符跟着变
    const meta = adapterMeta(adapterSelect.value);
    accountIdField.hidden = !meta.needsAccountId;
    baseUrlInput.placeholder = meta.baseUrlHint || '';
    // 新建时切到自带固定地址的协议（如 Cloudflare），自动把 baseUrl 填好
    if (!isEdit && meta.defaultBaseUrl && !String(baseUrlInput.value).trim()) {
      baseUrlInput.value = meta.defaultBaseUrl;
    }
  }
  isPaidInput.addEventListener('change', refreshHints);
  rateInput.addEventListener('input', refreshHints);
  policySelect.addEventListener('change', refreshHints);
  adapterSelect.addEventListener('change', refreshHints);
  refreshHints();

  const modelSection = isEdit
    ? h('div', { class: 'model-section' }, [h('h3', { text: '模型' }), h('p', { class: 'hint', text: '加载中…' })])
    : null;

  const form = h('form', { class: 'modal' }, [
    h('h2', { style: 'margin-bottom:14px', text: isEdit ? `编辑提供商：${provider.name}` : '添加提供商' }),
    // 三列栅格：
    //   第一行: id | 名称 | baseUrl
    //   第二行: apiKey | 适配器（占中间+右边两格，下面跟着该协议的提示）
    //   （Cloudflare 才显示）账号 ID，占整行
    //   第三行: 速率 | 上游拒绝策略 | 冷却秒数（或"不停用"提示）
    h('div', { class: 'grid grid-3' }, [
      h('label', { class: 'block' }, [h('span', { text: 'id（唯一标识，创建后不可改）' }), idInput]),
      h('label', { class: 'block' }, [h('span', { text: '名称' }), nameInput]),
      h('label', { class: 'block' }, [h('span', { text: 'baseUrl' }), baseUrlInput]),
      h('label', { class: 'block' }, [h('span', { text: apiKeyLabel }), apiKeyInput]),
      h('div', { class: 'span-2' }, [
        h('label', { class: 'block' }, [h('span', { text: '适配器（上游协议）' }), adapterSelect]),
      ]),
      accountIdField,
      h('label', { class: 'block' }, [h('span', { text: '速率：每分钟请求数（rpm）' }), rateInput]),
      h('label', { class: 'block' }, [h('span', { text: '上游拒绝时的策略' }), policySelect]),
      h('div', { class: 'block' }, [policyHint]),
      h('div', { class: 'span-3' }, [rateHint]),
    ]),
    h('div', { class: 'row modal-footer' }, [
      h('label', { class: 'inline' }, [isPaidInput, '付费来源']),
      h('label', { class: 'inline' }, [enabledInput, '启用']),
      h('div', { class: 'spacer' }),
      h('button', { type: 'button', text: '取消', onclick: closeProviderModal }),
      h('button', { class: 'primary', type: 'submit', text: isEdit ? '保存' : '添加' }),
    ]),
    modelSection,
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    // 只认"这个表单自己"的提交：模型区里还有个内层 form，它的 submit 会冒泡上来
    if (event.target !== form) return;
    const payload = {
      name: nameInput.value.trim(),
      baseUrl: baseUrlInput.value.trim(),
      adapter: adapterSelect.value,
      accountId: accountIdInput.value.trim(),
      isPaid: isPaidInput.checked,
      enabled: enabledInput.checked,
      rejectPolicy: policySelect.value,
      rateLimits:
        String(rateInput.value).trim() === '' ? [] : [{ kind: 'rpm', value: Number(rateInput.value) }],
    };
    if (apiKeyInput.value.trim() !== '') payload.apiKey = apiKeyInput.value.trim();
    try {
      if (isEdit) {
        await api(`/providers/${provider.id}`, { method: 'PATCH', body: payload });
      } else {
        payload.id = idInput.value.trim();
        await api('/providers', { method: 'POST', body: payload });
      }
      closeProviderModal();
      renderProviders();
    } catch (err) {
      alert(err.message);
    }
  });

  const backdrop = h(
    'div',
    {
      class: 'modal-backdrop',
      onclick: (event) => {
        if (event.target === backdrop) closeProviderModal();
      },
    },
    [form]
  );
  document.body.appendChild(backdrop);
  providerModal = backdrop;
  document.addEventListener('keydown', escCloseProviderModal);
  (isEdit ? nameInput : idInput).focus();
  if (modelSection) renderModalModelList(modelSection, provider);
}

function selectOf(labels, value) {
  const select = h('select', {});
  for (const [key, label] of Object.entries(labels)) {
    const option = h('option', { value: key, text: label });
    if (key === value) option.selected = true;
    select.appendChild(option);
  }
  return select;
}

/* --------------------------------------------------------------- 模型 */

/** 提供商弹层里的模型列表（模型多时内部滚动；每个模型显示自己的状态） */
async function renderModalModelList(section, provider) {
  let models = [];
  try {
    const all = await api('/models');
    models = all.filter((m) => m.providerId === provider.id);
  } catch (err) {
    models = [];
  }

  section.textContent = '';
  section.appendChild(h('h3', { text: `模型（${models.length}）` }));

  const modelIdInput = h('input', { placeholder: '上游真实模型 id，如 meta/llama-3.3-70b-instruct' });
  const addForm = h('form', { class: 'row' }, [
    modelIdInput,
    h('button', { class: 'tiny primary', type: 'submit', text: '添加模型' }),
  ]);
  addForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    // 这个内层 form 在外层「提供者表单」里面，而 submit 事件会冒泡 ——
    // 不拦住的话，点「添加模型」会把整个提供者表单也提交掉（保存 + 关窗口）。
    event.stopPropagation();
    try {
      await api(`/providers/${provider.id}/models`, {
        method: 'POST',
        body: { modelId: modelIdInput.value.trim() },
      });
      await renderModalModelList(section, provider);
    } catch (err) {
      alert(err.message);
    }
  });
  section.appendChild(addForm);

  const rows = models.map((m) =>
    h('tr', {}, [
      // 对外名字（下游要填的就是这个）
      h('td', { class: 'mono wrap' }, m.publishedId || m.modelId),
      h('td', { class: 'small wrap' }, m.modelId),
      h('td', {}, [visionToggle(m, () => renderModalModelList(section, provider))]),
      h('td', {}, [runtimeBadge(m)]),
      h('td', {}, [
        h('div', { class: 'row' }, [
          modelTestButton(provider.id, m, () => renderModalModelList(section, provider)),
          h('button', {
            type: 'button',
            class: 'tiny',
            text: m.enabled ? '禁用' : '启用',
            onclick: async () => {
              try {
                await api(`/models/${m.id}`, { method: 'PATCH', body: { enabled: !m.enabled } });
                await renderModalModelList(section, provider);
              } catch (err) {
                alert(err.message);
              }
            },
          }),
          h('button', {
            type: 'button',
            class: 'tiny danger',
            text: '删除',
            onclick: async () => {
              if (!confirm(`删除模型「${m.modelId}」？`)) return;
              try {
                await api(`/models/${m.id}`, { method: 'DELETE' });
                await renderModalModelList(section, provider);
              } catch (err) {
                alert(err.message);
              }
            },
          }),
        ]),
      ]),
    ])
  );

  if (models.length === 0) {
    section.appendChild(h('p', { class: 'hint', text: '还没有模型：用上面的输入框添加一个上游模型 id。' }));
  } else {
    section.appendChild(
      h('div', { class: 'model-list' }, [table(['对外模型名', '上游 model id', '图片', '状态', '操作'], rows)])
    );
  }
}

/* --------------------------------------------------------------- 密码 */

/**
 * 「密码」页（用户设计）：只有两块
 *   ① 后台管理密码  —— 固定一串 `*` + 「更改密码」按钮
 *      （库里现在存的是可逆密文，但界面照旧只让"改"、不给看：管理密码没必要天天抄出来）
 *   ② 下游请求 apikey —— `sk-******` 掩码 + 「复制」/「更改 apikey」（明文来自库里的密文，所以能复制）
 */

/** 复制到剪贴板：优先用 clipboard API，http 下（局域网 IP 访问）会失败就退回老办法 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    try {
      const box = h('textarea', { style: 'position:fixed;left:-1000px;top:0' });
      box.value = text;
      document.body.appendChild(box);
      box.select();
      const ok = document.execCommand('copy');
      box.remove();
      return ok;
    } catch (err2) {
      return false;
    }
  }
}

/**
 * 一个简单的"输入框 + 确认"弹窗（复用提供商弹层的样式与 ESC 关闭）。
 * @param {object} opts { title, hint, prefix, inputType, placeholder, submitText, onSubmit(value) }
 */
function openInputModal({ title, hint, prefix, inputType = 'text', placeholder = '', submitText = '确认更改', onSubmit }) {
  const input = h('input', { type: inputType, placeholder, autocomplete: 'off', class: 'pw-input' });
  const error = h('p', { class: 'error-text' });
  const submit = h('button', { class: 'primary', type: 'submit', text: submitText });

  const form = h('form', { class: 'modal' }, [
    h('h2', { style: 'margin-bottom:12px', text: title }),
    h('div', { class: 'row' }, [
      prefix ? h('span', { class: 'mono muted', text: prefix }) : null,
      input,
    ]),
    hint ? h('p', { class: 'hint', text: hint }) : null,
    error,
    h('div', { class: 'row modal-footer' }, [
      h('div', { class: 'spacer' }),
      h('button', { type: 'button', text: '取消', onclick: close }),
      submit,
    ]),
  ]);

  let backdrop = null;
  function onKey(event) {
    if (event.key === 'Escape') close();
  }
  function close() {
    if (backdrop) backdrop.remove();
    document.removeEventListener('keydown', onKey);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = '';
    try {
      await onSubmit(input.value);
      close();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  });

  backdrop = h(
    'div',
    {
      class: 'modal-backdrop',
      onclick: (event) => {
        if (event.target === backdrop) close();
      },
    },
    [form]
  );
  document.body.appendChild(backdrop);
  document.addEventListener('keydown', onKey);
  input.focus();
  return { close };
}

async function renderPasswords() {
  const [primary, me] = await Promise.all([api('/access-keys/primary'), api('/me')]);
  const container = $('#tab-password');
  container.textContent = '';

  // ① 后台管理密码
  const adminBox = h('input', { type: 'text', value: '**********', readonly: 'readonly', class: 'pw-input' });
  container.appendChild(
    h('div', { class: 'panel' }, [
      h('h2', { text: '后台管理密码' }),
      h('div', { class: 'row' }, [
        adminBox,
        h('button', {
          type: 'button',
          class: 'tiny',
          text: '更改密码',
          onclick: () =>
            openInputModal({
              title: '更改后台管理密码',
              hint: '至少 6 位；下次登录用它。',
              inputType: 'password',
              placeholder: '新密码',
              onSubmit: async (value) => {
                if (String(value).length < 6) throw new Error('新密码至少 6 位');
                await api('/settings/admin-password', { method: 'POST', body: { next: value } });
                alert('管理密码已更改');
              },
            }),
        }),
      ]),
      h('p', {
        class: 'hint',
        text: '密码不可显示，点右边按钮更换。',
      }),
    ])
  );

  // ② 下游请求 apikey
  const hasKey = Boolean(primary);
  const canDisplay = Boolean(primary && primary.key);
  const keyBox = h('input', {
    type: 'text',
    class: 'pw-input',
    value: !hasKey ? '（还没有设置）' : canDisplay ? primary.masked : '（这条口令已失效：解不开，请点「更改 apikey」生成新的）',
    readonly: 'readonly',
  });

  const copyBtn = h('button', {
    type: 'button',
    class: 'tiny',
    text: '复制',
    disabled: canDisplay ? null : 'disabled',
    onclick: async () => {
      const ok = await copyText(primary.key);
      alert(ok ? `已复制：\n${primary.key}` : `浏览器不让自动复制（可能是 http 访问）：\n${primary.key}`);
    },
  });

  const changeBtn = h('button', {
    type: 'button',
    class: 'tiny primary',
    text: '更改 apikey',
    onclick: () =>
      openInputModal({
        title: '更改下游请求 apikey',
        hint: '改完旧口令立即失效，记得同步改客户端配置。留空则自动生成。',
        prefix: 'sk-',
        placeholder: '后面这段随便写，或用自动生成的',
        onSubmit: async (value) => {
          const changed = await api('/access-keys/change', { method: 'POST', body: { key: value } });
          alert(`已更换。新的完整口令：\n${changed.plaintext}\n\n（${(await copyText(changed.plaintext)) ? '已复制到剪贴板' : '复制失败，请手动抄下来'}）`);
          await renderPasswords();
        },
      }),
  });

  container.appendChild(
    h('div', { class: 'panel' }, [
      h('h2', { text: '下游请求 apikey' }),
      h('div', { class: 'row' }, [keyBox, copyBtn, changeBtn]),
      h('p', {
        class: 'hint',
        text:
          '客户端用它调本网关（和上游的 apiKey 是两回事）。点「复制」填到客户端里。' +
          (hasKey && !canDisplay ? ' 这条已经解不开了（老版本的数据，或者 APP_SECRET 换过）—— 它现在也校验不过，点「更改 apikey」生成新的。' : ''),
      }),
      me.accessKeyCount === 0
        ? h('p', { class: 'error-text', text: '当前没有任何口令，/openai/* 会拒绝所有请求 —— 点「更改 apikey」设一个。' })
        : null,
    ])
  );

  // ③ 客户端地址（2.0.0 起按协议族分前缀，用户不用去猜该填哪个）
  const origin = location.origin;
  const endpoints = [
    ['OpenAI 方言', `${origin}/openai`, 'chat/completions、responses、models（OpenAI SDK、Cherry Studio、各种自定义 OpenAI 地址的工具）'],
    ['Anthropic 方言', `${origin}/anthropic`, 'messages、models（Claude Code、Anthropic SDK）'],
  ];
  const rows = endpoints.map(([label, url, hint]) => {
    const box = h('input', { type: 'text', class: 'pw-input', value: url, readonly: 'readonly' });
    return h('div', { class: 'block' }, [
      h('div', { class: 'row' }, [
        h('span', { class: 'muted small', style: 'min-width:110px', text: label }),
        box,
        h('button', {
          type: 'button',
          class: 'tiny',
          text: '复制',
          onclick: async () => {
            const ok = await copyText(url);
            alert(ok ? `已复制：\n${url}` : `浏览器不让自动复制（可能是 http 访问）：\n${url}`);
          },
        }),
      ]),
      h('p', { class: 'hint', text: `${hint}。地址里的 /v1 加不加都行。` }),
    ]);
  });
  container.appendChild(
    h('div', { class: 'panel' }, [
      h('h2', { text: '客户端填哪个地址' }),
      ...rows,
      h('p', {
        class: 'hint',
        text: '按客户端说的"方言"选一个就行 —— 和上游是哪家协议无关，网关自己翻。',
      }),
    ])
  );
}

/* --------------------------------------------------------------- 日志 */

async function renderLogs() {
  const logs = await api('/logs?limit=200');
  const container = $('#tab-logs');
  container.textContent = '';

  const rows = logs.map((log) => {
    const tok = fmtTokenPair(log.promptTokens, log.completionTokens);
    return h('tr', {}, [
      h('td', { class: 'small mono', text: fmtTime(log.ts) }),
      h('td', { text: log.modelName || log.requestModel || log.realModel || '-' }),
      h('td', { text: log.sourceLabel || log.providerId || '-' }),
      h('td', { class: 'mono small', text: log.realModel || '-' }),
      h('td', {}, [logBadge(log)]),
      h('td', { text: log.latencyMs ? `${log.latencyMs}ms` : '-' }),
      h('td', { class: 'small mono', text: tok.text, title: tok.title }),
      h('td', {
        class: 'small muted detail-cell',
        text: (log.errorType || '') + (log.detail ? ` · ${String(log.detail).slice(0, 120)}` : ''),
      }),
    ]);
  });

  container.appendChild(
    h('div', { class: 'panel' }, [
      h('h2', { text: `调用日志（最近 ${logs.length} 条）` }),
      table(['时间', '请求模型', '来源', '真实模型', '结果', '耗时', 'token（入/出）', '错误/详情'], rows),
    ])
  );
}

/* --------------------------------------------------------------- 设置 */

async function renderSettings() {
  const settings = await api('/settings');
  const container = $('#tab-settings');
  container.textContent = '';

  const allowNoKey = h('input', { type: 'checkbox' });
  allowNoKey.checked = settings.allow_no_key === 'true';
  const fakeEndpoints = h('input', { type: 'checkbox' });
  fakeEndpoints.checked = settings.fake_endpoints_enabled === 'true';
  const retention = h('input', { type: 'number', min: '1', value: settings.log_retention_days });
  const probeMax = h('input', { type: 'number', min: '0', value: settings.probe_max_attempts });
  const autoContext = h('input', { type: 'number', min: '0', placeholder: '256000', value: settings.auto_context_tokens });
  // 时区：应用自己的设置（不看操作系统、也不看 TZ 环境变量——很多 Linux 装完就是 UTC，用户并没意识到）
  const utcOffset = h('input', {
    type: 'number',
    min: '-12',
    max: '14',
    step: '0.5',
    placeholder: '0',
    value: settings.utc_offset_hours === undefined ? '0' : settings.utc_offset_hours,
  });

  // 倒计时探测的等待时长（退避表）：第 N 行 = 第 N 次探测之前等多少秒，最后一行带"+ 后续"
  let backoffValues = (() => {
    try {
      const parsed = JSON.parse(settings.probe_backoff_seconds || '[]');
      const arr = Array.isArray(parsed)
        ? parsed.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
        : [];
      return arr.length ? arr : [15, 60, 300];
    } catch (err) {
      return [15, 60, 300];
    }
  })();
  const backoffList = h('div', { class: 'backoff-list' });
  function renderBackoff() {
    backoffList.textContent = '';
    backoffValues.forEach((value, index) => {
      const isLast = index === backoffValues.length - 1;
      const input = h('input', { type: 'number', min: '1', value: String(value) });
      input.addEventListener('input', () => {
        backoffValues[index] = Number(input.value) || 0;
      });
      const row = h('div', { class: 'row backoff-row' }, [
        h('span', {
          class: 'muted small',
          text: isLast ? `等待时长：第 ${index + 1} 次 + 后续（秒）` : `等待时长：第 ${index + 1} 次（秒）`,
        }),
        input,
        isLast && backoffValues.length > 1
          ? h('button', {
              type: 'button',
              class: 'tiny danger',
              text: '删除最后一段',
              onclick: () => {
                backoffValues.pop();
                renderBackoff();
              },
            })
          : null,
      ]);
      backoffList.appendChild(row);
    });
    backoffList.appendChild(
      h('button', {
        type: 'button',
        class: 'tiny',
        text: '＋ 再加一段',
        onclick: () => {
          // 新的一段默认沿用最后一段的值，想改再改
          backoffValues.push(backoffValues[backoffValues.length - 1] || 60);
          renderBackoff();
        },
      })
    );
  }
  renderBackoff();

  const form = h('form', { class: 'panel' }, [
    h('h2', { text: '设置' }),
    h('div', { class: 'block' }, [
      h('label', { class: 'inline' }, [allowNoKey, '允许不带口令访问 /openai/*（仅本机/内网建议打开）']),
    ]),
    h('div', { class: 'block' }, [
      h('span', { text: '管理端来源限制' }),
      h('p', {
        class: 'hint',
        text:
          '默认只允许本机/内网来源打开后台（这里没有开关可改）。' +
          '要让公网直接访问后台，就在 compose / normal.env 里加环境变量 ALLOW_PUBLIC_INTERNET="true"，然后重启容器。',
      }),
    ]),
    h('div', { class: 'block' }, [
      h('label', { class: 'inline' }, [
        fakeEndpoints,
        '启用假数据端点（/openai/usage、/openai/billing/subscription、/openai/credits）',
      ]),
    ]),
    h('label', { class: 'block' }, [h('span', { text: '倒计时检测次数上限（0 = 一直检测）' }), probeMax]),
    h('p', {
      class: 'hint',
      text: '连续探测这么多次都没恢复就停下来，转「故障（需人工）」。0 = 一直探。',
    }),
    h('div', { class: 'block' }, [h('span', { text: '倒计时检测的等待时长（退避）' }), backoffList]),
    h('p', {
      class: 'hint',
      text: '第 N 次探测前等多久；最后一段之后都用它。前几段短一点，上游抖一下能快点恢复。',
    }),
    h('label', { class: 'block' }, [h('span', { text: '调用日志保留天数' }), retention]),
    h('label', { class: 'block' }, [h('span', { text: '时区（UTC 偏移小时）' }), utcOffset]),
    h('p', {
      class: 'hint',
      text: '默认 0 = UTC（主页卡片上不加后缀）。填 8 就是 UTC+8，5.5 是 UTC+5:30。主页「今日」和日额度（rpd/tpd）的重置都按这个零点切。',
    }),
    h('label', { class: 'block' }, [h('span', { text: 'All / 模型组的上下文长度（tokens）' }), autoContext]),
    h('p', {
      class: 'hint',
      text: '发布给客户端的上下文长度（All 和模型组会落到哪个来源不定，按最窄的那个填）。0 = 不发布。',
    }),
    h('button', { class: 'primary', type: 'submit', text: '保存设置' }),
  ]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/settings', {
        method: 'PATCH',
        body: {
          allow_no_key: allowNoKey.checked,
          fake_endpoints_enabled: fakeEndpoints.checked,
          probe_max_attempts: Number(probeMax.value),
          probe_backoff_seconds: backoffValues.filter((n) => Number(n) > 0),
          log_retention_days: Number(retention.value),
          utc_offset_hours: Number(utcOffset.value) || 0,
          auto_context_tokens: Number(autoContext.value) || 0,
        },
      });
      alert('已保存');
    } catch (err) {
      alert(err.message);
    }
  });
  container.appendChild(form);
}

init();
