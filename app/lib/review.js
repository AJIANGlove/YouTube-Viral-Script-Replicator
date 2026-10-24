// 先写后改:一键生成 + 逐段对照审稿
// 一键生成:写前分析 → AI 先调整(能联网就联网)→ 不等人确认,直接四步写稿 → 稿件检查 → 中文对照翻译。
// 逐段对照:每一行是新稿的一章,左边是它承接的原片段原文,中间是模板(留存功能、高峰、可删性、AI 的处理),
// 右边是新稿,下面挂这一章用到的事实(绿=查到有出处,黄=估算/假设,红=没来源)和程序查出的红旗。
// 人逐章处理:通过 / 我的意见(只重写这一章)/ 压成过渡 / 撤回;改一条事实,用到它的章节一起重写。
// 视图(buildView)每次按当前稿子现算,不落盘;落盘的只有人的处理状态、历史版本和译文(run.review)。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const checks = require('./checks');
const retention = require('./retention');
const voice = require('./voice');
const { HEDGE_RE } = require('./compliance');

const pl = () => require('./pipeline');
const an = () => require('./analysis');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');
const readPrompt = f => fs.readFileSync(path.join(PROMPTS_DIR, f), 'utf-8');
const parse = t => { try { return typeof t === 'string' ? JSON.parse(t) : (t || null); } catch (e) { return null; } };
const dataOf = j => (j && j.data) || j || {};
const arr = v => (Array.isArray(v) ? v : []);
const hash = t => crypto.createHash('sha1').update(String(t || '')).digest('hex').slice(0, 12);

const TRANSLATE_BATCH_CHARS = 1800;
const HISTORY_MAX = 10;
const REPEAT_AFTER = 3; // 同一个数出现在第几章以后算重复(从 0 数)
// 论坛、个人博客、问答站:可以当线索,不能当「事实」的出处
const WEAK_SOURCES = /mlbpark|82cook|dcinside|theqoo|clien|ppomppu|fmkorea|ruliweb|instiz|cafe\.naver|blog\.naver|tistory|kin\.naver|reddit\.com|quora\.com|zhihu\.com|tieba|douban|2ch|5ch|chiebukuro|ameblo|论坛|카페|블로그|커뮤니티/i;
// 中文分析直译进稿子的常见残留(韩文);汉字另外单独查
const TRANSLATIONESE = { Korean: ['결여율', '외삽', '구경이', '결여금'] };

// ---------- 原片切段 ----------
function srtCues(srtText) {
  const cues = [];
  for (const b of String(srtText || '').replace(/^﻿/, '').split(/\r?\n\s*\r?\n/)) {
    const ls = b.trim().split(/\r?\n/);
    const tm = ls[1] && ls[1].match(/^(\d+):(\d+):(\d+)[,.](\d+)/);
    if (tm) cues.push({ sec: (+tm[1] * 60 + +tm[2]) * 60 + +tm[3] + +tm[4] / 1000, text: ls.slice(2).join(' ').trim() });
  }
  return cues;
}

function sourceSegments(asset) {
  const cards = retention.cardsForAsset(asset);
  const tl = dataOf(parse(asset.timeline));
  const durSec = ((tl.duration_profile || {}).observed_duration_ms || 0) / 1000;
  const cues = srtCues(asset.srt);
  return cards.map((c, i) => {
    const start = c.start_sec != null ? c.start_sec : (durSec ? c.start_ratio * durSec : 0);
    const next = cards[i + 1];
    const end = next ? (next.start_sec != null ? next.start_sec : (durSec ? next.start_ratio * durSec : Infinity)) : Infinity;
    return {
      stage_id: c.stage_id, function: c.function, position_label: c.position_label,
      start_ratio: c.start_ratio, end_ratio: c.end_ratio,
      purpose: c.purpose || '', abstract_move: c.abstract_move || '',
      deletability: c.deletability, deletability_reason: c.deletability_reason || '',
      peaks: arr(c.peaks).map(p => ({ peak_id: p.peak_id, peak_type: p.peak_type, strength: p.strength })),
      text: cues.filter(q => q.sec >= start && q.sec < end).map(q => q.text).join(' ')
    };
  });
}

// ---------- 新稿切章 ----------
function scriptChapters(script) {
  const re = /^\[(CH\d+)\s*\|\s*([^|\]]*?)\s*\|\s*([^\]]*?)\s*\]\s*$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(script)) !== null) marks.push({ id: m[1], range: m[2], fn: m[3], tag: m[0].trim(), index: m.index, end: m.index + m[0].length });
  return marks.map((k, i) => {
    const bodyEnd = i + 1 < marks.length ? marks[i + 1].index : script.length;
    const r = k.range.match(/(\d+:\d+(?::\d+)?)\s*[-–—]\s*(\d+:\d+(?::\d+)?)/);
    return { id: k.id, tag: k.tag, fn: k.fn, range: k.range, start: r ? checks.toSec(r[1]) : null, end: r ? checks.toSec(r[2]) : null, text: script.slice(k.end, bodyEnd).trim(), bodyStart: k.end, bodyEnd };
  });
}

// 替换一章正文,标签行不动
function replaceChapter(script, chId, newText) {
  const ch = scriptChapters(script).find(c => c.id === chId);
  if (!ch) return null;
  const tail = script.slice(ch.bodyEnd);
  return script.slice(0, ch.bodyStart) + '\n' + String(newText || '').trim() + (tail ? '\n\n' + tail.replace(/^\s+/, '') : '\n');
}

function blueprintOf(run) {
  const bp = parse(checks.stripFence((run.outputs || {}).step1 || '')) || checks.extractJsonObject((run.outputs || {}).step1 || '') || {};
  return arr(bp.chapters);
}

// 稿子的当前版本(和稿件检查同一份:有 V1 存档取 V1,否则取终稿)
function currentScript(run) { return run.script_v1 || run.final_script || ''; }
function writeScript(run, text) {
  if (run.script_v1) run.script_v1 = text; else run.final_script = text;
  // V1 文案已变:这一版的扫描与简介缓存过期
  ['compliance_scans', 'opening_scans', 'descriptions'].forEach(k => { if (run[k] && run[k].v1) run[k].v1.stale = true; });
}

// ---------- 事实 ----------
// 事实里的「有辨识度的数」:三位以上、带小数或百分号的数,去掉千分位
function factNumbers(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/\d[\d,]*(?:\.\d+)?\s*%?/g)) {
    const raw = m[0].replace(/\s+/g, '');
    const n = raw.replace(/,/g, '');
    if (/%$/.test(n) || /\./.test(n) || n.replace(/\D/g, '').length >= 3) out.add(n.replace(/%$/, ''));
  }
  return [...out];
}

