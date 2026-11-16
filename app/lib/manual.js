// v1.105 网页版接力:选完论点后,写前分析、AI 调整、出蓝图、写稿这几步不调 API,
// 程序把拼好的提示词交给人复制到自己的 Claude 网页版,人把回答粘回来,程序照常解析、检查、往下走。
// 后面的审核、初稿检查、二稿审稿、终审照旧走 API。v1.113 起优化(Step 4)也走网页版。
//
// 做法:llmCall 遇到「这篇开了网页版 + 这一步属于网页版」时不发请求,改成在任务上挂一条「等你粘贴」,
// 等人粘回来再把回答当成 AI 的输出交回调用方。调用方(重试、续写、闸门)的逻辑一行不改。
// 同一段对话的后续消息(格式不对重发、续写、按意见改)只显示新的那一句,让人在同一个网页对话里接着发。
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const store = require('./store');
// 接力状态单独存一个文件(data/web/<任务>.json),不放在任务里:
// 写稿管线手里拿着任务对象、隔一会儿整对象存一次,放在任务里会把刚粘进来的回答盖掉
const WEB_DIR = path.join(store.APP_ROOT, 'data', 'web');
const fileOf = runId => path.join(WEB_DIR, String(runId).replace(/[^\w-]/g, '') + '.json');
function load(runId) { try { return JSON.parse(fs.readFileSync(fileOf(runId), 'utf-8')); } catch (e) { return null; } }
function save(runId, st) { fs.mkdirSync(WEB_DIR, { recursive: true }); const f = fileOf(runId); fs.writeFileSync(f + '.tmp', JSON.stringify(st)); fs.renameSync(f + '.tmp', f); }
function must(runId) { const st = load(runId); if (!st) throw err('这个任务没有开网页版', 404); return webOf(st); }

// 哪些步骤走网页版(v1.106 收窄):写前分析(那条最长的消息,格式不对重发也在同一个对话)、蓝图(含闸门重试、按蓝图审改)、写稿
// 原片对照表、AI 调整(查询词、调整、补素材、修账本、账本对照、论点对账)、蓝图前的功能表、蓝图补搜自动走 API,不用人点
// 蓝图审照旧走 API(人选的:蓝图先粘回来,程序检查 + 蓝图审)
// v1.113 优化(Step 4)也走网页版:主调用新开「优化」对话,结构/篇幅/听感重试回这个对话接着发;外文字符修正(逐行小修)照旧走 API。审核(Step 3)照旧走 API
// v1.115 ⑧ 二稿审稿报告的主调用也走网页版(新开「二稿审稿」对话,不沿用写稿/优化的对话,免得审自己写的稿);中文对照、问题在哪/大白话照旧走 API
const WEB_RE = /^(写前分析|Step 1|Step 2|Step 4|二稿审稿)/;
const API_RE = /蓝图审(?!改)|^Step 1 (蓝图补搜|功能表)|^Step 4 外文字符修正/;
const ANSWERS_MAX = 40;

