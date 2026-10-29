// 写前分析判「换框架」时:不再照写,停下来从框架库按题目推荐 3 个更合适的框架,人选一个后换框架重跑分析。
// 实测:仓库里写前分析判「换框架」却照写的 9 篇,进终审时七维平均 5.3;判「可以写 / 调整后可写」的 12 篇平均 6.3
// (청나라 궁녀 套「嫁入皇室」框架,分析已写明宫女没有婚姻和继承线,照写后终审 4.6)。
// run.reframe = { status: held|suggesting|done|failed|ignored, from_asset, reasons, picks, topic_note, tried[], error }
const fs = require('fs');
const path = require('path');
const store = require('./store');

const an = () => require('./analysis');
const pl = () => require('./pipeline');
const arr = v => (Array.isArray(v) ? v : []);
const PROMPT = path.join(__dirname, '..', 'prompts', 'reframe_suggest.md');

// 推荐中途进程重启:「suggesting」超过 10 分钟就当没在跑
const busy = rf => !!(rf && rf.status === 'suggesting' && Date.now() - Date.parse(rf.started_at || 0) < 600000);
const isReframe = run => !!(run && run.analysis && run.analysis.verdict === '换框架');
// 判了换框架、人没选「仍按现在的框架写」:先写后改的任务停在分析后,不点火写稿
function shouldHold(run) {
  return isReframe(run) && !(run.reframe && run.reframe.status === 'ignored');
}