function factState(f) {
  const src = [f.source, f.url].filter(Boolean).join(' ');
  if (f.kind === '待查' || /模型记忆|待人工核实|待核/.test(src)) return { state: 'red', why: '没有查到出处' };
  if (WEAK_SOURCES.test(src)) return { state: 'red', why: '出处是论坛或个人博客,不能当事实' };
  if (f.kind === '估算') return f.method ? { state: 'yellow', why: '估算:' + f.method } : { state: 'red', why: '估算但没写算法' };
  if (f.kind === '假设') return { state: 'yellow', why: '假设,稿中要明说' };
  if (!f.source && !f.url) return { state: 'red', why: '没有写来源' };
  return { state: 'green', why: f.url ? '有链接' : '有来源' };
}

function factView(f, marks) {
  const st = factState(f);
  const mk = (marks || {})['facts.' + f.id] || {};
  return {
    id: f.id, kind: f.kind || '', content: f.content || '', source: f.source || '', url: f.url || '', year: f.year || '', region: f.region || '',
    method: f.method || '', state: st.state, why: st.why,
    evidence: arr(mk.evidence).map(e => ({ title: e.title, url: e.url, date: e.date, quote: e.quote || '' }))
  };
}

// ---------- 红旗 ----------
function numberTokensOf(text) {
  return [...String(text || '').matchAll(/\d[\d,]*(?:\.\d+)?\s*%?/g)].map(m => m[0].replace(/\s+/g, '').replace(/,/g, '').replace(/%$/, ''))
    .filter(n => /\./.test(n) || n.length >= 3);
}

function chapterFlags(ch, ctx) {
  const flags = [];
  for (const h of ctx.tools.findOverlaps(ch.text)) flags.push({ type: '照抄原片', text: h });
  if (ctx.hanCheck) {
    const han = [...new Set((ch.text.match(/[㐀-鿿]+/g) || []))];
    if (han.length) flags.push({ type: '汉字残留', text: han.join('、') });
  }
  for (const w of ctx.lintTerms) if (ch.text.includes(w)) flags.push({ type: '翻译腔', text: w });
  const sentences = ch.text.split(/(?<=[.?!。!?])\s+|\n+/).map(x => x.trim()).filter(Boolean);
  const hedges = sentences.filter(x => HEDGE_RE.test(x));
  if (hedges.length) flags.push({ type: '免责插句', text: hedges.map(x => x.slice(0, 60)).join(' / ') });
  if (ch.isLast && sentences.length && HEDGE_RE.test(sentences[sentences.length - 1]) ) flags.push({ type: '结尾', text: '最后一句是免责/中性说法,不是结尾落点判断' });
  const unknown = [...new Set(numberTokensOf(ch.text).filter(n => !ctx.knownNumbers.has(n)))];
  if (unknown.length) flags.push({ type: '数字不在事实表', text: unknown.slice(0, 8).join('、') });
  // 同一个数第 4 次(含)以后出现才算重复:开场的锚点数(如单价)前后呼应两三次是正常的;年份不算
  const repeated = [...new Set(numberTokensOf(ch.text).filter(n => !/^(19|20)\d{2}$/.test(n) && (ctx.numberChapters[n] || []).indexOf(ch.id) >= REPEAT_AFTER))];
  if (repeated.length) flags.push({ type: '重复', text: repeated.map(n => n + ' 已在 ' + ctx.numberChapters[n].slice(0, ctx.numberChapters[n].indexOf(ch.id)).join('、') + ' 出现过').join(';') });
  if (ch.budget) {
    const r = ch.words / ch.budget;
    if (r > 1.3) flags.push({ type: '篇幅', text: ch.words + ' 词,预算 ' + ch.budget + '(' + Math.round(r * 100) + '%)' });
    else if (r < 0.6) flags.push({ type: '篇幅', text: ch.words + ' 词,预算 ' + ch.budget + '(只有 ' + Math.round(r * 100) + '%)' });
  }
  return flags;
}

// 相邻两版逐章对比:改前/改后正文、中文、这一章的问题
function versionDiffs(state) {
  const vs = arr(state.versions);
  const out = [];
  for (let i = 1; i < vs.length; i++) {
    const before = Object.fromEntries(scriptChapters(vs[i - 1].text).map(c => [c.id, c]));
    const issues = arr(vs[i].issues);
    out.push({
      key: vs[i].key, from: vs[i - 1].label, to: vs[i].label, at: vs[i].at,
      general_issues: issues.filter(x => !/^CH/.test(x.chapter)),
      chapters: scriptChapters(vs[i].text).map(c => {
        const b = before[c.id] || { text: '' };
        return {
          id: c.id, fn: c.fn, range: c.range, changed: b.text !== c.text,
          before: b.text, after: c.text, zh_before: zhOf(state, b.text), zh_after: zhOf(state, c.text),
          issues: issues.filter(x => x.chapter === c.id)
        };
      })
    });
  }
  return out;
}

