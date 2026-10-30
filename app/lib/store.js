// 资产库与生成记录的持久化(文件系统)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const textnorm = require('./textnorm');

const APP_ROOT = path.join(__dirname, '..');
const ASSETS_ROOT = path.join(APP_ROOT, '..', 'assets');
const RUNS_ROOT = path.join(APP_ROOT, 'data', 'runs');

function ensureDirs() {
  fs.mkdirSync(ASSETS_ROOT, { recursive: true });
  fs.mkdirSync(RUNS_ROOT, { recursive: true });
}

function slugify(title) {
  return (title || 'untitled')
    .toLowerCase()
    .replace(/[—–]/g, '-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

// ---------- 资产 ----------
function assetDir(id) { return path.join(ASSETS_ROOT, id); }

// 框架库分类筛选:assets/_library/asset_categories.json 里按终审 5 赛道人工归类
// 只用于浏览筛选,不参与 autoTrack;按 mtime 缓存,改分类文件后不必重启进程
const CATEGORIES_FILE = path.join(ASSETS_ROOT, '_library', 'asset_categories.json');
let catCache = { mtime: 0, tracks: [], items: {} };

function loadAssetCategories() {
  let mtime = 0;
  try { mtime = fs.statSync(CATEGORIES_FILE).mtimeMs; } catch (e) {}
  if (mtime && mtime === catCache.mtime) return catCache;
  try {
    const j = JSON.parse(fs.readFileSync(CATEGORIES_FILE, 'utf-8'));
    catCache = {
      mtime,
      tracks: (j.cats || []).filter(c => c && c.key).map(c => ({ key: c.key, name: c.name || c.key })),
      items: j.items || {}
    };
  } catch (e) {
    // 文件缺失或损坏时退化为"无分类",不影响资产列表本身
    catCache = { mtime: 0, tracks: [], items: {} };
  }
  return catCache;
}

// 分类定义(顺序即前端 chip 顺序)
function assetCategories() { return loadAssetCategories().tracks; }

function listAssets() {
  ensureDirs();
  const cats = loadAssetCategories();
  return fs.readdirSync(ASSETS_ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('_')) // _library 等下划线目录是汇总产物,不是资产
    .map(e => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(ASSETS_ROOT, e.name, 'meta.json'), 'utf-8'));
        // track: 分类 key(cats 里没有则为空串=未分类),不写回 meta.json
        return { id: e.name, ...meta, track: cats.items[e.name] || '' };
      } catch (err) { return { id: e.name, name: e.name, broken: true, track: '' }; }
    })
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

function getAsset(id) {
  const dir = assetDir(id);
  if (!fs.existsSync(dir)) return null;
  const read = f => { try { return fs.readFileSync(path.join(dir, f), 'utf-8'); } catch (e) { return null; } };
  return {
    id,
    meta: JSON.parse(read('meta.json') || '{}'),
    framework: read('framework.json'),
    timeline: read('timeline.json'),
    style: read('style.json'),
    examples: read('examples.json'),
    srt: read('source.srt'),
    retention_cards: read('retention_cards.json') // 可选:bin/build_retention_cards.js 生成的 7 项留存卡(可人工修改)
  };
}

function saveAsset(id, meta, files) {
  const dir = assetDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
  for (const key of ['framework', 'timeline', 'style', 'examples']) {
    fs.writeFileSync(path.join(dir, key + '.json'), files[key], 'utf-8');
  }
  if (files.srt) fs.writeFileSync(path.join(dir, 'source.srt'), files.srt, 'utf-8');
}