const hash = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
const msgHash = m => hash((m.role || '') + '\n' + (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
const keyOf = messages => hash(messages.map(msgHash).join('|'));
const arr = v => (Array.isArray(v) ? v : []);
const now = () => new Date().toISOString();
const err = (msg, status) => Object.assign(new Error(msg), { status: status || 400 });

function isOn(runOrId) { const id = runOrId && typeof runOrId === 'object' ? runOrId.id : runOrId; const st = id ? load(id) : null; return !!(st && st.on); }
function wants(runId, label) {
  if (!runId || !WEB_RE.test(String(label || '')) || API_RE.test(String(label || ''))) return false;
  return isOn(runId);
}
// 这一步在页面上叫什么、属于哪段对话
function chatName(label) {
  const l = String(label || '');
  if (/^写前分析/.test(l)) return '写前分析';
  if (/^原片对照表/.test(l)) return '原片对照表';
  if (/^(联网查询词|AI 先调整|AI 补素材|AI 修账本|账本对照事实|账本补推算行|论点对账)/.test(l)) return 'AI 调整·' + l.replace(/(重试|续写)\d*.*$/, '').trim();
  if (/^Step 1 功能表/.test(l)) return '蓝图·功能表';
  if (/^Step 1/.test(l)) return '蓝图';
  if (/^Step 2/.test(l)) return '写稿';
  if (/^Step 4/.test(l)) return '优化';
  if (/^二稿审稿/.test(l)) return '二稿审稿';
  if (/^终审·修改/.test(l)) return '终审·修改';
  return l;
}

const waiters = new Map(); // runId|id → { resolve, reject, cfg, messages, label, opts }
const wkey = (runId, id) => runId + '|' + id;

function webOf(st) {
  st.chats = arr(st.chats);
  st.pending = arr(st.pending);
  st.done = arr(st.done);
  st.answers = st.answers && typeof st.answers === 'object' ? st.answers : {};
  return st;
}
// 多条消息又对不上任何已有对话(比如程序重启过):拼成一条完整消息,新开对话发
function flatten(messages) {
  if (messages.length === 1) return messages[0].content;
  return messages.map((m, i) => (m.role === 'assistant' ? '【你上一次的回答】\n' : (i === 0 ? '' : '【我的要求】\n')) + m.content).join('\n\n');
}
function chatId(web) { return 'C' + (web.cseq = (web.cseq || 0) + 1); }
function nextId(web) { return 'M' + (web.seq = (web.seq || 0) + 1); }

// ---------- v1.111 对话名里的题目用中文 ----------
// 对话名 = 步骤名 + ' · ' + 题目开头。题目用任务列表那个自动翻的中文标题;没有就在选论点时先翻一次存起来;实在没有用原文。
// 第一次给人看对话名时定下来(存在 chat_title),之后新开、接着发都用这同一个,不会前后对不上。
const titleWait = new Map(); // runId → 选论点时正在翻的那一次
const isZh = t => { const s = String(t || ''); const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length; return cjk > 0 && cjk >= (s.match(/[A-Za-z\uac00-\ud7af\u3040-\u30ff]/g) || []).length; };
function zhTitleOf(topic) {
  const t = String(topic || '').trim();
  if (!t) return '';
  if (isZh(t)) return t;
  try { return require('./topiczh').get(t) || ''; } catch (e) { return ''; }
}
// 选论点(网页版)时调:列表里还没有中文标题就先翻一次(最多等 20 秒),存进主题译文缓存
function prepareTitle(run) {
  const id = run && run.id, topic = String((run && run.topic) || '').trim();
  if (!id || !topic || zhTitleOf(topic)) return Promise.resolve();
  const tz = require('./topiczh');
  const job = Promise.race([
    tz.translateOne(topic).then(zh => { if (zh) tz.put(topic, zh); }),
    new Promise(r => setTimeout(r, 20000))
  ]).catch(() => {}).then(() => { titleWait.delete(id); });
  titleWait.set(id, job);
  return job;
}
// 定下这篇的对话名题目(只定一次)。升级前已经开过对话的,继续用原文,免得和你已经改好的对话名对不上
function fixTitle(runId, web) {
  if (web.chat_title != null) return;
  const run = store.getRun(runId) || {};
  const topic = String(run.topic || '').trim();
  web.chat_title = web.chats.length || web.done.length ? topic : (zhTitleOf(topic) || topic);
}

// v1.113 优化这一步:蓝图里有哪些章(粘回来时先看齐没齐)
function bpIds(runId) {
  try {
    const run = store.getRun(runId) || {};
    const bp = JSON.parse(require('./checks').stripFence(String((run.outputs || {}).step1 || '')));
    return arr(bp.chapters).map(c => String(c.id || '')).filter(Boolean);
  } catch (e) { return []; }
}
// 粘回来的终稿:去掉代码框那几行;一章都认不出、或者后面的章没有(网页版回答被截断),直接让人补齐再粘
function checkFinal(content, ids) {
  const checks = require('./checks'), textnorm = require('./textnorm');
  const text = content.split('\n').filter(l => !/^\s*```[a-z]*\s*$/i.test(l)).join('\n').trim();
  const have = checks.parseChapters(checks.extractFinalScript(textnorm.normalizeChapterTags(text))).map(c => 'CH' + String(Number(c.ch)).padStart(2, '0'));
  if (!have.length) throw err('没找到任何章节标签行(像 [CH01 | 0:00-1:00 | 功能] 这样的行)。请把 Claude 输出的终稿整段复制过来,标签行要带上');
  const missing = arr(ids).filter(id => !have.includes('CH' + String(Number(String(id).replace(/\D/g, ''))).padStart(2, '0')));
  if (missing.length) throw err('还缺 ' + missing.join('、') + '。Claude 的回答可能被截断了:在网页里点「继续」(或说「继续」),等它写完,把前后几段按顺序拼在一起再粘进来');
  return text;
}

// v1.115 粘回来的二稿审稿报告:结尾给程序读的问题清单(===ISSUES===)和路线(===ROUTE===)要在,不在就是没写完,不收
function checkAudit(content) {
  const t = content.replace(/^[*`\s]*(===\s*[A-Za-z]+\s*===)[*`\s]*$/gm, '$1');
  const miss = ['ISSUES', 'ROUTE'].filter(k => !new RegExp('^===\\s*' + k + '\\s*===\\s*$', 'm').test(t));
  if (miss.length) throw err('报告没写完(结尾的 ' + miss.map(k => '===' + k + '===').join(' / ') + ' 不在)。回到网页版点「继续」(或者发一句「继续」),等它写到最后,把后半段拼上再粘');
  // v1.118 清单在,但一条问题都认不出来,报告里却有 P01 小节 / 推荐理由说要改 P0:不能当成「0 个问题」收下
  const R = require('./review');
  const cut = t.search(/^===\s*(SCORE|ISSUES|ROUTE)\s*===\s*$/m);
  const report = cut >= 0 ? t.slice(0, cut) : t;
  const block = k => ((t.split(new RegExp('^===\\s*' + k + '\\s*===\\s*$', 'm'))[1] || '').split(/^===\s*[A-Za-z]+\s*===\s*$/m)[0] || '').replace(/^```.*$/gm, '');
  if (!R.parseAuditIssues(block('ISSUES')).length && !Object.keys(R.auditSections(report)).length && R.auditLooksNonEmpty(report, block('ROUTE')))
    throw err('报告里写了要改的问题(有 P01 这样的编号,或推荐理由提到 P0),但程序一条都没认出来,不能当成「0 个问题」收下。多半是复制时格式丢了:请用网页版回答下面的「复制」按钮(不要拖选文字)把整份报告复制过来再粘');
  return content;
}

// 挂一条「等你粘贴」;返回和 llmCall 一样形状的结果
function relay(runId, cfg, messages, label, opts) {
  const w = titleWait.get(runId);
  if (w) return w.then(() => relay0(runId, cfg, messages, label, opts));
  return relay0(runId, cfg, messages, label, opts);
}
function relay0(runId, cfg, messages, label, opts) {
  const web = must(runId);
  const key = keyOf(messages);
  const t0 = Date.now();
  const result = content => ({ content, secs: (Date.now() - t0) / 1000, stopReason: 'end_turn', streams: 1, usage: null, manual: true });
  // 程序重启后重跑到同一步:粘过的直接用
  // v1.115 二稿审稿报告点「重跑」就是要一份新的:不拿上次粘过的(稿子没变、提示词一样也重新出一条)
  if (typeof web.answers[key] === 'string' && !/^二稿审稿/.test(String(label || ''))) return Promise.resolve(result(web.answers[key]));
  let p = web.pending.find(x => x.key === key);
  if (!p) {
    const prior = messages.slice(0, -1).map(msgHash);
    const chat = prior.length ? web.chats.find(c => c.hashes.length === prior.length && c.hashes.every((h, i) => h === prior[i])) : null;
    const last = messages[messages.length - 1];
    p = {
      id: nextId(web), key, label, at: now(), kind: 'text',
      chat: chat ? chat.id : null, chat_name: chat ? chat.name : chatName(label),
      how: chat ? 'continue' : 'new',
      texts: [{ text: chat ? last.content : flatten(messages) }],
      prior, last: msgHash(last),
      ...(/^Step 4/.test(String(label || '')) ? { check: 'final', chapters: bpIds(runId) } : {}),
      ...(/^二稿审稿/.test(String(label || '')) ? { check: 'audit' } : {}),
      ...(/^终审·修改/.test(String(label || '')) ? { check: 'edits' } : {})
    };
    fixTitle(runId, web);
    web.pending.push(p);
    save(runId, web);
  }
  return new Promise((resolve, reject) => {
    waiters.set(wkey(runId, p.id), { resolve: c => resolve(result(c)), reject, cfg, messages, label, opts });
  });
}

// 写稿:按蓝图分几批,在同一个网页对话里按顺序发;最后让它输出纯净稿,人只粘一次
function writeBatches(chapters) {
  const out = [];
  let cur = [], words = 0;
  chapters.forEach(c => {
    const w = Number(c.word_budget) || 0;
    if (cur.length && (cur.length >= 4 || words + w > 1500)) { out.push(cur); cur = []; words = 0; }
    cur.push(c); words += w;
  });
  if (cur.length) out.push(cur);
  return out;
}
function relayWrite(runId, basePrompt, chapters, briefOf) {
  const w = titleWait.get(runId);
  if (w) return w.then(() => relayWrite0(runId, basePrompt, chapters, briefOf));
  return relayWrite0(runId, basePrompt, chapters, briefOf);
}
function relayWrite0(runId, basePrompt, chapters, briefOf) {
  const web = must(runId);
  const key = hash('write|' + basePrompt + '|' + chapters.map(c => c.id).join(','));
  const t0 = Date.now();
  const result = content => ({ content, secs: (Date.now() - t0) / 1000, stopReason: 'end_turn', streams: 1, usage: null, manual: true });
  if (typeof web.answers[key] === 'string') return Promise.resolve(result(web.answers[key]));
  let p = web.pending.find(x => x.key === key);
  if (!p) {
    const ids = chapters.map(c => c.id);
    const batches = writeBatches(chapters);
    const span = b => b[0].id + (b.length > 1 ? '–' + b[b.length - 1].id : '');
    const block = b => b.map(c => briefOf(chapters.indexOf(c))).join('\n\n');
    const end = '\n\n现在直接开始写正文,不要输出思考过程、提纲或解释。每章第一行是上面给的标签行,一字不差。写完这一批就停下,等我说「接着写」。';
    const texts = batches.map((b, i) => ({
      title: '第 ' + (i + 1) + ' 条:写 ' + span(b),
      text: (i === 0
        ? basePrompt + '\n\n【分批写】整篇共 ' + chapters.length + ' 章,分 ' + batches.length + ' 次写。这一次只写 ' + span(b) + ',禁止写其它章节。\n\n'
        : '接着写 ' + span(b) + '(只写这几章,写完停下)。和上一批最后一章自然衔接;前面讲透的内容不要重讲,需要用到时一句话回顾。\n\n') + block(b) + end
    }));
    texts.push({
      title: '最后一条:输出纯净稿',
      text: '全部写完了。现在把 ' + ids[0] + ' 到 ' + ids[ids.length - 1] + ' 按顺序原样拼成一篇完整稿子输出。\n' +
        '格式:每章第一行是这一章的标签行(原样,例如 ' + '[' + ids[0] + ' | 0:00-1:00 | 功能]' + '),下面是这一章的正文。\n' +
        '只输出稿子本身:不要标题、不要说明、不要 markdown 符号(# * 等)、不要分隔线、不要代码框;不要改任何字。\n' +
        '太长一次写不完就停在两章之间,我说「继续」你再接着输出。'
    });
    p = { id: nextId(web), key, label: 'Step 2 写稿', at: now(), kind: 'script', how: 'new', chat_name: '写稿', chapters: ids, texts, prior: [], base: msgHash({ role: 'user', content: basePrompt }) };
    fixTitle(runId, web);
    web.pending.push(p);
    save(runId, web);
  }
  return new Promise((resolve, reject) => {
    waiters.set(wkey(runId, p.id), { resolve: c => resolve(result(c)), reject, write: true });
  });
}

// 粘回来的稿子:按标签切章,每个章号取第一次出现的那段;缺章就报出来
function parseScript(text, ids) {
  const textnorm = require('./textnorm');
  const lines = String(text || '').replace(/```[a-z]*\n?/gi, '').split('\n');
  const t = textnorm.normalizeChapterTags(lines.join('\n'));
  const { extractChapterBlock } = require('./pipeline');
  const blocks = [], missing = [];
  ids.forEach(id => { const b = extractChapterBlock(t, id); if (b) blocks.push(b); else missing.push(id); });
  return { missing, content: textnorm.normalizeChapterTags(blocks.join('\n\n')) };
}

function finish(web, p, content, how, meta) {
  web.pending = web.pending.filter(x => x.id !== p.id);
  web.done = [...web.done, {
    id: p.id, label: p.label, chat_name: p.chat_name, at: now(), chars: content.length, by: how,
    ...(meta || {}) // 本地模型调用:task_id / elapsed_ms / timed_out / sent / started_at,人工粘贴没有这些
  }].slice(-60);
  if (how === 'paste' || how === 'local') { // 本地提交与人工粘贴语义相同:都要留答案缓存,程序重启后跑到这一步直接取用,不用重发
    web.answers[p.key] = content;
    const ks = Object.keys(web.answers);
    if (ks.length > ANSWERS_MAX) ks.slice(0, ks.length - ANSWERS_MAX).forEach(k => delete web.answers[k]);
  }
}

// 人粘回来了
// v1.112 点过「复制」的那一段记下来(刷新、换页面、重启程序都还在),页面上一直显示「已复制 ✓ 再复制」;这条粘回去就不再显示了
function markCopied(runId, id, i) {
  const web = must(runId);
  const p = web.pending.find(x => x.id === id);
  if (!p) throw err('这一条已经处理过了,刷新一下页面', 409);
  const n = Number(i);
  if (!Number.isInteger(n) || n < 0 || n >= arr(p.texts).length) throw err('没有这一段');
  p.copied = { ...(p.copied || {}), [n]: now() };
  save(runId, web);
  return { ok: true, copied: p.copied };
}
// opts.by: 来源标记(paste=人粘的 / local=本地模型自动提交),记进 done 供事后区分;opts.meta 一并落盘
function answer(runId, id, text, opts) {
  const web = must(runId);
  const p = web.pending.find(x => x.id === id);
  if (!p) throw err('这一条已经处理过了,刷新一下页面', 409);
  let content = String(text || '').trim();
  if (!content) throw err('粘贴的内容是空的');
  const w = waiters.get(wkey(runId, id));
  if (p.kind === 'script') {
    const ps = parseScript(content, p.chapters || []);
    if (ps.missing.length === (p.chapters || []).length) throw err('没找到任何章节标签行(像 [CH01 | 0:00-1:00 | 功能] 这样的行)。请让 Claude 按最后一条消息的格式输出,带上每章的标签行再粘');
    if (ps.missing.length) throw err('还缺 ' + ps.missing.join('、') + '。Claude 可能没写完或被截断了:在网页里说「继续」,把后面的部分也一起粘进来');
    content = ps.content;
    // 后面「篇幅不够、听感不合格」重发时,程序会接着这段对话问:记成「整篇提示词 → 这份稿子」
    const chat = { id: chatId(web), name: '写稿', at: now(), hashes: [p.base, msgHash({ role: 'assistant', content })] };
    web.chats.push(chat);
  } else {
    if (p.check === 'final') content = checkFinal(content, p.chapters);
    if (p.check === 'audit') content = checkAudit(content);
    if (p.check === 'edits' && !/^\s*[*`]*\s*===\s*EDIT\s*===/m.test(content)) throw err('没找到任何一处修改(===EDIT=== 开头的块)。请把 Claude 的整段回答粘进来;回答被截断了就在网页里点「继续」,几段按顺序拼起来粘');
    // 记进对话:下一条如果是在这段对话上接着问的,只显示新的那句
    let chat = p.chat ? web.chats.find(c => c.id === p.chat) : null;
    if (!chat) { chat = { id: chatId(web), name: p.chat_name, at: now(), hashes: [] }; web.chats.push(chat); }
    chat.hashes = [...arr(p.prior), p.last, msgHash({ role: 'assistant', content })];
  }
  web.chats = web.chats.slice(-20);
  const by = (opts && opts.by) || 'paste';
  finish(web, p, content, by, opts && opts.meta);
  save(runId, web);
  // 人工粘贴会打断连续会话(网页窗口里没有这条本地服务没发过的消息);本地自动提交属于段内延续,不结束段
  if (by !== 'local') {
    segDrop(runId, id);
    segForceEnd(runId, '这一条是人工粘贴的,当前连续会话已结束:下一张卡会新开会话、按负载均衡重新选账号。若你本来想接着上一个会话发,请改用「本地模型调用」。');
  }
  if (w) { waiters.delete(wkey(runId, id)); w.resolve(content); }
  return { ok: true, id, waiting: !!w };
}

