// YouTube 商业化检查:原创性与 YPP 合规审计(独立于生成管线的外挂模块,模式对齐 fingerprint.js)
// 检测 = 单次 LLM 调用产出「总体评估 summary + 可定位命中 hits」;命中原句必须是全文精确子串才可被替换。
// 替换复用 textloc.applyReplacements(与指纹检测同一套双锚点逻辑),本模块不重复实现。
// 本模块不认识 HTTP 与 store,唯一外部依赖是 pipeline.llmCall 与 checks.stripFence。
const fs = require('fs');
const path = require('path');
const pipeline = require('./pipeline');
const checks = require('./checks');
const { splitChapters, chapterOf } = require('./textloc');

const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'compliance_check.md');

const TYPES = ['originality', 'template', 'ai_feel', 'reused'];
const TYPE_NAMES = {
  originality: '原创性不足',
  template: '模板感',
  ai_feel: 'AI生成感',
  reused: 'YPP低原创风险'
};
const SEVERITIES = ['high', 'medium', 'low'];
const SEV_RANK = { high: 0, medium: 1, low: 2 };
const RATINGS = ['低', '中', '高'];
const RISK_LEVELS = ['安全', '需要优化', '高风险'];

// 任务语言是唯一来源;不根据原文或已修改的 .5 文案推断,也不默认英文。
function requireTargetLanguage(value) {
  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error('任务缺少目标语言 target_language，无法进行商业化检查或替换');
    error.code = 'TARGET_LANGUAGE_REQUIRED';
    throw error;
  }
  return value.trim();
}

// ---------- 解析 LLM 输出 ----------
const FAIL_DUMP_DIR = path.join(__dirname, '..', 'data', 'logs');

