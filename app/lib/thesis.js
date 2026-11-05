// v1.77 写前分析之前先定论点:出 3 个角度 → 联网搜正反资料 → 核对挑选 → 结果带进写前分析
// 没开联网搜索时只出角度(标「未联网核对」),写前分析照旧自己定论点,只是多了几个候选可参考。
// 失败一律不挡写前分析。同一题目 + 同一框架做过的直接复用(重做分析、重试不重复花钱)。
const fs = require('fs');
const path = require('path');
const search = require('./search');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');
const readPrompt = f => fs.readFileSync(path.join(PROMPTS_DIR, f), 'utf-8');
const MAX_Q = 7; // 角度查询词上限(另有 1 条程序按题目搜的「先摸底」)
const VERDICTS = ['站得住', '收窄后站得住', '站不住'];

function an() { return require('./analysis'); }
// 题目、框架、参考资料任何一个变了就重做
function scoutKey(run) {
  const m = String(run.materials || '');
  let h = 0;
  for (let i = 0; i < m.length; i++) h = (h * 31 + m.charCodeAt(i)) | 0;
  return String(run.topic || '').trim() + '|' + run.asset_id + '|' + m.length + ':' + h;
}
function arr(v) { return Array.isArray(v) ? v : []; }
function str(v) { return v == null ? '' : String(v); }

function anglesOk(o) { return o && Array.isArray(o.angles) && o.angles.filter(x => x && (x.one_line || x.claim)).length >= 1; }
function pickOk(o) { return o && Array.isArray(o.checks) && typeof o.chosen === 'string'; }

function cleanAngles(o) {
  return arr(o.angles).filter(x => x && typeof x === 'object' && (x.one_line || x.claim)).slice(0, 4).map((x, i) => ({
    id: str(x.id) || ('A' + (i + 1)), belief: str(x.belief), claim: str(x.claim), one_line: str(x.one_line || x.claim),
    method: arr(x.method).map(str).filter(m => /^M[1-8]$/.test(m)), key_fact: str(x.key_fact), why_watch: str(x.why_watch), risk: str(x.risk),
    queries: arr(x.queries).filter(q => q && q.query).map(q => ({ query: str(q.query).slice(0, 120), side: q.side === 'con' ? 'con' : 'pro' })).slice(0, 3)
  }));
}

function anglesText(angles) {
  return angles.map(x => x.id + ' 「' + x.one_line + '」\n  原来以为:' + x.belief + '\n  要证明:' + x.claim +
    '\n  定法:' + (x.method.join('/') || '未标') + ';关键事实:' + x.key_fact + '\n  可能站不住:' + x.risk).join('\n');
}

// 查询词:每个角度轮流取(先保证每个角度都有 1 条支持 + 1 条反对),再按顺序补满
function queriesOf(angles, max) {
  const out = [], seen = new Set();
  const add = (q, a) => { const k = q.query.trim().toLowerCase(); if (!k || seen.has(k) || out.length >= max) return; seen.add(k); out.push({ query: q.query, target: a.id + (q.side === 'con' ? ' 反对' : ' 支持') }); };
  ['pro', 'con'].forEach(side => angles.forEach(a => { const q = a.queries.find(x => x.side === side); if (q) add(q, a); }));
  angles.forEach(a => a.queries.forEach(q => add(q, a)));
  return out;
}

function ledgerOf(batches) {
  return arr(batches).map(b => ({
    query: b.query, target: b.target || '', error: b.error || null,
    hits: arr(b.results).map(x => ({ ref: x.ref, title: x.title, url: x.url, date: x.date, site: x.site, quote: String(x.summary || '').replace(/\s+/g, ' ').slice(0, search.QUOTE_MAX) }))
  }));
}

// 把 R 编号换成链接(落盘、显示用)
function refsToLinks(refs, batches) { return search.resolveEvidence(arr(refs), batches).map(r => ({ ref: r.ref, title: r.title, url: r.url, date: r.date, site: r.site })); }

