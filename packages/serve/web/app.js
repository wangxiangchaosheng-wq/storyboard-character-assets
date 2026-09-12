/* 历史推演台 · 前端逻辑（原生 JS，无框架；展示文本一律转义输出） */
'use strict';

// 单体骨架：boot 在文件末尾调用

/* 短命名选择器 */
const $ = (id) => document.getElementById(id);

/* HTML 转义：所有 AI 生成文本进入模板前必须过这里（防 XSS） */
function esc(s) {
  const map = [['&', '&amp;'], ['<', '&lt;'], ['>', '&gt;'], ['"', '&quot;'], ["'", '&#39;']];
  let out = String(s ?? '');
  for (const pair of map) out = out.split(pair[0]).join(pair[1]);
  return out;
}

/* 站内请求封装：路径只接受 /api/ 相对前缀或 /healthz（白名单），其余一律拒绝 */
function apiPath(sub) {
  const p = String(sub);
  if (p.indexOf('/api/') !== 0 && p !== '/healthz') throw new Error('非法请求路径');
  return p;
}

async function api(sub, opts) {
  const init = { ...(opts || {}) };
  if (!init.headers) init.headers = {};
  // 只在有请求体时才声明 JSON 头：空 body 的 POST（如 /build）带该头会被服务端判为非法
  if (init.body !== undefined && String(init.method || 'GET') !== 'GET') {
    init.headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(apiPath(sub), init);
  } catch {
    throw new Error('无法连接引擎服务（请确认已运行 pnpm serve）');
  }
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON 响应 */ }
  if (!res.ok) {
    const msg = (body && body.error && body.error.message) ||
      (body && body.message) || ('请求失败（HTTP ' + res.status + '）');
    throw new Error(msg);
  }
  return body;
}

/* POST 查询封装：URL 恒定（不接受任何插值），可变数据一律走请求体。
   hash 恢复（restoreGame/restoreTopic/loadSpec）场景专用，杜绝把外部输入拼进请求路径。 */
async function apiPost(path, data) {
  return api(path, {
    method: 'POST',
    body: JSON.stringify(data || {}),
  });
}

let toastTimer = 0;
function toast(msg, isErr) {
  const t = $('toast');
  t.replaceChildren(document.createTextNode(String(msg)));
  t.classList.toggle('err', Boolean(isErr));
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.hidden = true; }, 4200);
}

/* ---------------- 全局状态 ---------------- */
const S = { topicId: null, spec: null, gameId: null, busy: false };
let lastBuildFailReason = ''; // 最近一次构建失败的服务端原因（SSE topics.spec.failed 携带）

/* 页面阶段切换：home / building / spec / game */
function phase(name) {
  const ids = ['home', 'building', 'spec', 'game'];
  for (const id of ids) {
    if (id === name) {
      $(id).hidden = false;
    } else {
      $(id).hidden = true;
    }
  }
  $('btnReset').hidden = name === 'home';
  if (name === 'home') refreshPastGames();
}

/* 是否为链接输入：只认 http/https 开头 */
function looksLikeUrl(v) {
  return v.indexOf('http://') === 0 || v.indexOf('https://') === 0;
}

/* 内网目标预检（与服务端 safeFetch 同一套约束的镜像，防把内网链接喂进管线）：
   真正的出站总闸在服务端 topic-pipeline → safeFetch；这里只是表单层的快速拒绝 */
function isPrivateTarget(raw) {
  let host;
  try {
    host = String(new URL(raw).host).toLowerCase();
  } catch (e) {
    return true; // 解析失败的链接一律不放行
  }
  if (host.indexOf('::1') === 0 || host === 'localhost' || host.indexOf('localhost:') === 0) {
    return true;
  }
  const ip = host.split(':')[0];
  if (ip.indexOf('127.') === 0 || ip.indexOf('10.') === 0) return true;
  if (ip.indexOf('192.168.') === 0) return true;
  if (ip.indexOf('172.') === 0) {
    const b = Number(ip.split('.')[1]);
    if (Number.isInteger(b) && b >= 16 && b <= 31) return true;
  }
  return false;
}

/* 引擎模式徽章：后台刷新（失败 800ms 后重试一次），不阻塞 hash 恢复 */
function badgeLabel(h) {
  return (h && h.provider === 'real' ? '真实模型模式' : '离线模拟模式，数值由事实驱动') +
    ' · AI 历史模拟引擎';
}

function bootBadge() {
  api('/healthz')
    .then(function (h) { $('providerBadge').textContent = badgeLabel(h); })
    .catch(function () {
      setTimeout(function () {
        api('/healthz')
          .then(function (h) { $('providerBadge').textContent = badgeLabel(h); })
          .catch(function () { $('providerBadge').textContent = 'AI 历史模拟引擎 · 服务未连接'; });
      }, 800);
    });
}

/* hash 入参白名单（restoreGame / restoreTopic 入口都会校验）：
   gameId 恒为 g + 8 位 hex；topicId 为 txt: 前缀或 http(s) 链接 */
const GAME_ID_RE = /^g[0-9a-f]{8}$/;
const TOPIC_ID_RE = /^txt:/;

