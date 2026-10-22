// 写前分析(流程 B②–⑧)与稿件检查(流程 B⑬⑭)
// 写前分析:一次 LLM 调用跑完六步(适配/标题/论点/事实表/留存地图与取舍/钩子),产物存 run.analysis,
// 任务置为 awaiting_review 等人工确认(③⑤⑦⑨ 合并为一次确认),确认后才进入四步写稿。
// 稿件检查:程序先算稿件数据(retention.scriptStats),再由 LLM 按 K1–K5 出报告;只有 K3 自动改稿,其余给选项。
const fs = require('fs');
const path = require('path');
const store = require('./store');
const checks = require('./checks');
const retention = require('./retention');
const voice = require('./voice');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');
const GATE_MAX_RETRIES = 2;
const readPrompt = f => fs.readFileSync(path.join(PROMPTS_DIR, f), 'utf-8');
const parse = t => { try { return JSON.parse(t); } catch (e) { return null; } };
const dataOf = j => (j && j.data) || j || {};
const list = a => (Array.isArray(a) && a.length ? a.join(';') : '(无)');

// ---------- 赛道证据卡(A4 的产物,存于 prompts/track_cards.md) ----------
function loadTrackCards() {
  const text = readPrompt('track_cards.md');
  return text.split(/^## /m).slice(1).map(block => {
    const lines = block.split('\n');
    const name = lines[0].trim();
    const kwLine = lines.find(l => l.startsWith('关键词:')) || '';
    const keywords = kwLine.replace('关键词:', '').split(/[,，]/).map(s => s.trim().toLowerCase()).filter(Boolean);
    const body = lines.slice(1).filter(l => !l.startsWith('关键词:')).join('\n').trim();
    return { name, keywords, text: '【' + name + '】\n' + body };
  });
}