function cleanPick(o, angles, batches) {
  const ids = new Set(angles.map(a => a.id));
  const checks = arr(o.checks).filter(c => c && ids.has(str(c.id))).map(c => ({
    id: str(c.id), verdict: VERDICTS.includes(c.verdict) ? c.verdict : '站不住', note: str(c.note), narrowed: str(c.narrowed),
    pro: refsToLinks(c.pro_refs, batches), con: refsToLinks(c.con_refs, batches),
    card: cardOf(c, angles.find(a => a.id === str(c.id)) || {}, batches) // v1.89:人可能选没推荐的那个,每个角度都有一张卡
  }));
  let chosen = str(o.chosen);
  const chk = checks.find(c => c.id === chosen);
  if (chosen && chosen !== 'NEW' && (!ids.has(chosen) || (chk && chk.verdict === '站不住'))) {
    // 选了不存在的或站不住的:改选第一个站得住的,没有就当没选
    const ok = checks.find(c => c.verdict !== '站不住');
    chosen = ok ? ok.id : '';
  }
  const f = o.final && typeof o.final === 'object' ? o.final : {};
  const forOf = x => arr(x.for).map(str).filter(id => ids.has(id));
  const facts = arr(o.facts).filter(x => x && x.content).slice(0, 20).map(x => ({ content: str(x.content), year: str(x.year), region: str(x.region), note: str(x.note), for: forOf(x), sources: refsToLinks(x.refs, batches) }))
    .filter(x => x.sources.length); // 没有真实出处的不收
  checks.forEach(c => { c.enough = enoughOf(c, facts); });
  const chk2 = checks.find(c => c.id === chosen);
  const fin = chosen ? { belief: str(f.belief), claim: str(f.claim), one_line: str(f.one_line), method: arr(f.method).map(str), ending_landing: str(f.ending_landing), boundary: str(f.boundary) } : null;
  if (fin && chk2 && !fin.one_line) Object.assign(fin, finalOfCard(chk2.card));
  return {
    checks, chosen, why: str(o.why),
    final: fin,
    facts,
    con_facts: arr(o.con_facts).filter(x => x && x.content).slice(0, 10).map(x => ({ content: str(x.content), how_to_handle: str(x.how_to_handle), for: forOf(x), sources: refsToLinks(x.refs, batches) })),
    missing: arr(o.missing).map(str).filter(Boolean).slice(0, 8)
  };
}

