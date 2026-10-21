// 视频生成网站(TubeFlow)集成:账号绑定 + 频道缓存 + 建项目(草稿) / 启动全链路自动生产 + 状态查询
//
// 与视频网站代码对齐的事实(2026-10-20 核实):
// - 登录 POST /identity/login {username,password} → {token, expires_in_seconds: 43200, account}
//   后续所有接口走 Authorization: Bearer <token>(identity_project/router.py)。
// - 频道 GET /identity/channels → 含 id/name/url/default_character_image_ids/default_visual_style/
//   default_voice_version_id/default_cloned_voice_id/default_tts_provider。
// - 建项目(草稿) POST /identity/projects:aspect_ratio 只接受 16:9;频道必须有默认音色与
//   默认画面风格;character_image_ids 必填(前端创建页用频道默认角色图预填)。
// - 提交并开始生产 POST /narration/confirm {project_id}(视频前端"提交并开始生产"按钮调的就是它)。
//   AUTO 项目不走预检,该请求内部先跑拆句 agent 再冻结快照,是同步长请求 → 用长超时。
// - 项目 production_mode 由后端硬编码为 AUTO,所以"草稿"= 只建项目不提交。
//
// 用户已确认的约定:全局单账号;保存用户名+密码用于 token 过期自动重登;不支持的语言禁止推送;
// 频道缺默认角色图/风格/音色时前置拦截并提示去视频网站配置。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_PATH = path.join(DATA_DIR, 'video_binding.json');
const DEFAULT_BASE_URL = 'http://192.168.110.200:8000';

const LOGIN_TTL_MS = 12 * 60 * 60 * 1000; // 视频后端签发 12 小时会话
const TOKEN_SAFETY_MS = 5 * 60 * 1000; // 提前 5 分钟视为过期,避免踩点失败
const SHORT_TIMEOUT_MS = 20000;
// 提交并开始生产是同步长请求(内部跑拆句 agent + 冻结快照),给足 15 分钟
const CONFIRM_TIMEOUT_MS = 15 * 60 * 1000;

// 文案"目标语言" → 视频网站 SupportedLocale。视频后端只有这六种(domain/common.py),
// 其余语言(印地/印尼/德/越/阿/中)一律禁止推送。English 无论市场选 US 还是 GB 都走 en-US:
// 视频后端没有 en-GB,且 locale 只由语言决定、与目标市场无关。
const LOCALE_BY_LANGUAGE = {
  English: 'en-US',
  Japanese: 'ja-JP',
  Korean: 'ko-KR',
  Spanish: 'es-ES',
  Portuguese: 'pt-BR',
  French: 'fr-FR'
};

const STAGE_LABELS = {
  NARRATION: '配音',
  DIRECTING: '导演',
  STORYBOARD: '故事板',
  VIDEO: '视频生成',
  VIDEO_READY: '视频就绪',
  COMPOSITION: '合成',
  DELETING: '删除中'
};

// 与前端 cleanScriptText 一致:去掉 "Optimized Script" 标题行与章节标签行
// (视频后端按行切句、不过滤 [CH..] 标签,标签会被当成旁白朗读)
// 容错:允许行首 Markdown 装饰(#/>/列表符/加粗)与行尾加粗 —— 存量文案里出现过 **[CH01 | ..]** 形态
const CH_TAG_LINE = /^[\s#>*+_\-]*\[CH\d+\s*\|\s*\d{1,2}:\d{2}(?::\d{2})?\s*[-–—~]\s*\d{1,2}:\d{2}(?::\d{2})?\s*\|[^\]]*\][\s*_]*$/;

function cleanScript(raw) {
  return String(raw || '')
    .replace(/^\s*#?\s*Optimized Script[ \t]*\r?\n?/i, '')
    .split(/\r?\n/)
    .filter(line => !CH_TAG_LINE.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function localeForLanguage(language) {
  return LOCALE_BY_LANGUAGE[language] || null;
}

// 频道显示名,与视频网站同口径(frontend/project-list-display.js):有名称用名称,
// 未命名用「频道 NN」(列表序号两位补零)。视频后端 name 可能为 null,不能拿 URL 当名字——
// 多个频道可能指向同一个 URL,用 URL 会完全无法区分。
// 兼容旧缓存:name 为空或恰好等于 URL(早期兜底值)时按序号重新派生。
function derivedChannelName(channel, index) {
  const name = String((channel && channel.name) || '').trim();
  const url = String((channel && channel.url) || '').trim();
  if (name && name !== url) return name;
  return '频道 ' + String(index + 1).padStart(2, '0');
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim() || DEFAULT_BASE_URL;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : 'http://' + raw;
  return withScheme.replace(/\/+$/, '');
}

// 视频后端有两种错误体:DomainError → {"error":{code,message}};HTTPException → {"detail":{code,message}}
function errorCode(data) {
  if (!data) return null;
  if (data.error && typeof data.error === 'object') return data.error.code || null;
  if (data.detail && typeof data.detail === 'object') return data.detail.code || null;
  return null;
}

function errorMessage(data, status) {
  const err = data && data.error;
  if (err && typeof err === 'object') return err.message || err.code || 'HTTP ' + status;
  if (typeof err === 'string') return err;
  const detail = data && data.detail;
  if (detail && typeof detail === 'object') return detail.message || detail.code || 'HTTP ' + status;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail) && detail.length) {
    return detail.map(d => d.msg || JSON.stringify(d)).join('; ');
  }
  return 'HTTP ' + status;
}

// ---------- 绑定状态持久化 ----------
function loadBinding() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf-8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    if (!data.base_url || !data.username) return null;
    return data;
  } catch (e) {
    return null;
  }
}