// ---------- 视图 ----------
function buildView(run, asset) {
  const script = currentScript(run);
  const a = run.analysis || {};
  const marks = a.ai_marks || {};
  const facts = arr(a.facts);
  const segs = sourceSegments(asset);
  const segById = Object.fromEntries(segs.map(s => [s.stage_id, s]));
  const bp = blueprintOf(run);
  const chs = scriptChapters(script);
  const total = chs.length ? Math.max(...chs.map(c => c.end || 0)) : 0;
  const state = run.review || {};
  const lang = (run.audience || {}).target_language || '';
  const tools = checks.makeRefTools({ examples: asset.examples, srt: asset.srt, timeline: asset.timeline });

  // 数字白名单:事实表 + 账本里出现过的数
  const knownNumbers = new Set();
  facts.forEach(f => factNumbers([f.content, f.method].join(' ')).forEach(n => knownNumbers.add(n)));
  arr(a.ledger).forEach(l => factNumbers([l.item, l.value].join(' ')).forEach(n => knownNumbers.add(n)));
  const numberChapters = {};
  chs.forEach(c => [...new Set(numberTokensOf(c.text))].forEach(n => { (numberChapters[n] = numberChapters[n] || []).push(c.id); }));
  const ctx = {
    tools, knownNumbers, numberChapters,
    hanCheck: !/^(Chinese|Japanese)$/i.test(lang),
    lintTerms: TRANSLATIONESE[lang] || []
  };

  const modOf = id => arr(a.modules).find(m => m.segment === id) || null;
  const usedSegs = new Set();
  const rows = chs.map((c, i) => {
    const b = bp.find(x => x.id === c.id) || bp[i] || {};
    let segIds = arr(b.source_segments).filter(id => segById[id]);
    if (!segIds.length && total && c.start != null) {
      // 蓝图没写对应段(旧任务):按时间比例找重叠最多的原片段
      const s0 = c.start / total, s1 = (c.end || c.start) / total;
      let best = null, bestOv = 0;
      segs.forEach(s => { const ov = Math.min(s1, s.end_ratio) - Math.max(s0, s.start_ratio); if (ov > bestOv) { bestOv = ov; best = s; } });
      if (best) segIds = [best.stage_id];
    }
    segIds.forEach(id => usedSegs.add(id));
    const byNumber = facts.filter(f => factNumbers(f.content).some(n => numberTokensOf(c.text).includes(n))).map(f => f.id);
    const factIds = [...new Set([...arr(b.fact_ids), ...byNumber])].filter(id => facts.some(f => f.id === id));
    const st = (state.chapters || {})[c.id] || {};
    const row = {
      id: c.id, tag: c.tag, fn: c.fn, range: c.range, text: c.text, words: checks.countWords(c.text),
      budget: Number(b.word_budget) || null, purpose: b.purpose || '', treatment: b.treatment || '',
      carries_peaks: arr(b.carries_peaks),
      source: segIds.map(id => {
        const s = segById[id];
        const m = modOf(id);
        return {
          stage_id: id, function: s.function, position_label: s.position_label, abstract_move: s.abstract_move,
          deletability: s.deletability, peaks: s.peaks, text: s.text,
          decision: m ? m.decision : '', reason: m ? (m.reason || '') : ''
        };
      }),
      facts: factIds.map(id => factView(facts.find(f => f.id === id), marks)),
      status: st.status || '待审',
      history: arr(st.history).map(h => ({ at: h.at, note: h.note || '', by: h.by || '', text: h.text })),
      zh: zhOf(state, c.text),
      last_reply: st.last_reply || ''
    };
    row.isLast = i === chs.length - 1;
    row.flags = chapterFlags(row, ctx);
    return row;
  });

  // 没有任何一章承接的原片段:AI 删掉或并入了
  const dropped = segs.filter(s => !usedSegs.has(s.stage_id)).map(s => {
    const m = modOf(s.stage_id);
    return {
      stage_id: s.stage_id, function: s.function, position_label: s.position_label, abstract_move: s.abstract_move,
      deletability: s.deletability, peaks: s.peaks, text: s.text,
      decision: m ? m.decision : '没有章节承接', reason: m ? (m.reason || '') : ''
    };
  });

  const usedFacts = new Set(rows.flatMap(r => r.facts.map(f => f.id)));
  const redFacts = facts.filter(f => usedFacts.has(f.id) && factState(f).state === 'red').map(f => f.id);
  const words = rows.reduce((n, r) => n + r.words, 0);
  const budget = rows.reduce((n, r) => n + (r.budget || 0), 0);
  return {
    run_id: run.id, status: run.status, target_language: lang,
    passes: { check: (run.steps || {}).draft_check || null, audit: (run.steps || {}).reverse_audit || null, final: (run.steps || {}).final_review || null },
    audit: state.audit ? { ...state.audit, score: state.audit.score != null ? state.audit.score : reportScore(state.audit.report), stale: state.audit.base_hash !== hash(script) && ((arr(state.versions).find(v => v.key === 'd3') || {}).text) !== script } : null,
    versions: arr(state.versions).map(v => ({ key: v.key, label: v.label, at: v.at, issues: arr(v.issues), changed: arr(v.changed), truncated: !!v.truncated })),
    diffs: versionDiffs(state),
    translating: ((run.steps || {}).review_zh || {}).status === 'running',
    zh_error: ((run.steps || {}).review_zh || {}).error || '',
    rows, dropped,
    facts: facts.map(f => ({ ...factView(f, marks), used: usedFacts.has(f.id) })),
    ledger: arr(a.ledger),
    summary: {
      chapters: rows.length, passed: rows.filter(r => r.status === '通过').length,
      flags: rows.reduce((n, r) => n + r.flags.length, 0),
      red_facts: redFacts, words, budget, ratio: budget ? Math.round(words / budget * 100) / 100 : null,
      ledger_mismatches: an().verifyLedger(arr(a.ledger)).mismatches,
      thesis_contradicts: arr((a.thesis_check || {}).contradicts),
      thesis_note: (a.thesis_check || {}).note || ''
    }
  };
}

function loadRunAsset(runId) {
  const run = store.getRun(runId);
  if (!run) throw Object.assign(new Error('任务不存在'), { status: 404 });
  const asset = store.getAsset(run.asset_id);
  if (!asset) throw Object.assign(new Error('资产不存在: ' + run.asset_id), { status: 400 });
  return { run, asset };
}

function getView(runId) {
  const { run, asset } = loadRunAsset(runId);
  if (!currentScript(run)) throw Object.assign(new Error('稿子还没写好'), { status: 400 });
  return buildView(run, asset);
}

// ---------- 翻译(中文对照) ----------
// 译文按原文的 hash 存(review.zh.byHash):同一段文字不管出现在初稿、二稿还是终稿里,只翻一次。
// 输入输出都用 ===编号=== 分段的纯文本,不要求模型输出 JSON(长篇韩文塞进 JSON 字符串,模型常漏转义,实测「输出不是合法 JSON」)
function needsZh(text) {
  const t = String(text || '');
  const han = (t.match(/[㐀-鿿]/g) || []).length;
  const other = (t.match(/[가-힯぀-ヿA-Za-zЀ-ӿ؀-ۿ฀-๿À-ɏ]/g) || []).length;
  return other > han;
}

// ===KEY=== 分段文本 → { KEY: 内容 };没有收尾的最后一段(输出被截断)丢掉
function parseBlocks(text, truncated) {
  const out = {};
  const re = /^===\s*([A-Za-z0-9_]+)\s*===\s*$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(String(text || ''))) !== null) marks.push({ key: m[1].toUpperCase(), start: m.index, end: m.index + m[0].length });
  marks.forEach((k, i) => {
    if (k.key === 'END') return;
    const next = marks[i + 1];
    if (!next && truncated) return;
    out[k.key] = String(text).slice(k.end, next ? next.start : undefined).trim();
  });
  return out;
}

async function rawCall(run, cfg, prompt, label) {
  return an().callWithLog(run, cfg, [{ role: 'user', content: prompt }], label);
}

async function translateTexts(run, cfg, texts, label) {
  const out = {};
  const items = [...new Set(texts.filter(t => t && needsZh(t)))];
  let batch = [], size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const keyed = {};
    batch.forEach((t, i) => { keyed['T' + (i + 1)] = t; });
    const prompt = an().fillVars(readPrompt('translate.md'), { items: Object.keys(keyed).map(k => '===' + k + '===\n' + keyed[k]).join('\n') });
    let r = await rawCall(run, cfg, prompt, label);
    let got = parseBlocks(r.content, r.stopReason === 'max_tokens');
    // 漏了的段单独再翻一次
    for (const k of Object.keys(keyed).filter(k => !got[k])) {
      const r2 = await rawCall(run, cfg, an().fillVars(readPrompt('translate.md'), { items: '===' + k + '===\n' + keyed[k] }), label + '补翻');
      Object.assign(got, parseBlocks(r2.content, r2.stopReason === 'max_tokens'));
    }
    Object.keys(keyed).forEach(k => { if (got[k]) out[hash(keyed[k])] = got[k]; });
    batch = []; size = 0;
  };
  for (const t of items) {
    if (size + t.length > TRANSLATE_BATCH_CHARS) await flush();
    batch.push(t); size += t.length;
  }
  await flush();
  return out;
}

