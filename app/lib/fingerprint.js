// 爆款声音指纹:检测与替换(独立于生成管线的外挂模块)
// 检测 = 模式库正则预筛(按语言,可空) + LLM 结构检测(语言无关,主);
// 替换 = 以「CH 章节标签 + 原句精确文本」双锚点定位,段内精确替换,失败项不猜不动(实现见 textloc.js,与商业化检查共用)。
// 本模块不认识 HTTP 与 store,唯一外部依赖是 pipeline.llmCall(复用先例见 topics.js)。
const fs = require('fs');
const path = require('path');
const pipeline = require('./pipeline');
const checks = require('./checks');
const { splitChapters, chapterOf, applyReplacements } = require('./textloc');

const LIB_PATH = path.join(__dirname, '..', 'prompts', 'fingerprints.json');
const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'fingerprint_detect.md');

// ---------- 模式库 ----------
let libCache = { mtimeMs: 0, lib: null };

function loadPatternLib() {
  const st = fs.statSync(LIB_PATH);
  if (!libCache.lib || st.mtimeMs !== libCache.mtimeMs) {
    libCache = { mtimeMs: st.mtimeMs, lib: JSON.parse(fs.readFileSync(LIB_PATH, 'utf-8')) };
  }
  return libCache.lib;
}

// ---------- 章节切分与替换 ----------
// splitChapters / chapterOf / applyReplacements 已迁至 textloc.js(顶部解构引入,行为不变)。

// ---------- 句子切分(预筛用;句号为多种语言共同句尾,足够做候选定位) ----------
function splitSentences(text) {
  const out = [];
  const re = /[^.?!。!?…\n]+[.?!。!?…]*\s*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const sentence = raw.trim();
    if (sentence.length >= 4) out.push({ sentence, start: m.index + raw.indexOf(sentence[0]) });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

// ---------- 正则预筛 ----------
// 命中即取「包含命中点的完整句子」作为候选原句(从原文切出,保证精确可替换)
function regexScan(script, lib) {
  const sections = splitChapters(script);
  const sentences = splitSentences(script);
  const hits = [];
  for (const p of lib.patterns) {
    const regexes = Object.values(p.regex || {}).flat();
    for (const patternStr of regexes) {
      let re;
      try { re = new RegExp(patternStr, 'i'); } catch (e) { continue; } // 库中坏正则不拖垮检测
      for (const s of sentences) {
        if (re.test(s.sentence)) {
          hits.push({ chapter: chapterOf(script, sections, s.start), original: s.sentence, type: p.id, source: 'regex' });
        }
      }
    }
  }
  return hits;
}

// ---------- LLM 结构检测 ----------
function renderPatternsForPrompt(lib) {
  return lib.patterns.map((p, i) => `${i + 1}. [${p.id}] ${p.name}:${p.desc}\n   判定要点:${p.llm_hint}`).join('\n');
}

function renderCandidatesForPrompt(candidates) {
  if (!candidates.length) return '(无候选句)';
  return candidates.map((c, i) => `${i + 1}. [${c.chapter || '全文'}] ${c.original}`).join('\n');
}

function parseLlmHits(content, lib, script) {
  const sections = splitChapters(script);
  const validTypes = new Set(lib.patterns.map(p => p.id));
  let arr;
  try {
    arr = JSON.parse(checks.stripFence(content));
  } catch (e) {
    const m = content.match(/\[[\s\S]*\]/); // 模型裹了解说文字时,捞第一个 JSON 数组
    try { arr = m ? JSON.parse(m[0]) : null; } catch (e2) { arr = null; }
  }
  if (!Array.isArray(arr)) throw new Error('检测结果不是合法 JSON 数组');
  const hits = [];
  for (const item of arr) {
    if (!item || typeof item.original !== 'string' || !item.original.trim()) continue;
    const original = item.original.trim();
    // 原句必须是全文中的精确子串,否则替换必然失败,直接丢弃该条
    const idx = script.indexOf(original);
    if (idx === -1) continue;
    const type = validTypes.has(item.type) ? item.type : lib.patterns[0].id;
    let chapter = typeof item.chapter === 'string' && /^CH\d+$/.test(item.chapter.trim()) ? item.chapter.trim() : null;
    // 模型给的章节号只作参考,以原文实际位置为准
    const actual = chapterOf(script, sections, idx);
    if (actual) chapter = actual;
    hits.push({
      chapter,
      original,
      type,
      suggestion: typeof item.suggestion === 'string' ? item.suggestion.trim() : '',
      original_zh: typeof item.original_zh === 'string' ? item.original_zh.trim() : '',
      suggestion_zh: typeof item.suggestion_zh === 'string' ? item.suggestion_zh.trim() : '',
      reason: typeof item.reason === 'string' ? item.reason.trim() : '',
      source: 'llm'
    });
  }
  return hits;
}

async function llmScan(cfg, script, lib, candidates) {
  const tpl = fs.readFileSync(PROMPT_PATH, 'utf-8');
  const prompt = tpl
    .replaceAll('{{patterns}}', renderPatternsForPrompt(lib))
    .replaceAll('{{regex_candidates}}', renderCandidatesForPrompt(candidates))
    .replaceAll('{{script}}', script);
  const detectCfg = { ...cfg, temperature: 0 }; // 检测任务关掉随机性
  const r = await pipeline.llmCall(detectCfg, [{ role: 'user', content: prompt }], '指纹检测');
  return parseLlmHits(r.content, lib, script);
}

// ---------- 检测入口:正则预筛产出候选 → LLM 复核+改写(唯一权威输出) ----------
async function detect(cfg, script) {
  const lib = loadPatternLib();
  const t0 = Date.now();
  const regexHits = regexScan(script, lib);
  const hits = await llmScan(cfg, script, lib, regexHits);

  // 标注来源:同时被规则预筛命中的记为 regex+llm,LLM 自行发现的记为 llm
  const regexKeys = new Set(regexHits.map(h => (h.chapter || '') + '|' + h.original.replace(/\s+/g, ' ').trim()));
  hits.forEach((h, i) => {
    const key = (h.chapter || '') + '|' + h.original.replace(/\s+/g, ' ').trim();
    if (regexKeys.has(key)) h.source = 'regex+llm';
    h.id = 'h' + (i + 1);
    h.status = 'pending';
  });
  return {
    lib_version: lib.version,
    model: cfg.model || '',
    pattern_names: Object.fromEntries(lib.patterns.map(p => [p.id, p.name])), // 前端展示用 {id: 中文名}
    secs: Math.round((Date.now() - t0) / 100) / 10, // 总耗时(含预筛与 LLM 调用)
    hits
  };
}

module.exports = { loadPatternLib, splitChapters, splitSentences, regexScan, detect, applyReplacements };
