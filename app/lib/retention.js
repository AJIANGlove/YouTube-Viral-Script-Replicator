// 留存卡 / 替换库 / 留存检查 / 稿件检查的程序部分(确定性,不调 LLM)
// 留存卡:按 timeline.normalized_pattern 的位置比例,把 peak_points、open_loops 挂到 framework 的每个结构段上(流程 A1 的程序部分)
// 替换库:汇总全部资产的留存卡,按高峰类型列出"同一个留存动作在别的资产里用什么内容完成"(流程 A3 的程序部分)
// 留存检查:蓝图每章声明 carries_peaks 后,核对高峰承接数、第一个甜头秒数、相邻高峰最大间隔(流程 B⑪)
// 稿件数据:稿中数字与年份、每章数字密度、片长对比、事实时效(流程 B⑬ 新增,供稿件检查 K2/K3/K5 使用)
const store = require('./store');
const checks = require('./checks');

const parse = t => { try { return typeof t === 'string' ? JSON.parse(t) : (t || null); } catch (e) { return null; } };
const dataOf = j => (j && j.data) || j || {};

// 语言无关的词数:有空格的语言按空白切分(韩语按语节);中文/日文按字符数 ÷ 2 估算
function countWords(text) {
  const t = String(text || '');
  const cjk = (t.match(/[぀-ヿ㐀-鿿]/g) || []).length;
  const tokens = t.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w));
  if (cjk > tokens.length * 2) return Math.round(cjk / 2);
  return tokens.length;
}

// 含数字的"词"(数字密度的分子)
function numberTokens(text) {
  return String(text || '').split(/\s+/).filter(w => /\d/.test(w));
}

// ---------- A1:留存卡 ----------
function buildCards(frameworkText, timelineText) {
  const fw = dataOf(parse(frameworkText));
  const tl = dataOf(parse(timelineText));
  const stages = fw.structure_pattern || [];
  const pattern = tl.normalized_pattern || [];
  const durMs = (tl.duration_profile || {}).observed_duration_ms || 0;
  const peaks = tl.peak_points || [];
  const loops = tl.open_loops || [];
  const ratioOfMs = ms => (durMs && ms != null ? ms / durMs : null);
  const inRange = (r, p, isLast) => r != null && r >= p.start_ratio && (r < p.end_ratio || (isLast && r <= p.end_ratio));

  return pattern.map((p, i) => {
    const isLast = i === pattern.length - 1;
    const st = stages.find(s => s.stage_id === p.stage_id) || {};
    const card = {
      stage_id: p.stage_id,
      function: p.function || st.function || '',
      purpose: st.purpose || '',
      start_ratio: p.start_ratio,
      end_ratio: p.end_ratio,
      required_retention_events: p.required_retention_events || [],
      peaks: peaks.filter(pk => inRange(pk.position_ratio, p, isLast)).map(pk => ({
        peak_id: pk.peak_id, peak_type: pk.peak_type, strength: pk.strength,
        position_ratio: pk.position_ratio, time_ms: pk.time_ms, reason: pk.reason
      })),
      loops_opened: loops.filter(l => inRange(ratioOfMs(l.open_ms), p, isLast)).map(l => ({ loop_id: l.loop_id, tension: l.tension_function })),
      loops_closed: loops.filter(l => inRange(ratioOfMs(l.close_ms), p, isLast)).map(l => ({ loop_id: l.loop_id, payoff_type: l.payoff_type })),
      loops_open_ended: loops.filter(l => l.close_ms == null && inRange(ratioOfMs(l.open_ms), p, isLast)).map(l => l.loop_id)
    };
    if (i === 0 && tl.hook_window) card.hook = tl.hook_window;
    return card;
  });
}

// 程序卡片为准;资产目录里有 retention_cards.json 时并入 AI 补写的 abstract_action / replace_when
function cardsForAsset(asset) {
  if (!asset || !asset.framework || !asset.timeline) return [];
  const cards = buildCards(asset.framework, asset.timeline);
  const saved = parse(asset.retention_cards || '');
  const extra = {};
  (Array.isArray(saved) ? saved : (saved && saved.cards) || []).forEach(c => { if (c && c.stage_id) extra[c.stage_id] = c; });
  return cards.map(c => ({ ...c, abstract_action: (extra[c.stage_id] || {}).abstract_action || '', replace_when: (extra[c.stage_id] || {}).replace_when || '' }));
}

// ---------- A3:替换库(全部资产汇总,进程内缓存) ----------
let libraryCache = null;
function buildLibrary(force) {
  if (libraryCache && !force) return libraryCache;
  const lib = {};
  for (const a of store.listAssets()) {
    if (a.broken) continue;
    const asset = store.getAsset(a.id);
    for (const c of cardsForAsset(asset)) {
      for (const pk of c.peaks) {
        const key = pk.peak_type || 'other';
        (lib[key] = lib[key] || []).push({ asset_id: a.id, stage_function: c.function, strength: pk.strength, reason: pk.reason });
      }
    }
  }
  for (const k of Object.keys(lib)) lib[k].sort((x, y) => (y.strength || 0) - (x.strength || 0));
  libraryCache = lib;
  return lib;
}

