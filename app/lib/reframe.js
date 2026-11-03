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
const SUMMARY_PROMPT = path.join(__dirname, '..', 'prompts', 'reframe_summary.md');
const PARALLEL = 6;     // 预判最多同时发几个(改题目后要判的框架可能有十几个)
const CANDIDATES = 6;   // 初选几个
const SHOW = 3;         // 预判后给人看几个
// v1.71:人从推荐里选了框架、完整分析仍判「换框架」时,程序按预判排名自动换下一个(只试预判可以写 / 调整后可写、没试过的),
// 最多试 N 个(设置里改,默认 3,0 = 不自动试);通过就接着往下跑,试完或候选用完就停下等人
const AUTO_MAX_DEFAULT = 3;
const AUTO_OK = ['可以写', '调整后可写'];
function autoMax() {
  const c = pl().loadConfig() || {};
  const n = Number(c.reframe_auto_max);
  return c.reframe_auto_max != null && Number.isFinite(n) && n >= 0 ? Math.min(10, Math.floor(n)) : AUTO_MAX_DEFAULT;
}
function setAutoMax(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 10) throw Object.assign(new Error('自动试的个数要填 0–10 的整数(0 = 不自动试)'), { status: 400 });
  const c = pl().loadConfig();
  if (!c) throw Object.assign(new Error('还没有配置文件,先在「主流程 API 配置」里保存一次'), { status: 400 });
  c.reframe_auto_max = n;
  pl().saveConfig(c);
  return { ok: true, auto_max: n };
}
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
  const prompt = an().fillVars(require('./fitrule').suggestPrompt(fs.readFileSync(PROMPT, 'utf-8')), { // v1.74:按功能重排时第 3 条换成新标准
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
  let next = 0;
  const one = async p => {
    const asset = store.getAsset(p.asset_id);
    if (!asset || !asset.framework) { p.prejudge = { status: 'failed', error: '框架不存在' }; return; }
    try {
      const fit = await fc().quickFit(run, cfg, asset, ctx);
      fc().logQuick(run, fit, 'prejudge');
      p.prejudge = { status: 'done', ...fit };
    } catch (e) {
      p.prejudge = { status: 'failed', error: e.message };
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, picks.length) }, async () => { while (next < picks.length) await one(picks[next++]); }));
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
  // 自动往下试已经停下(试完或候选用完):等人选「重新推荐 / 手动选 / 仍按某个框架写」,不自动再推荐
  if (!force && rf.status === 'auto_stopped') return rf;
  const cfg = pl().loadConfig();
  if (!cfg || !cfg.api_key) return save(runId, { status: 'failed', error: '未配置 API Key' }).reframe;
  const a = run.analysis;
  const tried = [...new Set(arr(rf.tried).concat([run.asset_id]))];
  save(runId, { status: 'suggesting', stage: '挑候选框架', started_at: new Date().toISOString(), for_analysis: analysisAt, from_asset: run.asset_id, from_name: run.asset_name || run.asset_id, reasons: arr(a.reframe_reasons).map(String), quick_only: !!a.quick_only, tried, picks: [], candidates: [], rounds: 0, none_fit: false, error: '', summary: null, summary_status: '', summary_error: '' });
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
    // pool:这次推荐预判过的全部候选(按预判排好),人选了其中一个以后,自动往下试就从这里按顺序取
    const pool = sorted.concat(sortPicks(all.filter(p => !sorted.includes(p)))).map(p => ({ asset_id: p.asset_id, name: p.name, source: p.source, track: p.track, why: p.why, risk: p.risk, round: p.round || 1, prejudge: p.prejudge }));
    fresh.reframe = { ...(fresh.reframe || {}), status: 'done', stage: '', at: new Date().toISOString(), picks, candidates: all.map(brief), pool, rounds, none_fit: noneFit, topic_note: round.topic_note };
    store.saveRun(fresh);
    // 两轮都预计不合适:汇总「为什么都套不上」,给「改主题 / 不改继续写」两条路(v1.71)
    if (noneFit) { await summarize(runId); return (store.getRun(runId) || {}).reframe; }
    return fresh.reframe;
  } catch (e) {
    const fresh = store.getRun(runId);
    if (fresh) { if (run.attempts) fresh.attempts = run.attempts; if (run.fit_log) fresh.fit_log = run.fit_log; fresh.reframe = { ...(fresh.reframe || {}), status: 'failed', stage: '', error: e.message }; store.saveRun(fresh); }
    return null;
  }
}