function zhOf(state, text) {
  const z = (state && state.zh) || {};
  return (z.byHash || {})[hash(text)] || '';
}

// 要翻的:当前稿每一章 + 各版本改过的章节(改前和改后)
function textsToTranslate(run) {
  const texts = scriptChapters(currentScript(run)).map(c => c.text);
  const vs = arr((run.review || {}).versions);
  for (let i = 1; i < vs.length; i++) {
    const before = Object.fromEntries(scriptChapters(vs[i - 1].text).map(c => [c.id, c.text]));
    scriptChapters(vs[i].text).forEach(c => { if (before[c.id] !== c.text) texts.push(c.text, before[c.id] || ''); });
  }
  const have = ((run.review || {}).zh || {}).byHash || {};
  return texts.filter(t => t && !have[hash(t)]);
}

async function translateRun(runId) {
  const cfg = pl().loadConfig();
  let run = store.getRun(runId);
  if (!run || !cfg || !cfg.api_key) return;
  run.steps = { ...(run.steps || {}), review_zh: { status: 'running', started_at: new Date().toISOString() } };
  store.saveRun(run);
  try {
    const tr = await translateTexts(run, cfg, textsToTranslate(run), '中文对照');
    const fresh = store.getRun(runId) || run;
    fresh.review = fresh.review || {};
    fresh.review.zh = fresh.review.zh || {};
    fresh.review.zh.byHash = { ...(fresh.review.zh.byHash || {}), ...tr };
    fresh.steps = { ...(fresh.steps || {}), review_zh: { status: 'done', finished_at: new Date().toISOString() } };
    if (run.attempts) fresh.attempts = run.attempts;
    store.saveRun(fresh);
  } catch (e) {
    const fresh = store.getRun(runId) || run;
    fresh.steps = { ...(fresh.steps || {}), review_zh: { status: 'failed', error: e.message } };
    store.saveRun(fresh);
  }
}

// ---------- 初稿检查 → 二稿,终审 → 终稿 ----------
// 两遍都是:模型先列问题清单,再只重写有问题的章节(整章正文);程序换进稿子、校验章节结构,存成新版本。
// 版本存在 review.versions(初稿 / 二稿 / 终稿),页面按相邻两版逐章对比。
const PASSES = {
  check: { label: '二稿', step: 'draft_check', prompt: 'draft_check.md', title: '初稿检查' },
  final: { label: '终稿', step: 'final_review', prompt: 'final_review.md', title: '终审' }
};
const ISSUE_RE = /^\s*[-*•]\s*\[(CH\d+|全篇|全片|ALL)\]\s*\[([^\]]+)\]\s*(.+)$/i;

function parseIssues(text) {
  return String(text || '').split('\n').map(l => {
    const m = l.match(ISSUE_RE);
    if (!m) return null;
    const parts = m[3].split(/\s*[｜|]\s*/);
    const pick = re => (parts.find(p => re.test(p)) || '').replace(re, '').trim();
    return {
      chapter: /^CH/i.test(m[1]) ? m[1].toUpperCase() : '全篇', category: m[2].trim(),
      problem: parts[0].trim(), quote: pick(/^原句[:：]\s*/), fix: pick(/^改法[:：]\s*/)
    };
  }).filter(Boolean);
}

function chapterMap(run, asset) {
  const view = buildView(run, asset);
  return view.rows.map(r => {
    const tpl = r.source.map(s => s.stage_id + ' ' + (s.function || '') + ':' + (s.abstract_move || '') + (s.peaks.length ? '(持有高峰 ' + s.peaks.map(p => p.peak_id + ' ' + (p.peak_type || '')).join('、') + ')' : '') + (s.decision ? ';分析时的处理:' + s.decision : '')).join(' / ');
    return '- ' + r.id + ' ' + r.range + ' ' + r.fn + (r.budget ? ' 预算 ' + r.budget + ' 词,现 ' + r.words + ' 词' : '') + '\n  模板:' + (tpl || '(无)') +
      (r.purpose ? '\n  蓝图目标:' + r.purpose : '') +
      (r.flags.length ? '\n  程序查出:' + r.flags.map(f => f.type + '「' + f.text.slice(0, 120) + '」').join(';') : '');
  }).join('\n');
}

function programFindings(run, asset) {
  const v = buildView(run, asset);
  const s = v.summary;
  const out = [];
  if (s.ledger_mismatches.length) out.push('账本对不上(程序按公式重算):' + s.ledger_mismatches.join(';'));
  if (s.thesis_contradicts.length) out.push('反转被事实推翻:' + s.thesis_contradicts.join('、') + (s.thesis_note ? '(' + s.thesis_note + ')' : ''));
  if (s.red_facts.length) out.push('稿里用到但没有出处的事实:' + s.red_facts.join('、') + '(要么删掉这句,要么改成不依赖它的说法)');
  if (s.budget) out.push('篇幅:' + s.words + ' 词,预算 ' + s.budget + ' 词');
  const len = (run.checks || {}).length;
  if (len && !len.ok) out.push('篇幅超标:' + len.detail);
  return out.join('\n') || '(无)';
}

