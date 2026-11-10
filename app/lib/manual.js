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
      ...(/^二稿审稿/.test(String(label || '')) ? { check: 'audit' } : {})
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

function finish(web, p, content, how) {
  web.pending = web.pending.filter(x => x.id !== p.id);
  web.done = [...web.done, { id: p.id, label: p.label, chat_name: p.chat_name, at: now(), chars: content.length, by: how }].slice(-60);
  if (how === 'paste') {
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
function answer(runId, id, text) {
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
    // 记进对话:下一条如果是在这段对话上接着问的,只显示新的那句
    let chat = p.chat ? web.chats.find(c => c.id === p.chat) : null;
    if (!chat) { chat = { id: chatId(web), name: p.chat_name, at: now(), hashes: [] }; web.chats.push(chat); }
    chat.hashes = [...arr(p.prior), p.last, msgHash({ role: 'assistant', content })];
  }
  web.chats = web.chats.slice(-20);
  finish(web, p, content, 'paste');
  save(runId, web);
  if (w) { waiters.delete(wkey(runId, id)); w.resolve(content); }
  return { ok: true, id, waiting: !!w };
}

// 这一条改用 API 跑
function useApi(runId, id) {
  const web = must(runId);
  const p = web.pending.find(x => x.id === id);
  if (!p) throw err('这一条已经处理过了,刷新一下页面', 409);
  if (p.kind === 'script') throw err('写稿这一步要改用 API,请点「后面全部改用 API」');
  const w = waiters.get(wkey(runId, id));
  if (!w) throw err('程序重启过,这一条要等任务接着跑到这一步才能改,稍等再点', 409);
  finish(web, p, '', 'api');
  save(runId, web);
  waiters.delete(wkey(runId, id));
  require('./pipeline').llmCall(w.cfg, w.messages, w.label, { ...(w.opts || {}), noManual: true }).then(r => w.resolve(r.content), e => w.reject(e));
  return { ok: true, id };
}

// ---------- 本地模型:把「等你粘贴」这一条自动发给本地模型服务,拿回回答直接当人粘的 ----------
// 一条 pending 里有多条消息时(写稿分批)按顺序发:第 1 条按卡片提示(新开对话→always / 接着发→never),
// 后面几条一律 never(在同一个对话里接着发)。全局串行:同一时刻只跑一条链,保证对话里不会插进别的任务的消息。
// 失败停在原地并记住 next,再点时从失败那条继续,已成功的批次不重发。
let localChain = Promise.resolve();

function localConfig() {
  let cfg = null;
  try { cfg = require('./pipeline').loadConfig(); } catch (e) { cfg = null; }
  const ls = (cfg && cfg.local_service) || {};
  return {
    url: String(ls.url || '').replace(/\/+$/, ''),
    token: String(ls.token || ''),
    enabled: ls.enabled !== false,
    poll_ms: Number(ls.poll_ms) > 0 ? Number(ls.poll_ms) : 3000,
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

async function localSend(cfg, text, chatPolicy) {
  const r = await localRequest(cfg, 'POST', '/queue', { message: text, chatPolicy, source: 'viral-script' });
  if (r.status === 401) throw new Error('本地模型服务要访问令牌,检查 config.json 的 local_service.token');
  const j = r.json || {};
  const t = Array.isArray(j.tasks) ? j.tasks[0] : null;
  if (!j.ok || !t || !t.id) throw new Error('本地模型服务没有接单: ' + (j.error || ('HTTP ' + r.status)));
  return String(t.id);
}

async function localWait(cfg, taskId, onPhase, alive) {
  let missing = 0;
  let lastPhase = '';
  for (;;) {
    // 这一条已经被手动粘好 / 改用 API / 取消:不用再等,立刻把串行位让出来
    if (alive && !alive()) throw new Error('这一条已经不在等粘贴了');
    const r = await localRequest(cfg, 'GET', '/queue', null);
    if (r.status === 401) throw new Error('本地模型服务要访问令牌,检查 config.json 的 local_service.token');
    const j = r.json || {};
    const t = (Array.isArray(j.tasks) ? j.tasks : []).find(x => x.id === taskId);
    if (!t) {
      if (++missing >= cfg.max_missing_polls) throw new Error('本地模型队列里找不到这条任务了(那边可能重启过)');
    } else {
      missing = 0;
      if (onPhase && t.status && t.status !== lastPhase) { lastPhase = t.status; onPhase(t.status); }
      if (t.status === 'done') {
        const reply = String(t.reply || '').trim();
        if (!reply) throw new Error('本地模型返回了空回复');
        return { reply, timedOut: !!t.timedOut, elapsedMs: Number(t.elapsedMs) || 0 };
      }
      if (t.status === 'failed') throw new Error('本地模型处理失败: ' + (t.error || '没有说明原因'));
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
  localState(runId, id, {
    status: 'queued', phase: 'queued', index: from, total, error: '', timed_out: false,
    started_at: st.status === 'failed' ? now() : (st.started_at || now()), next: from
  });
  runLocalChain(runId, id, from);
  return { ok: true, id, from, total };
}

function runLocalChain(runId, id, from) {
  const job = async () => {
    const cfg = localConfig();
    let idx = from;
    try {
      for (idx = from; ; idx++) {
        const w = load(runId);
        const p = w && arr(w.pending).find(x => x.id === id);
        if (!p) return; // 已被「改用 API」「后面全部改用 API」或取消处理掉
        const texts = arr(p.texts);
        if (idx >= texts.length) break;
        const total = texts.length;
        localState(runId, id, { status: 'running', phase: 'sending', index: idx, total, error: '' });
        // 第 1 条按卡片提示:新开对话→always;接着发→never。后面一律 never(同一对话里继续)
        const policy = idx === 0 ? (p.how === 'continue' ? 'never' : 'always') : 'never';
        const taskId = await localSend(cfg, texts[idx].text, policy);
        localState(runId, id, { status: 'running', phase: 'waiting', index: idx, total, task_id: taskId });
        const r = await localWait(cfg, taskId, phase => localState(runId, id, { status: 'running', phase, index: idx, total, task_id: taskId }),
          () => { const x = load(runId); return !!(x && arr(x.pending).find(y => y.id === id)); });
        localState(runId, id, { status: 'running', phase: 'sent', index: idx, total, task_id: taskId, timed_out: !!r.timedOut, last_ms: r.elapsedMs });
        if (idx === texts.length - 1) { submitLocal(runId, id, r.reply); return; }
      }
      throw new Error('这一条没有可发送的内容');
    } catch (e) {
      const w = load(runId);
      const p = w && arr(w.pending).find(x => x.id === id);
      if (!p) return; // 已经不在等粘贴了,失败也不用记
      const total = arr(p.texts).length;
      localState(runId, id, {
        status: 'failed', phase: 'failed', error: e.message || String(e),
        next: Math.max(0, Math.min(idx, total - 1))
      });
    }
  };
  localChain = localChain.then(job, job).catch(() => {});
  return localChain;
}

// 和人工粘贴走同一条路:章节校验、对话记录、唤醒管线全都一样
function submitLocal(runId, id, reply) {
  localState(runId, id, { status: 'running', phase: 'submitting' });
  answer(runId, id, reply);
}

// 进程重启:上次在跑/排队的本地调用已经没了,落成 failed,页面上可以再点(不自动重投)
function resetInterrupted() {
  let files = [];
  try { files = fs.readdirSync(WEB_DIR).filter(f => /\.json$/.test(f)); } catch (e) { return 0; }
  let n = 0;
  for (const f of files) {
    const fp = path.join(WEB_DIR, f);
    let w;
    try { w = JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch (e) { continue; }
    let hit = false;
    arr(w.pending).forEach(p => {
      const st = p.local || {};
      if (st.status !== 'running' && st.status !== 'queued') return;
      p.local = {
        ...st, status: 'failed', phase: 'failed',
        error: '程序重启过,这一条没跑完,可以再点「本地模型调用」',
        next: Number.isInteger(st.index) ? st.index : 0, at: now()
      };
      hit = true; n++;
    });
    if (hit) {
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
  pend.forEach(p => {
    const w = waiters.get(wkey(runId, p.id));
    if (!w) return;
    if (p.kind === 'script') {
      waiters.delete(wkey(runId, p.id));
      const st = must(runId); st.pending = st.pending.filter(x => x.id !== p.id); save(runId, st);
      w.reject(Object.assign(new Error('改回 API 写稿'), { kind: 'web_off' }));
    } else useApi(runId, p.id);
  });
  return { ok: true };
}

// 取消任务:正在等粘贴的都停掉
function cancelRun(runId) {
  for (const [k, w] of waiters) {
    if (!k.startsWith(runId + '|')) continue;
    waiters.delete(k);
    w.reject(new Error('任务已取消'));
  }
  const st = load(runId);
  if (st && arr(st.pending).length) { st.pending = []; save(runId, st); }
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
    pending: arr(w.pending).filter(p => p.kind === 'script' || waiters.has(wkey(id, p.id)) || (WEB_RE.test(String(p.label || '')) && !API_RE.test(String(p.label || '')))) // v1.106 升级前挂着、现在改走 API 的步骤不再显示
      .map(({ prior, key, ...p }) => ({ ...p, waiting: waiters.has(wkey(id, p.id)) })),
    done: arr(w.done)
  };
}

module.exports = { WEB_RE, wants, relay, relayWrite, answer, useApi, turnOn, turnOff, clear, load, cancelRun, view, isOn, writeBatches, parseScript, chatName, prepareTitle, zhTitleOf, markCopied, localRun, localConfig, resetInterrupted, _waiters: waiters };
