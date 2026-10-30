// 任务列表「主题」中文对照:把外文主题(韩/英/日…)译成中文,显示在原文下方一行。
// 数据落在 data/topic_zh.json(按**主题文本**缓存,同一选题的多个任务共用一条翻译),不入库。
//
// 调用时机:只有 GET /api/runs 会调 ensure()——缺译的主题排队后台翻译,本次响应先不带译文,
// 3 秒轮询自然补上。不在建任务时同步翻译(会拖慢建任务),也不在启动时全量跑(会白烧 token)。
// 与生成管线解耦:只复用 loadTweakConfig/llmCall(走「微调按钮」渠道,本项目默认 DeepSeek)。
// 不写 prompts/*.md:三行翻译指令内联即可,免得为它维护一份提示词表和 README 行数。
const fs = require('fs');
const path = require('path');
const { loadTweakConfig, llmCall } = require('./pipeline');

const CACHE_PATH = path.join(__dirname, '..', 'data', 'topic_zh.json');
const CACHE_VERSION = 1;
const MAX_LEN = 120;                 // 译文上限,防模型夹带解释
const RETRY_COOLDOWN_MS = 10 * 60 * 1000; // 失败后 10 分钟内不再试,避免列表轮询反复点火
const MAX_FAILS = 3;                 // 同一主题连续失败 3 次后放弃(重启进程才重置)

// 主题已经是中文就不翻译(显示中文译文等于把原文重复一遍)
function isChinese(s) {
  const text = String(s || '');
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const letters = (text.match(/[A-Za-z\uac00-\ud7af\u3040-\u30ff]/g) || []).length;
  return cjk > 0 && cjk >= letters;
}

// ---------- 缓存读写 ----------
let cache = null;   // { version, items: { [topic]: { zh, at, model, skipped? } } }
let cacheMtime = 0;

function loadCache() {
  if (cache) return cache;
  try {
    const st = fs.statSync(CACHE_PATH);
    const disk = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    if (disk && disk.version === CACHE_VERSION && disk.items) {
      cache = disk;
      cacheMtime = st.mtimeMs;
      return cache;
    }
  } catch (e) {}
  cache = { version: CACHE_VERSION, items: {} };
  return cache;
}

// 先写临时文件再 rename:后台翻译可能和手工编辑/另一个实例撞上,别留半截 JSON
function saveCache() {
  if (!cache) return;
  cache.updated_at = new Date().toISOString();
  try {
    const tmp = CACHE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 1), 'utf-8');
    fs.renameSync(tmp, CACHE_PATH);
    cacheMtime = fs.statSync(CACHE_PATH).mtimeMs;
  } catch (e) {
    console.error('主题译文缓存写入失败:', e.message);
  }
}

// 外部(脚本/手工)改过文件时重新加载,不用重启进程
function refreshIfChanged() {
  try {
    const st = fs.statSync(CACHE_PATH);
    if (st.mtimeMs !== cacheMtime) cache = null;
  } catch (e) {}
}

// ---------- 查询 ----------
// 返回可直接展示的中文;没有译文(未译/翻译中/原文即中文)时返回空串
function get(topic) {
  const key = String(topic || '').trim();
  if (!key) return '';
  refreshIfChanged();
  const hit = loadCache().items[key];
  return hit && hit.zh ? hit.zh : '';
}

// ---------- 翻译 ----------
const fails = new Map(); // topic -> { count, at }

function canTry(key) {
  const f = fails.get(key);
  if (!f) return true;
  if (f.count >= MAX_FAILS) return false;
  return Date.now() - f.at > RETRY_COOLDOWN_MS;
}

