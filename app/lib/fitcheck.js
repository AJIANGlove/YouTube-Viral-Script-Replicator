// 快速适配判断(v1.70):写前分析之前,先用一次短调用判「这个题能不能用这个框架写」。
// 实测:完整写前分析一次 1.5–6 分钟、平均 1.8 万字,判了「换框架」整份扔掉(19 次换框架里 13 次换过去又被判不合适)。
// 这里只喂框架的结构段、必须保留的机制、使用前提、不可删段,只出结论;判「换框架」就不跑完整分析和原片对照表。
// 推荐框架时,候选的 6 个也各跑一次(并行),按结论排序给人看前 3 个。
// 完整写前分析的提示词和输入不变。
const fs = require('fs');
const path = require('path');
const retention = require('./retention');

const an = () => require('./analysis');
const arr = v => (Array.isArray(v) ? v : []);
const str = v => String(v == null ? '' : v).trim();
const list = a => (Array.isArray(a) && a.length ? a.join(';') : '(无)');
const parse = t => { try { return JSON.parse(t); } catch (e) { return null; } };
const fitrule = () => require('./fitrule'); // v1.74:按功能重排时换提示词、按新标准过一遍结论(严格照原片时不变)
const promptPath = () => path.join(__dirname, '..', 'prompts', fitrule().fitPromptFile());
const VERDICTS = ['可以写', '调整后可写', '换框架'];
const STRUCTURE_MAX = 3000;
const MATERIALS_MAX = 1500;
const rank = v => { const i = VERDICTS.indexOf(v); return i < 0 ? 1 : i; };

function fwData(asset) {
  const fw = parse((asset && asset.framework) || '') || {};
  return fw.data || fw;
}

// 结构段:编号 功能:目的(≤90 字) | 必需(≤110 字),总共不超过 3000 字(213 个框架实测最长 2722 字)
function structureBrief(fw) {
  let left = STRUCTURE_MAX;
  const out = [];
  for (const s of arr(fw.structure_pattern)) {
    if (!s || typeof s !== 'object') continue;
    const need = arr(s.required_payload).map(str).filter(Boolean).join('、').slice(0, 110);
    const line = '- ' + str(s.stage_id) + ' ' + str(s.function) + ':' + str(s.purpose).slice(0, 90) + (need ? ' | 必需:' + need : '');
    if (line.length > left) break;
    out.push(line);
    left -= line.length + 1;
  }
  return out.join('\n') || '(无)';
}

// 留存卡上标「不可删」的段(timeline 缺失时为空)
function fixedSegments(asset) {
  try {
    return retention.cardsForAsset(asset).filter(c => c.deletability === '不可删')
      .map(c => '- ' + c.stage_id + ' ' + (c.function || '') + ':' + str(c.deletability_reason).replace(/。?事实不够时.*$/, '').slice(0, 80)).join('\n') || '(没有标「不可删」的段)';
  } catch (e) { return '(这个框架没有留存卡)'; }
}

function frameworkBrief(asset) {
  const fw = fwData(asset);
  const tr = fw.transferability || {};
  const mr = fw.migration_rules || {};
  const ce = fw.core_engine || {};
  const cp = fw.content_profile || {};
  const thc = fw.title_hook_contract || {};
  return {
    framework_name: fw.name || asset.id,
    core_engine: [ce.surface_promise_pattern, arr(ce.deep_emotional_promise).join('、')].filter(Boolean).join(';') || '(无)',
    narrative_mode: str(cp.narrative_mode) || '(未记录)',
    best_traits: list(tr.best_topic_traits),
    avoid_traits: list(tr.avoid_topic_traits),
    prerequisites: list(tr.prerequisites),
    risk_flags: list(tr.risk_flags),
    must_preserve: list(mr.must_preserve),
    title_contract: [thc.title_formula ? '标题公式:' + thc.title_formula : '', arr(thc.must_deliver).length ? '必须兑现:' + arr(thc.must_deliver).join(';') : ''].filter(Boolean).join(' / ').slice(0, 600) || '(无)',
    structure: structureBrief(fw),
    fixed_segments: fixedSegments(asset)
  };
}

// 题目这一侧:ctx = { title, thesis_card, protagonist }(换框架时取上一份分析的,第一次分析时没有)
function topicVars(run, ctx) {
  const aud = run.audience || {};
  const c = ctx || {};
  const has = v => v && typeof v === 'object' && Object.keys(v).length;
  return {
    topic: run.topic || '',
    title: str(c.title) || run.topic || '',
    target_language: aud.target_language || '',
    target_country: aud.target_country || '',
    video_goal: aud.video_goal || '',
    target_audience: aud.target_audience || '(未填)',
    thesis: has(c.thesis_card) ? JSON.stringify(c.thesis_card).slice(0, 1200) : '(还没有,按题目判断)',
    protagonist: has(c.protagonist) ? JSON.stringify(c.protagonist).slice(0, 600) : '(还没有,按题目判断)',
    materials: run.materials ? String(run.materials).slice(0, MATERIALS_MAX) + (String(run.materials).length > MATERIALS_MAX ? '……(后略)' : '') : '(无)'
  };
}