function boot() {
  bootBadge();
  // hash 恢复：#t=话题Id（剧本页）/ #g=游戏Id（游戏页）
  const params = new URLSearchParams(location.hash.slice(1));
  const g = params.get('g');
  const t = params.get('t');
  if (g) {
    restoreGame(decodeURIComponent(g));
  } else if (t) {
    restoreTopic(decodeURIComponent(t));
  } else {
    refreshPastGames();
  }
}

$('topicForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (S.busy) return;
  const raw = $('topicInput').value.trim();
  if (!raw) {
    toast('先写一个话题，或粘贴一个知乎 / 网页链接', true);
    return;
  }
  S.busy = true;
  $('btnGo').disabled = true;
  try {
    let payload;
    if (looksLikeUrl(raw)) {
      if (isPrivateTarget(raw)) {
        toast('不支持内网 / 本机地址链接（与服务端 safeFetch 同款门禁）', true);
        S.busy = false;
        $('btnGo').disabled = false;
        return;
      }
      payload = { kind: 'url', url: raw };
    } else {
      payload = { kind: 'text', text: raw };
    }
    const r = await api('/api/topics/ingest', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    await startBuild(r.topicId);
  } catch (e) {
    toast(e.message, true);
  } finally {
    S.busy = false;
    $('btnGo').disabled = false;
  }
});

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', function () {
    $('topicInput').value = chip.dataset.ex;
  });
}
$('topicInput').addEventListener('input', function () {
  let hint;
  if (looksLikeUrl($('topicInput').value.trim())) {
    hint = '识别为链接，将抓取网页内容考据';
  } else {
    hint = '支持知乎链接：https://www.zhihu.com/question/…';
  }
  $('modeHint').textContent = hint;
});

$('btnReset').addEventListener('click', function () {
  if (!confirm('放弃当前推演 / 本局对局？')) return;
  S.topicId = null;
  S.spec = null;
  S.gameId = null;
  history.replaceState(null, '', location.pathname);
  phase('home');
});

/* ---------------- 构建：SSE 阶段 + 轮询兜底 ---------------- */
const STAGES = ['ingesting', 'filling', 'generating', 'validating', 'ready'];

function setStage(i) {
  document.querySelectorAll('#stages li').forEach(function (li) {
    const n = STAGES.indexOf(li.dataset.st);
    if (n === i) {
      li.classList.add('on');
    } else {
      li.classList.remove('on');
    }
    if (n < i) {
      li.classList.add('done');
    } else {
      li.classList.remove('done');
    }
  });
}

async function startBuild(topicId) {
  S.topicId = topicId;
  phase('building');
  const short = String(topicId).slice(0, 40);
  $('buildingTopic').textContent = String(topicId).length > 40 ? short + '…' : topicId;
  $('buildingMsg').textContent = '现场考据事实、检索数值、推导公式，不写死任何话题…';
  setStage(0);

  const enc = encodeURIComponent(topicId);
  const eventsUrl = '/api/topics/' + enc + '/events';
  const statusUrl = '/api/topics/' + enc + '/status';
  const buildUrl = '/api/topics/' + enc + '/build';
  let settled = false;

  function finish() {
    if (settled) return;
    settled = true;
    source.close();
    clearInterval(poll);
    clearTimeout(hardStop);
    loadSpec();
  }

  const source = new EventSource(eventsUrl);
  source.addEventListener('topics.build.progress', function (ev) {
    try {
      const p = JSON.parse(ev.data);
      const i = STAGES.indexOf(p.state);
      if (i >= 0) setStage(i);
      if (p.state === 'revising') setStage(3);
    } catch (e) { /* 坏包忽略 */ }
  });
  source.addEventListener('topics.spec.ready', function () { setStage(4); finish(); });
  source.addEventListener('topics.spec.failed', function (ev) {
    try {
      const p = JSON.parse(ev.data);
      const rev = p.lastRevision || p.last_revision || [];
      if (rev.length) lastBuildFailReason = String(rev[0]);
    } catch (e) { /* 坏包忽略 */ }
    finish();
  });

  const poll = setInterval(async function () {
    if (settled) return;
    try {
      const st = await api(statusUrl);
      if (st.state === 'ready') {
        setStage(4);
        finish();
      } else if (st.state === 'failed') {
        settled = true;
        source.close();
        clearInterval(poll);
        clearTimeout(hardStop);
        loadSpec();
      }
    } catch (e) { /* 瞬时错误忽略 */ }
  }, 1200);
  const hardStop = setTimeout(function () { if (!settled) finish(); }, 480_000);

  await api(buildUrl, { method: 'POST' });
}

async function loadSpec() {
  try {
    const r = await apiPost('/api/topics/spec', { id: S.topicId });
    S.spec = r.spec;
    renderSpec();
  } catch (e) {
    phase('home');
    // 优先展示服务端记录的构建失败原因（如"知乎反爬，请粘贴文本"）
    const reason = lastBuildFailReason || e.message;
    lastBuildFailReason = '';
    toast('剧本未能生成：' + reason, true);
  }
}