// 换成新框架:清掉旧分析,按任务原来的模式重跑(先写后改:分析→AI 调整→写稿一路跑完;否则停在分析等确认)
// 推荐时预判过的,预判结果带进写前分析(run.fit_carry),不再跑一次快速判断;预判是「换框架」人仍要换,就当人拍板,直接做完整分析
// opts.by:user = 人选的(每选一次,自动往下试的次数重新算)/ auto = 程序自动换的;opts.keep:仍按这个框架写(不判、不推荐,直接做完整分析往下走)
function switchTo(runId, assetId, opts) {
  const o = opts || {};
  const by = o.by === 'auto' ? 'auto' : 'user';
  const run = store.getRun(runId);
  if (!run) throw Object.assign(new Error('任务不存在'), { status: 404 });
  if (run.analysis_confirmed || !['awaiting_review', 'failed', 'cancelled'].includes(run.status)) throw Object.assign(new Error('只有还没开始写稿的任务能换框架(当前: ' + run.status + ')'), { status: 400 });
  if (busy(run.reframe)) throw Object.assign(new Error('框架推荐还在生成,等它出来再换'), { status: 409 });
  const asset = store.getAsset(assetId);
  if (!asset) throw Object.assign(new Error('框架不存在: ' + assetId), { status: 404 });
  if (assetId === run.asset_id) throw Object.assign(new Error('就是现在用的框架'), { status: 400 });
  const rf = run.reframe || {};
  const pool = arr(rf.pool);
  const pick = arr(rf.picks).find(p => p.asset_id === assetId) || pool.find(p => p.asset_id === assetId);
  const pj = !o.keep && pick && pick.prejudge && pick.prejudge.status === 'done' && pick.prejudge.verdict ? pick.prejudge : null;
  // 下一次快速判断 / 推荐要参考的题目侧信息:完整分析有就取完整分析的,只做了快速判断就沿用上一份
  const a = run.analysis || {};
  const prev = a.quick_only || !a.thesis_card ? (rf.prev || null) : { title: (a.title || {}).final_title || '', thesis_card: a.thesis_card, protagonist: a.protagonist || {} };
  const toName = (asset.meta || {}).name || assetId;
  const fromReasons = a.verdict === '换框架' ? arr(a.reframe_reasons).map(String).slice(0, 5) : [];
  // 自动往下试(v1.71):只有人从这次推荐里选过以后才开;人每选一次重新计数
  let auto = null;
  if (by === 'auto') auto = rf.auto || null;
  else if (pool.length && !o.keep) {
    const max = autoMax();
    if (max > 0) auto = { max, steps: [], user_pick: assetId, user_pick_name: toName, started_at: new Date().toISOString() };
  }
  run.reframe = {
    // 改了题目以后(resetTried):旧题目下试过的不算,现在这个框架也还能再被自动试到
    tried: o.resetTried ? [] : [...new Set(arr(rf.tried).concat([run.asset_id]))],
    switched: arr(rf.switched).concat([{ at: new Date().toISOString(), from: run.asset_id, from_name: run.asset_name || run.asset_id, to: assetId, to_name: toName, prejudge: pj ? pj.verdict : '', by, ...(o.keep ? { keep: true } : {}), ...(fromReasons.length ? { from_reasons: fromReasons } : {}) }]),
    ...(prev ? { prev } : {}),
    ...(pool.length ? { pool } : {}),
    ...(auto ? { auto } : {}),
    ...(o.keep ? { status: 'ignored', ignored_at: new Date().toISOString() } : {})
  };
  if (!o.keep) delete run.keep_notes; // 「不改,继续写」的写不成立段落只跟着人最初选的框架走
  run.asset_id = assetId;
  run.asset_name = toName;
  ['analysis', 'analysis_raw', 'analysis_original', 'analysis_edited', 'analysis_saved_at', 'track_card_name', 'error', 'fit_quick', 'fit_carry'].forEach(k => { delete run[k]; });
  if (pj) run.fit_carry = { ...pj, asset_id: assetId };
  if (run.steps) { delete run.steps.analysis; delete run.steps.auto_adjust; delete run.steps.fit_quick; }
  run.status = 'analyzing';
  store.saveRun(run);
  if (run.draft_first) require('./review').runDraftFirst(runId).catch(() => {});
  else an().runAnalysis(runId).catch(() => {});
  return { ok: true };
}

// 自动往下试(v1.71):写前分析(完整分析,或只做了快速判断)判了「换框架」时调用。
// 返回 'switched' = 已经自动换成下一个;'stopped' = 试完或候选用完,停下等人;null = 不归它管(人还没从推荐里选过 / 设置成 0 / 人选了仍按这个写)
function autoNext(runId) {
  const run = store.getRun(runId);
  if (!isReframe(run)) return null;
  const rf = run.reframe || {};
  if (!rf.auto || !rf.auto.max || !arr(rf.pool).length || rf.status === 'ignored') return null;
  const a = run.analysis || {};
  const now = new Date().toISOString();
  const fail = { asset_id: run.asset_id, name: run.asset_name || run.asset_id, quick_only: !!a.quick_only, reasons: arr(a.reframe_reasons).map(String).slice(0, 5), verdict_reason: String(a.verdict_reason || ''), at: now };
  const steps = arr(rf.auto.steps);
  const tried = new Set(arr(rf.tried).concat([run.asset_id]));
  const next = arr(rf.pool).find(p => AUTO_OK.includes((p.prejudge || {}).verdict) && !tried.has(p.asset_id));
  if (steps.length >= rf.auto.max || !next) {
    run.reframe = { ...rf, status: 'auto_stopped', summary: null, summary_status: '', summary_error: '', auto: { ...rf.auto, last_fail: fail, stopped: { at: now, why: steps.length >= rf.auto.max ? 'max' : 'exhausted' } } };
    store.saveRun(run);
    summarize(runId).catch(() => {});
    return 'stopped';
  }
  run.reframe = { ...rf, auto: { ...rf.auto, steps: steps.concat([{ from: fail, to: next.asset_id, to_name: next.name, prejudge: next.prejudge.verdict, at: now }]) } };
  store.saveRun(run);
  try { switchTo(runId, next.asset_id, { by: 'auto' }); }
  catch (e) {
    const f = store.getRun(runId);
    if (f) { f.reframe = { ...(f.reframe || {}), status: 'auto_stopped', auto: { ...((f.reframe || {}).auto || {}), last_fail: fail, stopped: { at: now, why: 'error', error: e.message } } }; store.saveRun(f); }
    return 'stopped';
  }
  return 'switched';
}

