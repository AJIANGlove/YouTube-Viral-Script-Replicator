// v1.84 锁框架之前先查「反转证不证得出」(建任务前预判时做,不在写前分析、蓝图之后做,免得返工)
// 实测 빙수 那篇:框架的反转是「看着赚钱其实不赚」,写到账本才发现夏天其实挣得不少,框架已经锁了,只能硬改论点。
// 做法:预判时按题目搜一轮(和写前分析「定论点」的摸底是同一条,建任务后直接复用,不重搜),
// 一次小调用判每个框架的反转在本题能不能用一两笔账或一两条事实证明:原角度能证 / 换角度能证 / 有反证 / 资料不够。
// 只提醒不拦:有反证才明确建议换题或换框架;资料不够只提示一句。能证的角度(1–3 个)交给定论点、蓝图分章用。
const fs = require('fs');
const path = require('path');
const search = require('./search');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');
const readPrompt = f => fs.readFileSync(path.join(PROMPTS_DIR, f), 'utf-8');
const arr = v => (Array.isArray(v) ? v : []);
const str = v => String(v == null ? '' : v).trim();
const RESULTS = ['原角度能证', '换角度能证', '有反证', '资料不够'];
const MAX_ANGLES = 3;
const an = () => require('./analysis');

function parse(t) { try { return JSON.parse(t); } catch (e) { return null; } }
function fwData(asset) { const fw = parse((asset && asset.framework) || '') || {}; return fw.data || fw; }
// 框架的反转:原片观众原来以为什么、片子要证明什么
function twistOf(asset) {
  const fw = fwData(asset);
  const bs = ((fw.story_engine || {}).belief_shift) || {};
  const ce = fw.core_engine || {};
  return { name: fw.name || (asset && asset.id) || '', old_belief: str(bs.old_belief), new_belief: str(bs.new_belief), promise: str(ce.surface_promise_pattern) };
}

// 按题目搜一轮(和 thesis.scout 的「先摸底」同一条查询)
async function discover(topic, cfg) {
  if (!search.searchStatus(cfg).ready) return null;
  return search.runQueries([{ query: String(topic || '').slice(0, 100), target: '摸底' }], topic, cfg, { max: 1 });
}
function hitCount(batches) { return arr(batches).reduce((m, b) => m + arr(b.results).length, 0); }

function cleanOne(x, refs) {
  const okRefs = v => arr(v).map(String).filter(r => refs.has(r));
  let result = RESULTS.includes(str(x.result)) ? str(x.result) : '资料不够';
  const angles = arr(x.angles).filter(g => g && str(g.angle)).slice(0, MAX_ANGLES).map(g => ({ angle: str(g.angle).slice(0, 200), proves_with: str(g.proves_with).slice(0, 300), refs: okRefs(g.refs), estimate: !!g.estimate }));
  const against = x.against && typeof x.against === 'object' ? { text: str(x.against.text).slice(0, 300), refs: okRefs(x.against.refs) } : null;
  const notes = [];
  // 说能证却没有一条真出处:当资料不够(只是提示)
  if ((result === '原角度能证' || result === '换角度能证') && !angles.some(g => g.refs.length)) { notes.push('AI 说能证,但没给出搜到的出处'); result = '资料不够'; }
  // 说有反证却没给出处:不当反证(不拿没根据的话劝人换题)
  if (result === '有反证' && !(against && against.refs.length)) { notes.push('AI 说有反证,但没给出搜到的出处'); result = '资料不够'; }
  return { result, why: str(x.why).slice(0, 300), against: result === '有反证' ? against : null, angles: angles.filter(g => g.refs.length || result === '资料不够'), notes };
}

