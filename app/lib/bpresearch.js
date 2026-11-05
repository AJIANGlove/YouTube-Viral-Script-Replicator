// v1.82 蓝图审「事实支撑」不过时先针对性补搜,再改蓝图(只在「按功能重排」的蓝图上用)
// 背景(기생 那一篇):第 6、7、9、10 章的核心主张靠的是写前分析里标「假设」「待查」「推定」的事实,
// 蓝图只能在现有事实里挑,改 2 次也变不出新的实录,所以改完还是不过。
// 流程:审稿点名的章 → AI 列查询词 → 联网搜(search.runQueries,3 路并行)→ AI 只用搜索结果整理新事实 → 程序核对 → 追加进事实表
// 防法:
//  · 新事实必须附搜索结果原文摘录(quote),程序核对摘录确实在那条结果里,对不上只能标「假设」(写了算法的标「估算」);
//    content 里出现摘录里没有的数字,同样不能标「事实」
//  · 论坛、博客、知识问答、维基类、视频网站不能标「事实」
//  · 和论点或反转相反的事实单独列出(against),蓝图必须正面处理(程序查有没有写进某一章)
//  · 事实表只追加新编号,原有条目一条不改
//  · 查不到:普通章降一级(写成「可能」「有说法认为」)或并掉,不硬编;
//    反转章、核心章、开头、结尾查不到时保持原样,不降级、不改动,也不停下来问(用户 2026-11-04 定的)
const fs = require('fs');
const path = require('path');
const store = require('./store');
const checks = require('./checks');
const search = require('./search');