function deleteAsset(id) {
  const dir = assetDir(id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function newAssetId(title) {
  let slug = slugify(title);
  let id = slug, i = 2;
  while (fs.existsSync(assetDir(id))) id = slug + '-' + (i++);
  return id;
}

// ---------- 生成记录 ----------
function runPath(id) { return path.join(RUNS_ROOT, id + '.json'); }

// 整篇脚本文本字段:读写两侧统一归一化章节标签行(只剥 Markdown 装饰,正文逐字节不变)
// 不纳入 outputs.stepN —— 它们保留模型原始输出用于审计,消费点(pipeline/迁移工具)各自归一化
const SCRIPT_TEXT_FIELDS = ['final_script', 'script_v1', 'script_v2', 'script_v1_5', 'script_v2_5'];

// 原地改写 run 的脚本字段并返回同一对象(幂等)。注意:saveRun 会改写调用方持有的对象,
// 调用方不要在 saveRun 之后再用 getRun 之前拿到的旧字符串做等值/偏移比较。
function normalizeRunText(run) {
  if (!run || typeof run !== 'object') return run;
  for (const k of SCRIPT_TEXT_FIELDS) {
    if (typeof run[k] === 'string') run[k] = textnorm.normalizeChapterTags(run[k]);
  }
  return run;
}

function newRun(data) {
  const id = 'run_' + crypto.randomBytes(6).toString('hex');
  const run = {
    id,
    status: 'queued', // queued → running → done | failed
    current_step: 0,
    steps: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...data
  };
  saveRun(run);
  return run;
}

function saveRun(run, opts) {
  normalizeRunText(run); // 落盘前归一化,保证磁盘上的标签行永远是规范形态
  // 标记爆款这类"非生成本身"的变更不刷新 updated_at,否则已完成任务的"结束时间"会被改写
  if (!opts || opts.touch !== false) run.updated_at = new Date().toISOString();
  fs.writeFileSync(runPath(run.id), JSON.stringify(run, null, 2), 'utf-8');
  updateIndexEntry(run); // 同步索引,避免下次读取时因指纹变化触发整体重建
}

// 标记/取消爆款(行级,不绑定版本文案);返回最新 run,saveRun 会同步索引
function setRunViral(id, marked) {
  const run = getRun(id);
  if (!run) return null;
  run.viral = { marked: !!marked, marked_at: marked ? new Date().toISOString() : null };
  saveRun(run, { touch: false });
  return run;
}

// 确认文案版本(行级单一值,再点一次取消):version 为空即取消。
// hash 记录确认时该版文本指纹,详情页据此提示"确认后内容被改过";不刷新 updated_at,免得改写结束时间
function setRunConfirmed(id, version, hash) {
  const run = getRun(id);
  if (!run) return null;
  run.confirmed_version = version
    ? { version, at: new Date().toISOString(), hash: hash || null }
    : null;
  saveRun(run, { touch: false });
  return run;
}

function getRun(id) {
  // 读取侧同样归一化:存量脏数据不必等迁移脚本就能被强化/留存检查正常解析
  try { return normalizeRunText(JSON.parse(fs.readFileSync(runPath(id), 'utf-8'))); } catch (e) { return null; }
}

function listRuns() {
  ensureDirs();
  return fs.readdirSync(RUNS_ROOT)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(RUNS_ROOT, f), 'utf-8')); } catch (e) { return null; } })
    .filter(Boolean)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

// ---------- 任务列表索引 ----------
// 列表只需要少量字段,但单个 run 文件平均 100KB+(存了全部版本文案/输出/检测结果),
// 每次都全量解析会让列表页随任务数增长线性变慢。这里维护 data/runs.index.json:
//   { version, built_at, files: { 'run_x.json': {mtime_ms,size} }, items: [列表字段] }
// 读取前用 readdir+stat 校验文件指纹,不一致(新增/删除/被外部改写)就整体重建;
// 正常写入路径由 saveRun 直接维护,不会触发重建。
const RUNS_INDEX = path.join(APP_ROOT, 'data', 'runs.index.json');
// 3: 新增 active_pass(列表"进行中"副标),旧索引会因版本不符自动重建
// 4: 新增 score(列表"评分"列:审稿报告分 + 终审七维平均),同上
// 5: 合并上游 v1.21.5 的 verdict / reframe / analysis_confirmed(列表「待换框架」「换框架中」)。
//    上游把这三个字段也叫 4,与本地 v1.23 评分列的 4 撞号;合并后升 5 强制重建一次,两 schema 字段齐全
const INDEX_VERSION = 5;
let indexCache = null;

