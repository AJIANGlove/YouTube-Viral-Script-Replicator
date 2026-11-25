'use strict';
// v1.134 新流程「只改一次」:初稿写好后,稿子从初稿到终稿只整篇动一次。
// ① 一次体检:二稿审稿报告、开头单独审 + 三选一、信息复现、论点核对、账本、听感,全部只查不改,合并成一张按章节的清单
// ② 拍板:人在清单上勾要改的(关键的默认勾上),开头三选一(或保留现在的)
// ③ 整篇重写一次:先写「一条线」大纲再写全文;选中的开头程序直接放回去;新出现的数字列出来让人确认(走网页版 / 本地模型)
// ④ 终检:只查不改,给结论和硬伤(数字错、和事实矛盾)
// ⑤ 硬伤只修这一句:直接替换那一句,不让 AI 再动别的地方
// 老流程(初稿检查 → 二稿 → 终审 → 补改…)照旧,建任务时选 flow: 'classic'。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const checks = require('./checks');

const rv = () => require('./review');
const pl = () => require('./pipeline');
const an = () => require('./analysis');
const ob = () => require('./openbeats');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');
const readPrompt = f => fs.readFileSync(path.join(PROMPTS_DIR, f), 'utf-8');
const hash = t => crypto.createHash('sha1').update(String(t || '')).digest('hex').slice(0, 12);
const arr = v => (Array.isArray(v) ? v : []);
const now = () => new Date().toISOString();

const FLOW = 'one_pass';
function isOn(run) { return !!run && run.flow === FLOW; }

// 同一任务同一时刻只跑一步(体检 / 重写 / 终检 / 修一句)
const busy = new Map();
function busyOf(runId) { return busy.get(runId) || ''; }
async function withBusy(runId, label, fn) {
  if (busy.has(runId)) throw Object.assign(new Error('「' + busy.get(runId) + '」正在跑,等它跑完'), { status: 409 });
  busy.set(runId, label);
  try { return await fn(); } finally { busy.delete(runId); }
}

function cur(run) { return rv().currentScript(run); }
function titleOf(run) { return (((run.analysis || {}).title || {}).final_title) || run.topic || ''; }
function lang(run) { return (run.audience || {}).target_language || ''; }
function listenOpts(run) {
  const nw = (run.checks || {}).narration || require('./narration').narrationWpm(run, null);
  return { wpm: nw.wpm, title: titleOf(run), lang: lang(run), locked: ob().on(run), track: ob().trackOf(run) };
}
function save(runId, patch) {
  const f = store.getRun(runId);
  if (!f) return null;
  f.onepass = { ...(f.onepass || {}), ...patch };
  store.saveRun(f);
  return f;
}

// ---------- ① 一次体检 ----------
async function claimFind(run, cfg, text) {
  const R = rv();
  const sl = R.openingSlice(run);
  const out0 = await an().callJson(run, cfg, an().fillVars(readPrompt('claim_check.md'), {
    target_language: lang(run), title: titleOf(run),
    picked: run.thesis_scout && run.thesis_scout.user_pick ? an().PICKED_RULE + '\n一句话论点:' + (((run.analysis || {}).thesis_card || {}).one_line_thesis || '') : '(无)',
    opening: sl.lines.map(l => l.text).join('\n') || '(无)', script: checks.extractFinalScript(text),
    ledger: R.claimLedgerText(run), off_ledger: R.offLedgerAmounts(run).map(x => '- ' + x.ch + '「' + x.amount + '」' + (x.why ? '(' + x.why + ')' : '') + ':' + x.text).join('\n') || '(无)'
  }), '论点核对·体检', o => !!R.claimVerdict(R.claimUnwrap(o)));
  const out = R.claimUnwrap(out0);
  return { verdict: R.claimVerdict(out), claim: String(out.claim || ''), calc: String(out.calc || ''), fix_claim: String(out.fix_claim || ''),
    issues: arr(out.issues).filter(x => x && x.problem).map(x => ({ chapter: (String(x.chapter || '').match(/CH\d+/i) || [''])[0].toUpperCase(),
      level: /关键|關鍵|관건|중요|핵심|critical|key|major|high/i.test(String(x.level || '')) ? '关键' : '次要',
      quote: String(x.quote || '').trim(), problem: String(x.problem), fix: String(x.fix || '') })) };
}

