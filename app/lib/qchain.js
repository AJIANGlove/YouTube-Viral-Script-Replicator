// v1.135 问题链:全篇按「观众心里的问题」一环套一环排。功能表之后、蓝图之前做一次(一次 AI 调用),
// 蓝图按它分章、写稿 / 重写按它写、蓝图审和终检按它查。同时定讲法:you(假设你来开一家)/ case(真案例)/ mix。
// 硬规矩:真名字(真人案例)旁边只能出现事实表里的真数,假设的数只能用在「你的店」上(realNameNumbers 程序查)。
const fs = require('fs');
const path = require('path');
const store = require('./store');
const checks = require('./checks');

const pl = () => require('./pipeline');
const rv = () => require('./review');
const PROMPTS = path.join(__dirname, '..', 'prompts');
const readPrompt = f => fs.readFileSync(path.join(PROMPTS, f), 'utf-8');
const arr = v => (Array.isArray(v) ? v : []);
const str = v => (v == null ? '' : String(v));
const cut = (s, n) => { s = str(s); return s.length > n ? s.slice(0, n) + '…' : s; };
const MODES = { you: '代入式(假设你来开一家)', case: '真案例', mix: '混合(代入式算账 + 真案例)' };
const TRACK_ZH = { econ: '经济', history: '历史', science: '科普', pov: 'POV', general: '通用' };
const DELETED = '新题目没有这块可删';
const KINDS = { info: '想知道', fate: '后来怎样', ladder: '下一级', why: '为什么' };
const crypto = require('crypto');
const sha = t => crypto.createHash('sha1').update(String(t || '')).digest('hex').slice(0, 12);