// 写进提示词的替换库摘要:资产里出现最多的若干种高峰类型(长尾的一次性标签不进提示词),每种取强度最高的若干条
function librarySummary(perType, maxTypes) {
  const lib = buildLibrary();
  const n = perType || 6;
  const types = Object.keys(lib).sort((a, b) => lib[b].length - lib[a].length).slice(0, maxTypes || 8);
  return types.map(k => '- ' + k + ':\n' + lib[k].slice(0, n).map(x =>
    '  · [' + x.stage_function + '] ' + x.reason + '(' + x.asset_id + ')').join('\n')).join('\n');
}

// 写进提示词的留存地图:每段一行
function cardsSummary(cards) {
  return cards.map(c => {
    const pk = c.peaks.length ? c.peaks.map(p => p.peak_id + '(' + p.peak_type + ',强度' + p.strength + ',位置' + p.position_ratio + '):' + p.reason).join(';') : '无高峰';
    const lo = [
      c.loops_opened.length ? '开:' + c.loops_opened.map(l => l.loop_id).join('/') : '',
      c.loops_closed.length ? '合:' + c.loops_closed.map(l => l.loop_id).join('/') : '',
      c.loops_open_ended.length ? '明示未闭合:' + c.loops_open_ended.join('/') : ''
    ].filter(Boolean).join(',');
    const act = c.abstract_action ? ';留存动作:' + c.abstract_action + (c.replace_when ? '(可替换为:' + c.replace_when + ')' : '') : '';
    return '- ' + c.stage_id + ' ' + c.function + '(' + c.start_ratio + '–' + c.end_ratio + '):' + pk + (lo ? ';悬念 ' + lo : '') + act;
  }).join('\n');
}

function hookContract(timelineText) {
  const tl = dataOf(parse(timelineText));
  const h = tl.hook_window || {};
  if (!h.hook_type) return '(资产未记录开场窗口)';
  return '钩子类型 ' + h.hook_type + ';第一个刺激 ' + ((h.first_stimulus_ms || 0) / 1000).toFixed(1) + ' 秒;第一个甜头 ' + ((h.first_payoff_ms || 0) / 1000).toFixed(1) + ' 秒;开场窗口 0–' + ((h.end_ms || 0) / 1000).toFixed(0) + ' 秒';
}

// ---------- B⑪:蓝图留存检查 ----------
// accepted:写前分析里标为"缺口-接受弱化"的高峰编号,不计入应接住总数
function checkBlueprintRetention(blueprintText, timelineText, accepted) {
  const tl = dataOf(parse(timelineText));
  const bp = parse(checks.stripFence(blueprintText || '')) || checks.extractJsonObject(blueprintText || '') || {};
  const chapters = bp.chapters || [];
  const srcPeaks = tl.peak_points || [];
  const durSrc = ((tl.duration_profile || {}).observed_duration_ms || 0) / 1000;
  const acceptedSet = new Set(accepted || []);
  const expected = srcPeaks.filter(p => !acceptedSet.has(p.peak_id));
  const issues = [];

  const range = c => {
    const m = String(c.time_range || '').match(/(\d+:\d+(?::\d+)?)\s*[-–—~]\s*(\d+:\d+(?::\d+)?)/);
    return m ? [checks.toSec(m[1]), checks.toSec(m[2])] : null;
  };
  const carried = {};
  let total = 0;
  chapters.forEach(c => {
    const r = range(c);
    if (r) total = Math.max(total, r[1]);
    (Array.isArray(c.carries_peaks) ? c.carries_peaks : []).forEach(id => { if (!carried[id] && r) carried[id] = { chapter: c.id, sec: (r[0] + r[1]) / 2 }; });
  });
  const caught = expected.filter(p => carried[p.peak_id]);
  const missing = expected.filter(p => !carried[p.peak_id]).map(p => p.peak_id);
  if (missing.length) issues.push('未接住的高峰:' + missing.join('、'));

  // 第一个甜头:蓝图顶层 hook.first_payoff_sec,不晚于原片
  const srcPay = ((tl.hook_window || {}).first_payoff_ms || 0) / 1000;
  const pay = bp.hook && Number(bp.hook.first_payoff_sec);
  let payoffOk = null;
  if (srcPay) {
    if (!pay && pay !== 0) { payoffOk = false; issues.push('蓝图没有写 hook.first_payoff_sec(第一个甜头在第几秒)'); }
    else { payoffOk = pay <= srcPay + 0.5; if (!payoffOk) issues.push('第一个甜头在 ' + pay + ' 秒,晚于原片的 ' + srcPay.toFixed(1) + ' 秒'); }
  }

  // 相邻高峰最大间隔:按占全片比例比较,允许 2 个百分点误差
  const gapRatio = (times, dur) => {
    const t = [...times].sort((a, b) => a - b);
    let g = 0, prev = 0;
    for (const x of t) { g = Math.max(g, x - prev); prev = x; }
    return dur ? g / dur : 0;
  };
  const srcGap = gapRatio(srcPeaks.map(p => p.time_ms / 1000), durSrc);
  const newGap = gapRatio(Object.values(carried).map(x => x.sec), total);
  const gapOk = !caught.length || newGap <= srcGap + 0.02;
  if (!gapOk) issues.push('相邻高峰最大间隔占全片 ' + Math.round(newGap * 100) + '%,原片 ' + Math.round(srcGap * 100) + '%');

  return {
    ok: !missing.length && payoffOk !== false && gapOk,
    caught: caught.length, expected: expected.length, total_peaks: srcPeaks.length,
    accepted_gaps: [...acceptedSet], missing,
    first_payoff_sec: pay || null, source_first_payoff_sec: srcPay || null,
    max_gap_ratio: Math.round(newGap * 100) / 100, source_max_gap_ratio: Math.round(srcGap * 100) / 100,
    carried, issues
  };
}