async function runPass(runId, kind) {
  const P = PASSES[kind];
  const cfg = pl().loadConfig();
  let { run, asset } = loadRunAsset(runId);
  if (!cfg || !cfg.api_key) throw Object.assign(new Error('未配置 API Key'), { status: 400 });
  const start = currentScript(run);
  if (!start) throw Object.assign(new Error('稿子还没写好'), { status: 400 });
  // 重跑终审(比如换了一组审稿意见):终稿之后没人动过稿子,就从二稿重新改,不在旧终稿上叠改
  const vByKey = Object.fromEntries(arr((run.review || {}).versions).map(v => [v.key, v]));
  const base = kind === 'final' && vByKey.d2 && vByKey.d3 && vByKey.d3.text === start ? vByKey.d2.text : start;
  run.steps = { ...(run.steps || {}), [P.step]: { status: 'running', started_at: new Date().toISOString() } };
  run.review = run.review || {};
  // 第一遍之前把当前稿存成初稿
  if (!arr(run.review.versions).length) run.review.versions = [{ key: 'd1', label: '初稿', at: new Date().toISOString(), text: base, issues: [] }];
  store.saveRun(run);
  try {
    const a = run.analysis || {};
    const aud = run.audience || {};
    const prompt = an().fillVars(readPrompt(P.prompt), {
      today: pl().todayStr(),
      topic: run.topic,
      title: ((a.title || {}).final_title) || run.topic,
      target_language: aud.target_language || '',
      target_country: aud.target_country || '',
      video_goal: aud.video_goal || '',
      voice: voice.voiceBrief(voice.voiceForRun(run)) || '(未设定)',
      analysis: run.analysis ? an().analysisBrief(a) : '(无写前分析)',
      chapter_map: chapterMap(run, asset),
      program_findings: programFindings(run, asset),
      selected_fixes: kind === 'final' ? selectedFixes(run) : '',
      script: base
    });
    const r = await rawCall(run, cfg, prompt, P.title);
    const blocks = parseBlocks(r.content, r.stopReason === 'max_tokens');
    const issues = parseIssues(blocks.ISSUES || r.content.split(/^===\s*CH\d+/m)[0]);
    let next = base;
    const changed = [];
    for (const ch of scriptChapters(base)) {
      const t = blocks[ch.id];
      if (!t) continue;
      const clean = t.replace(/^\s*\[CH\d+[^\]]*\]\s*\n?/, '').trim(); // 模型偶尔把标签行带进来
      if (!clean || clean === ch.text) continue;
      const tryNext = replaceChapter(next, ch.id, clean);
      if (tryNext && !checks.chapterStructureError(tryNext)) { next = tryNext; changed.push(ch.id); }
    }
    const fresh = store.getRun(runId) || run;
    if (currentScript(fresh) !== start) throw new Error('这一遍运行期间稿子被改过,结果没有保存,请重跑');
    fresh.review = fresh.review || {};
    const versions = arr(fresh.review.versions).length ? fresh.review.versions : [{ key: 'd1', label: '初稿', at: new Date().toISOString(), text: base, issues: [] }];
    // 重跑同一遍:替换掉旧的同名版本及其后的版本
    const keep = versions.filter(v => v.key === 'd1' || (kind === 'final' && v.key === 'd2'));
    keep.push({ key: kind === 'check' ? 'd2' : 'd3', label: P.label, at: new Date().toISOString(), text: next, issues, changed, truncated: r.stopReason === 'max_tokens' });
    fresh.review.versions = keep;
    if (next !== start) writeScript(fresh, next);
    if (changed.length) {
      changed.forEach(id => { const st = chapterState(fresh, id); st.status = '待审'; st.history = [...arr(st.history), { at: new Date().toISOString(), note: P.title, by: kind, text: scriptChapters(base).find(c => c.id === id).text }].slice(-HISTORY_MAX); });
    }
    fresh.steps = { ...(fresh.steps || {}), [P.step]: { status: 'done', secs: Math.round(r.secs * 10) / 10, finished_at: new Date().toISOString(), issues: issues.length, changed: changed.length } };
    if (kind === 'check') { delete fresh.steps.final_review; delete fresh.steps.reverse_audit; if (fresh.review.audit) fresh.review.audit = null; }
    if (kind === 'final' && fresh.review.audit) fresh.review.audit.used_selection = (fresh.review.audit.selection || null);
    if (run.attempts) fresh.attempts = run.attempts;
    store.saveRun(fresh);
    return { ok: true, issues: issues.length, changed };
  } catch (e) {
    const fresh = store.getRun(runId) || run;
    fresh.steps = { ...(fresh.steps || {}), [P.step]: { status: 'failed', error: e.message } };
    store.saveRun(fresh);
    throw e;
  }
}

// ---------- 二稿逆向工程审稿(终审前) ----------
// 把原片标题、原文案、拆解框架、新题目、新标题和二稿交给模型,按用户的审稿提示词出完整报告(赛道、评分、迁移对照、
// 逐段问题 P01…、深层问题、P0/P1/P2、三种修改路线)。报告末尾附一段 ===SCORE=== / ===ISSUES=== / ===ROUTE=== 清单给程序读。
// 报告出来后流程停住:人在页面上勾选要改的问题、选修改路线,再带着这些去终审。
const AUDIT_ISSUE_RE = /^\s*[-*•]\s*\[(P\d+)\]\s*\[([SABC])[级]?\]\s*\[(P[012])\]\s*\[([^\]]+)\]\s*(.+)$/i;
const AUDIT_MAX_ROUNDS = 4; // 报告很长,被 max_tokens 截断就接着写,最多续 3 次
const ROUTE_NAMES = { A: '最小修改', B: '结构优化', C: '深度重构' };

function parseAuditIssues(text) {
  return String(text || '').split('\n').map(l => {
    const m = l.match(AUDIT_ISSUE_RE);
    if (!m) return null;
    const parts = m[5].split(/\s*[｜|]\s*/);
    return {
      id: m[1].toUpperCase().replace(/^P(\d)$/, 'P0$1'), severity: m[2].toUpperCase(), priority: m[3].toUpperCase(),
      chapter: /^CH/i.test(m[4].trim()) ? m[4].trim().toUpperCase() : '全篇',
      type: (parts[0] || '').trim(), problem: (parts[1] || '').trim(),
      direction: (parts.find((p, i) => i > 1 && /^修改方向[:：]/.test(p)) || parts[2] || '').replace(/^修改方向[:：]\s*/, '').trim()
    };
  }).filter(Boolean);
}