// 解析失败留痕:原文 + stop_reason 落盘(与 opening 同一口径),返回路径;写盘失败不影响主流程
function dumpFailure(content, stopReason) {
  try {
    fs.mkdirSync(FAIL_DUMP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(FAIL_DUMP_DIR, 'compliance_fail_' + ts + '.txt');
    fs.writeFileSync(file, 'stop_reason=' + (stopReason || '(未知)') + '\n\n' + (content || ''), 'utf-8');
    return file;
  } catch (e) { return null; }
}

// 命中过滤:原句必须是全文精确子串(否则替换必然失败,直接丢弃该条);summary 缺失字段给安全默认值
// 解析顺序:直接解析(stripFence)→ 花括号配平捞完整对象(容忍解说文字/围栏错位)→ 失败则落盘并抛错
// 免责/软化句式(韩/英/日/中)
const HEDGE_RE = /단정(하기|할 수|짓기)[^.?!\n]{0,6}(어렵|없|보다)|(적용|해석|확정|일반화)하기(는|가) 어렵|일반화(하기|할 수)[^.?!\n]{0,6}(어렵|없)|(매장|지역|브랜드|계약)[^.?!\n]{0,12}(마다|별로)[^.?!\n]{0,12}(다릅니다|다르다|달라질 수)|달라질 수 있(습니다|어)|보기는 어렵|may vary|varies by|hard to generali[sz]e|cannot be generali[sz]ed|一概には言え|断定はでき|因(店|地|人)而异|不能一概而论|难以一概|不宜一概/i;

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
  // 冲突由模型按提示词报告;这里只解析错误契约,不做语种识别或自动纠正。
  if (obj.error != null) {
    const message = typeof obj.error.message === 'string' ? obj.error.message.trim() : '';
    const error = new Error(message || '商业化检查返回错误，未生成可采纳建议');
    if (obj.error.code === 'TARGET_LANGUAGE_CONFLICT') error.code = 'TARGET_LANGUAGE_CONFLICT';
    throw error;
  }

  const s = obj.summary && typeof obj.summary === 'object' && !Array.isArray(obj.summary) ? obj.summary : {};
  const rawRatings = s.ratings && typeof s.ratings === 'object' ? s.ratings : {};
  const ratings = {};
  TYPES.forEach(t => { ratings[t] = RATINGS.includes(rawRatings[t]) ? rawRatings[t] : '中'; });
  const strArr = v => (Array.isArray(v) ? v : []).filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
  const summary = {
    ratings,
    risk_level: RISK_LEVELS.includes(s.risk_level) ? s.risk_level : '需要优化',
    conclusion: typeof s.conclusion === 'string' ? s.conclusion.trim() : '',
    structure: strArr(s.structure),
    directions: strArr(s.directions)
  };

  const sections = splitChapters(script);
  const hits = [];
  for (const item of Array.isArray(obj.hits) ? obj.hits : []) {
    if (!item || typeof item.original !== 'string' || !item.original.trim()) continue;
    const original = item.original.trim();
    const idx = script.indexOf(original);
    if (idx === -1) continue;
    const type = TYPES.includes(item.type) ? item.type : 'originality';
    const severity = SEVERITIES.includes(item.severity) ? item.severity : 'medium';
    // 模型给的章节号只作参考,以原文实际位置为准
    const chapter = chapterOf(script, sections, idx);
    hits.push({
      chapter,
      original,
      type,
      severity,
      suggestion: typeof item.suggestion === 'string' ? item.suggestion.trim() : '',
      original_zh: typeof item.original_zh === 'string' ? item.original_zh.trim() : '',
      suggestion_zh: typeof item.suggestion_zh === 'string' ? item.suggestion_zh.trim() : '',
      reason: typeof item.reason === 'string' ? item.reason.trim() : '',
      status: 'pending'
    });
  }
  // 免责/软化句守卫:建议只是加一句「다만…단정하기 어렵다」之类的免责,采纳会打断节奏、削弱结论(实测一篇韩文稿被采纳后多出 9 句免责,
  // 结尾的落点句也被换成免责声明)。这类建议不删,标出来排到最后,由人决定;全稿最后一句同样只提示不建议改
  const lastLine = (script.trim().split(/\n/).filter(l => l.trim() && !/^\s*\[CH\d+/.test(l)).pop() || '').trim();
  hits.forEach(h => {
    if (HEDGE_RE.test(h.suggestion) && !HEDGE_RE.test(h.original)) {
      h.hedge = true;
      h.reason = '⚠ 这条建议是在加免责句,采纳会打断节奏、削弱结论,一般不建议采纳。' + h.reason;
    }
    if (lastLine && (lastLine.includes(h.original) || h.original.includes(lastLine))) {
      h.protected = true;
      h.reason = '⚠ 这是全稿最后一句(结尾落点),改之前想清楚。' + h.reason;
    }
  });
  // 高风险在前,同级按文中先后顺序;免责类和结尾句排最后
  hits.forEach(h => { h._pos = script.indexOf(h.original); });
  hits.sort((a, b) => ((a.hedge || a.protected ? 1 : 0) - (b.hedge || b.protected ? 1 : 0)) || (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || (a._pos - b._pos));
  hits.forEach((h, i) => { h.id = 'h' + (i + 1); delete h._pos; });
  return { summary, hits };
}

// ---------- 检测入口 ----------
async function detect(cfg, script, targetLanguage) {
  const language = requireTargetLanguage(targetLanguage);
  const t0 = Date.now();
  const tpl = fs.readFileSync(PROMPT_PATH, 'utf-8');
  const values = { target_language: language, script };
  const prompt = tpl.replace(/\{\{(target_language|script)\}\}/g, (_, key) => values[key]);
  const detectCfg = { ...cfg, temperature: 0 }; // 检测任务关掉随机性
  const r = await pipeline.llmCall(detectCfg, [{ role: 'user', content: prompt }], '商业化检查');
  const { summary, hits } = parseResult(r.content, script, r.stopReason);
  return {
    model: cfg.model || '',
    target_language: language,
    type_names: { ...TYPE_NAMES }, // 前端展示用 {id: 中文名}
    secs: Math.round((Date.now() - t0) / 100) / 10,
    summary,
    hits
  };
}

module.exports = { HEDGE_RE, TYPES, TYPE_NAMES, requireTargetLanguage, parseResult, detect };