// 按"赛道 + 题目 + 资产名/题材"命中关键词最多的卡;都不命中返回 null
function pickTrackCard(track, topic, asset) {
  const fw = dataOf(parse((asset && asset.framework) || ''));
  const hay = [track, topic, asset && asset.id, asset && asset.meta && asset.meta.name, ((fw.content_profile || {}).genres || []).join(' ')]
    .filter(Boolean).join(' ').toLowerCase();
  let best = null, bestScore = 0;
  for (const c of loadTrackCards()) {
    const score = c.keywords.filter(k => hay.includes(k)).length;
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return best;
}

function buildAnalysisPrompt(run, asset) {
  const fw = dataOf(parse(asset.framework || ''));
  const tr = fw.transferability || {};
  const mr = fw.migration_rules || {};
  const ce = fw.core_engine || {};
  const cards = retention.cardsForAsset(asset);
  const aud = run.audience || {};
  const card = run.track_card_name
    ? loadTrackCards().find(c => c.name === run.track_card_name)
    : pickTrackCard(run.track, run.topic, asset);
  const structure = (fw.structure_pattern || []).map(s => '- ' + s.stage_id + ' ' + s.function + ':' + (s.purpose || '')).join('\n');
  const vars = {
    topic: run.topic,
    target_language: aud.target_language || '',
    target_country: aud.target_country || '',
    video_goal: aud.video_goal || '',
    target_audience: aud.target_audience || '(未填)',
    framework_name: fw.name || asset.id,
    core_engine: [ce.surface_promise_pattern, (ce.deep_emotional_promise || []).join('、')].filter(Boolean).join(';'),
    best_traits: list(tr.best_topic_traits),
    avoid_traits: list(tr.avoid_topic_traits),
    prerequisites: list(tr.prerequisites),
    risk_flags: list(tr.risk_flags),
    must_preserve: list(mr.must_preserve),
    title_contract: JSON.stringify(fw.title_hook_contract || {}),
    structure: structure || '(无)',
    source_conclusion: ((fw.story_engine || {}).belief_shift || {}).new_belief || '(未记录)',
    retention_map: retention.cardsSummary(cards) || '(资产缺少 timeline)',
    hook_contract: retention.hookContract(asset.timeline),
    retention_library: retention.librarySummary(4, 8),
    track_card: card ? card.text : '(没有匹配的赛道证据卡:事实按通用标准填写,来源、年份、地区缺一不可)',
    materials: run.materials || '(无)',
    voice: voice.voiceBrief(voice.voiceForRun(run))
  };
  let tpl = readPrompt('analysis.md');
  for (const k of Object.keys(vars)) tpl = tpl.replaceAll('{{' + k + '}}', vars[k]);
  return { prompt: tpl, track_card_name: card ? card.name : null };
}

// 写进 step1–4 的 {{analysis}}:只放写稿需要的部分(论点、标题、事实、取舍、留存地图、钩子)
function analysisBrief(a) {
  if (!a) return '(无写前分析,按原流程执行)';
  const out = [];
  const t = a.title || {};
  out.push('标题:' + (t.final_title || '') + (t.viewer_question ? '(观众想知道:' + t.viewer_question + ';期待方向:' + (t.expected_answer_direction || '') + ')' : ''));
  const th = a.thesis_card || {};
  out.push('论点卡:原有认知=' + (th.viewer_belief || '') + ';真相=' + (th.truth || '') + ';一句话论点=' + (th.one_line_thesis || '') + ';结尾落点=' + (th.ending_landing || ''));
  out.push('事实表(只能用这些):\n' + (a.facts || []).map(f => '- ' + f.id + ' [' + (f.kind || '') + '] ' + (f.content || '') + '(' + [f.source, f.year, f.region].filter(Boolean).join(',') + ')').join('\n'));
  if ((a.ledger || []).length) out.push('账本:\n' + a.ledger.map(l => '- ' + l.item + ' = ' + l.value + (l.fact_ids && l.fact_ids.length ? '(' + l.fact_ids.join(',') + ')' : '')).join('\n'));
  out.push('模块取舍:\n' + (a.modules || []).map(m => '- ' + m.segment + ' ' + m.decision + ':' + (m.reason || '') + (m.fact_ids && m.fact_ids.length ? '(' + m.fact_ids.join(',') + ')' : '')).join('\n'));
  out.push('留存地图:\n' + (a.retention_map || []).map(r => '- ' + r.source_peak + '(' + (r.source_segment || '') + ')→' + (r.new_chapter_hint || '') + ' ' + r.status + (r.fact_ids && r.fact_ids.length ? '(' + r.fact_ids.join(',') + ')' : '')).join('\n'));
  const h = a.hook || {};
  const chosen = (h.candidates || [])[h.chosen || 0];
  if (chosen) out.push('钩子(已选定):' + chosen.text + '(事实 ' + (chosen.fact_ids || []).join(',') + ';第一个甜头 ' + chosen.first_payoff_sec + ' 秒)');
  return out.join('\n\n');
}

function acceptedGaps(a) {
  return ((a && a.retention_map) || []).filter(r => /接受弱化/.test(r.status || '')).map(r => r.source_peak);
}

// 分析 JSON 的最低结构要求;返回错误说明或 null
function analysisShapeError(a) {
  if (!a || typeof a !== 'object') return '不是 JSON 对象';
  for (const k of ['verdict', 'title', 'thesis_card', 'facts', 'modules', 'retention_map', 'hook']) {
    if (a[k] == null) return '缺少字段 ' + k;
  }
  if (!Array.isArray(a.facts) || !a.facts.length) return 'facts 为空';
  return null;
}

function parseJsonLoose(text) {
  const s = checks.stripFence((text || '').trim());
  return parse(s) || checks.extractJsonObject(s);
}

// 单次 LLM 调用 + 流水记录(与 runGeneration 的 attempts 同结构)
async function callWithLog(run, cfg, messages, label) {
  const pipeline = require('./pipeline'); // 延迟加载,避免与 pipeline 循环依赖
  const t0 = Date.now();
  const log = extra => {
    const fresh = store.getRun(run.id); // 保住调用期间接口写入的取消标记,不被旧对象覆盖
    if (fresh && fresh.cancel_requested) run.cancel_requested = true;
    run.attempts = [...(run.attempts || []), { ts: new Date().toISOString(), label, provider: cfg.provider || '', model: cfg.model || '', ...extra }].slice(-100);
    store.saveRun(run);
  };
  try {
    const r = await pipeline.llmCall(cfg, messages, label);
    log({ ok: true, secs: Math.round(r.secs * 10) / 10, stop_reason: r.stopReason });
    return r;
  } catch (e) {
    log({ ok: false, secs: Math.round((Date.now() - t0) / 100) / 10, error: e.message });
    throw e;
  }
}

// ---------- B②–⑧:写前分析 ----------
async function runAnalysis(runId) {
  const pipeline = require('./pipeline');
  const run = store.getRun(runId);
  if (!run) return;
  const cfg = pipeline.loadConfig();
  if (!cfg || !cfg.api_key) { run.status = 'failed'; run.error = '未配置 API Key(POST /api/settings)'; store.saveRun(run); return; }
  const asset = store.getAsset(run.asset_id);
  if (!asset || !asset.framework) { run.status = 'failed'; run.error = '资产不存在: ' + run.asset_id; store.saveRun(run); return; }

  run.status = 'analyzing';
  delete run.error;
  delete run.cancel_requested;
  run.steps = { ...(run.steps || {}), analysis: { status: 'running', started_at: new Date().toISOString() } };
  store.saveRun(run);
  try {
    const built = buildAnalysisPrompt(run, asset);
    run.track_card_name = built.track_card_name;
    let messages = [{ role: 'user', content: built.prompt }];
    let r = await callWithLog(run, cfg, messages, '写前分析');
    let a = parseJsonLoose(r.content);
    let err = r.stopReason === 'max_tokens' ? '输出被 max_tokens 截断' : analysisShapeError(a);
    for (let retry = 1; err && retry <= GATE_MAX_RETRIES; retry++) {
      run.steps.analysis.gate_retry = { reason: err, attempt: retry };
      store.saveRun(run);
      const feedback = err.indexOf('截断') !== -1
        ? '上一次输出被长度上限截断。请压缩每个字段的文字(理由一句话以内),一次性输出完整 JSON,禁止代码围栏和解释。'
        : '上一次输出不合格:' + err + '。请严格只输出格式要求里的 JSON 对象,字段齐全,禁止代码围栏和解释。';
      messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: feedback }];
      r = await callWithLog(run, cfg, messages, '写前分析重试');
      a = parseJsonLoose(r.content);
      err = r.stopReason === 'max_tokens' ? '输出被 max_tokens 截断(请在设置里调大 Max Tokens)' : analysisShapeError(a);
    }
    if (err) throw new Error(err);
    if (run.cancel_requested) {
      run.status = 'cancelled';
      run.steps.analysis = { ...run.steps.analysis, status: 'failed' };
      store.saveRun(run);
      return;
    }
    run.analysis = a;
    run.analysis_raw = r.content;
    run.steps.analysis = { ...run.steps.analysis, status: 'done', secs: Math.round(r.secs * 10) / 10, finished_at: new Date().toISOString() };
    run.status = 'awaiting_review';
    store.saveRun(run);
  } catch (e) {
    run.status = 'failed';
    run.error = '写前分析失败: ' + e.message;
    run.steps.analysis = { ...(run.steps.analysis || {}), status: 'failed' };
    store.saveRun(run);
  }
}