// ---------- B⑬ 新增:稿件数据(K2/K3/K5 的程序部分) ----------
function chapterBodies(script) {
  const re = /^\[(CH\d+)\s*\|[^\]]*\]\s*$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(script)) !== null) marks.push({ id: m[1], index: m.index, end: m.index + m[0].length });
  return marks.map((k, i) => ({ id: k.id, text: script.slice(k.end, i + 1 < marks.length ? marks[i + 1].index : script.length).trim() }));
}

// 原片每段的数字密度上限(每 100 词含数字的词数),从 source.srt 按 normalized_pattern 切段
function sourceDensityMax(srtText, timelineText) {
  const tl = dataOf(parse(timelineText));
  const durMs = (tl.duration_profile || {}).observed_duration_ms || 0;
  if (!srtText || !durMs) return null;
  const cues = [];
  for (const b of String(srtText).replace(/^﻿/, '').split(/\r?\n\s*\r?\n/)) {
    const ls = b.trim().split(/\r?\n/);
    const tm = ls[1] && ls[1].match(/^(\d+):(\d+):(\d+)[,.](\d+)/);
    if (tm) cues.push({ ms: ((+tm[1] * 60 + +tm[2]) * 60 + +tm[3]) * 1000 + +tm[4], text: ls.slice(2).join(' ') });
  }
  let max = 0;
  for (const p of tl.normalized_pattern || []) {
    const text = cues.filter(c => c.ms >= p.start_ratio * durMs && c.ms < p.end_ratio * durMs).map(c => c.text).join(' ');
    const w = countWords(text);
    if (w >= 40) max = Math.max(max, numberTokens(text).length / w * 100);
  }
  return Math.round(max * 10) / 10;
}

// facts:写前分析的事实表;now:当前年份(测试可注入)
function scriptStats(script, opts) {
  const o = opts || {};
  const now = o.year || new Date().getFullYear();
  const tl = dataOf(parse(o.timeline));
  const fw = dataOf(parse(o.framework));
  const wpm = ((tl.subtitle_metrics || {}).average_words_per_minute) || 130;
  const chapters = chapterBodies(script || '');
  const words = chapters.reduce((s, c) => s + countWords(c.text), 0);
  const estSec = Math.round(words / wpm * 60);
  const rec = (fw.content_profile || {}).recommended_duration_ms || (tl.duration_profile || {}).recommended_duration_ms || null;
  const srcSec = Math.round(((tl.duration_profile || {}).observed_duration_ms || 0) / 1000) || null;
  const densMax = o.srt ? sourceDensityMax(o.srt, o.timeline) : null;
  const densLimit = densMax ? Math.round(densMax * 1.5 * 10) / 10 : null;

  const perChapter = chapters.map(c => {
    const w = countWords(c.text);
    const nums = numberTokens(c.text);
    const years = [...new Set((c.text.match(/(?:19|20)\d{2}/g) || []))];
    const density = w ? Math.round(nums.length / w * 1000) / 10 : 0;
    return { id: c.id, words: w, number_tokens: nums.length, density, too_dense: densLimit != null && w >= 30 && density > densLimit, years };
  });

  const facts = Array.isArray(o.facts) ? o.facts : [];
  const stale = facts.filter(f => {
    const y = parseInt(String(f.year || '').match(/\d{4}/), 10);
    return y && now - y > 3;
  }).map(f => ({ id: f.id, year: f.year, content: f.content, age: now - parseInt(String(f.year).match(/\d{4}/), 10) }));

  const length = {
    est_sec: estSec, words, wpm,
    recommended_min_sec: rec ? Math.round(rec.min / 1000) : null,
    recommended_max_sec: rec ? Math.round(rec.max / 1000) : null,
    source_sec: srcSec,
    too_short: !!(rec && estSec < rec.min / 1000)
  };
  return {
    length, chapters: perChapter,
    source_density_max: densMax, density_limit: densLimit,
    dense_chapters: perChapter.filter(c => c.too_dense).map(c => c.id),
    mixed_year_chapters: perChapter.filter(c => c.years.length >= 2).map(c => ({ id: c.id, years: c.years })),
    stale_facts: stale
  };
}

module.exports = { countWords, numberTokens, buildCards, cardsForAsset, buildLibrary, librarySummary, cardsSummary, hookContract, checkBlueprintRetention, chapterBodies, sourceDensityMax, scriptStats };