// 各检查的结果 → 一张清单。每条:id、章、严重(关键/一般)、默认勾不勾、出处、问题、原句、改法
// v1.134 免责 / 口径说明数一数(程序查,不调 AI):「这是我假设的 / 추정 / 不是这家店的数 / 和业界平均比 / 不能直接比」
// 全片超过 2 句就并进体检清单(关键、默认勾上),在那一次整篇重写里压到 1–2 句;结尾把开头场景整段再铺一遍也一起查
const HEDGE_RE = {
  ko: /가정(해|한|이|하면|이에요|일 뿐)|추정|제가 (잡은|정한|가정)|실제 (가게|매장|점포)?\s*(의 )?(숫자|수치|자료)가 아니|감사 자료가 아니|업계 평균|평균보다|평균이라|직접 비교|비교하기(는)? 어렵|단정하기|가게마다|매장마다|다를 수 있|그 정도 선이라고|라고만 들어/,
  en: /\b(assum(e|ed|ing|ption)s?|estimat(e|ed|es)|hypothetical|industry average|can'?t (directly )?compare|varies (by|from)|not (the|this) (shop|store|company)'?s? (real|actual)|ballpark|take (this|these) (number|figure)s? with)\b/i,
  zh: /假设|估算|推算|不是这家|行业平均|不能直接比|每家(店)?不一样|仅供参考/
};
function chaptersOf(text) {
  const out = []; let cur = null;
  String(text || '').split('\n').forEach(l => {
    const m = l.match(/^\s*\[(CH\d+)/i);
    if (m) { cur = { ch: m[1].toUpperCase(), lines: [] }; out.push(cur); return; }
    if (cur) cur.lines.push(l); else { cur = { ch: 'CH01', lines: [l] }; out.push(cur); }
  });
  return out.map(c => ({ ch: c.ch, sents: c.lines.join(' ').split(/(?<=[.?!。？！])\s+/).map(x => x.trim()).filter(Boolean) }));
}
function hedgeScan(text, language) {
  const L = /韩|ko/i.test(language) || /[가-힯]/.test(String(text).slice(0, 2000)) ? 'ko' : /中文|zh/i.test(language) ? 'zh' : 'en';
  const re = HEDGE_RE[L];
  const hits = [];
  chaptersOf(text).forEach(c => c.sents.forEach(s => { if (re.test(s)) hits.push({ ch: c.ch, quote: s }); }));
  return hits;
}
function grams(s) { const t = String(s).replace(/[\s.,!?'"“”‘’·…-]/g, ''); const g = new Set(); for (let i = 0; i + 3 <= t.length; i++) g.add(t.slice(i, i + 3)); return g; }
function endEchoScan(text) {
  const chs = chaptersOf(text);
  if (chs.length < 3) return [];
  const first = chs[0].sents.map(s => ({ s, g: grams(s) })).filter(x => x.g.size >= 8);
  const last = chs[chs.length - 1];
  const out = [];
  last.sents.forEach(s => {
    const g = grams(s); if (g.size < 8) return;
    const best = first.reduce((m, f) => { let n = 0; g.forEach(x => { if (f.g.has(x)) n++; }); return Math.max(m, n / Math.min(g.size, f.g.size)); }, 0);
    if (best >= 0.5) out.push({ ch: last.ch, quote: s });
  });
  return out;
}
function hedgeItems(text, language) {
  const items = [];
  const h = hedgeScan(text, language);
  if (h.length > 2) {
    const chs = [...new Set(h.map(x => x.ch))];
    items.push({ id: 'D-1', chapter: '全篇', level: '关键', checked: true, src: '免责/口径(程序数的)',
      problem: '「这是我假设的 / 估算的 / 不是这家店的真实数字 / 和行业平均比 / 不能直接比」这类提醒说了 ' + h.length + ' 次(' + chs.join('、') + '),观众还没听到结论,就先听了一堆提醒,会走神',
      quote: h[0].quote,
      fix: '全片只留 1–2 句:第一次算账时用半句话交代一次「下面是按我假设的一家店算的,听个大概」;和行业平均最多比一次;其余的直接删,不换个说法留着。出现的地方:' + h.map(x => x.ch + '「' + x.quote.slice(0, 40) + (x.quote.length > 40 ? '…' : '') + '」').join(';') });
  }
  const e = endEchoScan(text);
  if (e.length >= 2) items.push({ id: 'D-2', chapter: e[0].ch, level: '关键', checked: true, src: '结尾重复(程序查的)',
    problem: '结尾把开头的场景又整段铺了一遍(' + e.length + ' 句和开头几乎一样),听起来像在重讲',
    quote: e[0].quote, fix: '结尾回收开头只用一句话点一下那个画面,然后直接落到结论;不把开头的描写和前面的账再说一遍' });
  return items;
}
function mergeItems(run, parts) {
  const items = [];
  const add = x => {
    const ch = (String(x.chapter || '').match(/CH\d+/i) || [''])[0].toUpperCase();
    const sig = ch + '|' + String(x.quote || x.problem || '').replace(/\s+/g, '').slice(0, 24);
    const same = items.find(y => y.sig === sig && sig.length > 4);
    if (same) { if (!same.src.includes(x.src)) same.src += ' + ' + x.src; if (x.level === '关键') { same.level = '关键'; same.checked = true; } return; }
    items.push({ id: x.id, sig, chapter: ch || '全篇', level: x.level || '一般', checked: x.checked != null ? !!x.checked : x.level === '关键', src: x.src,
      problem: String(x.problem || '').trim(), quote: String(x.quote || '').trim(), fix: String(x.fix || '').trim() });
  };
  const au = parts.audit;
  if (au) {
    arr(au.issues).forEach(x => {
      const key = /S|A/.test(String(x.severity || '')) || /P0|P1/.test(String(x.priority || ''));
      add({ id: 'A-' + x.id, chapter: x.chapter, level: key ? '关键' : '一般', src: '审稿报告', problem: (x.type ? x.type + ':' : '') + (x.problem || ''), fix: x.direction || '' });
    });
  }
  arr(parts.extras).forEach(x => add({ id: x.id, chapter: x.chapter, level: /S|A/.test(String(x.severity || '')) ? '关键' : '一般', src: x.type || '核验', problem: x.problem, fix: x.direction }));
  const ic = parts.info;
  if (ic) arr(ic.problems).forEach((x, i) => add({ id: 'I-' + (i + 1), chapter: x.chapter, level: '关键', src: '信息重复', problem: (x.type ? x.type + ':' : '') + ((x.plain || {}).problem || ''), quote: x.quote, fix: (x.plain || {}).fix || '' }));
  const cc = parts.claim;
  if (cc) {
    if (cc.verdict === '不成立') add({ id: 'L-0', chapter: 'CH01', level: '关键', src: '论点核对', problem: '开头的主张「' + cc.claim + '」被稿子自己的数字推翻:' + cc.calc, fix: cc.fix_claim });
    cc.issues.forEach((x, i) => add({ id: 'L-' + (i + 1), chapter: x.chapter, level: x.level === '关键' ? '关键' : '一般', src: '论点核对', problem: x.problem, quote: x.quote, fix: x.fix }));
  }
  arr(parts.ledger).filter(x => x.used).forEach(x => add({ id: 'G-' + x.id, chapter: '', level: '关键', src: '账本', problem: '稿子里写的「' + x.used + '」来自账本 ' + rv().ledgerLine(x) + ',这个数算错了', fix: '按公式改成 ' + x.calc + (x.unit ? ' ' + x.unit : '') + ',前后用到它的句子一起改' }));
  // 稿件检查(标题和结论对不上、旧数据…):还没处理的并进来
  arr((parts.scriptCheck || {}).issues).filter(x => x && !x.applied && !x.adopted && x.problem).forEach((x, i) => {
    const opt = arr(x.options).map(o => (typeof o === 'string' ? o : (o && o.label) || '')).filter(Boolean);
    add({ id: 'S-' + (i + 1), chapter: (String(x.location || '').match(/CH\d+/i) || [''])[0], level: /K1/.test(String(x.type || '')) ? '关键' : '一般', src: '稿件检查',
      problem: x.problem, quote: x.quote, fix: opt.length ? opt.map((o, k) => (k + 1) + ') ' + o).join(';') : '' });
  });
  arr(parts.hedges).forEach(x => add(x));
  const lc = parts.listen;
  if (lc) arr(lc.issues).forEach((t, i) => add({ id: 'H-' + (i + 1), chapter: /前 \d+ 秒|开头/.test(t) ? 'CH01' : '', level: '一般', checked: true, src: '听感', problem: t }));
  const order = c => (c === '全篇' ? 0 : Number((c.match(/\d+/) || [999])[0]));
  return items.sort((a, b) => order(a.chapter) - order(b.chapter) || (a.level === '关键' ? 0 : 1) - (b.level === '关键' ? 0 : 1));
}

async function checkup(runId) {
  return withBusy(runId, '一次体检', async () => {
    const R = rv();
    const cfg = pl().loadConfig();
    let run = store.getRun(runId);
    if (!run) return;
    const text = cur(run);
    if (!text) throw new Error('稿子还没写好');
    run.review = run.review || {};
    if (!arr(run.review.versions).length) run.review.versions = [{ key: 'd1', label: '初稿', at: now(), text, issues: [] }];
    run.onepass = { stage: 'checking', started_at: now(), base_hash: hash(text), errors: {} };
    store.saveRun(run);
    const errors = {};
    const keep = (k, p) => p.catch(e => { errors[k] = e.message; return null; });
    const [, , info, claim] = await Promise.all([
      keep('audit', pl().inRun(runId, () => R.runReverseAudit(runId))),
      keep('opening', (async () => { try { await R.runOpeningCard(runId); } catch (e) { /* 开头审失败不挡三选一 */ } return R.runOpeningVariants(runId); })()),
      keep('info', R.infoReuseCheck(run, cfg, checks.extractFinalScript(text) || text, '信息复现核对·体检')),
      keep('claim', claimFind(run, cfg, text))
    ]);
    run = store.getRun(runId);
    if (!run) return;
    if (cur(run) !== text) throw new Error('体检期间稿子被改过,请重新体检');
    let extras = [], ledger = [];
    try { extras = arr((R.getView(runId).audit || {}).extras); } catch (e) { /* 视图算不出来不挡 */ }
    try { ledger = R.ledgerWrongUsed(run); } catch (e) {}
    const listen = checks.listenCheck(checks.extractFinalScript(text), listenOpts(run));
    const hedges = hedgeItems(checks.extractFinalScript(text) || text, lang(run));
    const items = mergeItems(run, { audit: (run.review || {}).audit, extras, info, claim, ledger, listen, hedges, scriptCheck: run.script_check });
    const ov = (run.review || {}).opening_variants;
    run.onepass = { ...(run.onepass || {}), stage: 'decide', checked_at: now(), items, errors, sc_merged: true,
      opening_pick: ov && ov.pick != null ? ov.pick : -1, claim: claim ? { verdict: claim.verdict, claim: claim.claim } : null };
    store.saveRun(run);
    try { require('./manual').autoLocalDone(runId); } catch (e) {}
    return run.onepass;
  });
}
function startCheckup(runId) {
  const run = store.getRun(runId);
  if (!run) throw Object.assign(new Error('任务不存在'), { status: 404 });
  if (!cur(run)) throw Object.assign(new Error('稿子还没写好'), { status: 400 });
  if (busy.has(runId)) throw Object.assign(new Error('「' + busy.get(runId) + '」正在跑'), { status: 409 });
  checkup(runId).catch(e => save(runId, { stage: 'failed', failed_at: 'checking', error: '体检没跑完:' + e.message }));
  return { ok: true };
}

// 体检清单是 v1.134 早期出的、还没并进稿件检查的问题:补进去(不调 AI);只在拍板前补
function syncScriptCheck(runId) {
  const run = store.getRun(runId);
  const op = run && run.onepass;
  if (!isOn(run) || !op || op.stage !== 'decide' || op.sc_merged || !arr(op.items).length) return false;
  const add = mergeItems(run, { scriptCheck: run.script_check }).filter(x => !op.items.some(y => y.sig === x.sig));
  op.items = op.items.concat(add);
  const order = c => (c === '全篇' ? 0 : Number((c.match(/\d+/) || [999])[0]));
  op.items.sort((a, b) => order(a.chapter) - order(b.chapter) || (a.level === '关键' ? 0 : 1) - (b.level === '关键' ? 0 : 1));
  op.sc_merged = true;
  store.saveRun(run);
  return add.length;
}

// ---------- ② 拍板 + ③ 整篇重写一次 ----------
function issuesText(items) {
  if (!items.length) return '(人没有勾具体问题:按上面的规则把整篇理顺一遍,重点去掉重复绕圈、补丁句、数字口径不一致)';
  return items.map(x => '- [' + x.id + '][' + x.chapter + '][' + x.level + '] ' + x.problem + (x.quote ? '\n  原句:「' + x.quote + '」' : '') + (x.fix ? '\n  改法:' + x.fix : '')).join('\n');
}
// 篇幅:按「目标时长 × 配音语速」给出该写多少词(和终审篇幅同一个口径);没有目标时长时退回按初稿的 80%–100%
function lengthWindow(run, base) {
  const t = rv().lengthTarget(run);
  if (!t) return null;
  return { ...t, min: Math.round(t.target * 0.9), max: Math.round(t.target * 1.05), base: rv().scriptWords(base) };
}
function lengthRule(run, base) {
  const w = lengthWindow(run, base);
  const bw = rv().scriptWords(base);
  if (!w) return '初稿约 ' + bw + ' 个词。删掉重复以后变短是对的,最多可以短 20%;**宁短勿绕**,不许为了凑字数把说过的意思再说一遍。不要比初稿长。';
  return '目标成片 ' + w.goal_min + ' 分钟,配音每分钟约 ' + w.wpm + ' 词,成稿要写 **' + w.min + '–' + w.max + ' 词**(初稿现在 ' + bw + ' 词)。' +
    (bw > w.max ? '初稿偏长:先删重复,删到这个范围就停。' : bw < w.min ? '初稿本身偏短:删掉重复以后,把讲得太快的地方展开(数字太密的句子拆开说、补上跳过的算账那一步、补一句画面),不加新事实。' : '删掉重复以后要还在这个范围里:删多了就把初稿里的算账过程、案例细节留下来。') +
    '**不许**为了凑字数把说过的意思换个说法再说一遍——字数只能靠算账过程、具体细节、案例情节撑。';
}
function factsText(run) {
  const a = run.analysis || {};
  let t = rv().variantFacts(a);
  try { const led = rv().claimLedgerText(run); if (led && led !== '(无)') t += '\n\n账本(程序重算过,以这个为准):\n' + led; } catch (e) {}
  return t;
}
function thesisText(run) { return JSON.stringify(((run.analysis || {}).thesis_card) || {}); }
function parseRewrite(content) {
  const c = String(content || '').replace(/^```[a-z]*\s*$/gim, '');
  const marks = [...c.matchAll(/^[ \t*]*=+\s*(OUTLINE|SCRIPT|NEW_NUMBERS)\s*=+[ \t*]*$/gim)].map(m => ({ name: m[1].toUpperCase(), start: m.index, end: m.index + m[0].length }));
  const sec = name => { const i = marks.findIndex(m => m.name === name); if (i < 0) return null; return c.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].start : c.length).trim(); };
  let script = sec('SCRIPT');
  if (script == null) script = ((c.match(/^\[CH\d+[\s\S]*$/m) || [''])[0]).trim();
  return { outline: sec('OUTLINE') || '', script, new_numbers: sec('NEW_NUMBERS') || '' };
}
// 稿子里「有辨识度的数」(三位以上、带小数或百分号)不在这些地方出现过的:列出来让人确认
function newNumbers(run, base, next) {
  const R = rv();
  const a = run.analysis || {};
  const allowed = new Set([base, JSON.stringify(a.facts || []), JSON.stringify(a.ledger || []), factsText(run), JSON.stringify(a.thesis_card || {}), titleOf(run)].flatMap(t => R.factNumbers(t)));
  const body = checks.extractFinalScript(next);
  const out = [];
  R.factNumbers(body).filter(n => !allowed.has(n)).forEach(n => {
    const re = new RegExp('[^.!?。\\n]*' + n.replace(/\B(?=(\d{3})+(?!\d))/g, ',?').replace(/\./g, '\\.') + '[^.!?。\\n]*[.!?。]?');
    const m = body.match(re);
    const ch = m ? ((R.scriptChapters(next).find(c => next.indexOf(m[0]) >= c.bodyStart && next.indexOf(m[0]) < c.bodyEnd) || {}).id || '') : '';
    out.push({ num: n, quote: m ? m[0].trim() : '', chapter: ch });
  });
  return out;
}

async function rewrite(runId) {
  return withBusy(runId, '整篇重写', async () => {
    const R = rv();
    const cfg = pl().loadConfig();
    let run = store.getRun(runId);
    const op = run.onepass || {};
    const picked = arr(op.items).filter(x => arr(op.picked_ids).includes(x.id));
    // 每次重写都从初稿开始,不在上一次重写的稿子上叠着改:不管重做几次,稿子从初稿到成稿都只动这一次
    let base = (arr((run.review || {}).versions).find(x => x.key === 'd1') || {}).text || cur(run);
    const ov = (run.review || {}).opening_variants;
    const v = op.opening_choice != null && op.opening_choice >= 0 && ov ? arr(ov.variants).find(x => x.i === op.opening_choice) : null;
    if (v) { const b2 = ob().replaceOpening(base, v.text); if (b2) base = b2; }
    const tags = R.scriptChapters(base).map(c => c.tag);
    const t0 = Date.now();
    save(runId, { stage: 'rewriting', rewrite_started: now(), error: '' });
    const openingRule = v ? 'CH01 的正文已经由人选定(就是下面初稿里的 CH01),一字不改,原样照抄;CH02 第一句要能接上 CH01 最后一句。'
      : ob().on(run) ? 'CH01 是照原片节拍写的开头,保留每一拍的内容和顺序,只许为了接后文改词;不许提前说破全片的答案。'
      : 'CH01 前 30 秒按这个顺序:兑现标题 → 和观众扯上关系 → 留一个没答案的问题 → 进第一个数字;不打招呼、不报流程。';
    const prompt = an().fillVars(readPrompt('onepass_rewrite.md'), {
      target_language: lang(run), title: titleOf(run), thesis: thesisText(run), opening_rule: openingRule,
      words: String(R.scriptWords(base)), length_rule: lengthRule(run, base), issues: issuesText(picked), note: op.note ? '\n人另外交代的:' + op.note : '',
      facts: factsText(run), script: base
    });
    let r = await pl().inRun(runId, () => R.callLong(run, cfg, prompt, '一遍重写'));
    let p = parseRewrite(r.content);
    // 篇幅守门(用户 2026-11-25:目标 15 分钟,重写后只剩 1,054 词、配出来 9 分多钟):短得太多,带上原因从初稿再写一次(还是这一次重写,不叠着改)
    const lw = lengthWindow(run, base);
    const shortBy = w => lw && w < lw.min * 0.92;
    let firstWords = 0;
    if (p.script && shortBy(R.scriptWords(p.script))) {
      firstWords = R.scriptWords(p.script);
      const fb = '\n\n【注意】上一次你写出来只有 ' + firstWords + ' 词,按配音速度约 ' + (Math.round(firstWords / lw.wpm * 10) / 10) + ' 分钟,目标是 ' + lw.goal_min + ' 分钟(' + lw.min + '–' + lw.max + ' 词)。删得太多了:这次只删「同一个意思又说一遍」的句子,初稿里的算账过程、每一笔钱怎么来的、案例的具体情节、画面都要留下;还不够就把数字太密的句子拆开说、补上跳过的那一步。仍然不许把说过的意思再说一遍、不许加新事实。';
      r = await pl().inRun(runId, () => R.callLong(run, cfg, prompt + fb, '一遍重写·篇幅不够再写'));
      const p2 = parseRewrite(r.content);
      if (p2.script && R.scriptWords(p2.script) > firstWords) p = p2;
    }
    let next = require('./textnorm').normalizeChapterTags(p.script);
    const err = checks.chapterStructureError(next);
    if (err) throw new Error('重写出来的稿子章节不对(' + err + '),稿子没换。可以点「重新重写」');
    const got = R.scriptChapters(next).map(c => c.tag);
    if (got.length !== tags.length) throw new Error('重写出来的稿子有 ' + got.length + ' 章,原来是 ' + tags.length + ' 章,稿子没换。可以点「重新重写」');
    if (v) { const n2 = ob().replaceOpening(next, v.text); if (n2) next = n2; }
    const pure = await R.purifyText(run, cfg, next, '一遍重写');
    next = pure.text;
    const fresh = store.getRun(runId) || run;
    const before = cur(fresh);
    R.writeScript(fresh, next, v ? '' : '一遍重写'); // 人选了开头的:开头就是人选的,不拦;没选的照旧守住锁定开头
    const nn = newNumbers(fresh, base, cur(fresh));
    fresh.review = fresh.review || {};
    fresh.review.versions = arr(fresh.review.versions).filter(x => x.key !== 'op');
    fresh.review.versions.push({ key: 'op', label: '重写稿', at: now(), text: cur(fresh), base_text: before, issues: [] });
    fresh.onepass = { ...(fresh.onepass || {}), stage: 'final_check', rewrite: { at: now(), secs: Math.round((Date.now() - t0) / 100) / 10, outline: p.outline, new_numbers_note: p.new_numbers, base: before, base_with_opening: base, opening_used: v ? v.i : -1, words: R.scriptWords(cur(fresh)), base_words: R.scriptWords(before) },
      new_numbers: nn.map((x, i) => ({ id: 'N' + (i + 1), ...x, ok: false })), fixes: [] };
    if (firstWords) fresh.onepass.rewrite.retried_short = firstWords;
    if (run.attempts) fresh.attempts = an().mergeAttempts(fresh.attempts, run.attempts);
    store.saveRun(fresh);
    return true;
  });
}

function decide(runId, body = {}) {
  const run = store.getRun(runId);
  if (!run) throw Object.assign(new Error('任务不存在'), { status: 404 });
  if (!isOn(run)) throw Object.assign(new Error('这篇用的是老流程'), { status: 400 });
  if (busy.has(runId)) throw Object.assign(new Error('「' + busy.get(runId) + '」正在跑'), { status: 409 });
  const op = run.onepass || {};
  if (!arr(op.items).length && op.stage !== 'decide' && !body.again) throw Object.assign(new Error('还没有体检清单'), { status: 400 });
  const ids = arr(body.ids).map(String).filter(id => arr(op.items).some(x => x.id === id));
  const ovN = Number(body.opening);
  run.onepass = { ...op, picked_ids: ids, opening_choice: Number.isFinite(ovN) ? ovN : -1, note: String(body.note || '').trim().slice(0, 2000), decided_at: now() };
  store.saveRun(run);
  (async () => {
    try { await rewrite(runId); } catch (e) { save(runId, { stage: 'failed', failed_at: 'rewriting', error: '整篇重写没成功:' + e.message }); return; }
    try { await finalCheck(runId); } catch (e) { save(runId, { stage: 'failed', failed_at: 'final_check', error: '终检没跑完:' + e.message }); }
    try { await rv().explainRun(runId); } catch (e) {}
  })();
  return { ok: true };
}

// ---------- ④ 终检(只查不改) ----------
async function finalCheck(runId) {
  return withBusy(runId, '终检', async () => {
    const R = rv();
    const cfg = pl().loadConfig();
    const run = store.getRun(runId);
    const op = run.onepass || {};
    const text = cur(run);
    save(runId, { stage: 'final_check' });
    const picked = arr(op.items).filter(x => arr(op.picked_ids).includes(x.id));
    const prompt = an().fillVars(readPrompt('onepass_final.md'), {
      target_language: lang(run), title: titleOf(run), thesis: thesisText(run), issues: issuesText(picked), facts: factsText(run), script: checks.extractFinalScript(text)
    });
    // 终检和「重讲 / 绕圈」检查同时跑:绕圈是这次最影响读下去的毛病,单独查、单独列
    const [out, ic] = await Promise.all([
      R.viaStep('final_audit', cfg, (c, sfx) => an().callJson(run, c, prompt, '一遍终检' + sfx, o => !!o && typeof o === 'object' && (o.verdict != null || Array.isArray(o.hard)))),
      R.infoReuseCheck(run, cfg, checks.extractFinalScript(text) || text, '信息复现核对·终检').catch(() => null)
    ]);
    const loops = ic ? arr(ic.problems).map((x, i) => ({ id: 'R' + (i + 1), chapter: x.chapter || '', type: x.type || '重讲', quote: String(x.quote || ''), problem: (x.plain || {}).problem || x.type || '', fix: (x.plain || {}).fix || '' })) : null;
    const fresh = store.getRun(runId) || run;
    if (cur(fresh) !== text) throw new Error('终检期间稿子被改过,请重新终检');
    const hard = arr(out.hard).filter(x => x && x.problem).map((x, i) => {
      const quote = String(x.quote || '').trim();
      return { id: 'F' + (i + 1), chapter: (String(x.chapter || '').match(/CH\d+/i) || [''])[0].toUpperCase(), kind: String(x.kind || '硬伤'), quote, problem: String(x.problem), fix: String(x.fix || '').trim(),
        level: /可改可不改|可以不改|次要|minor/i.test(String(x.level || '')) ? '可改可不改' : '必须改', plain: String(x.plain || '').trim(),
        found: !!(quote && R.locate(text, quote)), done: false };
    });
    // 口径问题(整篇用哪个基准):一条,不拆成一句句的硬伤
    const basis = arr(out.basis).filter(x => x && x.topic).map((x, i) => ({ id: 'B' + (i + 1), topic: String(x.topic), options: arr(x.options).map(String).slice(0, 3), recommend: String(x.recommend || ''), why: String(x.why || ''), quotes: arr(x.quotes).map(String).slice(0, 12), done: false }));
    const listen = checks.listenCheck(checks.extractFinalScript(text), listenOpts(fresh));
    fresh.onepass = { ...(fresh.onepass || {}), stage: 'done', final: { at: now(), hash: hash(text), verdict: String(out.verdict || ''), summary: String(out.summary || ''), basis, loops,
      picked: arr(out.picked).map(x => ({ id: String(x.id || ''), done: x.done !== false, note: String(x.note || '') })), hard, notes: arr(out.notes).map(String).slice(0, 5), listen: listen ? arr(listen.issues) : [] } };
    if (run.attempts) fresh.attempts = an().mergeAttempts(fresh.attempts, run.attempts);
    store.saveRun(fresh);
    return fresh.onepass.final;
  });
}
function startFinalCheck(runId) {
  const run = store.getRun(runId);
  if (!run || !isOn(run)) throw Object.assign(new Error('这篇不是新流程'), { status: 400 });
  if (busy.has(runId)) throw Object.assign(new Error('「' + busy.get(runId) + '」正在跑'), { status: 409 });
  finalCheck(runId).catch(e => save(runId, { stage: 'failed', failed_at: 'final_check', error: '终检没跑完:' + e.message }));
  return { ok: true };
}

// ---------- ⑤ 硬伤只修这一句 ----------
// 终检给了改好的句子:直接替换,不调 AI;新数字没有改法:让 AI 只改这一句(只回一句),再替换
function replaceOnce(text, quote, fix) {
  const p = rv().locate(text, quote);
  if (!p) return null;
  return text.slice(0, p.start) + fix + text.slice(p.end);
}
async function fixOne(runId, body = {}) {
  return withBusy(runId, '只修这一句', async () => {
    const R = rv();
    const run = store.getRun(runId);
    const op = run.onepass || {};
    const id = String(body.id || '');
    const fin = op.final || {};
    let item = arr(fin.hard).find(x => x.id === id);
    const nItem = !item ? arr(op.new_numbers).find(x => x.id === id) : null;
    if (!item && !nItem) throw Object.assign(new Error('找不到这一条'), { status: 400 });
    const text = cur(run);
    const quote = (item || nItem).quote;
    if (!quote || !R.locate(text, quote)) throw Object.assign(new Error('稿子里找不到这句原话(可能已经改过),在「逐段对照」里手动改'), { status: 400 });
    let fix = String(body.text || (item && item.fix) || '').trim();
    if (!fix) {
      const cfg = pl().loadConfig();
      const prompt = '下面这句是' + lang(run) + '口播稿里的一句,里面的数字「' + nItem.num + '」在能用的事实里找不到出处。只改这一句:把这个数换成能用的事实里有的数,或者改成不带这个数的说法;别的词尽量不动,语体不变。只输出改好的这一句,不要引号和解释。\n\n这句:' + quote + '\n\n能用的事实:\n' + factsText(run).slice(0, 4000);
      const r = await R.viaStep('ai_fix', cfg, (c, sfx) => R.rawCall(run, c, prompt, '只修这一句' + sfx));
      fix = String(r.content || '').trim().split('\n').filter(l => l.trim())[0] || '';
      fix = fix.replace(/^["“「]|["”」]$/g, '').trim();
      if (!fix) throw new Error('AI 没给出改好的句子,可以自己填一句再点');
    }
    const next = replaceOnce(text, quote, fix);
    if (!next) throw Object.assign(new Error('稿子里找不到这句原话'), { status: 400 });
    const fresh = store.getRun(runId) || run;
    if (cur(fresh) !== text) throw new Error('修改期间稿子被改过,请重试');
    R.writeScript(fresh, next);
    const o = fresh.onepass;
    if (item) o.final.hard = o.final.hard.map(x => (x.id === id ? { ...x, done: true, fixed_to: fix } : x));
    else o.new_numbers = o.new_numbers.map(x => (x.id === id ? { ...x, ok: true, fixed_to: fix } : x));
    o.fixes = arr(o.fixes).concat([{ id, at: now(), from: quote, to: fix }]);
    const vv = arr(fresh.review.versions).find(x => x.key === 'op');
    if (vv) vv.text = cur(fresh);
    if (run.attempts) fresh.attempts = an().mergeAttempts(fresh.attempts, run.attempts);
    store.saveRun(fresh);
    return { ok: true, to: fix };
  });
}
// 新数字人看过没问题 / 硬伤人判断不用改:标成已处理
function markOk(runId, body = {}) {
  const run = store.getRun(runId);
  if (!run || !run.onepass) throw Object.assign(new Error('任务不存在'), { status: 404 });
  const id = String(body.id || '');
  const o = run.onepass;
  o.new_numbers = arr(o.new_numbers).map(x => (x.id === id ? { ...x, ok: true, accepted: true } : x));
  if (o.final) o.final.hard = arr(o.final.hard).map(x => (x.id === id ? { ...x, done: true, accepted: true } : x));
  if (o.final) o.final.basis = arr(o.final.basis).map(x => (x.id === id ? { ...x, done: true, accepted: true } : x));
  if (o.final && o.final.loops) o.final.loops = arr(o.final.loops).map(x => (x.id === id || id === 'LOOPS' ? { ...x, done: true, accepted: true } : x));
  store.saveRun(run);
  return { ok: true };
}
// 口径问题人选了另一种口径:几句话要一起改,不能一句句修,整篇按这个口径再重写一次(同一份勾选,加一句交代)
function basisRewrite(runId, body = {}) {
  const run = store.getRun(runId);
  const op = (run || {}).onepass || {};
  const b = arr((op.final || {}).basis).find(x => x.id === String(body.id || ''));
  if (!b) throw Object.assign(new Error('找不到这一条'), { status: 400 });
  const opt = b.options[Number(body.option)];
  if (!opt) throw Object.assign(new Error('选项不对'), { status: 400 });
  const note = '全片口径统一改成:' + opt + '(要定的是:' + b.topic + ')。所有用到这个基准的数、由它算出来的数都按这个口径一起改,全片只用这一套。' + (op.note ? '\n' + op.note : '');
  return decide(runId, { ids: op.picked_ids, opening: op.rewrite && op.rewrite.opening_used != null ? op.rewrite.opening_used : op.opening_choice, note, again: true });
}
// 终检查出还在绕圈 / 重讲:把这些当成要改的问题,整篇再重写一次(不一句句删,删了前后接不上)
function loopRewrite(runId) {
  const run = store.getRun(runId);
  const op = (run || {}).onepass || {};
  const loops = arr((op.final || {}).loops);
  if (!loops.length) throw Object.assign(new Error('终检没查出绕圈的地方'), { status: 400 });
  const note = '上一次从初稿重写出来,下面这些地方还在绕圈、重讲(原句是上一版的,意思对得上就行)。这次从初稿重新写时,这些意思全片只说一次:\n' + loops.map(x => '- [' + x.chapter + '][' + x.type + '] 「' + x.quote + '」 ' + x.problem + (x.fix ? ' → ' + x.fix : '')).join('\n');
  return decide(runId, { ids: op.picked_ids, opening: op.rewrite && op.rewrite.opening_used != null ? op.rewrite.opening_used : op.opening_choice, note: note.slice(0, 1800), again: true });
}
// ---------- v1.134 终检后:勾选 → 一起改一次 → 复查就停(用户 2026-11-25) ----------
// 终检结果是一张勾选单(绕圈、口径、必须改、可改可不改、新数字)。人勾完点一次「按勾的一起改」:
// 终检给了改好句子的硬伤程序直接换;要动几句的(绕圈、没改法的数字)把所在的几章一次交给 AI,别的章程序原样拼回(一字不动)。
// 口径选了另一种:影响整篇,只能从初稿整篇重写。改完自动复查:勾的每条解决没有 + 这次改动有没有带出新问题(程序比数字、提醒句;AI 只看改了的章)。
// 复查完就停:没有第二次「一起改」,只能接受、撤回、或从初稿整篇重写。
function finalItems(op) {
  const fin = op.final || {};
  return [
    ...arr(fin.loops).map(x => ({ ...x, kind: 'loop', label: x.type || '重讲' })),
    ...arr(fin.hard).map(x => ({ ...x, kind: 'hard', label: x.kind || '硬伤' })),
    ...arr(op.new_numbers).map(x => ({ ...x, kind: 'num', label: '新数字', problem: '「' + x.num + '」在初稿、事实表、账本里都没有,可能是 AI 编的', done: x.ok }))
  ];
}
// 每一章在全片里的任务(蓝图):推进哪一步、接住上一章什么、留给下一章什么钩子、留存目标、埋点 / 回收;
// 配上稿子里实际的上一章最后一句、本章第一句 / 最后一句、下一章第一句。改的时候要保住这些功能,复查也按这个查
function chapterRoles(run, text, ids) {
  const R = rv();
  let bp = [];
  try { bp = pl().bpChaptersOf((run.outputs || {}).step1) || []; } catch (e) { bp = []; }
  const a = run.analysis || {};
  const pp = a.planted_payoff || {}, hp = a.hook_plan || {};
  const chs = R.scriptChapters(text);
  const sents = t => String(t || '').split(/(?<=[.?!。？！])\s+/).map(x => x.trim()).filter(Boolean);
  const segHit = (b, seg) => !!seg && arr(b.source_segments).some(s => String(seg).includes(String(s)));
  return ids.map(id => {
    const i = chs.findIndex(c => c.id === id);
    if (i < 0) return '';
    const c = chs[i], b = bp.find(x => String(x.id).toUpperCase() === id) || {};
    const ss = sents(c.text);
    const L = ['=== ' + id + ' 在全片里的任务 ==='];
    if (b.claim) L.push('这一章往前推的一步:' + b.claim);
    if (b.retention_goal) L.push('留存目标:' + b.retention_goal);
    L.push('开头接上一章:' + (b.answers_prev ? b.answers_prev + ';' : '') + (i > 0 ? '上一章最后一句「' + (sents(chs[i - 1].text).pop() || '') + '」' : '(这是第一章)') + ';本章第一句「' + (ss[0] || '') + '」');
    L.push('结尾留给下一章的钩子:' + (b.leaves_question ? b.leaves_question + ';' : '') + '本章最后一句「' + (ss[ss.length - 1] || '') + '」' + (i + 1 < chs.length ? ';下一章第一句「' + (sents(chs[i + 1].text)[0] || '') + '」' : '(这是最后一章)'));
    if (b.open_loop && (b.open_loop.open || b.open_loop.close)) L.push('悬念:' + (b.open_loop.open ? '这里埋「' + b.open_loop.open + '」' : '') + (b.open_loop.close ? ' 这里回收「' + b.open_loop.close + '」' : ''));
    if (pp.what && (segHit(b, pp.plant_at) || segHit(b, pp.payoff_at))) L.push('埋点 / 回收:这一章' + (segHit(b, pp.plant_at) ? '埋下' : '回收') + '「' + pp.what + '」,改的时候这一处不能删');
    ['background', 'midpoint', 'final15'].forEach(k => { const h = hp[k]; if (h && segHit(b, h.segment)) L.push('留存钩子(' + (h.hook_type || k) + '):' + (h.how || '')); });
    const nb = [...new Set(R.factNumbers(c.text))];
    if (nb.length) L.push('本章的数(算账链,前后要接得上):' + nb.join('、'));
    return L.join('\n');
  }).filter(Boolean).join('\n\n');
}
// 一条问题牵扯到的别的章(问题描述里点名的):哪里第一次讲透(不改,只对照)
function relatedOf(run, x, ch) {
  let bp = [];
  try { bp = pl().bpChaptersOf((run.outputs || {}).step1) || []; } catch (e) { bp = []; }
  const refs = [...new Set((String(x.problem || '') + ' ' + String(x.fix || '') + ' ' + String(x.chapter || '')).match(/CH\d+/gi) || [])].map(s => s.toUpperCase()).filter(id => id !== ch);
  if (!refs.length) return '';
  return '\n  牵扯的章(不改,只拿来对照):' + refs.map(id => { const b = bp.find(y => String(y.id).toUpperCase() === id) || {}; const ideas = arr(b.ideas_new).slice(0, 3).join('、'); return id + (ideas ? '(这一章讲透了:' + ideas + ')' : ''); }).join(';');
}
// 原句前后各一句:让 AI 知道删 / 改完以后要和谁接上
function ctxOf(text, quote) {
  const p = quote ? rv().locate(text, quote) : null;
  if (!p) return '';
  const sents = t => t.split(/(?<=[.?!。？！])\s+/).map(x => x.trim()).filter(Boolean);
  const before = sents(text.slice(Math.max(0, p.start - 400), p.start).replace(/^\[CH[^\]]*\]\s*/m, '')).pop() || '';
  const after = sents(text.slice(p.end, p.end + 400).split(/\n\s*\[CH/)[0])[0] || '';
  return (before ? '\n  前一句:「' + before + '」' : '') + (after ? '\n  后一句:「' + after + '」' : '');
}
// 这几章里没被勾到的数:一个都不许动(列给 AI,复查时程序也按这个比)
function keepNumbers(text, chapters, items) {
  const R = rv();
  const touched = new Set(R.factNumbers(items.map(x => [x.quote, x.fix].join(' ')).join(' ')));
  const chs = R.scriptChapters(text).filter(c => chapters.includes(c.id));
  const lines = chs.map(c => { const ns = [...new Set(R.factNumbers(c.text))].filter(n => !touched.has(n)); return ns.length ? c.id + ':' + ns.join('、') : ''; }).filter(Boolean);
  return lines.length ? lines.join('\n') : '(无)';
}
function chapterOfItem(text, chs, x) {
  const p = x.quote ? rv().locate(text, x.quote) : null;
  const byQuote = p ? chs.find(c => p.start >= c.bodyStart && p.start < c.bodyEnd) : null;
  if (byQuote) return byQuote.id;
  const id = (String(x.chapter || '').match(/CH\d+/gi) || []).map(s => s.toUpperCase()).pop() || '';
  return chs.some(c => c.id === id) ? id : '';
}
async function finalFix(runId, body = {}) {
  return withBusy(runId, '按勾的一起改', async () => {
    const R = rv();
    const cfg = pl().loadConfig();
    const run = store.getRun(runId);
    const op = run.onepass || {};
    if (!op.final) throw Object.assign(new Error('还没有终检结果'), { status: 400 });
    if (op.finalfix && !op.finalfix.undone_at) throw Object.assign(new Error('这一版已经一起改过一次了:只能接受、撤回,或从初稿整篇重写'), { status: 400 });
    const ids = new Set(arr(body.ids).map(String));
    const all = finalItems(op).filter(x => !x.done);
    const picked = all.filter(x => ids.has(x.id));
    const text = cur(run);
    const chs = R.scriptChapters(text);
    let next = text;
    const replaced = [], aiItems = [], lost = [];
    // 先做程序能直接换的(终检给了改好的句子),再看剩下的;原句已经被前面换掉的,算一起解决了
    const rest = [];
    picked.forEach(x => {
      if (x.kind === 'hard' && x.fix && x.quote && R.locate(next, x.quote)) { const n2 = replaceOnce(next, x.quote, x.fix); if (n2) { next = n2; replaced.push({ id: x.id, from: x.quote, to: x.fix }); return; } }
      rest.push(x);
    });
    rest.forEach(x => {
      if (x.quote && R.locate(text, x.quote) && !R.locate(next, x.quote)) { replaced.push({ id: x.id, from: x.quote, to: '(和别的问题同一句,已一起换掉)' }); return; }
      const ch = chapterOfItem(text, chs, x);
      if (ch) aiItems.push({ ...x, ch }); else lost.push(x.id);
    });
    const chapters = chs.map(c => c.id).filter(id => aiItems.some(x => x.ch === id));
    const t0 = Date.now();
    if (chapters.length) {
      save(runId, { finalfix_stage: '一起改 ' + chapters.join('、') });
      const locked = op.rewrite && op.rewrite.opening_used >= 0;
      const prompt = an().fillVars(readPrompt('onepass_finalfix.md'), {
        target_language: lang(run), chapters: chapters.join('、'),
        opening_rule: locked ? 'CH01 的开头是人选定的:CH01 里只改勾到的那一句,别的句子一字不动。' : '改 CH01 时保住开头 30 秒的钩子(兑现标题、留问题、第一个数),只改勾到的句子。',
        issues: aiItems.map(x => '- [' + x.id + '][' + x.ch + '][' + x.label + '] ' + (x.problem || '') + (x.quote ? '\n  原句:「' + x.quote + '」' : '') + ctxOf(next, x.quote) + relatedOf(run, x, x.ch) + (x.fix ? '\n  改法:' + x.fix : '')).join('\n'),
        keep_numbers: keepNumbers(next, chapters, aiItems), roles: chapterRoles(run, next, chapters) || '(蓝图里没有这几章的任务说明,按稿子本身的上下文保住衔接和钩子)',
        note: body.note ? '\n人另外交代的:' + String(body.note).slice(0, 1000) : '',
        facts: factsText(run).slice(0, 12000), script: checks.extractFinalScript(next) || next
      });
      const r = await pl().inRun(runId, () => R.callLong(run, cfg, prompt, '一遍重写·终检后一起改'));
      let out = require('./textnorm').normalizeChapterTags(String(r.content || '').replace(/^```[a-z]*\s*$/gim, ''));
      out = (await R.purifyText(run, cfg, out, '一遍重写·终检后一起改')).text;
      const got = R.scriptChapters(out);
      for (const id of chapters) {
        const g = got.find(c => c.id === id);
        if (!g || !g.text.trim()) throw new Error('AI 没把 ' + id + ' 写回来,稿子没动。可以再点一次');
        next = R.replaceChapter(next, id, g.text.trim());
      }
    }
    const fresh = store.getRun(runId) || run;
    if (cur(fresh) !== text) throw new Error('改的期间稿子被改过,请重试');
    const o = fresh.onepass;
    const finalBefore = JSON.parse(JSON.stringify(o.final));
    const numsBefore = JSON.parse(JSON.stringify(arr(o.new_numbers)));
    if (next !== text) R.writeScript(fresh, next, op.rewrite && op.rewrite.opening_used >= 0 ? '' : '一遍重写');
    // 没勾的:人看过,不改;勾了的:先标「改过」,解决没有看复查
    const mark = x => (ids.has(x.id) ? { ...x, done: true, fixed: true } : x.done ? x : { ...x, done: true, accepted: true });
    o.final.loops = arr(o.final.loops).map(mark);
    o.final.hard = arr(o.final.hard).map(mark);
    o.final.basis = arr(o.final.basis).map(x => (x.done ? x : { ...x, done: true, accepted: true }));
    o.new_numbers = arr(o.new_numbers).map(x => (ids.has(x.id) ? { ...x, ok: true, fixed: true } : x.ok ? x : { ...x, ok: true, accepted: true }));
    const after = cur(fresh);
    const changed = R.scriptChapters(after).filter(c => { const b = R.scriptChapters(text).find(y => y.id === c.id); return !b || b.text !== c.text; }).map(c => c.id);
    o.finalfix = { at: now(), secs: Math.round((Date.now() - t0) / 100) / 10, ids: [...ids].filter(id => picked.some(x => x.id === id)), picked: picked.map(x => ({ id: x.id, kind: x.kind, label: x.label, chapter: x.chapter || '', problem: x.problem || '', quote: x.quote || '', fix: x.fix || '' })),
      chapters: changed, replaced, lost, note: String(body.note || '').slice(0, 1000), before: text, after, final_before: finalBefore, numbers_before: numsBefore, words_before: R.scriptWords(text), words_after: R.scriptWords(after) };
    delete o.finalfix_stage;
    delete o.verify;
    const vv = arr((fresh.review || {}).versions).find(x => x.key === 'op');
    if (vv) vv.text = after;
    if (run.attempts) fresh.attempts = an().mergeAttempts(fresh.attempts, run.attempts);
    store.saveRun(fresh);
    return o.finalfix;
  });
}
// 复查:程序比改动前后(数字、提醒句),AI 只看改了的章:勾的解决没有、有没有改出新问题
function verifyProgram(run, ff) {
  const R = rv();
  const out = [];
  const before = R.scriptChapters(ff.before), after = R.scriptChapters(ff.after);
  if (before.length !== after.length) out.push({ chapter: '全篇', problem: '章数变了(' + before.length + ' → ' + after.length + ')', plain: '章节对不上,后面配音、剪辑会乱' });
  const a = run.analysis || {};
  const allowed = new Set([ff.before, JSON.stringify(a.facts || []), JSON.stringify(a.ledger || []), factsText(run)].flatMap(t => R.factNumbers(t)));
  const touched = arr(ff.picked).map(x => [x.quote, x.fix].join(' ')).join(' ');
  const expect = new Set(R.factNumbers(touched));
  arr(ff.chapters).forEach(id => {
    const b = before.find(c => c.id === id), n = after.find(c => c.id === id);
    if (!b || !n) return;
    const nb = new Set(R.factNumbers(b.text)), na = new Set(R.factNumbers(n.text));
    const gone = [...nb].filter(x => !na.has(x) && !expect.has(x) && !R.factNumbers(ff.after).includes(x));
    const added = [...na].filter(x => !nb.has(x) && !allowed.has(x) && !expect.has(x));
    if (gone.length) out.push({ chapter: id, problem: '这次改动把这些数删没了(没勾到它们):' + gone.join('、'), plain: '算账少了一步,观众可能对不上前后的数' });
    if (added.length) out.push({ chapter: id, problem: '这次改动冒出了新数字(哪里都没有出处):' + added.join('、'), plain: '可能是 AI 编的数' });
  });
  const lw = lengthWindow(run, ff.before);
  const wb = R.scriptWords(ff.before), wa = R.scriptWords(ff.after);
  if (lw && wa < wb && wa < lw.min * 0.92) out.push({ chapter: '全篇', problem: '这次改动删到 ' + wa + ' 词,按配音速度约 ' + (Math.round(wa / lw.wpm * 10) / 10) + ' 分钟,比目标 ' + lw.goal_min + ' 分钟短太多', plain: '成片时长不够' });
  const hb = hedgeScan(ff.before, lang(run)).length, ha = hedgeScan(ff.after, lang(run)).length;
  if (ha > hb) out.push({ chapter: '全篇', problem: '这次改动多了 ' + (ha - hb) + ' 句「这是假设 / 不是这家店的数」这类提醒', plain: '观众又要多听提醒' });
  return out;
}
async function verifyFix(runId) {
  return withBusy(runId, '复查', async () => {
    const R = rv();
    const cfg = pl().loadConfig();
    const run = store.getRun(runId);
    const op = run.onepass || {};
    const ff = op.finalfix;
    if (!ff || ff.undone_at) throw Object.assign(new Error('没有要复查的改动'), { status: 400 });
    save(runId, { finalfix_stage: '复查' });
    const prog = verifyProgram(run, ff).map(x => ({ ...x, by: '程序' }));
    let resolved = [], fresh = [];
    const before = R.scriptChapters(ff.before), after = R.scriptChapters(ff.after);
    const changes = arr(ff.chapters).map(id => {
      const i = after.findIndex(c => c.id === id);
      const b = before.find(c => c.id === id) || {}, n = after[i] || {};
      const sents = t => String(t || '').split(/(?<=[.?!。？！])\s+/).filter(Boolean);
      const prevLast = i > 0 ? sents(after[i - 1].text).pop() || '' : '';
      const nextFirst = i >= 0 && i + 1 < after.length ? sents(after[i + 1].text)[0] || '' : '';
      return '=== ' + id + ' ===\n(上一章最后一句)' + prevLast + '\n【改前】\n' + (b.text || '') + '\n【改后】\n' + (n.text || '') + '\n(下一章第一句)' + nextFirst;
    }).join('\n\n');
    if (arr(ff.picked).length && changes) {
      const prompt = an().fillVars(readPrompt('onepass_verify.md'), {
        target_language: lang(run),
        issues: arr(ff.picked).map(x => '- [' + x.id + '][' + x.label + '] ' + x.problem + (x.quote ? '\n  原句:「' + x.quote + '」' : '') + (x.fix ? '\n  改法:' + x.fix : '')).join('\n'),
        changes, facts: factsText(run).slice(0, 8000), roles: chapterRoles(run, ff.before, arr(ff.chapters)) || '(无)'
      });
      const out = await R.viaStep('final_audit', cfg, (c, sfx) => an().callJson(run, c, prompt, '一遍终检·复查' + sfx, o => !!o && typeof o === 'object' && (Array.isArray(o.resolved) || Array.isArray(o.new_issues))));
      resolved = arr(out.resolved).map(x => ({ id: String(x.id || ''), ok: x.ok !== false, note: String(x.note || '') }));
      fresh = arr(out.new_issues).filter(x => x && x.problem).slice(0, 8).map(x => ({ chapter: (String(x.chapter || '').match(/CH\d+/i) || [''])[0].toUpperCase(), quote: String(x.quote || ''), problem: String(x.problem), plain: String(x.plain || ''), by: 'AI' }));
    }
    // 程序直接换的句子:换上了就算解决;找不到位置的:没解决
    arr(ff.replaced).forEach(x => { if (!resolved.some(y => y.id === x.id)) resolved.push({ id: x.id, ok: true, note: '程序按终检给的改法换好了' }); });
    arr(ff.lost).forEach(id => resolved.push({ id, ok: false, note: '稿子里找不到这句原话,没改' }));
    arr(ff.picked).forEach(x => { if (!resolved.some(y => y.id === x.id)) resolved.push({ id: x.id, ok: true, note: '' }); });
    const r2 = store.getRun(runId) || run;
    const o = r2.onepass;
    if (!o.finalfix || o.finalfix.at !== ff.at) throw new Error('复查期间改动被撤回了');
    const newIssues = [...prog, ...fresh];
    o.verify = { at: now(), resolved, new_issues: newIssues, ok: resolved.every(x => x.ok) && !newIssues.length, accepted: false };
    delete o.finalfix_stage;
    if (run.attempts) r2.attempts = an().mergeAttempts(r2.attempts, run.attempts);
    store.saveRun(r2);
    return o.verify;
  });
}
function startFinalFix(runId, body = {}) {
  const run = store.getRun(runId);
  if (!run || !isOn(run)) throw Object.assign(new Error('这篇不是新流程'), { status: 400 });
  if (busy.has(runId)) throw Object.assign(new Error('「' + busy.get(runId) + '」正在跑'), { status: 409 });
  const op = run.onepass || {};
  if (op.finalfix && !op.finalfix.undone_at) throw Object.assign(new Error('这一版已经一起改过一次了:只能接受、撤回,或从初稿整篇重写'), { status: 400 });
  // 口径选了另一种:影响整篇,从初稿整篇重写(勾的其他问题一起带上)
  const bsel = Object.entries(body.basis || {}).map(([id, i]) => ({ b: arr((op.final || {}).basis).find(x => x.id === id), i: Number(i) })).find(x => x.b && x.i > 0 && x.b.options[x.i]);
  if (bsel) {
    const ids = new Set(arr(body.ids).map(String));
    const extra = finalItems(op).filter(x => ids.has(x.id));
    const note = '全片口径统一改成:' + bsel.b.options[bsel.i] + '(要定的是:' + bsel.b.topic + ')。所有用到这个基准的数、由它算出来的数都按这个口径一起改,全片只用这一套。' +
      (extra.length ? '\n上一版终检还查出这些,这次从初稿写时一起避开:\n' + extra.map(x => '- [' + (x.chapter || '') + '][' + x.label + '] ' + (x.problem || '') + (x.quote ? ' 「' + x.quote + '」' : '')).join('\n') : '') + (body.note ? '\n' + body.note : '') + (op.note ? '\n' + op.note : '');
    decide(runId, { ids: op.picked_ids, opening: op.rewrite && op.rewrite.opening_used != null ? op.rewrite.opening_used : op.opening_choice, note: note.slice(0, 2000), again: true });
    return { ok: true, mode: 'rewrite' };
  }
  if (!arr(body.ids).length) throw Object.assign(new Error('一条都没勾。都不用改的话点「都不改,直接能发布」'), { status: 400 });
  (async () => {
    try { await finalFix(runId, body); } catch (e) { save(runId, { finalfix_stage: null, finalfix_error: '一起改没成功:' + e.message }); return; }
    save(runId, { finalfix_error: '' });
    try { await verifyFix(runId); } catch (e) { save(runId, { finalfix_stage: null, finalfix_error: '复查没跑完:' + e.message + '(点「重新复查」)' }); }
  })();
  return { ok: true, mode: 'fix' };
}
function startVerify(runId) {
  if (busy.has(runId)) throw Object.assign(new Error('「' + busy.get(runId) + '」正在跑'), { status: 409 });
  verifyFix(runId).then(() => save(runId, { finalfix_error: '' })).catch(e => save(runId, { finalfix_stage: null, finalfix_error: '复查没跑完:' + e.message }));
  return { ok: true };
}
// 都不改:终检剩下的全部标成人看过、能接受
function acceptAll(runId) {
  const run = store.getRun(runId);
  const o = (run || {}).onepass;
  if (!o || !o.final) throw Object.assign(new Error('还没有终检结果'), { status: 400 });
  const acc = x => (x.done ? x : { ...x, done: true, accepted: true });
  o.final.loops = arr(o.final.loops).map(acc); o.final.hard = arr(o.final.hard).map(acc); o.final.basis = arr(o.final.basis).map(acc);
  o.new_numbers = arr(o.new_numbers).map(x => (x.ok ? x : { ...x, ok: true, accepted: true }));
  if (o.verify) o.verify.accepted = true;
  store.saveRun(run);
  return { ok: true };
}
// 撤回「一起改」:稿子还是改完那一版时,整篇换回改之前的,终检结果也换回改之前的(不重跑)
function finalFixUndo(runId) {
  const run = store.getRun(runId);
  const o = (run || {}).onepass || {};
  const ff = o.finalfix;
  if (!ff || ff.undone_at) throw Object.assign(new Error('没有可以撤回的'), { status: 400 });
  if (busy.has(runId)) throw Object.assign(new Error('「' + busy.get(runId) + '」正在跑'), { status: 409 });
  if (cur(run) !== ff.after) throw Object.assign(new Error('改完以后稿子又动过,不能整篇撤回'), { status: 400 });
  rv().writeScript(run, ff.before);
  const vv = arr((run.review || {}).versions).find(x => x.key === 'op');
  if (vv) vv.text = cur(run);
  o.final = ff.final_before; o.new_numbers = ff.numbers_before;
  o.finalfix = { ...ff, undone_at: now(), before: undefined, after: undefined, final_before: undefined, numbers_before: undefined };
  delete o.verify;
  store.saveRun(run);
  return { ok: true };
}
// 从初稿整篇重写一次(终检后不满意时的最后一条路):把终检查出的、复查没解决的、改出来的新问题当成要避开的
function redoFromDraft(runId) {
  const run = store.getRun(runId);
  const op = (run || {}).onepass || {};
  if (!op.final) throw Object.assign(new Error('还没有终检结果'), { status: 400 });
  const ff = op.finalfix && !op.finalfix.undone_at ? op.finalfix : null;
  const items = ff ? arr(ff.picked) : finalItems(op).filter(x => !x.done);
  const fresh = op.verify ? arr(op.verify.new_issues) : [];
  const note = '上一次从初稿重写出来,终检还查出下面这些(原句是上一版的,意思对得上就行)。这次从初稿重新写时一起避开,这些意思全片只说一次:\n' +
    items.map(x => '- [' + (x.chapter || '') + '][' + (x.label || x.type || x.kind || '') + '] ' + (x.quote ? '「' + x.quote + '」 ' : '') + (x.problem || '') + (x.fix ? ' → ' + x.fix : '')).join('\n') +
    (fresh.length ? '\n另外要注意:' + fresh.map(x => x.problem).join(';') : '');
  return decide(runId, { ids: op.picked_ids, opening: op.rewrite && op.rewrite.opening_used != null ? op.rewrite.opening_used : op.opening_choice, note: note.slice(0, 1900), again: true });
}
// 失败后重试:从断掉的那一步接着跑
function retry(runId) {
  const run = store.getRun(runId);
  if (!run || !isOn(run)) throw Object.assign(new Error('这篇不是新流程'), { status: 400 });
  const op = run.onepass || {};
  const at = op.failed_at || (op.stage === 'checking' ? 'checking' : op.stage === 'rewriting' ? 'rewriting' : op.stage === 'final_check' ? 'final_check' : '');
  if (at === 'checking' || !op.items) return startCheckup(runId);
  if (at === 'rewriting') return decide(runId, { ids: op.picked_ids, opening: op.opening_choice, note: op.note, again: true });
  return startFinalCheck(runId);
}