function cleanOutput(raw) {
  let s = String(raw || '').trim();
  s = s.split('\n').map(x => x.trim()).filter(Boolean)[0] || '';
  s = s.replace(/^(译文|中文|翻译)\s*[:：]\s*/, '');
  s = s.replace(/^["'“”「」『』]+|["'“”「」『』]+$/g, '').trim();
  return s.slice(0, MAX_LEN);
}

const PROMPT = [
  '把下面的视频选题标题翻译成简体中文。',
  '只输出译文本身:不要引号、不要解释、不要保留原文、不要加任何前后缀。',
  '如果原文已经是中文,原样返回。',
  '',
  '标题:'
].join('\n');

// 单条翻译:成功返回中文(原文即中文时返回 ''),失败抛错
async function translateOne(topic, cfg) {
  const c = cfg || loadTweakConfig();
  if (!c || !c.api_key) throw new Error('未配置微调渠道 API Key');
  const messages = [{ role: 'user', content: PROMPT + '\n' + topic }];
  const r = await llmCall({ ...c, temperature: 0.2, max_tokens: 200 }, messages, '主题翻译');
  const zh = cleanOutput(r.content);
  return zh && zh !== topic ? zh : '';
}

// 把结果写进缓存(成功与「原文即中文」都落盘,后者存 skipped 避免反复翻译)
function put(key, zh) {
  loadCache().items[key] = zh
    ? { zh, at: new Date().toISOString() }
    : { zh: '', at: new Date().toISOString(), skipped: 'zh' };
  saveCache();
}

// ---------- 后台队列(列表轮询触发) ----------
const queue = [];
const queued = new Set();
let pumping = false;

function enqueue(topic) {
  const key = String(topic || '').trim();
  if (!key || queued.has(key)) return;
  const known = loadCache().items[key];
  if (known) return;
  if (isChinese(key)) { put(key, ''); return; } // 中文主题直接记空,不排队
  if (!canTry(key)) return;
  queued.add(key);
  queue.push(key);
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const key = queue.shift();
      queued.delete(key);
      try {
        const zh = await translateOne(key);
        put(key, zh);
      } catch (e) {
        const f = fails.get(key) || { count: 0, at: 0 };
        fails.set(key, { count: f.count + 1, at: Date.now() });
        console.error(`主题翻译失败(${key.slice(0, 24)}): ${e.message}`);
      }
    }
  } finally {
    pumping = false;
  }
}

// 列表接口调用:把本页还没译的主题排进队列,立刻返回(不 await)
function ensure(topics) {
  if (!Array.isArray(topics) || !topics.length) return;
  refreshIfChanged();
  topics.forEach(enqueue);
  if (queue.length) pump();
}

// ---------- 批量补译(命令行 / 维护用) ----------
// 串行改为小并发:55 个主题各 1~2 秒,并发 4 大约半分钟跑完
async function backfill(opts) {
  const o = opts || {};
  const concurrency = Math.max(1, Math.min(8, Number(o.concurrency) || 4));
  const force = !!o.force;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const cfg = loadTweakConfig();
  if (!cfg || !cfg.api_key) throw new Error('未配置微调渠道 API Key,无法翻译');

  refreshIfChanged();
  const topics = [...new Set((o.topics || []).map(t => String(t || '').trim()).filter(Boolean))];
  const items = loadCache().items;
  // 中文主题永远跳过;force 只对「已有译文但想重译」生效
  const todo = topics.filter(t => (isChinese(t) ? false : (force ? true : !items[t])));
  log(`共 ${topics.length} 个主题,待翻译 ${todo.length} 个(并发 ${concurrency})`);

  let ok = 0, skipped = 0, failed = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const key = todo[cursor++];
      try {
        const zh = await translateOne(key, cfg);
        put(key, zh);
        if (zh) { ok += 1; log(`✓ ${key.slice(0, 40)} → ${zh}`); }
        else { skipped += 1; log(`· ${key.slice(0, 40)}(原文即中文,跳过)`); }
      } catch (e) {
        failed += 1;
        log(`✗ ${key.slice(0, 40)}: ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length || 1) }, worker));
  return { total: topics.length, todo: todo.length, ok, skipped, failed };
}

module.exports = { get, ensure, translateOne, backfill, isChinese, CACHE_PATH, loadCache };