// v1.119 终审「修改」:步骤渠道、Claude 主渠道都没回修改,就挂到「网页版接力」等你复制粘贴(没开网页版的任务也挂,但不开网页版,后面的步骤照旧走 API)
function relayForce(runId, cfg, messages, label, opts) {
  if (!load(runId)) save(runId, { on: false, at: now(), chats: [], pending: [], done: [], answers: {} });
  return relay0(runId, cfg, messages, label, opts);
}

// v1.121 粘回来的回答程序判不合格(比如写前分析「缺少字段 title」),这一步最后失败了:把这几条记下的回答删掉。
// 不删的话点「续跑此任务」会直接拿同一份回答再判一次,马上又失败,看起来像点了没反应
function forget(runId, messageLists) {
  const st = load(runId);
  if (!st) return 0;
  const web = webOf(st);
  let n = 0;
  arr(messageLists).forEach(m => { const k = keyOf(m); if (typeof web.answers[k] === 'string') { delete web.answers[k]; n++; } });
  if (n) save(runId, web);
  return n;
}

// 这一条改用 API 跑。opts.skipSegEnd:批量「后面全部改用 API」时由 turnOff 统一处理,避免每张卡重复释放/写盘
function useApi(runId, id, opts) {
  const web = must(runId);
  const p = web.pending.find(x => x.id === id);
  if (!p) throw err('这一条已经处理过了,刷新一下页面', 409);
  if (p.kind === 'script') throw err('写稿这一步要改用 API,请点「后面全部改用 API」');
  const w = waiters.get(wkey(runId, id));
  if (!w) throw err('程序重启过,这一条要等任务接着跑到这一步才能改,稍等再点', 409);
  finish(web, p, '', 'api');
  save(runId, web);
  // 这一条改用 API:强制结束当前段,清账号占用与锚点,下一张卡一律按新段起头
  segDrop(runId, id);
  if (!(opts && opts.skipSegEnd)) segForceEnd(runId, '这一条改用了 API,当前连续会话已结束:下一张卡会新开会话、按负载均衡重新选账号。');
  waiters.delete(wkey(runId, id));
  require('./pipeline').llmCall(w.cfg, w.messages, w.label, { ...(w.opts || {}), noManual: true }).then(r => w.resolve(r.content), e => w.reject(e));
  return { ok: true, id };
}