// ---------- v1.89 论点卡:人来选论点 ----------
// 卡上的话全是中文大白话;「整篇大概会这样讲」照原片结构一段一行
function cardOf(c, a, batches) {
  const key = c.key_ref ? refsToLinks([c.key_ref], batches)[0] || null : null;
  return {
    belief: str(c.belief) || str(a.belief), claim: str(c.claim) || str(a.claim),
    one_line: str(c.one_line) || str(c.narrowed) || str(a.one_line), ending_landing: str(c.ending_landing), boundary: str(c.boundary),
    opening_line: str(c.opening_line), key,
    outline: arr(c.outline).filter(x => x && typeof x === 'object' && str(x.says).trim()).slice(0, 12).map(x => ({ says: str(x.says), uses: str(x.uses), leaves: str(x.leaves) })),
    missing: arr(c.missing).map(str).filter(Boolean).slice(0, 6)
  };
}
// 资料够不够:程序数,不听 AI 自己说。够 = 关键事实查到了 + 至少 3 个不同来源;勉强 = 有来源但不到;不够 = 一个来源都没有
const ENOUGH_MIN = 3;
function enoughOf(c, facts) {
  const own = facts.filter(f => !f.for.length || f.for.includes(c.id));
  const urls = new Set([...c.pro.map(p => p.url), ...own.flatMap(f => f.sources.map(s => s.url))].filter(Boolean));
  const n = urls.size, key = !!(c.card && c.card.key);
  return { level: key && n >= ENOUGH_MIN ? '够' : n >= 1 ? '勉强' : '不够', sources: n, key_found: key, facts: own.length };
}
function finalOfCard(card) {
  return { belief: str(card.belief), claim: str(card.claim), one_line: str(card.one_line), method: [], ending_landing: str(card.ending_landing), boundary: str(card.boundary) };
}
function chosenOutline(ts) {
  if (!ts || !ts.user_pick) return [];
  const c = arr((ts.pick || {}).checks).find(x => x.id === ts.user_pick.id);
  return c && c.card ? arr(c.card.outline) : [];
}
function outlineText(outline) {
  return arr(outline).map((x, i) => (i + 1) + '. ' + x.says + (x.uses ? '(用:' + x.uses + ')' : '') + (x.leaves ? ' → 留下:' + x.leaves : '')).join('\n');
}
// 建任务时选了「我来选论点」、论点调研出了角度、人还没选 → 停下来
function needHold(run) {
  const ts = run && run.thesis_scout;
  return !!(run && run.thesis_choose && ts && !ts.error && arr(ts.angles).length && !ts.user_pick);
}
// 人选定:pick.chosen 换成人选的,final 按那张卡写
function choose(run, id) {
  const ts = run.thesis_scout;
  if (!ts || !arr(ts.angles).length) throw Object.assign(new Error('这个任务还没有论点可选'), { status: 400 });
  const a = ts.angles.find(x => x.id === id);
  if (!a) throw Object.assign(new Error('没有这个论点:' + id), { status: 400 });
  const c = ts.pick ? arr(ts.pick.checks).find(x => x.id === id) : null;
  ts.user_pick = { id, at: new Date().toISOString(), recommended: (ts.pick && ts.pick.chosen) || ts.recommended || '' };
  if (ts.pick) {
    ts.pick.chosen = id;
    ts.pick.final = c ? finalOfCard(c.card) : { belief: a.belief, claim: a.claim, one_line: a.one_line, method: a.method, ending_landing: '', boundary: '' };
  }
  return ts;
}
// 把存下来的搜索记录还原成 runQueries 的格式(改一句再核对时和新搜的一起给 AI)
function batchesFrom(runs) {
  return arr(runs).map(b => ({ query: b.query, target: b.target, error: b.error, results: arr(b.hits).map(h => ({ ref: h.ref, title: h.title, url: h.url, date: h.date, site: h.site, summary: h.quote || '' })) }));
}
function maxRef(batches) { return batches.reduce((m, b) => arr(b.results).reduce((k, x) => Math.max(k, Number(String(x.ref || '').replace(/^R/, '')) || 0), m), 0); }

async function pickAll(run, cfg, asset, ts, all, setStage) {
  const A = an();
  const { vars } = A.frameworkVars(run, asset);
  setStage('定论点:核对资料、挑论点');
  const pp = A.fillVars(readPrompt('thesis_pick.md'), {
    ...vars, thesis_methods: readPrompt('thesis_methods.md'), angle_count: ts.angles.length, angles: anglesText(ts.angles), results: search.resultsBrief(all)
  });
  const po = await A.callJson(run, cfg, pp, '核对论点', pickOk);
  ts.pick = cleanPick(po, ts.angles, all);
}