// 框架库目录:同赛道给完整信息(核心承诺、适合/不适合的题),其他赛道只给名字,控制提示词长度。读 200 多个框架文件,缓存 5 分钟
let cache = null;
function library() {
  if (cache && Date.now() - cache.at < 300000) return cache.list;
  const list = store.listAssets().filter(a => !a.broken).map(a => {
    let tr = {}, ce = {};
    try {
      const asset = store.getAsset(a.id);
      const fw = JSON.parse(asset.framework || '{}');
      const d = fw.data || fw;
      tr = d.transferability || {};
      ce = d.core_engine || {};
    } catch (e) { /* 框架文件坏了:只用 meta 里的信息 */ }
    return {
      id: a.id, name: a.name || a.id, track: a.track || '', source: a.source_title_zh || a.source_title || '',
      promise: ce.surface_promise_pattern || String(a.description || '').slice(0, 80),
      best: arr(tr.best_topic_traits).length ? arr(tr.best_topic_traits) : arr(a.best_topic_traits),
      avoid: arr(tr.avoid_topic_traits)
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
    same_track: same.map(a => [a.id, a.name, a.promise, a.best.join(';'), a.avoid.join(';'), a.source].join(' | ')).join('\n') || '(无)',
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
  save(runId, { status: 'suggesting', started_at: new Date().toISOString(), for_analysis: analysisAt, from_asset: run.asset_id, from_name: run.asset_name || run.asset_id, reasons: arr(a.reframe_reasons).map(String), tried, picks: [], error: '' });
  try {
    const cat = catalogText(run, tried);
    const cur = library().find(x => x.id === run.asset_id) || { name: run.asset_name || run.asset_id };
    const prompt = an().fillVars(fs.readFileSync(PROMPT, 'utf-8'), {
      topic: run.topic || '', title: ((a.title || {}).final_title) || run.topic || '',
      target_country: (run.audience || {}).target_country || '', target_language: (run.audience || {}).target_language || '',
      thesis: JSON.stringify(a.thesis_card || {}),
      current: cur.name + (cur.source ? '(原片:' + cur.source + ')' : ''),
      reasons: arr(a.reframe_reasons).map((r, i) => (i + 1) + '. ' + r).join('\n') || (a.verdict_reason || '(分析没写原因)'),
      same_track: cat.same_track, other_tracks: cat.other_tracks
    });
    const out = await an().callJson(run, cfg, prompt, '换框架·推荐框架', o => arr(o.picks).some(p => p && cat.ids.has(String(p.asset_id || '').trim())));
    const lib = library();
    let picks = arr(out.picks).map(p => ({ ...p, asset_id: String(p.asset_id || '').trim() }))
      .filter((p, i, all) => cat.ids.has(p.asset_id) && all.findIndex(x => x.asset_id === p.asset_id) === i).slice(0, 3)
      .map(p => {
        const x = lib.find(l => l.id === p.asset_id) || {};
        return { asset_id: p.asset_id, name: x.name || p.asset_id, source: x.source || '', track: x.track || '',
          fit: String(p.fit || ''), why: String(p.why || ''), adjust: String(p.adjust || ''), risk: String(p.risk || ''), recommended: p.recommended === true };
      });
    const ri = Math.max(0, picks.findIndex(p => p.recommended));
    picks = picks.map((p, i) => ({ ...p, recommended: i === ri }));
    const fresh = store.getRun(runId) || run;
    // 推荐期间人已经换了框架或重跑了分析:这份推荐作废
    if ((((fresh.steps || {}).analysis || {}).finished_at || '') !== analysisAt) return null;
    if (run.attempts) fresh.attempts = run.attempts;
    fresh.reframe = { ...(fresh.reframe || {}), status: 'done', at: new Date().toISOString(), picks, topic_note: String(out.topic_note || '') };
    store.saveRun(fresh);
    return fresh.reframe;
  } catch (e) {
    const fresh = store.getRun(runId);
    if (fresh) { if (run.attempts) fresh.attempts = run.attempts; fresh.reframe = { ...(fresh.reframe || {}), status: 'failed', error: e.message }; store.saveRun(fresh); }
    return null;
  }
}

// 换成新框架:清掉旧分析,按任务原来的模式重跑(先写后改:分析→AI 调整→写稿一路跑完;否则停在分析等确认)
function switchTo(runId, assetId) {
  const run = store.getRun(runId);
  if (!run) throw Object.assign(new Error('任务不存在'), { status: 404 });
  if (run.analysis_confirmed || !['awaiting_review', 'failed', 'cancelled'].includes(run.status)) throw Object.assign(new Error('只有还没开始写稿的任务能换框架(当前: ' + run.status + ')'), { status: 400 });
  if (busy(run.reframe)) throw Object.assign(new Error('框架推荐还在生成,等它出来再换'), { status: 409 });
  const asset = store.getAsset(assetId);
  if (!asset) throw Object.assign(new Error('框架不存在: ' + assetId), { status: 404 });
  if (assetId === run.asset_id) throw Object.assign(new Error('就是现在用的框架'), { status: 400 });
  const rf = run.reframe || {};
  run.reframe = { tried: [...new Set(arr(rf.tried).concat([run.asset_id]))], switched: arr(rf.switched).concat([{ at: new Date().toISOString(), from: run.asset_id, from_name: run.asset_name || run.asset_id, to: assetId }]) };
  run.asset_id = assetId;
  run.asset_name = (asset.meta || {}).name || assetId;
  ['analysis', 'analysis_raw', 'analysis_original', 'analysis_edited', 'analysis_saved_at', 'track_card_name', 'error'].forEach(k => { delete run[k]; });
  if (run.steps) { delete run.steps.analysis; delete run.steps.auto_adjust; }
  run.status = 'analyzing';
  store.saveRun(run);
  if (run.draft_first) require('./review').runDraftFirst(runId).catch(() => {});
  else an().runAnalysis(runId).catch(() => {});
  return { ok: true };
}

// 不换:仍按现在的框架写。先写后改的任务接着跑 AI 调整和写稿
function ignore(runId) {
  const run = store.getRun(runId);
  if (!run) throw Object.assign(new Error('任务不存在'), { status: 404 });
  if (run.analysis_confirmed || run.status !== 'awaiting_review') throw Object.assign(new Error('这个任务已经在写稿了'), { status: 400 });
  run.reframe = { ...(run.reframe || {}), status: 'ignored', ignored_at: new Date().toISOString() };
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
