// 开头留存检查:前 30 秒(现象/冲突/本质)与 30–60 秒(价值承诺)诊断(独立于生成管线的外挂模块,模式对齐 compliance.js)
// 检测 = 单次 LLM 调用产出「分段评估 summary + 可定位命中 hits」;命中原句必须是开头区域(章节起点 < 1:00)内的精确子串。
// 时间判定:与强化开头同一口径 —— 只认章节标签行上的时间区间([CH01 | 0:00–0:26 | tag]),不做语速估算;
// 无章节时间戳的文案由服务端在调用前拒绝(本模块 detect 内再做一次兜底)。
// 替换复用 textloc.applyReplacements(与指纹/商业化同一套双锚点逻辑),本模块不重复实现。
// 本模块不认识 HTTP 与 store,唯一外部依赖是 pipeline.llmCall、checks.stripFence 与 textloc 的章节切分。
const fs = require('fs');
const path = require('path');
const pipeline = require('./pipeline');
const checks = require('./checks');
const { splitChapters, chapterOf } = require('./textloc');

const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'opening_retention_check.md');

const TYPES = ['phenomenon_missing', 'conflict_weak', 'essence_missing', 'value_promise_missing', 'hook_weak', 'promise_mismatch'];
const TYPE_NAMES = {
  phenomenon_missing: '现象缺失',
  conflict_weak: '冲突不足',
  essence_missing: '本质未点明',
  value_promise_missing: '价值承诺缺失',
  hook_weak: '钩子偏弱',
  promise_mismatch: '承诺与内容不符'
};
const MODES = ['replace', 'insert_after'];
const SEGMENTS = ['s0_30', 's30_60'];
const CHECK_STATUSES = ['ok', 'weak', 'missing'];
const CONTENT_TYPES = ['知识拆解', '方法', '认知纠偏', '具体步骤', '混合型', '不明确'];

// 章节标签行(带时间区间):[CH01 | 0:00–0:26 | identity_entry]
// 时间分隔符兼容连字符/ en-dash / em-dash / 波浪线(真实数据为 en-dash,旧数据可能出现连字符)
const CH_TIME_LINE = /^\[CH(\d+)\s*\|\s*(\d{1,2}):(\d{2})\s*[-–—~]\s*(\d{1,2}):(\d{2})\s*\|[^\]]*\]\s*$/;

