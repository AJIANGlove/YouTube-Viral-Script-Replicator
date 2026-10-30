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
const purify = require('./purify');
const retention = require('./retention');
const voice = require('./voice');
const { HEDGE_RE } = require('./compliance');

const pl = () => require('./pipeline');
const an = () => require('./analysis');
const search = require('./search');

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
  // 非中文稿混进的汉字/日文假名:各遍保存前已经清过(purifyText),这里按规则再兜一次(单章重写、撤回也走这里)
  text = checks.cleanForeignScript(text, (run.audience || {}).target_language).text;
  if (run.script_v1) run.script_v1 = text; else run.final_script = text;
  // V1 文案已变:这一版的扫描与简介缓存过期
  ['compliance_scans', 'opening_scans', 'descriptions'].forEach(k => { if (run[k] && run[k].v1) run[k].v1.stale = true; });
  // 稿件检查的结论基于旧稿:标过期(详情页沿用既有提示「稿子已改,建议重新检查一次」)。
  // 留存检查不标:它跑在 Step1 蓝图上(carries_peaks 结构),单章重写与逐处修订都不动蓝图
  if (run.script_check) run.script_check.stale_after_adopt = true;
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

// 终稿全文修订视图:以二稿为底,每章切成「原文 / 修改」片段,修改处附中文和理由
function revisionView(state, key) {
  const vs = arr(state.versions);
  const k = key || 'd3';
  const d3 = vs.find(v => v.key === k);
  const d2 = k === 'd4' ? vs.find(v => v.key === 'd3') : (vs.find(v => v.key === 'd2') || vs.find(v => v.key === 'd1'));
  if (!d3 || !d2 || (!arr(d3.edits).length && k !== 'd4')) return null;
  const edits = d3.edits.map(e => ({ ...e, zh_old: zhOf(state, e.old), zh_new: e.new ? zhOf(state, e.new) : '' }));
  const finals = Object.fromEntries(scriptChapters(d3.text).map(c => [c.id, c.text]));
  const chapters = scriptChapters(d3.base_text || d2.text).map(c => {
    const list = edits.filter(e => e.ok && e.chapter === c.id).sort((a, b) => a.start - b.start);
    const segs = [];
    let at = 0;
    list.forEach(e => {
      if (e.start > at) segs.push({ t: 'text', text: c.text.slice(at, e.start) });
      segs.push({ t: 'edit', n: e.n });
      at = e.end;
    });
    if (at < c.text.length) segs.push({ t: 'text', text: c.text.slice(at) });
    const fin = finals[c.id] != null ? finals[c.id] : c.text;
    return { id: c.id, fn: c.fn, range: c.range, segs, edits: list.map(e => e.n), final: fin, zh_final: zhOf(state, fin) };
  });
  return {
    from: d2.label, at: d3.at, chapters, edits,
    applied: edits.filter(e => e.ok).length, failed: edits.filter(e => !e.ok),
    final_text: d3.text
  };
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
  const out = {
    run_id: run.id, status: run.status, target_language: lang,
    running: passLabel(run.id),
    passes: { check: (run.steps || {}).draft_check || null, audit: (run.steps || {}).reverse_audit || null, final: (run.steps || {}).final_review || null, deai: (run.steps || {}).deai || null, final_open: (run.steps || {}).final_open || null, final_options: (run.steps || {}).final_options || null },
    audit: state.audit ? { ...state.audit, issues: arr(state.audit.issues).map(x => ({ ...x, zh_type: hasForeign(x.type) ? zhOf(state, x.type) : '', zh_problem: hasForeign(x.problem) ? zhOf(state, x.problem) : '', zh_direction: hasForeign(x.direction) ? zhOf(state, x.direction) : '', need_zh: hasForeign(x.problem) || hasForeign(x.direction) })), score: state.audit.score != null ? state.audit.score : reportScore(state.audit.report), stale: state.audit.base_hash !== hash(script) && ((arr(state.versions).find(v => v.key === 'd3') || {}).text) !== script } : null,
    factcheck: state.factcheck ? { ...state.factcheck, items: arr(state.factcheck.items).map(x => ({ ...x, zh_claim: hasForeign(x.claim) ? zhOf(state, x.claim) : '' })) } : null,
    versions: arr(state.versions).map(v => ({ key: v.key, label: v.label, at: v.at, issues: arr(v.issues), changed: arr(v.changed), truncated: !!v.truncated })),
    diffs: versionDiffs(state),
    revision: revisionView(state),
    deai_revision: revisionView(state, 'd4'),
    deai: state.deai ? { ...state.deai, diagnosis: deaiReportOf(state.deai), ...(sp => ({ skipped_opening: (state.deai.skipped_opening || 0) + sp.cut, skipped_claim: (state.deai.skipped_claim || 0) + sp.cut_claim }))(deaiOpeningSplit(run, deaiItemsOf(state.deai))), items: deaiOpeningSplit(run, deaiItemsOf(state.deai)).keep.map(x => ({ ...x, ...deaiQuoteView(run, x), old_zh: x.old_zh || zhOf(state, x.old), options: x.options.map(o => ({ ...o, zh: o.zh || (o.text ? zhOf(state, o.text) : '') })) })), stale: !!state.deai.base_hash && state.deai.base_hash !== hash(arr(state.versions).some(v => v.key === 'd4' && v.text === script) ? ((arr(state.versions).find(v => v.key === 'd3') || {}).text || '') : script) } : null,
    final: state.final ? (() => {
      // 旧结果:清单里没读出的分数,按报告正文的评分表补上
      const f = state.final, dims = arr(f.dims);
      // 解决方案是给当时那组问题出的,问题列表变了就不再显示
      const rechecks = arr(f.rechecks).map(r => ({ ...r, scores: fillScores(r.scores, r.report, dims, 2), options: r.options && r.options_for === openKey(r.open) ? r.options : null,
        open: arr(r.open).map(x => ({ ...x, zh_problem: hasForeign(x.problem) ? zhOf(state, x.problem) : '', zh_suggestion: hasForeign(x.suggestion) ? zhOf(state, x.suggestion) : '' })) }));
      const last = rechecks[rechecks.length - 1];
      return { ...f, rechecks, scores_before: fillScores(f.scores_before, f.audit_report, dims, 1), scores_after: last ? { ...last.scores, ...(f.scores_after || {}) } : f.scores_after };
    })() : null,
    opening: openingView(run),
    tracks: trackList(), track_default: lockedTrack(run) || state.final_track || autoTrack(run, asset), track_locked: !!lockedTrack(run),
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
  const lastRc = out.final ? arr(out.final.rechecks).slice(-1)[0] : null;
  out.summary.thesis_resolved = lastRc && lastRc.thesis ? lastRc.thesis : null;
  out.summary.publish = publishCheck(run, out);
  return out;
}

// 「可发布」硬标准,和 AI 复审的「达标」分开:复审没有关键/结构遗留问题、事实没有红旗(没出处、账本对不上、反转被推翻)、听感检查通过
// 平均分到 PUBLISH_AVG:复审剩下的关键/结构问题、数字密的句子只提示不挡,只要开头过关(人定的标准,之后按真实发布数据再调)
const PUBLISH_AVG = 8;
function publishCheck(run, v) {
  const s = v.summary, reasons = [], notes = [];
  const last = v.final ? arr(v.final.rechecks).slice(-1)[0] : null;
  const dims = v.final ? (arr(v.final.dims).length ? v.final.dims : Object.keys((last || {}).scores || {})) : [];
  const avg = last ? avgScore(last.scores, dims) : null;
  const good = avg != null && avg >= PUBLISH_AVG;
  if (!v.final) reasons.push('还没跑终审');
  else {
    const hard = arr(last && last.open).filter(x => (x.level === '关键' || x.level === '结构') && !x.not_found);
    if (hard.length) (good ? notes : reasons).push('复审还有 ' + hard.length + ' 个关键/结构问题(' + hard.map(x => x.id).join('、') + ')');
  }
  if (s.red_facts.length) reasons.push('稿里有 ' + s.red_facts.length + ' 个没出处的事实');
  if (arr(s.ledger_mismatches).length) reasons.push('账本对不上');
  // 反转被推翻:看最近一轮复审对终稿的判断;复审判定已解决就不再挡
  const th = last && last.thesis;
  if (arr(s.thesis_contradicts).length && !(th && th.resolved)) reasons.push('反转被事实推翻' + (th ? '(复审判定未解决:' + th.note + ')' : '(终审复审还没判断)'));
  const lc = checks.listenCheck(checks.extractFinalScript(currentScript(run)), {
    wpm: require('./narration').narrationWpm(run, null).wpm, title: ((run.analysis || {}).title || {}).final_title || run.topic, lang: (run.audience || {}).target_language });
  // 论点核对:主张被稿子自己的数字推翻、账本关键错误,不管平均几分都挡(改过稿还没重新核对的,按上次结果算)
  const cc = v.final ? v.final.claim_check : null;
  if (cc && claimBlocking(cc)) reasons.push('论点对不上(' + (cc.verdict === '不成立' ? '开头主张被稿子自己的数字推翻' : '账本有 ' + arr(cc.issues).filter(x => x.level === '关键' && !x.not_found).length + ' 处关键错误') + ')');
  else if (v.final && !cc) notes.push('还没核对论点');
  const openBad = openingIssues(lc);
  if (lc && !lc.ok) {
    const rest = lc.issues.filter(i => !openBad.includes(i));
    const soft = good ? rest.filter(i => /一口气念/.test(i)) : [];
    const block = openBad.concat(rest.filter(i => !soft.includes(i)));
    if (block.length) reasons.push('听感检查没过:' + block.join(';'));
    if (soft.length) notes.push(soft.join(';'));
  }
  return { ready: !reasons.length, reasons, notes, craft_hints: v.final ? craftHints(run, last) : [], avg: avg != null ? Math.round(avg * 10) / 10 : null, good, opening_bad: openBad, fix: (run.steps || {}).opening_fix || null,
    claim: cc ? { ...cc, stale: cc.hash !== hash(currentScript(run)), blocking: claimBlocking(cc), auto_left: Math.max(0, CLAIM_FIX_MAX - (v.final.claim_fixes || 0)) } : null, claim_step: (run.steps || {}).claim_check || null, fix_rec: ((run.review || {}).final || {}).opening_fix || null };
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

// 中文为主但夹着韩文、日文假名或英文单词的句子(审稿问题、修改方向),也要整句翻成中文
function hasForeign(text) { return /[가-힯぀-ヿ]|[A-Za-z]{4,}/.test(String(text || '')); }

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
  const items = [...new Set(texts.filter(t => t && (needsZh(t) || hasForeign(t))))];
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
  vs.forEach(v => arr(v.edits).forEach(e => texts.push(e.old, e.new || '')));
  // 二稿审稿报告的问题类型、问题和修改方向
  arr(((run.review || {}).audit || {}).issues).forEach(x => { if (hasForeign(x.type)) texts.push(x.type); if (hasForeign(x.problem)) texts.push(x.problem); if (hasForeign(x.direction)) texts.push(x.direction); });
  // 复审没解决的问题和建议(里面常引用韩文原句)
  arr(((run.review || {}).final || {}).rechecks).forEach(r => arr(r.open).forEach(x => { if (hasForeign(x.problem)) texts.push(x.problem); if (hasForeign(x.suggestion)) texts.push(x.suggestion); }));
  // 事实核验表里的原文主张
  arr(((run.review || {}).factcheck || {}).items).forEach(x => { if (hasForeign(x.claim)) texts.push(x.claim); });
  // 去AI感候选改法:AI 没给中文的补翻
  deaiItemsOf((run.review || {}).deai).forEach(x => { if (!x.old_zh) texts.push(x.old); x.options.forEach(o => { if (!o.zh && o.text) texts.push(o.text); }); });
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
  final: { label: '终稿', step: 'final_review', prompt: 'final_audit.md', title: '终审' }
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

// 写前分析查出「反转被事实推翻」时,复审顺带判断终稿的论点是否已经和这些事实一致(这条是对着论点卡查的,稿子改对了它自己不会消失)
// 写法提示(写法规则 C1、D1):埋的有没有回收、评论问题和主线对不对得上。只给人看,不进分数、不进补改、不挡发布
const CRAFT_BLOCK = '===CRAFT===\n回收: 有 或 没有 或 没埋 | 一句中文(埋了什么、在哪回收)\n评论问题: 对得上 或 对不上 或 没有 | 一句中文(结尾问了什么、和全片主线的关系)\n';
function parseCraft(block) {
  const out = {};
  String(block || '').split('\n').forEach(l => {
    const m = l.match(/^\s*[-*]?\s*(回收|评论问题)\s*[:：]\s*([^|｜]*)[|｜]?\s*(.*)$/);
    if (!m) return;
    const v = m[2].trim();
    if (m[1] === '回收') out.payoff = { status: /没埋/.test(v) ? '没埋' : /没有|未|否/.test(v) ? '没有' : /有/.test(v) ? '有' : v, note: m[3].trim() };
    else out.comment = { status: /对不上|不对/.test(v) ? '对不上' : /没有|无/.test(v) ? '没有' : /对得上|对上/.test(v) ? '对得上' : v, note: m[3].trim() };
  });
  return Object.keys(out).length ? out : null;
}
// 正文中间(第一章和最后一章以外)对观众的反问:同类爆款一般不超过两次
function midQuestions(script) {
  const chs = scriptChapters(script);
  if (chs.length < 3) return [];
  const qs = [];
  chs.slice(1, -1).forEach(c => {
    String(c.text).replace(/^\[CH[^\]]*\]\s*/, '').split(/(?<=[.?!。？！])\s+/).forEach(t => {
      if (/[?？]\s*$/.test(t) && /당신|여러분|손님|\byou\b|你/i.test(t)) qs.push({ chapter: c.id, text: t.trim() });
    });
  });
  return qs;
}
function craftHints(run, last) {
  const out = [];
  const c = last && last.craft;
  if (c && c.payoff && c.payoff.status === '没有') out.push('埋下的东西结尾没有回收' + (c.payoff.note ? '(' + c.payoff.note + ')' : ''));
  if (c && c.comment && c.comment.status === '对不上') out.push('结尾评论问题和全片主线对不上' + (c.comment.note ? '(' + c.comment.note + ')' : ''));
  if (c && c.comment && c.comment.status === '没有') out.push('结尾没有评论问题,可以从核心两难里出一个一句话能答的问题');
  const qs = midQuestions(currentScript(run));
  if (qs.length > 2) out.push('正文中间对观众的反问有 ' + qs.length + ' 次(同类爆款一般不超过 2 次),如 ' + qs.slice(0, 2).map(q => q.chapter + '「' + q.text.slice(0, 40) + '」').join('、'));
  return out;
}
function thesisVars(run) {
  const tc = (run.analysis || {}).thesis_check || {};
  if (!arr(tc.contradicts).length) return { thesis_check: '', thesis_block: CRAFT_BLOCK };
  return {
    thesis_check: '【写前分析时程序查出的论点矛盾(请对照修改后的稿子判断是否已经解决)】\n论点卡:' + JSON.stringify((run.analysis || {}).thesis_card || {}) +
      '\n与论点相反的事实:' + arr(tc.contradicts).join('、') + (tc.note ? '(' + tc.note + ')' : '') +
      '\n判断标准:稿子现在的主张和结尾落点是否已经和这些事实一致(稿子可以已经换了说法,不必和论点卡一字不差);稿子里还在说和这些事实相反的话,就是未解决。\n\n',
    thesis_block: '===THESIS===\n已解决 或 未解决 | 一句中文理由(引用稿子里现在的主张)\n' + CRAFT_BLOCK
  };
}
function parseThesis(block) {
  const t = String(block || '').trim();
  if (!t) return null;
  const [head, ...rest] = t.split(/\s*[|｜]\s*/);
  const resolved = /未解决/.test(head) ? false : /已解决/.test(head) ? true : null;
  return resolved == null ? null : { resolved, note: rest.join(' | ').trim() };
}

// 听感检查 + 开头卡片的「可能掉人的地方」:交给终审修改和复审,让它照着改、照着查(text 是这一步要改/要查的稿)
function listenFindings(run, text) {
  const r2 = { ...run, script_v1: text };
  const title = ((run.analysis || {}).title || {}).final_title || run.topic;
  const wpm = require('./narration').narrationWpm(run, null).wpm;
  const lc = checks.listenCheck(checks.extractFinalScript(text), { wpm, title, lang: (run.audience || {}).target_language });
  const out = [];
  if (lc && !lc.ok) {
    out.push('听感检查(程序按配音语速 ' + lc.wpm + ' 词/分钟推算时间):' + lc.issues.join(';'));
    const fb = checks.listenFeedback(lc);
    if (fb) out.push(fb);
  }
  const o = (run.review || {}).opening;
  let fresh = false;
  try { fresh = !!o && openingSlice(r2).hash === o.hash; } catch (e) {}
  if (fresh && arr(o.risks).length) out.push('开头单独审指出的可能掉人的地方(句子编号对应开头 60 秒逐句):\n' + arr(o.risks).map(x => '- ' + x).join('\n') +
    '\n开头逐句:\n' + arr(o.lines).map(l => l.n + '. ' + l.text).join('\n'));
  return out.join('\n') || '(无)';
}

// ---------- 终审:逐处修改 ----------
// 终审不再整章重写,而是列出一处一处的修改(原句 → 改成 + 理由);程序在二稿里定位原句、替换,拼出终稿,
// 页面在整页全文上划线展示每一处改动,附中文和理由。
const EDIT_FIELDS = {
  章节: 'chapter', 位置: 'chapter', 类别: 'category', 类型: 'category',
  原句: 'old', 原文: 'old', 修改前: 'old', 改前: 'old',
  改成: 'new', 改为: 'new', 修改为: 'new', 修改后: 'new', 改后: 'new', 新句: 'new',
  理由: 'reason', 原因: 'reason', 修改理由: 'reason', 说明: 'reason'
};
const EDIT_FIELD_RE = new RegExp('^\\s*[-*•]?\\s*\\**\\s*(' + Object.keys(EDIT_FIELDS).sort((a, b) => b.length - a.length).join('|') + ')\\s*\\**\\s*[:：]\\s*\\**\\s*(.*)$');
const EDIT_DELETE = /^[(\uFF08\u3010\[]?\s*(删除|删掉|删去|삭제|delete|deleted|remove)[^)\uFF09\u3011\]]{0,8}[)\uFF09\u3011\]]?$/i;
// 「改成」里夹着的删除记号(如「(삭제) 다음 문장」):模型用韩文或英文写了删除标记,又把下一句接在后面;
// 不去掉就会原样进稿子被念出来(run_561940f3685f 终稿出现两处「(삭제)」)
const EDIT_DELETE_MARK = /\s*[(\uFF08\u3010\[]\s*(删除|删掉|删去|삭제|delete|deleted|remove)\s*[)\uFF09\u3011\]]\s*/gi;
// 模型常给原句加引号或书名号:成对的包裹符号去掉
function unwrapQuote(s) {
  const pairs = [['「', '」'], ['『', '』'], ['“', '”'], ['"', '"'], ["'", "'"], ['‘', '’'], ['《', '》'], ['`', '`']];
  let x = String(s || '').trim().replace(/^\*+|\*+$/g, '').trim();
  for (const [a, b] of pairs) if (x.length > 2 && x.startsWith(a) && x.endsWith(b) && !x.slice(1, -1).includes(b)) return x.slice(1, -1).trim();
  return x;
}

// 原句后面跟着的中文备注,如「오늘 우리는 그 이유를 찾아갑니다.(第二次出现)」:备注不是正文,去掉再定位;写了第几次出现就记下来,改那一处
// (实测 run_1f67a92553fd 去AI感 D01:带备注找不到原句;这句开头出现了两次,校正后按第一处改,会删掉开头那句)
const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function splitQuoteNote(s) {
  const x = String(s || '');
  const m = x.match(/\s*[（(]([^()（）]*?(?:出现|重复|第\s*[一二两三四五六七八九十\d]+\s*[次处遍])[^()（）]*)[)）]\s*$/);
  if (!m || !/[\u4e00-\u9fff]/.test(m[1])) return { old: x, occ: 0 };
  const n = (m[1].match(/第\s*([一二两三四五六七八九十]|\d+)\s*[次处遍]/) || [])[1];
  return { old: unwrapQuote(x.slice(0, m.index)), occ: n ? (CN_NUM[n] || Number(n) || 0) : 0 };
}
// 同一句在稿子里出现多次时按第 occ 次定位(全篇按章节顺序数);没写第几次就用原来的规则(找第一处)
function locateNth(chs, chapter, old, occ) {
  const all = [];
  for (const c of chs) {
    let from = 0, p;
    while ((p = locate(c.text.slice(from), old))) { all.push({ ch: c, start: from + p.start, end: from + p.end }); from += p.end; if (all.length > 20) break; }
  }
  if (!all.length) return null;
  if (all.length === 1) return all[0];
  if (occ >= 1) return all[Math.min(occ, all.length) - 1];
  return all.find(h => h.ch.id === chapter) || all[0];
}