// 人改了一句:整理成新角度 → 按它搜 → 连同原来的角度一起再核对一次 → 再停下来给人看
async function editAngle(run, cfg, asset, ts, req, setStage) {
  const A = an();
  const { vars } = A.frameworkVars(run, asset);
  const base = ts.angles.find(a => a.id === req.base) || ts.angles[0];
  setStage('定论点:整理你改的论点');
  const eo = await A.callJson(run, cfg, A.fillVars(readPrompt('thesis_edit.md'), { ...vars, today: require('./pipeline').todayStr(), base: base ? anglesText([base]) : '(无)', text: req.text }), '改论点整理', o => o && o.angle && (o.angle.one_line || o.angle.claim));
  const n = ts.angles.filter(a => /^U\d+$/.test(a.id)).length + 1;
  const ang = cleanAngles({ angles: [{ ...eo.angle, id: 'U' + n }] })[0];
  if (!ang) throw new Error('没整理出论点');
  ang.user_text = req.text; ang.from = base ? base.id : '';
  ts.angles.push(ang);
  ts.recommended = ang.id;
  if (!ts.searched || !search.searchStatus(cfg).ready) return;
  setStage('定论点:按你改的论点联网核对');
  const old = batchesFrom(ts.search_runs);
  const nb = await search.runQueries(queriesOf([ang], 3), run.topic, cfg, { max: 3 });
  let k = maxRef(old);
  nb.forEach(b => arr(b.results).forEach(x => { x.ref = 'R' + (++k); }));
  const all = [...old, ...nb];
  ts.search_runs = ledgerOf(all);
  await pickAll(run, cfg, asset, ts, all, setStage);
}

// 页面上的三个按钮:选这个 / 改一句再核对 / 重出 3 个
function holdChoice(runId, body) {
  const store = require('./store');
  const run = store.getRun(runId);
  if (!run) throw Object.assign(new Error('任务不存在'), { status: 404 });
  if (run.status !== 'thesis_hold') throw Object.assign(new Error('这个任务现在不是「待选论点」(当前: ' + run.status + ')'), { status: 400 });
  const b = body || {}, action = str(b.action);
  const now = new Date().toISOString();
  if (action === 'pick') {
    choose(run, str(b.id));
    run.steps = { ...(run.steps || {}), thesis_pick: { status: 'done', at: now, choice: str(b.id) } };
  } else if (action === 'edit') {
    const text = str(b.text).trim();
    if (!text) throw Object.assign(new Error('改的论点是空的'), { status: 400 });
    if (text.length > 300) throw Object.assign(new Error('论点写一句话就行(300 字以内)'), { status: 400 });
    run.thesis_request = { action: 'edit', base: str(b.id), text };
    run.steps = { ...(run.steps || {}), thesis_pick: { status: 'checking', at: now, what: '核对你改的论点' } };
  } else if (action === 'regen') {
    run.thesis_request = { action: 'regen' };
    run.steps = { ...(run.steps || {}), thesis_pick: { status: 'checking', at: now, what: '重出 3 个论点' } };
  } else throw Object.assign(new Error('不认识的操作:' + action), { status: 400 });
  run.thesis_resume = true; // 接着跑写前分析时不再做一遍快速适配判断
  run.status = 'analyzing';
  delete run.error;
  store.saveRun(run);
  const fail = e => { const r = store.getRun(runId); if (r) { r.status = 'failed'; r.error = (r.draft_first ? '一键生成异常: ' : '写前分析异常: ') + e.message; store.saveRun(r); } };
  if (run.draft_first) require('./review').runDraftFirst(runId).catch(fail);
  else an().runAnalysis(runId).catch(fail);
  return { ok: true, action };
}

