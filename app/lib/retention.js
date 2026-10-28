// 留存卡 / 替换库 / 留存检查 / 稿件检查的程序部分(确定性,不调 LLM)
// 留存卡:按 timeline.normalized_pattern 的位置比例,把 peak_points、open_loops、retention_events 挂到每个结构段上,补齐 7 项(流程 A1)
// 替换库:汇总全部资产的留存卡,按高峰类型列出"同一个留存动作在别的资产里用什么内容完成"(流程 A3 的程序部分)
// 留存检查:蓝图每章声明 carries_peaks 后,核对高峰承接数、第一个甜头秒数、相邻高峰最大间隔(流程 B⑪)
// 稿件数据:稿中数字与年份、每章数字密度、片长对比、事实时效(流程 B⑬ 新增,供稿件检查 K2/K3/K5 使用)
const store = require('./store');
const checks = require('./checks');

const parse = t => { try { return typeof t === 'string' ? JSON.parse(t) : (t || null); } catch (e) { return null; } };
const dataOf = j => (j && j.data) || j || {};

// 语言无关的词数(实现在 checks,写稿闸门和稿件检查用同一个口径)
const countWords = checks.countWords;

// 含数字的"词"(数字密度的分子)
function numberTokens(text) {
  return String(text || '').split(/\s+/).filter(w => /\d/.test(w));
}

// ---------- A1:留存卡(7 项) ----------
// 一张卡 = 段与位置 / 持有的高峰 / 悬念 / 原片做法 / 抽象动作 / 替换条件 / 可删性
// 前三项由程序从 timeline 对出;后三项的初稿取自拆解阶段 AI 已写好的字段(原片做法 ← observed_segments.information_move,
// 抽象动作 ← structure_pattern.purpose,替换条件 ← structure_pattern.required_payload),可删性按规则判定。
// 资产目录里的 retention_cards.json(--ai 润色或人工改过)优先于程序初稿。
const CARD_VERSION = '1.1';