function buildPrompt(run, asset, ctx) {
  return an().fillVars(fs.readFileSync(promptPath(), 'utf-8'), { ...topicVars(run, ctx), ...frameworkBrief(asset) });
}

const fitOk = o => !!(o && typeof o === 'object' && !Array.isArray(o) && VERDICTS.includes(str(o.verdict)));
function cleanFit(out) {
  const verdict = str(out.verdict);
  return {
    verdict,
    verdict_reason: str(out.verdict_reason),
    blocking: arr(out.blocking).map(b => (b && typeof b === 'object' ? { segment: str(b.segment), why: str(b.why) } : { segment: '', why: str(b) })).filter(b => b.segment || b.why).slice(0, 12),
    adjust: verdict === '调整后可写' ? arr(out.adjust).map(str).filter(Boolean).slice(0, 12) : [],
    reframe_reasons: verdict === '换框架' ? arr(out.reframe_reasons).map(str).filter(Boolean).slice(0, 12) : [],
    pov_mode: ['climb', 'per_level', 'none'].includes(str(out.pov_mode)) ? str(out.pov_mode) : 'none',
    pov_basis: str(out.pov_basis)
  };
}

// 一次快速判断。run 是调用方持有的同一个对象:并行跑几个时,attempts 都记在它上面(callWithLog 只把 attempts 并回盘上的最新版)
async function quickFit(run, cfg, asset, ctx) {
  const t0 = Date.now();
  const out = await an().callJson(run, cfg, buildPrompt(run, asset, ctx), '快速适配判断', fitOk);
  let fit = cleanFit(out);
  if (fitrule().on()) fit = fitrule().applyQuick(fit, out);
  return { ...fit, asset_id: asset.id, secs: Math.round((Date.now() - t0) / 100) / 10, at: new Date().toISOString() };
}

// 快速判断判了「换框架」:不跑完整分析,存一份只有结论的分析(quick_only),后面的换框架推荐照常读 verdict / reframe_reasons
function stubAnalysis(run, fit, ctx) {
  const c = ctx || {};
  const reasons = fit.reframe_reasons.length ? fit.reframe_reasons
    : fit.blocking.map(b => (b.segment ? b.segment + ':' : '') + b.why).filter(Boolean);
  return {
    quick_only: true,
    verdict: '换框架',
    verdict_reason: fit.verdict_reason || '快速适配判断:这个框架套不上这个题目',
    reframe_reasons: reasons.length ? reasons : [fit.verdict_reason || '快速适配判断判了换框架'],
    fit_quick: fit,
    title: { final_title: str(c.title) || run.topic || '' },
    thesis_card: (c.thesis_card && typeof c.thesis_card === 'object') ? c.thesis_card : {},
    protagonist: (c.protagonist && typeof c.protagonist === 'object') ? c.protagonist : {},
    facts: [], modules: [], retention_map: [], hook: {}
  };
}

const isQuickOnly = run => !!(run && run.analysis && run.analysis.quick_only);
function assertFull(run) {
  if (isQuickOnly(run)) throw Object.assign(new Error('这篇只做了快速适配判断(判了「换框架」),还没有完整的写前分析:请换一个框架,或点「仍按现在的框架写」先做完整分析'), { status: 409 });
}

// 记录每次快速判断和完整分析的结论(run.fit_log),以后统计两者一致率。by: quick=写前分析前跑的 / prejudge=推荐时的预判
function logQuick(run, fit, by) {
  const reasons = fit.verdict === '换框架' ? (fit.reframe_reasons.length ? fit.reframe_reasons : fit.blocking.map(b => (b.segment ? b.segment + ':' : '') + b.why)).slice(0, 5) : [];
  run.fit_log = arr(run.fit_log).concat([{ asset_id: fit.asset_id, quick: { verdict: fit.verdict, secs: fit.secs, by, at: fit.at, ...(reasons.length ? { reasons } : {}) } }]).slice(-60);
}
// reasons:完整分析判换框架时的原因(v1.71 自动往下试要写清每一次为什么不行),最多 5 条
function logFull(run, assetId, verdict, reasons) {
  const full = { verdict, at: new Date().toISOString(), ...(arr(reasons).length ? { reasons: arr(reasons).map(x => String(x).slice(0, 200)).slice(0, 5) } : {}) };
  const log = arr(run.fit_log);
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].asset_id === assetId && !log[i].full) { log[i] = { ...log[i], full }; run.fit_log = log; return; }
  }
  run.fit_log = log.concat([{ asset_id: assetId, full }]).slice(-60);
}

module.exports = { VERDICTS, rank, frameworkBrief, structureBrief, fixedSegments, topicVars, buildPrompt, fitOk, cleanFit, quickFit, stubAnalysis, isQuickOnly, assertFull, logQuick, logFull };