// 源标题中文只用于列表副标题,按资产 id 缓存,避免重复读 meta.json
const assetZhCache = new Map();
function assetTitleZh(assetId) {
  if (!assetId) return '';
  if (assetZhCache.has(assetId)) return assetZhCache.get(assetId);
  let zh = '';
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(ASSETS_ROOT, assetId, 'meta.json'), 'utf-8'));
    zh = meta.source_title_zh || '';
  } catch (e) {}
  assetZhCache.set(assetId, zh);
  return zh;
}

function runFileStats() {
  ensureDirs();
  const out = {};
  for (const f of fs.readdirSync(RUNS_ROOT)) {
    if (!f.endsWith('.json')) continue;
    try {
      const st = fs.statSync(path.join(RUNS_ROOT, f));
      out[f] = { mtime_ms: Math.round(st.mtimeMs), size: st.size };
    } catch (e) {}
  }
  return out;
}

// 列表「进行中」副标:判断当前真正跑到哪个阶段。
// 写稿四步与各 pass 都会往 steps[key] 写 status='running'(pass 还带 stage 细阶段),
// 这里取 started_at 最新的那个;崩溃残留的假 running 会一起出现,取最近的才对得上用户看到的进度。
const ACTIVE_STEP_LABELS = {
  analysis: '写前分析',
  auto_adjust: 'AI 调整',
  blueprint: '第1步 蓝图',
  script: '第2步 脚本',
  audit: '第3步 审核',
  optimized: '第4步 优化',
  opening_boost: '第5步 强化开头',
  opening_card: '强化开头',
  script_check: '稿件检查',
  draft_check: '初稿检查',
  reverse_audit: '二稿审稿报告',
  review_zh: '翻译对照',
  final_review: '终审',
  final_open: '复审补改',
  final_options: '终审选改法',
  deai: '去AI感'
};
const ACTIVE_STATUSES = new Set(['running', 'analyzing', 'awaiting_review']);
const GEN_STEP_KEYS = ['', 'blueprint', 'script', 'audit', 'optimized'];

function activePass(run) {
  if (!ACTIVE_STATUSES.has(run.status || '')) return null;
  const steps = run.steps || {};
  let best = null;
  for (const key of Object.keys(ACTIVE_STEP_LABELS)) {
    const s = steps[key];
    if (!s || s.status !== 'running') continue;
    const at = s.started_at || '';
    if (!best || at > best.at) best = { key, label: ACTIVE_STEP_LABELS[key], stage: s.stage || '', at };
  }
  // at 用 run.updated_at:阶段切换都会落盘,长时间没有新落盘 = 这一阶段卡住了,
  // 前端据此把「呼吸圆点」转灰(stage 本身不带时间戳,用 started_at 会把长阶段误判成卡死)
  if (best) return { ...best, at: run.updated_at || best.at };
  // 兜底:步骤记录缺失(老任务/被外部清过)时按 current_step 推
  if (run.status === 'running') {
    const n = Number(run.current_step) || 0;
    const key = GEN_STEP_KEYS[n];
    if (key) return { key, label: ACTIVE_STEP_LABELS[key], stage: '', at: run.updated_at || '' };
  }
  return null;
}

// 列表「评分」列:二稿审稿报告分(0-100) 与 终审七维平均分(0-10)。
// 两个分数口径不同,只分开展示,不加权、不合成;还没跑到该阶段的就是 null。
// 七维平均取 review.final.scores_after(最后一次复审/补改后的分数),按 dims 过滤,
// dims 缺失时(极少见)退回对 scores_after 的全部数值取平均。
function scoreSummary(run) {
  const stepScore = ((run.steps || {}).reverse_audit || {}).score;
  const fin = (run.review || {}).final || {};
  const after = fin.scores_after || {};
  const dims = Array.isArray(fin.dims) ? fin.dims : [];
  const xs = (dims.length ? dims.map(d => after[d]) : Object.values(after))
    .filter(x => typeof x === 'number' && isFinite(x));
  return {
    audit: typeof stepScore === 'number' && isFinite(stepScore) ? stepScore : null,
    final: xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 10) / 10 : null
  };
}