// 报告里每个「问题编号:P01」小节的全文(给终审用,里面有原文位置、为什么不好、修改方向、示范修改)
function auditSections(report) {
  const out = {};
  const re = /^#{1,6}\s*\**\s*问题编号\s*[:：]\s*(P\d+)/gim;
  const marks = [];
  let m;
  while ((m = re.exec(report)) !== null) marks.push({ id: m[1].toUpperCase(), index: m.index, after: m.index + m[0].length, level: (m[0].match(/^#+/) || ['##'])[0].length });
  marks.forEach((k, i) => {
    let end = i + 1 < marks.length ? marks[i + 1].index : report.length;
    // 最后一个问题之后是「深层问题」等大标题:截到下一个同级或更高级的标题
    if (i + 1 === marks.length) {
      const nx = report.slice(k.after).search(new RegExp('^#{1,' + k.level + '}\\s', 'm'));
      if (nx >= 0) end = k.after + nx;
    }
    out[k.id] = report.slice(k.index, end).trim();
  });
  return out;
}

// 报告里三种修改路线各自的说明
function routeSections(report) {
  const out = {};
  const re = /^#{1,6}\s*(?:方案|路线)?\s*([ABC])\s*[.．、:：]\s*(最小修改|结构优化|深度重构)?/gm;
  const marks = [];
  let m;
  while ((m = re.exec(report)) !== null) marks.push({ id: m[1], index: m.index, after: m.index + m[0].length, level: (m[0].match(/^#+/) || [''])[0].length });
  marks.forEach(k => {
    const nx = report.slice(k.after).search(new RegExp('^#{1,' + k.level + '}\\s', 'm'));
    const end = nx >= 0 ? k.after + nx : report.length;
    if (!out[k.id]) out[k.id] = report.slice(k.index, end).trim();
  });
  return out;
}

// 总分:先看清单里的 ===SCORE===;没有就从报告正文里找「总分:68 分 / 68/100」;再没有就把评分表的「实际得分」列加起来
function reportScore(report, scoreBlock) {
  const ok = n => (isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 10) / 10 : null);
  const fromBlock = String(scoreBlock || '').match(/(\d+(?:\.\d+)?)/);
  if (fromBlock && ok(+fromBlock[1]) != null) return ok(+fromBlock[1]);
  const text = String(report || '').replace(/\*+/g, '');
  const inReport = text.match(/===\s*SCORE\s*===\s*\n\s*(\d+(?:\.\d+)?)/);
  if (inReport && ok(+inReport[1]) != null) return ok(+inReport[1]);
  // 「总分」后面跟着数字,数字后面是「分」或「/100」;跳过权重合计的 100
  const re = /总(?:分|得分|评分)[^\d\n]{0,15}?(\d{1,3}(?:\.\d+)?)\s*(分|\/\s*100|／\s*100)?/g;
  let m, loose = null;
  while ((m = re.exec(text)) !== null) {
    const n = ok(+m[1]);
    if (n == null) continue;
    if (m[2] && n !== 100) return n;
    if (loose == null && n !== 100) loose = n;
  }
  // 评分表:表头里有「实际得分」的那张,把这一列加起来(跳过「合计/总分」行)
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i]) || !/实际得分|得分/.test(lines[i])) continue;
    const head = lines[i].split('|').map(s => s.trim());
    const col = head.findIndex(h => /实际得分/.test(h)) >= 0 ? head.findIndex(h => /实际得分/.test(h)) : head.findIndex(h => /^得分$/.test(h));
    if (col < 0) continue;
    let sum = 0, rows = 0, total = null;
    for (let j = i + 1; j < lines.length && /^\s*\|/.test(lines[j]); j++) {
      const cells = lines[j].split('|').map(s => s.trim());
      const v = parseFloat(cells[col]);
      if (!isFinite(v)) continue;
      if (/合计|总分|总计/.test(cells[1] || '')) { total = v; continue; }
      sum += v; rows++;
    }
    if (total != null && ok(total) != null) return ok(total);
    if (rows >= 3 && ok(sum) != null) return ok(sum);
  }
  return loose;
}

// 问题小节里某个字段的内容:「**问题类型:** xxx」同一行,或者标题下一行
function auditField(section, name) {
  const lines = section.split('\n');
  const i = lines.findIndex(l => l.replace(/\*+/g, '').trim().startsWith(name));
  if (i < 0) return '';
  const same = lines[i].replace(/\*+/g, '').trim().slice(name.length).replace(/^[\s:：]+/, '').trim();
  if (same) return same;
  const next = lines.slice(i + 1).find(l => l.trim());
  return next ? next.replace(/\*+/g, '').replace(/^\s*[-*•]\s*/, '').trim() : '';
}

function sourceTitle(asset) {
  const m = asset.meta || {};
  return [m.source_title, m.source_title_zh ? '(中文:' + m.source_title_zh + ')' : ''].filter(Boolean).join(' ') || m.name || asset.id;
}

function sourceScript(asset) {
  const cues = srtCues(asset.srt);
  if (!cues.length) return '(没有原片字幕,无法提供完整原文案)';
  // 停顿超过 1.5 秒另起一段,方便模型定位
  let out = '', last = null;
  cues.forEach(c => { out += (last == null ? '' : c.sec - last > 1.5 ? '\n' : ' ') + c.text; last = c.sec; });
  return out.trim();
}

function frameworkText(asset) {
  const fw = dataOf(parse(asset.framework));
  return Object.keys(fw).length ? JSON.stringify(fw, null, 1) : '(没有拆解框架)';
}

// 长输出:被 max_tokens 截断就让模型接着写,拼起来
async function callLong(run, cfg, prompt, label) {
  let messages = [{ role: 'user', content: prompt }];
  let text = '', r = null, secs = 0;
  for (let round = 0; round < AUDIT_MAX_ROUNDS; round++) {
    r = await an().callWithLog(run, cfg, messages, round ? label + '续写' + round : label);
    text += r.content;
    secs += r.secs || 0;
    if (r.stopReason !== 'max_tokens') return { content: text, secs, truncated: false };
    messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: '输出被截断了。从你上一条最后一个字接着往下写,不要重复已经写过的内容,不要重新开头,最后照样输出 ===SCORE=== 那段清单。' }];
  }
  return { content: text, secs, truncated: true };
}

async function runReverseAudit(runId) {
  const cfg = pl().loadConfig();
  let { run, asset } = loadRunAsset(runId);
  if (!cfg || !cfg.api_key) throw Object.assign(new Error('未配置 API Key'), { status: 400 });
  const cur = currentScript(run);
  if (!cur) throw Object.assign(new Error('稿子还没写好'), { status: 400 });
  // 已经终审过、之后没人动过稿子:审的仍是二稿
  const vByKey = Object.fromEntries(arr((run.review || {}).versions).map(v => [v.key, v]));
  const base = vByKey.d2 && vByKey.d3 && vByKey.d3.text === cur ? vByKey.d2.text : cur;
  run.steps = { ...(run.steps || {}), reverse_audit: { status: 'running', started_at: new Date().toISOString() } };
  store.saveRun(run);
  try {
    const a = run.analysis || {};
    const aud = run.audience || {};
    const prompt = an().fillVars(readPrompt('reverse_audit.md'), {
      today: pl().todayStr(),
      target_language: aud.target_language || '',
      target_country: aud.target_country || '',
      video_goal: aud.video_goal || '',
      source_title: sourceTitle(asset),
      source_script: sourceScript(asset),
      framework: frameworkText(asset),
      topic: run.topic,
      title: ((a.title || {}).final_title) || run.topic,
      analysis: run.analysis ? an().analysisBrief(a) : '(无写前分析)',
      script: base
    });
    const r = await callLong(run, cfg, prompt, '二稿审稿');
    // 模型偶尔给清单的分隔行加粗或包进代码围栏:先把 **===SCORE===** / `===SCORE===` 还原成裸分隔行,再去掉围栏
    const content = r.content.replace(/^[*`\s]*(===\s*[A-Za-z]+\s*===)[*`\s]*$/gm, '$1');
    let cut = content.search(/^===\s*(SCORE|ISSUES|ROUTE)\s*===\s*$/m);
    const report = (cut >= 0 ? content.slice(0, cut) : content).replace(/\n```[a-z]*\s*$/, '').trim();
    const blocks = cut >= 0 ? parseBlocks(content.slice(cut).replace(/^```.*$/gm, ''), false) : {};
    const sections = auditSections(report);
    let issues = parseAuditIssues(blocks.ISSUES || '');
    // 清单没出来(截断或模型漏写):从报告的 P 小节里兜底取编号和严重程度
    if (!issues.length) {
      issues = Object.keys(sections).map(id => {
        const s = sections[id];
        const sev = (s.match(/严重程度[^SABC]{0,20}([SABC])\s*级?/) || [])[1] || 'B';
        return { id, severity: sev, priority: sev === 'S' ? 'P0' : sev === 'A' ? 'P1' : 'P2', chapter: (s.match(/CH\d+/i) || ['全篇'])[0].toUpperCase(), type: auditField(s, '问题类型'), problem: auditField(s, '为什么不好').slice(0, 120), direction: auditField(s, '修改方向').slice(0, 120) };
      });
    }
    issues.forEach(x => { x.detail = sections[x.id] || ''; });
    const score = reportScore(report, blocks.SCORE);
    const routeLine = String(blocks.ROUTE || '');
    const recommended = ((routeLine.match(/\b([ABC])\b/) || routeLine.match(/([ABC])/) || [])[1]) || '';
    const fresh = store.getRun(runId) || run;
    fresh.review = fresh.review || {};
    fresh.review.audit = {
      at: new Date().toISOString(), base_hash: hash(base), report, score, issues,
      routes: routeSections(report), recommended, route_reason: routeLine.replace(/^[^|｜]*[|｜]\s*/, '').trim(),
      truncated: r.truncated, selection: null
    };
    fresh.steps = { ...(fresh.steps || {}), reverse_audit: { status: 'done', secs: Math.round(r.secs * 10) / 10, finished_at: new Date().toISOString(), issues: issues.length, score } };
    if (run.attempts) fresh.attempts = run.attempts;
    store.saveRun(fresh);
    return { ok: true, issues: issues.length, score };
  } catch (e) {
    const fresh = store.getRun(runId) || run;
    fresh.steps = { ...(fresh.steps || {}), reverse_audit: { status: 'failed', error: e.message } };
    store.saveRun(fresh);
    throw e;
  }
}