// ---------- 写法卡:只给用到的那几种 ----------
function cardsText(kinds) {
  let raw = '';
  try { raw = readPrompt('tension_cards.md'); } catch (e) { return ''; }
  const want = [...new Set(arr(kinds).filter(k => KINDS[k]))];
  if (!want.length) want.push('info');
  const sec = {};
  let cur = null;
  raw.split('\n').forEach(l => { const m = l.match(/^##\s+(\w+)/); if (m) { cur = m[1]; sec[cur] = []; return; } if (cur) sec[cur].push(l); });
  return want.filter(k => sec[k]).map(k => '【' + k + ' · ' + KINDS[k] + '】\n' + sec[k].join('\n').trim()).join('\n\n');
}

// ---------- 原片张力链:读原片文案拆,每个对标拆一次,存在对标目录 tension_chain.json ----------
const toMs = t => { const m = String(t || '').match(/(\d+):(\d+):(\d+)[,.](\d+)/); return m ? ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4] : 0; };
function sourceSegmentsText(asset, segs) {
  const cues = require('./srt').parseSrt(asset && asset.srt).map(c => ({ ms: toMs(c.start), text: c.text }));
  if (!cues.length || !segs.length) return '';
  const total = segs[0].dur ? segs[0].dur * 1000 : (cues[cues.length - 1].ms || 1);
  return segs.map((s, i) => {
    const a = s.start * total, b = i === segs.length - 1 ? Infinity : s.end * total;
    const txt = cues.filter(c => c.ms >= a && c.ms < b).map(c => c.text).join(' ');
    return '- ' + s.id + ' | ' + Math.round(s.start * 100) + '%–' + Math.round(s.end * 100) + '% | ' + cut(s.abstract_move || s.purpose || s.function, 120) + '\n  ' + txt;
  }).join('\n');
}
function normalizeSource(j, segs) {
  const by = {};
  arr(j && j.segments).forEach(x => { if (x && x.segment) by[str(x.segment).trim().toUpperCase()] = x; });
  const kindOf = k => (KINDS[str(k).trim()] ? str(k).trim() : 'info');
  return {
    main_kind: kindOf(j && j.main_kind), main_why: str(j && j.main_why), voiced_style: str(j && j.voiced_style), max_open: Number(j && j.max_open) || 0, big_tension: str(j && j.big_tension),
    segments: segs.map(s => { const x = by[s.id] || {}; return { segment: s.id, position: [s.start, s.end], kind: kindOf(x.kind), open: str(x.open), open_abs: str(x.open_abs), payoff: str(x.payoff), raises: str(x.raises), raises_abs: str(x.raises_abs), paid_at: str(x.paid_at).toUpperCase(), voiced: !!x.voiced, voiced_line: str(x.voiced_line) }; })
  };
}
function sourceFile(asset) { try { return path.join(store.assetDir(asset.id), 'tension_chain.json'); } catch (e) { return ''; } }
function readSource(asset) {
  const f = asset && asset.id ? sourceFile(asset) : '';
  if (!f || !fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch (e) { return null; }
}
async function ensureSourceChain(asset, callLlm) {
  if (!asset || !asset.srt) return null;
  const segs = require('./blueprint').segmentsOf(asset);
  if (!segs.length) return null;
  const key = sha(asset.srt) + '|' + segs.map(s => s.id).join(',');
  const old = readSource(asset);
  if (old && old.key === key && arr(old.segments).length) return old;
  const prompt = readPrompt('source_chain.md')
    .replaceAll('{{title}}', str((asset.meta || {}).source_title || (asset.meta || {}).name || asset.id))
    .replaceAll('{{segments}}', sourceSegmentsText(asset, segs));
  let messages = [{ role: 'user', content: prompt }];
  let r = await callLlm(messages, 'Step 1 原片张力链');
  let j = parseJson(r.content);
  if (!j || !Array.isArray(j.segments)) {
    messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: '上一次输出不是合法 JSON。请严格只输出 {"main_kind":…,"segments":[…]} 这个 JSON 对象,不要代码围栏和解释。' }];
    r = await callLlm(messages, 'Step 1 原片张力链 JSON 重试');
    j = parseJson(r.content);
  }
  if (!j || !Array.isArray(j.segments)) throw new Error('原片张力链输出不是合法 JSON');
  const out = { ...normalizeSource(j, segs), key, at: new Date().toISOString(), asset_id: asset.id };
  const f = sourceFile(asset);
  if (f) { try { fs.writeFileSync(f, JSON.stringify(out, null, 2), 'utf-8'); } catch (e) { /* 写不进对标目录就只放在任务里 */ } }
  return out;
}
function sourceBrief(sc) {
  if (!sc || !arr(sc.segments).length) return '(没拆出原片张力链:按功能表的作用排)';
  return '原片主要靠「' + (KINDS[sc.main_kind] || sc.main_kind) + '」推进' + (sc.main_why ? '(' + sc.main_why + ')' : '') + ';问题怎么说出口:' + (sc.voiced_style || '没写') + ';同一时刻最多吊着 ' + (sc.max_open || '?') + ' 个;全片大张力:' + (sc.big_tension || '没写') + '\n' +
    sc.segments.map(s => '- ' + s.segment + ' [' + s.kind + ' · ' + KINDS[s.kind] + '] 开:' + (s.open_abs || '—') + ' → 引出:' + (s.raises_abs || '—') + (s.paid_at ? '(在 ' + s.paid_at + ' 收)' : '') + (s.voiced ? ' · 原片直接说出口' : '')).join('\n');
}

function parseJson(text) {
  const t = checks.stripFence(str(text));
  try { return JSON.parse(t); } catch (e) { return checks.extractJsonObject(t); }
}
function casesOf(run) {
  return arr((run.analysis || {}).cases).filter(c => c && str(c.nick || c.who).trim()).map(c => ({ name: str(c.nick || c.who).trim(), who: str(c.who), source: str(c.source || c.src || '') }));
}
function goalMinutes(run) {
  const s = checks.goalSeconds(((run.audience || {}).video_goal) || '');
  return s ? Math.round(s / 60) : 0;
}

function fillPrompt(run, ft) {
  const a = run.analysis || {};
  const th = a.thesis_card || {};
  const facts = arr(a.facts).map(f => '- ' + f.id + ' [' + str(f.kind) + '] ' + cut(f.content, 180)).join('\n');
  let ledger = '';
  try { ledger = rv().claimLedgerText(run); } catch (e) { ledger = ''; }
  const rows = arr((ft || {}).rows).map(r => '- ' + r.segment + ' | 位置 ' + Math.round(((r.position || [])[0] || 0) * 100) + '%–' + Math.round(((r.position || [])[1] || 0) * 100) + '% | 作用:' + r.function +
    ' | 处理:' + r.treatment + (r.locks && r.locks.length ? ' | 锁定项:' + r.locks.join('、') : '') +
    '').join('\n');
  const locks = arr((ft || {}).locks).map(l => '- ' + l.id + ' ' + l.label + '(原片 ' + Math.round((l.ratio || 0) * 100) + '% 处,在 ' + l.segment + ')').join('\n');
  const cs = casesOf(run);
  const min = goalMinutes(run);
  return readPrompt('question_chain.md')
    .replaceAll('{{topic}}', str(run.topic))
    .replaceAll('{{title}}', str((a.title || {}).final_title) || str(run.topic))
    .replaceAll('{{track}}', TRACK_ZH[run.review_track] || '(没选)')
    .replaceAll('{{goal}}', min ? min + ' 分钟(大约 ' + min + ' 个问题)' : str((run.audience || {}).video_goal) || '(没写)')
    .replaceAll('{{thesis}}', ['原有认知=' + str(th.viewer_belief), '真相=' + str(th.truth), '一句话论点=' + str(th.one_line_thesis), '结尾落点=' + str(th.ending_landing)].join(';'))
    .replaceAll('{{cases}}', cs.length ? cs.map(c => '- ' + c.name + (c.who && c.who !== c.name ? '(' + cut(c.who, 80) + ')' : '') + (c.source ? ' 来源:' + cut(c.source, 60) : '')).join('\n') : '(没有)')
    .replaceAll('{{facts}}', facts || '(没有)')
    .replaceAll('{{ledger}}', ledger && ledger !== '(无)' ? ledger : '(没有)')
    .replaceAll('{{table}}', rows || '(没有功能表)')
    .replaceAll('{{source_chain}}', sourceBrief(run.source_chain))
    .replaceAll('{{cards}}', cardsText(arr((run.source_chain || {}).segments).map(s => s.kind).concat([(run.source_chain || {}).main_kind || 'info'])))
    .replaceAll('{{locks}}', locks || '(没有)');
}

// 程序把关(不花钱):编号、衔接、问答、事实、段、锁定项
function normalize(j, sc) {
  const skind = seg => ((arr((sc || {}).segments).find(s => s.segment === seg) || {}).kind) || (sc || {}).main_kind || 'info';
  const qs = arr(j && j.questions).filter(q => q && str(q.ask).trim()).map((q, i) => ({
    id: 'Q' + (i + 1), orig: str(q.id).trim().toUpperCase(), kind: KINDS[str(q.kind).trim()] ? str(q.kind).trim() : skind(str(q.segment).trim().toUpperCase()), ask: str(q.ask).trim(), answer: str(q.answer).trim(),
    fact_ids: arr(q.fact_ids).map(String), raises: str(q.raises).trim().toUpperCase(), segment: str(q.segment).trim().toUpperCase(), beat: str(q.beat).trim().toUpperCase()
  }));
  // AI 自己的编号跳了号:按顺序重编,raises 跟着换
  const map = {}; qs.forEach(q => { if (q.orig) map[q.orig] = q.id; });
  qs.forEach(q => { q.raises = map[q.raises] || (/^Q\d+$/.test(q.raises) ? '' : q.raises); delete q.orig; });
  const mode = MODES[str(j && j.mode).trim()] ? str(j.mode).trim() : 'mix';
  return { mode, mode_why: str(j && j.mode_why).trim(), setup: str(j && j.setup).trim(), big_question: str(j && j.big_question).trim(),
    cases_use: arr(j && j.cases_use).filter(c => c && str(c.name).trim()).map(c => ({ name: str(c.name).trim(), as: str(c.as).trim(), q: str(c.q).trim().toUpperCase() })), questions: qs };
}
function validate(run, chain, ft) {
  const issues = [];
  const qs = arr(chain.questions);
  const facts = new Set(arr((run.analysis || {}).facts).map(f => str(f.id)));
  const rows = arr((ft || {}).rows);
  const segOk = new Set(rows.filter(r => r.treatment !== DELETED).map(r => r.segment));
  const min = goalMinutes(run);
  if (!chain.big_question) issues.push('没写大问题(big_question)');
  if (qs.length < 6) issues.push('只有 ' + qs.length + ' 个问题,最少 6 个');
  if (min && qs.length < Math.round(min * 0.6)) issues.push('目标 ' + min + ' 分钟,只排了 ' + qs.length + ' 个问题,大约每分钟一个');
  if (chain.mode !== 'case' && !chain.setup) issues.push('讲法是「' + MODES[chain.mode] + '」,没写代入的前提(setup)');
  qs.forEach((q, i) => {
    if (!q.answer) issues.push(q.id + ' 没写答案(answer)');
    const bad = q.fact_ids.filter(x => !/账本|ledger/i.test(x) && !facts.has(x));
    if (bad.length) issues.push(q.id + ' 用的事实 ' + bad.join('、') + ' 不在事实表里');
    if (rows.length && q.segment && !segOk.has(q.segment)) issues.push(q.id + ' 放在 ' + q.segment + ',这一段功能表判了可删或者不存在');
    if (i < qs.length - 1 && q.raises && q.raises !== qs[i + 1].id && !/^LOOP/.test(q.beat)) {
      const k = qs.findIndex(x => x.id === q.raises);
      if (k > i + 2) issues.push(q.id + ' 引出的问题隔了 ' + (k - i - 1) + ' 个问题才回答(' + q.raises + '),不是悬念就要下一段回答');
    }
  });
  // 一次吊着的问题:raises 指到后面、还没轮到的
  let open = 0;
  qs.forEach((q, i) => { const k = qs.findIndex(x => x.id === q.raises); if (k > i + 1) open++; });
  if (open > 2) issues.push('有 ' + open + ' 个问题不是下一段就回答的,一次最多吊着两个');
  // 锁定项都要有问题承担
  const beats = new Set(qs.map(q => q.beat).filter(Boolean));
  arr((ft || {}).locks).filter(l => l.kind === 'peak' || l.kind === 'hook' || l.kind === 'ending').forEach(l => { if (!beats.has(String(l.id).toUpperCase())) issues.push('锁定项 ' + l.id + '(' + l.label + ')没有问题承担(beat)'); });
  // 没被问题用到的原片段(功能表没判删的)
  if (rows.length) {
    const used = new Set(qs.map(q => q.segment));
    const miss = rows.filter(r => r.treatment !== DELETED && r.treatment !== '合并到相邻章' && !used.has(r.segment)).map(r => r.segment);
    if (miss.length) issues.push('原片这几段没有放问题:' + miss.join('、') + '(大骨架不变,每段都要有问题;太薄的可以和相邻段合答一个问题)');
  }
  return issues;
}

async function ensureChain(run, asset, ft, callLlm) {
  // 先拆原片张力链(每个对标一次,存起来复用);拆不出来不挡,新链按功能表排
  if (asset) {
    try { const sc = await ensureSourceChain(asset, callLlm); if (sc) run.source_chain = sc; }
    catch (e) { run.source_chain_error = String(e.message || e).slice(0, 200); }
  }
  const key = str((ft || {}).at) + '|' + str(run.analysis_confirmed_at) + '|' + str(((run.steps || {}).analysis || {}).finished_at) + '|' + str((run.source_chain || {}).at);
  const old = run.question_chain;
  if (old && old.for_table === key && arr(old.questions).length) return old;
  const t0 = Date.now();
  run.steps = { ...(run.steps || {}), question_chain: { status: 'running', started_at: new Date().toISOString() } };
  store.saveRun(run);
  const prompt = fillPrompt(run, ft);
  let messages = [{ role: 'user', content: prompt }];
  let r = await callLlm(messages, 'Step 1 问题链');
  let j = parseJson(r.content);
  if (!j || !Array.isArray(j.questions)) {
    messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: '上一次输出不是合法 JSON。请严格只输出 {"mode":…,"questions":[…]} 这个 JSON 对象,不要代码围栏和解释。' }];
    r = await callLlm(messages, 'Step 1 问题链 JSON 重试');
    j = parseJson(r.content);
  }
  if (!j || !Array.isArray(j.questions)) throw new Error('问题链输出不是合法 JSON(重试一次后仍然不是)');
  let chain = normalize(j, run.source_chain);
  let issues = validate(run, chain, ft);
  let retried = false;
  const first = issues.slice();
  if (issues.length) {
    messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: '问题链有这些地方要改:\n' + issues.map(x => '- ' + x).join('\n') + '\n其余不变,重新输出完整 JSON。' }];
    const r2 = await callLlm(messages, 'Step 1 问题链 改一次');
    const j2 = parseJson(r2.content);
    retried = true;
    if (j2 && Array.isArray(j2.questions)) {
      const c2 = normalize(j2, run.source_chain), i2 = validate(run, c2, ft);
      if (i2.length < issues.length) { chain = c2; issues = i2; }
    }
  }
  const out = { ...chain, mode_label: MODES[chain.mode], at: new Date().toISOString(), for_table: key, secs: Math.round((Date.now() - t0) / 100) / 10, issues, first_issues: first, retried };
  run.question_chain = out;
  run.steps.question_chain = { status: 'done', secs: out.secs, finished_at: out.at };
  store.saveRun(run);
  return out;
}