const fmtSec = sec => {
  if (sec == null || isNaN(sec)) return '';
  const s = Math.round(sec);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

// "A → B → C" / "A;B" 形式拆成动作列表;拆不开就整句一条
function splitMoves(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  const parts = t.split(/\s*(?:→|->|⇒|;|;)\s*/).map(x => x.trim()).filter(Boolean);
  return parts.length ? parts : [t];
}

// 时间点归段:落在多个段里(边界重叠)时归开始位置更靠后的那段;落在段与段的空隙里时归前一段
function segmentIndexOf(ratio, pattern) {
  if (ratio == null || isNaN(ratio) || !pattern.length) return -1;
  let idx = -1;
  pattern.forEach((p, i) => { if (p.start_ratio <= ratio + 1e-9) idx = i; });
  return idx === -1 ? 0 : idx;
}

// observed_segments 不一定带 stage_id:按 stage_id → 同序号 → 位置重叠最多 依次匹配
function matchObserved(pattern, observed) {
  return pattern.map((p, i) => {
    const byId = observed.find(o => o.stage_id && o.stage_id === p.stage_id);
    if (byId) return byId;
    if (observed.length === pattern.length) return observed[i];
    let best = null, bestOv = 0;
    observed.forEach(o => {
      const ov = Math.min(p.end_ratio, o.end_ratio) - Math.max(p.start_ratio, o.start_ratio);
      if (ov > bestOv) { bestOv = ov; best = o; }
    });
    return best;
  });
}

function buildCards(frameworkText, timelineText) {
  const fw = dataOf(parse(frameworkText));
  const tl = dataOf(parse(timelineText));
  const stages = fw.structure_pattern || [];
  const pattern = (tl.normalized_pattern || []).slice().sort((a, b) => a.start_ratio - b.start_ratio);
  const durMs = (tl.duration_profile || {}).observed_duration_ms || 0;
  const peaks = tl.peak_points || [];
  const loops = tl.open_loops || [];
  const events = tl.retention_events || [];
  const observed = matchObserved(pattern, tl.observed_segments || []);
  const ratioOfMs = ms => (durMs && ms != null ? ms / durMs : null);
  const segOfMs = ms => segmentIndexOf(ratioOfMs(ms), pattern);

  const cards = pattern.map((p, i) => {
    const st = stages.find(s => s.stage_id === p.stage_id) || {};
    const ob = observed[i] || {};
    const startSec = ob.start_ms != null ? ob.start_ms / 1000 : (durMs ? p.start_ratio * durMs / 1000 : null);
    const endSec = ob.end_ms != null ? ob.end_ms / 1000 : (durMs ? p.end_ratio * durMs / 1000 : null);
    const myPeaks = peaks.filter(pk => segmentIndexOf(pk.position_ratio != null ? pk.position_ratio : ratioOfMs(pk.time_ms), pattern) === i);
    const opened = loops.filter(l => segOfMs(l.open_ms) === i);
    const closed = loops.filter(l => l.close_ms != null && segOfMs(l.close_ms) === i);
    const needs = (st.required_payload && st.required_payload.length) ? st.required_payload.slice()
      : (st.exit_condition ? ['能做到:' + st.exit_condition] : (ob.viewer_goal ? ['能让观众:' + ob.viewer_goal] : (p.required_retention_events || [])));
    return {
      stage_id: p.stage_id,
      // ① 段与位置
      function: p.function || st.function || ob.primary_function || '',
      start_ratio: p.start_ratio,
      end_ratio: p.end_ratio,
      start_sec: startSec != null ? Math.round(startSec * 10) / 10 : null,
      end_sec: endSec != null ? Math.round(endSec * 10) / 10 : null,
      position_label: Math.round(p.start_ratio * 1000) / 10 + '%–' + Math.round(p.end_ratio * 1000) / 10 + '%' +
        (startSec != null ? '(' + fmtSec(startSec) + '–' + fmtSec(endSec) + ')' : ''),
      purpose: st.purpose || '',
      // ② 持有的高峰
      peaks: myPeaks.map(pk => ({
        peak_id: pk.peak_id, peak_type: pk.peak_type, strength: pk.strength,
        position_ratio: pk.position_ratio, time_ms: pk.time_ms, reason: pk.reason
      })),
      // ③ 悬念(开、合、跨段)
      loops_opened: opened.map(l => ({ loop_id: l.loop_id, tension: l.tension_function, closes_in: l.close_ms != null ? (pattern[segOfMs(l.close_ms)] || {}).stage_id || null : null })),
      loops_closed: closed.map(l => ({ loop_id: l.loop_id, payoff_type: l.payoff_type, opened_in: (pattern[segOfMs(l.open_ms)] || {}).stage_id || null })),
      loops_open_ended: opened.filter(l => l.close_ms == null).map(l => l.loop_id),
      retention_events: events.filter(e => segmentIndexOf(e.position_ratio != null ? e.position_ratio : ratioOfMs(e.time_ms), pattern) === i)
        .map(e => ({ event_id: e.event_id, event_type: e.event_type, mechanism: e.mechanism })),
      required_retention_events: p.required_retention_events || [],
      // ④ 原片做法 ⑤ 抽象动作 ⑥ 替换条件(初稿,来自拆解阶段;--ai 可重写)
      original_moves: splitMoves(ob.information_move),
      abstract_move: st.purpose || ob.viewer_goal || '',
      replacement_needs: needs,
      // ⑦ 可删性(下面统一判定)
      deletability: '',
      deletability_reason: '',
      merge_keep: '',
      loss_if_deleted: []
    };
  });

  cards.forEach((c, i) => {
    const crossOpen = c.loops_opened.filter(l => l.closes_in !== c.stage_id);   // 这里开、别处合或不合
    const crossClose = c.loops_closed.filter(l => l.opened_in !== c.stage_id);   // 别处开、这里合
    const inner = c.loops_opened.filter(l => l.closes_in === c.stage_id);
    c.loss_if_deleted = c.peaks.map(p => ({ peak_id: p.peak_id, strength: p.strength }));
    const why = [];
    if (i === 0) why.push('开场钩子段');
    if (c.peaks.length) why.push('持有高峰 ' + c.peaks.map(p => p.peak_id + '(' + p.strength + ')').join('、'));
    if (crossOpen.length) why.push('打开的悬念 ' + crossOpen.map(l => l.loop_id + (l.closes_in ? '→' + l.closes_in : '(不闭合)')).join('、') + ' 跨段');
    if (crossClose.length) why.push('回收了前文的悬念 ' + crossClose.map(l => (l.opened_in || '?') + '→' + l.loop_id).join('、'));
    if (why.length) {
      c.deletability = '不可删';
      c.deletability_reason = why.join(';') + '。事实不够时只能换内容保功能,接不住就在写前分析里标缺口。';
    } else if (inner.length) {
      c.deletability = '可并入';
      c.deletability_reason = '没有高峰,只有段内小悬念 ' + inner.map(l => l.loop_id).join('、') + '。';
      c.merge_keep = '内容可以删,但相邻段要补一个小问答:' + inner.map(l => l.tension).filter(Boolean).join(';');
    } else {
      c.deletability = '可删';
      c.deletability_reason = '没有高峰,也不开合任何悬念,删掉不丢爆点。';
    }
  });
  if (cards.length && tl.hook_window) cards[0].hook = tl.hook_window;
  return cards;
}

// 资产目录的 retention_cards.json 里可编辑的字段(--ai 润色或人工改过的版本优先)
const EDITABLE = ['original_moves', 'abstract_move', 'replacement_needs', 'deletability', 'deletability_reason', 'merge_keep'];

function cardsForAsset(asset) {
  if (!asset || !asset.framework || !asset.timeline) return [];
  const cards = buildCards(asset.framework, asset.timeline);
  const saved = parse(asset.retention_cards || '');
  const extra = {};
  (Array.isArray(saved) ? saved : (saved && saved.cards) || []).forEach(c => { if (c && c.stage_id) extra[c.stage_id] = c; });
  return cards.map(c => {
    const e = extra[c.stage_id];
    if (!e) return c;
    const out = { ...c };
    EDITABLE.forEach(k => { if (e[k] != null && e[k] !== '' && !(Array.isArray(e[k]) && !e[k].length)) out[k] = e[k]; });
    // 兼容 1.0 版文件的字段名
    if (e.abstract_action && !e.abstract_move) out.abstract_move = e.abstract_action;
    if (e.replace_when && !e.replacement_needs) out.replacement_needs = [e.replace_when];
    if (e.ai_refined) out.ai_refined = true;
    return out;
  });
}

// ---------- A3:替换库(全部资产汇总,进程内缓存) ----------
// 按高峰类型归类:同一类高峰在别的资产里由什么抽象动作完成、需要哪类事实
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
        (lib[key] = lib[key] || []).push({
          asset_id: a.id, stage_id: c.stage_id, stage_function: c.function, strength: pk.strength, reason: pk.reason,
          abstract_move: c.abstract_move, replacement_needs: c.replacement_needs
        });
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
    '  · [' + x.stage_function + '] 动作:' + (x.abstract_move || x.reason) + ';需要:' + (x.replacement_needs || []).join('、') + '(' + x.asset_id + ')').join('\n')).join('\n');
}