// ---------- 老流程已经跑完的任务:回到初稿改走新流程(不重做写前分析、蓝图、写稿) ----------
// 老终稿、老审稿记录整份备份在 run.classic_backup,随时可以切回去
const SWITCH_KEYS = ['final_script', 'script_v1', 'review', 'onepass'];
function canSwitch(run) {
  return !!run && !isOn(run) && run.draft_first && run.status === 'done' && !!((run.outputs || {}).step2 || cur(run));
}
function draftOf(run) {
  const s2 = (run.outputs || {}).step2;
  if (s2) {
    const meta = checks.stripMetaNotes(checks.extractFinalScript(s2), lang(run));
    return checks.cleanForeignScript(checks.speechTidy(meta.text), lang(run)).text;
  }
  const d1 = arr((run.review || {}).versions).find(v => v.key === 'd1');
  return (d1 && d1.text) || '';
}
function switchToOnePass(runId) {
  const run = store.getRun(runId);
  if (!run) throw Object.assign(new Error('任务不存在'), { status: 404 });
  if (!canSwitch(run)) throw Object.assign(new Error('只有「先写后改」、已经完成、还在老流程的任务能切'), { status: 400 });
  if (rv().passBusy(runId)) throw Object.assign(new Error('「' + rv().passLabel(runId) + '」正在跑,等它跑完再切'), { status: 409 });
  const keep = { at: now(), ...Object.fromEntries(SWITCH_KEYS.map(k => [k, run[k] === undefined ? null : run[k]])) };
  // 之前切过新流程又切回来的:新流程那份(体检、重写稿、终检)原样放回,不再花钱重跑
  if (run.onepass_backup) {
    const nb = run.onepass_backup;
    SWITCH_KEYS.forEach(k => { if (nb[k] == null) delete run[k]; else run[k] = nb[k]; });
    run.classic_backup = keep;
    run.flow = FLOW;
    delete run.onepass_backup;
    store.saveRun(run);
    return { ok: true, restored: true };
  }
  const draft = draftOf(run);
  if (!draft) throw Object.assign(new Error('找不到初稿'), { status: 400 });
  run.classic_backup = keep;
  run.flow = FLOW;
  run.final_script = draft;
  if (run.script_v1) run.script_v1 = draft;
  run.review = { versions: [{ key: 'd1', label: '初稿', at: now(), text: draft, issues: [] }] };
  delete run.onepass;
  ['reverse_audit', 'opening_card', 'opening_variants', 'claim_check', 'info_check'].forEach(k => { if (run.steps && run.steps[k]) delete run.steps[k]; });
  store.saveRun(run);
  try { require('./manual').reopenAuto(runId); } catch (e) {}
  startCheckup(runId);
  return { ok: true };
}
// 切回老流程:老终稿和老审稿记录原样放回去;新流程这份也备份着(onepass_backup),再点「改用新流程」直接切回来,两份文案都留着
function switchBack(runId) {
  const run = store.getRun(runId);
  if (!run || !run.classic_backup) throw Object.assign(new Error('没有老流程的备份'), { status: 400 });
  if (busy.has(runId)) throw Object.assign(new Error('「' + busy.get(runId) + '」正在跑,等它跑完再切'), { status: 409 });
  const b = run.classic_backup;
  run.onepass_backup = { at: now(), ...Object.fromEntries(SWITCH_KEYS.map(k => [k, run[k] === undefined ? null : run[k]])) };
  SWITCH_KEYS.forEach(k => { if (b[k] == null) delete run[k]; else run[k] = b[k]; });
  run.flow = 'classic';
  delete run.classic_backup;
  store.saveRun(run);
  return { ok: true };
}