async function restoreTopic(topicId) {
  // hash 来源的 topicId 未经可信：仅放行 txt: 前缀（URL 粘贴走表单提交，不走 hash 恢复）
  if (typeof topicId !== 'string' || !TOPIC_ID_RE.test(topicId)) {
    phase('home');
    return;
  }
  S.topicId = topicId;
  try {
    // id 走请求体（URL 恒定），不拼进请求路径
    const r = await apiPost('/api/topics/spec', { id: topicId });
    S.spec = r.spec;
    renderSpec();
  } catch (e) {
    phase('home');
  }
}

/* ---------------- 剧本渲染 ---------------- */
function renderSpec() {
  const sp = S.spec;
  phase('spec');
  const sc = sp.scenario || {};
  $('specKicker').textContent = sp.domain + ' · 无固定回合（可一直廷议）';
  $('specTitle').textContent = sp.title || sc.title || S.topicId;
  $('specMeta').textContent = '廷议无尽：想聊多久聊多久，主动「退朝」才定局';
  $('specBackground').textContent = sc.background || '（背景略）';
  $('specConflict').textContent = sc.conflict || '（矛盾略）';
  $('specCriteria').textContent = sc.successCriteria
    ? '终局判定 —— ' + sc.successCriteria
    : '';
  if (sp.seedEvents && sp.seedEvents.length) {
    $('seedEvents').textContent = '开局即临 —— ' + sp.seedEvents.join('；');
  } else {
    $('seedEvents').textContent = '';
  }

  // 阵容
  const cast = sp.cast || [];
  $('castCount').textContent = '共 ' + cast.length + ' 位';
  $('castBox').innerHTML = '';
  const tr = { competence: '才', loyalty: '忠', ambition: '望', power: '势' };
  for (const c of cast) {
    const el = document.createElement('div');
    el.className = 'cast';
    let inner = '<h4>' + esc(c.name);
    if (c.stance) inner += ' <span class="stance">· ' + esc(c.stance) + '</span>';
    inner += '</h4>';
    if (c.role) inner += '<span class="role">' + esc(c.role) + '</span>';
    inner += '<p class="muted small">' + esc(c.description || '') + '</p><div class="traitbar">';
    for (const k of Object.keys(tr)) {
      const v = Math.max(0, Math.min(100, Number(c.traits && c.traits[k]) || 0));
      inner += '<span>' + tr[k] + '<i style="--fill:' + v + '%"></i></span>';
    }
    inner += '</div>';
    el.innerHTML = inner;
    $('castBox').appendChild(el);
  }

  // 指标一览（初始 / 下限 / 上限，纯表格；出处与估算链不展示）
  $('metricsBox').innerHTML = '';
  const mrows = (sp.metrics || []).map(function (m) {
    let unit = '';
    if (m.unit) unit = '<span class="unit">' + esc(m.unit) + '</span>';
    return '<tr><td>' + esc(m.label || m.key) + '</td>' +
      '<td class="r g-num"><b>' + m.start + '</b> ' + unit + '</td>' +
      '<td class="r muted">' + m.min + '</td>' +
      '<td class="r muted">' + m.max + '</td></tr>';
  }).join('');
  $('metricsBox').innerHTML = '<table class="ledger"><thead><tr>' +
    '<th>科目</th><th class="r">初始</th><th class="r">下限</th><th class="r">上限</th>' +
    '</tr></thead><tbody>' + mrows + '</tbody></table>';

  // 规则 + 推导（derivations）+ 公式复核结论（formulaAudit；公式原文不出现在前端）
  renderRuleList($('rulesBox'), sp);
}

/* 规则明细卡（spec 预览与「本局机制」页共用；不展示推导/复核等出处信息） */
function ruleCardHTML(sp, r) {
  return '<div class="rule"><div class="r-head"><span class="badge ' + esc(r.kind) + '">' +
    esc(r.kind) + '</span><span>' + esc(r.label) + '</span></div>' +
    '<p class="muted small">' + esc(r.description || '') + '</p></div>';
}

function renderRuleList(box, sp) {
  box.innerHTML = '';
  for (const r of sp.rules || []) {
    box.appendChild(dom(ruleCardHTML(sp, r)));
  }
}

