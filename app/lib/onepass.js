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
    const items = mergeItems(run, { audit: (run.review || {}).audit, extras, info, claim, ledger, listen });
    const ov = (run.review || {}).opening_variants;
    run.onepass = { ...(run.onepass || {}), stage: 'decide', checked_at: now(), items, errors,
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

// ---------- ② 拍板 + ③ 整篇重写一次 ----------
function issuesText(items) {
  if (!items.length) return '(人没有勾具体问题:按上面的规则把整篇理顺一遍,重点去掉重复绕圈、补丁句、数字口径不一致)';
  return items.map(x => '- [' + x.id + '][' + x.chapter + '][' + x.level + '] ' + x.problem + (x.quote ? '\n  原句:「' + x.quote + '」' : '') + (x.fix ? '\n  改法:' + x.fix : '')).join('\n');
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
    let base = cur(run);
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
      words: String(R.scriptWords(base)), issues: issuesText(picked), note: op.note ? '\n人另外交代的:' + op.note : '',
      facts: factsText(run), script: base
    });
    const r = await pl().inRun(runId, () => R.callLong(run, cfg, prompt, '一遍重写'));
    const p = parseRewrite(r.content);
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
  run.onepass = { ...op, picked_ids: ids, opening_choice: Number.isFinite(ovN) ? ovN : -1, note: String(body.note || '').trim().slice(0, 600), decided_at: now() };
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
    const out = await R.viaStep('final_audit', cfg, (c, sfx) => an().callJson(run, c, prompt, '一遍终检' + sfx, o => !!o && typeof o === 'object' && (o.verdict != null || Array.isArray(o.hard))));
    const fresh = store.getRun(runId) || run;
    if (cur(fresh) !== text) throw new Error('终检期间稿子被改过,请重新终检');
    const hard = arr(out.hard).filter(x => x && x.problem).map((x, i) => {
      const quote = String(x.quote || '').trim();
      return { id: 'F' + (i + 1), chapter: (String(x.chapter || '').match(/CH\d+/i) || [''])[0].toUpperCase(), kind: String(x.kind || '硬伤'), quote, problem: String(x.problem), fix: String(x.fix || '').trim(),
        found: !!(quote && R.locate(text, quote)), done: false };
    });
    const listen = checks.listenCheck(checks.extractFinalScript(text), listenOpts(fresh));
    fresh.onepass = { ...(fresh.onepass || {}), stage: 'done', final: { at: now(), hash: hash(text), verdict: String(out.verdict || ''), summary: String(out.summary || ''),
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
  store.saveRun(run);
  return { ok: true };
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
  const hardLeft = fin ? arr(fin.hard).filter(x => !x.done).length : 0;
  const numLeft = arr(op.new_numbers).filter(x => !x.ok).length;
  return {
    stage, stage_zh: STAGE_ZH[stage] || (stage === 'writing' ? '写初稿中' : '等体检'), running, stalled,
    error: op.error || '', errors: op.errors || {},
    items: arr(op.items), picked_ids: op.picked_ids || null, note: op.note || '', claim: op.claim || null,
    opening: ov ? { pick: ov.pick, pick_why: ov.pick_why || '', pick_note: ov.pick_note || '', now: arr(ov.now), title_kind: ov.title_kind || '',
      variants: arr(ov.variants).map(v => ({ i: v.i, name: v.name, text: v.text, zh: v.zh, why: v.why, steps: v.steps || {}, issues: arr(v.issues), words: v.words })) } : null,
    opening_choice: op.opening_choice != null ? op.opening_choice : (ov && ov.pick != null ? ov.pick : -1),
    rewrite: op.rewrite ? { at: op.rewrite.at, outline: op.rewrite.outline, words: op.rewrite.words, base_words: op.rewrite.base_words, opening_used: op.rewrite.opening_used, new_numbers_note: op.rewrite.new_numbers_note } : null,
    new_numbers: arr(op.new_numbers), final: fin, fixes: arr(op.fixes),
    publish: fin ? { ok: hardLeft === 0 && numLeft === 0, hard_left: hardLeft, num_left: numLeft } : null
  };
}

module.exports = { FLOW, isOn, checkup, startCheckup, mergeItems, decide, rewrite, parseRewrite, newNumbers, finalCheck, startFinalCheck, fixOne, markOk, retry, view, busyOf, STAGE_ZH };
