// 写前分析判「换框架」时:不再照写,停下来从框架库按题目推荐 3 个更合适的框架,人选一个后换框架重跑分析。
// 实测:仓库里写前分析判「换框架」却照写的 9 篇,进终审时七维平均 5.3;判「可以写 / 调整后可写」的 12 篇平均 6.3
// (청나라 궁녀 套「嫁入皇室」框架,分析已写明宫女没有婚姻和继承线,照写后终审 4.6)。
// run.reframe = { status: held|suggesting|done|failed|ignored, stage, from_asset, reasons, picks, candidates, rounds, none_fit, topic_note, tried[], prev, error }
// v1.70:推荐时先选 6 个候选,每个并行跑一次快速适配判断(lib/fitcheck.js),按结论排序给人看前 3 个;
// 6 个全判「换框架」就排除它们再推荐一轮,还不行就标 none_fit(「库里没有合适的框架」)。人选中后预判结果带进写前分析,不再判一次
const fs = require('fs');
const path = require('path');
const store = require('./store');

const an = () => require('./analysis');
const fc = () => require('./fitcheck');
const pl = () => require('./pipeline');
const arr = v => (Array.isArray(v) ? v : []);
const PROMPT = path.join(__dirname, '..', 'prompts', 'reframe_suggest.md');
const CANDIDATES = 6;   // 初选几个
const SHOW = 3;         // 预判后给人看几个
const cut = (v, n) => { const t = String(v == null ? '' : v); return t.length > n ? t.slice(0, n) + '…' : t; };

// 推荐中途进程重启:「suggesting」超过 10 分钟就当没在跑
const busy = rf => !!(rf && rf.status === 'suggesting' && Date.now() - Date.parse(rf.started_at || 0) < 600000);
const isReframe = run => !!(run && run.analysis && run.analysis.verdict === '换框架');
// 判了换框架、人没选「仍按现在的框架写」:先写后改的任务停在分析后,不点火写稿
function shouldHold(run) {
  return isReframe(run) && !(run.reframe && run.reframe.status === 'ignored');
}

// 框架库目录:同赛道给完整信息(核心承诺、适合/不适合的题,v1.70 起加上叙事方式、必须保留的机制、使用前提),
// 其他赛道只给名字,控制提示词长度。读 200 多个框架文件,缓存 5 分钟
// (实测写前分析否掉推荐框架的理由几乎全是结构段要求和「必须保留的机制」,原来推荐这一步看不到)
let cache = null;
function library() {
  if (cache && Date.now() - cache.at < 300000) return cache.list;
  const list = store.listAssets().filter(a => !a.broken).map(a => {
    let tr = {}, ce = {}, mr = {}, cp = {};
    try {
      const asset = store.getAsset(a.id);
      const fw = JSON.parse(asset.framework || '{}');
      const d = fw.data || fw;
      tr = d.transferability || {};
      ce = d.core_engine || {};
      mr = d.migration_rules || {};
      cp = d.content_profile || {};
    } catch (e) { /* 框架文件坏了:只用 meta 里的信息 */ }
    return {
      id: a.id, name: a.name || a.id, track: a.track || '', source: a.source_title_zh || a.source_title || '',
      promise: ce.surface_promise_pattern || String(a.description || '').slice(0, 80),
      best: arr(tr.best_topic_traits).length ? arr(tr.best_topic_traits) : arr(a.best_topic_traits),
      avoid: arr(tr.avoid_topic_traits),
      mode: String(cp.narrative_mode || ''),
      must: arr(mr.must_preserve).map(String),
      pre: arr(tr.prerequisites).map(String)
    };
  });
  cache = { at: Date.now(), list };
  return list;
}

function catalogText(run, exclude) {
  const lib = library().filter(a => !exclude.includes(a.id));
  const cur = library().find(a => a.id === run.asset_id) || {};
  const track = cur.track || '';
  const same = lib.filter(a => a.track === track || a.track === 'general' || !a.track);
  const other = lib.filter(a => !same.includes(a));
  return {
    same_track: same.map(a => [a.id, a.name, a.promise, a.best.join(';'), a.avoid.join(';'), a.mode || '-', cut(a.must.join(';'), 150) || '-', cut(a.pre.join(';'), 100) || '-', a.source].join(' | ')).join('\n') || '(无)',
    other_tracks: other.map(a => [a.id, a.name, a.source].join(' | ')).join('\n') || '(无)',
    ids: new Set(lib.map(a => a.id))
  };
}