// list:[{ asset_id, asset }];返回 { [asset_id]: twist }
async function judge(run, cfg, list, batches) {
  const out = {};
  if (!arr(list).length) return out;
  if (!batches) { list.forEach(x => { out[x.asset_id] = { status: 'skipped', why: '没开联网搜索,没核对反转' }; }); return out; }
  if (!hitCount(batches)) { list.forEach(x => { out[x.asset_id] = { status: 'done', result: '资料不够', why: '按题目没搜到资料', angles: [], notes: [] }; }); return out; }
  const ids = {};
  const fwText = list.map((x, i) => {
    const id = 'K' + (i + 1); ids[id] = x.asset_id;
    const t = twistOf(x.asset);
    return '- ' + id + ' 「' + t.name + '」:观众原来以为「' + (t.old_belief || '(未记录)') + '」→ 片子要证明「' + (t.new_belief || t.promise || '(未记录)') + '」';
  }).join('\n');
  const aud = run.audience || {};
  const prompt = an().fillVars(readPrompt('twist_check.md'), {
    topic: run.topic || '', target_language: aud.target_language || '', target_country: aud.target_country || '',
    materials: str(run.materials).slice(0, 2500) || '(没有)', results: search.resultsBrief(batches), frameworks: fwText
  });
  const o = await an().callJson(run, cfg, prompt, '反转核对', v => v && Array.isArray(v.frameworks));
  const refs = new Set(arr(batches).flatMap(b => arr(b.results).map(r => r.ref)));
  arr(o.frameworks).forEach(x => { const aid = x && ids[str(x.id)]; if (aid && !out[aid]) out[aid] = { status: 'done', ...cleanOne(x, refs) }; });
  list.forEach(x => { if (!out[x.asset_id]) out[x.asset_id] = { status: 'failed', why: 'AI 没给这个框架的结论' }; });
  // 出处换成链接(页面显示)
  Object.values(out).forEach(t => {
    arr(t.angles).forEach(g => { g.sources = search.resolveEvidence(g.refs, batches).map(r => ({ ref: r.ref, title: r.title, url: r.url, site: r.site })); });
    if (t.against) t.against.sources = search.resolveEvidence(t.against.refs, batches).map(r => ({ ref: r.ref, title: r.title, url: r.url, site: r.site }));
  });
  return out;
}
async function judgeSafe(run, cfg, list, batches) {
  try { return await judge(run, cfg, list, batches); }
  catch (e) { const out = {}; arr(list).forEach(x => { out[x.asset_id] = { status: 'failed', why: '反转核对没成功:' + e.message }; }); return out; }
}

// 建任务后:这个任务用的框架在预判时核对过的反转(写前分析把 carry 放在 run.fit_quick)
function twistForRun(run) {
  const fq = run && run.fit_quick;
  const t = fq && fq.asset_id === run.asset_id ? fq.twist : null;
  return t && t.status === 'done' ? t : null;
}
// 定论点「先摸底」用:预判时搜过的同一题目的结果,直接复用
function reuseDiscovery(run) {
  const p = run && run.precheck_search;
  if (!p || str(p.topic) !== str(run.topic) || !Array.isArray(p.batches)) return null;
  return JSON.parse(JSON.stringify(p.batches));
}
function anglesText(t) {
  return arr(t.angles).map((g, i) => '  ' + (i + 1) + '. ' + g.angle + (g.proves_with ? '(怎么证:' + g.proves_with + (g.estimate ? ',估算' : '') + ')' : '') + (arr(g.sources).length ? ' | ' + g.sources.map(s => s.url).join(' ; ') : '')).join('\n');
}
// 写进定论点(thesis_angles)提示词的「先摸底」后面
function scoutHint(t) {
  if (!t) return '';
  const head = '【建任务时核对过:这个框架的反转在本题' + t.result + '】' + (t.why ? t.why : '');
  if (t.result === '有反证') return head + '\n反证:' + ((t.against || {}).text || '') + '\n出角度时要正面处理这条反证,不要假装没看见。';
  if (!arr(t.angles).length) return head;
  return head + '\n能证明的角度(出角度时优先用这几个,查询词照着它们的资料出;不同角度要各不相同):\n' + anglesText(t);
}
// 写前分析摘要(蓝图、写稿都读):每章换一个角度推进,不要把同一笔账拆成两章讲
function briefText(run) {
  const t = twistForRun(run);
  if (!t || !arr(t.angles).length || !/能证/.test(t.result)) return '';
  return '可用角度(建任务时核对过,都能证明这个框架的反转;蓝图分章时不同的章用不同的角度推进,不要把同一笔账拆成两章讲):\n' + anglesText(t);
}

module.exports = { twistOf, discover, judge, judgeSafe, cleanOne, twistForRun, reuseDiscovery, scoutHint, briefText, RESULTS };
