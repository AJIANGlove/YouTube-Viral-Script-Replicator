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

// 写前分析与「AI 先调整」「标题审核」共用的框架侧变量
function frameworkVars(run, asset) {
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
    today: require('./pipeline').todayStr(),
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
  return { vars, card };
}

function fillVars(tpl, vars) {
  for (const k of Object.keys(vars)) tpl = tpl.replaceAll('{{' + k + '}}', vars[k] == null ? '' : String(vars[k]));
  return tpl;
}

function buildAnalysisPrompt(run, asset) {
  const { vars, card } = frameworkVars(run, asset);
  return { prompt: fillVars(readPrompt('analysis.md'), vars), track_card_name: card ? card.name : null };
}

// 写进 step1–4 的 {{analysis}}:只放写稿需要的部分(论点、标题、事实、取舍、留存地图、钩子)
function analysisBrief(a) {
  if (!a) return '(无写前分析,按原流程执行)';
  const out = [];
  const t = a.title || {};
  out.push('标题:' + (t.final_title || '') + (t.viewer_question ? '(观众想知道:' + t.viewer_question + ';期待方向:' + (t.expected_answer_direction || '') + ')' : ''));
  const th = a.thesis_card || {};
  out.push('论点卡:原有认知=' + (th.viewer_belief || '') + ';真相=' + (th.truth || '') + ';一句话论点=' + (th.one_line_thesis || '') + ';结尾落点=' + (th.ending_landing || ''));
  out.push('事实表(只能用这些;[估算] 的数在稿中要说明是估算、怎么算的,[待查] 的数不要写成确定的事实):\n' + (a.facts || []).map(f => '- ' + f.id + ' [' + (f.kind || '') + '] ' + (f.content || '') + '(' + [f.source, f.year, f.region].filter(Boolean).join(',') + ')' + (f.method ? ' 算法:' + f.method : '')).join('\n'));
  const stale = a.stale || {};
  const staleTag = (arr, key) => (Array.isArray(arr) && arr.includes(key) ? '(依据的事实已更新,这一行的数作废,按事实表重算)' : '');
  if ((a.ledger || []).length) out.push('账本:\n' + a.ledger.map(l => '- ' + l.item + ' = ' + l.value + (l.fact_ids && l.fact_ids.length ? '(' + l.fact_ids.join(',') + ')' : '') + staleTag(stale.ledger, l.item)).join('\n'));
  out.push('模块取舍(「保留」只保留功能和节奏,内容用本题事实):\n' + (a.modules || []).map(m => '- ' + m.segment + ' ' + m.decision + ':' + (m.reason || '') + (m.fact_ids && m.fact_ids.length ? '(' + m.fact_ids.join(',') + ')' : '') + staleTag(stale.modules, m.segment)).join('\n'));
  out.push('留存地图:\n' + (a.retention_map || []).map(r => '- ' + r.source_peak + '(' + (r.source_segment || '') + ')→' + (r.new_chapter_hint || '') + ' ' + r.status + (r.fact_ids && r.fact_ids.length ? '(' + r.fact_ids.join(',') + ')' : '')).join('\n'));
  const h = a.hook || {};
  const chosen = (h.candidates || [])[h.chosen || 0];
  if (chosen) out.push('钩子(已选定):' + chosen.text + '(事实 ' + (chosen.fact_ids || []).join(',') + ';第一个甜头 ' + chosen.first_payoff_sec + ' 秒)');
  return out.join('\n\n');
}

function acceptedGaps(a) {
  return ((a && a.retention_map) || []).filter(r => /接受弱化/.test(r.status || '')).map(r => r.source_peak);
}