// 列表字段子集:视频推送只留原始字段,status_label/project_url 由调用方按当前绑定的 base_url 现算
function indexEntry(run) {
  const pushes = Array.isArray(run.video_pushes) ? run.video_pushes : [];
  const p = pushes.length ? pushes[pushes.length - 1] : null;
  return {
    id: run.id,
    topic: run.topic || '',
    asset_id: run.asset_id || '',
    asset_name: run.asset_name || run.asset_id || '',
    asset_zh: assetTitleZh(run.asset_id),
    status: run.status || '',
    current_step: run.current_step || 0,
    // 列表状态列第二行:当前跑到哪个阶段(仅进行中的任务有值)
    active_pass: activePass(run),
    // 列表「评分」列:审稿报告分 + 终审七维平均(口径不同,分开存)
    score: scoreSummary(run),
    // 列表「待换框架/换框架中」状态(上游 v1.21.5):索引里没有 analysis,没这三个字段时列表只能显示「AI 调整中」
    verdict: (run.analysis || {}).verdict || '',
    reframe: run.reframe ? { status: run.reframe.status || '', switched: Array.isArray(run.reframe.switched) ? run.reframe.switched.length : 0 } : null,
    analysis_confirmed: !!run.analysis_confirmed,
    created_at: run.created_at || '',
    updated_at: run.updated_at || '',
    has_error: !!run.error,
    audience: run.audience || {},
    channel_id: run.channel_id || null,
    channel_name: run.channel_name || null,
    draft_first: !!run.draft_first,
    boost_opening: !!run.boost_opening || !!((run.steps || {}).opening_boost),
    opening_boosted: !!run.opening_boosted,
    viral: { marked: !!(run.viral && run.viral.marked), marked_at: (run.viral && run.viral.marked_at) || null },
    // 确认文案版本:列表只展示版本号与确认时间,内容是否已改由详情页现算(索引不存文本哈希)
    confirmed: (run.confirmed_version && run.confirmed_version.version)
      ? { version: run.confirmed_version.version, at: run.confirmed_version.at || null }
      : null,
    video: p ? {
      push_id: p.push_id || null,
      version: p.version || null,
      mode: p.mode || null,
      status: p.status || null,
      stage: p.stage || null,
      stage_label: p.stage_label || null,
      project_id: p.project_id || null,
      channel_id: p.channel_id || null,
      channel_name: p.channel_name || '',
      error: p.error || null,
      created_at: p.created_at || null,
      updated_at: p.updated_at || null
    } : null
  };
}

function indexStatsEqual(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const x = a[k], y = b[k];
    if (!y || x.size !== y.size || x.mtime_ms !== y.mtime_ms) return false;
  }
  return true;
}

function buildIndex() {
  const files = runFileStats();
  const items = [];
  for (const f of Object.keys(files)) {
    try {
      const run = JSON.parse(fs.readFileSync(path.join(RUNS_ROOT, f), 'utf-8'));
      if (run && run.id) items.push(indexEntry(run));
    } catch (e) {} // 损坏的 run 文件跳过,不影响其它任务
  }
  items.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  return { version: INDEX_VERSION, built_at: new Date().toISOString(), files, items };
}

// 先写临时文件再 rename:多任务并发写时不会读到半截 JSON
function writeIndex(idx) {
  const tmp = RUNS_INDEX + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(idx), 'utf-8');
  fs.renameSync(tmp, RUNS_INDEX);
}