function fmtSec(s) { return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

// ---------- 章节时间解析 ----------
// 返回 [{ tag, start, end(字符区间), startSec, endSec }],仅含标签行带时间区间的章节
function chapterTimeRanges(script) {
  const timeByTag = {};
  for (const line of script.split('\n')) {
    const m = line.trim().match(CH_TIME_LINE);
    if (m) timeByTag['CH' + m[1]] = { startSec: (+m[2]) * 60 + (+m[3]), endSec: (+m[4]) * 60 + (+m[5]) };
  }
  return splitChapters(script)
    .filter(s => s.tag && timeByTag[s.tag])
    .map(s => ({ tag: s.tag, start: s.start, end: s.end, startSec: timeByTag[s.tag].startSec, endSec: timeByTag[s.tag].endSec }));
}

function hasChapterTimestamps(script) {
  return typeof script === 'string' && chapterTimeRanges(script).length > 0;
}

// ---------- 开头边界:所有「起点 < 1:00」的章节 ----------
// 返回 { chapters, endOffset, note };无任何带时间的章节时返回 null(调用方应拒绝检测)
function openingBoundary(script) {
  const ranges = chapterTimeRanges(script);
  const chapters = ranges.filter(r => r.startSec < 60);
  if (!chapters.length) return null;
  const endOffset = chapters[chapters.length - 1].end;
  const at30 = chapters.find(r => r.startSec < 30 && r.endSec >= 30);
  const list = chapters.map(r => `${r.tag}(${fmtSec(r.startSec)}–${fmtSec(r.endSec)})`).join('、');
  const note = [
    '开头范围(由系统按章节时间标签判定,请勿自行重新估算):',
    `- 前 30 秒 = 0:00–0:30;30–60 秒 = 0:30–1:00`,
    `- 开头覆盖章节:${list}`,
    at30 ? `- 30 秒分界位于 ${at30.tag} 内(该章 ${fmtSec(at30.startSec)}–${fmtSec(at30.endSec)}),章内位置按比例推算` : '- 30 秒分界与章节边界重合',
    '- 所有命中的 original 必须引用上述章节内的正文句子'
  ].join('\n');
  return { chapters, endOffset, note };
}

// ---------- 解析 LLM 输出 ----------
const FAIL_DUMP_DIR = path.join(__dirname, '..', 'data', 'logs');

// 解析失败留痕:原文 + stop_reason 落盘,并返回路径(写盘失败不影响主流程)。
// 没有这一步,失败只能给前端一句固定文案,事后无法判断是"纯文字""截断"还是"顶层数组"。
function dumpFailure(content, stopReason) {
  try {
    fs.mkdirSync(FAIL_DUMP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(FAIL_DUMP_DIR, 'opening_fail_' + ts + '.txt');
    fs.writeFileSync(file, 'stop_reason=' + (stopReason || '(未知)') + '\n\n' + (content || ''), 'utf-8');
    return file;
  } catch (e) { return null; }
}

// 命中过滤:原句必须是全文精确子串且位于开头边界内(否则替换必然失败或越界,直接丢弃);summary 缺失字段给安全默认值
// 解析顺序:直接解析(stripFence)→ 花括号配平捞完整对象(容忍 JSON 前后的解说文字/围栏错位)→ 失败则落盘并抛错
function parseResult(content, script, stopReason) {
  let obj = null;
  try {
    obj = JSON.parse(checks.stripFence(content));
  } catch (e) {
    obj = checks.extractJsonObject(content);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    const file = dumpFailure(content, stopReason);
    const why = stopReason === 'max_tokens' ? '(输出在 max_tokens 处被截断,未形成完整 JSON)' : '(模型返回的正文不是 JSON 对象)';
    const error = new Error('检测结果不是合法 JSON 对象' + why + (file ? ',原文已存 ' + file : ''));
    error.code = 'PARSE_FAILED';
    throw error;
  }

  const s = obj.summary && typeof obj.summary === 'object' && !Array.isArray(obj.summary) ? obj.summary : {};
  const score = v => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(10, Math.round(n * 10) / 10)) : null;
  };
  const str = v => (typeof v === 'string' ? v.trim() : '');
  const check = v => {
    const c = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    return { status: CHECK_STATUSES.includes(c.status) ? c.status : 'weak', note: str(c.note) };
  };
  const seg0 = s.seg_0_30 && typeof s.seg_0_30 === 'object' ? s.seg_0_30 : {};
  const seg1 = s.seg_30_60 && typeof s.seg_30_60 === 'object' ? s.seg_30_60 : {};
  const vp = check(seg1.value_promise);
  const vpCategory = seg1.value_promise && typeof seg1.value_promise === 'object' ? str(seg1.value_promise.category) : '';
  const summary = {
    score_0_30: score(s.score_0_30),
    score_30_60: score(s.score_30_60),
    content_type: CONTENT_TYPES.includes(s.content_type) ? s.content_type : '不明确',
    content_type_note: str(s.content_type_note),
    biggest_problem: str(s.biggest_problem),
    conclusion: str(s.conclusion),
    seg_0_30: { phenomenon: check(seg0.phenomenon), conflict: check(seg0.conflict), essence: check(seg0.essence) },
    seg_30_60: { value_promise: { ...vp, category: CONTENT_TYPES.includes(vpCategory) ? vpCategory : '不明确' } }
  };

  const sections = splitChapters(script);
  const boundary = openingBoundary(script);
  const ranges = boundary ? boundary.chapters : [];
  const hits = [];
  for (const item of Array.isArray(obj.hits) ? obj.hits : []) {
    if (!item || typeof item.original !== 'string' || !item.original.trim()) continue;
    const original = item.original.trim();
    if (CH_TIME_LINE.test(original) || /^\[CH\d+\s*\|[^\]]*\]$/.test(original)) continue; // 章节标签行不可作为命中
    const idx = script.indexOf(original);
    if (idx === -1) continue;
    if (boundary && idx >= boundary.endOffset) continue; // 越出开头边界的引用一律丢弃
    if (!TYPES.includes(item.type)) continue; // 未知类型不猜,直接丢弃
    const inChapter = ranges.find(r => idx >= r.start && idx < r.end);
    hits.push({
      chapter: chapterOf(script, sections, idx),
      original,
      type: item.type,
      segment: SEGMENTS.includes(item.segment) ? item.segment : (inChapter && inChapter.startSec >= 30 ? 's30_60' : 's0_30'),
      mode: MODES.includes(item.mode) ? item.mode : 'replace',
      suggestion: str(item.suggestion),
      original_zh: str(item.original_zh),
      suggestion_zh: str(item.suggestion_zh),
      reason: str(item.reason),
      status: 'pending'
    });
  }
  // 按文中先后顺序
  hits.forEach(h => { h._pos = script.indexOf(h.original); });
  hits.sort((a, b) => a._pos - b._pos);
  hits.forEach((h, i) => { h.id = 'h' + (i + 1); delete h._pos; });
  return { summary, hits };
}

