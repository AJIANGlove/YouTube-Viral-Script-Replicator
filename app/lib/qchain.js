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
// v1.135 开场合同:代入为主的片子(POV、故事式历史;别的赛道原片主要靠「下一级 / 后来怎样」推的也算)开头先签合同
// 开场合同只在这里定义一次:张力链提示词、前 30 秒四步、开头三选一、重写、终检的说法都从这里生成(v1.135 二阶修补:以前散在 5 处)
const CONTRACT = { hook: '外面的钩子', who: '你是谁', link: '你和题目的关系', want: '你此刻想要什么、怕什么', first: '第一个张力' };
const CONTRACT_DESC = {
  hook: '2–3 句,标题那件事最反常 / 代价最大的一点,不说答案',
  who: '几岁、在哪、什么处境',
  link: '一句说清「你」为什么会卷进标题那件事(例如「你是王妃家的远房堂兄」)',
  want: '此刻最想要的和最怕的',
  first: '开头只留这一个没答案的问题(写 Q1 这种编号,一般就是 Q1),加上全片的大问题,开头一共不超过两个'
};
const CONTRACT_ORDER = '外面的钩子 → 你是谁 → 你和题目的关系 → 你想要什么、怕什么 → 留一个没答案的问题 → 进第一级 / 第一幕的场景';
const CONTRACT_RULES = '你是谁、你和题目的关系一定在任何细节(物件、对白、地名、年份)之前;细节只放能让观众更懂这几项的;还没介绍过的人和事不许先出现;开头一共不超过两个没答案的问题;不写空预告(「这句话后面还会出现」)';
function contractRuleLine() { return '开场合同(顺序:' + CONTRACT_ORDER + '):' + CONTRACT_RULES + '。'; }
function immersive(run) {
  let t = '';
  try { t = require('./craft').trackOf(run); } catch (e) { t = ''; }
  if (t === 'pov') return true;
  if (t === 'history') { let st = ''; try { st = require('./craft').styleOf(run); } catch (e) {} return st !== '讲解式'; }
  // v1.137 历史悬疑(第三人称讲案子 / 讲事件)、企业与系统兴衰(讲解)不套「你」的开场合同;穿越亲历的放 POV
  if (t === 'econ' || t === 'science' || t === 'history_mystery' || t === 'national_history') return false;
  const mk = ((run || {}).source_chain || {}).main_kind;
  return mk === 'ladder' || mk === 'fate';
}
// 说破伏笔:预告「这句话后面还会出现 / 记住这句话」(埋可以,不许说出来)
// 空预告:「这句话 / 这一幕 后面还会再出现」——观众还不知道它为什么重要就被告知它会回来。
// 「这个数先记住,后面要用」「你当时还不懂,很久以后才会懂」这类挂在主线上、很快兑现的提示不算(伏笔四条,用户 2026-11-26)
const ANNOUNCE_RE = [
  /(이|그)\s*(말|한마디|문장|대사|장면|목소리)[^.!?。\n]{0,24}(다시|나중에|또)[^.!?。\n]{0,16}(들|듣|나오|떠오|울리|등장|돌아)[가-힣]{0,3}\s*(게\s*(됩|될|돼)|겁니다|거예요|것입니다|거야|것이다|거다)/,
  /(这句话|这句|这一幕|这个画面|这个声音)[^。!?\n]{0,14}(还会|会再|之后会|后面会|稍后会|以后会|待会)/,
  /(you'?ll|you will) (hear|see) (this|that|these words) again/i
];
function announceScan(text) {
  const hits = [];
  let ch = 'CH01';
  String(text || '').split('\n').forEach(line => {
    const m = line.match(/^\s*\[(CH\d+)/i);
    if (m) { ch = m[1].toUpperCase(); return; }
    line.split(/(?<=[.?!。？！])\s*/).forEach(s => { if (ANNOUNCE_RE.some(re => re.test(s))) hits.push({ ch, quote: s.trim() }); });
  });
  return hits;
}
function normalizeOpening(o) {
  o = o && typeof o === 'object' ? o : {};
  const out = {};
  Object.keys(CONTRACT).forEach(k => { out[k] = str(o[k]).trim(); });
  out.first = out.first.toUpperCase().match(/^Q\d+$/) ? out.first.toUpperCase() : out.first;
  return out;
}
// 伏笔四条:挂在张力链某一环上(是那个问题的线索)、同一级或下一级就解开(留到结尾的中间至少再出现一次)、没有合适的就不埋
function normalizePlant(p, legacy) {
  p = p && typeof p === 'object' ? p : (legacy ? { what: legacy } : {});
  const q = v => { const m = str(v).trim().toUpperCase().match(/^Q\d+$/); return m ? m[0] : ''; };
  const what = str(p.what).trim();
  return what ? { what, clue_for: q(p.clue_for), plant_at: q(p.plant_at), payoff_at: q(p.payoff_at), mid_at: q(p.mid_at) } : null;
}
const num = id => Number(str(id).slice(1)) || 0;
function plantIssues(plant, qs) {
  if (!plant) return [];
  const ids = new Set(arr(qs).map(q => q.id));
  const out = [];
  if (!plant.clue_for || !ids.has(plant.clue_for)) out.push('伏笔「' + cut(plant.what, 20) + '」没挂在张力链的某一环上(clue_for 写它是哪个问题的线索);挂不上就别埋,plant 留空');
  if (!plant.plant_at || !plant.payoff_at || !ids.has(plant.plant_at) || !ids.has(plant.payoff_at)) out.push('伏笔没写在哪个问题埋(plant_at)、在哪个问题解开(payoff_at)');
  else if (num(plant.payoff_at) - num(plant.plant_at) > 3 && !(plant.mid_at && num(plant.mid_at) > num(plant.plant_at) && num(plant.mid_at) < num(plant.payoff_at)))
    out.push('伏笔在 ' + plant.plant_at + ' 埋、' + plant.payoff_at + ' 才解开,隔太远观众早忘了:改成同一级或下一级就解开,要留到后面就在中间(mid_at)再出现一次、意思变一层');
  return out;
}
function plantText(chain) {
  const p = (chain || {}).plant;
  if (!p) return '伏笔:这篇不埋伏笔(没有挂在主线上的合适伏笔,不硬凑)。';
  return '伏笔:' + p.what + '(它是 ' + (p.clue_for || '?') + ' 那个问题的线索;' + (p.plant_at ? '在 ' + p.plant_at + ' 那段埋' : '') + (p.mid_at ? ',' + p.mid_at + ' 那段再出现一次、意思变一层' : '') + (p.payoff_at ? ',' + p.payoff_at + ' 那段解开' : '') + ')。' + PLANT_RULE;
}
const PLANT_RULE = '埋的时候不解释、不空预告(不写「这句话后面还会出现」);可以像原片那样轻轻点一句「你当时还不懂」,前提是它很快就解开;解开时让观众自己对上。';
// 给写稿 / 开头 / 重写 / 终检看的开场合同(没有返回空)
function contractText(run) { return contractOf((run || {}).question_chain); }
function contractOf(c) {
  const o = c && c.opening;
  if (!o || !(o.who || o.link)) return '';
  const q = /^Q\d+$/.test(o.first) ? arr(c.questions).find(x => x.id === o.first) : null;
  const val = { ...o, hook: o.hook || CONTRACT_DESC.hook, first: q ? q.id + '〈' + (KINDS[q.kind] || '') + '〉「' + q.ask + '」' : o.first };
  return '开场合同(CH01 只按它写,顺序不变;它没写的东西开头不放):\n' +
    ['hook', 'who', 'link', 'want', 'first'].map((k, i) => '①②③④⑤'[i] + ' ' + CONTRACT[k] + ':' + val[k]).join('\n') + '\n' +
    CONTRACT_RULES + '。\n' + plantText(c);
}
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
    .replaceAll('{{locks}}', locks || '(没有)')
    .replaceAll('{{opening_rule}}', immersive(run)
      ? '这篇是代入为主的片子(「你」就是一个身份),必须写 opening(开场合同),每一项都要写具体:\n' +
        Object.keys(CONTRACT).map(k => '- ' + k + '(' + CONTRACT[k] + '):' + CONTRACT_DESC[k] + ';').join('\n') +
        '\n' + contractRuleLine() + '\n讲法 mode 写 you,setup 写这个身份的前提(不是算账)。'
      : '这篇不是代入身份的片子,opening 留空对象 {}。');
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
    cases_use: arr(j && j.cases_use).filter(c => c && str(c.name).trim()).map(c => ({ name: str(c.name).trim(), as: str(c.as).trim(), q: str(c.q).trim().toUpperCase() })), questions: qs,
    opening: normalizeOpening(j && j.opening), plant: normalizePlant(j && j.plant, j && j.opening && j.opening.plant) };
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
  if (immersive(run)) {
    const o = chain.opening || {};
    ['who', 'link', 'want'].forEach(k => { if (!o[k]) issues.push('开场合同没写「' + CONTRACT[k] + '」(opening.' + k + ')'); });
    if (o.first && /^Q\d+$/.test(o.first) && !qs.some(q => q.id === o.first)) issues.push('开场合同的第一个张力 ' + o.first + ' 不在问题链里');
  }
  plantIssues(chain.plant, qs).forEach(x => issues.push(x));
  if (chain.plant && ANNOUNCE_RE.some(re => re.test(chain.plant.what))) issues.push('伏笔写成了空预告(「这句话后面还会出现」),写埋的那句话 / 那个物件本身');
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

// 提示词或合同规矩改了就升版本:老任务的张力链缓存作废,下次跑蓝图自动重排(v1.135 二阶修补)
const CHAIN_VER = 'v1135-oc2';
async function ensureChain(run, asset, ft, callLlm) {
  // 先拆原片张力链(每个对标一次,存起来复用);拆不出来不挡,新链按功能表排
  if (asset) {
    try { const sc = await ensureSourceChain(asset, callLlm); if (sc) run.source_chain = sc; }
    catch (e) { run.source_chain_error = String(e.message || e).slice(0, 200); }
  }
  const key = CHAIN_VER + '|' + str((ft || {}).at) + '|' + str(run.analysis_confirmed_at) + '|' + str(((run.steps || {}).analysis || {}).finished_at) + '|' + str((run.source_chain || {}).at);
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
    (contractOf(chain) ? '\n' + contractOf(chain) + '\n(蓝图 CH01 的 key_points 就按这份合同一项一项写。)' : '') +
    (!contractOf(chain) && chain.plant ? '\n' + plantText(chain) : '') +
    (arr(chain.cases_use).length ? '\n真人案例怎么用:' + chain.cases_use.map(c => c.name + (c.q ? '(' + c.q + ')' : '') + ':' + c.as).join(';') : '');
}
// 写稿 / 重写时的讲法规矩(一段话)
function framingRule(chain, sc, run) {
  if (!chain || !chain.mode) return '';
  const fb = framingBase(chain, run);
  return fb + (chain.plant && !/^讲法:代入式。全片/.test(fb) ? plantText(chain) : '') + voicingRule(chain, sc);
}
// 问题念不念出来照原片;各种张力怎么写,只给这篇用到的写法卡
function voicingRule(chain, sc) {
  const kinds = [...new Set(arr(chain.questions).map(q => q.kind || 'info'))];
  return '\n- 问题怎么说出口:照原片(' + ((sc && sc.voiced_style) || '只在转段处直接问一句,段内靠陈述推进') + ');不每段都写「那么……呢?」。\n- 每一环按它的种类写(下面是这篇用到的写法卡):\n' + cardsText(kinds);
}
function framingBase(chain, run) {
  const o = chain.opening || {};
  if (run ? immersive(run) : (o.who || o.link)) {
    return '讲法:代入式。全片的「你」就是这个身份' + (o.who ? ':' + o.who : '') + (o.link ? ';' + o.link : '') + (chain.setup ? '(' + chain.setup + ')' : '') + '。每一章都从「你」此刻的处境、看到的、想要的和怕的往前推,不变成第三人称讲解;真实的人(王、王妃、大臣这类)按史实出场,说他们真实做过的事。' +
      plantText(chain) + '真名字旁边只放事实表里有出处、属于他的事和数。';
  }
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
  return { source: run.source_chain ? { main_kind: run.source_chain.main_kind, main_why: run.source_chain.main_why, voiced_style: run.source_chain.voiced_style, max_open: run.source_chain.max_open, big_tension: run.source_chain.big_tension, segments: arr(run.source_chain.segments) } : null, source_error: str(run.source_chain_error), kinds: KINDS, mode: c.mode, mode_label: c.mode_label || MODES[c.mode], mode_why: c.mode_why, setup: c.setup, big_question: c.big_question, questions: arr(c.questions), opening: c.opening && (c.opening.who || c.opening.link) ? c.opening : null, plant: c.plant || null, contract_labels: CONTRACT, immersive: immersive(run), cases_use: arr(c.cases_use), issues: arr(c.issues), retried: !!c.retried, status: st.status || 'done', secs: c.secs };
}

module.exports = { normalizePlant, plantIssues, plantText, PLANT_RULE, CONTRACT, CONTRACT_DESC, CONTRACT_ORDER, CONTRACT_RULES, contractRuleLine, immersive, ANNOUNCE_RE, announceScan, normalizeOpening, contractText, KINDS, cardsText, sourceSegmentsText, normalizeSource, readSource, ensureSourceChain, sourceBrief, voicingRule, MODES, fillPrompt, normalize, validate, ensureChain, brief, framingRule, chapterQuestions, chapterQText, checkBlueprint, realNameNumbers, casesOf, view };