async function scout(run, cfg, asset, setStage, opts) {
  const A = an();
  const { vars } = A.frameworkVars(run, asset);
  const ready = search.searchStatus(cfg).ready;
  const methods = readPrompt('thesis_methods.md');
  const keep = A.keepNotesText ? A.keepNotesText(run, 'analysis') : '';
  const out = { key: scoutKey(run), at: new Date().toISOString(), searched: false, angles: [], recommended: '', rec_why: '', search_runs: [] };
  const t0 = Date.now();
  // 先摸底:按题目原文搜一次,让角度从真实资料里长出来(联网定论点)
  let disc = [];
  // v1.84:建任务前预判时已经按题目搜过同一条(reuseDiscovery),直接用,不重搜;预判核对过的反转角度带进出角度的提示词
  const T = require('./twist');
  const pre = ready ? T.reuseDiscovery(run) : null;
  const tw = T.twistForRun(run);
  if (tw) out.twist = tw;
  if (pre) { disc = pre; out.reused_discovery = true; }
  else if (ready) {
    setStage('定论点:先按题目搜一轮');
    disc = await search.runQueries([{ query: String(run.topic || '').slice(0, 100), target: '摸底' }], run.topic, cfg, { max: 1 });
  }
  setStage('定论点:想 3 个角度');
  const prompt = A.fillVars(readPrompt('thesis_angles.md'), {
    ...vars, thesis_methods: methods, max_queries: MAX_Q,
    keep_notes: keep + (opts && arr(opts.avoid).length ? '\n【人已经看过、不要的论点(这次换完全不同的方向,不要换个说法再出一遍)】\n' + opts.avoid.map(x => '- ' + x).join('\n') : ''),
    discovery: (disc.length && arr(disc[0].results).length ? '【先搜了一轮(按题目原文)】\n' + search.resultsBrief(disc) : '') + (tw ? '\n\n' + T.scoutHint(tw) : '')
  });
  const ao = await A.callJson(run, cfg, prompt, '定论点角度', anglesOk);
  out.angles = cleanAngles(ao);
  out.recommended = out.angles.some(a => a.id === str(ao.recommended)) ? str(ao.recommended) : (out.angles[0] || {}).id || '';
  out.rec_why = str(ao.why);
  if (!ready) {
    out.secs = Math.round((Date.now() - t0) / 100) / 10;
    out.note = '没开联网搜索:只出了角度,没有核对资料。';
    return out;
  }
  setStage('定论点:联网搜正反资料');
  const queries = queriesOf(out.angles, MAX_Q);
  const batches = await search.runQueries(queries, run.topic, cfg, { max: MAX_Q });
  // 摸底的结果接着编号,核对时也能引用
  let n = batches.reduce((m, b) => m + arr(b.results).length, 0);
  disc.forEach(b => arr(b.results).forEach(x => { x.ref = 'R' + (++n); }));
  const all = [...batches, ...disc];
  out.searched = true;
  out.search_runs = ledgerOf(all);
  const hitN = all.reduce((m, b) => m + arr(b.results).length, 0);
  if (!hitN) {
    out.secs = Math.round((Date.now() - t0) / 100) / 10;
    out.note = '联网搜索没有返回结果(' + (all.map(b => b.error).filter(Boolean)[0] || '都没搜到') + '),论点未核对。';
    return out;
  }
  await pickAll(run, cfg, asset, out, all, setStage);
  out.secs = Math.round((Date.now() - t0) / 100) / 10;
  return out;
}