// ---------- 本地模型:把「等你粘贴」这一条自动发给本地模型服务,拿回回答直接当人粘的 ----------
// 会话段调度:一个 always 起头 + 之后所有 never(直到下一个 always 之前)算一段;段内独占账号,
// 段与段之间可以换号或让给别人。同一账号一条串行链;段级独占保证 never 不会落进别的任务新建的窗口。
// 严格按点击顺序分配:账号释放时先满足排队最久的任务;新段不抢刚释放的旧账号,去按均衡选另一个。
// 失败/上下文中断一律停下报错、保留账号占用等人处理;重试同一段不换号。
// 段绑定落盘 data/web/<任务>.json 的 web.segment,进程重启后据重试卡里的 account 重建占用锁。
const VIRTUAL_ACCOUNT = '__default__';
const segAccounts = new Map(); // accountId → { owner, busy, seg_at, release_pending, chain }
const segFifo = [];            // 等账号的 job,按 ticket 从小到大(点击顺序)
let segTicket = 0, segPumping = false, segNeedsRerun = false, segKickPending = false;
let segAccountsCache = { at: 0, list: [] };
// 不再由我方加长文本全局锁:服务侧的全局剪贴板锁已覆盖 write+press 与 Copy 读回完整周期,
// 我方锁的 POST+轮询区间与服务侧粘贴时刻不重叠,只会把「等生成」也串行,让多账号并行失效。
const segVirtual = a => !a || a === VIRTUAL_ACCOUNT;
const RUN_END = new Set(['done', 'failed', 'cancelled']);

// 账号列表:必须读 /queue 的 accounts[](顶层 stats/quota 只代表默认账号)
async function segListAccounts(cfg) {
  if (Date.now() - segAccountsCache.at < 10000 && segAccountsCache.list.length) return segAccountsCache.list;
  const r = await localRequest(cfg, 'GET', '/queue', null);
  if (r.status === 401) throw new Error('本地模型服务要访问令牌,检查 config.json 的 local_service.token');
  let list = arr((r.json || {}).accounts).map(a => ({
    id: String(a.id || ''), enabled: a.enabled !== false, offline: !!a.offline, paused: !!a.paused,
    blocked: !!(a.quota && a.quota.blocked), waitingFor: String((a.stats && a.stats.waitingFor) || ''),
    usage24h: Number((a.usage && a.usage.last24h) || 0) || 0
  })).filter(a => a.id);
  // 老服务没有 accounts 字段:退回单账号虚拟槽,行为等价于原来的全局串行
  if (!list.length) list = [{ id: VIRTUAL_ACCOUNT, enabled: true, offline: false, paused: false, blocked: false, waitingFor: '', usage24h: 0 }];
  segAccountsCache = { at: Date.now(), list };
  return list;
}
// 均衡:硬状态可用优先 → 软闸门降权(不排除) → 24h 用量升序 → id 稳定
function segSort(list) {
  return list.slice().sort((x, y) => {
    const rank = a => [a.enabled && !a.offline && !a.paused ? 0 : 1, (a.blocked ? 2 : 0) + (a.waitingFor ? 1 : 0), a.usage24h];
    const A = rank(x), B = rank(y);
    for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] - B[i];
    return String(x.id).localeCompare(String(y.id));
  });
}
// 给一个 job 选账号。返回 {account} / null(拿不到,继续排队) / {error}(停下报错)
function segChoose(job, list) {
  const one = list.length === 1 && segVirtual(list[0].id);
  if (one) return { account: VIRTUAL_ACCOUNT };
  const ok = list.filter(a => a.enabled && !a.offline && !a.paused);
  if (!ok.length) return { error: '当前没有可用账号(都被禁用/离线/熔断),按约定不自动换号,已停下等人处理' };
  if (job.need_account) {
    const want = job.need_account, slot = segAccounts.get(want);
    if (slot && slot.owner && slot.owner !== job.runId) {
      // 残留 owner 兜底:占着账号的 run 一张待处理卡都没有了(段已结束却没释放),才清空;
      // 正常段内(卡还在、只是 API 步骤空闲)仍返回 null 排队,段内独占不变
      const ow = load(slot.owner);
      if (ow && arr(ow.pending).length) return null;
      slot.owner = '';
    }
    if (!ok.some(a => a.id === want)) return { error: '绑定的账号 ' + want + ' 现在不可用(禁用/离线/熔断),按约定不自动换号,已停下等人处理' };
    return { account: want };
  }
  // 只有一个可用账号时没法换号:允许复用刚释放的旧账号(新段会 always 新建会话,不会串窗口)
  const others = ok.filter(a => a.id !== job.avoid_account);
  const pool = others.length ? others : ok;
  const free = segSort(pool)
    .filter(a => { const s = segAccounts.get(a.id); return !s || !s.owner || s.owner === job.runId; });
  return free.length ? { account: free[0].id } : null;
}
function segReleaseAccounts(runId) {
  for (const [, s] of segAccounts) {
    if (s.owner !== runId) continue;
    if (s.busy) { s.release_pending = true; continue; } // 还有消息在跑:跑完再放,不能中途让号
    s.owner = ''; s.release_pending = false;
  }
  segKick();
}
function segClearSegment(runId) { const w = load(runId); if (w) { delete w.segment; save(runId, w); } }
function segBind(runId, account) {
  const w = load(runId); if (!w) return;
  w.segment = { account, chat_url: '', started_at: now() };
  save(runId, w);
}
function segSetAnchor(runId, url, account) {
  const w = load(runId); if (!w || !url) return;
  if (!w.segment) w.segment = { account: account || '', chat_url: '', started_at: now() };
  w.segment.chat_url = String(url); save(runId, w);
}
// 常驻提示:写盘,刷新/切页面/重启回来都在。kind: switch 换段 / ended 强制结束 / broken 中断 / warn 告警
function segNotice(runId, kind, text) {
  const w = load(runId); if (!w) return;
  const old = w.segment_notice;
  if (old && old.kind === kind && old.text === text && Date.now() - new Date(old.at).getTime() < 600000) return;
  w.segment_notice = { kind, text, at: now() }; save(runId, w);
}
// 强制结束当前段:清账号占用与锚点,下一张卡一律按新段起头
function segForceEnd(runId, text) {
  segReleaseAccounts(runId);
  const w = load(runId); if (!w) return;
  delete w.segment; w.force_new = true;
  w.segment_notice = { kind: 'ended', text, at: now() };
  save(runId, w);
}
// 这条卡被粘好/改用 API/取消:把还在 fifo 里的 job 丢掉
function segDrop(runId, id) {
  for (let i = segFifo.length - 1; i >= 0; i--) if (segFifo[i].runId === runId && segFifo[i].id === id) segFifo.splice(i, 1);
}
function segFail(runId, id, text, kind) {
  localState(runId, id, { status: 'failed', phase: 'failed', error: text, waiting_for: '', wait_ms: 0 });
  segNotice(runId, kind || 'broken', text);
}
// run 终态懒清理:只查「有账号占用」或「还在排队」的活跃 run,不遍历全部 web 文件。
// 终态 ≠ 不会再有本地调用:任务 done 之后仍可能挂待粘贴卡(终审·修改 v1.119),
// 所以只要 w.pending 还有卡就不释放账号、不清段绑定、不动 fifo 里的 job。
// 失效 job 由 pumpSeg 里的 pending 检查自然丢弃,不能按 run.status 删。
function segSweepTerminal() {
  const active = new Set();
  for (const [, s] of segAccounts) if (s.owner) active.add(s.owner);
  for (const j of segFifo) active.add(j.runId);
  for (const runId of active) {
    let run = null;
    try { run = store.getRun(runId); } catch (e) {}
    if (!run || !RUN_END.has(String(run.status || ''))) continue;
    const w = load(runId);
    if (w && arr(w.pending).length) continue;
    segReleaseAccounts(runId);
    if (w && w.segment) { delete w.segment; save(runId, w); }
  }
}
function segKick() {
  if (segKickPending) return;
  segKickPending = true;
  setImmediate(() => { segKickPending = false; pumpSeg().catch(e => console.log('本地模型调度异常(不影响其它任务): ' + (e && e.message))); });
}
// 按点击顺序分配:队首能分就先分;队首拿不到账号时允许后面的 job 用其它账号,避免互相卡死
async function pumpSeg() {
  if (segPumping) { segNeedsRerun = true; return; }
  segPumping = true;
  try {
    segSweepTerminal();
    for (let guard = 0; guard < 100 && segFifo.length; guard++) {
      let list;
      const cfg = localConfig();
      try { list = await segListAccounts(cfg); }
      catch (e) { list = [{ id: VIRTUAL_ACCOUNT, enabled: true, offline: false, paused: false, blocked: false, waitingFor: '', usage24h: 0 }]; }
      segFifo.sort((a, b) => a.ticket - b.ticket);
      let moved = false;
      for (let i = 0; i < segFifo.length; i++) {
        const job = segFifo[i];
        const w = load(job.runId);
        if (!w || !arr(w.pending).some(p => p.id === job.id)) { segFifo.splice(i, 1); i--; moved = true; continue; }
        const c = segChoose(job, list);
        if (c && c.error) {
          segFifo.splice(i, 1); i--; moved = true;
          segFail(job.runId, job.id, c.error, 'broken');
          continue;
        }
        if (!c || !c.account) continue;
        segFifo.splice(i, 1); i--; moved = true;
        segStart(job, c.account);
      }
      if (!moved) break;
    }
  } finally {
    segPumping = false;
    if (segNeedsRerun) { segNeedsRerun = false; segKick(); }
  }
}
function segStart(job, account) {
  let s = segAccounts.get(account);
  if (!s) { s = { chain: Promise.resolve(), owner: '', busy: false }; segAccounts.set(account, s); }
  s.owner = job.runId; s.busy = true; s.seg_at = now(); s.release_pending = false;
  if (job.new_seg) segBind(job.runId, account);
  // 成功拿到账号并开跑:之前的中断/失败/告警已经过去,清掉常驻横幅(switch/ended 保留作本次提示)
  const nw = load(job.runId);
  if (nw && nw.segment_notice && ['broken', 'error', 'warn'].includes(nw.segment_notice.kind)) { delete nw.segment_notice; save(job.runId, nw); }
  localState(job.runId, job.id, { account, status: 'queued', phase: 'queued', waiting_for: '', wait_ms: 0 });
  // 排队/开跑前就按本链账号把「为什么还没开始」带回来(顶层 stats 只代表默认账号)
  localQueueState(localConfig(), account).then(q => {
    if (!q.paused && !q.waitingFor && !q.quotaBlocked) return;
    const cur = load(job.runId);
    const pp = cur && arr(cur.pending).find(x => x.id === job.id);
    if (!pp || !pp.local || pp.local.status !== 'queued') return;
    localState(job.runId, job.id, {
      waiting_for: q.paused ? ('队列已暂停:' + (q.pauseReason || '等待人工确认'))
        : (q.quotaBlocked ? ('额度闸门:' + (q.quotaBanner || '等待提示消失') + ' · 仅供参考,以提示消失为准') : q.waitingFor),
      wait_ms: q.waitMs || 0
    });
  }).catch(() => {});
  s.chain = s.chain.then(() => segJob(job, account), () => segJob(job, account)).catch(() => {});
}