function save(runId, patch) {
  const fresh = store.getRun(runId);
  if (!fresh) return null;
  fresh.reframe = { ...(fresh.reframe || {}), ...patch };
  store.saveRun(fresh);
  return fresh;
}

// 预判排序:可以写 > 调整后可写 > 预判没成功 > 换框架;同档按 AI 推荐的顺序(recommended 的排最前)
function prejudgeRank(p) {
  const pj = p.prejudge || {};
  return pj.verdict ? fc().rank(pj.verdict) * 2 : 3;
}
const unfit = p => (p.prejudge || {}).verdict === '换框架';

// 初选一轮:一次调用挑 6 个候选(只能从目录里挑、去重);extra 是上一轮的预判结果(第二轮才有)
async function pickRound(run, cfg, a, exclude, extra) {
  const cat = catalogText(run, exclude);
  const cur = library().find(x => x.id === run.asset_id) || { name: run.asset_name || run.asset_id };
  const prompt = an().fillVars(fs.readFileSync(PROMPT, 'utf-8'), {
    topic: run.topic || '', title: ((a.title || {}).final_title) || run.topic || '',
    target_country: (run.audience || {}).target_country || '', target_language: (run.audience || {}).target_language || '',
    thesis: JSON.stringify(a.thesis_card || {}),
    current: cur.name + (cur.source ? '(原片:' + cur.source + ')' : ''),
    reasons: arr(a.reframe_reasons).map((r, i) => (i + 1) + '. ' + r).join('\n') || (a.verdict_reason || '(分析没写原因)'),
    previous_round: extra || '',
    same_track: cat.same_track, other_tracks: cat.other_tracks
  });
  const out = await an().callJson(run, cfg, prompt, extra ? '换框架·推荐框架(第二轮)' : '换框架·推荐框架', o => arr(o.picks).some(p => p && cat.ids.has(String(p.asset_id || '').trim())));
  const lib = library();
  const picks = arr(out.picks).map(p => ({ ...p, asset_id: String(p.asset_id || '').trim() }))
    .filter((p, i, all) => cat.ids.has(p.asset_id) && all.findIndex(x => x.asset_id === p.asset_id) === i).slice(0, CANDIDATES)
    .map((p, i) => {
      const x = lib.find(l => l.id === p.asset_id) || {};
      return { asset_id: p.asset_id, name: x.name || p.asset_id, source: x.source || '', track: x.track || '',
        fit: String(p.fit || ''), why: String(p.why || ''), adjust: String(p.adjust || ''), risk: String(p.risk || ''), recommended: p.recommended === true, ai_order: i };
    });
  return { picks, topic_note: String(out.topic_note || '') };
}

// 对候选并行跑快速适配判断。共用同一个 run 对象:attempts 和 fit_log 都记在它上面(callWithLog 只把 attempts 并回盘上的最新版)
async function prejudgeAll(run, cfg, a, picks) {
  const ctx = { title: (a.title || {}).final_title, thesis_card: a.thesis_card, protagonist: a.protagonist };
  await Promise.all(picks.map(async p => {
    const asset = store.getAsset(p.asset_id);
    if (!asset || !asset.framework) { p.prejudge = { status: 'failed', error: '框架不存在' }; return; }
    try {
      const fit = await fc().quickFit(run, cfg, asset, ctx);
      fc().logQuick(run, fit, 'prejudge');
      p.prejudge = { status: 'done', ...fit };
    } catch (e) {
      p.prejudge = { status: 'failed', error: e.message };
    }
  }));
  return picks;
}

function sortPicks(picks) {
  return picks.slice().sort((x, y) => prejudgeRank(x) - prejudgeRank(y) || (y.recommended === true) - (x.recommended === true) || x.ai_order - y.ai_order);
}