// 写进提示词的留存地图:每段一张卡(7 项)
function cardsSummary(cards) {
  return cards.map(c => {
    const pk = c.peaks.length ? c.peaks.map(p => p.peak_id + '(' + p.peak_type + ',强度' + p.strength + '):' + p.reason).join(';') : '无';
    const lo = [
      c.loops_opened.length ? '开 ' + c.loops_opened.map(l => l.loop_id + (l.closes_in && l.closes_in !== c.stage_id ? '→' + l.closes_in : '')).join('/') : '',
      c.loops_closed.length ? '合 ' + c.loops_closed.map(l => l.loop_id).join('/') : '',
      c.loops_open_ended.length ? '明示未闭合 ' + c.loops_open_ended.join('/') : ''
    ].filter(Boolean).join(',') || '无';
    return [
      '- ' + c.stage_id + ' ' + c.function + ' ' + (c.position_label || (c.start_ratio + '–' + c.end_ratio)),
      '  高峰:' + pk,
      '  悬念:' + lo,
      '  原片做法:' + (c.original_moves || []).join(' → '),
      '  抽象动作:' + (c.abstract_move || ''),
      '  替换条件:' + (c.replacement_needs || []).join(';'),
      '  可删性:' + c.deletability + '——' + c.deletability_reason + (c.merge_keep ? ' ' + c.merge_keep : '')
    ].join('\n');
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
  // 基准必须用"同一组高峰"算:已标"缺口-接受弱化"的高峰两边都不算,否则接受弱化后新稿必然超差(自相矛盾)
  const gapRatio = (times, dur) => {
    const t = [...times].sort((a, b) => a - b);
    let g = 0, prev = 0;
    for (const x of t) { g = Math.max(g, x - prev); prev = x; }
    return dur ? g / dur : 0;
  };
  const srcGap = gapRatio(expected.map(p => p.time_ms / 1000), durSrc);
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
  const wpm = o.wpm || ((tl.subtitle_metrics || {}).average_words_per_minute) || 130;
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

module.exports = { CARD_VERSION, countWords, numberTokens, buildCards, cardsForAsset, buildLibrary, librarySummary, cardsSummary, hookContract, checkBlueprintRetention, chapterBodies, sourceDensityMax, scriptStats };