function dom(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

/* ---------------- 印章头像（按立场配色，随人物册数据生成，不写死任何人物） ---------------- */
const STANCE_COLORS = {
  '进取': '#a63d2f', '主战': '#a63d2f', '推进': '#a63d2f',
  '稳守': '#31594b', '稳健': '#31594b', '持重': '#31594b',
  '客观': '#8a6d3b', '协商': '#8a6d3b', '中立': '#8a6d3b',
};

function stanceColor(stance) {
  if (STANCE_COLORS[stance]) return STANCE_COLORS[stance];
  // 未知立场：按名字 hash 从四色盘中取，保证同人同色
  const palette = ['#a63d2f', '#31594b', '#8a6d3b', '#4a5a7a'];
  let h = 0;
  const s = String(stance || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

function avatarSvg(name, stance) {
  const s = String(name || '?');
  const hit = s.match(/[\u4e00-\u9fa5A-Za-z0-9]/);
  const ch = hit ? hit[0] : '?';
  const c = stanceColor(stance);
  return '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="' +
    esc(s) + '">' +
    '<circle cx="32" cy="32" r="30" fill="#f7efdb" stroke="' + c + '" stroke-width="3"/>' +
    '<circle cx="32" cy="32" r="24" fill="none" stroke="' + c + '" stroke-width="1" opacity="0.45"/>' +
    '<text x="32" y="43" text-anchor="middle" font-size="30" font-family="Kaiti SC,STKaiti,KaiTi,serif" fill="#2b2418">' +
    esc(ch) + '</text></svg>';
}

/* ---------------- 游戏（聊天式廷议） ---------------- */
S.view = null;   // GameView（聊天主线）
S.mode = 'consult'; // consult=问策（只对话）｜decree=下诏（结算数值）
S.target = null;  // 当前发话对象（persona id；null = 全场）

$('btnPlay').addEventListener('click', async function () {
  if (S.busy) return;
  S.busy = true;
  const btn = $('btnPlay');
  btn.disabled = true;
  btn.textContent = '正在宣群臣入朝…';
  try {
    const specId = S.spec && S.spec.id ? S.spec.id : S.topicId;
    const r = await api('/api/games', {
      method: 'POST',
      body: JSON.stringify({ specId: specId, player: '主上' }),
    });
    S.gameId = r.gameId;
    S.topicId = r.specId;
    history.replaceState(null, '', '#g=' + encodeURIComponent(r.gameId));
    renderGame(r);
  } catch (e) {
    toast('开局失败：' + e.message, true);
  } finally {
    S.busy = false;
    setBusy(false); // renderGame 在 busy 中会把输入区一并禁用，这里统一解锁
    btn.disabled = false;
    btn.textContent = '以我之名，入局推演';
  }
});

async function restoreGame(gameId) {
  // hash 来源的 gameId 未经可信：格式白名单不过即回首页，不发起请求
  if (typeof gameId !== 'string' || !GAME_ID_RE.test(gameId)) {
    phase('home');
    return;
  }
  try {
    // id 一律走请求体（URL 恒定）；state 响应已内联 spec，无需二次查询
    const v = await apiPost('/api/games/state', { id: gameId });
    S.gameId = gameId;
    S.topicId = v.specId;
    if (v.spec) S.spec = v.spec;
    renderGame(v);
    if (v.status === 'final') {
      const e = await apiPost('/api/games/ending', { id: gameId });
      renderEnding(e);
    }
  } catch (e) {
    phase('home');
  }
}

function renderGame(v) {
  S.gameId = v.gameId;
  S.view = v;
  phase('game');
  const isFinal = v.status === 'final';
  // 鼎新后的覆盖 spec（/state 与 /reform 响应都带 spec）
  if (v.spec) S.spec = v.spec;
  $('gameKicker').textContent =
    (v.turn ? '已下诏 ' + v.turn + ' 道' : '朝中初议') + ' · ' +
    (isFinal ? '终局已定' : '廷议无尽（无固定轮数）');
  $('gameTitle').textContent = v.title || (S.spec && S.spec.title) || '推演';
  $('vertTitle').textContent = vertTheme(v.title || (S.spec && S.spec.title) || '');
  $('chatHint').textContent = '在场 ' + castList().length + ' 位 · 点名问策，或下诏执行';
  renderGauge(v.metrics || [], v.state);
  renderRoster();
  renderFocus();
  renderMechanisms(v.directives || []);
  renderChat();
  $('btnEnd').disabled = isFinal || S.busy;
  $('msgInput').disabled = isFinal || S.busy;
  $('btnSend').disabled = isFinal || S.busy;
  $('reformInput').disabled = isFinal || S.busy;
  $('btnReform').disabled = isFinal || S.busy;
  if (isFinal) {
    $('chatStatus').textContent = '定局后朝议罢，可另开新局';
  } else {
    $('chatStatus').textContent = '';
  }
  syncModeHint();
  refreshHistory();
}

/* 右栏竖排卷轴标题：取话题主题词（竖排放不下长句） */
function vertTheme(title) {
  const segs = String(title || '').replace(/^话题推演[:：]?/, '').split(/[：:，,。；;？?！!]/);
  let t = (segs[0] || '').trim();
  if (t.length > 10) t = t.slice(0, 10);
  return t || '推演';
}

function metricLabelOf(key) {
  const defs = (S.spec && S.spec.metrics) || (S.view && S.view.metrics) || [];
  for (const m of defs) if (m.key === key) return m.label || key;
  return key;
}

function setHidden(el, yes) {
  el.hidden = yes;
}

/* ---- 朝堂诸科目：数值台账（只读表格） ---- */
function cmpOp(op, a, b) {
  if (op === '<=') return a <= b;
  if (op === '>=') return a >= b;
  if (op === '<') return a < b;
  if (op === '>') return a > b;
  return a === b;
}
var gaugePrevState = null;
function renderGauge(metrics, state) {
  $('gaugeBox').innerHTML = '';
  if (!metrics || !metrics.length) { gaugePrevState = null; return; }
  const defs = (S.spec && S.spec.metrics) || [];
  const rules = (S.spec && S.spec.rules) || [];
  const prev = gaugePrevState || {};
  const thead = '<table class="ledger"><thead><tr>' +
    '<th>科目</th><th class="r">数值</th><th class="r">区间</th><th class="c">状态</th>' +
    '<th class="r">较上轮</th><th class="r">初值</th></tr></thead><tbody>';
  let rows = '';
  for (const m of metrics) {
    const def = defs.find(function (d) { return d.key === m.key; });
    const start = def && def.start !== undefined ? def.start : m.min;
    let now = start;
    if (state && state[m.key] !== undefined) now = state[m.key];
    const span = Math.max(1e-6, m.max - m.min);
    const p = Math.max(0, Math.min(100, ((now - m.min) / span) * 100));
    const base = prev[m.key] !== undefined ? prev[m.key] : start;
    const diff = now - base;
    const diffHtml = Math.abs(diff) < 0.5 ? '<span class="muted">—</span>' :
      '<span class="led-diff ' + (diff > 0 ? 'up' : 'down') + '">' +
      (diff > 0 ? '▲' : '▼') + Math.round(Math.abs(diff)) + '</span>';
    const risks = [];
    for (const r of rules) {
      if (!r || r.kind !== 'threshold' || r.metric !== m.key) continue;
      if (r.op && r.value != null && cmpOp(r.op, now, r.value) && r.fires) risks.push(r.fires);
    }
    const nearBottom = p <= 30;
    const stat = p <= 15 ? '告急' : p <= 30 ? '见紧' : p <= 60 ? '如常' : p <= 85 ? '见好' : '充盈';
    const statCls = p <= 15 ? 'warn' : p >= 85 ? 'good' : '';
    const unit = (def && def.unit) ? '<span class="unit">' + esc(def.unit) + '</span>' : '';
    rows += '<tr class="led-row' + (nearBottom ? ' warn' : '') + '">' +
      '<td>' + esc(m.label || m.key) + '</td>' +
      '<td class="r g-num"><b>' + Math.round(now) + '</b> ' + unit + '</td>' +
      '<td class="r">' + Math.round(p) + '%</td>' +
      '<td class="c led-state ' + statCls + '">' + stat + '</td>' +
      '<td class="r">' + diffHtml + '</td>' +
      '<td class="r muted">' + Math.round(start) + '</td></tr>';
    if (risks.length) {
      rows += '<tr class="led-alert"><td colspan="6">⚠ ' +
        risks.map(function (t) { return esc(t); }).join('；') + '</td></tr>';
    }
  }
  $('gaugeBox').innerHTML = thead + rows + '</tbody></table>';
  gaugePrevState = state || null;
}

/* ---- 左栏人物册 + 中央人物卡（全部数据驱动，随 cast 变动） ---- */
function castList() {
  return (S.spec && S.spec.cast) || [];
}

function renderRoster() {
  const box = $('rosterBox');
  box.innerHTML = '';
  const all = $('targetAll');
  all.classList.toggle('active', S.target === null);
  all.onclick = function () { pickTarget(null); };
  for (const p of castList()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'roster-item' + (S.target === p.id ? ' active' : '');
    b.title = (p.role || '') + ' ·『' + (p.stance || '') + '』';
    b.innerHTML =
      '<span class="avatar-medal">' + avatarSvg(p.name, p.stance) + '</span>' +
      '<span class="ri-body"><b>' + esc(p.name) + '</b><small>' +
      esc(p.role || '') + (p.stance ? ' ·『' + esc(p.stance) + '』' : '') + '</small></span>';
    b.onclick = function () { pickTarget(p.id); };
    box.appendChild(b);
  }
}

function pickTarget(pid) {
  S.target = pid;
  renderRoster();
  renderFocus();
  syncModeHint();
  $('msgInput').focus();
}

function renderFocus() {
  const p = S.target ? castList().find(function (x) { return x.id === S.target; }) : null;
  if (p) {
    $('focusAvatar').innerHTML = avatarSvg(p.name, p.stance);
    $('focusName').textContent = p.name;
    $('focusRole').textContent = (p.role || '朝臣') + (p.stance ? ' ·『' + p.stance + '』' : '');
  } else {
    $('focusAvatar').innerHTML =
      '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><circle cx="32" cy="32" r="30" ' +
      'fill="#f7efdb" stroke="#8a6d3b" stroke-width="3"/><text x="32" y="43" text-anchor="middle" ' +
      'font-size="30" font-family="Kaiti SC,STKaiti,KaiTi,serif" fill="#2b2418">朝</text></svg>';
    $('focusName').textContent = '朝堂';
    $('focusRole').textContent = '满朝文武 · 共议国是';
  }
}

/* 本局机制页：快捷操作（chips）+ 规则明细（与 spec 页同源渲染）。
   主对话区不再展示机制——机制只在独立页（btnMech 进入）。 */
function renderMechanisms(list) {
  S.directives = list || [];
  const box = $('mechQuick');
  box.innerHTML = '';
  for (const d of list || []) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip mech mech-' + esc(d.kind);
    const glyph = d.kind === 'consult' ? '❡' : d.kind === 'decree' ? '诏' : '衡';
    b.innerHTML = '<b>' + esc(d.label) + '</b><span class="hint">' + esc(d.hint) + '</span>';
    b.title = d.hint;
    b.addEventListener('click', function () {
      if (d.kind === 'consult') {
        S.mode = 'consult';
        S.target = d.personaId || null;
      } else {
        S.mode = 'decree';
        if (d.personaId) S.target = d.personaId;
      }
      closeMechPanel();
      setModeActive();
      renderRoster();
      renderFocus();
      syncModeHint();
      $('msgInput').focus();
      return;
    });
    box.appendChild(b);
  }
}

function openMechPanel() {
  if (!S.spec) return;
  // 每次进入按最新 spec 组装（鼎新可能已改写本局）
  renderMechanisms(S.directives || []);
  renderRuleList($('mechRules'), S.spec);
  setHidden($('gameMain'), true);
  setHidden($('mechPanel'), false);
}
function closeMechPanel() {
  setHidden($('mechPanel'), true);
  setHidden($('gameMain'), false);
}
$('btnMech').addEventListener('click', openMechPanel);
$('btnMechBack').addEventListener('click', closeMechPanel);

/* mode 切换（segmented） */
function setModeActive() {
  $('modeConsult').classList.toggle('active', S.mode === 'consult');
  $('modeDecree').classList.toggle('active', S.mode === 'decree');
}
$('modeConsult').addEventListener('click', function () { S.mode = 'consult'; setModeActive(); syncModeHint(); });
$('modeDecree').addEventListener('click', function () { S.mode = 'decree'; setModeActive(); syncModeHint(); });

function syncModeHint() {
  const who = S.target ? ((S.spec && S.spec.cast || []).find(function (p) { return p.id === S.target; }) || {}).name || S.target : '全场';
  if (S.mode === 'decree') {
    $('chatModeHint').textContent = '下诏执行：按「' + who + '」意向行动，重算本局数据（诏令 +1）';
    $('msgInput').placeholder = '以 ' + who + ' 的名义，拟一道诏令…';
  } else {
    $('chatModeHint').textContent = '廷议问策：' + who + ' 会按立场回应，不改动数值';
    $('msgInput').placeholder = '跟 ' + who + ' 说点建议 / 质询…';
  }
}

/* ---- 聊天气泡 ---- */
function bubble(kind, m) {
  const el = document.createElement('div');
  el.className = 'msg kind-' + kind;
  if (kind === 'player') el.classList.add('mine');
  const whoBadge = m.name ? '<span class="who">' + esc(m.name) +
    (m.stance ? ' <em class="stance">' + esc(m.stance) + '</em>' : '') + '</span>' : '';
  if (kind === 'agent') {
    el.innerHTML =
      '<span class="avatar">' + avatarSvg(m.name || '?', m.stance) + '</span>' +
      '<div class="body">' + whoBadge + '<p>' + esc(m.text) + '</p></div>';
  } else if (kind === 'player') {
    // 文策（诏令/改令，结算数值）与廷议问策（仅对话）在消息流里明确区分
    const tag = m.act
      ? '<em class="tag tag-decree">文策 · 诏令</em>'
      : '<em class="tag tag-talk">廷议 · 问策</em>';
    el.innerHTML = '<div class="mine-head"><span class="who you">你</span>' + tag + '</div>' +
      '<p>' + esc(m.text) + '</p>';
  } else {
    let dl = '';
    for (const d of (m.deltas || [])) {
      const label = metricLabelOf(d.metric);
      const sign = d.by > 0 ? '+' : '';
      dl += '<span class="delta ' + (d.by >= 0 ? 'up' : 'down') + '" title="' + esc((d.why || []).join('；')) + '">' +
        esc(label) + ' ' + sign + d.by + '</span>';
    }
    // system / result / event 都走整段卡片样式
    const head = kind === 'result' ? '✦ ' + esc(m.name || '诏令执行') :
      kind === 'event' ? '⚑ ' + esc(m.name || '烽火') : '◈ ' + esc(m.name || '史官');
    el.innerHTML = '<h4>' + head + '</h4><p>' + esc(m.text) + '</p>' +
      (dl ? '<div class="deltas">' + dl + '</div>' : '');
  }
  return el;
}

function renderChat() {
  const box = $('chatBox');
  box.innerHTML = '';
  const chat = (S.view && S.view.chat) || [];
  for (const m of chat) {
    box.appendChild(bubbleFor(m));
  }
  box.scrollTop = box.scrollHeight;
}

function bubbleFor(m) {
  return bubble(m.kind, m);
}

/* ---------- 发送 ---------- */
$('msgForm').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  if (S.busy || !S.view || S.view.status === 'final') return;
  const text = $('msgInput').value.trim();
  if (!text) return;
  const wasDecree = S.mode === 'decree';
  const body = { text: text, act: wasDecree };
  if (S.target) body.to = S.target;
  $('msgInput').value = '';
  setBusy(true);
  try {
    const r = await api('/api/games/' + encodeURIComponent(S.gameId) + '/message', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    // 增量追加新消息
    S.view.chat = (S.view.chat || []).concat(r.messages || []);
    S.view.turn = r.turn;
    S.view.status = r.status;
    S.view.state = r.state;
    $('gameKicker').textContent =
      (r.turn ? '已下诏 ' + r.turn + ' 道' : '朝中初议') + ' · ' +
      (r.status === 'final' ? '终局已定' : '廷议无尽（无固定轮数）');
    renderGauge(S.view.metrics || [], r.state);
    renderChat();
    if (wasDecree) refreshHistory();
    if (r.ended) renderEnding(r.ended);
  } catch (e) {
    toast(e.message, true);
  } finally {
    setBusy(false);
  }
});

/** 发送中状态：禁用按钮 + 状态行 */
function setBusy(b) {
  S.busy = b;
  const set = function (id) { $(id).disabled = b; };
  set('btnSend');
  set('btnEnd');
  set('msgInput');
  set('btnReform');
  set('reformInput');
  if (b) $('chatStatus').textContent = '正在书写朝议…';
  else if (S.view && S.view.status === 'final') {
    // 终局后再解锁会把已定格的输入框重新打开，这里必须保持禁用
    $('chatStatus').textContent = '定局后朝议罢，可另开新局';
    $('btnSend').disabled = true;
    $('btnEnd').disabled = true;
    $('msgInput').disabled = true;
    $('btnReform').disabled = true;
    $('reformInput').disabled = true;
  } else {
    $('chatStatus').textContent = '';
  }
}

/* ---------- 鼎新改局：一段话改写任意区域（年代 / 人物册 / 矛盾） ---------- */
function openReformPanel() {
  setHidden($('gameMain'), true);
  setHidden($('reformPanel'), false);
  $('reformInput').focus();
}
function closeReformPanel() {
  setHidden($('reformPanel'), true);
  setHidden($('gameMain'), false);
}
$('btnReformPanel').addEventListener('click', openReformPanel);
$('btnReformBack').addEventListener('click', closeReformPanel);

$('reformForm').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  if (S.busy || !S.view || S.view.status === 'final') return;
  const text = $('reformInput').value.trim();
  if (!text) {
    toast('先写一句改令：推移年代 / 罢免老臣 / 起用新人，皆可', true);
    return;
  }
  setBusy(true);
  $('chatStatus').textContent = '正在颁改令，朝局更迭…';
  try {
    const r = await api('/api/games/' + encodeURIComponent(S.gameId) + '/reform', {
      method: 'POST',
      body: JSON.stringify({ text: text }),
    });
    $('reformInput').value = '';
    closeReformPanel();
    if (r.spec) S.spec = r.spec;
    if (r.view) {
      S.view = r.view;
      S.view.state = r.state;
      renderGame(r.view);
    }
    toast('朝局已鼎新' + (r.spec ? '（在场 ' + r.spec.cast.length + ' 位）' : ''), false);
  } catch (e) {
    toast(e.message, true);
  } finally {
    setBusy(false);
  }
});