function localConfig() {
  let cfg = null;
  try { cfg = require('./pipeline').loadConfig(); } catch (e) { cfg = null; }
  const ls = (cfg && cfg.local_service) || {};
  return {
    url: String(ls.url || '').replace(/\/+$/, ''),
    token: String(ls.token || ''),
    enabled: ls.enabled !== false,
    poll_ms: Number(ls.poll_ms) > 0 ? Number(ls.poll_ms) : 5000,
    max_missing_polls: Number(ls.max_missing_polls) > 0 ? Number(ls.max_missing_polls) : 60
  };
}

function localRequest(cfg, method, p, payload) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(cfg.url + p); } catch (e) { return reject(new Error('本地模型服务地址不对: ' + cfg.url)); }
    const body = payload == null ? '' : JSON.stringify(payload);
    const headers = { Accept: 'application/json' };
    if (cfg.token) headers.Authorization = 'Bearer ' + cfg.token;
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, text, json });
      });
      res.on('error', reject);
    });
    req.on('error', e => reject(new Error('连不上本地模型服务(' + cfg.url + '): ' + e.message)));
    req.setTimeout(60000, () => req.destroy(new Error('本地模型服务 60 秒没有响应')));
    if (body) req.write(body);
    req.end();
  });
}

// 必须显式传 account,绝不用 "auto"(服务端按每条消息独立选号,会把同一段的 never 拆到不同账号)
async function localSend(cfg, text, chatPolicy, account) {
  const body = { message: text, chatPolicy, source: 'viral-script' };
  if (!segVirtual(account)) body.account = account;
  const r = await localRequest(cfg, 'POST', '/queue', body);
  if (r.status === 401) throw new Error('本地模型服务要访问令牌,检查 config.json 的 local_service.token');
  const j = r.json || {};
  const t = Array.isArray(j.tasks) ? j.tasks[0] : null;
  if (!j.ok || !t || !t.id) throw new Error('本地模型服务没有接单: ' + (j.error || ('HTTP ' + r.status)));
  const mismatch = !segVirtual(account) && t.account && String(t.account) !== String(account)
    ? String(t.account) : '';
  return { id: String(t.id), seq: t.seq == null ? null : t.seq, account: account, mismatch };
}

// 队列概况:顶层 stats/quota 只代表默认账号,必须按本链账号读 accounts[] 里的那一份
async function localQueueState(cfg, account) {
  const r = await localRequest(cfg, 'GET', '/queue', null);
  if (r.status === 401) throw new Error('本地模型服务要访问令牌,检查 config.json 的 local_service.token');
  const j = r.json || {};
  const a = arr(j.accounts).find(x => String(x.id || '') === String(account)) || null;
  const st = (a && a.stats) || {};
  const q = (a && a.quota) || {};
  return {
    paused: !!j.paused,
    pauseReason: String(j.pauseReason || ''),
    waitingFor: String(st.waitingFor || ''),
    waitMs: Number(st.waitMs) || 0,
    quotaBlocked: !!q.blocked,
    quotaBanner: String(q.banner || ''),
    resetsAtMs: Number(q.resetsAtMs) || 0
  };
}