// 出推荐:同一份分析已经推荐过就不重复调用
async function suggest(runId, force) {
  const run = store.getRun(runId);
  if (!isReframe(run)) return null;
  const analysisAt = ((run.steps || {}).analysis || {}).finished_at || '';
  const rf = run.reframe || {};
  if (!force && rf.for_analysis === analysisAt && (rf.status === 'done' || busy(rf))) return rf;
  const cfg = pl().loadConfig();
  if (!cfg || !cfg.api_key) return save(runId, { status: 'failed', error: '未配置 API Key' }).reframe;
  const a = run.analysis;
  const tried = [...new Set(arr(rf.tried).concat([run.asset_id]))];
  save(runId, { status: 'suggesting', stage: '挑候选框架', started_at: new Date().toISOString(), for_analysis: analysisAt, from_asset: run.asset_id, from_name: run.asset_name || run.asset_id, reasons: arr(a.reframe_reasons).map(String), quick_only: !!a.quick_only, tried, picks: [], candidates: [], rounds: 0, none_fit: false, error: '' });
  const stale = () => ((((store.getRun(runId) || {}).steps || {}).analysis || {}).finished_at || '') !== analysisAt;
  try {
    let round = await pickRound(run, cfg, a, tried, '');
    if (stale()) return null;
    save(runId, { stage: '预判 ' + round.picks.length + ' 个候选' });
    let cands = await prejudgeAll(run, cfg, a, round.picks);
    let all = cands.slice();
    let rounds = 1;
    // 6 个全判「换框架」:排除它们再推荐一轮(最多一轮),把第一轮卡住的原因告诉它
    if (cands.length && cands.every(unfit)) {
      if (stale()) return null;
      save(runId, { stage: '第一轮 ' + cands.length + ' 个都预计不合适,再挑一轮' });
      const why = cands.map(p => '- ' + p.name + ':' + ((p.prejudge || {}).reframe_reasons || []).concat(((p.prejudge || {}).blocking || []).map(b => (b.segment ? b.segment + ' ' : '') + b.why)).slice(0, 3).join(';')).join('\n');
      const extra = '## 上一轮挑的框架,预判都套不上(不要再选,也不要选犯同样毛病的)\n' + why + '\n';
      const r2 = await pickRound(run, cfg, a, tried.concat(cands.map(p => p.asset_id)), extra);
      if (stale()) return null;
      save(runId, { stage: '预判第二轮 ' + r2.picks.length + ' 个候选' });
      const c2 = await prejudgeAll(run, cfg, a, r2.picks.map(p => ({ ...p, round: 2 })));
      rounds = 2;
      all = all.concat(c2);
      cands = all;
      round = r2;
    }
    const sorted = sortPicks(cands);
    const noneFit = sorted.length > 0 && sorted.every(unfit);
    const picks = sorted.slice(0, SHOW).map((p, i) => ({ ...p, recommended: i === 0 && !unfit(p) }));
    const fresh = store.getRun(runId) || run;
    // 推荐期间人已经换了框架或重跑了分析:这份推荐作废
    if ((((fresh.steps || {}).analysis || {}).finished_at || '') !== analysisAt) return null;
    if (run.attempts) fresh.attempts = run.attempts;
    if (run.fit_log) fresh.fit_log = run.fit_log;
    const brief = p => ({ asset_id: p.asset_id, name: p.name, round: p.round || 1, verdict: (p.prejudge || {}).verdict || '', secs: (p.prejudge || {}).secs, error: (p.prejudge || {}).error || '' });
    fresh.reframe = { ...(fresh.reframe || {}), status: 'done', stage: '', at: new Date().toISOString(), picks, candidates: all.map(brief), rounds, none_fit: noneFit, topic_note: round.topic_note };
    store.saveRun(fresh);
    return fresh.reframe;
  } catch (e) {
    const fresh = store.getRun(runId);
    if (fresh) { if (run.attempts) fresh.attempts = run.attempts; if (run.fit_log) fresh.fit_log = run.fit_log; fresh.reframe = { ...(fresh.reframe || {}), status: 'failed', stage: '', error: e.message }; store.saveRun(fresh); }
    return null;
  }
}