// 写进写前分析提示词的那一段
function researchText(ts) {
  if (!ts || !arr(ts.angles).length) return '';
  const p = ts.pick;
  const head = '【写前论点调研(写前分析之前做的:先想角度,' + (ts.searched ? '再联网查了支持和反对的资料' : '没有联网核对') + ')】';
  if (!p || !p.final) {
    return head + '\n候选角度(' + (ts.searched ? '核对后没有一个站得住,第 3 步自己定论点,可以参考但不要照用' : '未核对,第 3 步可以参考,用之前要确认关键事实成立') + '):\n' +
      ts.angles.map(a => '- ' + a.id + ' ' + a.one_line + '(关键事实:' + a.key_fact + ')' + (p ? ' → ' + ((p.checks.find(c => c.id === a.id) || {}).note || '') : '')).join('\n') +
      (p && p.missing.length ? '\n还没查到:' + p.missing.join(';') : '');
  }
  const f = p.final;
  const byUser = !!(ts.user_pick && ts.user_pick.id === p.chosen);
  const mine = x => !arr(x.for).length || x.for.includes(p.chosen); // v1.89:只收撑住(或反对)选定论点的事实
  const facts = p.facts.filter(mine), cons = p.con_facts.filter(mine);
  const outline = byUser ? chosenOutline(ts) : [];
  const lines = [head,
    ...(ts.twist ? [require('./twist').scoutHint(ts.twist)] : []),
    '选定论点(' + (byUser ? '人亲自选的' : p.chosen === 'NEW' ? '资料里发现的新角度' : p.chosen) + '):' + f.one_line,
    '  原来以为:' + f.belief + '\n  要证明:' + f.claim + (f.ending_landing ? '\n  结尾落点:' + f.ending_landing : '') + (f.boundary ? '\n  边界:' + f.boundary : ''),
    byUser ? '  这是人看过论点卡后亲自选的:第 3 步论点卡的「一句话论点」「原来以为」「真相」「结尾落点」只能把说法磨准,不能换意思,也不能换成没选的角度。' : '  为什么选它:' + p.why];
  if (outline.length) lines.push('人选论点时看到的「整篇大概会这样讲」(第 5 步模块取舍、留存地图按这个顺序和内容安排;某一段实在要不一样,在 adjustments 里记一条说明哪里不一样、为什么):\n' + outlineText(outline));
  const others = p.checks.filter(c => c.id !== p.chosen && !/^U\d+$/.test(c.id));
  if (others.length) lines.push('没选的角度:' + others.map(c => c.id + '(' + c.verdict + ':' + c.note + ')').join(';'));
  if (facts.length) lines.push('已核对的事实(有出处,写进事实表时 kind 标「事实」,source/url 照抄):\n' + facts.map(x => '- ' + x.content + (x.year ? '(' + x.year + (x.region ? ',' + x.region : '') + ')' : '') + ' | ' + x.sources.map(s => (s.site || s.title) + ' ' + s.url).join(' ; ') + (x.note ? ' | ' + x.note : '')).join('\n'));
  if (cons.length) lines.push('和论点相反、必须正面处理的事实(写进 thesis_check.contradicts,稿里不能藏):\n' + cons.map(x => '- ' + x.content + (x.sources[0] ? ' | ' + x.sources[0].url : '') + (x.how_to_handle ? ' → ' + x.how_to_handle : '')).join('\n'));
  if (p.missing.length) lines.push('还没查到(事实表里标「待查」,不要编):' + p.missing.join(';'));
  lines.push('第 3 步用这个选定论点做底(可以按框架和标题把说法磨得更准,但不要换成核对时站不住的角度);第 4 步事实表先收上面已核对的事实。');
  return lines.join('\n');
}

// runAnalysis 里调用:成功写 run.thesis_scout;失败只记 error,不挡
async function ensure(run, cfg, asset, setStage) {
  if (cfg && cfg.thesis_scout === false && !run.thesis_choose) return null;
  const req = run.thesis_request;
  if (req && run.thesis_scout && arr(run.thesis_scout.angles).length) {
    // v1.89:人在论点卡上点了「改一句再核对」或「重出 3 个」
    const ts = run.thesis_scout;
    delete ts.request_error;
    try {
      if (req.action === 'regen') {
        const avoid = [...arr(ts.avoid), ...ts.angles.map(a => a.one_line)].filter(Boolean).slice(-12);
        const fresh = await scout(run, cfg, asset, setStage, { avoid });
        fresh.avoid = avoid;
        run.thesis_scout = fresh;
      } else if (req.action === 'edit') {
        await editAngle(run, cfg, asset, ts, req, setStage);
      }
    } catch (e) {
      ts.request_error = (req.action === 'regen' ? '重出论点没成功:' : '核对你改的论点没成功:') + e.message;
    }
    delete run.thesis_request;
    return run.thesis_scout;
  }
  delete run.thesis_request;
  const old = run.thesis_scout;
  if (old && old.key === scoutKey(run) && !old.error && arr(old.angles).length) return old;
  try {
    run.thesis_scout = await scout(run, cfg, asset, setStage);
  } catch (e) {
    run.thesis_scout = { key: scoutKey(run), at: new Date().toISOString(), error: e.message, angles: [] };
  }
  return run.thesis_scout;
}

module.exports = { ensure, scout, researchText, queriesOf, cleanAngles, cleanPick, scoutKey, needHold, choose, holdChoice, enoughOf, cardOf, chosenOutline, outlineText, batchesFrom, ENOUGH_MIN };