function saveBinding(binding) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(binding, null, 2), 'utf-8');
  fs.renameSync(tmp, STATE_PATH);
  return binding;
}

function clearBinding() {
  try { fs.unlinkSync(STATE_PATH); } catch (e) { /* 未绑定 */ }
}

// 前端可见视图:绝不回传密码与 token
function publicBinding(binding) {
  if (!binding) {
    return { bound: false, default_base_url: DEFAULT_BASE_URL, channels: [], channels_at: null, account: null, username: '', base_url: '' };
  }
  return {
    bound: true,
    base_url: binding.base_url,
    username: binding.username,
    account: binding.account || null,
    channels: (binding.channels || []).map((c, index) => ({
      id: c.id,
      name: derivedChannelName(c, index),
      url: c.url
    })),
    channels_at: binding.channels_at || null,
    session_expires_at: binding.token_at ? new Date(binding.token_at + LOGIN_TTL_MS).toISOString() : null,
    default_base_url: DEFAULT_BASE_URL
  };
}

// ---------- HTTP ----------
async function rawFetch(url, options, timeoutMs, baseUrl) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const name = e && e.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error('连接视频网站超时:' + baseUrl);
    }
    const code = (e && e.cause && e.cause.code) || (e && e.code) || (e && e.message) || '网络错误';
    throw new Error('无法连接视频网站 ' + baseUrl + '(' + code + '),请确认地址与网络');
  }
}

async function login(binding) {
  const base = binding.base_url.replace(/\/+$/, '');
  const resp = await rawFetch(base + '/identity/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username: binding.username, password: binding.password })
  }, SHORT_TIMEOUT_MS, binding.base_url);

  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }

  if (!resp.ok) {
    if (resp.status === 401 || errorCode(data) === 'invalid_credentials') {
      throw new Error('视频网站用户名或密码错误');
    }
    throw new Error('视频网站登录失败:' + errorMessage(data, resp.status));
  }
  if (!data || !data.token) throw new Error('视频网站登录响应缺少 token');

  binding.token = data.token;
  binding.token_at = Date.now();
  binding.account = data.account || null;
  saveBinding(binding);
  return binding;
}

async function ensureToken(binding) {
  const fresh = binding.token && binding.token_at
    && Date.now() - binding.token_at < LOGIN_TTL_MS - TOKEN_SAFETY_MS;
  if (fresh) return binding;
  if (!binding.username || !binding.password) {
    throw new Error('视频网站会话已过期,请在设置页重新绑定账号');
  }
  return login(binding);
}

async function apiCall(binding, pathname, options = {}) {
  const base = binding.base_url.replace(/\/+$/, '');
  const timeout = options.timeout || SHORT_TIMEOUT_MS;
  const run = async () => {
    const headers = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (binding.token) headers.Authorization = 'Bearer ' + binding.token;
    const resp = await rawFetch(base + pathname, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    }, timeout, binding.base_url);

    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }

    if (!resp.ok) {
      const err = new Error(errorMessage(data, resp.status));
      err.status = resp.status;
      err.code = errorCode(data);
      throw err;
    }
    return data;
  };

  try {
    return await run();
  } catch (e) {
    // 会话失效(401):用已保存的账号密码重登一次再重试
    if (e.status === 401 && binding.username && binding.password) {
      await login(binding);
      return run();
    }
    throw e;
  }
}

// ---------- 业务动作 ----------
async function fetchChannels(binding) {
  await ensureToken(binding);
  const list = await apiCall(binding, '/identity/channels');
  // 缓存里只存接口原始 name(可能为空):「频道 NN」是按序号派生的展示名,
  // 一旦固化进缓存,频道增删导致序号漂移时就不会再更新。
  const channels = (Array.isArray(list) ? list : []).map(c => ({
    id: c.id,
    name: String(c.name || '').trim(),
    url: c.url || '',
    default_visual_style: c.default_visual_style || '',
    default_character_image_ids: Array.isArray(c.default_character_image_ids) ? c.default_character_image_ids : [],
    default_voice_version_id: c.default_voice_version_id || null,
    default_cloned_voice_id: c.default_cloned_voice_id || null,
    default_tts_provider: c.default_tts_provider || 'cosyvoice'
  }));
  binding.channels = channels;
  binding.channels_at = new Date().toISOString();
  saveBinding(binding);
  // 调用方拿到的是可直接展示/记入任务的派生名
  return channels.map((c, index) => ({ ...c, name: derivedChannelName(c, index) }));
}

