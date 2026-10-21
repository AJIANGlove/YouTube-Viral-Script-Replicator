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

function listAssets() {
  ensureDirs();
  return fs.readdirSync(ASSETS_ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(ASSETS_ROOT, e.name, 'meta.json'), 'utf-8'));
        return { id: e.name, ...meta };
      } catch (err) { return { id: e.name, name: e.name, broken: true }; }
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
    srt: read('source.srt')
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

function saveRun(run) {
  normalizeRunText(run); // 落盘前归一化,保证磁盘上的标签行永远是规范形态
  run.updated_at = new Date().toISOString();
  fs.writeFileSync(runPath(run.id), JSON.stringify(run, null, 2), 'utf-8');
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

module.exports = { APP_ROOT, ASSETS_ROOT, RUNS_ROOT, ensureDirs, slugify, listAssets, getAsset, saveAsset, deleteAsset, newAssetId, newRun, saveRun, getRun, listRuns, SCRIPT_TEXT_FIELDS, normalizeRunText };