// 给蓝图看的问题链
function brief(chain) {
  if (!chain || !arr(chain.questions).length) return '(没有问题链)';
  return '讲法:' + (MODES[chain.mode] || chain.mode) + (chain.mode_why ? '(' + chain.mode_why + ')' : '') + '\n' +
    (chain.setup ? '代入前提:' + chain.setup + '\n' : '') +
    '大问题:' + chain.big_question + '\n' +
    chain.questions.map(q => '- ' + q.id + ' 〈' + (KINDS[q.kind] || '想知道') + '〉 [' + (q.segment || '—') + (q.beat ? ' · ' + q.beat : '') + '] 问:' + q.ask + ' → 答:' + q.answer + (q.fact_ids.length ? '(' + q.fact_ids.join(',') + ')' : '') + (q.raises ? ' → 引出 ' + q.raises : '')).join('\n') +
    (arr(chain.cases_use).length ? '\n真人案例怎么用:' + chain.cases_use.map(c => c.name + (c.q ? '(' + c.q + ')' : '') + ':' + c.as).join(';') : '');
}
// 写稿 / 重写时的讲法规矩(一段话)
function framingRule(chain, sc) {
  if (!chain || !chain.mode) return '';
  return framingBase(chain) + voicingRule(chain, sc);
}
// 问题念不念出来照原片;各种张力怎么写,只给这篇用到的写法卡
function voicingRule(chain, sc) {
  const kinds = [...new Set(arr(chain.questions).map(q => q.kind || 'info'))];
  return '\n- 问题怎么说出口:照原片(' + ((sc && sc.voiced_style) || '只在转段处直接问一句,段内靠陈述推进') + ');不每段都写「那么……呢?」。\n- 每一环按它的种类写(下面是这篇用到的写法卡):\n' + cardsText(kinds);
}
function framingBase(chain) {
  const base = '真名字(真实的店、人、品牌)旁边只能出现事实表里有出处、属于他的真数;假设出来的数只用在「你的店 / 假如一家店」身上,不许把真店的名字和编出来的营业额、利润放在一起。';
  if (chain.mode === 'case') return '讲法:真案例。全片围绕真实的人和事讲,用事实表里的真数;出处在真人、真事第一次出场时半句带过,之后不再解释。' + base;
  return '讲法:' + MODES[chain.mode] + '。算账都在这个前提里:「' + chain.setup + '」。用「假设你 / 假如 / 比如」带出数字,观众自然知道是举例,不再单独声明「这是假设 / 不是真实数据 / 当估算看」。账本里的数就是「你的店」的数,算账一步一步跟着账本走。' +
    (chain.mode === 'mix' ? '真实案例单独出场,讲他们真实发生的事。' : '真实的店和人只当单独的故事讲。') + base;
}
// 蓝图每章写了 questions:[…] 时,这一章回答的问题(给写稿、重写、终检看)
function chapterQuestions(run, c) {
  const chain = (run || {}).question_chain;
  if (!chain || !c) return [];
  return arr(c.questions).map(id => arr(chain.questions).find(q => q.id === str(id).toUpperCase())).filter(Boolean);
}
function chapterQText(run, c) {
  const qs = chapterQuestions(run, c);
  if (!qs.length) return '';
  const next = (() => { const last = qs[qs.length - 1]; return last.raises ? arr(run.question_chain.questions).find(q => q.id === last.raises) : null; })();
  return '本章要收的张力(开什么收什么,收完引出下一个):' + qs.map(q => q.id + '〈' + (KINDS[q.kind] || '想知道') + '〉 开「' + q.ask + '」→ 收「' + q.answer + '」').join(';') + (next ? ';本章结尾引出:' + next.id + '「' + next.ask + '」(下一章开头就回答它)' : '');
}