function parseEdits(text) {
  const parts = String(text || '').replace(/[*`]*(===\s*(?:EDIT|END|SCORES|VERDICT|OPEN)\s*===)[*`]*/gi, '\n$1\n').replace(/^[ \t]+(===)/gm, '$1').split(/^===\s*EDIT\s*===\s*$/m).slice(1);
  return parts.map(part => {
    const body = part.split(/^===\s*END\s*===\s*$/m)[0];
    const e = {};
    let cur = null;
    body.split('\n').forEach(line => {
      const m = line.match(EDIT_FIELD_RE);
      if (m && !(cur && e[EDIT_FIELDS[m[1]]] != null)) { cur = EDIT_FIELDS[m[1]]; e[cur] = m[2]; } else if (cur) e[cur] += '\n' + line;
    });
    Object.keys(e).forEach(k => { e[k] = e[k].trim(); });
    if (e.old) { const q = splitQuoteNote(unwrapQuote(e.old)); e.old = q.old; if (q.occ) e.occ = q.occ; }
    if (e.new) e.new = unwrapQuote(e.new);
    // 模型有时把整章连同章节标签行一起当原句:标签行不是正文,去掉再定位
    const TAG = /^\s*\[\s*(CH\d+)[^\]\n]*\]\s*(?:\n|$)/i;
    const tag = String(e.old || '').match(TAG);
    if (tag) { e.old = e.old.replace(TAG, '').trim(); if (!e.chapter) e.chapter = tag[1]; }
    if (e.new) e.new = e.new.replace(TAG, '').trim();
    if (e.new != null && EDIT_DELETE.test(e.new)) e.new = '';
    else if (e.new) { const x = e.new.replace(EDIT_DELETE_MARK, ' '); if (x !== e.new) e.new = x.replace(/[ \t]{2,}/g, ' ').trim(); }
    // 「改成」写成了一句删除说明(如「(删除三处中的后两处,只保留第一处)」):按删掉原句处理
    else if (e.new && /^[(（【\[]\s*(删除|删掉|删去|去掉)/.test(e.new.trim()) && checks.isMetaNoteLine(e.new)) e.new = '';
    e.chapter = (String(e.chapter || '').match(/CH\d+/i) || [''])[0].toUpperCase();
    return e;
  }).filter(e => e.old);
}

// 在一章正文里找原句:先逐字找,找不到就放宽空白和引号再找
// 定位顺序:逐字 → 忽略空白和引号差异 → 原句里有省略号时按首尾两段 → 多句原句按首句和末句
const ELLIPSIS = /\s*(?:…+|\.{3,}|⋯+|。{3,})\s*/;
function compactIndex(text) {
  const norm = ch => (/["“”„]/.test(ch) ? '"' : /['‘’]/.test(ch) ? "'" : ch);
  let s = '';
  const pos = [];
  for (let i = 0; i < text.length; i++) { if (/\s/.test(text[i])) continue; s += norm(text[i]); pos.push(i); }
  return { s, pos };
}
function locateLoose(text, old) {
  const i = text.indexOf(old);
  if (i >= 0) return { start: i, end: i + old.length };
  const T = compactIndex(text), O = compactIndex(old).s;
  if (!O) return null;
  const j = T.s.indexOf(O);
  return j >= 0 ? { start: T.pos[j], end: T.pos[j + O.length - 1] + 1 } : null;
}
function locate(text, old) {
  const o = String(old || '').trim();
  const hit = locateLoose(text, o);
  if (hit) return hit;
  const span = (a, b) => {
    const p = locateLoose(text, a);
    if (!p) return null;
    const q = locateLoose(text.slice(p.end), b);
    if (!q) return null;
    const end = p.end + q.end;
    return end - p.start <= Math.max(o.length * 3, 200) ? { start: p.start, end } : null;
  };
  if (ELLIPSIS.test(o)) {
    const parts = o.split(ELLIPSIS).filter(x => x.trim());
    if (parts.length >= 2) { const r = span(parts[0], parts[parts.length - 1]); if (r) return r; }
    if (parts.length === 1) return locateLoose(text, parts[0]);
  }
  const sents = o.match(/[^.!?。!?]+[.!?。!?]+["”’」]?|[^.!?。!?]+$/g) || [];
  if (sents.length >= 2) return span(sents[0].trim(), sents[sents.length - 1].trim());
  return null;
}

// 审稿不许把稿子改长(实测 run_2713e3885236:二稿把 1,453 词改到 1,845 词,观众在前 2 分钟走光)。
// 前 2 分钟只许删和换:这段里净加词的修改不采用;整篇改完不许超过改前词数的 3%,超了从加得最多的那处开始退回。
const GROWTH_OPENING_SEC = 120, GROWTH_TOLERANCE = 0.03;
const scriptWords = text => checks.parseChapters(text || '').reduce((n, c) => n + c.words, 0);
// maxWords:改完最多多少词。终审多轮修改共用第一轮算出的上限,不让每轮各涨 3%
function growthLimit(run, base) {
  const wpm = require('./narration').narrationWpm(run, null).wpm || 150;
  const w = scriptWords(base);
  return { openingWords: Math.round(GROWTH_OPENING_SEC * wpm / 60), maxWords: Math.max(w + 5, Math.round(w * (1 + GROWTH_TOLERANCE))), wpm };
}
function limitEditGrowth(chs, list, limit) {
  const before = {};
  let acc = 0;
  chs.forEach(c => { before[c.id] = acc; acc += checks.countWords(c.text); });
  const delta = e => checks.countWords(e.new || '') - checks.countWords(e.old || '');
  list.forEach(e => {
    const at = before[e.chapter] + checks.countWords(chs.find(c => c.id === e.chapter).text.slice(0, e.start));
    if (at < limit.openingWords && delta(e) > 1) { e.ok = false; e.error = '前 2 分钟只许删和换,不许加长(这处多了 ' + delta(e) + ' 词),没有采用'; e.growth_rejected = true; }
  });
  let total = acc + list.filter(e => e.ok !== false).reduce((n, e) => n + delta(e), 0);
  const grow = list.filter(e => e.ok !== false && delta(e) > 0).sort((a, b) => delta(b) - delta(a));
  for (const e of grow) {
    if (total <= limit.maxWords) break;
    total -= delta(e);
    e.ok = false; e.error = '整篇改完会超过改前篇幅,这处加长(多 ' + delta(e) + ' 词)没有采用'; e.growth_rejected = true;
  }
}
// 整章改写同理:开头 2 分钟里的章不许变长,整篇超了从加得最多的章开始退回。返回被退回的章
function limitChapterGrowth(baseText, nextText, limit) {
  const bc = scriptChapters(baseText);
  let acc = 0;
  const startOf = {};
  bc.forEach(c => { startOf[c.id] = acc; acc += checks.countWords(c.text); });
  const rows = scriptChapters(nextText).map(c => { const b = bc.find(x => x.id === c.id); return b && b.text !== c.text ? { id: c.id, old: b.text, before: checks.countWords(b.text), after: checks.countWords(c.text) } : null; }).filter(Boolean);
  const rejected = [];
  let text = nextText;
  const revert = (r, reason) => { const t = replaceChapter(text, r.id, r.old); if (t) { text = t; rejected.push({ chapter: r.id, words_before: r.before, words_after: r.after, reason }); r.reverted = true; } };
  rows.forEach(r => { if (startOf[r.id] < limit.openingWords && r.after > r.before + 1) revert(r, '前 2 分钟只许删和换,这一章改长了 ' + (r.after - r.before) + ' 词'); });
  for (const r of rows.filter(x => !x.reverted && x.after > x.before).sort((a, b) => (b.after - b.before) - (a.after - a.before))) {
    if (scriptWords(text) <= limit.maxWords) break;
    revert(r, '整篇改完超过改前篇幅,这一章多了 ' + (r.after - r.before) + ' 词');
  }
  return { text, rejected };
}

// 把修改套到稿子上:返回新稿和每处修改的结果(ok / 没找到 / 和前一处重叠);offset 记的是改前那一章里的位置
// limit(可选,见 growthLimit):不许改长
function applyEdits(base, edits, limit) {
  const chs = scriptChapters(base);
  const byCh = {};
  edits.forEach((e, idx) => {
    e.n = idx + 1;
    let ch = chs.find(c => c.id === e.chapter);
    let pos = null;
    if (e.occ) { const h = locateNth(chs, e.chapter, e.old, e.occ); if (h) { ch = h.ch; pos = { start: h.start, end: h.end }; } }
    if (!pos) pos = ch ? locate(ch.text, e.old) : null;
    if (!pos) { // 章节写错了:到别的章里找
      for (const c of chs) { const p = locate(c.text, e.old); if (p) { ch = c; pos = p; break; } }
    }
    if (!pos) { e.ok = false; e.error = '在二稿里没找到这句原句'; return; }
    if (!e.new) { // 删除:连带吃掉一个空格或一个空行,免得留下双空格、空段
      const tx = ch.text;
      if (tx[pos.end] === ' ') pos.end++;
      else if ((pos.start === 0 || tx[pos.start - 1] === '\n') && /^\n{1,2}/.test(tx.slice(pos.end))) pos.end += tx.slice(pos.end).match(/^\n{1,2}/)[0].length;
      else if (tx[pos.start - 1] === ' ') pos.start--;
    }
    e.chapter = ch.id; e.start = pos.start; e.end = pos.end; e.old = ch.text.slice(pos.start, pos.end);
    if (e.new === e.old) { e.ok = false; e.error = '改前改后一样'; return; }
    if (e.new && e.new.split('\n').some(l => checks.isMetaNoteLine(l))) { e.ok = false; e.error = '「改成」里写的是修改说明,不是正文,没有采用'; return; }
    (byCh[ch.id] = byCh[ch.id] || []).push(e);
  });
  if (limit) limitEditGrowth(chs, Object.values(byCh).flat(), limit);
  let next = base;
  for (const ch of chs) {
    const list = (byCh[ch.id] || []).filter(e => e.ok !== false).sort((a, b) => a.start - b.start);
    let out = '', at = 0;
    list.forEach(e => {
      if (e.start < at) { e.ok = false; e.error = '和前一处修改重叠,没有采用'; return; }
      out += ch.text.slice(at, e.start) + (e.new || '');
      at = e.end; e.ok = true;
    });
    if (!list.some(e => e.ok)) continue;
    out += ch.text.slice(at);
    const tryNext = replaceChapter(next, ch.id, out);
    if (tryNext && !checks.chapterStructureError(tryNext)) next = tryNext;
    else list.forEach(e => { if (e.ok) { e.ok = false; e.error = '改完章节结构不对,这一章没有采用'; } });
  }
  return { next, edits };
}

// ---------- 事实核验(初稿检查的前半段) ----------
// ① 事实审计(fact_audit.md):把初稿拆成一条条主张 F01…,标风险,给高风险的出搜索词;
// ② 联网核验(fact_verify.md):程序按搜索词联网搜,模型只能用搜到的结果(R 编号)定证据等级 A–E、独立重算、选处理方式;
// 结果存在 review.factcheck,写进初稿检查(改二稿时落实)和终审(审稿、修改、复审都以它为准)的提示词。
// 核验失败不挡初稿检查,只记下错误。
const FACT_MAX_QUERIES = 12;
const FACT_RESULTS_PER_QUERY = 3; // 要正文,每条较长,少取几条
const FACT_GRADES = ['A', 'B', 'C', 'D', 'E'];
const FACT_ACTIONS = ['保留', '修正数字', '限定表述', '标明估算', '删除', '改为观点'];
const FACT_RISKS = ['致命', '高', '中', '低'];
// 不同赛道核验的重点不一样:账本类盯数字和计算,历史、科普、POV 类盯年代、人物、研究结论和因果
const FACT_FOCUS = {
  econ: '- 价格、销量、成本、租金、人工、毛利和净利,以及它们之间的计算和口径。\n- 「大多数店」「行业平均」这类把个案或估算说成行业事实的判断。\n- 政策、税费、法定最低工资等要用今年的现行值。',
  history: '- 年代、朝代、在位时间、人物身份和事件经过是否对得上史料。\n- 引语和「某人说过」是否真有出处;传说、野史、后人演绎有没有被写成史实。\n- 把一个时期、一个地区的情况推广成「古人都这样」的判断。\n- 数字(人口、寿命、价格)只在稿子里真的用到时才查,不要为了核验去追加数字。',
  science: '- 研究结论有没有被夸大:样本是动物还是人、相关还是因果、单个研究还是学界共识。\n- 生物学、心理学、医学说法是否准确,有没有过时的说法。\n- 「科学证明」「研究发现」这类说法是否真有对应的研究。',
  pov: '- 身份、等级、职业、制度、工具和年代等设定细节是否符合史实或现实。\n- 第二人称的代入、想象情节不算需要核实的主张,只查其中当作事实讲出来的部分。\n- 收入、刑罚、死亡率等数字只在稿子里真的用到时才查。',
  general: '- 当作事实讲出来的年份、人物、事件、研究结论和统计数据。\n- 绝对化表述和把个案推广成普遍规律的判断。'
};
const FACT_LINE_RE = /^\s*[-*•\d.)]*\s*\[\s*(F\d+)\s*\]\s*\[\s*([^\]]*)\]\s*\[\s*([^\]]*)\]\s*(.+)$/i;
const splitBar = s => String(s || '').split(/\s*[|｜]\s*/);

function parseClaims(block) {
  const out = [];
  String(block || '').split('\n').forEach(l => {
    const m = l.replace(/\*+/g, '').match(FACT_LINE_RE);
    if (!m) return;
    const parts = splitBar(m[4]);
    const check = parts.length >= 3 ? parts.pop() : '';
    const type = parts.length >= 2 ? parts.pop() : '';
    const id = m[1].toUpperCase();
    if (out.some(c => c.id === id)) return;
    out.push({ id, chapter: m[2].trim().toUpperCase().replace(/^全片$/, '全篇') || '全篇', risk: FACT_RISKS.find(r => m[3].includes(r)) || '中', claim: parts.join(' | ').trim(), type: type.trim(), check: check.trim() });
  });
  return out.slice(0, 40);
}

function parseFactQueries(block) {
  const out = [];
  String(block || '').split('\n').forEach(l => {
    const m = l.replace(/\*+/g, '').match(/^\s*[-*•\d.)]*\s*\[\s*(F\d+)\s*\]\s*(.+)$/i);
    const q = m && m[2].trim().replace(/^["“「]|["”」]$/g, '');
    if (q && !out.some(x => x.query === q)) out.push({ target: m[1].toUpperCase(), query: q });
  });
  return out.slice(0, FACT_MAX_QUERIES);
}

function parseVerdicts(block) {
  const out = {};
  String(block || '').split('\n').forEach(l => {
    const m = l.replace(/\*+/g, '').match(FACT_LINE_RE);
    if (!m) return;
    const parts = splitBar(m[4]);
    const refs = parts.length >= 3 ? (parts.pop().match(/R\d+/gi) || []).map(x => x.toUpperCase()) : [];
    const fix = parts.length >= 2 ? parts.pop() : '';
    out[m[1].toUpperCase()] = {
      grade: (m[2].trim().toUpperCase().match(/[A-E]/) || [''])[0],
      action: FACT_ACTIONS.find(a => m[3].includes(a)) || m[3].trim(),
      finding: parts.join(' | ').trim(), fix: fix.trim(), refs
    };
  });
  return out;
}

function setStepStage(runId, step, stage) {
  const fresh = store.getRun(runId);
  if (!fresh) return;
  fresh.steps = { ...(fresh.steps || {}), [step]: { ...((fresh.steps || {})[step] || {}), status: 'running', stage } };
  store.saveRun(fresh);
}

async function runFactCheck(run, cfg, script, asset) {
  const a = run.analysis || {};
  const aud = run.audience || {};
  const ss = search.searchStatus(cfg);
  const common = {
    today: pl().todayStr(), topic: run.topic, target_language: aud.target_language || '', target_country: aud.target_country || '',
    analysis: run.analysis ? an().analysisBrief(a, run) : '(无写前分析)', script
  };
  // 赛道:已经选过终审赛道就用那个,否则按写前分析匹配的赛道
  const trackKey = lockedTrack(run) || ((run.review || {}).final || {}).track || autoTrack(run, asset);
  const tr = loadTrack(trackKey);
  // ① 事实审计
  setStepStage(run.id, 'draft_check', '事实审计');
  const r1 = await callLong(run, cfg, an().fillVars(readPrompt('fact_audit.md'), { ...common, max_queries: FACT_MAX_QUERIES, track_name: tr.name, fact_focus: FACT_FOCUS[tr.key] || FACT_FOCUS.general }), '事实审计');
  const b1 = parseBlocks(r1.content.replace(/[*`]*(===\s*(?:CLAIMS|QUERIES|END)\s*===)[*`]*/gi, '\n$1\n'), false);
  const claims = parseClaims(b1.CLAIMS);
  const overview = r1.content.split(/^===\s*CLAIMS/m)[0].trim();
  if (!claims.length) return { at: new Date().toISOString(), track: tr.key, track_name: tr.name, search_ready: ss.ready, claims: 0, items: [], overview, report: '', error: '事实审计没有列出主张' };
  // ② 联网搜索(没开就跳过,全部按未核实处理)
  let batches = [];
  const queries = parseFactQueries(b1.QUERIES);
  if (ss.ready && queries.length) {
    setStepStage(run.id, 'draft_check', '联网核验(搜索 ' + queries.length + ' 条)');
    batches = await search.runQueries(queries, run.topic, cfg, { max: FACT_MAX_QUERIES, content: true, count: FACT_RESULTS_PER_QUERY });
  }
  // ③ 逐项核验
  setStepStage(run.id, 'draft_check', '联网核验(逐项定级)');
  const claimsText = claims.map(c => '- [' + c.id + '][' + c.chapter + '][' + c.risk + '] ' + c.claim + ' | ' + c.type + ' | ' + c.check).join('\n');
  const results = ss.ready ? search.resultsBrief(batches) : '(没有开联网搜索:除了按稿子里的输入值能独立重算、对照的计算类和口径类主张,其他一律标 D)';
  const r2 = await callLong(run, cfg, an().fillVars(readPrompt('fact_verify.md'), { ...common, claims: claimsText, results }), '联网核验');
  const c2 = r2.content.replace(/[*`]*(===\s*(?:VERDICTS|END)\s*===)[*`]*/gi, '\n$1\n');
  const verdicts = parseVerdicts(parseBlocks(c2, false).VERDICTS);
  const items = claims.map(c => {
    const v = verdicts[c.id] || { grade: 'D', action: '', finding: '没有给出核验结论', fix: '', refs: [] };
    const evidence = search.resolveEvidence(v.refs, batches);
    let grade = FACT_GRADES.includes(v.grade) ? v.grade : 'D';
    // 没有能对上的搜索结果,就只能是 D(计算、口径类按稿子里的输入重算、对照,可以没有链接)
    if (grade !== 'D' && !evidence.length && !/计算|口径/.test(c.type)) grade = 'D';
    return { ...c, grade, action: v.action, finding: v.finding, fix: v.fix, evidence, downgraded: grade !== v.grade && !!verdicts[c.id], ai_grade: v.grade };
  });
  return {
    at: new Date().toISOString(), track: tr.key, track_name: tr.name, search_ready: ss.ready, queries: batches.length, results: batches.reduce((n, b) => n + arr(b.results).length, 0),
    search_errors: batches.filter(b => b.error).map(b => b.query + ':' + b.error).slice(0, 5),
    claims: claims.length, items, overview, report: c2.split(/^===\s*VERDICTS/m)[0].trim(), truncated: r1.truncated || r2.truncated
  };
}

// 写进初稿检查、终审提示词的事实核验表
function factBrief(fc) {
  if (!fc || !arr(fc.items).length) return fc && fc.error ? '(事实核验没有完成:' + fc.error + '。数字和事实按写前分析的事实表处理,拿不准的不要新增。)' : '(本稿没有做事实核验)';
  const head = fc.search_ready ? '(已联网核验。等级:A 原始来源直接支持 / B 可靠二手来源 / C 部分证据、口径不全匹配 / D 证据不足 / E 与证据矛盾。只改处理方式不是「保留」的,改法要口播自然,不加免责句)' : '(这次没有联网搜索,除计算、口径类外都是 D:不得把这些数字当成已核实;观众能直接察觉、或核心论点依赖的才改,其余按表里的处理方式,「保留」的不要动)';
  return head + '\n' + fc.items.map(i => {
    const ev = i.evidence.slice(0, 2).map(e => e.title + (e.date ? '(' + e.date + ')' : '') + ' ' + e.url).join(';');
    return '- [' + i.id + '][' + i.chapter + '][' + i.risk + '][' + i.grade + '][' + (i.action || '待人工决定') + '] ' + i.claim + ' | 核验:' + (i.finding || '—') + ' | 正确数据/改法:' + (i.fix || '—') + (ev ? ' | 来源:' + ev : '');
  }).join('\n');
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
  let factcheck = kind === 'check' ? null : undefined;
  try {
    if (kind === 'check') {
      try { factcheck = await runFactCheck(run, cfg, base, asset); } catch (e) { factcheck = { at: new Date().toISOString(), items: [], error: e.message }; }
      setStepStage(runId, P.step, '改出二稿');
    }
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
      analysis: run.analysis ? an().analysisBrief(a, run) : '(无写前分析)',
      chapter_map: chapterMap(run, asset),
      program_findings: programFindings(run, asset),
      selected_fixes: kind === 'final' ? selectedFixes(run) : '',
      fact_check: kind === 'check' ? factBrief(factcheck) : factBrief((run.review || {}).factcheck),
      script: base
    });
    const r = await rawCall(run, cfg, prompt, P.title);
    const blocks = parseBlocks(r.content, r.stopReason === 'max_tokens');
    let issues = parseIssues(blocks.ISSUES || r.content.split(/^===\s*CH\d+/m)[0]);
    let next = base;
    const changed = [];
    // 终审:逐处修改(截断时最后一处可能不完整,丢掉)
    let edits = kind === 'final' ? parseEdits(r.content) : [];
    if (edits.length && r.stopReason === 'max_tokens' && !/^===\s*END\s*===/m.test(r.content)) edits = edits.slice(0, -1);
    const limit = growthLimit(run, base);
    let growthRejected = [];
    if (edits.length) {
      next = applyEdits(base, edits, limit).next;
      scriptChapters(next).forEach(c => { const b = scriptChapters(base).find(x => x.id === c.id); if (b && b.text !== c.text) changed.push(c.id); });
      issues = edits.map(e => ({ chapter: e.chapter || '全篇', category: e.category || '', problem: e.reason || '', quote: e.old, fix: e.new || '(删除)', edit: e.n }));
    }
    for (const ch of edits.length ? [] : scriptChapters(base)) {
      const t = blocks[ch.id];
      if (!t) continue;
      const clean = t.replace(/^\s*\[CH\d+[^\]]*\]\s*\n?/, '').trim(); // 模型偶尔把标签行带进来
      if (!clean || clean === ch.text) continue;
      const tryNext = replaceChapter(next, ch.id, clean);
      if (tryNext && !checks.chapterStructureError(tryNext)) { next = tryNext; changed.push(ch.id); }
    }
    if (!edits.length && changed.length) {
      const g = limitChapterGrowth(base, next, limit);
      next = g.text; growthRejected = g.rejected;
      g.rejected.forEach(x => changed.splice(changed.indexOf(x.chapter), 1));
    }
    const pure = await purifyText(run, cfg, next, P.label);
    next = pure.text;
    const fresh = store.getRun(runId) || run;
    if (currentScript(fresh) !== start) throw new Error('这一遍运行期间稿子被改过,结果没有保存,请重跑');
    fresh.review = fresh.review || {};
    setForeign(fresh, pure, P.label);
    const versions = arr(fresh.review.versions).length ? fresh.review.versions : [{ key: 'd1', label: '初稿', at: new Date().toISOString(), text: base, issues: [] }];
    // 重跑同一遍:替换掉旧的同名版本及其后的版本
    const keep = versions.filter(v => v.key === 'd1' || (kind === 'final' && v.key === 'd2'));
    keep.push({ key: kind === 'check' ? 'd2' : 'd3', label: P.label, at: new Date().toISOString(), text: next, issues, changed, truncated: r.stopReason === 'max_tokens', ...(edits.length ? { edits, base_text: base } : {}), ...(growthRejected.length ? { growth_rejected: growthRejected } : {}), words_before: scriptWords(base), words_after: scriptWords(next) });
    fresh.review.versions = keep;
    if (factcheck !== undefined) fresh.review.factcheck = factcheck;
    if (next !== start) writeScript(fresh, next);
    if (changed.length) {
      changed.forEach(id => { const st = chapterState(fresh, id); st.status = '待审'; st.history = [...arr(st.history), { at: new Date().toISOString(), note: P.title, by: kind, text: scriptChapters(base).find(c => c.id === id).text }].slice(-HISTORY_MAX); });
    }
    fresh.steps = { ...(fresh.steps || {}), [P.step]: { status: 'done', secs: Math.round(r.secs * 10) / 10, finished_at: new Date().toISOString(), issues: issues.length, changed: changed.length, ...(growthRejected.length ? { growth_rejected: growthRejected.length } : {}), ...(edits.length ? { edits: edits.filter(e => e.ok).length, edits_failed: edits.filter(e => !e.ok).length } : {}), ...(factcheck ? { facts: arr(factcheck.items).length, facts_wrong: arr(factcheck.items).filter(x => x.grade === 'E').length, facts_error: factcheck.error || '' } : {}) } };
    if (kind === 'check') { delete fresh.steps.final_review; delete fresh.steps.reverse_audit; if (fresh.review.audit) fresh.review.audit = null; }
    if (kind === 'final' && fresh.review.audit) fresh.review.audit.used_selection = (fresh.review.audit.selection || null);
    if (run.attempts) fresh.attempts = run.attempts;
    store.saveRun(fresh);
    return { ok: true, issues: issues.length, changed };
  } catch (e) {
    const fresh = store.getRun(runId) || run;
    fresh.steps = { ...(fresh.steps || {}), [P.step]: { status: 'failed', error: e.message } };
    if (factcheck) { fresh.review = fresh.review || {}; fresh.review.factcheck = factcheck; }
    store.saveRun(fresh);
    throw e;
  }
}