// ---------- 程序实测的开头硬指标(checks.listenCheck 的结果) ----------
const HARD_FAIL_CAP = 6;
function hardFails(lc) {
  if (!lc) return [];
  return lc.issues.filter(i => /前 \d+ 秒/.test(i) || (/一口气念/.test(i) && lc.dense.some(d => d.sec < 60)));
}
function listenNote(lc) {
  if (!lc) return '';
  const o = lc.opening || {};
  const early = (lc.dense || []).filter(d => d.sec < 60);
  return '\n\n程序实测(按配音语速 ' + lc.wpm + ' 词/分钟推算时间,以此为准,不要自己另算):\n' +
    '- 前 10 秒念了 ' + (o.nums_10s || 0) + ' 个数字(硬规则:最多 1 个)\n' +
    '- 标题关键词出现的时间:' + ((o.title_words || []).map(w => w.word + (w.sec == null ? ' 没出现' : ' ' + Math.floor(w.sec / 60) + ':' + String(w.sec % 60).padStart(2, '0'))).join('、') || '(无)') + '(硬规则:8 秒内用一个人或一个场景说出标题里的冲突)\n' +
    '- 前 60 秒一口气念 3 个以上数字的句子:' + (early.length ? early.map(d => '「' + d.text + '」').join(' ') : '无') + '(硬规则:一句最多 2 个数字)\n' +
    '违反硬规则的,每条都要作为命中报告并给出改法;前 30 秒有任何一条违反,score_0_30 不得高于 ' + HARD_FAIL_CAP + '。改法只许删和换,开头不能变长。';
}

// ---------- 检测入口 ----------
async function detect(cfg, script, meta) {
  const boundary = openingBoundary(script);
  if (!boundary) throw new Error('该版本无章节时间戳,无法按 30 秒口径检查');
  const t0 = Date.now();
  const tpl = fs.readFileSync(PROMPT_PATH, 'utf-8');
  const m = meta || {};
  const prompt = tpl
    .replaceAll('{{script}}', script)
    .replaceAll('{{topic}}', m.topic || '(未提供)')
    .replaceAll('{{audience}}', m.audience || '(未提供)')
    .replaceAll('{{opening_note}}', boundary.note + listenNote(m.listen));
  const detectCfg = { ...cfg, temperature: 0 }; // 检测任务关掉随机性
  const messages = [{ role: 'user', content: prompt }];
  let r = await pipeline.llmCall(detectCfg, messages, '开头留存检查');
  let parsed;
  try {
    parsed = parseResult(r.content, script, r.stopReason);
  } catch (e) {
    if (e.code !== 'PARSE_FAILED') throw e;
    // JSON 闸门重试(与生成管线 Step 3 同一策略):把失败原文与该走的要求回灌,只重试一次;
    // 仍失败则抛出,错误信息里带第二次的原文路径
    const repair = [
      ...messages,
      { role: 'assistant', content: r.content },
      { role: 'user', content: '上一次输出不是可直接解析的 JSON 对象(可能夹带了解说文字,或被长度上限截断)。请只重新输出一个完整 JSON 对象:第一行是 {,最后一行是 },不要代码围栏,不要任何解释、分析或前后缀文字,字段与格式严格按原始要求。' }
    ];
    r = await pipeline.llmCall(detectCfg, repair, '开头留存检查 JSON 重试');
    parsed = parseResult(r.content, script, r.stopReason);
  }
  const { summary, hits } = parsed;
  // 程序实测的硬指标没过,前 30 秒的分数最多 6 分(实测 run_2713e3885236 被 AI 打 7 分,观众 0:10–0:20 走了一半)
  const hard = hardFails(m.listen);
  if (hard.length) { summary.hard_fails = hard; if (summary.score_0_30 != null && summary.score_0_30 > HARD_FAIL_CAP) summary.score_0_30 = HARD_FAIL_CAP; }
  return {
    model: cfg.model || '',
    type_names: { ...TYPE_NAMES }, // 前端展示用 {id: 中文名}
    secs: Math.round((Date.now() - t0) / 100) / 10,
    summary,
    hits
  };
}

module.exports = { TYPES, TYPE_NAMES, MODES, SEGMENTS, chapterTimeRanges, hasChapterTimestamps, openingBoundary, parseResult, detect };