// 蓝图审:按问题链对账(程序,不花钱)
function checkBlueprint(run, chs) {
  const chain = (run || {}).question_chain;
  const out = { missing: [], order: [], empty: [], dup: [], unknown: [] };
  if (!chain || !arr(chain.questions).length) return out;
  const ids = chain.questions.map(q => q.id);
  const at = {};
  chs.forEach((c, i) => {
    const qs = arr(c.questions).map(x => str(x).toUpperCase());
    if (!qs.length) out.empty.push(c.id);
    qs.forEach(q => { if (!ids.includes(q)) out.unknown.push({ ch: c.id, q }); else if (at[q]) out.dup.push({ q, a: at[q].ch, b: c.id }); else at[q] = { ch: c.id, i }; });
  });
  ids.forEach(q => { if (!at[q]) out.missing.push(q); });
  // 按蓝图里出现的先后排一遍(章内的先后也算),和问题链的编号顺序比
  let last = -1;
  chs.forEach(c => arr(c.questions).map(x => str(x).toUpperCase()).forEach(q => {
    const k = ids.indexOf(q);
    if (k < 0) return;
    if (k < last && !out.order.some(o => o.q === q)) out.order.push({ q, ch: c.id });
    last = Math.max(last, k);
  }));
  return out;
}

// 真名字旁边出现编出来的数(程序查):句子里有真人案例的名字,又有事实表里没有的数
function realNameNumbers(run, text) {
  const names = [...new Set(casesOf(run).map(c => c.name).concat(arr(((run || {}).question_chain || {}).cases_use).map(c => c.name)).filter(n => n && n.length >= 2))];
  if (!names.length) return [];
  const R = rv();
  const a = run.analysis || {};
  const allowed = new Set(R.factNumbers(JSON.stringify(a.facts || []) + ' ' + JSON.stringify(a.cases || [])));
  const hits = [];
  R.scriptChapters(text).forEach(c => {
    String(c.text).split(/(?<=[.?!。？！])\s+/).forEach(s => {
      const name = names.find(n => s.includes(n));
      if (!name) return;
      const bad = R.factNumbers(s).filter(x => !allowed.has(x));
      if (bad.length) hits.push({ ch: c.id, quote: s.trim(), name, nums: bad });
    });
  });
  return hits;
}

function view(run) {
  const c = (run || {}).question_chain;
  if (!c) return null;
  const st = ((run.steps || {}).question_chain) || {};
  return { source: run.source_chain ? { main_kind: run.source_chain.main_kind, main_why: run.source_chain.main_why, voiced_style: run.source_chain.voiced_style, max_open: run.source_chain.max_open, big_tension: run.source_chain.big_tension, segments: arr(run.source_chain.segments) } : null, source_error: str(run.source_chain_error), kinds: KINDS, mode: c.mode, mode_label: c.mode_label || MODES[c.mode], mode_why: c.mode_why, setup: c.setup, big_question: c.big_question, questions: arr(c.questions), cases_use: arr(c.cases_use), issues: arr(c.issues), retried: !!c.retried, status: st.status || 'done', secs: c.secs };
}

module.exports = { KINDS, cardsText, sourceSegmentsText, normalizeSource, readSource, ensureSourceChain, sourceBrief, voicingRule, MODES, fillPrompt, normalize, validate, ensureChain, brief, framingRule, chapterQuestions, chapterQText, checkBlueprint, realNameNumbers, casesOf, view };