// 前端编辑分析时要用的对照数据:原片高峰集合 + 第一个甜头秒数(用于"钩子晚于原片"提示与 PK 编号校验)
// 只读资产,不落盘;资产或 timeline 缺失时返回空结构,绝不抛错
function analysisContext(assetId) {
  const out = { peaks: [], source_first_payoff_sec: null, segments: [], framework: null };
  try {
    const asset = store.getAsset(assetId);
    try {
      out.segments = retention.cardsForAsset(asset).map(c => ({
        stage_id: c.stage_id, function: c.function, deletability: c.deletability,
        peaks: (c.peaks || []).map(p => p.peak_id), abstract_move: c.abstract_move || ''
      }));
      const fw = dataOf(parse(asset.framework || ''));
      const ce = fw.core_engine || {};
      out.framework = {
        name: fw.name || asset.id,
        core_engine: [ce.surface_promise_pattern, (ce.deep_emotional_promise || []).join('、')].filter(Boolean).join(';'),
        title_contract: fw.title_hook_contract || {},
        must_preserve: (fw.migration_rules || {}).must_preserve || []
      };
    } catch (e) { /* 留存卡或框架缺失:前端不显示可删性校验和标题提示词里的框架方向 */ }
    const tl = dataOf(parse(asset && asset.timeline));
    out.peaks = (tl.peak_points || []).map(p => ({
      peak_id: p.peak_id, peak_type: p.peak_type || '', strength: p.strength,
      time_ms: p.time_ms, position_ratio: p.position_ratio
    }));
    const first = (tl.hook_window || {}).first_payoff_ms;
    out.source_first_payoff_sec = first != null ? Math.round(first / 100) / 10 : null;
  } catch (e) { /* 忽略:前端退化为不做这两项校验 */ }
  return out;
}

function cloneJson(v) {
  try { return JSON.parse(JSON.stringify(v)); } catch (e) { return null; }
}