// 实时当前会话窗口:/health 顶层 accounts[].url(不是 /queue 的 accounts[],那份没有 url)
async function localCurrentUrl(cfg, account) {
  if (segVirtual(account)) return '';
  const r = await localRequest(cfg, 'GET', '/health', null);
  const a = arr((r.json || {}).accounts).find(x => String(x.id || '') === String(account));
  return a ? String(a.url || '') : '';
}

// 单任务查这一条,不再拉全量队列(队列会越积越多);新版接口 /tasks/:id 同时接受 id 和 seq
async function localWait(cfg, taskId, onPhase, alive) {
  let missing = 0;
  let lastPhase = '', longWarned = false;
  const startedAt = Date.now();
  for (;;) {
    // 这一条已经被手动粘好 / 改用 API / 取消:不用再等,立刻把串行位让出来
    if (alive && !alive()) throw new Error('这一条已经不在等粘贴了');
    const r = await localRequest(cfg, 'GET', '/tasks/' + encodeURIComponent(taskId), null);
    if (r.status === 401) throw new Error('本地模型服务要访问令牌,检查 config.json 的 local_service.token');
    const t = (r.json && r.json.task) || null;
    if (!t) {
      if (++missing >= cfg.max_missing_polls) throw new Error('本地模型里找不到这条任务了(可能被清理,或那边重启过)');
    } else {
      missing = 0;
      const st = String(t.status || '');
      // 去重键带上 reason:额度提示、拟人间隔、静默时段这类等待原因会变,只比 status 会一直显示旧文案
      const sig = st + '|' + String(t.reason || '');
      if (onPhase && st && sig !== lastPhase) { lastPhase = sig; onPhase(st, t); }
      // 到点不自动放行,只看提示是否消失:不设短超时,超过 6 小时只告警一次,不自动失败/重发
      if (!longWarned && (st === 'waiting' || st === 'queued') && Date.now() - startedAt > 6 * 3600 * 1000 && onPhase) { longWarned = true; onPhase('long_wait', t); }
      if (st === 'done') {
        if (t.hasFullBody === false) throw new Error('本地服务没有取到完整正文(只有摘要),这一条不能当答案,请重试');
        // reply 是列表摘要,fullReply 是复制纯文本(可能带弯引号),fullMarkdown 是复制 Markdown(直引号)
        // 只有 markdownSource === 'copy' 且是 JSON 类(以 { 开头)才用 Markdown 那份;否则降级 fullReply + 弯引号修复
        const src = String(t.markdownSource || '');
        const md = typeof t.fullMarkdown === 'string' ? t.fullMarkdown.trim() : '';
        const full = typeof t.fullReply === 'string' && t.fullReply.trim() ? t.fullReply : '';
        const jsonLike = /^\{/.test(md) || /^\{/.test(full);
        const clean = src === 'copy' && md && /^\{/.test(md);
        const pick = clean ? md : full;
        const reply = String(pick || t.reply || '').trim();
        if (!reply) throw new Error('本地模型返回了空回复');
        return {
          reply, timedOut: !!t.timedOut, elapsedMs: Number(t.elapsedMs) || 0,
          url: String(t.url || ''), markdownSource: src,
          degraded: !!(jsonLike && !clean) // JSON 类没拿到干净的 Copy 源码就标橙(含 markdownSource 缺失/legacy)
        };
      }
      // 以下都是「不会再有完整结果」的状态,一律判失败,不把半截内容当答案
      if (st === 'timeout') throw new Error('本地模型等待超时(30 分钟没有新进展),这一条的内容不完整,没有提交' + (t.reason ? '(' + t.reason + ')' : ''));
      if (st === 'interrupted') throw new Error('本地服务重启,这条任务被中断了' + (t.reason ? '(' + t.reason + ')' : '') + ',再点一次会重新发');
      if (st === 'cancelled') throw new Error('这条任务已经在本地服务里被删除了,再点一次会重新发');
      if (st === 'blocked') throw new Error('上下文已中断:本地服务被页面弹窗拦截了,需要在那台机器上人工处理后重试' + (t.reason ? '(' + t.reason + ')' : ''));
      if (st === 'failed') throw new Error('本地模型处理失败: ' + (t.error || t.reason || '没有说明原因'));
      if (st === 'legacy') throw new Error('本地服务把这条标成了历史记录,不会再处理,再点一次会重新发');
    }
    await new Promise(x => setTimeout(x, cfg.poll_ms));
  }
}

// 只改这一条的 local 状态(每次都重新读盘:管线那边随时会整对象重写 pending)
function localState(runId, id, patch) {
  const w = load(runId);
  if (!w) return null;
  const p = arr(w.pending).find(x => x.id === id);
  if (!p) return null;
  p.local = { ...(p.local || {}), ...patch, at: now() };
  save(runId, w);
  return p;
}

function localRun(runId, id) {
  const web = must(runId);
  const p = web.pending.find(x => x.id === id);
  if (!p) throw err('这一条已经处理过了,刷新一下页面', 409);
  const texts = arr(p.texts);
  if (!texts.length) throw err('这一条没有可发送的内容');
  const st = p.local || {};
  if (st.status === 'running' || st.status === 'queued') throw err('这一条正在等本地模型返回,不用重复点', 409);
  const cfg = localConfig();
  if (!cfg.enabled) throw err('本地模型调用没有打开(config.json 的 local_service.enabled)');
  if (!cfg.url) throw err('没有配置本地模型服务地址(config.json 的 local_service.url)');
  const total = texts.length;
  // 断点:上次停在 failed 且记了 next 就从那条继续;否则从头
  const from = Number.isInteger(st.next) && st.next > 0 && st.next < total ? st.next : 0;
  // 段边界:重跑(failed/已有 account)一律同一段不换号;只有从没跑过、且这张卡要新开会话才算新段。
  // run 级 force_new 是「上一张卡走了粘贴/API」留下的强制标记,覆盖 p.how。
  const retry = st.status === 'failed' || !!st.account;
  const forceNew = !!web.force_new;
  // force_new 是「上一张卡被粘贴/API 打断」的一次性标记,当前卡一律按新段起头(优先于失败重试)
  // 没有它时:失败重试算同一段、回原账号;从没跑过且要新开会话才算新段
  const newSeg = forceNew || (!retry && p.how !== 'continue');
  // 段被打断过:原本「接着发」的卡只带最后一句,新会话里没有上文,必须改发完整对话
  const needFull = forceNew && p.how === 'continue';
  if (needFull) {
    const w = waiters.get(wkey(runId, id));
    if (!w || !arr(w.messages).length) {
      const msg = '上下文已中断:这一条原本要接着上一个会话发,但那个会话已经结束,程序里也没有完整提示词了。请人工粘贴(新开一个对话,把整段提示词发过去),或点「这一条改用 API 跑」';
      segFail(runId, id, msg, 'broken');
      throw err(msg);
    }
  }
  const bound = (web.segment && web.segment.account) || st.account || '';
  // 段首 always 失败后重试:仍是同一段、同一账号、不换号,但第 1 条必须重新发 always(新段锚点还没建起来)
  // force_new 打断过的 continue 卡也一样:要新建会话 + 重建锚点
  const openAnchor = newSeg || needFull || (retry && from === 0 && bound && !(web.segment && web.segment.chat_url));
  let need = '';
  if (!newSeg) {
    need = st.account || (web.segment && web.segment.account) || '';
    if (!need) {
      const msg = '上下文已中断:这一条要接着上一个会话发,但没有记录它绑定的账号。请人工粘贴,或点「这一条改用 API 跑」';
      segFail(runId, id, msg, 'broken');
      throw err(msg);
    }
  }
  // 消费 force_new(只对下一张卡生效一次)
  if (web.force_new) { delete web.force_new; save(runId, web); }
  const ticket = ++segTicket;
  localState(runId, id, {
    status: 'queued', phase: 'queued', index: from, total, error: '', timed_out: false,
    started_at: st.status === 'failed' ? now() : (st.started_at || now()), next: from,
    waiting_for: '', wait_ms: 0, ticket, account: newSeg ? '' : need, new_seg: newSeg,
    need_full: !!needFull, avoid_account: newSeg ? bound : ''
  });
  if (newSeg) {
    // 段切换:释放旧账号(严格按点击顺序,排队最久的先拿),清锚点。账号在段内 API 步骤期间一直独占。
    segReleaseAccounts(runId);
    segClearSegment(runId);
    if (bound) segNotice(runId, 'switch', '上一段已结束:这一条会新开会话。原账号 ' + bound + ' 已让出,按负载均衡重新选号。');
  }
  segFifo.push({
    runId, id, from, ticket, new_seg: newSeg, open_anchor: !!openAnchor, need_full: !!needFull,
    need_account: newSeg ? '' : need,
    avoid_account: newSeg ? bound : ''
  });
  segKick();
  return { ok: true, id, from, total };
}

// 锚点校验:发送前读该账号实时会话窗口,与段锚点比;不一致再确认一次,仍不一致才停下(不静默串窗口)
async function segCheckAnchor(cfg, runId, account) {
  const w = load(runId);
  const anchor = w && w.segment && w.segment.chat_url;
  if (!anchor || segVirtual(account)) return;
  let cur = await localCurrentUrl(cfg, account);
  if (!cur || cur === anchor) return;
  await new Promise(x => setTimeout(x, cfg.poll_ms));
  cur = await localCurrentUrl(cfg, account);
  if (!cur || cur === anchor) return;
  throw new Error('上下文已中断:账号 ' + account + ' 的会话窗口已经变了(有人新开了对话或刷新了页面)。已停下,不能接着发。请人工粘贴,或点「这一条改用 API 跑」');
}

async function segJob(job, account) {
  const { runId, id, from, new_seg, open_anchor } = job;
  const cfg = localConfig();
  let idx = from;
  let lastTaskId = '', elapsed = 0, timedOut = false, sentCount = 0, startedAt = '', totalSeen = 0;
  const slot = segAccounts.get(account);
  try {
    for (idx = from; ; idx++) {
      const w = load(runId);
      const p = w && arr(w.pending).find(x => x.id === id);
      if (!p) return; // 已被「改用 API」「后面全部改用 API」或取消处理掉
      const texts = arr(p.texts);
      if (idx >= texts.length) break;
      const total = texts.length;
      totalSeen = total;
      startedAt = (p.local && p.local.started_at) || startedAt;
      const segNo = (w.segment && w.segment.started_at) || startedAt;
      localState(runId, id, {
        status: 'running', phase: 'sending', index: idx, total, error: '', waiting_for: '', wait_ms: 0,
        account, seg_started_at: segNo, seg_no: idx + 1
      });
      let text = texts[idx].text;
      // 强制新段 + 原本是 continue 卡:它只带最后一句,必须改发完整对话,否则新会话里没有上下文
      if (idx === 0 && job.need_full) {
        const wt = waiters.get(wkey(runId, id));
        if (!wt || !arr(wt.messages).length) throw new Error('上下文已中断:程序里的完整提示词已不在了(可能重启过),不能只发半截。请人工粘贴,或点「这一条改用 API 跑」');
        text = flatten(wt.messages);
      }
      // 段首 always 起新段(失败重试重建锚点也算);段内一律 never。同一张卡后续消息也在同一段里接着发
      const firstAlways = idx === 0 && (new_seg || open_anchor);
      const policy = firstAlways ? 'always' : 'never';
      if (!firstAlways) await segCheckAnchor(cfg, runId, account);
      // >200 字走全局单链:服务侧的剪贴板写入只锁住 write+press,双账号长文本并行未实测
      const sendAndWait = async () => {
        const queued = await localSend(cfg, text, policy, account);
        // 服务返回的账号与段绑定不一致:只记录 + 告警,不中断(该字段语义未经端到端实测,硬断言会误伤)
        if (queued.mismatch) {
          localState(runId, id, { account_mismatch: queued.mismatch });
          segNotice(runId, 'warn', '本地服务把这条记在账号 ' + queued.mismatch + ',段绑定的是 ' + account + '。已继续发送;若后续消息串了会话,请检查服务侧的账号回填。');
        }
        lastTaskId = queued.id;
        localState(runId, id, { status: 'running', phase: 'waiting', index: idx, total, task_id: queued.id, task_seq: queued.seq });
        return localWait(cfg, queued.id, (st, t) => {
          const waiting = st === 'queued' || st === 'waiting';
          const extra = { waiting_for: waiting && t && t.reason ? String(t.reason) : '', wait_ms: 0 };
          localState(runId, id, { status: 'running', phase: st === 'long_wait' ? 'waiting' : st, index: idx, total, task_id: queued.id, ...extra });
          if (st === 'long_wait') segNotice(runId, 'warn', '已经在队列里等了超过 6 小时。额度放行以页面提示消失为准,不会自动重发;请到那台机器上检查是否需要人工处理。');
        },
          () => { const x = load(runId); return !!(x && arr(x.pending).find(y => y.id === id)); });
      };
      const r = await sendAndWait();
      // 段首那条 always 的 url 就是本段锚点;之后每条都比对,变了就中断
      if (firstAlways && r.url) segSetAnchor(runId, r.url, account);
      else {
        const cur = load(runId);
        const anchor = cur && cur.segment && cur.segment.chat_url;
        if (anchor && r.url && r.url !== anchor)
          throw new Error('上下文已中断:这条回复落在了另一个会话窗口里(不是本段的窗口)。已停下,请人工粘贴或点「这一条改用 API 跑」');
      }
      if (r.degraded) segNotice(runId, 'warn', '本地服务这次没取到 Markdown 原始源码(markdownSource=' + (r.markdownSource || '缺失') + '),已降级用纯文本 + 弯引号修复继续;蓝图/分析若报格式不对,请重试这一条。');
      elapsed += Number(r.elapsedMs) || 0;
      timedOut = timedOut || !!r.timedOut;
      sentCount = idx + 1;
      localState(runId, id, {
        status: 'running', phase: 'sent', index: idx, total, task_id: lastTaskId,
        timed_out: !!r.timedOut, last_ms: r.elapsedMs, account, markdown_source: r.markdownSource
      });
      if (idx === texts.length - 1) {
        submitLocal(runId, id, r.reply, {
          task_id: lastTaskId, elapsed_ms: elapsed, timed_out: timedOut,
          sent: sentCount, total: totalSeen, started_at: startedAt, account, markdown_source: r.markdownSource
        });
        return;
      }
    }
    throw new Error('这一条没有可发送的内容');
  } catch (e) {
    const w = load(runId);
    const p = w && arr(w.pending).find(x => x.id === id);
    if (!p) return; // 已经不在等粘贴了,失败也不用记
    const total = arr(p.texts).length;
    const msg = e.message || String(e);
    // D3:停下报错,保留账号占用与段绑定,等人处理后重试(重试同一段不换号)
    localState(runId, id, {
      status: 'failed', phase: 'failed', error: msg,
      next: Math.max(0, Math.min(idx, total - 1))
    });
    segNotice(runId, /上下文已中断/.test(msg) ? 'broken' : 'error', msg);
  } finally {
    if (slot) {
      slot.busy = false;
      if (slot.release_pending) { slot.owner = ''; slot.release_pending = false; }
    }
    segKick();
  }
}

// 和人工粘贴走同一条路:章节校验、对话记录、唤醒管线全都一样;只是来源记成 local 并带上下面的耗时信息
function submitLocal(runId, id, reply, meta) {
  localState(runId, id, { status: 'running', phase: 'submitting' });
  answer(runId, id, reply, { by: 'local', meta: meta || {} });
}

// 进程重启:上次在跑/排队的本地调用已经没了,落成 failed,页面上可以再点(不自动重投)
// 段绑定不清除:失败的卡重试时是同一段、回原账号;同时把账号锁按盘上的段重建,防止别的任务插进来
function resetInterrupted() {
  let files = [];
  try { files = fs.readdirSync(WEB_DIR).filter(f => /\.json$/.test(f)); } catch (e) { return 0; }
  // 先扫一遍:同一账号被多个未终态 run 声明段绑定时,只让一个重建锁,
  // 其余清段 + force_new,避免重启后它们永远被「段被别人占着」挡在队列里。
  const claims = new Map(); // account → [{ runId, active }]
  const parsed = [];
  for (const f of files) {
    const fp = path.join(WEB_DIR, f);
    const runId = f.replace(/\.json$/, '');
    let w;
    try { w = JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch (e) { continue; }
    let run = null;
    try { run = store.getRun(runId); } catch (e) {}
    const ended = !!(run && RUN_END.has(String(run.status || '')));
    parsed.push({ fp, runId, w, ended });
    if (!ended && w.segment && w.segment.account) {
      const id = String(w.segment.account);
      if (!claims.has(id)) claims.set(id, []);
      claims.get(id).push({ runId, active: arr(w.pending).some(p => p.local && (p.local.status === 'running' || p.local.status === 'queued')) });
    }
  }
  const winner = new Map();
  for (const [acc, list] of claims) {
    const sorted = list.slice().sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
    winner.set(acc, sorted[0].runId);
  }
  let n = 0;
  for (const item of parsed) {
    const { fp, runId, w, ended } = item;
    let healNote = '';
    if (!ended && w.segment && w.segment.account) {
      const id = String(w.segment.account);
      if (winner.get(id) === runId) {
        const old = segAccounts.get(id);
        if (!old || !old.owner) segAccounts.set(id, { owner: runId, busy: false, seg_at: w.segment.started_at || now(), release_pending: false, chain: Promise.resolve() });
      } else {
        delete w.segment; w.force_new = true;
        healNote = '程序重启时发现多个任务都声明了账号 ' + id + ' 的连续会话,这篇已让出占用;下一张卡会新开会话、按均衡重新选账号。';
      }
    }
    let hit = false;
    arr(w.pending).forEach(p => {
      const st = p.local || {};
      if (st.status !== 'running' && st.status !== 'queued') return;
      p.local = {
        ...st, status: 'failed', phase: 'failed',
        error: '程序重启过,这一条没跑完,可以再点「本地模型调用」(同一段、原账号不变)',
        next: Number.isInteger(st.index) ? st.index : 0, waiting_for: '', wait_ms: 0, at: now()
      };
      hit = true; n++;
    });
    if (healNote || hit) {
      const base = hit ? '程序刚重启过:连续会话可能已经中断。再点「本地模型调用」会沿用原账号;发送前会校验会话窗口,不一致就停下让你改走粘贴或 API。' : '';
      w.segment_notice = { kind: healNote ? 'switch' : 'broken', text: [healNote, base].filter(Boolean).join(' '), at: now() };
      try { fs.writeFileSync(fp + '.tmp', JSON.stringify(w)); fs.renameSync(fp + '.tmp', fp); } catch (e) {}
    }
  }
  return n;
}

// 关掉网页版:后面全部改回 API(正在等的写稿这一步,程序按原来的方式逐章写)
function turnOff(runId) {
  const web = must(runId);
  web.on = false; web.off_at = now();
  const pend = web.pending.slice();
  save(runId, web);
  // 「后面全部改用 API」是人工出口:强制结束段、释放账号,让排队中的其它任务能拿到
  pend.forEach(p => segDrop(runId, p.id));
  segForceEnd(runId, '已点「后面全部改用 API」,连续会话结束、账号占用已释放,后面排队的任务可以开始了。');
  pend.forEach(p => {
    const w = waiters.get(wkey(runId, p.id));
    if (!w) return;
    if (p.kind === 'script') {
      waiters.delete(wkey(runId, p.id));
      const st = must(runId); st.pending = st.pending.filter(x => x.id !== p.id); save(runId, st);
      w.reject(Object.assign(new Error('改回 API 写稿'), { kind: 'web_off' }));
    } else useApi(runId, p.id, { skipSegEnd: true });
  });
  // 统一写一次总提示;任务已 off 且 pending 清空,不需要再留 force_new 标记
  const fin = load(runId);
  if (fin) {
    delete fin.force_new;
    fin.segment_notice = { kind: 'ended', text: '已点「后面全部改用 API」,连续会话结束、账号占用已释放,后面排队的任务可以开始了。', at: now() };
    save(runId, fin);
  }
  return { ok: true };
}

// 取消任务:正在等粘贴的都停掉,段占用一并释放
function cancelRun(runId) {
  for (const [k, w] of waiters) {
    if (!k.startsWith(runId + '|')) continue;
    waiters.delete(k);
    w.reject(new Error('任务已取消'));
  }
  segDropAll(runId);
  segReleaseAccounts(runId);
  const st = load(runId);
  if (st) {
    st.pending = [];
    delete st.segment;
    delete st.force_new;
    st.segment_notice = { kind: 'ended', text: '任务已取消,连续会话结束、账号占用已释放。', at: now() };
    save(runId, st);
  }
}
function segDropAll(runId) {
  for (let i = segFifo.length - 1; i >= 0; i--) if (segFifo[i].runId === runId) segFifo.splice(i, 1);
}

// 选论点时打开
function turnOn(runOrId) {
  const id = runOrId && typeof runOrId === 'object' ? runOrId.id : runOrId;
  save(id, { on: true, at: now(), chats: [], pending: [], done: [], answers: {} });
}
// 选论点时没选网页版:清掉(重新选论点的任务以前开过的也作废)
function clear(runOrId) {
  const id = runOrId && typeof runOrId === 'object' ? runOrId.id : runOrId;
  try { fs.unlinkSync(fileOf(id)); } catch (e) {}
}

// 页面用:不带 answers(很大),pending 里不带 prior
function view(runOrId) {
  const id = runOrId && typeof runOrId === 'object' ? runOrId.id : runOrId;
  const w = id ? load(id) : null;
  if (!w) return null;
  return {
    on: !!w.on, at: w.at, off_at: w.off_at, chat_title: w.chat_title != null ? w.chat_title : null,
    segment: w.segment || null,           // 当前连续会话:账号 / 锚点窗口 / 起段时间
    segment_notice: w.segment_notice || null, // 常驻提示(换段/被粘贴或 API 结束/上下文中断/告警)
    force_new: !!w.force_new,             // 下一张卡一律按新段起头
    pending: arr(w.pending).filter(p => p.kind === 'script' || waiters.has(wkey(id, p.id)) || (WEB_RE.test(String(p.label || '')) && !API_RE.test(String(p.label || '')))) // v1.106 升级前挂着、现在改走 API 的步骤不再显示
      .map(({ prior, key, ...p }) => ({ ...p, waiting: waiters.has(wkey(id, p.id)) })),
    done: arr(w.done)
  };
}

module.exports = { WEB_RE, wants, relay, relayForce, forget, relayWrite, answer, useApi, turnOn, turnOff, clear, load, cancelRun, view, isOn, writeBatches, parseScript, chatName, prepareTitle, zhTitleOf, markCopied, localRun, localConfig, resetInterrupted, _waiters: waiters };
