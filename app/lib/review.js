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
          zh: ((state.zh || {}).source || {})[id] || '',
          decision: m ? m.decision : '', reason: m ? (m.reason || '') : ''
        };
      }),
      facts: factIds.map(id => factView(facts.find(f => f.id === id), marks)),
      status: st.status || '待审',
      history: arr(st.history).map(h => ({ at: h.at, note: h.note || '', by: h.by || '', text: h.text })),
      zh: (((state.zh || {}).script || {})[c.id] || {}).hash === hash(c.text) ? state.zh.script[c.id].text : '',
      last_reply: st.last_reply || ''
    };
    row.flags = chapterFlags(row, ctx);
    return row;
  });

  // 没有任何一章承接的原片段:AI 删掉或并入了
  const dropped = segs.filter(s => !usedSegs.has(s.stage_id)).map(s => {
    const m = modOf(s.stage_id);
    return {
      stage_id: s.stage_id, function: s.function, position_label: s.position_label, abstract_move: s.abstract_move,
      deletability: s.deletability, peaks: s.peaks, text: s.text, zh: ((state.zh || {}).source || {})[s.stage_id] || '',
      decision: m ? m.decision : '没有章节承接', reason: m ? (m.reason || '') : ''
    };
  });

  const usedFacts = new Set(rows.flatMap(r => r.facts.map(f => f.id)));
  const redFacts = facts.filter(f => usedFacts.has(f.id) && factState(f).state === 'red').map(f => f.id);
  const words = rows.reduce((n, r) => n + r.words, 0);
  const budget = rows.reduce((n, r) => n + (r.budget || 0), 0);
  return {
    run_id: run.id, status: run.status, target_language: lang,
    translating: ((run.steps || {}).review_zh || {}).status === 'running',
    zh_error: ((run.steps || {}).review_zh || {}).error || '',
    rows, dropped,
    facts: facts.map(f => ({ ...factView(f, marks), used: usedFacts.has(f.id) })),
    ledger: arr(a.ledger),
    summary: {
      chapters: rows.length, passed: rows.filter(r => r.status === '通过').length,
      flags: rows.reduce((n, r) => n + r.flags.length, 0),
      red_facts: redFacts, words, budget, ratio: budget ? Math.round(words / budget * 100) / 100 : null
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
function needsZh(text) {
  const t = String(text || '');
  const han = (t.match(/[㐀-鿿]/g) || []).length;
  const other = (t.match(/[가-힯぀-ヿA-Za-zЀ-ӿ؀-ۿ฀-๿À-ɏ]/g) || []).length;
  return other > han;
}

async function translateMap(run, cfg, items, label) {
  const out = {};
  const keys = Object.keys(items).filter(k => needsZh(items[k]));
  let batch = {}, size = 0;
  const flush = async () => {
    if (!Object.keys(batch).length) return;
    const prompt = an().fillVars(readPrompt('translate.md'), { items_json: JSON.stringify(batch) });
    const res = await an().callJson(run, cfg, prompt, label, o => typeof o === 'object' && !Array.isArray(o));
    Object.keys(batch).forEach(k => { if (typeof res[k] === 'string') out[k] = res[k]; });
    batch = {}; size = 0;
  };
  for (const k of keys) {
    if (size + items[k].length > TRANSLATE_BATCH_CHARS) await flush();
    batch[k] = items[k]; size += items[k].length;
  }
  await flush();
  return out;
}

// 原片段的译文全资产共用,按资产缓存在 run 里一份即可(原片不变)
async function translateRun(runId, onlyChapters) {
  const cfg = pl().loadConfig();
  let run = store.getRun(runId);
  if (!run || !cfg || !cfg.api_key) return;
  const asset = store.getAsset(run.asset_id);
  if (!asset) return;
  run.steps = { ...(run.steps || {}), review_zh: { status: 'running', started_at: new Date().toISOString() } };
  store.saveRun(run);
  try {
    const review = run.review || {};
    const zh = review.zh || { source: {}, script: {} };
    zh.source = zh.source || {}; zh.script = zh.script || {};
    if (!onlyChapters) {
      const srcItems = {};
      sourceSegments(asset).forEach(s => { if (s.text && !zh.source[s.stage_id]) srcItems[s.stage_id] = s.text; });
      Object.assign(zh.source, await translateMap(run, cfg, srcItems, '原片中文对照'));
    }
    const chItems = {};
    scriptChapters(currentScript(run)).forEach(c => {
      if (onlyChapters && !onlyChapters.includes(c.id)) return;
      if ((zh.script[c.id] || {}).hash !== hash(c.text)) chItems[c.id] = c.text;
    });
    const tr = await translateMap(run, cfg, chItems, '新稿中文对照');
    const fresh = store.getRun(runId) || run;
    const fz = ((fresh.review || {}).zh) || { source: {}, script: {} };
    fz.source = { ...(fz.source || {}), ...zh.source };
    fz.script = fz.script || {};
    Object.keys(tr).forEach(k => { fz.script[k] = { hash: hash(chItems[k]), text: tr[k] }; });
    fresh.review = { ...(fresh.review || {}), zh: fz };
    fresh.steps = { ...(fresh.steps || {}), review_zh: { status: 'done', finished_at: new Date().toISOString() } };
    if (run.attempts) fresh.attempts = run.attempts;
    store.saveRun(fresh);
  } catch (e) {
    const fresh = store.getRun(runId) || run;
    fresh.steps = { ...(fresh.steps || {}), review_zh: { status: 'failed', error: e.message } };
    store.saveRun(fresh);
  }
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
  if (run && run.status === 'done') await translateRun(runId);
}

// 续跑(重试 / 重启接管):还没写稿就从头跑一键生成;已经在写稿就接着写,写完补翻译
async function resumeDraftFirst(runId) {
  const run = store.getRun(runId);
  if (!run) return;
  if (!run.analysis_confirmed) return runDraftFirst(runId);
  await pl().runGeneration(runId);
  const done = store.getRun(runId);
  if (done && done.status === 'done') await translateRun(runId);
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
    fresh.review.zh = fresh.review.zh || { source: {}, script: {} };
    fresh.review.zh.script = fresh.review.zh.script || {};
    fresh.review.zh.script[chId] = { hash: hash(text), text: out.zh.trim() };
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

module.exports = { sourceSegments, scriptChapters, replaceChapter, factNumbers, factState, buildView, getView, translateRun, runDraftFirst, resumeDraftFirst, setStatus, undo, rewriteChapter, updateFact, COMPRESS_NOTE };