const arr = v => (Array.isArray(v) ? v : []);
const str = v => (v == null ? '' : String(v));
const parse = t => { try { return typeof t === 'string' ? JSON.parse(t) : (t || null); } catch (e) { return null; } };
const dataOf = j => (j && j.data) || j || {};
const cut = (v, n) => { const t = str(v).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const PROMPTS = path.join(__dirname, '..', 'prompts');
const readPrompt = f => fs.readFileSync(path.join(PROMPTS, f), 'utf-8');
const bpOf = text => { try { return JSON.parse(checks.stripFence(str(text))) || {}; } catch (e) { return checks.extractJsonObject(str(text)) || {}; } };

const MAX_CHAPTERS = 5;   // 一次最多补几章
const MAX_QUERIES = 6;    // 一次最多几个查询(3 路并行,两批搜完)
const RESULTS_PER_QUERY = 4;
const QUOTE_MIN = 8;      // 摘录去掉空格标点后至少几个字

// 降级后的说法:写成「可能」「有说法认为」(中文 / 韩文 / 英文)
const HEDGE_RE = /可能|也许|或许|有说法|有人认为|一说|据说|据传|推测|未必|不一定|추정|가능성|일\s*수도|ㄹ\s*수도|수도\s*있|라는\s*(?:설|이야기|주장|말)|설이\s*있|알려져|전해(?:진|지|져)|것으로\s*보|듯하|perhaps|possibly|reportedly|may\s+have|might\s+have/i;
// 用户自己编的网页:论坛、博客、知识问答、维基类、视频网站 —— 不能标「事实」
const UGC_RE = /blog|tistory|brunch\.co\.kr|velog|medium\.com|wordpress|blogspot|cafe\.naver|cafe\.daum|kin\.naver|dcinside|fmkorea|theqoo|instiz|ruliweb|clien\.net|ppomppu|bobaedream|mlbpark|namu\.wiki|wikipedia\.org|wiki|reddit|quora|zhihu|tieba|douban|weibo|baike\.baidu|zhidao\.baidu|jianshu|csdn|youtube|youtu\.be|tiktok|bilibili|instagram|facebook|twitter|x\.com|threads\.net|论坛|博客|贴吧|블로그|카페|커뮤니티|지식iN|나무위키|위키/i;

const chIds = t => [...new Set((str(t).toUpperCase().match(/CH\s?\d{1,2}/g) || []).map(x => 'CH' + x.replace(/\D/g, '').padStart(2, '0')))];
const normLock = s => str(s).toUpperCase().replace(/\s+/g, '').replace(/[_:：]/g, '-').replace(/-?(OPEN|开)$/, '-open').replace(/-?(CLOSE|收|合)$/, '-close');
const nz = s => str(s).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

// ---------- 哪几章不能动:开头、结尾、反转章、核心章 ----------
// 核心章:承担原片最强高峰(强度最高的 PK)的章,和收开头抛出的主悬念(最早开的 LOOP)的章
function lockIdsOf(c) {
  const ids = arr(c.locks).map(normLock).concat(arr(c.carries_peaks).map(normLock));
  const ol = c.open_loop || {};
  (str(ol.close).match(/LOOP\d+/gi) || []).forEach(x => ids.push(x.toUpperCase() + '-close'));
  return new Set(ids);
}
function coreLocks(asset, accepted) {
  const tl = dataOf(parse(asset && asset.timeline));
  const acc = new Set(arr(accepted));
  const peaks = arr(tl.peak_points).filter(p => p && p.peak_id && !acc.has(p.peak_id));
  const max = Math.max(-Infinity, ...peaks.map(p => Number(p.strength) || 0));
  const out = peaks.filter(p => (Number(p.strength) || 0) === max && max > 0).map(p => p.peak_id.toUpperCase());
  const loops = arr(tl.open_loops).filter(l => l && l.loop_id && l.close_ms != null).sort((a, b) => (a.open_ms || 0) - (b.open_ms || 0));
  if (loops[0]) out.push(loops[0].loop_id.toUpperCase() + '-close');
  return out;
}
function protectedOf(run, asset, ft, chs) {
  const reversalSegs = new Set(arr((ft || {}).rows).filter(r => r.treatment === '必须是新题目自己的').map(r => r.segment));
  let accepted = [];
  try { accepted = require('./analysis').acceptedGaps(run.analysis); } catch (e) { accepted = []; }
  const core = coreLocks(asset, accepted);
  const out = {};
  chs.forEach((c, i) => {
    const roles = [];
    if (i === 0) roles.push('开头');
    if (i === chs.length - 1) roles.push('结尾');
    if (arr(c.source_segments).some(s => reversalSegs.has(str(s).toUpperCase()))) roles.push('反转');
    const ids = lockIdsOf(c);
    if (core.some(x => ids.has(x))) roles.push('核心');
    if (roles.length) out[str(c.id).toUpperCase()] = roles;
  });
  return out;
}

// 补搜时记下的章(降级 / 保持原样),在改过的蓝图里对应到哪一章:开头 / 结尾按位置,其余按承接的原片段
function mapNow(entry, chs) {
  const ids = chs.map(c => str(c.id).toUpperCase());
  const out = new Set();
  if (arr(entry.roles).includes('开头') && ids[0]) out.add(ids[0]);
  if (arr(entry.roles).includes('结尾') && ids.length) out.add(ids[ids.length - 1]);
  const segs = new Set(arr(entry.source_segments).map(s => str(s).toUpperCase()));
  if (segs.size) chs.forEach(c => { if (arr(c.source_segments).some(s => segs.has(str(s).toUpperCase()))) out.add(str(c.id).toUpperCase()); });
  else if (ids.includes(entry.ch)) out.add(entry.ch);
  return [...out];
}

// ---------- 补搜 ----------
function targetsOf(rv, pc, chs) {
  const ids = new Set(chs.map(c => str(c.id).toUpperCase()));
  const it = arr(rv.items).find(i => i.key === 'facts') || {};
  const want = [];
  arr(it.problems).forEach(p => [str(p.chapter).toUpperCase()].concat(chIds(p.text)).forEach(x => { if (ids.has(x) && !want.includes(x)) want.push(x); }));
  if (!want.length) arr(((pc || {}).facts || {}).thin).forEach(t => { const x = str(t.ch).toUpperCase(); if (ids.has(x) && !want.includes(x)) want.push(x); });
  return want.slice(0, MAX_CHAPTERS);
}
function factLine(f) { return f.id + ' [' + str(f.kind) + '] ' + cut(f.content, 140); }
function chaptersBrief(run, chs, targets, rv, prot) {
  const facts = {};
  arr((run.analysis || {}).facts).forEach(f => { if (f && f.id) facts[f.id] = f; });
  const it = arr(rv.items).find(i => i.key === 'facts') || {};
  return targets.map(id => {
    const c = chs.find(x => str(x.id).toUpperCase() === id) || {};
    const probs = arr(it.problems).filter(p => str(p.chapter).toUpperCase() === id || chIds(p.text).includes(id)).map(p => cut(p.text, 160) + (p.fix ? '(改法:' + cut(p.fix, 80) + ')' : ''));
    return '- ' + id + (prot[id] ? '(' + prot[id].join('、') + '章)' : '') + '\n  这一章要讲:' + cut(str(c.purpose) + ' ' + str(c.information_goal), 260) +
      '\n  现在用的事实:' + (arr(c.fact_ids).map(x => facts[x] ? factLine(facts[x]) : x + '(事实表里没有)').join(';') || '没写') +
      (probs.length ? '\n  审稿意见:' + probs.join(';') : '');
  }).join('\n');
}
function thesisOf(run) { const th = (run.analysis || {}).thesis_card || {}; return str(th.one_line_thesis) || str(th.truth); }
function reversalOf(ft) { return str(((ft || {}).reversal || {}).new_reversal) || '(没有)'; }
function nextFactNo(run) {
  let n = 0;
  arr((run.analysis || {}).facts).forEach(f => { const m = str(f && f.id).match(/^F(\d+)$/i); if (m) n = Math.max(n, Number(m[1])); });
  return n + 1;
}
// 程序核对一条新事实:摘录在不在那条搜索结果里、content 的数字摘录里有没有、来源是不是论坛博客
function verify(item, results) {
  const r = results[str(item.ref).toUpperCase()] || null;
  const quote = str(item.quote).trim();
  const hay = r ? nz(r.title + ' ' + r.summary) : '';
  const quoteOk = !!(r && nz(quote).length >= QUOTE_MIN && hay.includes(nz(quote)));
  const ugc = !!(r && UGC_RE.test(str(r.url) + ' ' + str(r.site)));
  const nums = (str(item.content).match(/\d+(?:[.,]\d+)?/g) || []).map(x => x.replace(/,/g, ''));
  const qn = (quote + ' ' + (r ? r.title : '')).replace(/,/g, '');
  const numMiss = nums.filter(x => !qn.includes(x));
  let kind = /估算/.test(str(item.kind)) ? '估算' : /假设/.test(str(item.kind)) ? '假设' : /网友/.test(str(item.kind)) ? '网友说法' : '事实';
  const notes = [];
  if (!r) { notes.push('引用的搜索结果编号不存在'); kind = '假设'; }
  else if (!quoteOk) { notes.push('原文摘录在搜索结果里找不到'); if (kind === '事实' || kind === '网友说法') kind = '假设'; }
  if (kind === '事实' && ugc) { notes.push('来源是论坛/博客/维基/视频类网页,不能标事实,改标网友说法'); kind = '网友说法'; } // v1.93
  if (kind === '事实' && numMiss.length) { notes.push('数字 ' + numMiss.join('、') + ' 摘录里没有'); kind = str(item.method).trim() ? '估算' : '假设'; }
  if (kind === '估算' && !str(item.method).trim() && !quoteOk) kind = '假设';
  return { r, quoteOk, ugc, kind, notes };
}

// opts:{ run, asset, ft, content, cur:{rv,pc}, callLlm, cfg? }
// 返回补搜记录(写在 run.steps.blueprint_review.research);status: done / skipped / failed
async function research(opts) {
  const { run, asset, ft, content, cur, callLlm } = opts;
  const t0 = Date.now();
  const chs = arr(bpOf(content).chapters);
  const rec = { status: 'running', started_at: new Date().toISOString(), chapters: [], queries: [], added: [], against: [], found: [], downgrade: [], kept: [], rejected: [] };
  const save = () => { run.steps.blueprint_review = { ...(run.steps.blueprint_review || {}), research: { ...rec } }; store.saveRun(run); };
  const st = search.searchStatus(opts.cfg);
  if (!st.ready) { Object.assign(rec, { status: 'skipped', why: st.enabled ? '联网搜索没有 API Key' : '设置里没开联网搜索' }); save(); return rec; }
  const targets = targetsOf(cur.rv, cur.pc, chs);
  if (!targets.length) { Object.assign(rec, { status: 'skipped', why: '审稿没点名是哪几章事实不够' }); save(); return rec; }
  const prot = protectedOf(run, asset, ft, chs);
  rec.chapters = targets.map(id => ({ ch: id, roles: prot[id] || [] }));
  save();
  try {
    const aud = run.audience || {};
    const brief = chaptersBrief(run, chs, targets, cur.rv, prot);
    const qPrompt = readPrompt('blueprint_research_queries.md')
      .replaceAll('{{today}}', require('./pipeline').todayStr())
      .replaceAll('{{topic}}', run.topic || '')
      .replaceAll('{{target_language}}', str(aud.target_language))
      .replaceAll('{{target_country}}', str(aud.target_country))
      .replaceAll('{{thesis}}', thesisOf(run))
      .replaceAll('{{reversal}}', reversalOf(ft))
      .replaceAll('{{chapters}}', brief)
      .replaceAll('{{max_queries}}', String(MAX_QUERIES));
    const qr = await callLlm([{ role: 'user', content: qPrompt }], 'Step 1 蓝图补搜 查询词');
    const qj = checks.extractJsonObject(checks.stripFence(str(qr.content))) || parse(checks.stripFence(str(qr.content))) || {};
    const per = {};
    const queries = arr(qj.queries).filter(q => q && str(q.query).trim()).map(q => ({ query: str(q.query).trim(), target: str(q.chapter).toUpperCase(), why: str(q.why) }))
      .filter(q => { per[q.target] = (per[q.target] || 0) + 1; return per[q.target] <= 2; }).slice(0, MAX_QUERIES);
    if (!queries.length) throw new Error('AI 没给出查询词');
    const batches = await search.runQueries(queries, run.topic, opts.cfg, { max: MAX_QUERIES, content: true, count: RESULTS_PER_QUERY });
    rec.queries = batches.map(b => ({ query: b.query, chapter: b.target, error: b.error || null, hits: arr(b.results).length }));
    const results = {};
    batches.forEach(b => arr(b.results).forEach(x => { results[x.ref] = x; }));
    if (!Object.keys(results).length) throw new Error('搜索没有结果' + (batches.some(b => b.error) ? '(' + cut(batches.find(b => b.error).error, 80) + ')' : ''));
    save();
    const fPrompt = readPrompt('blueprint_research_fill.md')
      .replaceAll('{{topic}}', run.topic || '')
      .replaceAll('{{thesis}}', thesisOf(run))
      .replaceAll('{{reversal}}', reversalOf(ft))
      .replaceAll('{{chapters}}', brief)
      .replaceAll('{{facts}}', arr((run.analysis || {}).facts).map(factLine).join('\n') || '(没有)')
      .replaceAll('{{results}}', search.resultsBrief(batches));
    const fr = await callLlm([{ role: 'user', content: fPrompt }], 'Step 1 蓝图补搜 整理事实');
    const fj = checks.extractJsonObject(checks.stripFence(str(fr.content))) || parse(checks.stripFence(str(fr.content)));
    if (!fj) throw new Error('整理事实的输出不是合法 JSON');
    // 只追加新编号,原有条目一条不改
    const a = run.analysis = run.analysis || {};
    a.facts = arr(a.facts);
    let no = nextFactNo(run);
    const supported = new Set();
    arr(fj.new_facts).forEach(item => {
      if (!item || !str(item.content).trim()) return;
      const ch = str(item.chapter).toUpperCase();
      // 重画蓝图又补搜到同一条(摘录或内容一样):不再追加,直接用事实表里那条
      const dup = a.facts.find(f => f && ((str(f.quote).trim() && nz(f.quote) === nz(item.quote)) || nz(f.content) === nz(item.content)));
      if (dup) {
        rec.reused = arr(rec.reused).concat([dup.id]);
        if (ch && !dup.against && !item.against && /事实/.test(str(dup.kind))) supported.add(ch);
        return;
      }
      const v = verify(item, results);
      const id = 'F' + String(no++).padStart(2, '0');
      const f = {
        id, slot: '蓝图补搜' + (ch ? '(' + ch + ')' : ''), content: str(item.content).trim(), kind: v.kind,
        source: str(item.source) || (v.r ? str(v.r.site || v.r.title) : ''), url: v.r ? str(v.r.url) : '', year: str(item.year), region: str(item.region),
        freshness: '不适用', method: v.kind === '估算' ? str(item.method) : '',
        quote: cut(item.quote, search.QUOTE_MAX), quote_checked: v.quoteOk, ref_date: v.r ? str(v.r.date) : '',
        added_by: 'blueprint_research', for_chapter: ch, ...(item.against ? { against: true, against_what: str(item.against_what) } : {}),
        ...(v.notes.length ? { check_notes: v.notes } : {})
      };
      a.facts.push(f);
      rec.added.push({ id, ch, kind: v.kind, content: cut(f.content, 120), quote_checked: v.quoteOk, url: f.url, notes: v.notes, against: !!item.against, against_what: str(item.against_what) });
      if (item.against) rec.against.push(id);
      else if (ch && (v.kind === '事实' || (v.kind === '估算' && v.quoteOk))) supported.add(ch);
      if (v.kind !== str(item.kind).trim() && str(item.kind).trim()) rec.rejected.push(id + ' AI 标「' + str(item.kind) + '」,程序改成「' + v.kind + '」:' + v.notes.join(';'));
    });
    const nf = {};
    arr(fj.not_found).forEach(x => { if (x && x.chapter) nf[str(x.chapter).toUpperCase()] = str(x.why); });
    targets.forEach(id => {
      const c = chs.find(x => str(x.id).toUpperCase() === id) || {};
      if (supported.has(id)) { rec.found.push(id); return; }
      const entry = { ch: id, roles: prot[id] || [], source_segments: arr(c.source_segments).map(s => str(s).toUpperCase()), why: nf[id] || '补搜没找到能直接撑住这一章主张的实录' };
      if (entry.roles.length) rec.kept.push(entry); else rec.downgrade.push(entry);
    });
    rec.status = 'done';
  } catch (e) {
    rec.status = 'failed';
    rec.error = e.message;
  }
  rec.secs = Math.round((Date.now() - t0) / 100) / 10;
  rec.finished_at = new Date().toISOString();
  save();
  return rec;
}

// 改蓝图的反馈里加的一段
function feedback(rec) {
  if (!rec || rec.status !== 'done') return '';
  const facts = arr(rec.added).filter(x => !x.against);
  const lines = ['\n【补搜结果】蓝图审判「事实支撑」不过,程序按点名的章联网补搜了一轮,新事实已经追加进事实表(原有事实不变):'];
  if (facts.length) lines.push(facts.map(x => '- ' + x.id + ' [' + x.kind + '](为 ' + (x.ch || '—') + ')' + x.content).join('\n') + '\n标「事实」的可以撑主张;标「估算」的要说明是估算;标「假设」的不能当主张用。用到的写进那一章的 fact_ids。');
  else lines.push('- 没补到能用的新事实。');
  if (rec.against.length) lines.push('和论点或反转相反的新事实(必须正面处理:写进某一章的 fact_ids,在 information_goal 里写这一章怎么回应它,不许放着不管):\n' + arr(rec.added).filter(x => x.against).map(x => '- ' + x.id + ' ' + x.content + (x.against_what ? '(和「' + cut(x.against_what, 60) + '」相反)' : '')).join('\n'));
  if (rec.downgrade.length) lines.push('查不到实录的章(主张降一级):' + rec.downgrade.map(d => d.ch).join('、') + '。这几章的主张改写成「可能」「有说法认为」(purpose 或 information_goal 里明写,目标语言写就用目标语言的说法),或者并进相邻章;不许硬编事实表里没有的实例、人名、年份、数字。');
  if (rec.kept.length) lines.push('这几章查不到也保持原样(' + rec.kept.map(d => d.ch + ' 是' + d.roles.join('、') + '章').join(';') + '):不降级、不并掉、不改这一章的主张,只改其他问题点到的字段。');
  return lines.join('\n');
}

// 给 AI 审(blueprint_review.md 的 {{research}})看的说明
function reviewBrief(rec) {
  if (!rec || rec.status !== 'done') return '(没有)';
  return [
    rec.added.length ? '追加的新事实:' + rec.added.map(x => x.id + '[' + x.kind + ']' + (x.against ? '(和论点或反转相反)' : '')).join('、') : '没补到新事实',
    rec.downgrade.length ? '查不到实录、要降级的章(改蓝图前的编号):' + rec.downgrade.map(d => d.ch + (d.source_segments.length ? '(承接 ' + d.source_segments.join('、') + ')' : '')).join('、') + '。这些章写成「可能」「有说法认为」或者并掉了,事实支撑按降级后的说法判:说法已经降级的不算问题,还写成确定的事实才算' : '',
    rec.kept.length ? '查不到、按规矩保持原样的章(开头、结尾、反转章、核心章):' + rec.kept.map(d => d.ch + '(' + d.roles.join('、') + ')').join('、') + '。这几章的事实支撑不再提问题' : ''
  ].filter(Boolean).join('\n');
}

// 程序检查里补的几条(blueprint.programChecks 调):
//  · 和论点或反转相反的新事实,蓝图里没有任何一章写进 fact_ids / recap_ids → 反转项不过
//  · 降级的章还只靠假设撑着、也没写成「可能」「有说法」→ 事实支撑不过;写了的,程序的「事实不够」提示不再列
// 返回 { against: [...], hedged: Set(章), unhedged: [...] }
function programItems(rec, chs, thin) {
  const out = { against: [], hedged: new Set(), unhedged: [] };
  if (!rec || rec.status !== 'done') return out;
  const used = new Set(chs.flatMap(c => arr(c.fact_ids).concat(arr(c.recap_ids)).map(String)));
  arr(rec.against).forEach(id => { if (!used.has(id)) out.against.push(id); });
  const txt = c => ['purpose', 'information_goal', 'emotion_goal', 'new_lens', 'answers_prev', 'leaves_question', 'layout_reason'].map(k => str(c[k])).join('\n');
  const thinIds = new Set(arr(thin).map(t => str(t.ch).toUpperCase()));
  arr(rec.downgrade).forEach(d => {
    mapNow(d, chs).forEach(id => {
      const c = chs.find(x => str(x.id).toUpperCase() === id);
      if (!c) return;
      if (HEDGE_RE.test(txt(c))) out.hedged.add(id);
      else if (thinIds.has(id)) out.unhedged.push(id);
    });
  });
  return out;
}

// 查不到、保持原样的章(开头、结尾、反转、核心):事实支撑项点到它们的问题挪进参考,不再拿去改蓝图,也不因此停下
function applyKept(rv, rec, chs) {
  if (!rec || rec.status !== 'done' || !arr(rec.kept).length) return rv;
  const kept = new Set(arr(rec.kept).flatMap(d => mapNow(d, chs)));
  if (!kept.size) return rv;
  const items = rv.items.map(it => {
    if (it.key !== 'facts') return it;
    const moved = [], left = [];
    arr(it.problems).forEach(p => {
      const ids = [...new Set([str(p.chapter).toUpperCase()].filter(Boolean).concat(chIds(p.text)))];
      if (ids.length && ids.every(x => kept.has(x)) && !/不在事实表里/.test(str(p.text))) moved.push({ ...p, hard: false, text: '(补搜查不到,按规矩保持原样)' + p.text });
      else left.push(p);
    });
    if (!moved.length) return it;
    const pass = !left.length;
    return { ...it, pass, plain: pass ? '' : it.plain, problems: left, notes: arr(it.notes).concat(moved), kept: [...kept] };
  });
  return { ...rv, pass: items.every(i => i.pass), items };
}

module.exports = { research, feedback, reviewBrief, programItems, applyKept, protectedOf, coreLocks, mapNow, verify, targetsOf, HEDGE_RE, UGC_RE, MAX_QUERIES };