function loadIndex() {
  const files = runFileStats();
  if (indexCache && indexStatsEqual(indexCache.files, files)) return indexCache;
  try {
    const disk = JSON.parse(fs.readFileSync(RUNS_INDEX, 'utf-8'));
    if (disk && disk.version === INDEX_VERSION && Array.isArray(disk.items) && indexStatsEqual(disk.files || {}, files)) {
      indexCache = disk;
      return disk;
    }
  } catch (e) {}
  const rebuilt = buildIndex();
  indexCache = rebuilt;
  try { writeIndex(rebuilt); } catch (e) {}
  return rebuilt;
}

function updateIndexEntry(run) {
  const fileKey = run.id + '.json';
  let statEntry = null;
  try {
    const st = fs.statSync(runPath(run.id));
    statEntry = { mtime_ms: Math.round(st.mtimeMs), size: st.size };
  } catch (e) {}
  // 刚写完的文件指纹先并入缓存,否则 loadIndex 会把这次写入当成"外部改写"而整体重建
  if (indexCache && statEntry) indexCache.files[fileKey] = statEntry;
  const idx = loadIndex();
  const entry = indexEntry(run);
  const i = idx.items.findIndex(x => x.id === run.id);
  if (i >= 0) idx.items[i] = entry; else idx.items.push(entry);
  idx.items.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  if (statEntry) idx.files[fileKey] = statEntry;
  idx.built_at = new Date().toISOString();
  indexCache = idx;
  try { writeIndex(idx); } catch (e) {}
}

function facetCounts(items) {
  const status = {}, language = {}, video = {};
  for (const it of items) {
    status[it.status || '?'] = (status[it.status || '?'] || 0) + 1;
    const lang = (it.audience || {}).target_language || '';
    if (lang) language[lang] = (language[lang] || 0) + 1;
    const vs = it.video && it.video.status ? it.video.status : 'none';
    video[vs] = (video[vs] || 0) + 1;
  }
  return { status, language, video };
}

// 列表查询:筛选 + 分页全部在服务端完成,前端只拿当前页。
// from/to 为 ISO 时间(含边界),按 created_at 比较;ISO 字符串可直接字典序比较
function queryRuns(opts) {
  opts = opts || {};
  const idx = loadIndex();
  const q = String(opts.q || '').trim().toLowerCase();
  const statuses = Array.isArray(opts.statuses) ? opts.statuses : [];
  const languages = Array.isArray(opts.languages) ? opts.languages : [];
  const videos = Array.isArray(opts.videos) ? opts.videos : [];
  const from = opts.from || '';
  const to = opts.to || '';

  const filtered = idx.items.filter(it => {
    if (statuses.length && !statuses.includes(it.status)) return false;
    if (languages.length) {
      const lang = (it.audience || {}).target_language || '';
      if (!languages.includes(lang)) return false;
    }
    if (videos.length) {
      const vs = it.video && it.video.status ? it.video.status : 'none';
      if (!videos.includes(vs)) return false;
    }
    if (opts.viralOnly && !(it.viral && it.viral.marked)) return false;
    if (from && (it.created_at || '') < from) return false;
    if (to && (it.created_at || '') > to) return false;
    if (q) {
      const hay = [it.topic, it.asset_name, it.asset_zh, it.channel_name, it.id].filter(Boolean).join('\n').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const total = filtered.length;
  const pageSize = Math.min(200, Math.max(1, Number(opts.pageSize) || 50));
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Number(opts.page) || 1));
  const start = (page - 1) * pageSize;
  return {
    items: filtered.slice(start, start + pageSize),
    total,
    total_all: idx.items.length,
    page,
    pages,
    page_size: pageSize,
    facets: facetCounts(idx.items),
    built_at: idx.built_at
  };
}

module.exports = {
  APP_ROOT, ASSETS_ROOT, RUNS_ROOT, ensureDirs, slugify,
  listAssets, getAsset, saveAsset, deleteAsset, newAssetId, assetCategories,
  newRun, saveRun, getRun, listRuns, setRunViral, setRunConfirmed,
  queryRuns, RUNS_INDEX, SCRIPT_TEXT_FIELDS, normalizeRunText
};