// ---------- 给页面 ----------
const STAGE_ZH = { checking: '① 一次体检中', decide: '② 等你拍板', rewriting: '③ 整篇重写中', final_check: '④ 终检中', done: '⑤ 终检完成', failed: '出错了' };
function view(run) {
  if (!isOn(run)) return null;
  const op = run.onepass || {};
  const running = busyOf(run.id);
  let stage = op.stage || (run.status === 'done' ? 'pending' : 'writing');
  // 进程重启过:写着「跑着」但其实没在跑
  const stalled = ['checking', 'rewriting', 'final_check'].includes(stage) && !running && !(stage === 'checking' && (run.steps || {}).reverse_audit && run.steps.reverse_audit.status === 'running');
  const ov = (run.review || {}).opening_variants;
  const fin = op.final || null;
  const ffOn = op.finalfix && !op.finalfix.undone_at;
  const hardLeft = fin ? arr(fin.hard).filter(x => !x.done && x.level !== '可改可不改').length + arr(fin.basis).filter(x => !x.done).length + arr(fin.loops).filter(x => !x.done).length : 0;
  const numLeft = arr(op.new_numbers).filter(x => !x.ok).length;
  return {
    failed_at: op.failed_at || '', stage, stage_zh: STAGE_ZH[stage] || (stage === 'writing' ? '写初稿中' : '等体检'), running, stalled,
    error: op.error || '', errors: op.errors || {},
    items: arr(op.items), picked_ids: op.picked_ids || null, note: op.note || '', claim: op.claim || null,
    opening: ov ? { pick: ov.pick, pick_why: ov.pick_why || '', pick_note: ov.pick_note || '', now: arr(ov.now), title_kind: ov.title_kind || '',
      variants: arr(ov.variants).map(v => ({ i: v.i, name: v.name, text: v.text, zh: v.zh, why: v.why, steps: v.steps || {}, issues: arr(v.issues), words: v.words })) } : null,
    opening_choice: op.opening_choice != null ? op.opening_choice : (ov && ov.pick != null ? ov.pick : -1),
    rewrite: op.rewrite ? { at: op.rewrite.at, retried_short: op.rewrite.retried_short || 0, outline: op.rewrite.outline, words: op.rewrite.words, base_words: op.rewrite.base_words, opening_used: op.rewrite.opening_used, new_numbers_note: op.rewrite.new_numbers_note } : null,
    new_numbers: arr(op.new_numbers), final: fin, fixes: arr(op.fixes),
    has_backup: !!run.classic_backup,
    length: (() => { try { const ln = rv().lengthNeed(run, cur(run)); return ln ? { words: ln.words, minutes: ln.minutes, goal_min: ln.goal_min, target: ln.target, wpm: ln.wpm, mode: ln.mode } : null; } catch (e) { return null; } })(),
    finalfix: op.finalfix ? { at: op.finalfix.at, picked: arr(op.finalfix.picked), chapters: arr(op.finalfix.chapters), replaced: arr(op.finalfix.replaced).length, lost: arr(op.finalfix.lost), words_before: op.finalfix.words_before, words_after: op.finalfix.words_after, undone_at: op.finalfix.undone_at || '', can_undo: !op.finalfix.undone_at && cur(run) === op.finalfix.after } : null,
    verify: op.verify || null, finalfix_stage: op.finalfix_stage || '', finalfix_error: op.finalfix_error || '',
    draft: (() => { // v1.134 初稿原样(写稿那一步出来的,重写都从它开始),页面上能展开看、能复制
      const t = (arr((run.review || {}).versions).find(x => x.key === 'd1') || {}).text || (run.status === 'done' ? draftOf(run) : '');
      return t ? { text: t, words: String(t).replace(/\[CH\d+[^\]]*\]/g, ' ').split(/\s+/).filter(Boolean).length } : null;
    })(),
    publish: fin ? { ok: ffOn ? !!(op.verify && (op.verify.ok || op.verify.accepted)) : hardLeft === 0 && numLeft === 0, hard_left: hardLeft, num_left: numLeft, verifying: !!(ffOn && !op.verify) } : null
  };
}

module.exports = { lengthWindow, lengthRule, chapterRoles, relatedOf, finalItems, finalFix, verifyFix, verifyProgram, startFinalFix, startVerify, acceptAll, finalFixUndo, redoFromDraft, hedgeScan, endEchoScan, hedgeItems, loopRewrite, basisRewrite, syncScriptCheck, canSwitch, switchToOnePass, switchBack, draftOf, FLOW, isOn, checkup, startCheckup, mergeItems, decide, rewrite, parseRewrite, newNumbers, finalCheck, startFinalCheck, fixOne, markOk, retry, view, busyOf, STAGE_ZH };
