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
    pro: refsToLinks(c.pro_refs, batches), con: refsToLinks(c.con_refs, batches)
  }));
  let chosen = str(o.chosen);
  const chk = checks.find(c => c.id === chosen);
  if (chosen && chosen !== 'NEW' && (!ids.has(chosen) || (chk && chk.verdict === '站不住'))) {
    // 选了不存在的或站不住的:改选第一个站得住的,没有就当没选
    const ok = checks.find(c => c.verdict !== '站不住');
    chosen = ok ? ok.id : '';
  }
  const f = o.final && typeof o.final === 'object' ? o.final : {};
  return {
    checks, chosen, why: str(o.why),
    final: chosen ? { belief: str(f.belief), claim: str(f.claim), one_line: str(f.one_line), method: arr(f.method).map(str), ending_landing: str(f.ending_landing), boundary: str(f.boundary) } : null,
    facts: arr(o.facts).filter(x => x && x.content).slice(0, 15).map(x => ({ content: str(x.content), year: str(x.year), region: str(x.region), note: str(x.note), sources: refsToLinks(x.refs, batches) }))
      .filter(x => x.sources.length), // 没有真实出处的不收
    con_facts: arr(o.con_facts).filter(x => x && x.content).slice(0, 8).map(x => ({ content: str(x.content), how_to_handle: str(x.how_to_handle), sources: refsToLinks(x.refs, batches) })),
    missing: arr(o.missing).map(str).filter(Boolean).slice(0, 8)
  };
}

async function scout(run, cfg, asset, setStage) {
  const A = an();
  const { vars } = A.frameworkVars(run, asset);
  const ready = search.searchStatus(cfg).ready;
  const methods = readPrompt('thesis_methods.md');
  const keep = A.keepNotesText ? A.keepNotesText(run, 'analysis') : '';
  const out = { key: scoutKey(run), at: new Date().toISOString(), searched: false, angles: [], recommended: '', rec_why: '', search_runs: [] };
  const t0 = Date.now();
  // 先摸底:按题目原文搜一次,让角度从真实资料里长出来(联网定论点)
  let disc = [];
  if (ready) {
    setStage('定论点:先按题目搜一轮');
    disc = await search.runQueries([{ query: String(run.topic || '').slice(0, 100), target: '摸底' }], run.topic, cfg, { max: 1 });
  }
  setStage('定论点:想 3 个角度');
  const prompt = A.fillVars(readPrompt('thesis_angles.md'), {
    ...vars, thesis_methods: methods, keep_notes: keep, max_queries: MAX_Q,
    discovery: disc.length && arr(disc[0].results).length ? '【先搜了一轮(按题目原文)】\n' + search.resultsBrief(disc) : ''
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
  setStage('定论点:核对资料、挑论点');
  const pp = A.fillVars(readPrompt('thesis_pick.md'), {
    ...vars, thesis_methods: methods, angle_count: out.angles.length, angles: anglesText(out.angles), results: search.resultsBrief(all)
  });
  const po = await A.callJson(run, cfg, pp, '核对论点', pickOk);
  out.pick = cleanPick(po, out.angles, all);
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
  const lines = [head,
    '选定论点(' + (p.chosen === 'NEW' ? '资料里发现的新角度' : p.chosen) + '):' + f.one_line,
    '  原来以为:' + f.belief + '\n  要证明:' + f.claim + (f.ending_landing ? '\n  结尾落点:' + f.ending_landing : '') + (f.boundary ? '\n  边界:' + f.boundary : ''),
    '  为什么选它:' + p.why];
  const others = p.checks.filter(c => c.id !== p.chosen);
  if (others.length) lines.push('没选的角度:' + others.map(c => c.id + '(' + c.verdict + ':' + c.note + ')').join(';'));
  if (p.facts.length) lines.push('已核对的事实(有出处,写进事实表时 kind 标「事实」,source/url 照抄):\n' + p.facts.map(x => '- ' + x.content + (x.year ? '(' + x.year + (x.region ? ',' + x.region : '') + ')' : '') + ' | ' + x.sources.map(s => (s.site || s.title) + ' ' + s.url).join(' ; ') + (x.note ? ' | ' + x.note : '')).join('\n'));
  if (p.con_facts.length) lines.push('和论点相反、必须正面处理的事实(写进 thesis_check.contradicts,稿里不能藏):\n' + p.con_facts.map(x => '- ' + x.content + (x.sources[0] ? ' | ' + x.sources[0].url : '') + (x.how_to_handle ? ' → ' + x.how_to_handle : '')).join('\n'));
  if (p.missing.length) lines.push('还没查到(事实表里标「待查」,不要编):' + p.missing.join(';'));
  lines.push('第 3 步用这个选定论点做底(可以按框架和标题把说法磨得更准,但不要换成核对时站不住的角度);第 4 步事实表先收上面已核对的事实。');
  return lines.join('\n');
}

// runAnalysis 里调用:成功写 run.thesis_scout;失败只记 error,不挡
async function ensure(run, cfg, asset, setStage) {
  if (cfg && cfg.thesis_scout === false) return null;
  const old = run.thesis_scout;
  if (old && old.key === scoutKey(run) && !old.error && arr(old.angles).length) return old;
  try {
    run.thesis_scout = await scout(run, cfg, asset, setStage);
  } catch (e) {
    run.thesis_scout = { key: scoutKey(run), at: new Date().toISOString(), error: e.message, angles: [] };
  }
  return run.thesis_scout;
}

module.exports = { ensure, scout, researchText, queriesOf, cleanAngles, cleanPick, scoutKey };