// 绑定:登录校验 + 首次拉取频道
async function bind({ base_url, username, password }) {
  const binding = {
    base_url: normalizeBaseUrl(base_url),
    username: String(username || '').trim(),
    password: String(password || ''),
    token: null,
    token_at: 0,
    account: null,
    channels: [],
    channels_at: null
  };
  if (!binding.username) throw new Error('请填写视频网站用户名');
  if (!binding.password) throw new Error('请填写视频网站密码');
  await login(binding);
  await fetchChannels(binding);
  return binding;
}

function findChannel(binding, channelId) {
  const list = binding.channels || [];
  const index = list.findIndex(c => c.id === channelId);
  if (index < 0) return null;
  return { ...list[index], name: derivedChannelName(list[index], index) };
}

// 建项目前的频道侧前置校验:视频后端也会拦,这里提前给出可读提示 + 引导去视频网站配置
function assertChannelReady(channel) {
  if (!channel) throw new Error('该任务的频道在视频网站已不存在,请重新选择频道');
  const images = channel.default_character_image_ids || [];
  if (!images.length) {
    throw new Error('频道「' + channel.name + '」未配置默认角色图,请先到视频网站「频道管理」中设置');
  }
  if (!String(channel.default_visual_style || '').trim()) {
    throw new Error('频道「' + channel.name + '」未配置默认画面风格,请先到视频网站「频道管理」中设置');
  }
  const hasCosy = channel.default_tts_provider === 'cosyvoice'
    ? !!channel.default_voice_version_id
    : !!channel.default_cloned_voice_id;
  if (!hasCosy) {
    throw new Error('频道「' + channel.name + '」未配置默认音色,请先到视频网站「频道管理」中设置');
  }
}

function buildProjectPayload({ title, channel, script, locale }) {
  return {
    title: String(title || '').trim() || 'Untitled project',
    channel_id: channel.id,
    script,
    // 与视频前端创建页一致:用频道默认角色图预填(而非留空)
    character_image_ids: channel.default_character_image_ids,
    // 不传风格/音色 → 后端回落频道默认(已在前置校验里确认存在)
    visual_style: null,
    voice_version_id: null,
    locale,
    aspect_ratio: '16:9'
    // expected_duration_seconds 不传:用户确认不需要按"视频目的(时长)"换算
  };
}

async function createProject(binding, payload) {
  await ensureToken(binding);
  const project = await apiCall(binding, '/identity/projects', { method: 'POST', body: payload });
  if (!project || !project.id) throw new Error('视频网站未返回项目 ID');
  return project;
}

async function startProduction(binding, projectId) {
  await ensureToken(binding);
  return apiCall(binding, '/narration/confirm', {
    method: 'POST',
    body: { project_id: projectId },
    timeout: CONFIRM_TIMEOUT_MS
  });
}

// 把 workflow-summary 收敛成列表/弹窗用的四态:草稿 / 生产中 / 已暂停 / 已完成
function mapSummary(summary) {
  const stage = (summary && summary.stage) || null;
  const auto = (summary && summary.auto_pipeline) || {};
  if (stage === 'DRAFT') return { status: 'draft', stage, stage_label: '草稿', reason: null };
  if (auto.state === 'COMPLETED') return { status: 'completed', stage, stage_label: '已完成', reason: null };
  if (auto.state === 'PAUSED') {
    return { status: 'paused', stage, stage_label: '已暂停', reason: (summary && summary.blocking_reason) || auto.reason_code || null };
  }
  return { status: 'running', stage, stage_label: STAGE_LABELS[stage] || '生产中', reason: null };
}

async function fetchProjectState(binding, projectId) {
  await ensureToken(binding);
  const summary = await apiCall(binding, '/identity/projects/' + projectId + '/workflow-summary');
  return mapSummary(summary);
}

function newPushId() {
  return 'vp_' + crypto.randomBytes(6).toString('hex');
}

module.exports = {
  DEFAULT_BASE_URL,
  LOCALE_BY_LANGUAGE,
  cleanScript,
  localeForLanguage,
  derivedChannelName,
  normalizeBaseUrl,
  loadBinding,
  saveBinding,
  clearBinding,
  publicBinding,
  bind,
  fetchChannels,
  findChannel,
  assertChannelReady,
  buildProjectPayload,
  createProject,
  startProduction,
  fetchProjectState,
  mapSummary,
  newPushId,
  STAGE_LABELS
};