// ---------- B⑬⑭:稿件检查 ----------
function buildCheckPrompt(run, asset, stats) {
  const a = run.analysis || {};
  const t = a.title || {};
  const vars = {
    title: t.final_title || run.topic,
    title_promise: (t.viewer_question || '') + ' → ' + (t.expected_answer_direction || ''),
    thesis_card: JSON.stringify(a.thesis_card || {}),
    facts: (a.facts || []).map(f => '- ' + f.id + ' [' + (f.kind || '') + '] ' + (f.content || '') + '(' + [f.source, f.year, f.region].filter(Boolean).join(',') + ')').join('\n') || '(无事实表)',
    search_log: (a.search_log || []).map(s => '- ' + s.looked_for + ':' + s.result + (s.note ? '(' + s.note + ')' : '')).join('\n') || '(无)',
    retention_map: (a.retention_map || []).map(r => '- ' + r.source_peak + ' → ' + (r.new_chapter_hint || '') + ' ' + r.status).join('\n') || '(无)',
    program_stats: JSON.stringify({
      length: stats.length, source_density_max: stats.source_density_max, density_limit: stats.density_limit,
      dense_chapters: stats.dense_chapters, mixed_year_chapters: stats.mixed_year_chapters, stale_facts: stats.stale_facts,
      chapters: stats.chapters.map(c => ({ id: c.id, words: c.words, density: c.density, years: c.years }))
    }),
    script: v1Text(run)
  };
  let tpl = readPrompt('script_check.md');
  for (const k of Object.keys(vars)) tpl = tpl.replaceAll('{{' + k + '}}', vars[k]);
  return tpl;
}