// ---------- 都套不上时(v1.71):为什么都套不上 + 两条路(改主题 / 不改继续写) ----------
// 走到头:两轮推荐都预计不合适(none_fit),或者自动往下试停下了(auto_stopped)
const deadEnd = rf => !!(rf && ((rf.status === 'done' && rf.none_fit) || rf.status === 'auto_stopped'));
// 人最初选的框架:第一次换框架之前的那个
function originOf(run) {
  const sw = arr((run.reframe || {}).switched)[0];
  const id = sw ? sw.from : run.asset_id;
  return { asset_id: id, name: sw ? (sw.from_name || id) : (run.asset_name || id) };
}
function logEvent(run, ev) { run.fit_log = arr(run.fit_log).concat([{ event: ev.event, at: new Date().toISOString(), ...ev }]).slice(-80); }
const pjLine = p => {
  const pj = p.prejudge || {};
  const bl = arr(pj.blocking).map(b => (b.segment ? b.segment + ':' : '') + b.why).slice(0, 4).join(';');
  return '- ' + p.name + ' | 预判:' + (pj.verdict || '没判成') + (pj.verdict_reason ? ' | ' + pj.verdict_reason : '') + (bl ? ' | 撑不住:' + bl : '') + (arr(pj.reframe_reasons).length ? ' | 原因:' + arr(pj.reframe_reasons).slice(0, 3).join(';') : '');
};
const summaryOk = o => !!(o && typeof o === 'object' && String(o.summary || '').trim() && ['title', 'library'].includes(String(o.cause || '').trim()));
const summaryBusy = new Set();
async function summarize(runId) {
  if (summaryBusy.has(runId)) return;
  const run = store.getRun(runId);
  if (!run || !deadEnd(run.reframe)) return;
  const cfg = pl().loadConfig();
  if (!cfg || !cfg.api_key) return;
  summaryBusy.add(runId);
  const key = JSON.stringify([run.reframe.status, run.reframe.at || '', (run.reframe.auto || {}).stopped || '']);
  save(runId, { summary_status: 'running', summary_error: '' });
  try {
    const rf = run.reframe;
    const origin = originOf(run);
    const a = run.analysis || {};
    const tc = arr(run.topic_changes);
    // v1.75:改过题目以后,只拿「改题目之后」的理由去汇总。以前拿的是原题目下最初那个框架被否的理由,
    // AI 照着旧题目的毛病又判「问题出在题目」、又让人改题目(조선 여성 거상 改题后又被要求改题)
    const since = tc.length ? String(tc[tc.length - 1].at || '') : '';
    const sw = arr(rf.switched).filter(x => !since || String(x.at || '') > since);
    const poolOrigin = arr(rf.pool).find(p => p.asset_id === origin.asset_id);
    const originReasons = origin.asset_id === run.asset_id && a.verdict === '换框架' ? arr(a.reframe_reasons)
      : since ? (sw[0] && sw[0].from === origin.asset_id && arr(sw[0].from_reasons).length ? arr(sw[0].from_reasons) : (poolOrigin ? [pjLine(poolOrigin).replace(/^- /, '按新题目预判:')] : []))
      : arr((sw[0] || {}).from_reasons);
    const tried = sw.filter(x => arr(x.from_reasons).length && x.from !== origin.asset_id).map(x => '- ' + (x.from_name || x.from) + ':' + arr(x.from_reasons).slice(0, 3).join(';'));
    if (origin.asset_id !== run.asset_id && a.verdict === '换框架') tried.push('- ' + (run.asset_name || run.asset_id) + ':' + arr(a.reframe_reasons).slice(0, 3).join(';'));
    const used = topicsUsed(run);
    const targets = [{ asset_id: origin.asset_id, name: origin.name }].concat(arr(rf.pool).filter(p => p.asset_id !== origin.asset_id).map(p => ({ asset_id: p.asset_id, name: p.name })))
      .filter(x => store.getAsset(x.asset_id)).slice(0, 12);
    const prompt = an().fillVars(fs.readFileSync(SUMMARY_PROMPT, 'utf-8'), {
      topic: run.topic || '',
      topic_history: tc.length ? '【这个题目是改过的】原题目:' + (run.original_title || tc[0].from) + '。改了题目以后还是都套不上,汇总时要说明这一点。下面的理由都是按现在的题目判的,只根据它们写,不要沿用原题目的毛病。' : '',
      used_topics: used.map(t => '- ' + t).join('\n'),
      target_language: (run.audience || {}).target_language || '', target_country: (run.audience || {}).target_country || '',
      origin: origin.name,
      origin_id: origin.asset_id,
      origin_reasons: originReasons.map((r, i) => (i + 1) + '. ' + r).join('\n') || (a.verdict_reason || '(没有记录)'),
      tried: tried.join('\n') || '(没有)',
      candidates: arr(rf.pool).map(pjLine).join('\n') || '(没有)',
      targets: targets.map(x => '- ' + x.asset_id + ' | ' + x.name).join('\n')
    });
    const out = await an().callJson(run, cfg, prompt, '换框架·为什么都套不上', summaryOk);
    const str = v => String(v == null ? '' : v).trim();
    const usedKey = new Set(used.map(topicKey));
    const summary = {
      at: new Date().toISOString(), text: str(out.summary), cause: str(out.cause), cause_why: str(out.cause_why),
      // 已经用过的题目(原题目、改过的)不再建议
      topics: arr(out.topics).filter(t => t && str(t.title) && !usedKey.has(topicKey(t.title))).map(t => ({ title: str(t.title), zh: str(t.zh), why: str(t.why), target: str(t.target) })).slice(0, 3),
      keep_tips: arr(out.keep_tips).filter(t => t && (str(t.segment) || str(t.how))).map(t => ({ segment: str(t.segment), why: str(t.why), how: str(t.how) })).slice(0, 8)
    };
    // v1.75:建议的题目先各做一次快速判断(对着它说能套上的框架,没说或说错就对人最初选的框架),套得上的排前面
    save(runId, { summary_status: 'checking' });
    await checkTopics(run, cfg, summary.topics, origin, targets);
    summary.topics.sort((x, y) => topicRank(x) - topicRank(y));
    if (summary.topics.length && !summary.topics.some(t => AUTO_OK.includes((t.check || {}).verdict)) && summary.topics.some(t => (t.check || {}).verdict)) {
      summary.topics_none_fit = true;
      if (summary.cause === 'title') { summary.cause = 'library'; summary.cause_note = 'AI 原本判「问题出在题目」,但它建议的新题目预判也都套不上,所以改成推荐「不改,继续写」。'; }
    }
    const fresh = store.getRun(runId);
    if (!fresh) return;
    if (run.attempts) fresh.attempts = run.attempts;
    if (run.fit_log) fresh.fit_log = run.fit_log; // v1.75:建议题目的预判也记进 fit_log
    // 汇总期间人已经做了选择(换框架、改主题、不改继续写):这份汇总作废,只留调用记录
    if (!deadEnd(fresh.reframe) || JSON.stringify([fresh.reframe.status, fresh.reframe.at || '', (fresh.reframe.auto || {}).stopped || '']) !== key) { store.saveRun(fresh); return; }
    fresh.reframe = { ...fresh.reframe, summary, summary_status: 'done', summary_error: '' };
    logEvent(fresh, { event: 'summary', cause: summary.cause, summary: summary.text.slice(0, 400), topic: fresh.topic });
    store.saveRun(fresh);
  } catch (e) {
    const fresh = store.getRun(runId);
    if (fresh) { if (run.attempts) fresh.attempts = run.attempts; if (fresh.reframe) fresh.reframe = { ...fresh.reframe, summary_status: 'failed', summary_error: e.message }; store.saveRun(fresh); }
  } finally { summaryBusy.delete(runId); }
}
// v1.75:用过的题目(原题目 + 每次改的),比较时去掉空格和标点
function topicsUsed(run) {
  const tc = arr(run.topic_changes);
  const list = [run.original_title || (tc[0] || {}).from || run.topic].concat(tc.map(x => x.to)).concat([run.topic]).map(t => String(t || '').trim()).filter(Boolean);
  return list.filter((t, i) => list.findIndex(x => topicKey(x) === topicKey(t)) === i);
}
function topicKey(t) { return String(t || '').replace(/[\s.,!?;:'"“”‘’「」『』()()\-—…?!,。、]/g, '').toLowerCase(); }
const topicRank = t => { const v = (t.check || {}).verdict; return v === '可以写' ? 0 : v === '调整后可写' ? 1 : v ? 3 : 2; };
// 建议的题目各快速判断一次(并行,最多 3 个)。题目侧只有题目本身(和改主题后重新挑框架时一样),结果记进 fit_log(by=topic_check)
async function checkTopics(run, cfg, topics, origin, targets) {
  const ids = new Set(targets.map(x => x.asset_id));
  await Promise.all(topics.map(async t => {
    const id = ids.has(t.target) ? t.target : origin.asset_id;
    const asset = store.getAsset(id);
    const name = (targets.find(x => x.asset_id === id) || {}).name || ((asset || {}).meta || {}).name || id;
    if (!asset || !asset.framework) { t.check = { asset_id: id, name, status: 'failed', error: '框架不存在' }; return; }
    try {
      const fit = await fc().quickFit(run, cfg, asset, { title: t.title, topic: t.title });
      fc().logQuick(run, fit, 'topic_check');
      t.check = { status: 'done', name, keep_origin: id === origin.asset_id, title: t.title, ...fit };
    } catch (e) { t.check = { asset_id: id, name, status: 'failed', error: e.message }; }
  }));
}
// ---------- 建任务前预判(v1.75) ----------
// 第 2 步填好题目后点「看看这个框架合不合适」:人选的框架快速判断一次,同时从库里挑 6 个候选并行预判,给人看最合适的 3 个。
// 还没有任务:用一个只在内存里的对象(ephemeral)调 AI,不落盘。结果缓存 30 分钟,
// 人照这个框架和题目建任务时,写前分析直接用这次的判断(和换框架时一样带 fit_carry),不再判一次。
const PRE_TTL = 30 * 60 * 1000;
const preCache = new Map();
function preKey(b) {
  const aud = b.audience || {};
  return JSON.stringify([String(b.topic || '').trim(), aud.target_language || '', aud.target_country || '', aud.target_audience || '', aud.video_goal || '', String(b.materials || '').trim()]);
}
function preRemember(key, assetId, fit) {
  const now = Date.now();
  for (const [k, v] of preCache) if (now - v.at > PRE_TTL) preCache.delete(k);
  const e = preCache.get(key) || { at: now, fits: {} };
  e.at = now; e.fits[assetId] = fit;
  preCache.set(key, e);
}
// 建任务时取这次预判(同题目、同受众、同资料、同框架,30 分钟内)
function precheckCarry(body) {
  const e = preCache.get(preKey(body));
  if (!e || Date.now() - e.at > PRE_TTL) return null;
  const fit = e.fits[body.asset_id];
  return fit && fit.verdict ? { ...fit, asset_id: body.asset_id } : null;
}
// v1.75.2:这次预判判过的全部框架(按结论排好)。建任务时放进 run.reframe.pool,
// 完整写前分析仍判「换框架」时,按 v1.71 的规则自动往下试预判合适的,不用再从头推荐
function precheckPool(body) {
  const e = preCache.get(preKey(body));
  if (!e || Date.now() - e.at > PRE_TTL || !arr(e.pool).length) return null;
  return e.pool;
}
// 建任务时调用:有预判就带上判断结果和候选池,并打开自动往下试(设置里是 0 就不开)
function applyPrecheck(run, body) {
  const fit = precheckCarry(body);
  if (!fit) return false;
  run.fit_carry = fit;
  run.precheck = { at: new Date().toISOString(), verdict: fit.verdict };
  // v1.75.3:预判说这个框架套不上,人没换、仍点了开始生成 = 人决定用这个框架写。
  // 和「不改,继续写」一样:不再判换框架、不再推荐、不自动换;套不上的段落交给写前分析、蓝图、写稿、审稿换个讲法,不硬编
  if (fit.verdict === '换框架') {
    const segs = arr(fit.blocking).filter(b => b && (b.segment || b.why)).map(b => ({ segment: String(b.segment || ''), why: String(b.why || ''), how: '' }));
    const reasons = segs.length ? segs : arr(fit.reframe_reasons).map(r => ({ segment: '', why: String(r), how: '' }));
    run.keep_notes = { at: run.precheck.at, by: 'precheck', summary: String(fit.verdict_reason || '建任务前预判:这个框架套不上这个题目,人决定仍用它写'), segments: reasons.slice(0, 8) };
    run.reframe = { status: 'ignored', ignored_at: run.precheck.at, by: 'precheck_insist', tried: [], switched: [] };
    run.precheck.insist = true;
    logEvent(run, { event: 'choice', choice: 'keep', by: 'precheck', framework: run.asset_id, topic: run.topic });
    return true;
  }
  const pool = arr(precheckPool(body)).filter(p => store.getAsset(p.asset_id));
  const max = autoMax();
  if (pool.some(p => p.asset_id !== run.asset_id && AUTO_OK.includes((p.prejudge || {}).verdict)) && max > 0) {
    run.reframe = { pool, tried: [], switched: [], from_precheck: true, auto: { max, steps: [], user_pick: run.asset_id, user_pick_name: run.asset_name || run.asset_id, by: 'precheck', started_at: run.precheck.at } };
    run.precheck.pool = pool.length;
  }
  return true;
}
// 预判要 2–3 分钟(挑候选要读整个同赛道目录),做成后台任务:页面每 2 秒来取一次进度;
// 人选的框架先判完先给结果,推荐的候选判完再补上
const preJobs = new Map();
let preSeq = 0;
function startPrecheck(body) {
  const b = body || {};
  const topic = String(b.topic || '').trim();
  if (!topic) throw Object.assign(new Error('先填新主题'), { status: 400 });
  if (topic.length > 300) throw Object.assign(new Error('主题太长(最多 300 字)'), { status: 400 });
  const asset = store.getAsset(b.asset_id);
  if (!asset || !asset.framework) throw Object.assign(new Error('框架不存在: ' + (b.asset_id || '')), { status: 404 });
  const cfg = pl().loadConfig();
  if (!cfg || !cfg.api_key) throw Object.assign(new Error('未配置 API Key,请先在设置中填写'), { status: 400 });
  const now = Date.now();
  for (const [k, j] of preJobs) if (now - j.t0 > PRE_TTL) preJobs.delete(k);
  const sig = preKey(b) + '|' + asset.id;
  for (const [k, j] of preJobs) if (j.sig === sig && j.status === 'running') return { job_id: k, reused: true };
  const id = 'pre_' + now.toString(36) + '_' + (++preSeq);
  const job = { sig, t0: now, status: 'running', stage: '判你选的框架,同时挑候选', topic, selected: { asset_id: asset.id, name: (asset.meta || {}).name || asset.id, prejudge: null }, picks: [], others: [], topic_note: '', pick_error: '', error: '' };
  preJobs.set(id, job);
  runPrecheck(job, b, asset, cfg).catch(e => { job.status = 'failed'; job.error = e.message; });
  return { job_id: id };
}
function getPrecheck(id) {
  const j = preJobs.get(String(id || ''));
  if (!j) throw Object.assign(new Error('预判结果过期了(超过 30 分钟或程序重启过),重新点一次'), { status: 404 });
  const { sig, t0, ...rest } = j;
  return { ...rest, secs: Math.round((((j.done_at || Date.now()) - t0)) / 100) / 10 };
}
async function runPrecheck(job, b, asset, cfg) {
  const topic = job.topic;
  const aud = b.audience || {};
  const run = {
    id: 'precheck', ephemeral: true, topic, asset_id: asset.id, asset_name: job.selected.name,
    audience: { target_language: aud.target_language || 'English', target_country: aud.target_country || 'US', target_audience: aud.target_audience || '', video_goal: aud.video_goal || '10分钟' },
    materials: typeof b.materials === 'string' ? b.materials.trim() : ''
  };
  const a = { title: { final_title: topic }, thesis_card: {}, protagonist: {} };
  const key2 = preKey(b);
  const selDone = fc().quickFit(run, cfg, asset, {}).then(f => ({ status: 'done', ...f }), e => ({ status: 'failed', error: e.message })).then(p => {
    job.selected = { ...job.selected, prejudge: p };
    if (p.status === 'done') preRemember(key2, asset.id, p);
    if (job.status === 'running') job.stage = '你选的框架判完了,还在挑候选';
  });
  const round = await pickRound(run, cfg, { ...a, reframe_reasons: [], verdict_reason: '还没开始写,建任务前先看看:人选了「' + run.asset_name + '」,从库里挑 6 个能套上这个题目的框架给人比较(人选的那个程序另外判,不要选它)' }, [asset.id], '')
    .catch(e => ({ picks: [], topic_note: '', error: e.message }));
  job.topic_note = String(round.topic_note || '');
  job.pick_error = round.error || '';
  job.stage = '预判 ' + (round.picks || []).length + ' 个候选';
  const picks = await prejudgeAll(run, cfg, a, round.picks || []);
  await selDone;
  const sorted = sortPicks(picks);
  sorted.forEach(p => { if (p.prejudge && p.prejudge.status === 'done') preRemember(key2, p.asset_id, p.prejudge); });
  // 候选池:人选的框架 + 判过的候选,按结论排好(建任务后自动往下试从这里取)
  const poolOf = p => ({ asset_id: p.asset_id, name: p.name, source: p.source || '', track: p.track || '', why: p.why || '', risk: p.risk || '', round: 1, prejudge: p.prejudge });
  const all = sortPicks([{ asset_id: asset.id, name: job.selected.name, prejudge: job.selected.prejudge, ai_order: -1 }].concat(picks)).filter(p => p.prejudge && p.prejudge.status === 'done');
  const ce = preCache.get(key2);
  if (ce) ce.pool = all.map(poolOf);
  const brief = p => ({ asset_id: p.asset_id, name: p.name, source: p.source, track: p.track, why: p.why, adjust: p.adjust, risk: p.risk, prejudge: p.prejudge });
  job.picks = sorted.slice(0, SHOW).map(brief);
  job.others = sorted.slice(SHOW).map(brief);
  job.calls = arr(run.attempts).length;
  job.done_at = Date.now();
  job.stage = '';
  job.status = 'done';
}

function startSummary(runId) {
  const run = store.getRun(runId);
  if (!run) throw Object.assign(new Error('任务不存在'), { status: 404 });
  if (!deadEnd(run.reframe)) throw Object.assign(new Error('现在不是「都套不上」的状态'), { status: 400 });
  summarize(runId).catch(() => {});
  return { ok: true };
}

// 写不成立的段落(人选了「不改,继续写」):写前分析、蓝图、写稿、复审都带上,要求换个讲法、不硬编
function keepNotesFrom(run) {
  const rf = run.reframe || {};
  const sm = rf.summary || {};
  let segs = arr(sm.keep_tips);
  if (!segs.length) {
    const a = run.analysis || {};
    const origin = originOf(run);
    const reasons = origin.asset_id === run.asset_id && a.verdict === '换框架' ? arr(a.reframe_reasons) : arr((arr(rf.switched)[0] || {}).from_reasons);
    segs = reasons.map(r => ({ segment: '', why: String(r), how: '' }));
  }
  return { at: new Date().toISOString(), summary: sm.text || '', segments: segs.slice(0, 8) };
}

// ② 不改,继续写:用人最初选的框架写(沿用「不换,仍按现在的框架写」),写不成立的段落交给后面换个讲法
function keepOrigin(runId) {
  const run = store.getRun(runId);
  if (!run) throw Object.assign(new Error('任务不存在'), { status: 404 });
  if (run.analysis_confirmed || run.status !== 'awaiting_review') throw Object.assign(new Error('这个任务已经在写稿了'), { status: 400 });
  if (busy(run.reframe)) throw Object.assign(new Error('框架推荐还在生成,等它出来再选'), { status: 409 });
  const origin = originOf(run);
  run.keep_notes = keepNotesFrom(run);
  logEvent(run, { event: 'choice', choice: 'keep', framework: origin.asset_id, topic: run.topic });
  store.saveRun(run);
  if (origin.asset_id === run.asset_id) return { ...ignore(runId), keep: true };
  return { ...switchTo(runId, origin.asset_id, { keep: true }), keep: true };
}

// ① 改主题:题目改成新的(原题目存进记录),按新题目重新预判最初的框架和上一轮的候选,不够就重新推荐一轮;
// 第一个预判合适的直接做完整分析,不过就按自动往下试接着换;还是都不合适就再停一次(不自动循环)
function retopic(runId, title) {
  const run = store.getRun(runId);
  if (!run) throw Object.assign(new Error('任务不存在'), { status: 404 });
  if (run.analysis_confirmed || run.status !== 'awaiting_review') throw Object.assign(new Error('这个任务已经在写稿了,不能改题目'), { status: 400 });
  if (busy(run.reframe)) throw Object.assign(new Error('框架推荐还在生成,等它出来再改'), { status: 409 });
  const t = String(title || '').trim();
  if (!t) throw Object.assign(new Error('新题目是空的'), { status: 400 });
  if (t.length > 200) throw Object.assign(new Error('新题目太长(最多 200 字)'), { status: 400 });
  if (t === run.topic) throw Object.assign(new Error('新题目和现在的一样'), { status: 400 });
  const cfg = pl().loadConfig();
  if (!cfg || !cfg.api_key) throw Object.assign(new Error('未配置 API Key'), { status: 400 });
  const rf = run.reframe || {};
  const origin = originOf(run);
  const now = new Date().toISOString();
  // v1.75:选的是建议题目、而且它预判套得上:改题目后直接用那个框架做完整分析,不再判一次
  const sug = arr((rf.summary || {}).topics).find(x => topicKey(x.title) === topicKey(t) && x.check && x.check.status === 'done' && AUTO_OK.includes(x.check.verdict) && store.getAsset(x.check.asset_id));
  const carry = sug ? { asset_id: sug.check.asset_id, name: sug.check.name, prejudge: sug.check } : null;
  run.original_title = run.original_title || run.topic;
  run.topic_changes = arr(run.topic_changes).concat([{ from: run.topic, to: t, at: now }]);
  logEvent(run, { event: 'choice', choice: 'retopic', from: run.topic, to: t });
  run.topic = t;
  delete run.keep_notes;
  ['analysis', 'analysis_raw', 'analysis_original', 'analysis_edited', 'analysis_saved_at', 'error', 'fit_quick', 'fit_carry'].forEach(k => { delete run[k]; });
  run.steps = { ...(run.steps || {}), analysis: { status: 'running', started_at: now, stage: '按新题目重新挑框架' } };
  delete run.steps.auto_adjust; delete run.steps.fit_quick;
  run.reframe = { switched: arr(rf.switched), tried: [], origin, pool: arr(rf.pool), status: 'suggesting', stage: '按新题目预判框架', started_at: now, retopic: { from: run.topic_changes.slice(-1)[0].from, to: t, at: now, ...(carry ? { carry } : {}) }, picks: [], candidates: [] };
  run.status = 'analyzing';
  store.saveRun(run);
  try { require('./topiczh').ensure([t]); } catch (e) { /* 中文译文补不上不影响 */ }
  refit(runId).catch(e => {
    const f = store.getRun(runId);
    if (f) { f.status = 'failed'; f.error = '改题目后重新挑框架失败: ' + e.message; f.reframe = { ...(f.reframe || {}), status: 'failed', stage: '', error: e.message }; store.saveRun(f); }
  });
  return { ok: true };
}
async function refit(runId) {
  const run = store.getRun(runId);
  const cfg = pl().loadConfig();
  const rf = run.reframe;
  const lib = library();
  const a = { title: { final_title: run.topic }, thesis_card: {}, protagonist: {} };
  const carry = (rf.retopic || {}).carry || null;
  const cand = (id, i) => { const x = lib.find(l => l.id === id) || {}; const old = arr(rf.pool).find(p => p.asset_id === id) || {}; return { asset_id: id, name: x.name || id, source: x.source || '', track: x.track || '', why: old.why || '', risk: old.risk || '', recommended: id === rf.origin.asset_id || !!(carry && id === carry.asset_id), ai_order: carry && id === carry.asset_id ? -1 : i }; };
  const setStage = st => { const f = store.getRun(runId); if (!f) return; if (run.attempts) f.attempts = run.attempts; if (run.fit_log) f.fit_log = run.fit_log; f.reframe = { ...(f.reframe || {}), stage: st }; f.steps = { ...(f.steps || {}), analysis: { ...((f.steps || {}).analysis || {}), stage: st } }; store.saveRun(f); };
  // v1.75:先按新题目重新推荐一轮。以前只判「最初的框架 + 上一轮的候选」,上一轮的候选是按旧题目挑的
  // (比如旧题目挑的全是阶梯框架),判得过快速判断、过不了完整分析,自动试完又停下让人改题目
  const baseIds = [...new Set([carry && carry.asset_id, rf.origin.asset_id, run.asset_id].filter(Boolean))].filter(id => store.getAsset(id));
  let topicNote = '';
  let fresh1 = [];
  try {
    setStage('按新题目挑候选框架');
    const last = arr(run.topic_changes).slice(-1)[0] || {};
    const ra = { ...a, reframe_reasons: [], verdict_reason: '题目从「' + (last.from || '') + '」改成了「' + run.topic + '」,按新题目从头挑最合适的框架(不要因为旧题目的毛病排除框架)' };
    const r1 = await pickRound(run, cfg, ra, baseIds, '');
    fresh1 = r1.picks.map(p => ({ ...p, ai_order: p.ai_order + 10 }));
    topicNote = r1.topic_note;
  } catch (e) {
    // 推荐失败:退回以前的做法,判上一轮的候选
    topicNote = '按新题目推荐没成功(' + e.message + '),先判上一轮的候选';
    fresh1 = arr(rf.pool).map(p => p.asset_id).filter(id => !baseIds.includes(id) && store.getAsset(id)).slice(0, 10).map((id, i) => cand(id, i + 10));
  }
  const first1 = baseIds.map((id, i) => cand(id, i)).concat(fresh1).slice(0, 13);
  const carried = carry ? first1.filter(p => p.asset_id === carry.asset_id).map(p => ({ ...p, prejudge: { ...carry.prejudge, asset_id: carry.asset_id } })) : [];
  const toJudge = first1.filter(p => !carried.includes(p) && !(carry && p.asset_id === carry.asset_id));
  setStage('按新题目预判 ' + toJudge.length + ' 个框架' + (carried.length ? '(你选的题目已预判过「' + carried[0].name + '」)' : ''));
  let all = carried.concat(await prejudgeAll(run, cfg, a, toJudge));
  let rounds = 1;
  // 一个合适的都没有:按新题目重新推荐一轮(排除判过的)
  if (!all.some(p => AUTO_OK.includes((p.prejudge || {}).verdict))) {
    setStage('都不合适,按新题目重新推荐');
    const why = all.map(p => '- ' + p.name + ':' + arr((p.prejudge || {}).reframe_reasons).slice(0, 2).join(';')).join('\n');
    // v1.75:不再带旧题目的汇总(那是按原题目判的),只带按新题目判过的结论(下面 why)
    const ra = { ...a, reframe_reasons: [], verdict_reason: '改了题目,按新题目挑的框架还是套不上' };
    // 重新推荐失败不算整篇失败:当作没有更多候选,下面照样停下来给原因汇总和两条路
    try {
      const r2 = await pickRound(run, cfg, ra, all.map(p => p.asset_id), '## 按新题目判过的框架,都套不上(不要再选)\n' + why + '\n');
      setStage('预判新推荐的 ' + r2.picks.length + ' 个候选');
      const c2 = await prejudgeAll(run, cfg, a, r2.picks.map(p => ({ ...p, round: 2, ai_order: p.ai_order + 100 })));
      all = all.concat(c2); rounds = 2; topicNote = r2.topic_note || topicNote;
    } catch (e) { topicNote = '按新题目重新推荐没成功:' + e.message; }
  }
  const sorted = sortPicks(all);
  const pool = sorted.map(p => ({ asset_id: p.asset_id, name: p.name, source: p.source, track: p.track, why: p.why, risk: p.risk, round: p.round || 1, prejudge: p.prejudge }));
  const brief = p => ({ asset_id: p.asset_id, name: p.name, round: p.round || 1, verdict: (p.prejudge || {}).verdict || '', secs: (p.prejudge || {}).secs, error: (p.prejudge || {}).error || '' });
  const first = sorted.find(p => AUTO_OK.includes((p.prejudge || {}).verdict));
  const fresh = store.getRun(runId);
  if (!fresh || fresh.status !== 'analyzing' || fresh.topic !== run.topic) return; // 期间人取消了 / 又改了
  if (run.attempts) fresh.attempts = run.attempts;
  if (run.fit_log) fresh.fit_log = run.fit_log;
  const now = new Date().toISOString();
  const picks = sorted.slice(0, SHOW).map((p, i) => ({ ...p, recommended: i === 0 && !unfit(p) }));
  const base = { ...(fresh.reframe || {}), stage: '', at: now, pool, picks, candidates: all.map(brief), rounds, topic_note: topicNote };
  if (!first) {
    // 改了题目还是都不合适:再停一次(现在的框架记一份只有快速判断的分析),给新的原因汇总和同样的两条路,不自动循环
    const curP = all.find(p => p.asset_id === fresh.asset_id) || all[0];
    const fit = { verdict: '换框架', verdict_reason: '', blocking: [], adjust: [], reframe_reasons: [], pov_mode: 'none', pov_basis: '', asset_id: fresh.asset_id, secs: null, at: now, ...((curP && curP.prejudge && curP.prejudge.verdict) ? curP.prejudge : {}) };
    fresh.analysis = fc().stubAnalysis(fresh, fit, { title: fresh.topic });
    fresh.fit_quick = { ...fit, by: 'prejudge' };
    fresh.steps = { ...(fresh.steps || {}), analysis: { status: 'done', quick_only: true, secs: fit.secs, finished_at: now } };
    fresh.status = 'awaiting_review';
    fresh.reframe = { ...base, status: 'done', none_fit: true, for_analysis: now, from_asset: fresh.asset_id, from_name: fresh.asset_name, reasons: fresh.analysis.reframe_reasons, summary: null, summary_status: '' };
    store.saveRun(fresh);
    await summarize(runId);
    return;
  }
  // 第一个预判合适的直接做完整分析(预判带进去);不过就按设置自动往下试
  const max = autoMax();
  fresh.reframe = { ...base, status: '', none_fit: false, summary: null, summary_status: '', ...(max > 0 ? { auto: { max, steps: [], user_pick: first.asset_id, user_pick_name: first.name, by: 'retopic', started_at: now } } : {}) };
  if (max <= 0) delete fresh.reframe.auto;
  const pj = first.prejudge;
  if (first.asset_id === fresh.asset_id) {
    fresh.fit_carry = { ...pj, asset_id: fresh.asset_id };
    fresh.steps = { ...(fresh.steps || {}), analysis: { status: 'running', started_at: now } };
    store.saveRun(fresh);
    if (fresh.draft_first) require('./review').runDraftFirst(runId).catch(() => {});
    else an().runAnalysis(runId).catch(() => {});
    return;
  }
  fresh.status = 'awaiting_review'; // switchTo 只接受还没写稿、不在推荐中的任务
  store.saveRun(fresh);
  switchTo(runId, first.asset_id, { by: 'auto', resetTried: true });
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

module.exports = { startPrecheck, getPrecheck, precheckCarry, precheckPool, applyPrecheck, topicsUsed, checkTopics, isReframe, shouldHold, suggest, startSuggest, switchTo, autoNext, autoMax, setAutoMax, ignore, library, catalogText, summarize, startSummary, keepOrigin, retopic, originOf, deadEnd };
