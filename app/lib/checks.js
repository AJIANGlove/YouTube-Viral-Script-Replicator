// 确定性校验:查重 / 词密度 / 总时长 / 引用存在性 / 交付性
// 分词按 Unicode 字母/数字切,不再只认 a-z:旧写法把韩文、中文、日文整段滤掉,
// 韩文稿 1,703 词只数出 369 词,词密度全判「偏稀」、6 词查重永远查不到(实测 run_a2f108398c13)。
const normWords = t => (t || '').toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
const ngrams = (w, n, sep) => { const o = []; const j = sep == null ? ' ' : sep; for (let i = 0; i + n <= w.length; i++) o.push(w.slice(i, i + n).join(j)); return o; };
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/g;
const HANGUL_CHAR = /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/g;

// 语言无关的词数:有空格的语言按空白切分(韩语按语节);中文/日文按字符数 ÷ 2 估算
function countWords(text) {
  const t = String(text || '');
  const cjk = (t.match(CJK_CHAR) || []).length;
  const tokens = t.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w));
  if (cjk > tokens.length * 2) return Math.round(cjk / 2);
  return tokens.length;
}

// 查重的单位:拉丁字母语言按词(连续 6 词);韩文、中文、日文按字(去掉空格和标点后连续 12 个字)。
// 韩文一个语节常带助词,照抄的原句往往只有 4–5 个语节(如「판돈보다 남의 가게에서 받을 월급」),按词数查不出来。
const OVERLAP_WORDS = 6;
const OVERLAP_CHARS = 12;
function overlapMode(text) {
  const t = String(text || '');
  const asian = (t.match(CJK_CHAR) || []).length + (t.match(HANGUL_CHAR) || []).length;
  const latin = (t.match(/[A-Za-z\u00c0-\u024f\u0400-\u04ff]/g) || []).length;
  return asian > latin ? 'chars' : 'words';
}
function overlapTokens(text, mode) {
  if (mode === 'chars') return Array.from(String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));
  return normWords(text);
}
const stripFence = t => { const s = (t || '').trim(); const m = s.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```\s*$/); return m ? m[1].trim() : s; };
// 从任意文本里捞第一个可解析的 JSON 对象:跳过围栏错位与前后解说,按花括号配平(字符串内的括号不计数)。
// 仅在直接 JSON.parse 失败时作兜底;返回 null 表示文本里没有完整对象(典型为被 max_tokens 截断)。
function extractJsonObject(text) {
  const s = text || '';
  for (let start = s.indexOf('{'); start !== -1; start = s.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(start, i + 1)); }
          catch (e) { break; } // 这一对括号内不是合法 JSON,从下一个 { 重试
        }
      }
    }
  }
  return null;
}
const toSec = ts => { const p = ts.split(':').map(Number); return p.length === 2 ? p[0] * 60 + p[1] : p[0] * 3600 + p[1] * 60 + p[2]; };
const fmt = s => Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');

function parseChapters(script) {
  const re = /\[CH(\d+) \| (\d+:\d+(?::\d+)?)\s*[-–—]\s*(\d+:\d+(?::\d+)?) \| ([^\]]+)\]\s*\n([\s\S]*?)(?=\n\[CH|\s*$)/g;
  const out = []; let m;
  while ((m = re.exec(script)) !== null) {
    out.push({ ch: m[1], start: m[2], end: m[3], fn: m[4].trim(), words: countWords(m[5]), secs: toSec(m[3]) - toSec(m[2]) });
  }
  return out;
}

// 看着像章节标签、但 parseChapters 认不出的行(时间写成「미할당」、缺竖线等)。
// parseChapters 会把这类标签连同它的正文静默跳过,所以结构闸门要单独把它们报出来。
const CH_TAG_LIKE = /^[ \t]*\[CH\d+[^\]\r\n]*\][ \t]*\r?$/gm;
const CH_TAG_OK = /^[ \t]*\[CH\d+ \| \d+:\d+(?::\d+)?\s*[-–—]\s*\d+:\d+(?::\d+)? \| [^\]]+\][ \t]*\r?$/;
function malformedChapterTags(script) {
  const out = []; let m, n = 0;
  const re = new RegExp(CH_TAG_LIKE.source, 'gm');
  while ((m = re.exec(script || '')) !== null) { n++; if (!CH_TAG_OK.test(m[0])) out.push({ index: n, text: m[0].trim() }); }
  return out;
}

function collapseHits(hits) {
  const out = [];
  for (const g of hits) {
    const last = out[out.length - 1];
    const w = g.split(' ');
    if (last && last.split(' ').slice(1).join(' ') === w.slice(0, -1).join(' ')) out[out.length - 1] = last + ' ' + w[w.length - 1];
    else out.push(g);
  }
  return out;
}

// 参照工具:基于资产 examples + 源 SRT + timeline 语速
// opts.wpm:按配音语速算密度(见 lib/narration.js),不传则用原片字幕语速
function makeRefTools(asset, opts) {
  let ex = '';
  try { ex = (JSON.parse(asset.examples).examples || []).map(e => e.example_text || '').join('\n'); }
  catch (e) { ex = asset.examples || ''; }
  const refText = ex + '\n' + (asset.srt || '');
  let tw = 149;
  try { tw = JSON.parse(asset.timeline).data.subtitle_metrics.average_words_per_minute || 149; } catch (e) {}
  const sourceWpm = tw;
  if (opts && opts.wpm) tw = opts.wpm;
  // 两种单位的参照集按需各建一次
  const refSets = {};
  const refSetOf = mode => refSets[mode] || (refSets[mode] = new Set(ngrams(overlapTokens(refText, mode), mode === 'chars' ? OVERLAP_CHARS : OVERLAP_WORDS, mode === 'chars' ? '' : ' ')));

  // 返回与参照(examples + 原片字幕)重合的最长连续片段,已合并相邻命中,不再需要 collapseHits
  const findOverlaps = text => {
    const mode = overlapMode(text);
    const n = mode === 'chars' ? OVERLAP_CHARS : OVERLAP_WORDS;
    const sep = mode === 'chars' ? '' : ' ';
    // 按字查时记下每个字在原文里的位置,输出原文片段(带空格和标点),方便人对照
    const src = String(text || '');
    let toks, pos = null;
    if (mode === 'chars') {
      toks = []; pos = [];
      const lower = src.toLowerCase();
      for (let i = 0; i < lower.length;) {
        const ch = String.fromCodePoint(lower.codePointAt(i));
        if (/[\p{L}\p{N}]/u.test(ch)) { toks.push(ch); pos.push(i); }
        i += ch.length;
      }
    } else toks = overlapTokens(src, mode);
    const ref = refSetOf(mode);
    const hit = new Array(toks.length).fill(false);
    for (let i = 0; i + n <= toks.length; i++) {
      if (ref.has(toks.slice(i, i + n).join(sep))) for (let k = i; k < i + n; k++) hit[k] = true;
    }
    const runs = [];
    for (let i = 0; i < toks.length;) {
      if (!hit[i]) { i++; continue; }
      let j = i;
      while (j < toks.length && hit[j]) j++;
      runs.push(pos ? src.slice(pos[i], pos[j - 1] + toks[j - 1].length).replace(/\s+/g, ' ').trim() : toks.slice(i, j).join(sep));
      i = j;
    }
    return [...new Set(runs)];
  };

  const densityLines = script => {
    const chs = parseChapters(script);
    if (!chs.length) return { lines: ['(未解析到 [CHxx] 章节标记)'], bad: 1, chapters: [] };
    let bad = 0;
    const lines = chs.map(c => {
      const wpm = c.secs > 0 ? Math.round(c.words / c.secs * 60) : 0;
      const r = tw > 0 ? wpm / tw : 1;
      let flag = '正常';
      if (r > 1.15) { flag = '超标'; bad++; }
      else if (r < 0.8) { flag = '偏稀'; bad++; }
      return `CH${c.ch} ${c.start}-${c.end} ${c.words}词 ${wpm}wpm(目标${tw}) ${flag}`;
    });
    return { lines, bad, chapters: chs };
  };
  return { findOverlaps, densityLines, targetWpm: tw, sourceWpm };
}

function goalSeconds(videoGoal) {
  const m = (videoGoal || '').match(/(\d+(?:\.\d+)?)/);
  return m ? Math.round(parseFloat(m[1]) * 60) : null;
}

// Step1: 蓝图查重 + 总时长
function checkBlueprint(text, tools, videoGoal) {
  const overlaps = tools.findOverlaps(text);
  const result = { plagiarism: overlaps, duration: { ok: null, detail: '' } };
  // 极短输出兜底:合法蓝图 JSON(8+ 章、每章 10 个字段)不可能低于 500 字符,低于即判不合格(防上游异常响应)
  const len = (text || '').trim().length;
  if (len < 500) {
    result.duration = { ok: false, detail: `蓝图输出过短(仅 ${len} 字符),疑似异常响应` };
    return result;
  }
  try {
    const bp = JSON.parse(stripFence(text));
    const last = (bp.chapters || [])[(bp.chapters || []).length - 1];
    const lastEnd = last && last.time_range ? last.time_range.split(/[-–—]/).pop().trim() : null;
    const goal = goalSeconds(videoGoal);
    if (!lastEnd || !goal) result.duration = { ok: null, detail: '未校验(末章时间或 video_goal 无法解析)' };
    else {
      const endSec = toSec(lastEnd), diff = Math.abs(endSec - goal);
      result.duration = diff > 30
        ? { ok: false, detail: `漂移:蓝图结束于 ${fmt(endSec)},目标 ${fmt(goal)}(差 ${diff}s)`, endSec, goalSec: goal }
        : { ok: true, detail: `${fmt(endSec)} ≈ 目标 ${fmt(goal)}`, endSec, goalSec: goal };
    }
  } catch (e) { result.duration = { ok: false, detail: '蓝图 JSON 解析失败', parseError: e.message.slice(0, 100) }; }
  return result;
}

// Step2: 查重 + 词密度
function checkScript(text, tools) {
  return {
    plagiarism: tools.findOverlaps(text),
    density: tools.densityLines(text)
  };
}

// Step3: 围栏 / JSON(宽容提取首个对象) / evidence_quote / verdict 一致性
function checkAudit(auditText, scriptText) {
  const stripped = stripFence(auditText);
  const r = { fenceStripped: stripped !== auditText.trim(), jsonOk: false, issues: 0, factualClaims: 0, quoteMissing: 0, quoteNoField: 0, verdict: null, verdictConflict: false };
  let j = null;
  try { j = JSON.parse(stripped); }
  catch (e) {
    // 宽容提取:首个 { 到末尾最后一个 }(容忍模型在 JSON 前后加了解释文字)
    const a = stripped.indexOf('{'), b = stripped.lastIndexOf('}');
    if (a !== -1 && b > a) {
      try { j = JSON.parse(stripped.slice(a, b + 1)); r.preambleStripped = true; } catch (e2) {}
    }
    if (!j) { r.parseError = e.message.slice(0, 100); return r; }
  }
  r.jsonOk = true;
  r.verdict = j.verdict || null;
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const sN = norm(scriptText);
  (j.issues || []).forEach(it => {
    if (!it.evidence_quote) r.quoteNoField++;
    else if (!sN.includes(norm(it.evidence_quote))) r.quoteMissing++;
  });
  r.issues = (j.issues || []).length;
  r.factualClaims = (j.factual_claims || []).length;
  const blockers = (j.issues || []).filter(i => i.severity === 'blocker').length;
  r.verdictConflict = blockers > 0 && j.verdict === 'pass';
  return r;
}

// 终稿正文的起点:章节标签行(允许被加粗,**[CH01 | ...]**)
const CH_TAG_LINE_ANY = /^\s*(?:\*\*)?\[CH\d+\s*\|/;

// 首个章节标签之前的「前导块」处理。
// 背景:模型偶尔把计划/自我说明写在终稿前面(实测量产记录 run_98de90807287:24 行英文
// "I need to fix the density issue...",导致 V1 文案中英混杂)。这类文字不属于终稿。
// 规则:只保留紧邻正文之前的标题前缀(Markdown # 标题、Optimized Script)与其间空行;
//       从第一个非标题、非空行开始到首个章节标签之前的整块内容丢弃。
//       若前导只有标题、或全文没有任何章节标签,则原样返回(逐字节不变,幂等)。
// 返回 { text, dropped } —— dropped 为 null 表示未改动,非 null 时可用于留痕。
function stripLeadingPreamble(text) {
  const lines = (text || '').split('\n');
  let first = -1;
  for (let i = 0; i < lines.length; i++) { if (CH_TAG_LINE_ANY.test(lines[i])) { first = i; break; } }
  if (first <= 0) return { text, dropped: null }; // 无章节标签,或正文已从首行开始
  const head = lines.slice(0, first);
  const isBlank = l => !l.trim();
  const isHeading = l => /^\s*#{1,6}\s/.test(l) || /^\s*(?:\*\*)?optimized script(?:\*\*)?\s*$/i.test(l);
  const kept = [];
  let dropFrom = head.length;
  for (let i = 0; i < head.length; i++) {
    const l = head[i];
    if (isBlank(l)) { if (kept.length) kept.push(l); continue; } // 标题之间的空行保留
    if (isHeading(l)) { kept.push(l); continue; }
    dropFrom = i; // 第一个正文式前导行:从这里起全部丢弃
    break;
  }
  if (dropFrom === head.length) return { text, dropped: null }; // 前导只有标题:原样返回
  while (kept.length && isBlank(kept[kept.length - 1])) kept.pop();
  const dropped = head.slice(dropFrom).filter(l => !isBlank(l));
  return {
    text: [...kept, ...lines.slice(first)].join('\n'),
    dropped: { lines: dropped.length, chars: dropped.join('\n').length, sample: dropped[0].trim().slice(0, 120) }
  };
}

// 章节结构校验:章号必须从 01 起严格递增、每个章号只出现一次。
// 实测两类事故都靠它兜住:①中转层把「中断的前半段 + 重试的完整段」拼进同一个响应体;
// ②模型自己从头重写一遍(实测量产记录 run_a3cb19c5b8a6 终稿 23 个标签、CH02–CH11 各两次)。
// ③标签格式不合法会被 parseChapters 静默跳过(实测 run_61f5f188d286:CH13 时间写成「미할당」,解析只剩 CH01,单章天然合法,残缺稿一路跑到终审)。
// expected:蓝图章数。传了就要求恰好 CH01..CHN 全部写出,少章判不合格。
// 返回 null 表示合格,否则返回可直接回灌给模型的中文原因。
function chapterStructureError(text, expected) {
  const bad = malformedChapterTags(text || '');
  if (bad.length) {
    return '章节标签格式不合法(第 ' + bad.map(b => b.index).join('、') + ' 个标签:' + bad.slice(0, 3).map(b => b.text).join(';') +
      ';时间必须写成 m:ss - m:ss,如 [CH13 | 11:20 - 12:00 | cta_outro])';
  }
  const chs = parseChapters(text || '');
  if (!chs.length) return '未解析到任何 [CHxx | 时间 | 功能] 章节标签';
  const nums = chs.map(c => Number(c.ch));
  const dup = [...new Set(nums.filter((n, i) => nums.indexOf(n) !== i))].sort((a, b) => a - b);
  if (dup.length) {
    return '章节重复(共 ' + chs.length + ' 个标签,' + dup.map(n => 'CH' + String(n).padStart(2, '0')).join('/') +
      ' 出现了多次,疑似整篇被粘贴了两遍)';
  }
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] !== i + 1) {
      return '章节顺序异常(第 ' + (i + 1) + ' 个标签是 CH' + String(nums[i]).padStart(2, '0') + ',应为 CH' + String(i + 1).padStart(2, '0') + ')';
    }
  }
  if (expected && nums.length < expected) {
    const pad = n => 'CH' + String(n).padStart(2, '0');
    return '章节不全(只写了 ' + nums.length + ' 章,蓝图有 ' + expected + ' 章,缺 ' + pad(nums.length + 1) + (nums.length + 1 < expected ? '–' + pad(expected) : '') + ')';
  }
  return null;
}

// 修改说明混进正文:模型偶尔不真删,而是在原处留一行「(删除三处中的后两处,只保留第一处)」这类中文批注。
// 判定:不是章节标签的整行,中文字占这一行字母的一半以上(韩文/英文稿的正文不会这样),
// 或整行被括号包住且以 删除/保留/省略/此处/修改/略 这类编辑动词开头。中文稿不做前一种判定。
const HAN = /[\u4e00-\u9fff]/g;
const META_WORD = /^[(（【\[]\s*(删除|删掉|删去|去掉|保留|省略|此处|这里|修改|改为|略|同上|待核实|注|备注|unchanged|omitted)/i;
function isMetaNoteLine(line, lang) {
  const t = String(line || '').trim();
  if (!t || /^\[CH\d+/.test(t)) return false;
  const wrapped = /^[(（【\[].*[)）】\]]$/.test(t);
  if (wrapped && META_WORD.test(t)) return true;
  if (/^(Chinese|中文|Japanese|日文)/i.test(lang || '')) return false;
  const han = (t.match(HAN) || []).length;
  const letters = (t.match(/[\p{L}]/gu) || []).length;
  return han >= 2 && han / Math.max(letters, 1) > 0.5;
}
function stripMetaNotes(text, lang) {
  const removed = [];
  const out = String(text || '').split('\n').filter(l => { if (isMetaNoteLine(l, lang)) { removed.push(l.trim()); return false; } return true; })
    .join('\n').replace(/\n{3,}/g, '\n\n');
  return { text: removed.length ? out : String(text || ''), removed };
}

// 外文字符混进旁白:目标语言不是中文/日文时,稿子里出现汉字或日文假名,配音会念错或念不出来。
// 来源有三类(仓库 70 篇终稿里 6 篇):括号注原词或中文翻译「에레베타가루 (エレベーターガール)」、
// 汉字数字「팔십六만」「60 万 people」、中文词混进句子「口径이 다르다」「14시间」。
// 前两类按规则修,第三类留给 purify.js 交模型改写。
const FOREIGN_CHAR = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;
const FOREIGN_CHARS = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/g;
const KO_NUM = { '一': '일', '二': '이', '三': '삼', '四': '사', '五': '오', '六': '육', '七': '칠', '八': '팔', '九': '구', '十': '십', '百': '백', '千': '천', '万': '만', '萬': '만', '億': '억', '亿': '억' };
// 目标语言是中文/日文,或没填语言但全文汉字假名占三成以上:不做这项检查
function foreignCheckApplies(text, lang) {
  const l = String(lang || '').trim();
  if (/^(Chinese|中文|汉语|Japanese|日文|日语|日本語|zh|ja)/i.test(l)) return false;
  if (l) return true;
  const t = String(text || '');
  const cjk = (t.match(FOREIGN_CHARS) || []).length;
  const letters = (t.match(/\p{L}/gu) || []).length;
  return cjk / Math.max(letters, 1) < 0.3;
}
function foreignLines(text) {
  return String(text || '').split('\n').map((l, i) => ({ line: i, text: l }))
    .filter(x => !/^\s*\[CH\d+/.test(x.text) && FOREIGN_CHAR.test(x.text))
    .map(x => ({ line: x.line, text: x.text.trim(), chars: [...new Set(x.text.match(FOREIGN_CHARS))].join('') }));
}
function cleanForeignScript(text, lang) {
  const src = String(text || '');
  if (!FOREIGN_CHAR.test(src) || !foreignCheckApplies(src, lang)) return { text: src, fixed: [], left: [] };
  const ko = /^(Korean|韩|한국|ko)/i.test(String(lang || '').trim()) || (src.match(HANGUL_CHAR) || []).length > (src.match(/[A-Za-z]/g) || []).length;
  const fixed = [];
  const out = src.split('\n').map(line => {
    if (/^\s*\[CH\d+/.test(line) || !FOREIGN_CHAR.test(line)) return line;
    let t = line;
    // ① 括号里大半是汉字/假名:原词注释或中文翻译,整段去掉
    t = t.replace(/\s*[(（]([^()（）\n]*)[)）]/g, (m, inner) => {
      const cjk = (inner.match(FOREIGN_CHARS) || []).length;
      const letters = (inner.match(/\p{L}/gu) || []).length;
      return cjk && cjk / Math.max(letters, 1) > 0.5 ? '' : m;
    });
    if (t !== line) t = t.replace(/([.!?])\s*\.(?=\s|$)/g, '$1');
    if (ko) {
      // ② 韩文稿:挨着韩文或数字的汉字数字换成韩文读法(六→육、一자형→일자형)
      t = t.replace(/[一二三四五六七八九十百千万萬億亿]+/g, (m, off, s) =>
        /[\uac00-\ud7af0-9]/.test(s.slice(Math.max(0, off - 1), off) + s.slice(off + m.length, off + m.length + 1)) ? [...m].map(c => KO_NUM[c]).join('') : m);
    } else {
      // ② 拉丁字母稿:「60 万」→「600,000」
      t = t.replace(/(\d+(?:\.\d+)?)\s*(万|萬|亿|億)/g, (m, n, u) => Math.round(parseFloat(n) * (/[万萬]/.test(u) ? 1e4 : 1e8)).toLocaleString('en-US'));
    }
    if (t !== line) fixed.push({ before: line.trim(), after: t.trim() });
    return t;
  }).join('\n');
  return { text: out, fixed, left: foreignLines(out) };
}

// ---------- 为「听」写:开头和数字密度(按真实留存定的规矩) ----------
// 실측 run_2713e3885236(김밥집,46 人留存曲线):前 10 秒连念 3,869원/1,299원/33.6% 三个数、标题里的「200줄 적자」到 0:32 才出现,
// 0:10–0:20 掉了一半人;1:00 起一行念 5 个带克数的价格,1:01–1:42 从 30% 掉到 7%。
// 时间按字数和配音语速(wpm)估,句子级的位置会差几秒。
const NUM_TOKEN = /\d[\d,.]*/g;
const OPEN_TITLE_SEC = 8, OPEN_NUM_SEC = 10, OPEN_MAX_NUMS = 1, LINE_MAX_NUMS = 2;
// 句末标点后接空白才算断句(5.5시간 里的点不算);引号跟在句末标点后面的一起带走
function sentencesOf(line) {
  return String(line).split(/(?<=[.!?。！？…]["”’」)]?)\s+/).map(t => t.trim()).filter(Boolean);
}
function narrationLines(script, wpm) {
  const out = [];
  let acc = 0;
  String(script || '').split('\n').forEach(raw => {
    const l = raw.trim();
    if (!l || /^\[CH\d+/.test(l) || /^(---|#)/.test(l)) return;
    // 一行可能是一整段(run_7148b9d76755 每章只有一段):按句切开,时间和数字都按句算
    sentencesOf(l).forEach(t => {
      const w = Math.max(countWords(t), 1);
      out.push({ text: t, start: acc / wpm * 60, end: (acc + w) / wpm * 60, nums: (t.match(NUM_TOKEN) || []).length });
      acc += w;
    });
  });
  return out;
}
// 标题关键词:按空格切,去标点;韩文取前 2 个字当词干(조사、어미不同也能对上),数字只认数字
const TITLE_STOPWORDS = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'do', 'did', 'does', 'how', 'what', 'when', 'why', 'who', 'which', 'where', 'it', 'its', 'you', 'your', 'if', 'with', 'from', 'by', 'as', 'that', 'this', 'they', 'their', 'can', 'could', 'would', 'without']);
function titleStems(title) {
  return [...new Set(String(title || '').split(/[\s,.!?…·:;'"“”‘’()\[\]-]+/).map(t => t.trim()).filter(t => t.length >= 2 && !TITLE_STOPWORDS.has(t.toLowerCase()))
    .map(t => /^\d/.test(t) ? t.match(/^\d[\d,.]*/)[0] : /[가-힯]/.test(t) ? t.slice(0, 2) : t.toLowerCase()))];
}
// 韩文语体:-다(반말/서술체)和 -니다/-요(존댓말)混用,听起来像两个人在说
// 少数一方达到 3 句就算混用(实测两篇 -니다 体稿里各混进 6、11 句 -다 体,按比例算都不到 10%)
const REGISTER_MAX_MINOR = 3;
// -ㅂ니다/-습니다/-ㅂ니까:「니」前一个字带ㅂ收音。「아니다」也以「니다」结尾,但它是 -다 体(实测 POV 稿 22 句误判)
function hamnida(t) {
  const m = t.match(/([가-힣])니[다까]$/);
  return !!m && (m[1] === '습' || (m[1].charCodeAt(0) - 0xAC00) % 28 === 17);
}
function koreanRegister(lines) {
  const c = { plain: [], formal: [] };
  lines.forEach(l => {
    if (/^["“「'‘]/.test(l.text)) return; // 引语不算
    const t = l.text.replace(/["”」'’)\]]+$/, '').replace(/[.!?。…]+$/, '');
    if (/(세요|어요|아요|해요|에요|예요|죠|지요|군요|네요|까요|래요|대요|거든요|잖아요)$/.test(t) || hamnida(t)) c.formal.push(l);
    else if (/다$|[가-힣](냐|자)$/.test(t)) c.plain.push(l); // 「…걸까?」这类自问在 -니다 体里也常用,不算
  });
  const n = c.plain.length + c.formal.length;
  const minor = c.plain.length <= c.formal.length ? 'plain' : 'formal';
  return { plain: c.plain.length, formal: c.formal.length, mixed: n >= 10 && c[minor].length >= REGISTER_MAX_MINOR, minor, examples: c[minor].slice(0, 8).map(l => l.text) };
}
function listenCheck(script, opts) {
  const o = opts || {};
  const wpm = o.wpm || 150;
  const lines = narrationLines(script, wpm);
  if (!lines.length) return null;
  const issues = [];
  // 开头:前 10 秒最多 1 个数字;前 8 秒要出现标题里的说法
  const nums10 = lines.filter(l => l.start < OPEN_NUM_SEC).reduce((n, l) => n + l.nums, 0);
  if (nums10 > OPEN_MAX_NUMS) issues.push('前 ' + OPEN_NUM_SEC + ' 秒念了 ' + nums10 + ' 个数字(最多 ' + OPEN_MAX_NUMS + ' 个)');
  const stems = titleStems(o.title);
  const seen = stems.map(st => { const l = lines.find(x => x.text.toLowerCase().includes(st)); return { word: st, sec: l ? Math.round(l.start) : null }; });
  const early = seen.filter(x => x.sec != null && x.sec < OPEN_TITLE_SEC).length;
  const titleHit = stems.length ? Math.round(early / stems.length * 100) / 100 : null;
  if (stems.length >= 3 && titleHit < 0.34) issues.push('前 ' + OPEN_TITLE_SEC + ' 秒只出现了标题里 ' + early + '/' + stems.length + ' 个关键词' +
    (seen.some(x => x.sec != null && x.sec >= OPEN_TITLE_SEC) ? '(' + seen.filter(x => x.sec != null && x.sec >= OPEN_TITLE_SEC).map(x => x.word + ' 在 ' + fmt(x.sec)).join('、') + ')' : ''));
  // 数字串:一行(一句)最多 2 个数字
  const dense = lines.filter(l => l.nums > LINE_MAX_NUMS).map(l => ({ sec: Math.round(l.start), nums: l.nums, text: l.text }));
  if (dense.length) issues.push(dense.length + ' 句一口气念 3 个以上的数字(最早在 ' + fmt(dense[0].sec) + ')');
  const register = /^(Korean|韩|한국|ko)/i.test(String(o.lang || '')) ? koreanRegister(lines) : null;
  if (register && register.mixed) issues.push('语体混用:-다 体 ' + register.plain + ' 句,-니다/-요 体 ' + register.formal + ' 句');
  return { wpm, ok: !issues.length, issues, opening: { nums_10s: nums10, title_hit: titleHit, title_words: seen }, dense, register };
}
// 问题轻重,用来比较重写前后哪版更好(越小越好)
function listenScore(lc) {
  if (!lc) return 0;
  const o = lc.opening || {};
  return Math.max(0, (o.nums_10s || 0) - OPEN_MAX_NUMS) * 2 + (lc.issues.some(i => /关键词/.test(i)) ? 4 : 0) +
    lc.dense.length + (lc.register && lc.register.mixed ? 6 : 0);
}
// 写稿、优化、审稿共用的听感规则(提示词里也是这几条)
const LISTEN_RULES = '听感规则(稿子是配音给人听的,观众不能回看):\n' +
  '- 开头 ' + OPEN_TITLE_SEC + ' 秒内,用一个人或一个场景说出标题里的冲突;前 ' + OPEN_NUM_SEC + ' 秒最多 ' + OPEN_MAX_NUMS + ' 个数字;45 秒前给出第一个答案。\n' +
  '- 一句最多 ' + LINE_MAX_NUMS + ' 个数字;价格表、配料克数这类清单不要一口气念完,只留最关键的一两个,其余拆开或删掉。\n' +
  '- 全篇只用一种语体(韩文:-다 体和 -니다/-요 体二选一),引用别人的话除外。';
// 给模型的修改意见(写稿重试、复审用)
function listenFeedback(lc) {
  if (!lc || lc.ok) return '';
  const parts = lc.issues.map(i => '- ' + i);
  if (lc.dense.length) parts.push('需要拆开的句子:\n' + lc.dense.slice(0, 6).map(d => '  · ' + d.text).join('\n'));
  if (lc.register && lc.register.mixed) parts.push('语体不统一的句子(全篇只用一种语体):\n' + lc.register.examples.map(t => '  · ' + t).join('\n'));
  return parts.join('\n');
}

// Step4: 元评论 / ChangeLog before / 时间漂移 / 附加内容
function checkOptimized(optText, origScript) {
  const meta = [/\[VERIFY/i, /\(unchanged\)/i, /note\s*[:：]/i, /all (the )?fixes are/i, /I need to flag/i].filter(p => p.test(optText)).map(p => p.source);
  const r = { metaHits: meta, preamble: null, changeLog: null, timeDrift: null, tail: null };
  r.preamble = stripLeadingPreamble(optText).dropped; // 终稿前的计划/自我说明(会被 extractFinalScript 丢弃,此处留痕)
  const arrMatch = optText.match(/\[\s*\{[\s\S]*"before"[\s\S]*\}\s*\]/);
  if (!arrMatch) { r.changeLog = { found: false }; return r; }
  const heading = /change\s*log/i.test(optText.slice(0, arrMatch.index));
  try {
    const log = JSON.parse(arrMatch[0]);
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const oN = norm(origScript);
    const fake = log.filter(e => e.before && !oN.includes(norm(e.before))).length;
    r.changeLog = { found: true, count: log.length, heading, fakeBefore: fake };
    const a = parseChapters(optText.slice(0, arrMatch.index)), b = parseChapters(origScript);
    if (a.length && b.length) {
      const diffs = [];
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const ta = a[i] ? a[i].start + '-' + a[i].end : '(缺)';
        const tb = b[i] ? b[i].start + '-' + b[i].end : '(缺)';
        if (ta !== tb) diffs.push(`CH${a[i] ? a[i].ch : '?'}: ${tb} → ${ta}`);
      }
      r.timeDrift = { count: diffs.length, diffs: diffs.slice(0, 10) };
    }
    const tail = optText.slice(arrMatch.index + arrMatch[0].length).trim();
    if (tail) r.tail = tail.slice(0, 500);
  } catch (e) { r.changeLog = { found: true, parseError: e.message.slice(0, 80) }; }
  return r;
}

// 尾部残留清理:反复剥掉纯装饰行(空行 / 代码围栏 ```json / 分隔线 ---),直到最后一行是正文。
// 实测形态:模型在 Change Log 前写成 "---\n\n```json",旧实现只剥末尾反引号与分隔线,
// 结果 "```json" 这一行留在终稿末尾(会被复制进文案、也会被当成旁白推送)。
function stripTrailingJunk(text) {
  const lines = (text || '').split('\n');
  const isJunk = l => {
    const t = l.trim();
    return !t || /^```[\w-]*$/.test(t) || /^[-–—*_]{3,}$/.test(t);
  };
  while (lines.length && isJunk(lines[lines.length - 1])) lines.pop();
  return lines.join('\n');
}

// 提取终稿正文(Change Log 之前的部分)。
// 截断点取两者中更靠前者:Change Log 标题行(兼容数组被 max_tokens 截断、数组套代码围栏、只输出标题三种形态)
// 或完整 JSON 数组起点(无标题形态);行内提及(如"无法生成 Change Log —— ...")不匹配标题行,避免误切;
// 最后剥离尾部残留(分隔线/围栏/反引号),再丢弃首个章节标签之前混入的计划/自我说明(保留标题行)
function extractFinalScript(optText) {
  const headMatch = optText.match(/^\s*(?:#{1,6}\s*)?change\s*log\s*[*:：]*\s*$/im);
  const arrMatch = optText.match(/\[\s*\{[\s\S]*"before"[\s\S]*\}\s*\]/);
  // Change Log 数组没写完(输出被截断,没有收尾的 ]),上面两个都匹配不到:按「独占一行的 [ + 下一行是 location/before 键」切。
  // 实测 run_a2f108398c13:Step 4 在 Change Log 中途断流,半截 JSON 和中文修改理由整段混进终稿,CH13 多出 700 多词
  const openArr = optText.match(/^[ \t]*\[[ \t]*\r?\n\s*\{\s*"(?:location|before|after|reason)"/m);
  let cut = -1;
  if (headMatch) cut = headMatch.index;
  if (arrMatch && (cut === -1 || arrMatch.index < cut)) cut = arrMatch.index;
  if (openArr && (cut === -1 || openArr.index < cut)) cut = openArr.index;
  const body = cut === -1 ? optText : optText.slice(0, cut);
  const cleaned = stripTrailingJunk(body.replace(/[`\s]*$/, '').replace(/\n?\s*[-–—*_]{3,}\s*$/, '').trim());
  return stripLeadingPreamble(cleaned).text;
}

module.exports = { normWords, ngrams, countWords, overlapMode, OVERLAP_WORDS, OVERLAP_CHARS, stripFence, extractJsonObject, toSec, fmt, parseChapters, chapterStructureError, malformedChapterTags, isMetaNoteLine, stripMetaNotes, foreignCheckApplies, foreignLines, cleanForeignScript, narrationLines, titleStems, listenCheck, listenFeedback, listenScore, LISTEN_RULES, collapseHits, makeRefTools, goalSeconds, checkBlueprint, checkScript, checkAudit, checkOptimized, extractFinalScript, stripLeadingPreamble };