// K3 的自动修改:before 在终稿里恰好出现一次才替换,否则降级为"待选择"
function applyK3(script, issues) {
  let text = script;
  for (const it of issues) {
    if (it.type !== 'K3' || it.status !== '已修改') continue;
    const before = it.before || '';
    const n = before ? text.split(before).length - 1 : 0;
    if (n === 1 && it.after) { text = text.replace(before, it.after); it.applied = true; }
    else { it.applied = false; it.status = '待选择'; it.problem = (it.problem || '') + '(自动修改未执行:原句在终稿中' + (n ? '出现多次' : '找不到') + ')'; }
  }
  return text;
}

// 稿件检查只针对 V1(写稿产物);强化开头生成 V2 后 final_script 会变成 V2,所以优先取 script_v1
function v1Text(run) { return run.script_v1 || run.final_script || ''; }

async function runScriptCheck(runId) {
  const pipeline = require('./pipeline');
  const run = store.getRun(runId);
  if (!run || !v1Text(run)) return;
  const cfg = pipeline.loadConfig();
  const asset = store.getAsset(run.asset_id);
  if (!cfg || !cfg.api_key || !asset) return;
  run.steps = { ...(run.steps || {}), script_check: { status: 'running', started_at: new Date().toISOString() } };
  store.saveRun(run);
  try {
    const stats = retention.scriptStats(v1Text(run), {
      timeline: asset.timeline, framework: asset.framework, srt: asset.srt, facts: (run.analysis || {}).facts
    });
    let messages = [{ role: 'user', content: buildCheckPrompt(run, asset, stats) }];
    let r = await callWithLog(run, cfg, messages, '稿件检查');
    let rep = parseJsonLoose(r.content);
    for (let retry = 1; !(rep && Array.isArray(rep.issues)) && retry <= GATE_MAX_RETRIES; retry++) {
      messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: '上一次输出不是合法 JSON。请只输出 {"issues": [...]} 这个 JSON 对象,禁止代码围栏和解释。' }];
      r = await callWithLog(run, cfg, messages, '稿件检查重试');
      rep = parseJsonLoose(r.content);
    }
    if (!(rep && Array.isArray(rep.issues))) throw new Error('输出不是合法 JSON');
    const issues = rep.issues;
    const before = v1Text(run);
    if (run.script_v2) {
      // 已基于 V1 生成 V2:V1 锁定,不再自动改,只提示
      issues.filter(i => i.type === 'K3' && i.status === '已修改').forEach(i => { i.status = '待选择'; i.problem = (i.problem || '') + '(已生成 V2,V1 不再自动修改)'; });
    }
    const after = applyK3(before, issues);
    if (after !== before) {
      // 改前版本留档;改后结构不合格则整体放弃自动修改
      if (checks.chapterStructureError(after)) issues.filter(i => i.applied).forEach(i => { i.applied = false; i.status = '待选择'; });
      else {
        run.final_script_before_check = before;
        if (run.script_v1) run.script_v1 = after; else run.final_script = after;
        // V1 文案已变:该版本的扫描与简介缓存过期
        ['compliance_scans', 'opening_scans', 'descriptions'].forEach(k => { if (run[k] && run[k].v1) run[k].v1.stale = true; });
      }
    }
    run.script_check = { at: new Date().toISOString(), program: stats, issues, applied: issues.filter(i => i.applied).length, pending: issues.filter(i => i.status === '待选择').length };
    run.steps.script_check = { ...run.steps.script_check, status: 'done', secs: Math.round(r.secs * 10) / 10, finished_at: new Date().toISOString() };
    store.saveRun(run);
  } catch (e) {
    run.steps.script_check = { ...(run.steps.script_check || {}), status: 'failed', error: e.message };
    store.saveRun(run);
  }
}

module.exports = { loadTrackCards, pickTrackCard, buildAnalysisPrompt, analysisBrief, acceptedGaps, analysisShapeError, runAnalysis, buildCheckPrompt, applyK3, runScriptCheck };