// 分析 JSON 的最低结构要求;返回错误说明或 null
// 数组类型必须是数组:模型偶尔把这几项输出成对象,前端表格会直接崩
function analysisShapeError(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return '不是 JSON 对象';
  for (const k of ['verdict', 'title', 'thesis_card', 'facts', 'modules', 'retention_map', 'hook']) {
    if (a[k] == null) return '缺少字段 ' + k;
  }
  for (const k of ['facts', 'modules', 'retention_map']) {
    if (!Array.isArray(a[k])) return k + ' 必须是数组';
  }
  if (!a.facts.length) return 'facts 为空';
  for (const k of ['adjustments', 'reframe_reasons']) {
    if (a[k] != null && !Array.isArray(a[k])) return k + ' 必须是数组';
  }
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
  // 只把 attempts / 取消标记并进盘上的最新版本,不整对象写回:
  // 这个调用可能持续几分钟,期间接口可能已经保存过分析、确认过任务,旧快照写回会把它们覆盖掉。
  const log = extra => {
    const fresh = store.getRun(run.id) || run;
    if (fresh.cancel_requested) run.cancel_requested = true;
    run.attempts = [...(run.attempts || []), { ts: new Date().toISOString(), label, provider: cfg.provider || '', model: cfg.model || '', ...extra }].slice(-100);
    fresh.attempts = run.attempts;
    if (run.cancel_requested) fresh.cancel_requested = run.cancel_requested;
    store.saveRun(fresh);
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

// 稿件数据统计(片长/密度/数字与年份/事实时效);输入输出与 runScriptCheck 里原来那段一致
function scriptProgramStats(run) {
  const asset = store.getAsset(run.asset_id);
  if (!asset) return null;
  return retention.scriptStats(v1Text(run), {
    timeline: asset.timeline, framework: asset.framework, srt: asset.srt, facts: (run.analysis || {}).facts
  });
}

// "采用某个选项"的落地:find 必须在稿中恰好出现一次,否则不动;改完结构不合格也不动
function applyOptionExact(script, find, replace) {
  const text = String(script || '');
  const f = String(find || '');
  const rep = String(replace == null ? '' : replace);
  if (!f.trim()) return { ok: false, reason: '原句为空' };
  // 章节标签行是结构锚点,不允许被改掉
  if (/\[\s*CH\d+\s*\|/.test(f) || /\[\s*CH\d+\s*\|/.test(rep)) return { ok: false, reason: '改动涉及章节标签行' };
  const n = text.split(f).length - 1;
  if (n === 0) return { ok: false, reason: '原句在稿子里找不到(可能已被改过)' };
  if (n > 1) return { ok: false, reason: '原句在稿子里出现 ' + n + ' 次,无法确定改哪一处' };
  const after = text.replace(f, rep);
  const structErr = checks.chapterStructureError(after);
  if (structErr) return { ok: false, reason: '改完章节结构不合格:' + structErr };
  return { ok: true, text: after };
}

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
    const stats = scriptProgramStats(run);
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

// ---------- 审核辅助:AI 先调整 / 我的意见(单行重做)/ 标题审核 ----------
// 三个动作都不改 run.status,也不自动确认;改动记在 analysis.ai_marks[target](界面上标蓝),
// 依据类型:查到(搜索结果或参考资料)/ 估算(写明算法)/ 记忆待核(没查到,只凭模型知识)/ 推理(非数字改动)。
const search = require('./search');
const BASIS = ['查到', '估算', '记忆待核', '推理'];

// target 写法:title / thesis_card / hook / facts.F04 / modules.FS03 / retention_map.PK02
function getTarget(a, target) {
  const [k, id] = String(target || '').split(/\.(.+)/);
  if (!a) return null;
  if (['title', 'thesis_card', 'hook'].includes(k)) return a[k] || null;
  if (k === 'facts') return (a.facts || []).find(f => f.id === id) || null;
  if (k === 'modules') return (a.modules || []).find(m => m.segment === id) || null;
  if (k === 'retention_map') return (a.retention_map || []).find(m => m.source_peak === id) || null;
  return null;
}

// 合并一行:模型没给的键保留旧值;显式给空值([] / '' / null)则覆盖为空,
// 这样模型想清空 fact_ids、理由这类字段时能清掉,不会把旧内容强行留下。
function mergeRow(oldRow, item, key, id) {
  const out = (oldRow && typeof oldRow === 'object' && !Array.isArray(oldRow)) ? { ...oldRow } : {};
  for (const k of Object.keys(item)) {
    if (k === key) continue;
    out[k] = item[k];
  }
  out[key] = id;
  return out;
}

// 有 id 的行:找到就合并(不是整行替换),找不到就追加(只有事实允许新增)
function setTarget(a, target, item) {
  const [k, id] = String(target || '').split(/\.(.+)/);
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  if (['title', 'thesis_card', 'hook'].includes(k)) {
    const old = (a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) ? a[k] : {};
    a[k] = { ...old, ...item };
    if (k === 'hook') {
      const c = a[k].candidates;
      const n = Number(a[k].chosen);
      if (Array.isArray(c) && !(Number.isInteger(n) && n >= 0 && n < c.length)) a[k].chosen = 0;
    }
    return true;
  }
  const key = { facts: 'id', modules: 'segment', retention_map: 'source_peak' }[k];
  if (!key) return false;
  const arr = Array.isArray(a[k]) ? a[k] : (a[k] = []);
  const i = arr.findIndex(x => x && x[key] === id);
  if (i >= 0) arr[i] = mergeRow(arr[i], item, key, id);
  else if (k === 'facts') arr.push(mergeRow(null, item, key, id));
  else return false;
  return true;
}

function markChange(a, target, mark, batches) {
  a.ai_marks = a.ai_marks || {};
  a.ai_marks[target] = {
    fields: Array.isArray(mark.fields) ? mark.fields : [],
    basis: BASIS.includes(mark.basis) ? mark.basis : '推理',
    reason: mark.reason || '',
    evidence: search.resolveEvidence(mark.evidence, batches),
    by: mark.by || 'auto',
    note: mark.note || '',
    at: new Date().toISOString()
  };
}

// 需要补的内容清单(给查询词提示词用)
function needsList(a) {
  const out = [];
  (a.facts || []).forEach(f => {
    const miss = ['content', 'source', 'year', 'region'].filter(k => !String(f[k] || '').trim());
    if (f.kind === '待查' || miss.length || (f.kind === '估算' && !f.method) || f.freshness === '时效风险') {
      out.push('- facts.' + f.id + ' [' + (f.kind || '未标') + '] ' + (f.slot || '') + ':' + (f.content || '(空)') +
        (miss.length ? '(缺 ' + miss.join('/') + ')' : '') + (f.freshness === '时效风险' ? '(数据太旧)' : '') + (f.region ? ' 地区:' + f.region : ''));
    }
  });
  (a.adjustments || []).filter(x => x.type === '补料').forEach(x => out.push('- ' + (x.target || '补料') + ':' + (x.reason || '')));
  (a.retention_map || []).filter(r => /缺口-补料/.test(r.status || '')).forEach(r => out.push('- retention_map.' + r.source_peak + '(' + (r.source_segment || '') + ')缺事实承担'));
  (a.modules || []).forEach(m => (m.research_tasks || []).forEach(t => out.push('- modules.' + m.segment + ' 补料任务:' + t)));
  return out;
}

async function planAndSearch(run, cfg, vars, a, needs, note, maxQ) {
  if (!needs.length && !note) return [];
  const prompt = fillVars(readPrompt('adjust_queries.md'), {
    ...vars, thesis: ((a.thesis_card || {}).one_line_thesis) || '', needs: needs.join('\n') || '(见人工意见)',
    note: note || '(无)', max_queries: maxQ
  });
  const r = await callWithLog(run, cfg, [{ role: 'user', content: prompt }], '联网查询词');
  const q = parseJsonLoose(r.content);
  const queries = (Array.isArray(q && q.queries) ? q.queries : []).filter(x => x && x.query).slice(0, maxQ);
  const batches = await search.runQueries(queries, run.topic);
  // 落盘的是检索账本:摘要只留前 QUOTE_MAX 字作原文出处(全文 700 字 ×40 条 ×20 次会把 run 文件撑到几百 KB),
  // 人核实时能看到「这个数原文怎么写的」,不用再去搜
  const ledger = batches.map(b => ({
    query: b.query, target: b.target || '', error: b.error || null,
    hits: (Array.isArray(b.results) ? b.results : []).map(x => ({ ref: x.ref, title: x.title, url: x.url, date: x.date, site: x.site, quote: String(x.summary || '').replace(/\s+/g, ' ').slice(0, search.QUOTE_MAX) }))
  }));
  run.search_runs = [...(Array.isArray(run.search_runs) ? run.search_runs : []), { at: new Date().toISOString(), note: note || '', batches: ledger }].slice(-20);
  return batches;
}

function loadRunAsset(runId) {
  const pipeline = require('./pipeline');
  const run = store.getRun(runId);
  if (!run) throw Object.assign(new Error('任务不存在'), { status: 404 });
  const cfg = pipeline.loadConfig();
  if (!cfg || !cfg.api_key) throw Object.assign(new Error('未配置 API Key(POST /api/settings)'), { status: 400 });
  const asset = store.getAsset(run.asset_id);
  if (!asset || !asset.framework) throw Object.assign(new Error('资产不存在: ' + run.asset_id), { status: 400 });
  return { run, cfg, asset };
}

function assertReviewable(run) {
  if (run.status !== 'awaiting_review' || run.analysis_confirmed) {
    throw Object.assign(new Error('仅待确认且未确认的任务可调整分析(当前: ' + run.status + ')'), { status: 400 });
  }
}

// 把调用流水/搜索记录并进盘上最新版本:这些接口可能跑几分钟,
// 中途用户可能保存过分析或确认过任务,整对象写回会把它们覆盖掉。
function saveRunMerge(run) {
  const fresh = store.getRun(run.id) || run;
  if (run.attempts !== undefined) fresh.attempts = run.attempts;
  if (run.search_runs !== undefined) fresh.search_runs = run.search_runs;
  store.saveRun(fresh);
  return fresh;
}

async function callJson(run, cfg, prompt, label, ok) {
  let messages = [{ role: 'user', content: prompt }];
  let r = await callWithLog(run, cfg, messages, label);
  let out = parseJsonLoose(r.content);
  for (let retry = 1; !(out && ok(out)) && retry <= GATE_MAX_RETRIES; retry++) {
    messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: r.stopReason === 'max_tokens'
      ? '上一次输出被长度上限截断。只输出改动的部分,理由一句话以内,一次性输出完整 JSON。'
      : '上一次输出不是格式要求里的 JSON。请只输出那个 JSON 对象,禁止代码围栏和解释。' }];
    r = await callWithLog(run, cfg, messages, label + '重试');
    out = parseJsonLoose(r.content);
  }
  if (!(out && ok(out))) throw new Error(label + '输出不是合法 JSON');
  return out;
}

// 把「AI 先调整」的输出合并进分析;返回改动条数
function mergeAdjust(a, out, batches) {
  let n = 0;
  const list = v => (Array.isArray(v) ? v : []);
  const changes = list(out.changes);
  const changeFor = t => changes.find(c => c && c.target === t) || {};
  const apply = (target, item) => {
    if (!setTarget(a, target, item)) return;
    markChange(a, target, changeFor(target), batches);
    n++;
  };
  list(out.facts).forEach(f => f && f.id && apply('facts.' + f.id, f));
  list(out.modules).forEach(m => m && m.segment && apply('modules.' + m.segment, m));
  list(out.retention_map).forEach(m => m && m.source_peak && apply('retention_map.' + m.source_peak, m));
  // 账本整张替换(adjust.md 要求给完整新账本):旧实现不收账本,改了事实以后账本还是旧数,写稿照旧数算账(实测 run_a2f108398c13)
  const changedFacts = list(out.facts).filter(f => f && f.id).map(f => f.id);
  if (list(out.ledger).length) {
    a.ledger = list(out.ledger).filter(l => l && typeof l === 'object' && !Array.isArray(l));
    markChange(a, 'ledger', changeFor('ledger').target ? changeFor('ledger') : { fields: ['ledger'], basis: '估算', reason: '事实更新后重算账本' }, batches);
    n++;
  }
  // 模型没重算的:账本行、模块里引用了改过的事实 → 标记作废,写稿时按事实表重算
  const touches = x => list(x && x.fact_ids).some(id => changedFacts.includes(id));
  a.stale = {
    ledger: list(out.ledger).length ? [] : list(a.ledger).filter(touches).map(l => l.item),
    modules: list(a.modules).filter(m => touches(m) && !list(out.modules).some(o => o && o.segment === m.segment)).map(m => m.segment)
  };
  if (out.thesis_card && typeof out.thesis_card === 'object' && !Array.isArray(out.thesis_card)) apply('thesis_card', out.thesis_card);
  if (out.hook && typeof out.hook === 'object' && !Array.isArray(out.hook) && Array.isArray(out.hook.candidates) && out.hook.candidates.length) apply('hook', out.hook);
  const addTitles = list(out.title_candidates_add).filter(t => typeof t === 'string' && t && !list((a.title || {}).candidates).includes(t));
  if (addTitles.length) {
    a.title = a.title && typeof a.title === 'object' ? a.title : {};
    a.title.candidates = [...list(a.title.candidates), ...addTitles];
    a.title.ai_added = [...list(a.title.ai_added), ...addTitles];
    markChange(a, 'title', { fields: ['candidates'], basis: '推理', reason: (changeFor('title').reason) || '补充与框架方向一致的候选标题' }, batches);
    n++;
  }
  // 调整清单按「类型 + 位置 + 影响段」合并:模型漏掉的旧项保留,只更新它这次提到的项
  if (list(out.adjustments).length) {
    const keyOf = x => [x && x.type, x && x.target, list(x && x.segments).join('/')].join('|');
    const merged = list(a.adjustments).map(x => ({ ...x }));
    list(out.adjustments).forEach(x => {
      if (!x || typeof x !== 'object' || Array.isArray(x)) return;
      const i = merged.findIndex(y => keyOf(y) === keyOf(x));
      if (i >= 0) merged[i] = { ...merged[i], ...x };
      else merged.push({ ...x });
    });
    a.adjustments = merged;
  }
  if (list(out.search_log_add).length) {
    const key = x => (x && x.looked_for || '') + '|' + (x && x.note || '');
    const seen = new Set(list(a.search_log).map(key));
    a.search_log = [...list(a.search_log), ...list(out.search_log_add).filter(x => x && !seen.has(key(x)) && seen.add(key(x)))];
  }
  return n;
}

// 「AI 先调整」:可先联网查询,再一次性改事实表、论点卡、模块、留存地图、钩子、候选标题。
// draft:界面上当前的草稿(可能还没保存),以它为底;结果写回 run.analysis,改前版本存 analysis_before_adjust 便于撤回
async function runAutoAdjust(runId, draft, opts) {
  const { run, cfg, asset } = loadRunAsset(runId);
  assertReviewable(run);
  const base = draft || run.analysis;
  const shapeErr = analysisShapeError(base);
  if (shapeErr) throw Object.assign(new Error('分析结果不合格: ' + shapeErr), { status: 400 });
  const a = cloneJson(base);
  const { vars } = frameworkVars(run, asset);
  const useSearch = !!(opts && opts.search) && search.searchStatus(cfg).ready;
  const batches = useSearch ? await planAndSearch(run, cfg, vars, a, needsList(a), '', search.MAX_QUERIES) : [];
  const forModel = cloneJson(a);
  delete forModel.ai_marks;
  const prompt = fillVars(readPrompt('adjust.md'), { ...vars, search_results: search.resultsBrief(batches), analysis_json: JSON.stringify(forModel) });
  const out = await callJson(run, cfg, prompt, 'AI 先调整', o => typeof o === 'object' && !Array.isArray(o));
  const n = mergeAdjust(a, out, batches);
  const fresh = store.getRun(run.id) || run;
  // 这段可能跑了几分钟:期间任务若已确认、已进入写稿,这次结果就不能再写,
  // 否则会把分析覆盖回「未确认版」,和已经开始的稿子对不上。
  if (fresh.status !== 'awaiting_review' || fresh.analysis_confirmed) {
    throw Object.assign(new Error('任务状态已变化(当前: ' + (fresh.status || '未知') + ',可能已确认或已开始写稿),本次 AI 调整结果没有保存'), { status: 409 });
  }
  if (fresh.analysis && !fresh.analysis_original) fresh.analysis_original = cloneJson(fresh.analysis);
  // 撤销点取盘上最后一版(用户等待期间若保存过,撤销回到他保存的那版,而不是请求开始时的旧草稿)
  fresh.analysis_before_adjust = cloneJson(fresh.analysis || base);
  fresh.analysis = a;
  fresh.analysis_edited = true;
  fresh.analysis_ai_adjusted = true;
  if (run.attempts !== undefined) fresh.attempts = run.attempts;
  if (run.search_runs !== undefined) fresh.search_runs = run.search_runs;
  fresh.analysis_adjusted_at = new Date().toISOString();
  store.saveRun(fresh);
  return { analysis: a, changed: n, searched: useSearch, queries: batches.map(b => ({ query: b.query, target: b.target, hits: (b.results || []).length, error: b.error })) };
}

// 「我的意见」要用的相关留存卡:段 → 本段卡;高峰 → 持有它的卡;事实 → 引用它的段/高峰所属卡
function cardText(asset, target, a) {
  const [k, id] = String(target || '').split(/\.(.+)/);
  const cards = retention.cardsForAsset(asset);
  let segs = [];
  if (k === 'modules') segs = [id];
  else if (k === 'retention_map') segs = cards.filter(c => (c.peaks || []).some(p => p.peak_id === id)).map(c => c.stage_id);
  else if (k === 'facts' && a) {
    const mods = (Array.isArray(a.modules) ? a.modules : []).filter(m => (Array.isArray(m.fact_ids) ? m.fact_ids : []).includes(id)).map(m => m.segment);
    const peaks = (Array.isArray(a.retention_map) ? a.retention_map : []).filter(r => (Array.isArray(r.fact_ids) ? r.fact_ids : []).includes(id)).map(r => r.source_peak);
    const peakSegs = cards.filter(c => (c.peaks || []).some(p => peaks.includes(p.peak_id))).map(c => c.stage_id);
    segs = [...new Set([...mods, ...peakSegs])];
  }
  segs = segs.filter(Boolean).slice(0, 2);
  if (!segs.length) return '(无)';
  return retention.cardsSummary(cards.filter(c => segs.includes(c.stage_id))) || '(无)';
}

// 「我的意见」:只重做一行,返回改前/改后,不落盘;人点「采用」后由前端写进草稿
async function reviseItem(runId, draft, target, note, opts) {
  const { run, cfg, asset } = loadRunAsset(runId);
  assertReviewable(run);
  const a = draft || run.analysis;
  const before = getTarget(a, target);
  if (!before) throw Object.assign(new Error('找不到要改的行: ' + target), { status: 400 });
  if (!String(note || '').trim()) throw Object.assign(new Error('意见为空'), { status: 400 });
  const { vars } = frameworkVars(run, asset);
  const useSearch = !!(opts && opts.search) && search.searchStatus(cfg).ready;
  const need = ['- ' + target + ':' + JSON.stringify(before)];
  const batches = useSearch ? await planAndSearch(run, cfg, vars, a, need, note, 4) : [];
  const prompt = fillVars(readPrompt('revise.md'), {
    ...vars,
    title: (a.title || {}).final_title || run.topic,
    thesis: JSON.stringify(a.thesis_card || {}),
    facts: (Array.isArray(a.facts) ? a.facts : []).map(f => '- ' + f.id + ' [' + (f.kind || '') + '] ' + (f.content || '') + '(' + [f.source, f.year, f.region].filter(Boolean).join(',') + ')').join('\n'),
    card: cardText(asset, target, a),
    search_results: search.resultsBrief(batches),
    target, item_json: JSON.stringify(before), note
  });
  const out = await callJson(run, cfg, prompt, '按意见重做', o => o.item && typeof o.item === 'object' && !Array.isArray(o.item));
  const ch = out.change || {};
  const tmp = { ai_marks: {} };
  markChange(tmp, target, { ...ch, by: 'revise', note }, batches);
  saveRunMerge(run); // 留住调用流水与搜索记录,不动盘上的分析/状态
  return { target, before, after: out.item, mark: tmp.ai_marks[target], reply: out.reply || '', searched: useSearch };
}

// 自写标题审核:可以用 / 不能用 + 理由;可以用时附上观众问题和期待方向,由前端写回 title
async function auditTitle(runId, draft, title) {
  const { run, cfg, asset } = loadRunAsset(runId);
  assertReviewable(run); // 审核结果只落在待确认的草稿里,已确认任务没有落点
  const t = String(title || '').trim();
  if (!t) throw Object.assign(new Error('标题为空'), { status: 400 });
  const a = draft || run.analysis || {};
  const { vars } = frameworkVars(run, asset);
  const prompt = fillVars(readPrompt('title_audit.md'), { ...vars, thesis: JSON.stringify(a.thesis_card || {}), title: t });
  const out = await callJson(run, cfg, prompt, '标题审核', o => /可以用|不能用/.test(o.verdict || ''));
  out.ok = /可以用/.test(out.verdict);
  out.title = t;
  saveRunMerge(run);
  return out;
}

module.exports = {
  loadTrackCards, pickTrackCard, buildAnalysisPrompt, analysisBrief, acceptedGaps,
  analysisContext, cloneJson, analysisShapeError, runAnalysis, buildCheckPrompt,
  applyK3, applyOptionExact, scriptProgramStats, v1Text, runScriptCheck,
  frameworkVars, fillVars, callJson, getTarget, setTarget, needsList, mergeAdjust, runAutoAdjust, reviseItem, auditTitle
};