// 人选中的问题 + 路线 → 终审提示词里的「人工确认要改的问题」
function selectedFixes(run) {
  const au = (run.review || {}).audit;
  const sel = au && au.selection;
  if (!sel) return '(无。这一遍按常规终审。)';
  const picked = arr(au.issues).filter(x => arr(sel.ids).includes(x.id));
  const out = [];
  if (sel.route && ROUTE_NAMES[sel.route]) {
    out.push('修改路线:' + sel.route + ' ' + ROUTE_NAMES[sel.route] + (au.routes && au.routes[sel.route] ? '\n' + au.routes[sel.route] : ''));
  }
  if (sel.note) out.push('人工补充意见:' + sel.note);
  if (picked.length) {
    out.push('要改的问题(' + picked.length + ' 条):');
    picked.forEach(x => out.push(x.detail || ('## 问题编号:' + x.id + '\n[' + x.severity + '级 / ' + x.priority + '] ' + x.chapter + ' ' + x.type + ':' + x.problem + '\n修改方向:' + x.direction)));
  }
  return out.join('\n\n') || '(无。这一遍按常规终审。)';
}

// 人确认审稿意见后开始终审:存下选择,后台跑终审和翻译
function startFinal(runId, body) {
  const run = store.getRun(runId);
  if (!run) throw Object.assign(new Error('任务不存在'), { status: 404 });
  if (((run.steps || {}).final_review || {}).status === 'running') throw Object.assign(new Error('终审正在进行'), { status: 400 });
  const au = (run.review || {}).audit;
  if (au) {
    const ids = arr(body.ids).map(String).filter(id => arr(au.issues).some(x => x.id === id));
    au.selection = { ids, route: ROUTE_NAMES[body.route] ? body.route : '', note: String(body.note || '').trim().slice(0, 2000), at: new Date().toISOString() };
    store.saveRun(run);
  }
  runPasses(runId, 'final').catch(() => {});
  return { ok: true };
}

// 初稿检查 → 二稿审稿报告 → 停下等人选;人选完再终审 → 翻译。某一遍失败不影响已有稿子,页面上可以单独重跑
async function runPasses(runId, from) {
  const order = from === 'final' ? ['final'] : from === 'audit' ? ['audit'] : ['check', 'audit'];
  for (const k of order) {
    try { if (k === 'audit') await runReverseAudit(runId); else await runPass(runId, k); } catch (e) { break; }
  }
  await translateRun(runId);
}

// ---------- 一键生成 ----------
async function runDraftFirst(runId) {
  await an().runAnalysis(runId);
  let run = store.getRun(runId);
  if (!run || run.status !== 'awaiting_review') return; // 分析失败或已取消
  try {
    await an().runAutoAdjust(runId, null, { search: true });
  } catch (e) {
    run = store.getRun(runId) || run;
    run.steps = { ...(run.steps || {}), auto_adjust: { status: 'failed', error: e.message } };
    store.saveRun(run);
  }
  run = store.getRun(runId);
  if (!run || run.cancel_requested) { if (run) { run.status = 'cancelled'; store.saveRun(run); } return; }
  run.analysis_confirmed = true;
  run.analysis_auto_confirmed = true;
  run.analysis_confirmed_at = new Date().toISOString();
  run.status = 'queued';
  store.saveRun(run);
  await pl().runGeneration(runId);
  run = store.getRun(runId);
  if (run && run.status === 'done') await runPasses(runId);
}

// 续跑(重试 / 重启接管):还没写稿就从头跑一键生成;已经在写稿就接着写,写完补二稿、终稿和翻译
async function resumeDraftFirst(runId) {
  const run = store.getRun(runId);
  if (!run) return;
  if (!run.analysis_confirmed) return runDraftFirst(runId);
  if (run.status !== 'done') await pl().runGeneration(runId);
  const done = store.getRun(runId);
  if (!done || done.status !== 'done') return;
  const st = done.steps || {};
  if ((st.draft_check || {}).status !== 'done') return runPasses(runId);
  // 终审要等人看完审稿报告再跑,这里只补审稿报告(旧任务已经终审过的不补)
  if ((st.reverse_audit || {}).status !== 'done' && (st.final_review || {}).status !== 'done') return runPasses(runId, 'audit');
  await translateRun(runId);
}

// ---------- 人工处理 ----------
function chapterState(run, chId) {
  run.review = run.review || {};
  run.review.chapters = run.review.chapters || {};
  return (run.review.chapters[chId] = run.review.chapters[chId] || { status: '待审', history: [] });
}

function assertDone(run) {
  if (run.status !== 'done') throw Object.assign(new Error('任务完成后才能逐段审稿(当前: ' + run.status + ')'), { status: 400 });
}

function setStatus(runId, chId, status) {
  const { run } = loadRunAsset(runId);
  assertDone(run);
  if (!scriptChapters(currentScript(run)).some(c => c.id === chId)) throw Object.assign(new Error('找不到章节 ' + chId), { status: 400 });
  chapterState(run, chId).status = status === '通过' ? '通过' : '待审';
  store.saveRun(run);
  return { ok: true };
}