// 换成新框架:清掉旧分析,按任务原来的模式重跑(先写后改:分析→AI 调整→写稿一路跑完;否则停在分析等确认)
// 推荐时预判过的,预判结果带进写前分析(run.fit_carry),不再跑一次快速判断;预判是「换框架」人仍要换,就当人拍板,直接做完整分析
function switchTo(runId, assetId) {
  const run = store.getRun(runId);
  if (!run) throw Object.assign(new Error('任务不存在'), { status: 404 });
  if (run.analysis_confirmed || !['awaiting_review', 'failed', 'cancelled'].includes(run.status)) throw Object.assign(new Error('只有还没开始写稿的任务能换框架(当前: ' + run.status + ')'), { status: 400 });
  if (busy(run.reframe)) throw Object.assign(new Error('框架推荐还在生成,等它出来再换'), { status: 409 });
  const asset = store.getAsset(assetId);
  if (!asset) throw Object.assign(new Error('框架不存在: ' + assetId), { status: 404 });
  if (assetId === run.asset_id) throw Object.assign(new Error('就是现在用的框架'), { status: 400 });
  const rf = run.reframe || {};
  const pick = arr(rf.picks).find(p => p.asset_id === assetId);
  const pj = pick && pick.prejudge && pick.prejudge.status === 'done' && pick.prejudge.verdict ? pick.prejudge : null;
  // 下一次快速判断 / 推荐要参考的题目侧信息:完整分析有就取完整分析的,只做了快速判断就沿用上一份
  const a = run.analysis || {};
  const prev = a.quick_only || !a.thesis_card ? (rf.prev || null) : { title: (a.title || {}).final_title || '', thesis_card: a.thesis_card, protagonist: a.protagonist || {} };
  run.reframe = { tried: [...new Set(arr(rf.tried).concat([run.asset_id]))], switched: arr(rf.switched).concat([{ at: new Date().toISOString(), from: run.asset_id, from_name: run.asset_name || run.asset_id, to: assetId, prejudge: pj ? pj.verdict : '' }]), ...(prev ? { prev } : {}) };
  run.asset_id = assetId;
  run.asset_name = (asset.meta || {}).name || assetId;
  ['analysis', 'analysis_raw', 'analysis_original', 'analysis_edited', 'analysis_saved_at', 'track_card_name', 'error', 'fit_quick', 'fit_carry'].forEach(k => { delete run[k]; });
  if (pj) run.fit_carry = { ...pj, asset_id: assetId };
  if (run.steps) { delete run.steps.analysis; delete run.steps.auto_adjust; delete run.steps.fit_quick; }
  run.status = 'analyzing';
  store.saveRun(run);
  if (run.draft_first) require('./review').runDraftFirst(runId).catch(() => {});
  else an().runAnalysis(runId).catch(() => {});
  return { ok: true };
}

// 不换:仍按现在的框架写。先写后改的任务接着跑 AI 调整和写稿
// 只做了快速判断(没有完整分析)的:先做完整分析(不再快速判断),先写后改的做完接着写
function ignore(runId) {
  const run = store.getRun(runId);
  if (!run) throw Object.assign(new Error('任务不存在'), { status: 404 });
  if (run.analysis_confirmed || run.status !== 'awaiting_review') throw Object.assign(new Error('这个任务已经在写稿了'), { status: 400 });
  run.reframe = { ...(run.reframe || {}), status: 'ignored', ignored_at: new Date().toISOString() };
  if (run.analysis && run.analysis.quick_only) {
    const a = run.analysis;
    if (!run.reframe.prev && a.thesis_card && Object.keys(a.thesis_card).length) run.reframe.prev = { title: (a.title || {}).final_title || '', thesis_card: a.thesis_card, protagonist: a.protagonist || {} };
    delete run.analysis;
    run.status = 'analyzing';
    store.saveRun(run);
    if (run.draft_first) require('./review').runDraftFirst(runId).catch(() => {});
    else an().runAnalysis(runId).catch(() => {});
    return { ok: true, full_analysis: true };
  }
  store.saveRun(run);
  if (run.draft_first) require('./review').resumeDraftFirst(runId).catch(() => {});
  return { ok: true };
}

function startSuggest(runId) {
  const run = store.getRun(runId);
  if (!run) throw Object.assign(new Error('任务不存在'), { status: 404 });
  if (!isReframe(run)) throw Object.assign(new Error('写前分析没有判「换框架」'), { status: 400 });
  if (busy(run.reframe)) throw Object.assign(new Error('正在推荐'), { status: 409 });
  suggest(runId, true).catch(() => {});
  return { ok: true };
}

module.exports = { isReframe, shouldHold, suggest, startSuggest, switchTo, ignore, library, catalogText };