// ---------- 二稿逆向工程审稿(终审前) ----------
// 把原片标题、原文案、拆解框架、新题目、新标题和二稿交给模型,按用户的审稿提示词出完整报告(赛道、评分、迁移对照、
// 逐段问题 P01…、深层问题、P0/P1/P2、三种修改路线)。报告末尾附一段 ===SCORE=== / ===ISSUES=== / ===ROUTE=== 清单给程序读。
// 报告出来后流程停住:人在页面上勾选要改的问题、选修改路线,再带着这些去终审。
const AUDIT_ISSUE_RE = /^\s*[-*•]\s*\[(P\d+)\]\s*\[([SABC])[级]?\]\s*\[(P[012])\]\s*\[([^\]]+)\]\s*(?:\[\s*\+?\s*(\d+(?:\.\d+)?)\s*分?\s*\]\s*)?(.+)$/i;
const AUDIT_MAX_ROUNDS = 4; // 报告很长,被 max_tokens 截断就接着写,最多续 3 次
const ROUTE_NAMES = { A: '最小修改', B: '结构优化', C: '深度重构' };

function parseAuditIssues(text) {
  return String(text || '').split('\n').map(l => {
    const m = l.match(AUDIT_ISSUE_RE);
    if (!m) return null;
    const parts = m[6].split(/\s*[｜|]\s*/);
    return {
      id: m[1].toUpperCase().replace(/^P(\d)$/, 'P0$1'), severity: m[2].toUpperCase(), priority: m[3].toUpperCase(),
      gain: m[5] != null ? +m[5] : null,
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
// 保存前清掉非中文稿里混进的汉字/日文假名(规则修 + 模型逐行改写,见 purify.js)
async function purifyText(run, cfg, text, label) {
  return purify.purifyScript(text, run.audience, async p => (await callLong(run, cfg, p, label + '·外文字符修正')).content);
}
// 日志挂在 review.foreign 上,详情页显示;这一遍没发现问题就清掉旧日志
function setForeign(fresh, pure, label) {
  fresh.review = fresh.review || {};
  fresh.review.foreign = purify.hasLog(pure.log) ? { at: new Date().toISOString(), pass: label, ...pure.log } : null;
}

async function callLong(run, cfg, prompt, label) {
  let messages = [{ role: 'user', content: prompt }];
  let text = '', r = null, secs = 0;
  for (let round = 0; round < AUDIT_MAX_ROUNDS; round++) {
    // 渠道中途断流(实测 run 비빔밥 终审·审稿在第 202 秒断流,已收到 1.1 万字,原样重试 4 次全断):
    // 收到的正文不丢,和 max_tokens 截断一样让模型接着写,不从头重来
    r = await an().callWithLog(run, cfg, messages, round ? label + '续写' + round : label, { allowPartial: true, minPartial: 500 });
    text += r.content;
    secs += r.secs || 0;
    if (r.stopReason !== 'max_tokens' && !r.partial) return { content: text, secs, truncated: false };
    messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: '输出被截断了。从你上一条最后一个字接着往下写,不要重复已经写过的内容,不要重新开头,最后照样输出结尾那段 === 开头的给程序读的清单。' }];
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
      analysis: run.analysis ? an().analysisBrief(a, run) : '(无写前分析)',
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
// 二稿审稿报告的勾选:人每改一次就存到 audit.selection(之前只在点终审时存,终审前刷新或改了没点就丢了)。
// 只存选择,不点火;终审跑的时候不改,免得改掉正在用的那份
function saveAuditSelection(runId, body) {
  const run = store.getRun(runId);
  if (!run) throw Object.assign(new Error('任务不存在'), { status: 404 });
  const au = (run.review || {}).audit;
  if (!au) throw Object.assign(new Error('还没有审稿报告'), { status: 400 });
  if (String(body.audit_at || '') !== String(au.at || '')) return { ok: false, stale: true }; // 报告已经重跑过,旧页面的勾选不再适用
  if (((run.steps || {}).final_review || {}).status === 'running') return { ok: false, running: true };
  const ids = arr(body.ids).map(String).filter(id => arr(au.issues).some(x => x.id === id));
  const track = lockedTrack(run) || (TRACK_KEYS.includes(body.track) ? body.track : '');
  au.selection = { ids, route: ROUTE_NAMES[body.route] ? body.route : '', note: String(body.note || '').trim().slice(0, 2000), track, at: new Date().toISOString(), draft: true };
  store.saveRun(run);
  return { ok: true };
}

function startFinal(runId, body) {
  const run = store.getRun(runId);
  if (!run) throw Object.assign(new Error('任务不存在'), { status: 404 });
  if (passBusy(runId)) throw Object.assign(new Error(busyMsg(runId, '终审')), { status: 409 });
  if (((run.steps || {}).final_review || {}).status === 'running') throw Object.assign(new Error('终审正在进行'), { status: 400 });
  if (lockedTrack(run)) body = { ...body, track: run.review_track };
  const au = (run.review || {}).audit;
  if (au) {
    const ids = arr(body.ids).map(String).filter(id => arr(au.issues).some(x => x.id === id));
    au.selection = { ids, route: ROUTE_NAMES[body.route] ? body.route : '', note: String(body.note || '').trim().slice(0, 2000), track: TRACK_KEYS.includes(body.track) ? body.track : '', at: new Date().toISOString() };
  }
  run.review = run.review || {};
  if (TRACK_KEYS.includes(body.track)) run.review.final_track = body.track;
  store.saveRun(run);
  runPasses(runId, 'final').catch(() => {});
  return { ok: true };
}

// ---------- 终审(v1.8):独立审稿 → 按诊断修改 → 独立复审,按赛道换提示词 ----------
// 三步分开调用,避免模型一边写一边替自己的问题辩护:
//   ① 审稿(final_audit.md):七维评分、P0–P3 问题清单、结构方案、待核实事实、修改决策,不改稿;
//   ② 修改(final_revise.md):按审稿报告 + 人工勾选的二稿审稿问题,列出一处一处的修改,程序套到二稿上;
//   ③ 复审(final_recheck.md):把改后的全文当新稿再审,给修改前后评分对照;没达标就再给一轮修改,套上后再复审一次(只出报告)。
// 赛道配置在 prompts/final_tracks/*.md:不同赛道替换「维度4」的审查内容、频道定位、留存重点。
const TRACK_KEYS = ['econ', 'history', 'science', 'pov', 'general'];
const FINAL_RECHECK_ROUNDS = 2;

function loadTrack(key) {
  const k = TRACK_KEYS.includes(key) ? key : 'general';
  const b = parseBlocks(readPrompt('final_tracks/' + k + '.md'));
  return {
    key: k, name: b.NAME || k, match: b.MATCH || '', audience: b.AUDIENCE || '', position: b.POSITION || '',
    dim4_name: b.DIM4_NAME || '事实与逻辑', dim4_role: b.DIM4_ROLE || '事实审稿人', dim4_view: b.DIM4_VIEW || '',
    mechanism: b.MECHANISM || '', dim4: b.DIM4 || '', retention: b.RETENTION || '', dim4_recheck: b.DIM4_RECHECK || '',
    deai_protect: b.DEAI_PROTECT || '- 所有事实、数字、案例和引用。\n- 因果链和信息递进的顺序。', deai_focus: b.DEAI_FOCUS || '重复的总结句和模板化转场。'
  };
}
function trackList() { return TRACK_KEYS.map(k => { const tr = loadTrack(k); return { key: k, name: tr.name }; }); }

// 默认赛道:写前分析匹配到的赛道证据卡;没有就按题目和资产重新匹配一次
// 建任务时选定的频道方向(run.review_track)优先,且锁定:审稿报告、终审、去AI感都只用它
function lockedTrack(run) { return run && TRACK_KEYS.includes(run.review_track) ? run.review_track : ''; }
function autoTrack(run, asset) {
  if (lockedTrack(run)) return run.review_track;
  let name = run.track_card_name || '';
  if (!name) { try { const c = an().pickTrackCard(run.track, run.topic, asset); name = c ? c.name : ''; } catch (e) {} }
  return TRACK_KEYS.find(k => { const m = loadTrack(k).match; return m && m === name; }) || 'general';
}

function finalDims(tr) {
  return ['框架与结构', '核心矛盾', '信息递进', tr.dim4_name, '留存与承诺兑现', '目标国家母语口播', '结尾完整性与整体一致性'];
}

// ===SCORES=== 段:一行一个「维度: 分数」;对不上名字的按顺序取
function parseScores(block, dims) {
  const lines = String(block || '').split('\n').map(l => l.replace(/\*+/g, '').trim()).filter(l => /\d/.test(l));
  const out = {};
  dims.forEach((d, i) => {
    const line = lines.find(l => l.includes(d)) || lines.find(l => l.includes(d.slice(0, 2)));
    const m = (line || '').match(/(\d+(?:\.\d+)?)\s*(?:\/\s*10)?\s*$/) || (line || '').match(/(\d+(?:\.\d+)?)/);
    if (m && +m[1] <= 10) out[d] = +m[1];
    else if (lines[i] && /^(\D*?)(\d+(?:\.\d+)?)/.test(lines[i]) && +lines[i].match(/(\d+(?:\.\d+)?)/)[1] <= 10 && !line) out[d] = +lines[i].match(/(\d+(?:\.\d+)?)/)[1];
  });
  return out;
}

// 报告正文 + 尾部清单:清单从第一个 ===SCORES=== 开始
function splitReport(content) {
  // 分隔符被加粗、放进代码块或和别的字连在一行时,先拆成单独一行
  const c = String(content || '').replace(/[*`]*(===\s*(?:SCORES|VERDICT|OPEN|EDIT|END)\s*===)[*`]*/gi, '\n$1\n').replace(/^[ \t]+(===)/gm, '$1');
  const cut = c.search(/^===\s*SCORES\s*===\s*$/m);
  return { report: (cut >= 0 ? c.slice(0, cut) : c).replace(/\n```[a-z]*\s*$/, '').trim(), tail: cut >= 0 ? c.slice(cut).replace(/^```.*$/gm, '') : '', all: c };
}

// 清单里没读出分数时,从报告正文的评分表里找:一行有维度名,取表格里第 pick 个纯数字格(审稿报告取第 1 个,复审对照表取第 2 个=修改后)
function scoresFromReport(report, dims, pick) {
  const out = {};
  const rows = String(report || '').split('\n').filter(l => l.includes('|'));
  dims.forEach(d => {
    const row = rows.find(l => l.includes(d)) || rows.find(l => l.includes(d.slice(0, 4)));
    if (!row) return;
    const nums = row.split('|').map(x => x.replace(/\*+/g, '').trim()).map(x => x.match(/^(\d+(?:\.\d+)?)\s*(?:\/\s*10|分)?$/)).filter(Boolean).map(m => +m[1]).filter(n => n <= 10);
    const n = nums[Math.min(pick, nums.length) - 1];
    if (n != null) out[d] = n;
  });
  // 没有评分表时,按小标题找:「### 1. 框架与结构:6分」「框架与结构:6 → 7 分」
  const lines = String(report || '').split('\n').filter(l => !l.includes('|'));
  dims.forEach(d => {
    if (out[d] != null) return;
    const line = lines.find(l => l.includes(d) && new RegExp(d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[*\\s]*[:：]').test(l));
    if (!line) return;
    const after = line.slice(line.indexOf(d) + d.length).replace(/\*+/g, '');
    const nums = (after.match(/\d+(?:\.\d+)?(?=\s*(?:分|\/\s*10|→|->|$|\s))/g) || []).map(Number).filter(n => n <= 10);
    const n = pick > 1 ? nums[nums.length - 1] : nums[0];
    if (n != null) out[d] = n;
  });
  return out;
}
function fillScores(scores, report, dims, pick) {
  const have = scores || {};
  if (dims.every(d => have[d] != null)) return have;
  return { ...scoresFromReport(report, dims, pick), ...have };
}

// 一章改后的文字切成片段:原文片段记它在改前那章的位置,修改片段记是哪一处修改
function chapterPieces(baseText, edits) {
  const pieces = [];
  let at = 0, r = 0;
  edits.filter(e => e.ok).sort((a, b) => a.start - b.start).forEach(e => {
    if (e.start > at) { pieces.push({ type: 'base', rs: r, re: r + e.start - at, bs: at, be: e.start }); r += e.start - at; }
    const len = (e.new || '').length;
    pieces.push({ type: 'edit', rs: r, re: r + len, bs: e.start, be: e.end, e });
    r += len; at = e.end;
  });
  if (at < baseText.length) pieces.push({ type: 'base', rs: r, re: r + baseText.length - at, bs: at, be: baseText.length });
  return pieces;
}

// 复审又改了一轮:把第二轮的修改折算回「相对二稿」的修改,和第一轮重叠的合并成一处(理由合在一起),
// 这样全文修订页始终以二稿为底,一次看全两轮改动
function mergeRounds(base, text1, edits1, edits2) {
  const out = edits1.filter(e => e.ok).map(e => ({ ...e }));
  const baseChs = Object.fromEntries(scriptChapters(base).map(c => [c.id, c.text]));
  const r1Chs = Object.fromEntries(scriptChapters(text1).map(c => [c.id, c.text]));
  for (const chId of [...new Set(edits2.filter(e => e.ok).map(e => e.chapter))]) {
    const B = baseChs[chId], R = r1Chs[chId];
    if (B == null || R == null) continue;
    const mine = out.filter(e => e.chapter === chId);
    let pieces = chapterPieces(B, mine);
    // 片段拼出来的文字和稿子里这一章可能差首尾空白(replaceChapter 会 trim)
    const composed = pieces.map(p => p.type === 'base' ? B.slice(p.bs, p.be) : (p.e.new || '')).join('');
    const lead = composed.length - composed.trimStart().length;
    pieces.forEach(p => { p.rs -= lead; p.re -= lead; });
    for (const e2 of edits2.filter(e => e.ok && e.chapter === chId).sort((a, b) => b.start - a.start)) {
      const s = e2.start, en = e2.end;
      const hit = pieces.filter(p => (p.rs < en && p.re > s) || (p.rs === p.re && p.rs > s && p.rs < en));
      const eds = hit.filter(p => p.type === 'edit');
      const RS = Math.min(s, ...eds.map(p => p.rs)), RE = Math.max(en, ...eds.map(p => p.re));
      const toBase = (x, isEnd) => {
        const p = pieces.find(q => (isEnd ? q.rs < x && q.re >= x : q.rs <= x && q.re > x)) || pieces.find(q => q.rs <= x && q.re >= x);
        if (!p) return isEnd ? B.length : 0;
        return p.type === 'base' ? p.bs + (x - p.rs) : (isEnd ? p.be : p.bs);
      };
      const BS = toBase(RS, false), BE = toBase(RE, true);
      const merged = eds.map(p => p.e);
      merged.forEach(m => { const i = out.indexOf(m); if (i >= 0) out.splice(i, 1); });
      const ne = {
        chapter: chId, ok: true, round: merged.length ? '1+2' : '2', start: BS, end: BE, old: B.slice(BS, BE),
        new: R.slice(RS, s) + (e2.new || '') + R.slice(en, RE),
        category: [...new Set([...merged.map(m => m.category), e2.category].filter(Boolean))].join(' / '),
        reason: [...merged.map(m => m.reason), '复审:' + (e2.reason || '')].filter(Boolean).join(';')
      };
      out.push(ne);
      // 重建这一章的片段:新修改之前的保持不动(从后往前处理,后面的不会再用到)
      pieces = pieces.filter(p => p.re <= RS || (p.type === 'base' && p.rs < RS)).map(p => (p.type === 'base' && p.re > RS ? { ...p, re: RS, be: p.bs + (RS - p.rs) } : p));
      pieces.push({ type: 'edit', rs: RS, re: RS + ne.new.length, bs: BS, be: BE, e: ne });
    }
  }
  return out.sort((a, b) => (a.chapter === b.chapter ? a.start - b.start : a.chapter.localeCompare(b.chapter))).map((e, i) => ({ ...e, n: i + 1 }));
}

function setFinalStage(runId, stage) {
  const fresh = store.getRun(runId);
  if (!fresh) return;
  fresh.steps = { ...(fresh.steps || {}), final_review: { ...((fresh.steps || {}).final_review || {}), status: 'running', stage } };
  store.saveRun(fresh);
}

function editsText(edits) {
  const ok = edits.filter(e => e.ok);
  return ok.length ? ok.map(e => '- [' + e.chapter + '][' + (e.category || '') + '] ' + (e.reason || '') + '\n  原句:' + e.old + '\n  改成:' + (e.new || '(删除)')).join('\n') : '(没有修改)';
}

// 套修改;原句找不到的,把那几章原文发回给模型,让它逐字重抄原句,再整体套一次
async function applyWithRepair(run, cfg, text, edits, label, limit) {
  let res = applyEdits(text, edits.map(e => ({ ...e })), limit);
  const lost = res.edits.filter(e => !e.ok && /没找到/.test(e.error || ''));
  if (!lost.length) return res;
  const chs = scriptChapters(text);
  const ids = [...new Set(lost.map(e => e.chapter).filter(id => chs.some(c => c.id === id)))];
  const show = ids.length ? chs.filter(c => ids.includes(c.id)) : chs;
  const prompt = an().fillVars(readPrompt('final_fix_quotes.md'), {
    failed: lost.map(e => '===EDIT===\n章节:' + (e.chapter || '') + '\n类别:' + (e.category || '') + '\n原句:' + e.old + '\n改成:' + (e.new || '(删除)') + '\n理由:' + (e.reason || '')).join('\n'),
    chapters: show.map(c => c.tag + '\n' + c.text).join('\n\n')
  });
  try {
    const r = await callLong(run, cfg, prompt, label + '·补对原句');
    const fixed = parseEdits(r.content);
    if (!fixed.length) return res;
    const keepOk = res.edits.filter(e => e.ok || (!/没找到/.test(e.error || '') && !e.growth_rejected)).map(e => ({ chapter: e.chapter, category: e.category, old: e.old, new: e.new, reason: e.reason, ...(e.occ ? { occ: e.occ } : {}) }));
    const again = applyEdits(text, keepOk.concat(fixed), limit);
    // 补了以后仍然找不到的,保留模型最初给的原句,方便人看
    const stillLost = lost.filter(l => !again.edits.some(e => e.ok && e.reason === l.reason && e.new === l.new));
    again.edits = again.edits.filter(e => e.ok || !/没找到/.test(e.error || '')).concat(stillLost);
    return again;
  } catch (e) { return res; }
}

// 终审各步共用的提示词变量
const OPEN_FORMAT = '在 ===OPEN=== 下面逐行列出还没解决的问题(达标且没有遗留问题就写「无」),每行一个,格式:\n- [R01][CH13][关键] 问题(中文,一两句;引用原句保留原语言) | 建议改法(中文)\n第三个方括号只能写 关键、结构、次要、待核实 之一。「待核实」指需要人确认事实或数据才能改的问题。「结构」指章节顺序或时间线跳跃、论证骨架、某一章整体没完成它的功能这类逐句改不动、要整章重写的问题,第二个方括号写明是哪一章(只写一章)。';
function finalCommon(run, tr, dims) {
  const a = run.analysis || {};
  const aud = run.audience || {};
  const lang = aud.target_language || '';
  return {
    today: pl().todayStr(), topic: run.topic, title: ((a.title || {}).final_title) || run.topic,
    target_language: lang, target_country: aud.target_country || '', video_goal: aud.video_goal || '(未指定,按稿件实际长度判断)',
    voice: voice.voiceBrief(voice.voiceForRun(run)) || '(未设定)',
    analysis: run.analysis ? an().analysisBrief(a, run, tr.key) : '(无写前分析)',
    track_name: tr.name, track_audience: tr.audience, track_position: tr.position, track_mechanism: tr.mechanism,
    track_dim4: tr.dim4, track_retention: tr.retention, dim4_name: tr.dim4_name, dim4_role: tr.dim4_role, dim4_view: tr.dim4_view, dim4_recheck: tr.dim4_recheck,
    language_notes: /^Korean$/i.test(lang) ? '例如韩语里频繁使用「그런데」「하지만」「문제는」「진짜 이유는」。' : '',
    dims_list: dims.map((d, i) => (i + 1) + '. ' + d).join('\n'),
    dims_score_lines: dims.map(d => d + ': 分数').join('\n'),
    open_format: OPEN_FORMAT, patch_note: '',
    fact_check: factBrief((run.review || {}).factcheck)
  };
}

// 复审引用的原句在稿子里找不到:实测 run_7c467c8e0a71 第 2 轮复审把写前分析钩子候选里的「지난 2년간 매출이 70% 넘게 뛰었다」
// 当成稿子原句判「关键」、事实维度 6→2,稿子里根本没有这句。问题描述里引号内的原文(≥10 字,不含汉字的才算原文引用)
// 一句都对不上稿子(最长共同片段 < 8 字且 < 60%)就标 not_found:不挡发布,补改默认不改
const normQ = t => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function longestIn(q, s) {
  let best = 0;
  for (let i = 0; i + best < q.length; i++) { let n = best + 1; while (i + n <= q.length && s.includes(q.slice(i, i + n))) { best = n; n++; } }
  return best;
}
function markMissingQuotes(open, script, lang) {
  if (/^(Chinese|Japanese)$/i.test(lang || '')) return open;
  const ns = normQ(script);
  return arr(open).map(x => {
    const qs = [];
    const re = /["“”「」『』]([^"“”「」『』]{4,300})["“”「」『』]/g;
    let m;
    while ((m = re.exec(String(x.problem || '')))) { const q = normQ(m[1]); if (q.length >= 10 && !/[\u4e00-\u9fff]/.test(m[1])) qs.push(q); }
    if (!qs.length) return x;
    const found = qs.some(q => { const l = longestIn(q, ns); return l >= 8 || l >= q.length * 0.6; });
    return found ? x : { ...x, not_found: true };
  });
}
// 上一轮复审的分数和遗留问题:第 2 轮复审、补改后复审以它为起点,分数变动要对应到之后的改动(实测同一篇第 1 轮 7.1、只改了 3 句后第 2 轮 5.7)
function prevRoundText(rc, dims) {
  if (!rc || !rc.scores) return '';
  return '【上一轮复审(同一篇稿子上一次复审的评分;这一轮以它为起点,分数变动要对应到之后的改动,或写明是上一轮漏判、稿子里一直存在的问题)】\n'
    + dims.map(d => d + ': ' + (rc.scores[d] != null ? rc.scores[d] : '—')).join('\n')
    + '\n上一轮列出的未解决问题:\n' + (arr(rc.open).filter(x => !x.not_found).map(x => '- [' + x.id + '][' + x.chapter + '][' + x.level + '] ' + x.problem).join('\n') || '(无)') + '\n\n';
}

// ===OPEN=== 段:复审没解决的问题,一行一条 - [R01][CH13][关键] 问题 | 建议
function parseOpen(block) {
  const out = [];
  String(block || '').split('\n').forEach(l => {
    const m = l.replace(/\*+/g, '').match(/^\s*[-*\d.)]*\s*\[\s*(R\d+)\s*\]\s*\[\s*([^\]]*)\]\s*\[\s*([^\]]*)\]\s*(.+)$/i);
    if (!m) return;
    const [problem, ...rest] = m[4].split(/\s*[|｜]\s*/);
    const level = /待核实|核实/.test(m[3]) ? '待核实' : /次要/.test(m[3]) ? '次要' : /结构/.test(m[3]) ? '结构' : '关键';
    out.push({ id: m[1].toUpperCase(), chapter: (m[2].match(/CH\d+/gi) || []).map(x => x.toUpperCase()).join('/') || m[2].trim(), level, problem: problem.trim(), suggestion: rest.join(' | ').replace(/^建议(改法)?[:：]\s*/, '').trim() });
  });
  return out;
}

// 复审报告读不出评分或结论(模型没写 ===SCORES===/===VERDICT=== 清单、写错格式或被截断):
// 把报告交回模型,只补这份清单,不重审;补出来的只填空缺,已经读到的不动
const parseVerdict = v => /未达标/.test(v || '') ? '未达标' : /达标/.test(v || '') ? '达标' : '';
// 复审没读到分数时把原文存下来,方便查是模型没写清单还是格式没认出来
function dumpNoScore(run, content) {
  try {
    const dir = path.join(__dirname, '..', 'data', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'recheck_noscore_' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt'), 'run=' + run.id + '\n\n' + String(content || '').slice(0, 80000), 'utf-8');
  } catch (e) { /* 留痕失败不影响流程 */ }
}
async function ensureRecheckBlocks(run, cfg, common, dims, s3, label) {
  const tb = parseBlocks(s3.tail, false);
  let scores = fillScores(parseScores(tb.SCORES, dims), s3.report, dims, 2), verdict = parseVerdict(tb.VERDICT);
  if (verdict && dims.every(d => scores[d] != null) || !String(s3.report || s3.all || '').trim()) return { tb, scores, verdict };
  try {
    const r = await callLong(run, cfg, '下面是一份复审报告。按报告里已经写出的评分和结论,只输出给程序读取的清单,不要重写报告,不要改分数,报告里没写分数的维度按报告内容给分。\n' +
      '格式(不要代码围栏):\n===SCORES===\n' + common.dims_score_lines + '\n===OPEN===\n' + OPEN_FORMAT + '\n===VERDICT===\n达标 或 未达标(只写这三个字之一)\n===END===\n\n【复审报告】\n' + (String(s3.report || '').trim() ? s3.report : s3.all), label + '·补评分');
    const sx = splitReport(r.content), tx = parseBlocks(sx.tail || sx.all, false);
    scores = { ...parseScores(tx.SCORES, dims), ...Object.fromEntries(Object.entries(scores).filter(([, v]) => v != null)) };
    verdict = verdict || parseVerdict(tx.VERDICT);
    return { tb: { ...tx, ...Object.fromEntries(Object.entries(tb).filter(([, v]) => v)) }, scores, verdict, refilled: true };
  } catch (e) { return { tb, scores, verdict }; }
}

// 终审不空转:一轮下来七维平均涨不到 STALL_MIN 分,再逐句改也没用(实测一篇 POV 稿改了 59 处,5.7 → 6,复审 3 轮都未达标),
// 停下来;复审标成「结构」的问题(时间线跳跃、论证骨架、整章没完成功能)交给整章重写,每轮最多 STRUCT_MAX 章
const REVERT_DROP = 0.3; // 补改后平均分掉这么多就退回
const CLAIM_REVERT_DROP = 1; // 按论点核对补改:论点对不上比 AI 打分要紧,掉 1 分以上才退回
const STALL_MIN = 0.3, STRUCT_MAX = 2;
function avgScore(scores, dims) {
  const xs = dims.map(d => scores && scores[d]).filter(x => typeof x === 'number');
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
const stalledBy = (before, after, dims) => { const a = avgScore(before, dims), b = avgScore(after, dims); return a != null && b != null && b - a < STALL_MIN; };
// 按复审的结构问题整章重写(在内存里的稿子上改,不落盘);改长、结构坏了的章不采用
async function structuralRewrite(run, asset, cfg, text, items, limit, label) {
  const byCh = {};
  arr(items).filter(x => x.level === '结构').forEach(x => { const ch = (String(x.chapter).match(/CH\d+/i) || [''])[0].toUpperCase(); if (ch) (byCh[ch] = byCh[ch] || []).push(x); });
  const done = [];
  for (const ch of Object.keys(byCh).slice(0, STRUCT_MAX)) {
    const note = '复审指出这一章有结构问题,逐句改解决不了,请整章重写解决:\n' + byCh[ch].map(x => '- ' + x.problem + (x.suggestion ? '(建议:' + x.suggestion + ')' : '')).join('\n') +
      '\n只重写这一章,篇幅不超过现在这一章;和前后章的衔接、已核实的事实和数字保持不变。';
    try {
      const out = await an().callJson(run, cfg, rewritePrompt({ ...run, script_v1: text }, asset, ch, note, false), label + '·整章重写 ' + ch, o => typeof o.text === 'string' && o.text.trim());
      const t = replaceChapter(text, ch, String(out.text).replace(/^\s*\[CH\d+[^\]]*\]\s*\n?/, '').trim());
      if (!t || checks.chapterStructureError(t)) { done.push({ chapter: ch, ok: false, error: '重写后章节结构不对,没有采用' }); continue; }
      const g = limitChapterGrowth(text, t, limit);
      if (g.rejected.length) { done.push({ chapter: ch, ok: false, error: g.rejected[0].reason + ',没有采用' }); continue; }
      text = t;
      done.push({ chapter: ch, ok: true, ids: byCh[ch].map(x => x.id) });
    } catch (e) { done.push({ chapter: ch, ok: false, error: e.message }); }
  }
  return { text, done };
}

async function runFinal(runId) {
  const cfg = pl().loadConfig();
  let { run, asset } = loadRunAsset(runId);
  if (!cfg || !cfg.api_key) throw Object.assign(new Error('未配置 API Key'), { status: 400 });
  const start = currentScript(run);
  if (!start) throw Object.assign(new Error('稿子还没写好'), { status: 400 });
  const vByKey = Object.fromEntries(arr((run.review || {}).versions).map(v => [v.key, v]));
  const untouched = (vByKey.d3 && vByKey.d3.text === start) || (vByKey.d4 && vByKey.d4.text === start);
  const base = vByKey.d2 && untouched ? vByKey.d2.text : start;
  const sel = ((run.review || {}).audit || {}).selection || null;
  const trackKey = lockedTrack(run) || (sel && sel.track) || (run.review || {}).final_track || autoTrack(run, asset);
  const tr = loadTrack(trackKey);
  const dims = finalDims(tr);
  const t0 = Date.now();
  run.steps = { ...(run.steps || {}), final_review: { status: 'running', stage: '审稿', track: tr.key, started_at: new Date().toISOString() } };
  run.review = run.review || {};
  if (!arr(run.review.versions).length) run.review.versions = [{ key: 'd1', label: '初稿', at: new Date().toISOString(), text: base, issues: [] }];
  store.saveRun(run);
  try {
    const common = { ...finalCommon(run, tr, dims), selected_fixes: selectedFixes(run) };
    // ① 审稿
    const r1 = await callLong(run, cfg, an().fillVars(readPrompt('final_audit.md'), { ...common, chapter_map: chapterMap(run, asset), program_findings: programFindings(run, asset), script: base }), '终审·审稿');
    const s1 = splitReport(r1.content);
    const scoresBefore = fillScores(parseScores(parseBlocks(s1.tail, false).SCORES, dims), s1.report, dims, 1);
    // ② 修改
    setFinalStage(runId, '修改');
    const r2 = await callLong(run, cfg, an().fillVars(readPrompt('final_revise.md'), { ...common, audit_report: s1.report, listen_findings: listenFindings(run, base), script: base }), '终审·修改');
    let edits1 = parseEdits(r2.content);
    if (r2.truncated && !/^===\s*END\s*===/m.test(r2.content)) edits1 = edits1.slice(0, -1);
    const limit = growthLimit(run, base);
    const a1 = await applyWithRepair(run, cfg, base, edits1, '终审·修改', limit);
    let text = a1.next, edits = a1.edits.filter(e => e.ok).map(e => ({ ...e })), failed = a1.edits.filter(e => !e.ok);
    // ③ 复审(没达标就再改一轮,再复审一次)
    const rechecks = [], snaps = [];
    const lang = (run.audience || {}).target_language;
    for (let round = 1; round <= FINAL_RECHECK_ROUNDS; round++) {
      setFinalStage(runId, '复审' + (round > 1 ? '(第 ' + round + ' 轮)' : ''));
      const allowEdits = round < FINAL_RECHECK_ROUNDS;
      // 每轮复审看到的稿子留个底:后一轮分数掉了就退回分数最高那一轮的稿子
      snaps.push({ text, edits: edits.slice(), failed: failed.slice() });
      const prev = rechecks[rechecks.length - 1];
      const r3 = await callLong(run, cfg, an().fillVars(readPrompt('final_recheck.md'), {
        ...common, ...thesisVars(run), scores_before: dims.map(d => d + ': ' + (scoresBefore[d] != null ? scoresBefore[d] : '—')).join('\n'),
        prev_round: prevRoundText(prev, dims),
        edits_done: round === 1 ? editsText(edits) : editsText(prev.edits_applied || []) + (arr(prev.structural).some(x => x.ok) ? '\n整章重写了:' + arr(prev.structural).filter(x => x.ok).map(x => x.chapter).join('、') + '(解决上一轮指出的结构问题)' : ''),
        edits_instruction: allowEdits ? '如果未达标,在 ===VERDICT=== 那一行后面接着输出要补的修改(格式同前:每处以 ===EDIT=== 开头,写 章节/类别/原句/改成/理由;原句从上面「修改后的完整稿子」逐字复制;只修尚未解决的问题;标成「结构」的问题不要逐句改,程序会把那一章整章重写;不许把稿子改长,前 2 分钟只许删和换,程序会退回加长的修改),然后再写 ===END===。达标就不要输出修改。' : '这是最后一轮复审,只出报告,不要输出修改。',
        listen_findings: listenFindings(run, text),
        script: text
      }), '终审·复审' + round);
      const s3 = splitReport(r3.content);
      const { tb, scores: sc3, verdict, refilled } = await ensureRecheckBlocks(run, cfg, common, dims, s3, '终审·复审' + round);
      const rc = { round, report: s3.report, scores: sc3, verdict, open: markMissingQuotes(parseOpen(tb.OPEN), text, lang), thesis: parseThesis(tb.THESIS), craft: parseCraft(tb.CRAFT), edits_applied: [], ...(refilled ? { refilled: true } : {}), ...(r3.truncated ? { truncated: true } : {}) };
      rechecks.push(rc);
      if (!allowEdits || verdict !== '未达标') break;
      // 分数没涨:不再逐句改,只做结构问题的整章重写;没有结构问题就停
      const stalled = stalledBy(round === 1 ? scoresBefore : rechecks[rechecks.length - 2].scores, sc3, dims);
      if (stalled) rc.stalled = true;
      let edits2 = stalled ? [] : parseEdits(s3.tail);
      // 复审引用了稿子里没有的句子的问题,不拿去整章重写
      rc.open_for_rewrite = rc.open.filter(x => !x.not_found);
      if (r3.truncated && !/^===\s*END\s*===/m.test(s3.tail)) edits2 = edits2.slice(0, -1);
      if (edits2.length) {
        const a2 = await applyWithRepair(run, cfg, text, edits2, '终审·复审' + round, limit);
        rc.edits_applied = a2.edits.filter(e => e.ok);
        failed = failed.concat(a2.edits.filter(e => !e.ok).map(e => ({ ...e, round: '2' })));
        if (rc.edits_applied.length) { edits = mergeRounds(base, text, edits, a2.edits); text = a2.next; }
      }
      if (rc.open_for_rewrite.some(x => x.level === '结构')) {
        setFinalStage(runId, '整章重写');
        const sr = await structuralRewrite(run, asset, cfg, text, rc.open_for_rewrite, limit, '终审·复审' + round);
        rc.structural = sr.done;
        text = sr.text;
      }
      if (!rc.edits_applied.length && !arr(rc.structural).some(x => x.ok)) break;
    }
    // 最后一轮复审比分数最高的那一轮低 REVERT_DROP 以上:退回那一轮复审看到的稿子(之后的修改不要),
    // 后面几轮记成被退回的尝试,和补改退回一样可以让 AI 找原因再试(实测 run_7c467c8e0a71 第 1 轮 7.1,第 2 轮 5.7 仍存成终稿)
    let finalReverted = null;
    const avgs = rechecks.map(r => avgScore(r.scores, dims));
    const bi = avgs.reduce((b, v, i) => (v != null && (b < 0 || v > avgs[b]) ? i : b), -1);
    const li = rechecks.length - 1;
    if (bi >= 0 && bi < li && avgs[li] != null && avgs[bi] - avgs[li] >= REVERT_DROP) {
      const best = rechecks[bi];
      const r1 = n => Math.round(n * 10) / 10;
      const later = rechecks.slice(bi + 1);
      const lastLater = later[later.length - 1];
      finalReverted = {
        at: new Date().toISOString(), from: '终审', round: lastLater.round, picked: arr(best.open).filter(x => !x.not_found).map(x => x.id), choices: {}, note: '',
        report: lastLater.report, scores: lastLater.scores, verdict: lastLater.verdict, open: lastLater.open,
        edits: arr(best.edits_applied).map(e => ({ chapter: e.chapter, category: e.category || '', old: e.old, new: e.new, reason: e.reason })),
        ...(best.structural ? { structural: best.structural } : {}), before: r1(avgs[bi]), after: r1(avgs[li])
      };
      best.reverted = [finalReverted];
      best.edits_applied = [];
      delete best.structural;
      rechecks.length = bi + 1;
      ({ text, edits, failed } = snaps[bi]);
    }
    const allEdits = edits.map((e, i) => ({ ...e, n: i + 1 })).concat(failed.map((e, i) => ({ ...e, ok: false, n: edits.length + i + 1 })));
    const last = rechecks[rechecks.length - 1] || {};
    const pure = await purifyText(run, cfg, text, '终审');
    text = pure.text;
    const fresh = store.getRun(runId) || run;
    if (currentScript(fresh) !== start) throw new Error('终审运行期间稿子被改过,结果没有保存,请重跑');
    fresh.review = fresh.review || {};
    setForeign(fresh, pure, '终审');
    const versions = arr(fresh.review.versions).length ? fresh.review.versions : [{ key: 'd1', label: '初稿', at: new Date().toISOString(), text: base, issues: [] }];
    const keep = versions.filter(v => v.key === 'd1' || v.key === 'd2');
    const changed = [];
    scriptChapters(text).forEach(c => { const b = scriptChapters(base).find(x => x.id === c.id); if (b && b.text !== c.text) changed.push(c.id); });
    const issues = allEdits.filter(e => e.ok).map(e => ({ chapter: e.chapter || '全篇', category: e.category || '', problem: e.reason || '', quote: e.old, fix: e.new || '(删除)', edit: e.n }));
    keep.push({ key: 'd3', label: '终稿', at: new Date().toISOString(), text, issues, changed, edits: allEdits, base_text: base });
    fresh.review.versions = keep;
    fresh.review.deai = null;
    if (fresh.steps) delete fresh.steps.deai;
    fresh.review.final = {
      at: new Date().toISOString(), track: tr.key, track_name: tr.name, dims,
      audit_report: s1.report, scores_before: scoresBefore,
      rechecks: rechecks.map(r => ({ round: r.round, report: r.report, scores: r.scores, verdict: r.verdict, open: r.open, edits: r.edits_applied.length, ...(r.thesis ? { thesis: r.thesis } : {}), ...(r.stalled ? { stalled: true } : {}), ...(r.structural ? { structural: r.structural } : {}), ...(r.reverted ? { reverted: r.reverted } : {}) })),
      scores_after: last.scores || {}, verdict: last.verdict || ''
    };
    if (text !== start) writeScript(fresh, text);
    changed.forEach(id => { const st = chapterState(fresh, id); st.status = '待审'; st.history = [...arr(st.history), { at: new Date().toISOString(), note: '终审', by: 'final', text: scriptChapters(base).find(c => c.id === id).text }].slice(-HISTORY_MAX); });
    fresh.steps = { ...(fresh.steps || {}), final_review: {
      status: 'done', secs: Math.round((Date.now() - t0) / 100) / 10, finished_at: new Date().toISOString(), track: tr.key,
      issues: issues.length, changed: changed.length, edits: allEdits.filter(e => e.ok).length, edits_failed: allEdits.filter(e => !e.ok).length, verdict: last.verdict || '',
      ...(finalReverted ? { patch_reverted: { at: finalReverted.at, before: finalReverted.before, after: finalReverted.after, from: '终审' } } : {})
    } };
    if (fresh.review.audit) fresh.review.audit.used_selection = (fresh.review.audit.selection || null);
    if (run.attempts) fresh.attempts = run.attempts;
    store.saveRun(fresh);
    return { ok: true, edits: allEdits.length };
  } catch (e) {
    const fresh = store.getRun(runId) || run;
    fresh.steps = { ...(fresh.steps || {}), final_review: { status: 'failed', error: e.message, track: tr.key } };
    store.saveRun(fresh);
    throw e;
  }
}

// ---------- 按复审意见再改一轮 ----------
// 复审没达标时:把复审里没解决的问题列出来(新复审直接在 ===OPEN=== 里给;旧报告用 final_open_extract.md 整理),
// 人勾选、写下自己的决定,只补改这几处(final_patch.md),再复审一次(只出报告)。以终稿为底,不从二稿重来。
function openPrompt(report) {
  return an().fillVars(readPrompt('final_open_extract.md'), { open_format: OPEN_FORMAT, report });
}

async function extractOpen(runId) {
  const cfg = pl().loadConfig();
  const run = store.getRun(runId);
  const last = arr(((run.review || {}).final || {}).rechecks).slice(-1)[0];
  run.steps = { ...(run.steps || {}), final_open: { status: 'running', started_at: new Date().toISOString() } };
  store.saveRun(run);
  try {
    const r = await callLong(run, cfg, openPrompt(last.report), '终审·整理复审问题');
    const c = String(r.content || '').replace(/[*`]*(===\s*(?:OPEN|END)\s*===)[*`]*/gi, '\n$1\n');
    const items = markMissingQuotes(parseOpen(parseBlocks(c, false).OPEN || c), currentScript(run), (run.audience || {}).target_language);
    const fresh = store.getRun(runId) || run;
    const rc = arr(fresh.review.final.rechecks).slice(-1)[0];
    if (rc) rc.open = items;
    fresh.steps = { ...(fresh.steps || {}), final_open: { status: 'done', finished_at: new Date().toISOString(), items: items.length } };
    if (run.attempts) fresh.attempts = run.attempts;
    store.saveRun(fresh);
  } catch (e) {
    const fresh = store.getRun(runId) || run;
    fresh.steps = { ...(fresh.steps || {}), final_open: { status: 'failed', error: e.message } };
    store.saveRun(fresh);
    throw e;
  }
}

// 复审遗留问题的解决方案:每个问题出至少 3 种改法并标推荐,人在补改区直接选,不用自己写意见。
// 存在最后一轮复审上(rc.options = { R01: [{key, zh, why, recommended}] }),rc.options_for 记下对应的问题编号,问题列表变了就算旧的
const openKey = items => arr(items).map(x => x.id + ':' + x.problem).join('\n');
// 从模型输出里取每个问题的方案:编号容错(R1 / 「R01 」/ 小写)、options 写成数组或 {A:{…}}、改法字段写成 zh/text/content 或直接是字符串
function optionsFrom(out, items) {
  const options = {};
  const normId = v => { const m = String(v || '').match(/R\s*0*(\d+)/i); return m ? 'R' + m[1].padStart(2, '0') : ''; };
  const list = Array.isArray(out && out.items) ? out.items : (out && typeof out.items === 'object' ? Object.entries(out.items).map(([id, v]) => ({ id, ...(Array.isArray(v) ? { options: v } : v) })) : []);
  list.forEach(it => {
    const id = normId(it && it.id);
    if (!items.some(x => x.id === id)) return;
    const raw = Array.isArray(it.options) ? it.options : (it.options && typeof it.options === 'object' ? Object.values(it.options) : []);
    let opts = raw.map(o => (typeof o === 'string' ? { zh: o } : o)).filter(o => o && String(o.zh || o.text || o.content || '').trim())
      .map((o, i) => ({ key: String.fromCharCode(65 + i), zh: String(o.zh || o.text || o.content).trim(), why: String(o.why || o.reason || '').trim(), recommended: o.recommended === true }));
    // 只留一个推荐;模型没标就推荐第一种
    const ri = Math.max(0, opts.findIndex(o => o.recommended));
    opts = opts.map((o, i) => ({ ...o, recommended: i === ri }));
    if (opts.length) options[id] = opts;
  });
  return options;
}
async function runOpenOptions(runId) {
  const { run } = loadRunAsset(runId);
  const cfg = pl().loadConfig();
  if (!cfg || !cfg.api_key) throw Object.assign(new Error('未配置 API Key'), { status: 400 });
  const fin = (run.review || {}).final || {};
  const last = arr(fin.rechecks).slice(-1)[0];
  const items = arr(last && last.open);
  const d3 = arr(run.review.versions).find(v => v.key === 'd3');
  if (!items.length || !d3) return null;
  run.steps = { ...(run.steps || {}), final_options: { status: 'running', started_at: new Date().toISOString(), items: items.length } };
  store.saveRun(run);
  try {
    const tr = loadTrack(fin.track);
    const common = finalCommon(run, tr, arr(fin.dims).length ? fin.dims : finalDims(tr));
    const out = await an().callJson(run, cfg, an().fillVars(readPrompt('final_open_options.md'), {
      ...common, script: d3.text,
      items: items.map(x => x.id + ' | ' + x.chapter + ' | ' + x.level + ' | ' + x.problem + (x.not_found ? '(程序查过:引用的原句稿子里找不到,复审可能看错了;推荐「不改」那类方式)' : '') + ' | ' + (x.suggestion || '(无)')).join('\n')
    }), '终审·出解决方案', o => Object.keys(optionsFrom(o, items)).length >= Math.max(1, Math.ceil(items.length / 2)));
    const options = optionsFrom(out, items);
    // 实测 run_1f67a92553fd:出方案两次都「成功」但一条都对不上,页面只是按钮还在,人不知道出没出
    if (!Object.keys(options).length) throw new Error('AI 给的方案对不上问题编号,没有能用的方案');
    const fresh = store.getRun(runId) || run;
    const rc = arr(((fresh.review || {}).final || {}).rechecks).slice(-1)[0];
    if (!rc || openKey(rc.open) !== openKey(items)) throw new Error('出方案期间复审问题变了(又补改或重新整理过),这份方案作废,请再点一次');
    rc.options = options; rc.options_for = openKey(items);
    fresh.steps = { ...(fresh.steps || {}), final_options: { status: 'done', finished_at: new Date().toISOString(), items: Object.keys(options).length } };
    if (run.attempts) fresh.attempts = run.attempts;
    store.saveRun(fresh);
    return options;
  } catch (e) {
    const fresh = store.getRun(runId) || run;
    fresh.steps = { ...(fresh.steps || {}), final_options: { status: 'failed', error: e.message } };
    store.saveRun(fresh);
    throw e;
  }
}

// 补改把分改低、被退回后:AI 对照掉分的维度和复审报告找出是哪些改动改坏的,给每个问题重新定改法(照用/换候选/新写/不改),
// 程序按它的决定自动再补改一次,不让人去猜 11 个问题里哪个改坏了。AUTO_RETRY_MAX 次还是掉分就停下,把 AI 的判断摆出来
const AUTO_RETRY_MAX = 2;
const usedKey = (tried, id) => (tried.choices || {})[id] || (arr(tried.picked).includes(id) ? 'rv' : 'skip');
async function diagnosePatch(run, cfg, common, dims, last) {
  const tried = arr(last.reverted).slice(-1)[0];
  if (!tried) throw new Error('没有被退回的补改可以分析');
  const items = arr(last.open);
  const options = { ...(last.options || {}) };
  const optText = (id, k) => k === 'skip' ? '不改' : k === 'rv' ? '按复审建议:' + ((items.find(x => x.id === id) || {}).suggestion || '(无)') : k + ' ' + ((arr(options[id]).find(o => o.key === k) || {}).zh || '');
  const sc = (o, d) => (o && o[d] != null ? o[d] : '—');
  const out = await an().callJson(run, cfg, an().fillVars(readPrompt('final_patch_diagnose.md'), {
    ...common, before: tried.before, after: tried.after,
    dim_changes: dims.map(d => d + ': ' + sc(last.scores, d) + ' → ' + sc(tried.scores, d)).join('\n'),
    used: items.map(x => x.id + ' | ' + x.chapter + ' | ' + x.level + ' | ' + x.problem + ' | ' + optText(x.id, usedKey(tried, x.id))).join('\n'),
    edits: arr(tried.edits).map(e => '- [' + (e.chapter || '') + '][' + (e.category || '') + '] ' + e.old + ' → ' + (e.new || '(删除)')).join('\n')
      + (arr(tried.structural).filter(x => x.ok).length ? '\n整章重写了:' + arr(tried.structural).filter(x => x.ok).map(x => x.chapter).join('、') : '') || '(没有记录)',
    report: tried.report || '(无)',
    tried: arr(last.reverted).map((t, i) => '第' + (i + 1) + '次(' + t.before + ' → ' + t.after + '):' + items.map(x => x.id + '=' + usedKey(t, x.id)).join(' ')).join('\n'),
    candidates: items.map(x => x.id + ':\n' + (arr(options[x.id]).map(o => '  ' + o.key + '. ' + o.zh).join('\n') || '  (没有候选,只有复审建议:' + (x.suggestion || '无') + ')')).join('\n'),
    script: ((arr(run.review.versions).find(v => v.key === 'd3')) || {}).text || ''
  }), '终审·补改退回找原因', o => Array.isArray(o.items));
  const dec = {};
  arr(out.items).forEach(it => { const id = String(it && it.id || '').toUpperCase(); if (items.some(x => x.id === id)) dec[id] = it; });
  const pick = {}, decisions = [];
  items.forEach(x => {
    const prev = usedKey(tried, x.id);
    const d = dec[x.id] || { action: 'keep' };
    let act = String(d.action || 'keep').toLowerCase(), k = prev;
    if (act === 'switch' && arr(options[x.id]).some(o => o.key === String(d.key || '').toUpperCase())) k = String(d.key).toUpperCase();
    else if (act === 'new' && String(d.zh || '').trim()) {
      const list = arr(options[x.id]);
      const zh = String(d.zh).trim();
      const same = list.find(o => o.zh === zh);
      k = same ? same.key : String.fromCharCode(65 + list.length);
      if (!same) options[x.id] = list.concat([{ key: k, zh, why: String(d.why || '').trim(), recommended: false, auto: true }]);
    } else if (act === 'skip') k = 'skip';
    else act = 'keep';
    pick[x.id] = k;
    decisions.push({ id: x.id, action: act, from: prev, to: k, why: String(d.why || '').trim() });
  });
  const diagnosis = { at: new Date().toISOString(), cause: String(out.cause || '').trim(), retry: out.retry !== false, items: decisions };
  const ids = items.filter(x => pick[x.id] !== 'skip').map(x => x.id);
  const same = items.every(x => pick[x.id] === usedKey(tried, x.id));
  const repeat = arr(last.reverted).some(t => items.every(x => pick[x.id] === usedKey(t, x.id)));
  const stop = !diagnosis.retry ? 'AI 判断不值得再试' : !ids.length ? 'AI 决定所有问题都先不改' : (same || repeat) ? 'AI 给出的改法和之前试过、掉了分的组合一样' : '';
  if (stop) { diagnosis.retry = false; diagnosis.stop = stop; }
  return { diagnosis, options, pick, body: { ids, choices: Object.fromEntries(ids.filter(id => pick[id] !== 'rv').map(id => [id, pick[id]])), note: tried.note || '' } };
}

async function runFinalPatch(runId, body) {
  const cfg = pl().loadConfig();
  let { run, asset } = loadRunAsset(runId);
  if (!cfg || !cfg.api_key) throw Object.assign(new Error('未配置 API Key'), { status: 400 });
  const start = currentScript(run);
  const vByKey = Object.fromEntries(arr(run.review.versions).map(v => [v.key, v]));
  const d2 = vByKey.d2, d3 = vByKey.d3;
  const fin = run.review.final;
  const tr = loadTrack(fin.track);
  const dims = arr(fin.dims).length ? fin.dims : finalDims(tr);
  const last = arr(fin.rechecks).slice(-1)[0] || {};
  const auto = Number(body.auto) || 0;
  const t0 = Date.now();
  const { patch_error, patch_failed_at, patch_reverted, ...prevStep } = (run.steps || {}).final_review || {};
  run.steps = { ...(run.steps || {}), final_review: { ...prevStep, status: 'running', stage: auto ? 'AI 找补改掉分的原因(自动重试第 ' + auto + ' 次)' : '补改', patch: true, started_at: new Date().toISOString() } };
  store.saveRun(run);
  let diagnosis = null;
  try {
    const common = finalCommon(run, tr, dims);
    // 自动重试:先让 AI 找出上次哪些改动改坏了、重新定改法;它判断不值得再试就停下,终稿不动
    if (auto) {
      const dg = await diagnosePatch(run, cfg, common, dims, last);
      diagnosis = { ...dg.diagnosis, round: auto };
      const fresh = store.getRun(runId) || run;
      const rcF = arr(fresh.review.final.rechecks).slice(-1)[0];
      const rv = rcF && arr(rcF.reverted).slice(-1)[0];
      if (rv) rv.next = diagnosis;
      if (rcF) { rcF.options = dg.options; if (!rcF.options_for) rcF.options_for = openKey(rcF.open); rcF.auto_pick = dg.pick; }
      last.options = dg.options;
      if (!diagnosis.retry) {
        fresh.steps = { ...(fresh.steps || {}), final_review: { ...prevStep, ...(patch_reverted ? { patch_reverted: { ...patch_reverted, stopped: true } } : {}) } };
        if (run.attempts) fresh.attempts = run.attempts;
        store.saveRun(fresh);
        return { ok: true, reverted: true, stop: true };
      }
      if (run.attempts) fresh.attempts = run.attempts;
      store.saveRun(fresh);
      body = { ...dg.body, ...(body.autoRound ? { autoRound: body.autoRound } : {}) };
      setFinalStage(runId, '补改(自动重试第 ' + auto + ' 次)');
    }
    const picked = arr(last.open).filter(x => arr(body.ids).includes(x.id));
    // 人选的解决方式:{ R01: 'B' };选了就照这个方式改,不再看复审的原建议
    const chosen = x => { const k = (body.choices || {})[x.id]; return k ? arr((last.options || {})[x.id]).find(o => o.key === k) : null; };
    const howTo = x => { const o = chosen(x); return o ? '\n  人选的改法(' + o.key + '):' + o.zh : x.suggestion ? '\n  复审建议:' + x.suggestion : ''; };
    const note = String(body.note || '').trim().slice(0, 3000);
    // 勾选的「结构」问题整章重写,其余问题照常逐句补改
    const structPicked = picked.filter(x => x.level === '结构');
    const sentPicked = picked.filter(x => x.level !== '结构');
    const selected = sentPicked.length ? sentPicked.map(x => '- [' + x.id + '][' + x.chapter + '][' + x.level + '] ' + x.problem + howTo(x)).join('\n') : '(没有勾选复审问题,只按下面人的决定改)';
    const limit = growthLimit(run, d3.text);
    let edits = [], a = { next: d3.text, edits: [] };
    if (sentPicked.length || note) {
      const r = await callLong(run, cfg, an().fillVars(readPrompt('final_patch.md'), { ...common, selected, note: note || '(没有补充意见)', script: d3.text }), '终审·补改');
      edits = parseEdits(r.content);
      if (r.truncated && !/^===\s*END\s*===/m.test(r.content)) edits = edits.slice(0, -1);
      a = await applyWithRepair(run, cfg, d3.text, edits.map(e => ({ ...e, round: '补改' })), '终审·补改', limit);
    }
    const okNew = a.edits.filter(e => e.ok);
    let structural = null;
    if (structPicked.length) {
      setFinalStage(runId, '整章重写');
      const sr = await structuralRewrite(run, asset, cfg, a.next, structPicked.map(x => { const o = chosen(x); return o ? { ...x, suggestion: '按人选的方式重写:' + o.zh } : x; }), limit, '终审·补改');
      structural = sr.done;
      a.next = sr.text;
    }
    const structOk = arr(structural).filter(x => x.ok);
    if (!okNew.length && !structOk.length) throw new Error(structural && structural.length ? '整章重写没有成功:' + structural.map(x => x.chapter + ' ' + x.error).join(';') : edits.length ? '补改的 ' + edits.length + ' 处都没对上原句,稿子没有变化,可以再点一次' : 'AI 没有给出补改,稿子没有变化');
    const pure = await purifyText(run, cfg, a.next, '终审·补改');
    const text = pure.text;
    // 复审(只出报告)
    setFinalStage(runId, '补改后复审');
    const patchNote = note ? '【人的决定(以此为准:与写前分析账本冲突的旧数字,按人的决定改过的不算错)】\n' + note + '\n\n' : '';
    const recheckPrompt = an().fillVars(readPrompt('final_recheck.md'), {
      ...common, ...thesisVars(run), patch_note: patchNote, prev_round: prevRoundText(last, dims),
      scores_before: dims.map(d => d + ': ' + ((fin.scores_before || {})[d] != null ? fin.scores_before[d] : '—')).join('\n'),
      edits_done: editsText(okNew) + (structOk.length ? '\n整章重写了:' + structOk.map(x => x.chapter).join('、') + '(解决复审指出的结构问题)' : ''),
      edits_instruction: '这是最后一轮复审,只出报告,不要输出修改。',
      listen_findings: listenFindings(run, text),
      script: text
    });
    // 复审一个分数都没读到就再跑一次;还是没有就不采用这次补改(实测 run_1f67a92553fd 第 4 轮补改后复审没分数,没退回保护,无分数的稿子被存成终稿)
    let s3, tb, scores, verdict;
    for (let k = 0; k < 2; k++) {
      if (k) setFinalStage(runId, '补改后复审(没读到分数,重跑)');
      const r3 = await callLong(run, cfg, recheckPrompt, '终审·补改后复审' + (k ? '重跑' : ''));
      s3 = splitReport(r3.content);
      ({ tb, scores, verdict } = await ensureRecheckBlocks(run, cfg, common, dims, s3, '终审·补改后复审'));
      if (avgScore(scores, dims) != null) break;
      dumpNoScore(run, r3.content);
    }
    if (avgScore(scores, dims) == null) throw new Error('补改后复审两次都没给出分数,这次补改没有采用,终稿没换;可以再点一次');
    // 修订痕迹仍以二稿为底:把这次补改并进终稿原有的修改里
    const oldEdits = arr(d3.edits);
    const merged = mergeRounds(d2.text, d3.text, oldEdits.filter(e => e.ok), a.edits);
    const failed = oldEdits.filter(e => !e.ok).concat(a.edits.filter(e => !e.ok));
    const allEdits = merged.map((e, i) => ({ ...e, n: i + 1 })).concat(failed.map((e, i) => ({ ...e, ok: false, n: merged.length + i + 1 })));
    const fresh = store.getRun(runId) || run;
    if (currentScript(fresh) !== start) throw new Error('补改期间稿子被改过,结果没有保存,请重试');
    // 补改后复审的平均分比补改前低 REVERT_DROP 以上:这次补改把稿子改坏了,不换终稿,只记下这次尝试(实测 run_77b4651152ef 第 3 轮 5.4→4.6 仍被存成终稿)
    const before = avgScore(last.scores, dims), after = avgScore(scores, dims);
    if (before != null && after != null && before - after >= (body.claim ? CLAIM_REVERT_DROP : REVERT_DROP)) {
      const rcF = arr(fresh.review.final.rechecks).slice(-1)[0];
      const tried = { at: new Date().toISOString(), picked: picked.map(x => x.id), choices: Object.fromEntries(picked.filter(chosen).map(x => [x.id, chosen(x).key])), note, report: s3.report, scores, verdict, open: markMissingQuotes(parseOpen(tb.OPEN), text, (run.audience || {}).target_language), edits: okNew.map(e => ({ chapter: e.chapter, category: e.category || '', old: e.old, new: e.new, reason: e.reason })), ...(structural ? { structural } : {}), ...(auto ? { auto, diagnosis } : {}), ...(body.autoRound ? { auto_round: body.autoRound } : {}), before: Math.round(before * 10) / 10, after: Math.round(after * 10) / 10 };
      if (rcF) rcF.reverted = arr(rcF.reverted).concat([tried]);
      fresh.steps = { ...(fresh.steps || {}), final_review: { ...prevStep, patch_reverted: { at: tried.at, before: tried.before, after: tried.after } } };
      if (run.attempts) fresh.attempts = run.attempts;
      store.saveRun(fresh);
      return { ok: true, reverted: true };
    }
    setForeign(fresh, pure, '终审·补改');
    const changed = [];
    scriptChapters(text).forEach(c => { const b = scriptChapters(d2.text).find(x => x.id === c.id); if (b && b.text !== c.text) changed.push(c.id); });
    const issues = allEdits.filter(e => e.ok).map(e => ({ chapter: e.chapter || '全篇', category: e.category || '', problem: e.reason || '', quote: e.old, fix: e.new || '(删除)', edit: e.n }));
    fresh.review.versions = arr(fresh.review.versions).filter(v => v.key === 'd1' || v.key === 'd2').concat([{ ...d3, at: new Date().toISOString(), text, issues, changed, edits: allEdits }]);
    fresh.review.deai = null;
    if (fresh.steps) delete fresh.steps.deai;
    const f2 = fresh.review.final;
    f2.rechecks = arr(f2.rechecks).concat([{ round: arr(f2.rechecks).length + 1, patch: true, picked: picked.map(x => x.id), choices: Object.fromEntries(picked.filter(chosen).map(x => [x.id, chosen(x).key])), note, report: s3.report, scores, verdict, open: markMissingQuotes(parseOpen(tb.OPEN), text, (run.audience || {}).target_language), thesis: parseThesis(tb.THESIS), craft: parseCraft(tb.CRAFT), edits: okNew.length, ...(auto ? { auto, diagnosis, reverted_before: arr(last.reverted).length } : {}), ...(body.autoRound ? { auto_round: body.autoRound } : {}),
      ...(structural ? { structural } : {}), ...(verdict === '未达标' && stalledBy(last.scores, scores, dims) ? { stalled: true } : {}) }]);
    f2.scores_after = scores;
    f2.verdict = verdict;
    if (text !== start) writeScript(fresh, text);
    fresh.steps = { ...(fresh.steps || {}), final_review: { ...prevStep, status: 'done', patch: true, secs: Math.round((Date.now() - t0) / 100) / 10, finished_at: new Date().toISOString(),
      issues: issues.length, changed: changed.length, edits: allEdits.filter(e => e.ok).length, edits_failed: allEdits.filter(e => !e.ok).length, verdict } };
    if (run.attempts) fresh.attempts = run.attempts;
    store.saveRun(fresh);
    return { ok: true, edits: okNew.length };
  } catch (e) {
    const fresh = store.getRun(runId) || run;
    // 补改失败不影响原终稿:状态回到上一次终审的结果,只记下这次的错误
    fresh.steps = { ...(fresh.steps || {}), final_review: { ...prevStep, ...(auto && patch_reverted ? { patch_reverted } : {}), patch_error: e.message, patch_failed_at: new Date().toISOString() } };
    store.saveRun(fresh);
    throw e;
  }
}

// 最后一轮复审没读到分数(旧版本没拦住,无分数的稿子已经是终稿):只对现在的终稿重新复审一次,补上分数、结论和遗留问题
async function rerunLastRecheck(runId) {
  const cfg = pl().loadConfig();
  const { run } = loadRunAsset(runId);
  const fin = run.review.final;
  const tr = loadTrack(fin.track);
  const dims = arr(fin.dims).length ? fin.dims : finalDims(tr);
  const rcs = arr(fin.rechecks);
  const prev = rcs.slice(-2)[0] === rcs[rcs.length - 1] ? null : rcs[rcs.length - 2];
  const lastRc = rcs[rcs.length - 1];
  const text = (arr(run.review.versions).find(v => v.key === 'd3') || {}).text || currentScript(run);
  const { patch_error, patch_failed_at, patch_reverted, ...prevStep } = (run.steps || {}).final_review || {};
  run.steps = { ...(run.steps || {}), final_review: { ...prevStep, status: 'running', stage: '重新复审', patch: true, started_at: new Date().toISOString() } };
  store.saveRun(run);
  try {
    const common = finalCommon(run, tr, dims);
    const prompt = an().fillVars(readPrompt('final_recheck.md'), {
      ...common, ...thesisVars(run),
      patch_note: lastRc.note ? '【人的决定(以此为准:与写前分析账本冲突的旧数字,按人的决定改过的不算错)】\n' + lastRc.note + '\n\n' : '',
      prev_round: prevRoundText(prev, dims),
      scores_before: dims.map(d => d + ': ' + ((fin.scores_before || {})[d] != null ? fin.scores_before[d] : '—')).join('\n'),
      edits_done: '(上一次补改的 ' + (lastRc.edits || 0) + ' 处修改已经在稿子里;这次只重新复审,不改稿)',
      edits_instruction: '这是最后一轮复审,只出报告,不要输出修改。',
      listen_findings: listenFindings(run, text), script: text
    });
    let s3, tb, scores, verdict;
    for (let k = 0; k < 2; k++) {
      const r3 = await callLong(run, cfg, prompt, '终审·重新复审');
      s3 = splitReport(r3.content);
      ({ tb, scores, verdict } = await ensureRecheckBlocks(run, cfg, common, dims, s3, '终审·重新复审'));
      if (avgScore(scores, dims) != null) break;
      dumpNoScore(run, r3.content);
    }
    if (avgScore(scores, dims) == null) throw new Error('重新复审两次都没给出分数,可以再点一次');
    const fresh = store.getRun(runId) || run;
    const rcF = arr(fresh.review.final.rechecks).slice(-1)[0];
    Object.assign(rcF, { report: s3.report, scores, verdict, open: markMissingQuotes(parseOpen(tb.OPEN), text, (run.audience || {}).target_language), thesis: parseThesis(tb.THESIS), craft: parseCraft(tb.CRAFT), rechecked_at: new Date().toISOString() });
    delete rcF.options; delete rcF.options_for; delete rcF.auto_pick;
    fresh.review.final.scores_after = scores;
    fresh.review.final.verdict = verdict;
    fresh.steps = { ...(fresh.steps || {}), final_review: { ...prevStep, status: 'done', verdict, finished_at: new Date().toISOString() } };
    if (run.attempts) fresh.attempts = run.attempts;
    store.saveRun(fresh);
  } catch (e) {
    const fresh = store.getRun(runId) || run;
    fresh.steps = { ...(fresh.steps || {}), final_review: { ...prevStep, patch_error: e.message, patch_failed_at: new Date().toISOString() } };
    store.saveRun(fresh);
    throw e;
  }
}

function startFinalPatch(runId, body) {
  const run = store.getRun(runId);
  if (!run) throw Object.assign(new Error('任务不存在'), { status: 404 });
  const st = run.steps || {};
  // 只出解决方案(不改稿):开头单独审、中文对照这些在跑不碍事,只有终审/补改在跑时不行(它们会换掉复审问题)
  if (body && body.options) {
    const fin0 = (run.review || {}).final || {};
    const last0 = arr(fin0.rechecks).slice(-1)[0];
    if ((st.final_options || {}).status === 'running') throw Object.assign(new Error('解决方案正在生成'), { status: 409 });
    if ((st.final_review || {}).status === 'running' || ['终审', '补改'].includes(passLabel(runId))) throw Object.assign(new Error(busyMsg(runId, '出方案')), { status: 409 });
    if (!last0 || !arr(last0.open).length) throw Object.assign(new Error('复审没有遗留问题'), { status: 400 });
    runOpenOptions(runId).catch(() => {});
    return { ok: true };
  }
  const busyStep = (st.final_review || {}).status === 'running' ? '终审' : (st.deai || {}).status === 'running' ? '去AI感' : (st.final_open || {}).status === 'running' ? '整理复审问题' : '';
  if (passBusy(runId) || busyStep) throw Object.assign(new Error('「' + (passLabel(runId) || busyStep) + '」正在跑,等它跑完再补改'), { status: 409 });
  const vs = arr((run.review || {}).versions);
  const d3 = vs.find(v => v.key === 'd3'), d4 = vs.find(v => v.key === 'd4');
  const fin = (run.review || {}).final;
  if (!d3 || !fin || !vs.some(v => v.key === 'd2')) throw Object.assign(new Error('还没有终稿,先跑终审'), { status: 400 });
  const cur = currentScript(run);
  if (cur !== d3.text && !(d4 && d4.text === cur)) throw Object.assign(new Error('终稿之后稿子被改过,不能按复审补改;请重新终审'), { status: 400 });
  const last = arr(fin.rechecks).slice(-1)[0];
  if (!last) throw Object.assign(new Error('这次终审没有复审报告'), { status: 400 });
  if (body && body.extract) {
    (async () => { try { await extractOpen(runId); await runOpenOptions(runId); } catch (e) {} await translateRun(runId); })();
    return { ok: true };
  }
  if (body && body.recheck) {
    if (Object.values(last.scores || {}).some(v => typeof v === 'number')) throw Object.assign(new Error('最后一轮复审有分数,不用重新复审'), { status: 400 });
    passRunning.set(runId, '补改');
    (async () => {
      let ok = false;
      try { await rerunLastRecheck(runId); ok = true; } catch (e) {} finally { passRunning.delete(runId); }
      if (ok) { await claimAfterPatch(runId); try { await runOpenOptions(runId); } catch (e) {} await autoOpeningFix(runId); await refreshClaimIfStale(runId); await refreshOpeningIfStale(runId); }
      await translateRun(runId);
    })();
    return { ok: true };
  }
  // 人点「让 AI 再自动试」:不用选问题,直接从找原因开始
  const autoOnly = !!(body && body.auto);
  if (autoOnly && !arr(last.reverted).length) throw Object.assign(new Error('没有被退回的补改,不用自动重试'), { status: 400 });
  if (!autoOnly && !arr(body.ids).length && !String(body.note || '').trim()) throw Object.assign(new Error('至少勾一个问题,或写下你的决定'), { status: 400 });
  passRunning.set(runId, '补改');
  (async () => {
    let ok = false;
    try {
      // 补改掉分被退回:自动找原因、换改法再试,最多 AUTO_RETRY_MAX 次;AI 判断不值得再试就停
      let res = autoOnly ? { reverted: true } : await runFinalPatch(runId, body);
      for (let n = 1; res && res.reverted && !res.stop && n <= AUTO_RETRY_MAX; n++) res = await runFinalPatch(runId, { auto: n });
      ok = !!res && !res.reverted;
    } catch (e) {} finally { passRunning.delete(runId); }
    if (ok) { await claimAfterPatch(runId); try { await runOpenOptions(runId); } catch (e) {} await autoOpeningFix(runId); await refreshClaimIfStale(runId); await refreshOpeningIfStale(runId); }
    await translateRun(runId);
  })();
  return { ok: true };
}

// ---------- 去AI感(终稿之后):诊断并给每处 3~5 种改法 → 人勾选、挑改法 → 应用 ----------
// 第一步只出诊断和候选改法,不动稿子;人选好后第二步按选择替换,结果存成 d4「去AI感稿」并写回 V1。
// 重跑:去AI感之后没人动过稿子,就从终稿重新来。
function setDeaiStage(runId, stage) {
  const fresh = store.getRun(runId);
  if (!fresh) return;
  fresh.steps = { ...(fresh.steps || {}), deai: { ...((fresh.steps || {}).deai || {}), status: 'running', stage } };
  store.saveRun(fresh);
}

// ===ITEM=== 块:章节/类型/优先级/原句/原句中文/问题/方案N/方案N中文/方案N说明
const DEAI_FIELD_RE = /^\s*[-*]?\s*\**\s*(章节|位置|类型|类别|优先级|严重程度|原句|原文|原句中文|问题|原因|推荐理由|推荐|方案\s*\d+\s*(?:中文|翻译|说明|思路)?)\s*\**\s*[:：]\s*(.*)$/;
function parseDeaiItems(text) {
  // 模型常把分隔符连写在一行(===ITEMS======ITEM===)或加粗,先拆成每个分隔符单独一行
  const c = String(text || '').replace(/[*`]*(===\s*[A-Za-z]+\s*===)[*`]*/g, '\n$1\n').replace(/\n{3,}/g, '\n\n');
  const cut = c.search(/^===\s*ITEMS\s*===\s*$/m);
  const report = (cut >= 0 ? c.slice(0, cut) : c.split(/^===\s*ITEM\s*===\s*$/m)[0]).trim();
  const parts = (cut >= 0 ? c.slice(cut) : c).split(/^===\s*ITEM\s*===\s*$/m).slice(1);
  const items = parts.map(part => {
    const f = {};
    let cur = null;
    part.split(/^===\s*END\s*===\s*$/m)[0].split('\n').forEach(line => {
      const m = line.match(DEAI_FIELD_RE);
      if (m) { cur = m[1].replace(/\s+/g, ''); f[cur] = m[2]; } else if (cur && line.trim()) f[cur] += '\n' + line;
    });
    Object.keys(f).forEach(k => { f[k] = f[k].trim(); });
    const options = [];
    for (let n = 1; n <= 8; n++) {
      const t = f['方案' + n];
      if (t == null) continue;
      const txt = unwrapQuote(t);
      options.push({ text: EDIT_DELETE.test(txt) ? '' : txt, zh: f['方案' + n + '中文'] || f['方案' + n + '翻译'] || '', note: f['方案' + n + '说明'] || f['方案' + n + '思路'] || '' });
    }
    return {
      chapter: (String(f['章节'] || f['位置'] || '').match(/CH\d+/i) || [''])[0].toUpperCase(),
      type: f['类型'] || f['类别'] || '', priority: (String(f['优先级'] || f['严重程度'] || '').match(/P[0-2]/i) || ['P1'])[0].toUpperCase(),
      ...(q => ({ old: q.old, ...(q.occ ? { occ: q.occ } : {}) }))(splitQuoteNote(unwrapQuote(f['原句'] || f['原文'] || ''))), old_zh: f['原句中文'] || '', problem: f['问题'] || f['原因'] || '', options,
      // 推荐:方案N(从 0 数);没写或越界就不标
      recommend: (n => n >= 1 && n <= options.length ? n - 1 : -1)(Number((String(f['推荐'] || '').match(/\d+/) || [0])[0])),
      recommend_reason: f['推荐理由'] || ''
    };
  }).filter(x => x.old && x.options.length).map((x, i) => ({ ...x, id: 'D' + String(i + 1).padStart(2, '0') }));
  return { report, items };
}

// 旧结果解析失败(items 为空但报告里有 ===ITEM===)时,按新规则重新解析
function deaiItemsOf(d) {
  if (!d) return [];
  if (arr(d.items).length || !/===\s*ITEM/.test(d.diagnosis || '')) return arr(d.items);
  return parseDeaiItems(d.diagnosis).items;
}
function deaiReportOf(d) {
  return d && !arr(d.items).length && /===\s*ITEM/.test(d.diagnosis || '') ? parseDeaiItems(d.diagnosis).report : (d || {}).diagnosis || '';
}

// 去AI感不动开头(人定的:开头单独审过、自动改过,去AI感再改容易把数字和点题改回去)。
// 开头 = 开头单独审的范围(按配音语速前 OPENING_SEC 秒),返回它在稿子里结束的位置
function openingEndPos(run, text) {
  const wpm = require('./narration').narrationWpm(run, null).wpm || 150;
  let at = 0;
  for (const l of checks.narrationLines(checks.extractFinalScript(text), wpm).filter(l => l.start < OPENING_SEC)) { const i = text.indexOf(l.text, at); if (i >= 0) at = i + l.text.length; }
  return at;
}
// 去AI感不动论点:论点核对挑出的论点句不改;每种改法里的数字要和原句一模一样(实测:去AI感把账本句改写,数字和加减方向跟着变)
const NUM_RE = /\d[\d,.]*/g;
const numsOf = t => (String(t || '').match(NUM_RE) || []).map(n => n.replace(/[,.]$/, '')).sort().join('|');
function deaiProtect(run, base) {
  const cc = (((run || {}).review || {}).final || {}).claim_check;
  return arr(cc && cc.protect).filter(q => locate(base, q));
}
function deaiGuardItems(run, base, items) {
  const prot = deaiProtect(run, base);
  let cutClaim = 0, cutOptions = 0;
  const out = [];
  for (const x of items) {
    const q = splitQuoteNote(x.old).old;
    if (prot.some(p => locate(p, q) || locate(q, p))) { cutClaim++; continue; }
    const want = numsOf(q);
    const options = x.options.filter(o => {
      if (!o.text) { // 删句:句子里的数字别处还有(重复句)才允许
        const nums = String(q).match(NUM_RE) || [];
        const rest = base.replace(q, '');
        return nums.every(n => rest.includes(n));
      }
      return numsOf(o.text) === want;
    });
    cutOptions += x.options.length - options.length;
    if (!options.length) continue;
    const rec = x.recommend >= 0 ? options.indexOf(x.options[x.recommend]) : -1;
    out.push({ ...x, options, recommend: rec });
  }
  return { items: out, cut_claim: cutClaim, cut_options: cutOptions };
}
// 页面上不列开头的句子(旧结果里可能有)
function deaiOpeningSplit(run, items) {
  try {
    const base = deaiBase(run), end = openingEndPos(run, base);
    const keep0 = items.filter(x => !deaiInOpening(base, end, x));
    const g = deaiGuardItems(run, base, keep0);
    return { keep: g.items, cut: items.length - keep0.length, cut_claim: g.cut_claim };
  } catch (e) { return { keep: items, cut: 0, cut_claim: 0 }; }
}
function deaiInOpening(text, end, x) {
  const q = splitQuoteNote(x.old);
  const h = locateNth(scriptChapters(text), x.chapter, q.old, x.occ || q.occ);
  if (!h) return false;
  const off = text.indexOf(h.ch.text);
  return off >= 0 && off + h.start < end;
}
// 旧的诊断结果:原句带着「(第二次出现)」这类备注时标成了找不到;去掉备注重新判断,并带出要改第几处
function deaiQuoteView(run, x) {
  const q = splitQuoteNote(x.old), occ = x.occ || q.occ;
  if (x.found !== false && !occ) return {};
  let found = x.found;
  try { if (found === false) found = !!locate(deaiBase(run), q.old); } catch (e) {}
  return { found, ...(occ ? { occ } : {}) };
}
function deaiBase(run) {
  const start = currentScript(run);
  const vByKey = Object.fromEntries(arr((run.review || {}).versions).map(v => [v.key, v]));
  if (!vByKey.d3) throw Object.assign(new Error('还没有终稿,先跑终审'), { status: 400 });
  return vByKey.d4 && vByKey.d4.text === start ? vByKey.d3.text : start;
}

async function runDeai(runId, trackKey) {
  const cfg = pl().loadConfig();
  let { run, asset } = loadRunAsset(runId);
  if (!cfg || !cfg.api_key) throw Object.assign(new Error('未配置 API Key'), { status: 400 });
  const start = currentScript(run);
  const base = deaiBase(run);
  const tr = loadTrack(lockedTrack(run) || (TRACK_KEYS.includes(trackKey) ? trackKey : ((run.review || {}).final || {}).track || autoTrack(run, asset)));
  const t0 = Date.now();
  run.steps = { ...(run.steps || {}), deai: { status: 'running', stage: '诊断并给改法', track: tr.key, started_at: new Date().toISOString() } };
  store.saveRun(run);
  try {
    const a = run.analysis || {};
    const aud = run.audience || {};
    const lang = aud.target_language || '';
    const vars = {
      target_language: lang, target_country: aud.target_country || '', title: ((a.title || {}).final_title) || run.topic,
      track_position: tr.position, track_audience: tr.audience, deai_protect: tr.deai_protect, deai_focus: tr.deai_focus,
      language_notes: /^Korean$/i.test(lang) ? '韩语里常见的是「그런데」「하지만」「문제는」「진짜 이유는」「결국」反复出现。' : '',
      opening: openingSlice({ ...run, script_v1: base }).lines.map(l => l.text).join('\n') || '(无)',
      protect: deaiProtect(run, base).map(q => '- ' + q).join('\n') || '(无)',
      script: base
    };
    const r = await callLong(run, cfg, an().fillVars(readPrompt('deai_diagnose.md'), vars), '去AI感·诊断');
    const parsed = parseDeaiItems(r.content);
    const report = parsed.report;
    if (r.truncated && parsed.items.length && !/^===\s*END\s*===/m.test(r.content)) parsed.items.pop();
    // AI 还是提了开头的句子:不列出来
    const openEnd = openingEndPos(run, base);
    const items = parsed.items.filter(x => !deaiInOpening(base, openEnd, x));
    const skippedOpening = parsed.items.length - items.length;
    // 论点句不改;改法动了数字的不要(删句只在数字别处还有时允许)
    const guarded = deaiGuardItems(run, base, items);
    items.length = 0; items.push(...guarded.items);
    // 原句在终稿里找不到的,标出来(应用时还会再让 AI 校正一次引号)
    const byCh = Object.fromEntries(scriptChapters(base).map(c => [c.id, c.text]));
    items.forEach(x => { const t = byCh[x.chapter]; x.found = !!(t && locate(t, x.old)) || Object.values(byCh).some(t2 => locate(t2, x.old)); });
    const fresh = store.getRun(runId) || run;
    if (currentScript(fresh) !== start) throw new Error('去AI感运行期间稿子被改过,结果没有保存,请重跑');
    fresh.review = fresh.review || {};
    // AI 给的中文直接记进翻译缓存,改完后修订说明里的原句/改成中文也能用上
    const zh = {};
    items.forEach(x => { if (x.old_zh) zh[hash(x.old)] = x.old_zh; x.options.forEach(o => { if (o.text && o.zh) zh[hash(o.text)] = o.zh; }); });
    fresh.review.zh = { ...(fresh.review.zh || {}), byHash: { ...((fresh.review.zh || {}).byHash || {}), ...zh } };
    fresh.review.deai = { at: new Date().toISOString(), track: tr.key, track_name: tr.name, diagnosis: report, items, base_hash: hash(base), truncated: !!r.truncated, applied: null, ...(skippedOpening ? { skipped_opening: skippedOpening } : {}), ...(guarded.cut_claim ? { skipped_claim: guarded.cut_claim } : {}), ...(guarded.cut_options ? { dropped_options: guarded.cut_options } : {}) };
    fresh.steps = { ...(fresh.steps || {}), deai: { status: 'done', stage: '等你选改法', track: tr.key, secs: Math.round((Date.now() - t0) / 100) / 10, finished_at: new Date().toISOString(), items: items.length } };
    if (run.attempts) fresh.attempts = run.attempts;
    store.saveRun(fresh);
    return { ok: true };
  } catch (e) {
    const fresh = store.getRun(runId) || run;
    fresh.steps = { ...(fresh.steps || {}), deai: { status: 'failed', error: e.message, track: tr.key } };
    store.saveRun(fresh);
    throw e;
  }
}

// picks: [{ id, text }],text 是人选中(或手改过)的改法,空字符串表示删掉这句
async function applyDeai(runId, picks) {
  const cfg = pl().loadConfig();
  let run = store.getRun(runId);
  const d = (run.review || {}).deai;
  const start = currentScript(run);
  const base = deaiBase(run);
  const t0 = Date.now();
  const byId = Object.fromEntries(deaiItemsOf(d).map(x => [x.id, x]));
  // 旧的诊断结果里可能有开头的句子:不改
  const openEnd = openingEndPos(run, base);
  // 论点句、AI 给的动了数字的改法不改(人自己写的照用)
  const guardedIds = new Map(deaiGuardItems(run, base, deaiItemsOf(d)).items.map(x => [x.id, x]));
  const aiChanged = (x, t) => x.options.some(o => (o.text || '') === t) && !(guardedIds.get(x.id) || { options: [] }).options.some(o => (o.text || '') === t);
  const chosen = arr(picks).filter(p => byId[p.id] && guardedIds.has(p.id) && !deaiInOpening(base, openEnd, byId[p.id]) && !aiChanged(byId[p.id], String(p.text || '').trim()));
  const edits = chosen.map(p => { const x = byId[p.id]; const q = splitQuoteNote(x.old); return { chapter: x.chapter, category: x.type, old: q.old, ...(x.occ || q.occ ? { occ: x.occ || q.occ } : {}), new: String(p.text || '').trim(), reason: x.problem, deai_id: x.id }; });
  run.steps = { ...(run.steps || {}), deai: { ...((run.steps || {}).deai || {}), status: 'running', stage: '按你的选择修改' } };
  store.saveRun(run);
  try {
    const applied = edits.length ? await applyWithRepair(run, cfg, base, edits, '去AI感·修改', growthLimit(run, base)) : { next: base, edits: [] };
    const pure = await purifyText(run, cfg, applied.next, '去AI感');
    applied.next = pure.text;
    const okN = applied.edits.filter(e => e.ok).length;
    const allEdits = applied.edits.filter(e => e.ok).concat(applied.edits.filter(e => !e.ok)).map((e, i) => ({ ...e, n: i + 1 }));
    const fresh = store.getRun(runId) || run;
    if (currentScript(fresh) !== start) throw new Error('修改期间稿子被改过,结果没有保存,请重试');
    setForeign(fresh, pure, '去AI感');
    fresh.review.versions = arr(fresh.review.versions).filter(v => v.key !== 'd4');
    if (allEdits.length) fresh.review.versions.push({ key: 'd4', label: '去AI感稿', at: new Date().toISOString(), text: applied.next, edits: allEdits, base_text: base, issues: [] });
    fresh.review.deai = { ...fresh.review.deai, applied: { at: new Date().toISOString(), picks: chosen, ok: okN, failed: allEdits.length - okN } };
    if (applied.next !== start) writeScript(fresh, applied.next);
    fresh.steps = { ...(fresh.steps || {}), deai: { ...((fresh.steps || {}).deai || {}), status: 'done', stage: '已修改', secs: Math.round((Date.now() - t0) / 100) / 10, finished_at: new Date().toISOString(), edits: okN } };
    if (run.attempts) fresh.attempts = run.attempts;
    store.saveRun(fresh);
    refreshOpeningIfStale(runId);
  } catch (e) {
    const fresh = store.getRun(runId) || run;
    fresh.steps = { ...(fresh.steps || {}), deai: { ...((fresh.steps || {}).deai || {}), status: 'failed', error: e.message } };
    store.saveRun(fresh);
    throw e;
  }
}

function deaiGuard(run) {
  if (!run) throw Object.assign(new Error('任务不存在'), { status: 404 });
  const st = run.steps || {};
  if ((st.deai || {}).status === 'running' || (st.final_review || {}).status === 'running') throw Object.assign(new Error('正在运行,请稍等'), { status: 400 });
  if (!arr((run.review || {}).versions).some(v => v.key === 'd3')) throw Object.assign(new Error('还没有终稿,先跑终审'), { status: 400 });
}

function startDeai(runId, body) {
  const run = store.getRun(runId);
  deaiGuard(run);
  if (body && body.apply) {
    const d = (run.review || {}).deai;
    if (!d || !deaiItemsOf(d).length) throw Object.assign(new Error('还没有去AI感建议,先生成'), { status: 400 });
    if (d.base_hash !== hash(deaiBase(run))) throw Object.assign(new Error('生成建议以后稿子改过,原句可能对不上,请重新生成建议'), { status: 400 });
    (async () => { try { await applyDeai(runId, body.picks); } catch (e) {} await refreshClaimIfStale(runId); await translateRun(runId); })();
    return { ok: true };
  }
  (async () => { try { await runDeai(runId, body && body.track); } catch (e) {} await translateRun(runId); })();
  return { ok: true };
}

// 初稿检查 → 二稿审稿报告 → 停下等人选;人选完再终审 → 翻译。某一遍失败不影响已有稿子,页面上可以单独重跑
// 并发守卫:同一任务同一时刻只许一个 pass 在跑(连点重跑/终审会并发烧 LLM 并竞争写 run 文件)。
// 用进程内集合而不是 run 文件里的 running 状态:进程重启后集合自然清空,崩溃留下的假 running 不会挡续跑
// 正在跑的审稿:任务 id → 现在在跑哪一步(给页面和 409 提示说清楚是什么在跑)
const passRunning = new Map();
function passBusy(runId) { return passRunning.has(runId); }
function passLabel(runId) { return passRunning.get(runId) || ''; }
const busyMsg = (runId, what) => '「' + (passLabel(runId) || '审稿') + '」正在跑,等它跑完再' + what;
const PASS_LABELS = { check: '初稿检查', audit: '二稿审稿报告', final: '终审', options: '出解决方案', claim: '论点核对', autopatch: '自动补改', openfix: '自动改开头', opening: '开头单独审' };
async function runPasses(runId, from) {
  if (passRunning.has(runId)) throw Object.assign(new Error(busyMsg(runId, '重跑')), { status: 409 });
  passRunning.set(runId, '审稿');
  try {
    // 二稿和终稿出来后各单独审一次开头;开头分析失败不挡后面的步骤
    const order = from === 'final' ? ['final', 'claim', 'options', 'autopatch', 'openfix', 'opening'] : from === 'audit' ? ['audit'] : ['check', 'opening', 'audit'];
    for (const k of order) {
      passRunning.set(runId, PASS_LABELS[k] || k);
      if (k === 'opening') { try { await runOpeningCard(runId); } catch (e) {} continue; }
      if (k === 'options') {
        // 平均不到 8 分:出好方案后接着自动补改,标签先说清楚,页面上提示不用点
        const r0 = store.getRun(runId);
        if (r0 && finalAvg(r0) != null && finalAvg(r0) < PUBLISH_AVG && !autoPatchStop(r0)) passRunning.set(runId, '出解决方案(出好后自动补改)');
        try { await runOpenOptions(runId); } catch (e) {}
        continue;
      }
      if (k === 'claim') { try { await claimCheckAndFix(runId); } catch (e) {} continue; }
      if (k === 'openfix') { await autoOpeningFixLocked(runId); await refreshClaimIfStale(runId); continue; }
      if (k === 'autopatch') { await autoPatchLocked(runId); continue; }
      try { if (k === 'audit') await runReverseAudit(runId); else if (k === 'final') await runFinal(runId); else await runPass(runId, k); } catch (e) { break; }
    }
  } finally { passRunning.delete(runId); }
  // 中文对照放在锁外:翻译可能要好几分钟,期间不该挡住换赛道重新终审(翻译保存前会重读任务,只合并译文)
  await translateRun(runId);
}

// ---------- 自动补改(终审之后):平均不到 PUBLISH_AVG,不等人点,按每个问题的推荐改法自动补改一轮 ----------
// 人的要求:终审第一次评分在 8 分以下,「按复审意见再改一轮」那里 AI 自己点。改法和人不动时页面默认选上的一样
// (AI 找原因后定的 > 引用原句找不到就不改 > ★推荐 > 第一个方案 > 复审建议)。掉分照常退回、找原因重试;
// 一次终审最多自动补改 AUTO_PATCH_MAX 轮,到 8 分、分数不涨、退回后 AI 判断不值得再试就停,剩下的交给人
const AUTO_PATCH_MAX = 2;
function autoPatchPick(rc, x) {
  const opts = arr((rc.options || {})[x.id]);
  const has = k => k === 'skip' || k === 'rv' || opts.some(o => o.key === k);
  const ap = (rc.auto_pick || {})[x.id];
  if (ap && has(ap)) return ap;
  if (x.not_found) return 'skip';
  const rec = opts.find(o => o.recommended) || opts[0];
  return rec ? rec.key : x.level === '待核实' ? 'skip' : 'rv';
}
// 不再自动补改的原因;空字符串 = 可以再改一轮
function autoPatchStop(run) {
  const fin = (run.review || {}).final;
  const rc = fin && arr(fin.rechecks).slice(-1)[0];
  if (!rc) return '没有复审结果';
  const avg = finalAvg(run);
  if (avg == null) return '复审没读到分数';
  if (avg >= PUBLISH_AVG) return '';
  if ((fin.auto_patches || 0) >= AUTO_PATCH_MAX) return '已经自动补改 ' + AUTO_PATCH_MAX + ' 轮';
  if (rc.stalled) return '上一轮分数没涨';
  if (!arr(rc.open).length) return '复审没有列出要改的问题';
  const vs = arr(run.review.versions);
  const d3 = vs.find(v => v.key === 'd3'), d4 = vs.find(v => v.key === 'd4');
  const cur = currentScript(run);
  if (!d3 || (cur !== d3.text && !(d4 && d4.text === cur))) return '终稿之后稿子被改过';
  return '';
}
// runPasses 里用:锁已经在自己手里,只换标签
async function autoPatchLocked(runId) {
  // 停下来的原因记在 final.auto_patch_stop,页面上告诉人为什么没接着改
  const stopWith = why => { const r = store.getRun(runId); if (!r || !(r.review || {}).final) return; r.review.final.auto_patch_stop = why; store.saveRun(r); };
  for (;;) {
    let run = store.getRun(runId);
    if (!run || !(run.review || {}).final) return;
    const avg = finalAvg(run);
    if (avg != null && avg >= PUBLISH_AVG) return run.review.final.auto_patches ? stopWith('') : undefined;
    // 复审没达标却没有现成的问题清单:先从报告里整理(和人点「从复审报告里整理」一样),每轮只整理一次
    const rc0 = arr(run.review.final.rechecks).slice(-1)[0];
    if (rc0 && !arr(rc0.open).length && rc0.verdict === '未达标' && !rc0.auto_extracted && avg != null) {
      rc0.auto_extracted = true;
      store.saveRun(run);
      passRunning.set(runId, '整理复审问题(之后自动补改)');
      try { await extractOpen(runId); } catch (e) {}
      continue;
    }
    const why = autoPatchStop(run);
    if (why) return stopWith(why);
    const fin = run.review.final;
    const n = (fin.auto_patches || 0) + 1;
    passRunning.set(runId, '自动补改第 ' + n + ' 轮');
    // 方案还没出或对不上现在的问题:先出方案;出不来就按复审建议改
    let rc = arr(fin.rechecks).slice(-1)[0];
    if (!rc.options || rc.options_for !== openKey(rc.open)) {
      try { await runOpenOptions(runId); } catch (e) {}
      run = store.getRun(runId);
      rc = arr(run.review.final.rechecks).slice(-1)[0];
    }
    const ids = [], choices = {};
    arr(rc.open).forEach(x => { const k = autoPatchPick(rc, x); if (k === 'skip') return; ids.push(x.id); if (k !== 'rv') choices[x.id] = k; });
    if (!ids.length) return stopWith('每个问题推荐的都是「不改」');
    run.review.final.auto_patches = n;
    store.saveRun(run);
    let res;
    try {
      res = await runFinalPatch(runId, { ids, choices, note: '', autoRound: n });
      for (let k = 1; res && res.reverted && !res.stop && k <= AUTO_RETRY_MAX; k++) res = await runFinalPatch(runId, { auto: k, autoRound: n });
    } catch (e) { return stopWith('第 ' + n + ' 轮补改没成功:' + e.message); }
    if (!res || res.reverted) return stopWith('第 ' + n + ' 轮补改把分数改低了,已退回,换改法重试也没涨');
    try { await claimCheckAndFix(runId); } catch (e) {}
    try { await runOpenOptions(runId); } catch (e) {}
  }
}

// ---------- 开头单独审(二稿出来后、终审后各生成一次) ----------
// 开头约 60 秒逐句列出(时间按配音语速推算)+ 中文 + 好在哪 + 可能掉人的地方 + 程序硬指标,给人单独审开头
const OPENING_SEC = 60;
function openingSlice(run) {
  const script = checks.extractFinalScript(currentScript(run));
  const wpm = require('./narration').narrationWpm(run, null).wpm || 150;
  const all = checks.narrationLines(script, wpm);
  const lines = all.filter(l => l.start < OPENING_SEC).map((l, i) => ({ n: i + 1, sec: Math.round(l.start), text: l.text, nums: l.nums }));
  const after = all.filter(l => l.start >= OPENING_SEC).slice(0, 6).map(l => l.text).join(' ');
  return { script, wpm, lines, after, hash: hash(lines.map(l => l.text).join('\n')) };
}
// 开头改过了(补改、单章重写、去AI感之后)就自动重审一次开头,让「开头单独审」一直对得上现在的稿子:
// 实测 run_1f67a92553fd 补改了两轮,开头卡片一直停在终审后那份「建议改」,人看不出开头到底改好没有
async function refreshOpeningIfStale(runId) {
  try {
    const run = store.getRun(runId);
    if (!run || !(run.review || {}).opening) return;
    if (((run.steps || {}).opening_card || {}).status === 'running') return;
    if (openingSlice(run).hash === run.review.opening.hash) return;
    await runOpeningCard(runId);
  } catch (e) { /* 开头分析失败不影响改稿结果 */ }
}

// ---------- 论点核对(终审之后):用稿子自己的数字检验开头的主张,对不上就按核对结果自动补改 ----------
// 实测 run_1f67a92553fd:终审 8.3 分,开头说「매출 올랐는데 업주 돈은 줄었다」,稿子自己的账算出大学街店每月多剩约 230 万;
// 账本把业主劳动 300 万加进收入(前文说要扣掉)。七维打分几轮都没挑出来,所以单独核对、单独拦。
const CLAIM_FIX_MAX = 2; // 一次终审里自动按核对结果补改的次数
function claimBlocking(cc) { return !!cc && (cc.verdict === '不成立' || arr(cc.issues).some(x => x.level === '关键' && !x.not_found)); }
function claimNote(cc) {
  const lines = ['论点核对发现的问题(按下面改;只改这些句子和由它们推出的结论,数字一律用稿子里已有的,不许编新数字;开头的说法要和稿子自己的账一致):'];
  if (cc.verdict === '不成立') lines.push('- 开头主张「' + cc.claim + '」被稿子自己的数字推翻:' + cc.calc + (cc.fix_claim ? '。改法:' + cc.fix_claim : ''));
  if (cc.fix_title) lines.push('- 核对建议把标题改成「' + cc.fix_title + '」,但人选择保留标题「' + (cc.title_for || '') + '」、改稿:稿子里和这个标题冲突的说法(身份、视角、主张)要改到和标题一致');
  arr(cc.issues).filter(x => !x.not_found).sort((a, b) => (a.level === '关键' ? 0 : 1) - (b.level === '关键' ? 0 : 1))
    .forEach(x => lines.push('- [' + (x.chapter || '全篇') + '][' + x.level + '] ' + (x.quote ? '「' + x.quote + '」' : '') + x.problem + (x.fix ? ' → 改成:' + x.fix : '')));
  return lines.join('\n').slice(0, 2900);
}
// 模型偶尔把结果包一层({"result":{...}})、verdict 写成「部分成立」「对不上」或干脆漏写(实测 llm_badjson_2026-10-30T11-17-30:
// 改完稿重新核对两次都「格式对但没有要的字段」,页面停在旧结果上,人不知道下一步)
function claimUnwrap(o) {
  if (!o || typeof o !== 'object') return o;
  if (o.verdict != null || o.claim != null || Array.isArray(o.issues)) return o;
  const inner = Object.values(o).find(v => v && typeof v === 'object' && !Array.isArray(v) && (v.verdict != null || v.claim != null));
  return inner || o;
}
function claimVerdict(o) {
  if (!o || typeof o !== 'object') return '';
  const v = String(o.verdict == null ? '' : o.verdict);
  if (/不成立|不一致|对不上|推翻|矛盾|^\s*(false|no)\s*$/i.test(v)) return '不成立';
  if (/没算|算不出|无法|不足|缺/.test(v)) return '稿子没算';
  if (/成立|一致|^\s*(true|yes)\s*$/i.test(v)) return '成立';
  if (v.trim()) return '';
  // 漏写 verdict:有「开头应该怎么说」就是不成立;只要有主张或问题清单,就当成立,关键问题照样会拦
  if (String(o.fix_claim || o.fix_title || '').trim()) return '不成立';
  return o.claim != null || Array.isArray(o.issues) ? '成立' : '';
}
async function runClaimCheck(runId) {
  const cfg = pl().loadConfig();
  if (!cfg || !cfg.api_key) throw Object.assign(new Error('未配置 API Key'), { status: 400 });
  const run = store.getRun(runId);
  if (!run || !(run.review || {}).final) throw Object.assign(new Error('还没跑终审'), { status: 400 });
  const text = currentScript(run);
  run.steps = { ...(run.steps || {}), claim_check: { status: 'running', started_at: new Date().toISOString() } };
  store.saveRun(run);
  try {
    const sl = openingSlice(run);
    const out0 = await an().callJson(run, cfg, an().fillVars(readPrompt('claim_check.md'), {
      target_language: (run.audience || {}).target_language || '', title: ((run.analysis || {}).title || {}).final_title || run.topic,
      opening: sl.lines.map(l => l.text).join('\n') || '(无)', script: checks.extractFinalScript(text)
    }), '论点核对', o => !!claimVerdict(claimUnwrap(o)));
    const out = claimUnwrap(out0);
    const verdict = claimVerdict(out);
    const issues = arr(out.issues).filter(x => x && x.problem).map((x, i) => {
      const quote = String(x.quote || '').trim();
      return { id: 'L' + (i + 1), chapter: (String(x.chapter || '').match(/CH\d+/i) || [''])[0].toUpperCase(), level: /关键/.test(x.level) ? '关键' : '次要',
        quote, problem: String(x.problem), fix: String(x.fix || ''), ...(quote && !locate(text, splitQuoteNote(quote).old) ? { not_found: true } : {}) };
    });
    const fresh = store.getRun(runId) || run;
    if (currentScript(fresh) !== text) throw new Error('核对期间稿子被改过,请重新核对');
    const prevFixes = ((fresh.review.final.claim_check || {}).fixes) || [];
    const curTitle = ((fresh.analysis || {}).title || {}).final_title || fresh.topic || '';
    const fixTitle = String(out.fix_title || '').trim();
    fresh.review.final.claim_check = { at: new Date().toISOString(), hash: hash(text), claim: String(out.claim || ''), verdict, calc: String(out.calc || ''), fix_claim: String(out.fix_claim || ''),
      ...(verdict === '不成立' && fixTitle && fixTitle !== curTitle ? { fix_title: fixTitle, fix_title_zh: String(out.fix_title_zh || '').trim(), title_for: curTitle } : {}),
      issues, protect: arr(out.protect).map(String).filter(q => q.trim() && locate(text, q)), fixes: prevFixes };
    fresh.steps = { ...(fresh.steps || {}), claim_check: { status: 'done', finished_at: new Date().toISOString(), verdict, blocking: claimBlocking(fresh.review.final.claim_check) } };
    if (run.attempts) fresh.attempts = run.attempts;
    store.saveRun(fresh);
    return fresh.review.final.claim_check;
  } catch (e) {
    const fresh = store.getRun(runId) || run;
    fresh.steps = { ...(fresh.steps || {}), claim_check: { status: 'failed', error: e.message, finished_at: new Date().toISOString() } };
    store.saveRun(fresh);
    throw e;
  }
}
function claimFresh(run) {
  const cc = (((run || {}).review || {}).final || {}).claim_check;
  return cc && cc.hash === hash(currentScript(run)) ? cc : null;
}
// 按核对结果补改一次(走补改 + 复审的流程;复审掉分 1 分以上才退回,论点对不上比 AI 打分要紧),再核对一遍
async function claimFixOnce(runId, cc, by) {
  const run = store.getRun(runId);
  const rec = { at: new Date().toISOString(), by, before: { verdict: cc.verdict, issues: arr(cc.issues).filter(x => x.level === '关键' && !x.not_found).length } };
  let res = null;
  passRunning.set(runId, '按论点核对改稿');
  try { res = await runFinalPatch(runId, { note: claimNote(cc), claim: true }); } catch (e) { rec.error = e.message; }
  if (res && res.reverted) rec.error = '改完复审掉分太多,没有采用';
  passRunning.set(runId, '论点核对');
  let after = null;
  try { after = res && !res.reverted ? await runClaimCheck(runId) : null; } catch (e) { rec.error = rec.error || ('改完重新核对失败:' + e.message); }
  if (after) rec.after = { verdict: after.verdict, issues: arr(after.issues).filter(x => x.level === '关键' && !x.not_found).length };
  const fresh = store.getRun(runId) || run;
  // 稿子到底改没改、复审几分:页面「已经试过」里要说清楚
  if (res && !res.reverted) { rec.patched = true; rec.edits = res.edits || 0; const a2 = finalAvg(fresh); if (a2 != null) rec.avg = Math.round(a2 * 10) / 10; }
  const c = fresh.review.final.claim_check;
  if (c) { c.fixes = arr(c.fixes).concat([rec]); store.saveRun(fresh); }
  return { ok: !!after && !claimBlocking(after), patched: !!res && !res.reverted };
}
// 终审、补改、重新复审之后(调用方已拿着锁):核对;对不上就自动补改,一次终审最多 CLAIM_FIX_MAX 次
async function claimCheckAndFix(runId) {
  passRunning.set(runId, '论点核对');
  let run = store.getRun(runId);
  let cc = claimFresh(run) || await runClaimCheck(runId);
  for (;;) {
    if (!claimBlocking(cc)) return;
    // 核对判断该改标题(全文改不动):不自动改稿,等人在页面上决定换不换标题
    if (cc.fix_title) return;
    run = store.getRun(runId);
    const fin = run.review.final;
    if ((fin.claim_fixes || 0) >= CLAIM_FIX_MAX) return;
    fin.claim_fixes = (fin.claim_fixes || 0) + 1;
    store.saveRun(run);
    await claimFixOnce(runId, cc, 'auto');
    cc = claimFresh(store.getRun(runId));
    if (!cc) cc = await runClaimCheck(runId);
  }
}
// 补改、重新复审成功之后(锁已经放开):占锁核对,对不上自动补改
async function claimAfterPatch(runId) {
  if (passBusy(runId)) return;
  try { await claimCheckAndFix(runId); } catch (e) {} finally { passRunning.delete(runId); }
}
// 人点「核对论点」/「按论点核对改稿」
function startClaimCheck(runId, body) {
  const run = store.getRun(runId);
  if (!run) throw Object.assign(new Error('任务不存在'), { status: 404 });
  if (!(run.review || {}).final) throw Object.assign(new Error('还没跑终审'), { status: 400 });
  const st = run.steps || {};
  const busyStep = (st.final_review || {}).status === 'running' ? '终审' : (st.deai || {}).status === 'running' ? '去AI感' : (st.claim_check || {}).status === 'running' ? '论点核对' : '';
  if (passBusy(runId) || busyStep) throw Object.assign(new Error('「' + (passLabel(runId) || busyStep) + '」正在跑,等它跑完再核对'), { status: 409 });
  // 采用核对给的新标题:标题和全文对不上、全文又改不动时(实测:标题说「며느리」,全文是入赘女婿视角),改标题再核对
  if (body && body.title) {
    const c0 = ((run.review || {}).final || {}).claim_check;
    if (!c0 || !c0.fix_title) throw Object.assign(new Error('核对结果里没有建议的新标题'), { status: 400 });
    run.analysis = run.analysis || {};
    run.analysis.title = run.analysis.title || {};
    const from = run.analysis.title.final_title || run.topic || '';
    run.analysis.title.final_title = c0.fix_title;
    run.review.final.title_changes = arr(run.review.final.title_changes).concat([{ at: new Date().toISOString(), from, to: c0.fix_title, by: 'claim' }]);
    store.saveRun(run);
    passRunning.set(runId, '论点核对(换了标题,重新核对)');
    (async () => {
      let patched = false;
      try {
        const c = await runClaimCheck(runId);
        // 换了标题还有别的关键问题(账算错等):接着按核对结果改一次稿
        if (claimBlocking(c) && !c.fix_title) patched = (await claimFixOnce(runId, c, 'manual')).patched;
      } catch (e) {} finally { passRunning.delete(runId); }
      if (patched) { try { await runOpenOptions(runId); } catch (e) {} }
      // 开头单独审要对照新标题重新审(开头句子没变,refreshOpeningIfStale 不会重跑)
      try { await runOpeningCard(runId); } catch (e) {}
      await translateRun(runId);
    })();
    return { ok: true };
  }
  const fix = !!(body && body.fix);
  const cc = claimFresh(run);
  // 核对结果是稿子改之前的(实测:点「按核对结果改稿」弹「先核对论点」):先重新核对,还对不上再改
  const old = ((run.review || {}).final || {}).claim_check;
  if (fix && cc && !claimBlocking(cc)) throw Object.assign(new Error('论点核对已经通过,不用改'), { status: 400 });
  if (fix && !cc && !old) throw Object.assign(new Error('先核对论点'), { status: 400 });
  passRunning.set(runId, fix ? '按论点核对改稿' : '论点核对');
  (async () => {
    let patched = false;
    try {
      let c = cc;
      if (fix && !c) { passRunning.set(runId, '论点核对(稿子改过,先重新核对)'); c = await runClaimCheck(runId); passRunning.set(runId, '按论点核对改稿'); }
      if (fix && claimBlocking(c)) patched = (await claimFixOnce(runId, c, 'manual')).patched;
      else if (!fix) await runClaimCheck(runId);
    } catch (e) {} finally { passRunning.delete(runId); }
    if (patched) { try { await runOpenOptions(runId); } catch (e) {} await autoOpeningFix(runId); await refreshOpeningIfStale(runId); await translateRun(runId); }
  })();
  return { ok: true };
}
// 稿子改过(自动改开头、去AI感)之后只重新核对,不再自动补改(补改可能又动到开头,来回改)
async function refreshClaimIfStale(runId) {
  try {
    const run = store.getRun(runId);
    if (!run || !((run.review || {}).final || {}).claim_check || claimFresh(run)) return;
    if (((run.steps || {}).claim_check || {}).status === 'running') return;
    await runClaimCheck(runId);
  } catch (e) { /* 核对失败记在 steps.claim_check */ }
}

// ---------- 自动改开头(终审之后):只改开头几句,让听感检查的开头两条(前 10 秒数字、前 8 秒点题)过关 ----------
// 人的标准:平均 8 分以上整篇就差不多了,不再一轮轮补改,只把开头改好(之后按真实发布数据再调)。
// 改完程序按配音语速重新数一遍,没过就把还差什么告诉 AI 再改,最多 OPEN_FIX_TRIES 次;数字密句不许变多,不许整体改长
const OPEN_FIX_TRIES = 3;
const openingIssues = lc => arr(lc && lc.issues).filter(i => /^前 \d+ 秒/.test(i));
function openingFixScore(lc) {
  const o = (lc && lc.opening) || {};
  return Math.max(0, (o.nums_10s || 0) - 1) * 2 + (arr(lc && lc.issues).some(i => /关键词/.test(i)) ? 4 : 0);
}
function listenOf(run, text) {
  return checks.listenCheck(checks.extractFinalScript(text), {
    wpm: require('./narration').narrationWpm(run, null).wpm, title: ((run.analysis || {}).title || {}).final_title || run.topic, lang: (run.audience || {}).target_language });
}
function finalAvg(run) {
  const f = (run.review || {}).final;
  const last = f && arr(f.rechecks).slice(-1)[0];
  if (!last) return null;
  return avgScore(fillScores(last.scores, last.report, arr(f.dims), 2), arr(f.dims).length ? f.dims : Object.keys(last.scores || {}));
}
function setOpenFixStage(runId, stage) {
  const fresh = store.getRun(runId);
  if (!fresh) return;
  fresh.steps = { ...(fresh.steps || {}), opening_fix: { ...((fresh.steps || {}).opening_fix || {}), status: 'running', stage } };
  store.saveRun(fresh);
}
async function runOpeningFix(runId) {
  const cfg = pl().loadConfig();
  if (!cfg || !cfg.api_key) throw Object.assign(new Error('未配置 API Key'), { status: 400 });
  const run = store.getRun(runId);
  const start = currentScript(run);
  const lc0 = listenOf(run, start);
  if (!openingIssues(lc0).length) return { ok: true, already: true };
  const t0 = Date.now();
  run.steps = { ...(run.steps || {}), opening_fix: { status: 'running', stage: '改开头', started_at: new Date().toISOString() } };
  store.saveRun(run);
  const vs = arr((run.review || {}).versions);
  // 改在现在的稿子上;现在的稿子是终稿(d3)或去AI感稿(d4)就把这几处并进它的修订痕迹
  const target = vs.find(v => v.key === 'd4' && v.text === start) || vs.find(v => v.key === 'd3' && v.text === start) || null;
  const base = target ? (target.key === 'd4' ? target.base_text : ((vs.find(v => v.key === 'd2') || {}).text)) : null;
  const lang = (run.audience || {}).target_language || '';
  const title = ((run.analysis || {}).title || {}).final_title || run.topic;
  const maxWords = scriptWords(start) + 8;
  const limit = { openingWords: 0, maxWords, wpm: growthLimit(run, start).wpm };
  let text = start, curLc = lc0, verEdits = target ? arr(target.edits).filter(e => e.ok) : [], applied = 0;
  const tries = [];
  try {
    for (let k = 1; k <= OPEN_FIX_TRIES && openingIssues(curLc).length; k++) {
      if (k > 1) setOpenFixStage(runId, '改开头(第 ' + k + ' 次,上次还差:' + openingIssues(curLc).map(i => i.replace(/\(.*?\)/g, '')).join(';') + ')');
      const sl = openingSlice({ ...run, script_v1: text });
      const prompt = an().fillVars(readPrompt('opening_fix.md'), {
        target_language: lang, wpm: String(sl.wpm), title,
        issues: curLc.issues.filter(i => /^前 \d+ 秒/.test(i)).map(i => '- ' + i).join('\n'),
        title_words: arr((curLc.opening || {}).title_words).map(w => w.word + (w.sec == null ? '(没出现)' : '(现在在 ' + checks.fmt(w.sec) + ')')).join('、') || '(无)',
        lines: sl.lines.filter(l => l.sec < 30).map(l => l.n + ' | ' + checks.fmt(l.sec) + ' | ' + l.nums + ' | ' + l.text).join('\n'),
        after: sl.lines.filter(l => l.sec >= 30).slice(0, 6).map(l => l.text).join(' ') || sl.after || '(无)',
        fact_check: factBrief((run.review || {}).factcheck),
        prev_tries: tries.length ? '## 之前几次没改成的原因(这次换个改法)\n' + tries.map(t => '- 第 ' + t.k + ' 次:' + t.note).join('\n') : ''
      });
      const r = await callLong(run, cfg, prompt, '自动改开头' + (k > 1 ? '·第 ' + k + ' 次' : ''));
      const edits = parseEdits(r.content).map(e => ({ ...e, chapter: e.chapter || 'CH01', category: '开头', round: '开头' }));
      const a = edits.length ? await applyWithRepair(run, cfg, text, edits, '自动改开头', limit) : { next: text, edits: [] };
      const ok = a.edits.filter(e => e.ok);
      if (!ok.length) { tries.push({ k, note: edits.length ? '改的 ' + edits.length + ' 处原句都没对上' : '没给出修改' }); continue; }
      const pure = await purifyText(run, cfg, a.next, '自动改开头');
      const lc = listenOf(run, pure.text);
      const worse = lc.dense.length > curLc.dense.length ? '数字密的句子从 ' + curLc.dense.length + ' 句变成 ' + lc.dense.length + ' 句' : '';
      if (!worse && openingFixScore(lc) < openingFixScore(curLc)) {
        if (target) verEdits = mergeRounds(base, text, verEdits, ok);
        text = pure.text; curLc = lc; applied += ok.length;
        tries.push({ k, ok: ok.length, note: openingIssues(lc).length ? '改了 ' + ok.length + ' 处,还差:' + openingIssues(lc).join(';') : '改了 ' + ok.length + ' 处,过关' });
      } else tries.push({ k, note: worse || '改了 ' + ok.length + ' 处,但开头没变好:' + openingIssues(lc).join(';') });
    }
    const passed = !openingIssues(curLc).length;
    const fresh = store.getRun(runId) || run;
    if (currentScript(fresh) !== start) throw new Error('改开头期间稿子被改过,结果没有保存,请重试');
    const rec = { at: new Date().toISOString(), passed, edits: applied, before: openingIssues(lc0), after: openingIssues(curLc), tries, on: target ? target.key : 'script' };
    if (text !== start) {
      if (target) {
        const tv = fresh.review.versions.find(v => v.key === target.key);
        const failed = arr(tv.edits).filter(e => !e.ok);
        tv.edits = verEdits.map((e, i) => ({ ...e, n: i + 1 })).concat(failed.map((e, i) => ({ ...e, n: verEdits.length + i + 1 })));
        tv.text = text;
        if (tv.key === 'd3') {
          tv.issues = tv.edits.filter(e => e.ok).map(e => ({ chapter: e.chapter || '全篇', category: e.category || '', problem: e.reason || '', quote: e.old, fix: e.new || '(删除)', edit: e.n }));
          tv.changed = scriptChapters(text).filter(c => { const b = scriptChapters(base).find(x => x.id === c.id); return b && b.text !== c.text; }).map(c => c.id);
        }
      }
      writeScript(fresh, text);
    }
    if (fresh.review.final) fresh.review.final.opening_fix = rec;
    fresh.steps = { ...(fresh.steps || {}), opening_fix: { status: passed ? 'done' : 'failed', secs: Math.round((Date.now() - t0) / 100) / 10, finished_at: rec.at, edits: applied, passed,
      ...(passed ? {} : { error: '试了 ' + tries.length + ' 次开头还没过:' + rec.after.join(';') + (applied ? '(改好的 ' + applied + ' 处已保存)' : '(稿子没变)') }) } };
    if (run.attempts) fresh.attempts = run.attempts;
    store.saveRun(fresh);
    return { ok: passed, edits: applied };
  } catch (e) {
    const fresh = store.getRun(runId) || run;
    fresh.steps = { ...(fresh.steps || {}), opening_fix: { status: 'failed', error: e.message, finished_at: new Date().toISOString() } };
    store.saveRun(fresh);
    throw e;
  }
}
// 终审/补改/重新复审成功后:平均到 PUBLISH_AVG 且开头没过,自动改开头(调用方已拿着锁或在锁外;这里自己占锁,锁被占就不跑)
async function autoOpeningFix(runId) {
  try {
    const run = store.getRun(runId);
    if (!run || passBusy(runId)) return;
    const avg = finalAvg(run);
    if (avg == null || avg < PUBLISH_AVG) return;
    if (!openingIssues(listenOf(run, currentScript(run))).length) return;
    passRunning.set(runId, '自动改开头');
    try { await runOpeningFix(runId); } finally { passRunning.delete(runId); }
  } catch (e) { /* 失败已记在 steps.opening_fix */ }
}
// runPasses 里用:锁已经在自己手里,只换标签
async function autoOpeningFixLocked(runId) {
  try {
    const run = store.getRun(runId);
    const avg = finalAvg(run);
    if (avg == null || avg < PUBLISH_AVG || !openingIssues(listenOf(run, currentScript(run))).length) return;
    passRunning.set(runId, '自动改开头');
    await runOpeningFix(runId);
  } catch (e) { /* 失败已记在 steps.opening_fix */ }
}
function startOpeningFix(runId) {
  const run = store.getRun(runId);
  if (!run) throw Object.assign(new Error('任务不存在'), { status: 404 });
  const st = run.steps || {};
  const busyStep = (st.final_review || {}).status === 'running' ? '终审' : (st.deai || {}).status === 'running' ? '去AI感' : (st.opening_fix || {}).status === 'running' ? '自动改开头' : '';
  if (passBusy(runId) || busyStep) throw Object.assign(new Error('「' + (passLabel(runId) || busyStep) + '」正在跑,等它跑完再改开头'), { status: 409 });
  if (!openingIssues(listenOf(run, currentScript(run))).length) throw Object.assign(new Error('开头已经通过听感检查,不用改'), { status: 400 });
  passRunning.set(runId, '自动改开头');
  (async () => {
    try { await runOpeningFix(runId); } catch (e) {} finally { passRunning.delete(runId); }
    await refreshClaimIfStale(runId);
    await refreshOpeningIfStale(runId);
    await translateRun(runId);
  })();
  return { ok: true };
}

async function runOpeningCard(runId) {
  const { run } = loadRunAsset(runId);
  const cfg = pl().loadConfig();
  if (!cfg || !cfg.api_key) throw Object.assign(new Error('未配置 API Key'), { status: 400 });
  const sl = openingSlice(run);
  if (!sl.lines.length) throw Object.assign(new Error('稿子还没写好'), { status: 400 });
  run.steps = { ...(run.steps || {}), opening_card: { status: 'running', started_at: new Date().toISOString() } };
  store.saveRun(run);
  const a = run.analysis || {};
  const title = ((a.title || {}).final_title) || run.topic;
  const lc = checks.listenCheck(sl.script, { wpm: sl.wpm, title, lang: (run.audience || {}).target_language });
  const o = (lc && lc.opening) || {};
  const hard = {
    nums_10s: o.nums_10s || 0,
    title_words: arr(o.title_words),
    dense: sl.lines.filter(l => l.nums > 2).map(l => l.n),
    issues: arr(lc && lc.issues).filter(i => /前 \d+ 秒/.test(i))
  };
  let bpHook = '';
  try { bpHook = JSON.stringify((JSON.parse(checks.stripFence((run.outputs || {}).step1 || '')) || {}).hook || {}); } catch (e) {}
  try {
    const out = await an().callJson(run, cfg, an().fillVars(readPrompt('opening_card.md'), {
      target_language: (run.audience || {}).target_language || '', wpm: String(sl.wpm), title,
      thesis: JSON.stringify(a.thesis_card || {}), hook: bpHook || '(无)',
      hard: '- 前 10 秒念了 ' + hard.nums_10s + ' 个数字\n- 标题关键词出现时间:' + (hard.title_words.map(w => w.word + (w.sec == null ? ' 没出现' : ' ' + w.sec + ' 秒')).join('、') || '(无)') +
        '\n- 一句超过 2 个数字的句子编号:' + (hard.dense.join('、') || '无'),
      lines: sl.lines.map(l => l.n + ' | ' + checks.fmt(l.sec) + ' | ' + l.text).join('\n'),
      after: sl.after || '(无)'
    }), '开头单独审', x => Array.isArray(x.lines) && x.lines.length);
    const zh = Object.fromEntries(arr(out.lines).map(x => [Number(x.n), String(x.zh || '')]));
    const fresh = store.getRun(runId) || run;
    fresh.review = fresh.review || {};
    fresh.review.opening = {
      at: new Date().toISOString(), hash: sl.hash, wpm: sl.wpm, title,
      lines: sl.lines.map(l => ({ ...l, zh: zh[l.n] || '' })),
      hook: String(out.hook || ''), title_conflict_sec: out.title_conflict_sec ?? null, first_payoff_sec: out.first_payoff_sec ?? null,
      strengths: arr(out.strengths).filter(Boolean).map(String), risks: arr(out.risks).filter(Boolean).map(String),
      verdict: hard.issues.length ? '建议改' : String(out.verdict || ''), hard
    };
    fresh.steps = { ...(fresh.steps || {}), opening_card: { status: 'done', finished_at: new Date().toISOString() } };
    if (run.attempts) fresh.attempts = run.attempts;
    store.saveRun(fresh);
  } catch (e) {
    const fresh = store.getRun(runId) || run;
    fresh.steps = { ...(fresh.steps || {}), opening_card: { status: 'failed', error: e.message } };
    store.saveRun(fresh);
    throw e;
  }
}
function startOpeningCard(runId) {
  const run = store.getRun(runId);
  if (!run) throw Object.assign(new Error('任务不存在'), { status: 404 });
  if (((run.steps || {}).opening_card || {}).status === 'running') throw Object.assign(new Error('开头分析正在跑'), { status: 409 });
  runOpeningCard(runId).catch(() => {});
  return { ok: true };
}
function openingView(run) {
  const o = (run.review || {}).opening;
  const st = (run.steps || {}).opening_card || null;
  if (!o) return st ? { status: st } : null;
  let stale = false;
  try { stale = openingSlice(run).hash !== o.hash; } catch (e) {}
  return { ...o, stale, status: st };
}

// ---------- 一键生成 ----------
async function runDraftFirst(runId) {
  await an().runAnalysis(runId);
  return finishDraftFirst(runId);
}

// 分析之后的部分:AI 先调整 → 自动确认 → 点火写初稿 → 初稿检查出二稿 → 二稿审稿报告 → 停下等人选 → 中文对照。
// 单独抽出是为了重启接管:分析已完成、调整被中断的任务从这里续跑,不重复调用分析(见 resumeDraftFirst)
async function finishDraftFirst(runId) {
  let run = store.getRun(runId);
  if (!run || run.status !== 'awaiting_review') return; // 分析失败或已取消
  // 写前分析判「换框架」:不调整、不写稿,停下来推荐框架等人选(人选「仍按现在的框架写」后从这里续跑)
  if (require('./reframe').shouldHold(run)) { await require('./reframe').suggest(runId); return; }
  try {
    await an().runAutoAdjust(runId, null, { search: true });
  } catch (e) {
    // AI 调整失败就停,不写稿:事实表还是写前分析里的「待查」占位,照写等于让模型自己编数字
    // (实测 run_7c467c8e0a71 调整断流失败后照写,终审时稿里 28 个事实没出处,联网核验 25 条里 19 条证据不足)
    run = store.getRun(runId) || run;
    if (run.cancel_requested || run.status === 'cancelled') return;
    run.steps = { ...(run.steps || {}), auto_adjust: { status: 'failed', error: e.message } };
    run.status = 'failed';
    run.error = 'AI 调整没成功,事实表还没查,没有开始写稿(' + e.message + ')。点「重试」从 AI 调整接着跑,不用重做写前分析。';
    store.saveRun(run);
    return;
  }
  run = store.getRun(runId);
  // 取消接口对 awaiting_review 是直接落 cancelled(不打 cancel_requested 标记):两种痕迹都要查,
  // 否则用户在 AI 调整期间点了取消,这里会把已取消的任务重新写成 queued 并点火写稿
  if (!run || run.cancel_requested || run.status === 'cancelled') {
    if (run && run.status !== 'cancelled') { run.status = 'cancelled'; store.saveRun(run); }
    return;
  }
  run.analysis_confirmed = true;
  run.analysis_auto_confirmed = true;
  run.analysis_confirmed_at = new Date().toISOString();
  run.status = 'queued';
  store.saveRun(run);
  await pl().runGeneration(runId);
  run = store.getRun(runId);
  if (run && run.status === 'done') await runPasses(runId);
}

// 续跑(重试 / 重启接管):分析没跑完就从头跑一键生成;分析跑完但调整被中断,从调整续跑;已经在写稿就接着写,写完补二稿、审稿报告和翻译
async function resumeDraftFirst(runId) {
  const run = store.getRun(runId);
  if (!run) return;
  if (!run.analysis_confirmed) {
    // AI 调整失败停下的任务(failed + 分析还在):重试从调整接着跑
    if (run.status === 'failed' && run.analysis && (run.steps || {}).auto_adjust && run.steps.auto_adjust.status === 'failed') {
      run.status = 'awaiting_review';
      delete run.error;
      store.saveRun(run);
    }
    if (run.status === 'awaiting_review' && run.analysis) return finishDraftFirst(runId);
    return runDraftFirst(runId);
  }
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
  const chs = scriptChapters(currentScript(run));
  // chapter 为 '*':一键全部通过 / 全部取消
  const ids = chId === '*' ? chs.map(c => c.id) : [chId];
  if (!ids.length || !ids.every(id => chs.some(c => c.id === id))) throw Object.assign(new Error('找不到章节 ' + chId), { status: 400 });
  ids.forEach(id => { chapterState(run, id).status = status === '通过' ? '通过' : '待审'; });
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
// 单章重写的提示词;run 的当前稿就是要改的稿(终审整章重写时传入内存里的稿)
function rewritePrompt(run, asset, chId, note, compress) {
  const view = buildView(run, asset);
  const i = view.rows.findIndex(r => r.id === chId);
  if (i < 0) throw Object.assign(new Error('找不到章节 ' + chId), { status: 400 });
  const row = view.rows[i];
  const bp = blueprintOf(run).find(c => c.id === chId) || {};
  const a = run.analysis || {};
  return an().fillVars(readPrompt('rewrite_segment.md'), {
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
}

async function rewriteChapter(runId, chId, note, opts) {
  const { run, asset } = loadRunAsset(runId);
  assertDone(run);
  const cfg = pl().loadConfig();
  if (!cfg || !cfg.api_key) throw Object.assign(new Error('未配置 API Key'), { status: 400 });
  if (!String(note || '').trim()) throw Object.assign(new Error('意见为空'), { status: 400 });
  const compress = !!(opts && opts.compress);
  const prompt = rewritePrompt(run, asset, chId, note, compress);
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
  refreshOpeningIfStale(runId);
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

module.exports = { startClaimCheck, runClaimCheck, claimBlocking, startOpeningFix, runOpeningFix, passLabel, saveAuditSelection, callLong, TRACK_KEYS, lockedTrack, runOpenOptions, listenFindings, runOpeningCard, startOpeningCard, openingSlice, growthLimit, limitChapterGrowth, limitEditGrowth, scriptWords, runFactCheck, factBrief, parseClaims, parseVerdicts, parseFactQueries, startFinalPatch, runFinalPatch, parseOpen, runDeai, applyDeai, parseDeaiItems, startDeai, runFinal, mergeRounds, parseScores, trackList, loadTrack, autoTrack, parseEdits, applyEdits, locate, revisionView, parseBlocks, parseIssues, parseAuditIssues, auditSections, auditField, reportScore, routeSections, runPass, runPasses, runReverseAudit, startFinal, selectedFixes, PASSES, passBusy, sourceSegments, scriptChapters, replaceChapter, factNumbers, factState, buildView, getView, translateRun, runDraftFirst, resumeDraftFirst, setStatus, undo, rewriteChapter, updateFact, COMPRESS_NOTE };