function undo(runId, chId) {
  const { run } = loadRunAsset(runId);
  assertDone(run);
  const st = chapterState(run, chId);
  const prev = arr(st.history).pop();
  if (!prev) throw Object.assign(new Error('这一章没有可以撤回的版本'), { status: 400 });
  const next = replaceChapter(currentScript(run), chId, prev.text);
  if (!next || checks.chapterStructureError(next)) throw Object.assign(new Error('撤回后章节结构不合格'), { status: 400 });
  writeScript(run, next);
  st.status = '待审';
  st.last_reply = '已撤回到上一版';
  store.saveRun(run);
  return { ok: true };
}

const COMPRESS_NOTE = '这一段在本题里撑不住,压成 1–2 句过渡:只保留它要交给下一章的悬念或问题,其他内容删掉。';

// 只重写一章:前后章做衔接参考,不动
async function rewriteChapter(runId, chId, note, opts) {
  const { run, asset } = loadRunAsset(runId);
  assertDone(run);
  const cfg = pl().loadConfig();
  if (!cfg || !cfg.api_key) throw Object.assign(new Error('未配置 API Key'), { status: 400 });
  if (!String(note || '').trim()) throw Object.assign(new Error('意见为空'), { status: 400 });
  const view = buildView(run, asset);
  const i = view.rows.findIndex(r => r.id === chId);
  if (i < 0) throw Object.assign(new Error('找不到章节 ' + chId), { status: 400 });
  const row = view.rows[i];
  const bp = blueprintOf(run).find(c => c.id === chId) || {};
  const a = run.analysis || {};
  const compress = !!(opts && opts.compress);
  const prompt = an().fillVars(readPrompt('rewrite_segment.md'), {
    today: pl().todayStr(),
    topic: run.topic,
    title: ((a.title || {}).final_title) || run.topic,
    target_language: (run.audience || {}).target_language || '',
    thesis: JSON.stringify(a.thesis_card || {}),
    voice: voice.voiceBrief(voice.voiceForRun(run)) || '(未设定)',
    chapter_blueprint: JSON.stringify(bp),
    template: row.source.map(s => s.stage_id + ' ' + s.function + ':' + s.abstract_move + (s.peaks.length ? '(持有高峰 ' + s.peaks.map(p => p.peak_id).join('、') + ')' : '')).join('\n') || '(无)',
    facts: arr(a.facts).map(f => { const st = factState(f); return '- ' + f.id + ' [' + (f.kind || '') + (st.state === 'red' ? ',未核实' : '') + '] ' + (f.content || '') + (f.method ? '(算法:' + f.method + ')' : ''); }).join('\n') || '(无)',
    ledger: arr(a.ledger).map(l => '- ' + l.item + ' = ' + l.value).join('\n') || '(无)',
    prev_text: i > 0 ? view.rows[i - 1].text.slice(-600) : '(这是第一章)',
    next_text: i + 1 < view.rows.length ? view.rows[i + 1].text.slice(0, 600) : '(这是最后一章)',
    current_text: row.text,
    flags: row.flags.map(f => '- ' + f.type + ':' + f.text).join('\n') || '(无)',
    word_budget: compress ? '30 词以内' : String(row.budget || row.words),
    note: compress ? COMPRESS_NOTE + (String(note || '').trim() === COMPRESS_NOTE ? '' : '\n' + note) : note
  });
  const out = await an().callJson(run, cfg, prompt, '单章重写 ' + chId, o => typeof o.text === 'string' && o.text.trim());
  const text = String(out.text).replace(/^\s*\[CH\d+[^\]]*\]\s*\n?/, '').trim(); // 模型偶尔把标签行带进来
  const fresh = store.getRun(runId) || run;
  const cur = currentScript(fresh);
  const chNow = scriptChapters(cur).find(c => c.id === chId);
  if (!chNow) throw Object.assign(new Error('章节已不存在'), { status: 409 });
  const next = replaceChapter(cur, chId, text);
  if (!next || checks.chapterStructureError(next)) throw Object.assign(new Error('重写后章节结构不合格,没有保存'), { status: 400 });
  const st = chapterState(fresh, chId);
  st.history = [...arr(st.history), { at: new Date().toISOString(), note: compress ? '压成过渡' : note, by: (opts && opts.by) || 'note', text: chNow.text }].slice(-HISTORY_MAX);
  st.status = '待审';
  st.last_reply = out.reply || '';
  writeScript(fresh, next);
  if (typeof out.zh === 'string' && out.zh.trim()) {
    fresh.review.zh = fresh.review.zh || {};
    fresh.review.zh.byHash = { ...(fresh.review.zh.byHash || {}), [hash(text)]: out.zh.trim() };
  }
  if (run.attempts) fresh.attempts = run.attempts;
  store.saveRun(fresh);
  return { ok: true, chapter: chId, reply: out.reply || '' };
}

// 改一条事实:写回事实表,再把用到它的章节逐章重写
const FACT_FIELDS = ['content', 'kind', 'source', 'url', 'year', 'region', 'method'];
async function updateFact(runId, factId, patch) {
  const { run, asset } = loadRunAsset(runId);
  assertDone(run);
  const facts = arr((run.analysis || {}).facts);
  const f = facts.find(x => x.id === factId);
  if (!f) throw Object.assign(new Error('找不到事实 ' + factId), { status: 400 });
  const before = { ...f };
  FACT_FIELDS.forEach(k => { if (patch && typeof patch[k] === 'string') f[k] = patch[k].trim(); });
  run.analysis.fact_edits = [...arr(run.analysis.fact_edits), { id: factId, before, after: { ...f }, at: new Date().toISOString() }].slice(-50);
  const affected = buildView({ ...run, analysis: { ...run.analysis, facts: facts.map(x => (x.id === factId ? before : x)) } }, asset)
    .rows.filter(r => r.facts.some(x => x.id === factId)).map(r => r.id);
  store.saveRun(run);
  const contentChanged = before.content !== f.content || before.kind !== f.kind;
  const results = [];
  if (contentChanged) {
    const note = '事实 ' + factId + ' 已改为:' + f.content + '(类型:' + (f.kind || '') + (f.kind === '假设' ? ',稿中要明说是假设' : '') + ')。只改这一章里和它有关的句子和由它算出来的数,其他不动。';
    for (const ch of affected) {
      try { results.push(await rewriteChapter(runId, ch, note, { by: 'fact' })); }
      catch (e) { results.push({ ok: false, chapter: ch, error: e.message }); }
    }
  }
  return { ok: true, fact: factId, affected, rewritten: results };
}

module.exports = { parseBlocks, parseIssues, parseAuditIssues, auditSections, auditField, reportScore, routeSections, runPass, runPasses, runReverseAudit, startFinal, selectedFixes, PASSES, sourceSegments, scriptChapters, replaceChapter, factNumbers, factState, buildView, getView, translateRun, runDraftFirst, resumeDraftFirst, setStatus, undo, rewriteChapter, updateFact, COMPRESS_NOTE };