/* ---------- 退朝定局 ---------- */
$('btnEnd').addEventListener('click', async function () {
  if (S.busy || !S.view || S.view.status === 'final') return;
  if (!confirm('就此退朝、定下终局判定？\n（对话与数值将定格，可用「新话题」另起一局）')) return;
  setBusy(true);
  try {
    const r = await api('/api/games/' + encodeURIComponent(S.gameId) + '/end', { method: 'POST' });
    S.view = r.view;
    renderGame(S.view);
    renderEnding(r.ending);
    refreshHistory();
  } catch (e) {
    toast(e.message, true);
  } finally {
    setBusy(false);
  }
});

function renderEnding(e) {
  setHidden($('endingCard'), false);
  const words = { victory: '大获全胜', defeat: '黯然收场', open: '胜负未分' };
  const word = words[e.verdict] || e.verdict;
  $('endingKicker').textContent = '终局判定 · ' + word;
  $('endingTitle').textContent = e.title || '终局';
  $('endingNarrative').textContent = e.narrative || '';
  $('endingMetrics').innerHTML = '';
  const defs = (S.spec && S.spec.metrics) || (S.view && S.view.metrics) || [];
  for (const m of defs) {
    let fin = '—';
    if (e.metrics && e.metrics[m.key] !== undefined) fin = Math.round(e.metrics[m.key]);
    const el = document.createElement('div');
    el.className = 'muted small';
    el.textContent = (m.label || m.key) + '：终局 ' + fin;
    $('endingMetrics').appendChild(el);
  }
  $('endingCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------------- 历史对局：续局列表 + 时势脉络（走势 / 年表） ---------------- */

/* 首页「过往推演」列表：进入 home 阶段时拉取；服务重启后内存清空则为空 */
async function refreshPastGames() {
  try {
    const r = await api('/api/games');
    renderPastGames(r.games || []);
  } catch (e) { /* 列表是辅助信息，失败静默（下次进入重试） */ }
}

function renderPastGames(games) {
  const box = $('pastList');
  box.innerHTML = '';
  if (!games || !games.length) {
    $('pastGames').hidden = true;
    return;
  }
  $('pastGames').hidden = false;
  for (const g of games) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'past-card';
    const state = g.status === 'final' ? '终局已定' : '廷议进行中';
    el.innerHTML =
      '<b>' + esc(g.title || '未名之局') + '</b>' +
      '<small>' + (g.turn ? '已下诏 ' + g.turn + ' 道' : '朝中初议') + ' · ' + state + '</small>';
    el.addEventListener('click', function () { openGame(g.gameId); });
    box.appendChild(el);
  }
}

function openGame(gameId) {
  history.replaceState(null, '', '#g=' + encodeURIComponent(gameId));
  restoreGame(gameId);
}

/* ---------- 时势脉络：指标走势曲线 + 诏事年表 ---------- */
const SPARK_COLORS = ['#c9a86a', '#7fb4d5', '#7fc98a', '#d97a6a'];

async function refreshHistory() {
  if (!S.gameId) return;
  try {
    const h = await api('/api/games/' + encodeURIComponent(S.gameId) + '/history');
    renderHistory(h);
  } catch (e) { /* 面板是强化信息，失败静默 */ }
}

function renderHistory(h) {
  const series = (h && h.metrics) || [];
  if (!series.length) {
    $('historyCard').hidden = true;
    return;
  }
  $('historyCard').hidden = false;
  drawSpark(series);
  renderSparkLegend(series);
  renderChrono((h && h.events) || []);
}

/* canvas 依据容器宽度重绘，按 devicePixelRatio 提清 */
function drawSpark(series) {
  const cv = $('spark');
  const dpr = window.devicePixelRatio || 1;
  const card = $('historyCard');
  const w = Math.max(240, (cv.clientWidth || (card ? card.clientWidth : 600)) - 2);
  const h = 140;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.height = h + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const pad = { l: 8, r: 8, t: 10, b: 22 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;

  let maxTurn = 0;
  for (const s of series) for (const p of s.points) maxTurn = Math.max(maxTurn, p.t);
  const turns = Math.max(1, maxTurn);

  // 淡网格
  ctx.strokeStyle = 'rgba(232,224,208,0.1)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const q of [0, 0.25, 0.5, 0.75, 1]) {
    const y = pad.t + ih * (1 - q);
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
  }
  ctx.stroke();

  // x 轴刻度：开局 / 诏 N
  ctx.fillStyle = 'rgba(232,224,208,0.5)';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const step = Math.max(1, Math.ceil(turns / 5));
  for (let t = 0; t <= turns; t += step) {
    const x = pad.l + (t / turns) * iw;
    ctx.fillText(t === 0 ? '开局' : '诏' + t, x, h - pad.b + 4);
  }

  // 每指标一条折线（各用自身 min..max 做 y 域）
  series.forEach(function (s, i) {
    const pts = s.points;
    if (!pts.length) return;
    const color = SPARK_COLORS[i % SPARK_COLORS.length];
    const span = Math.max(1e-6, s.max - s.min);
    const xOf = function (t) { return pad.l + (t / turns) * iw; };
    const yOf = function (v) { return pad.t + ih * (1 - (v - s.min) / span); };
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    pts.forEach(function (p, idx) {
      const x = xOf(p.t);
      const y = yOf(p.v);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = color;
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(xOf(p.t), yOf(p.v), 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    const last = pts[pts.length - 1];
    ctx.beginPath();
    ctx.arc(xOf(last.t), yOf(last.v), 3, 0, Math.PI * 2);
    ctx.fill();
  });
}

function renderSparkLegend(series) {
  const box = $('sparkLegend');
  box.innerHTML = '';
  series.forEach(function (s, i) {
    const last = s.points.length ? s.points[s.points.length - 1].v : null;
    const el = document.createElement('span');
    el.className = 'sp-key';
    el.innerHTML =
      '<i style="background:' + SPARK_COLORS[i % SPARK_COLORS.length] + '"></i>' +
      esc(s.label || s.key) +
      (last !== null ? ' <b>' + Math.round(last) + '</b>' : '');
    box.appendChild(el);
  });
}

/* 诏事年表：开局 / 每诏 / 终局逐帧倒序（新在前） */
function renderChrono(events) {
  const box = $('chrono');
  box.innerHTML = '';
  const items = (events || []).slice().reverse();
  for (const e of items) {
    if (!e.narrative) continue;
    const li = document.createElement('li');

    let clock = '';
    if (e.at) {
      const d = new Date(e.at);
      if (!isNaN(d.getTime()) && d.getTime() > 0) {
        const hh = d.getHours();
        const mm = d.getMinutes();
        clock = (hh < 10 ? '0' + hh : hh) + ':' + (mm < 10 ? '0' + mm : mm);
      }
    }
    const tag = e.t === 0 ? '开局' : (String(e.narrative).indexOf('终局') === 0 ? '终局' : '诏' + e.t);

    const text = String(e.narrative || '');
    let html = '<span class="t-badge">' + tag + '</span>';
    if (clock) html += '<span class="t-clock">' + clock + '</span>';
    html += '<p class="muted small">' + esc(text.length > 140 ? text.slice(0, 140) + '…' : text) + '</p>';
    if (e.deltas && e.deltas.length) {
      html += '<span class="deltas">';
      for (const d of e.deltas) {
        const sign = d.by > 0 ? '+' : '';
        html += '<span class="delta ' + (d.by >= 0 ? 'up' : 'down') + '">' +
          esc(metricLabelOf(d.metric)) + ' ' + sign + d.by + '</span>';
      }
      html += '</span>';
    }
    li.innerHTML = html;
    box.appendChild(li);
  }
}

boot();