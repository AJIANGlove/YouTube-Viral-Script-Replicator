// v1.73 蓝图按功能重排 + 蓝图审
// 现状(仓库 101 份蓝图):87 份章数 = 原片段数、0 份调过顺序、90 份每章 function 照抄原片功能码;
// 「框架硬套」的扣分 34/39 落在「不可删」的段上(80% 的段因为含一个高峰或悬念就整段不可删)。
// 这里改成两步:先给原片每一段写一行「功能表」(抽象功能、必须保留什么、可以换什么、四选一的处理方式),
// 再按功能表给新题目排章——锁定项(开头钩子、每个高峰、每对悬念的开和收、结尾回扣)必须有去处,其余可以合并、删、调序。
// 蓝图写完先过「蓝图审」(程序检查 + 一次 AI 审,6 项),不过就让 AI 按意见改,最多 2 次;还不过就停下给人三个选择。
// 设置里可以切回「严格照原片」(旧方式):走原来的 step1.md 和 v1.69 的残留重写,不做功能表、不做蓝图审,和 v1.72 一样。
const fs = require('fs');
const path = require('path');
const store = require('./store');
const checks = require('./checks');
const retention = require('./retention');
const consistency = require('./consistency');

const pl = () => require('./pipeline');
const an = () => require('./analysis');
const rs = () => require('./bpresearch'); // v1.82 事实支撑不过时先补搜
const arr = v => (Array.isArray(v) ? v : []);
const str = v => (v == null ? '' : String(v));
const parse = t => { try { return typeof t === 'string' ? JSON.parse(t) : (t || null); } catch (e) { return null; } };
const dataOf = j => (j && j.data) || j || {};
const PROMPTS = path.join(__dirname, '..', 'prompts');
const readPrompt = f => fs.readFileSync(path.join(PROMPTS, f), 'utf-8');
const cut = (v, n) => { const t = str(v).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

// ---------- 设置:蓝图方式 ----------
const MODES = { function: '按功能重排', strict: '严格照原片' };
const MODE_DEFAULT = 'function';
function settingMode() {
  const c = pl().loadConfig() || {};
  return MODES[c.blueprint_mode] ? c.blueprint_mode : MODE_DEFAULT;
}
function setSettingMode(v) {
  if (!MODES[v]) throw Object.assign(new Error('蓝图方式只能是 function(按功能重排)或 strict(严格照原片)'), { status: 400 });
  const c = pl().loadConfig();
  if (!c) throw Object.assign(new Error('还没有配置文件,先在「主流程 API 配置」里保存一次'), { status: 400 });
  c.blueprint_mode = v;
  pl().saveConfig(c);
  return { ok: true, mode: v, label: MODES[v] };
}
// 删掉的原片段合计最多占原片时长的百分之几(v1.74,用户定 15%,设置里可改 0–50)
const DELETE_MAX_DEFAULT = 15;
function deleteMax() {
  const c = pl().loadConfig() || {};
  const n = Number(c.blueprint_delete_max);
  return c.blueprint_delete_max != null && c.blueprint_delete_max !== '' && Number.isFinite(n) && n >= 0 && n <= 50 ? n : DELETE_MAX_DEFAULT;
}
function setDeleteMax(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 50 || Math.round(n) !== n) throw Object.assign(new Error('删除上限要填 0–50 的整数(百分比)'), { status: 400 });
  const c = pl().loadConfig();
  if (!c) throw Object.assign(new Error('还没有配置文件,先在「主流程 API 配置」里保存一次'), { status: 400 });
  c.blueprint_delete_max = n;
  pl().saveConfig(c);
  return { ok: true, delete_max: n };
}
// 这次蓝图用哪种方式:新方式要有确认过的写前分析(功能表和蓝图审都要用事实表、论点卡);没有就走旧方式,记下原因
function decideMode(run) {
  const want = settingMode();
  if (want === 'function' && !run.analysis_confirmed) return { mode: 'strict', want, why: '没有确认过的写前分析,按严格照原片画' };
  return { mode: want, want, why: '' };
}
// 已经画好的蓝图按当时的方式算(旧任务没记过的都是严格照原片)
function modeOf(run) { return run && run.blueprint_mode === 'function' ? 'function' : 'strict'; }

// ---------- 原片段、锁定项、重复单元 ----------
function segmentsOf(asset) {
  const fw = dataOf(parse(asset.framework));
  const tl = dataOf(parse(asset.timeline));
  const pattern = arr(tl.normalized_pattern).slice().sort((a, b) => (a.start_ratio || 0) - (b.start_ratio || 0));
  const obs = {};
  arr(tl.observed_segments).forEach(o => { if (o && o.stage_id) obs[o.stage_id] = o; });
  const cards = {};
  retention.cardsForAsset(asset).forEach(c => { cards[c.stage_id] = c; });
  const dur = ((tl.duration_profile || {}).observed_duration_ms || 0) / 1000;
  return arr(fw.structure_pattern).map((s, i) => {
    const p = pattern.find(x => x.stage_id === s.stage_id) || pattern[i] || {};
    const o = obs[s.stage_id] || {};
    const c = cards[s.stage_id] || {};
    return {
      id: s.stage_id, order: i + 1, function: str(s.function), purpose: str(s.purpose),
      start: p.start_ratio != null ? p.start_ratio : (o.start_ratio || 0), end: p.end_ratio != null ? p.end_ratio : (o.end_ratio || 0),
      dur,
      required_payload: arr(s.required_payload).map(String),
      triggers: [...new Set(arr(o.retention_triggers).concat(arr(p.required_retention_events)).map(String).filter(Boolean))],
      original_moves: arr(c.original_moves).map(String),
      abstract_move: str(c.abstract_move), replacement_needs: arr(c.replacement_needs).map(String),
      deletability: str(c.deletability), peaks: arr(c.peaks), loops_opened: arr(c.loops_opened), loops_closed: arr(c.loops_closed)
    };
  });
}
const segOfRatio = (segs, r) => (segs.find(s => r >= s.start && r < s.end) || segs[segs.length - 1] || {}).id || '';
const fmtSec = s => Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');

// 锁定项:开头钩子、每个高峰(写前分析标了「缺口-接受弱化」的除外)、每对悬念的开和收、结尾回扣
function locksOf(run, asset, segs) {
  segs = segs || segmentsOf(asset);
  const tl = dataOf(parse(asset.timeline));
  const dur = ((tl.duration_profile || {}).observed_duration_ms || 0);
  const ratio = ms => (dur && ms != null ? ms / dur : null);
  const accepted = new Set(an().acceptedGaps(run.analysis));
  const out = [];
  if (segs.length) out.push({ id: 'HOOK', kind: 'hook', label: '开头钩子', segment: segs[0].id, ratio: 0 });
  arr(tl.peak_points).forEach(p => {
    if (!p || !p.peak_id || accepted.has(p.peak_id)) return;
    const r = p.position_ratio != null ? p.position_ratio : ratio(p.time_ms);
    out.push({ id: p.peak_id, kind: 'peak', label: '高峰 ' + p.peak_id + (p.peak_type ? '(' + p.peak_type + (p.strength ? ',强度 ' + p.strength : '') + ')' : ''), segment: segOfRatio(segs, r || 0), ratio: r });
  });
  arr(tl.open_loops).forEach(l => {
    if (!l || !l.loop_id) return;
    const ro = ratio(l.open_ms);
    out.push({ id: l.loop_id + '-open', kind: 'loop_open', loop: l.loop_id, label: '悬念 ' + l.loop_id + ' 开', segment: segOfRatio(segs, ro || 0), ratio: ro });
    if (l.close_ms != null) {
      const rc = ratio(l.close_ms);
      out.push({ id: l.loop_id + '-close', kind: 'loop_close', loop: l.loop_id, label: '悬念 ' + l.loop_id + ' 收', segment: segOfRatio(segs, rc || 0), ratio: rc });
    }
  });
  if (segs.length) out.push({ id: 'ENDING', kind: 'ending', label: '结尾回扣', segment: segs[segs.length - 1].id, ratio: 1 });
  return out;
}

// 重复单元:同一功能(功能码前两个词相同)的段有 4 段以上,或者写前分析判的叙事方式是第二人称逐级(climb / per_level)
function ladderOf(run, segs) {
  const key = f => { const p = str(f).toLowerCase().split('_').filter(Boolean); return p.length >= 2 ? p[0] + '_' + p[1] : p[0] || ''; };
  const groups = {};
  segs.forEach(s => { const k = key(s.function); if (k) (groups[k] = groups[k] || []).push(s.id); });
  const top = Object.entries(groups).sort((a, b) => b[1].length - a[1].length)[0];
  const pov = consistency.povModeOf((run || {}).analysis);
  const repeated = top && top[1].length >= 4 ? { key: top[0], segments: top[1] } : null;
  const on = !!repeated || pov === 'climb' || pov === 'per_level';
  return { on, repeated, pov_mode: pov, why: [repeated ? '原片有 ' + repeated.segments.length + ' 段是同一种功能(' + repeated.key + ':' + repeated.segments.join('、') + ')' : '', pov === 'climb' || pov === 'per_level' ? '写前分析判的叙事方式是「' + consistency.POV_MODES[pov] + '」' : ''].filter(Boolean).join(';') };
}

// ---------- 功能表 ----------
const TREATMENTS = ['保留功能换内容', '合并到相邻章', '新题目没有这块可删', '必须是新题目自己的'];
function normTreatment(t) {
  const s = str(t);
  if (/自己的|新题目.*反转|必须是新/.test(s)) return TREATMENTS[3];
  if (/可删|删除|删掉|没有这块/.test(s)) return TREATMENTS[2];
  if (/合并|并入/.test(s)) return TREATMENTS[1];
  if (/保留|换内容|保功能/.test(s)) return TREATMENTS[0];
  return '';
}
const REVERSAL_RE = /revers|twist|invert|inversion|flip|subvert|turning_?point|反转|翻转|推翻/i;

function segmentTable(run, segs, locks) {
  const mods = {};
  arr((run.analysis || {}).modules).forEach(m => { if (m && m.segment) mods[m.segment] = m; });
  const pct = x => Math.round((x || 0) * 100) + '%';
  return segs.map(s => {
    const lk = locks.filter(l => l.segment === s.id);
    const m = mods[s.id];
    return '- ' + s.id + ' | 位置 ' + pct(s.start) + '–' + pct(s.end) + (s.dur ? '(原片 ' + fmtSec(s.start * s.dur) + '–' + fmtSec(s.end * s.dur) + ')' : '') + ' | 占原片 ' + pct(s.end - s.start) +
      ' | 原功能码 ' + s.function +
      ' | 这段在原片里干什么(抽象说法):' + cut(s.abstract_move || s.purpose, 220) +
      (s.replacement_needs.length ? ' | 换内容时需要:' + cut(s.replacement_needs.join(';'), 200) : '') +
      ' | 锁定项:' + (lk.length ? lk.map(l => l.id).join('、') : '无') +
      ' | 可删性:' + (s.deletability || '—') +
      (m ? ' | 写前分析的决定:' + str(m.decision) + (m.reason ? '(' + cut(m.reason, 160) + ')' : '') : '') +
      (plannedFacts(run, s.id).length ? ' | 写前分析给这段备的事实:' + plannedFacts(run, s.id).join('、') : '');
  }).join('\n');
}

// 原片的具体内容:对照表里的原片说法(残留词)+ 这一段原片做法里的数字。功能表和蓝图都不能写
const NUM_RE = /\d[\d,.]*(?:\s*[-–~]\s*\d[\d,.]*)?\s*(?:%|％|倍|镑|亩|英亩|便士|先令|美元|美金|dollars?|pounds?|년|원|만|억|万|亿|岁|살|명|人|年|分钟|秒)/gi;
function sourceTerms(run, seg) {
  const words = consistency.residueTerms(run).map(t => t.word).filter(Boolean);
  const nums = [];
  if (seg) seg.original_moves.concat(seg.required_payload).forEach(t => { (str(t).match(NUM_RE) || []).forEach(n => { if (/\d{2,}|\d.*\D{1,3}$/.test(n)) nums.push(n.replace(/\s+/g, '')); }); });
  return { words: [...new Set(words)], nums: [...new Set(nums)] };
}
function sourceHits(text, terms) {
  const t = str(text), flat = t.replace(/\s+/g, '');
  const hits = [];
  terms.words.forEach(w => { try { if (new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(t)) hits.push(w); } catch (e) {} });
  terms.nums.forEach(n => { if (flat.includes(n)) hits.push(n); });
  return [...new Set(hits)];
}

function parseTable(text) {
  const j = checks.extractJsonObject(checks.stripFence(str(text))) || parse(checks.stripFence(str(text)));
  if (!j || !Array.isArray(j.rows)) return null;
  return j;
}

// 程序把关:每段都有一行;锁定段不能「可删」;反转段一律「必须是新题目自己的」;处理方式只认四种
function normalizeTable(run, j, segs, locks) {
  const bySeg = {};
  arr(j.rows).forEach(r => { if (r && r.segment) bySeg[str(r.segment).trim().toUpperCase()] = r; });
  const fixes = [];
  const rows = segs.map(s => {
    const r = bySeg[s.id] || null;
    const lk = locks.filter(l => l.segment === s.id).map(l => l.id);
    const row = {
      segment: s.id, position: [s.start, s.end], source_function: s.function,
      function: str(r && r.function).trim(), keep: str(r && r.keep).trim(), swap: str(r && r.swap).trim(),
      treatment: normTreatment(r && r.treatment), merge_into: str(r && r.merge_into).trim(), reason: str(r && r.reason).trim(),
      is_reversal: !!(r && r.is_reversal), fact_ids: arr(r && r.fact_ids).map(String), checked_facts: arr(r && r.checked_facts).map(String), locks: lk, notes: []
    };
    if (!r) { row.treatment = TREATMENTS[0]; row.notes.push('AI 没写这一段,程序按「保留功能换内容」补上'); fixes.push(s.id + ' 缺行'); }
    if (!row.treatment) { row.treatment = TREATMENTS[0]; row.notes.push('处理方式写的不是四种之一,程序改成「保留功能换内容」'); }
    if ((row.is_reversal || REVERSAL_RE.test(s.function)) && row.treatment !== TREATMENTS[3]) {
      row.notes.push('这段是反转,程序改成「必须是新题目自己的」(原来是「' + row.treatment + '」)');
      row.treatment = TREATMENTS[3]; row.is_reversal = true;
    }
    if (lk.length && row.treatment === TREATMENTS[2]) {
      row.notes.push('含锁定项 ' + lk.join('、') + ',不能删,程序改成「保留功能换内容」');
      row.treatment = TREATMENTS[0];
      fixes.push(s.id + ' 锁定段不能删');
    }
    if (row.treatment === TREATMENTS[1] && !row.merge_into) row.merge_into = (segs[s.order] || segs[s.order - 2] || {}).id || '';
    return row;
  });
  return { rows, fixes, reversal: j.reversal && typeof j.reversal === 'object' ? j.reversal : null };
}

function tableSourceHits(run, rows, segs) {
  const out = [];
  rows.forEach(r => {
    const seg = segs.find(s => s.id === r.segment);
    const hits = sourceHits([r.function, r.keep, r.swap, r.reason].join(' '), sourceTerms(run, seg));
    if (hits.length) out.push({ segment: r.segment, words: hits });
  });
  return out;
}

// ---------- 删除限制(v1.74) ----------
// 优先顺序:保留功能换内容 > 合并到相邻章 > 删。删要有事实凭据;写前分析或功能表给这段备了事实的不准删;
// 删掉的段合计不超过原片时长的 deleteMax()%(默认 15%)。
const BAD_DELETE = /不好写|难写|不好讲|难讲|写不好|不适合|太复杂|没意思|不重要|可有可无|不必要|没必要|太长|冗长|拖沓|不好看|观众不感兴趣/;
const EVIDENCE = /事实表|事实|F\d{2}|账本|L\d+|没查到|查不到|没有记录|没有资料|素材/;
const segShare = s => Math.max(0, (s.end || 0) - (s.start || 0));
// 写前分析给这一段备的事实(模块取舍的 fact_ids、留存地图承担这段高峰的 fact_ids)
function plannedFacts(run, segId) {
  const a = (run || {}).analysis || {};
  const m = arr(a.modules).find(x => x && x.segment === segId);
  const out = [];
  if (m && !/删除/.test(str(m.decision))) out.push(...arr(m.fact_ids).map(String));
  arr(a.retention_map).forEach(x => { if (x && x.source_segment === segId && /承担/.test(str(x.status))) out.push(...arr(x.fact_ids).map(String)); });
  return [...new Set(out)].filter(Boolean);
}
function deletionCheck(run, rows, segs) {
  const max = deleteMax();
  const byId = {};
  segs.forEach(s => { byId[s.id] = s; });
  const del = rows.filter(r => r.treatment === TREATMENTS[2]);
  const issues = [];
  del.forEach(r => {
    const reason = str(r.reason);
    const planned = plannedFacts(run, r.segment);
    if (BAD_DELETE.test(reason)) issues.push({ segment: r.segment, kind: 'bad_reason', text: r.segment + ' 的删除理由「' + cut(reason, 60) + '」不算:「不好写」「不适合」「太复杂」这类理由一律不算,删除要跟事实挂钩' });
    else if (!EVIDENCE.test(reason) || !r.checked_facts.length) issues.push({ segment: r.segment, kind: 'no_evidence', text: r.segment + ' 的删除理由没有跟事实挂钩:要在 checked_facts 写查过哪些事实,在 reason 里写事实表为什么没有能完成这段作用的素材' });
    if (r.fact_ids.length) issues.push({ segment: r.segment, kind: 'has_facts', text: r.segment + ' 自己写了要用的事实 ' + r.fact_ids.join('、') + ',有素材就不能删,改成「保留功能换内容」' });
    else if (planned.length) issues.push({ segment: r.segment, kind: 'has_facts', text: r.segment + ' 写前分析给这段备了事实 ' + planned.join('、') + ',有素材就不能删,改成「保留功能换内容」' });
  });
  const ratio = del.reduce((n, r) => n + segShare(byId[r.segment] || {}), 0);
  if (ratio * 100 > max + 1e-9) issues.push({ segment: '', kind: 'over_cap', text: '删掉的段合计占原片 ' + Math.round(ratio * 100) + '%,超过上限 ' + max + '%;先考虑「保留功能换内容」,其次「合并到相邻章」' });
  return { issues, ratio, max };
}
// 程序兜底:理由不成立、有素材的删除改回「保留功能换内容」;还超上限的,从占比最大的开始改成「合并到相邻章」
function enforceDeletions(run, rows, segs) {
  const chk = deletionCheck(run, rows, segs);
  const fixes = [];
  const bad = new Set(chk.issues.filter(x => x.segment).map(x => x.segment));
  rows.forEach(r => {
    if (r.treatment === TREATMENTS[2] && bad.has(r.segment)) {
      const why = chk.issues.filter(x => x.segment === r.segment).map(x => x.kind === 'bad_reason' ? '理由不算' : x.kind === 'no_evidence' ? '理由没跟事实挂钩' : '有素材').join('、');
      r.notes.push('删除不成立(' + why + '),程序改成「保留功能换内容」');
      r.treatment = TREATMENTS[0];
      fixes.push(r.segment + ' 删除不成立(' + why + ')');
    }
  });
  const max = deleteMax();
  const byId = {};
  segs.forEach(s => { byId[s.id] = s; });
  let ratio = rows.filter(r => r.treatment === TREATMENTS[2]).reduce((n, r) => n + segShare(byId[r.segment] || {}), 0);
  rows.filter(r => r.treatment === TREATMENTS[2]).sort((a, b) => segShare(byId[b.segment] || {}) - segShare(byId[a.segment] || {})).forEach(r => {
    if (ratio * 100 <= max + 1e-9) return;
    ratio -= segShare(byId[r.segment] || {});
    const s = byId[r.segment] || {};
    r.treatment = TREATMENTS[1];
    r.merge_into = r.merge_into || (segs[s.order] || segs[s.order - 2] || {}).id || '';
    r.notes.push('删掉的段合计超过上限 ' + max + '%,程序把这段改成「合并到相邻章」(并到 ' + r.merge_into + ')');
    fixes.push(r.segment + ' 超上限改成合并');
  });
  return { fixes, ...deletedOf(rows, segs) };
}
function deletedOf(rows, segs) {
  const byId = {};
  segs.forEach(s => { byId[s.id] = s; });
  const deleted = rows.filter(r => r.treatment === TREATMENTS[2]).map(r => { const s = byId[r.segment] || {}; return { segment: r.segment, ratio: Math.round(segShare(s) * 1000) / 1000, secs: Math.round(segShare(s) * (s.dur || 0)), reason: r.reason, checked_facts: r.checked_facts }; });
  return { deleted, deleted_ratio: Math.round(deleted.reduce((n, d) => n + d.ratio, 0) * 1000) / 1000 };
}

function fillTablePrompt(run, asset, segs, locks, ladder) {
  const a = run.analysis || {};
  const th = a.thesis_card || {};
  const facts = arr(a.facts).map(f => '- ' + f.id + ' [' + str(f.kind) + '] ' + cut(f.content, 160)).join('\n');
  return readPrompt('function_table.md')
    .replaceAll('{{topic}}', run.topic || '')
    .replaceAll('{{title}}', str((a.title || {}).final_title) || run.topic || '')
    .replaceAll('{{thesis}}', ['原有认知=' + str(th.viewer_belief), '真相=' + str(th.truth), '一句话论点=' + str(th.one_line_thesis), '结尾落点=' + str(th.ending_landing)].join(';'))
    .replaceAll('{{protagonist}}', cut([(a.protagonist || {}).who, (a.protagonist || {}).era, (a.protagonist || {}).place].filter(Boolean).join(' / '), 400) || '(没写)')
    .replaceAll('{{pov_mode}}', ladder.pov_mode ? consistency.POV_MODES[ladder.pov_mode] : '(没判)')
    .replaceAll('{{ladder}}', ladder.on ? '是。' + ladder.why : '不是')
    .replaceAll('{{segments}}', segmentTable(run, segs, locks))
    .replaceAll('{{locks}}', locks.map(l => '- ' + l.id + ' ' + l.label + '(原片 ' + Math.round((l.ratio || 0) * 100) + '% 处,在 ' + l.segment + ')').join('\n'))
    .replaceAll('{{thesis_check}}', arr((a.thesis_check || {}).contradicts).length ? '写前分析的反转验证:事实 ' + a.thesis_check.contradicts.join('、') + ' 和反转结论相反(' + str(a.thesis_check.note) + ')' : '(没有)')
    .replaceAll('{{facts}}', facts || '(没有)')
    .replaceAll('{{delete_max}}', String(deleteMax()));
}

// 功能表(新的一次 AI 调用):同一份写前分析、同一个框架做过就复用
async function ensureTable(run, asset, callLlm) {
  const analysisAt = str(((run.steps || {}).analysis || {}).finished_at) + '|' + str(run.analysis_confirmed_at) + '|del' + deleteMax();
  const ft = run.function_table;
  if (ft && ft.asset_id === run.asset_id && ft.for_analysis === analysisAt && arr(ft.rows).length) return ft;
  const segs = segmentsOf(asset);
  const locks = locksOf(run, asset, segs);
  const ladder = ladderOf(run, segs);
  const prompt = fillTablePrompt(run, asset, segs, locks, ladder);
  const t0 = Date.now();
  run.steps = { ...(run.steps || {}), function_table: { status: 'running', started_at: new Date().toISOString() } };
  store.saveRun(run);
  let messages = [{ role: 'user', content: prompt }];
  let r = await callLlm(messages, 'Step 1 功能表');
  let j = parseTable(r.content);
  if (!j) {
    messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: '上一次输出不是合法 JSON。请严格只输出 {"rows":[...],"reversal":{...}} 这个 JSON 对象,不要代码围栏和解释。' }];
    r = await callLlm(messages, 'Step 1 功能表 JSON 重试');
    j = parseTable(r.content);
  }
  if (!j) throw new Error('功能表输出不是合法 JSON(重试一次后仍然不是)');
  let norm = normalizeTable(run, j, segs, locks);
  let hits = tableSourceHits(run, norm.rows, segs);
  let retried = false;
  if (hits.length) {
    // 写了原片的具体内容(原片说法、原片的数):反馈改一次,改完命中更少才用
    const fb = '功能表里写了原片的具体内容,要改成抽象说法(只写这一段的作用,不写原片讲了什么):\n' + hits.map(h => '- ' + h.segment + ':' + h.words.map(w => '「' + w + '」').join('')).join('\n') + '\n其余不变,重新输出完整 JSON。';
    messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: fb }];
    const r2 = await callLlm(messages, 'Step 1 功能表 去原片内容');
    const j2 = parseTable(r2.content);
    retried = true;
    if (j2) {
      const n2 = normalizeTable(run, j2, segs, locks);
      const h2 = tableSourceHits(run, n2.rows, segs);
      if (h2.length < hits.length) { norm = n2; hits = h2; r = r2; }
    }
  }
  // 删除限制(v1.74):理由不成立、有素材、超上限的,先退回让 AI 重排一次;改完问题更少才用,剩下的程序兜底
  let dchk = deletionCheck(run, norm.rows, segs);
  const delIssues = dchk.issues.slice();
  let delRetried = false;
  if (dchk.issues.length) {
    const fb = '功能表的「删掉」不成立,按下面改。处理方式固定按「保留功能换内容 > 合并到相邻章 > 删掉」的顺序选,删掉是最后的选择;删掉要跟事实挂钩(checked_facts 写查过哪些事实),有素材的段不准删;删掉的段合计不超过原片时长的 ' + deleteMax() + '%:\n' + dchk.issues.map(x => '- ' + x.text).join('\n') + '\n其余不变,重新输出完整 JSON。';
    messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: fb }];
    const r3 = await callLlm(messages, 'Step 1 功能表 删除不成立');
    const j3 = parseTable(r3.content);
    delRetried = true;
    if (j3) {
      const n3 = normalizeTable(run, j3, segs, locks);
      const d3 = deletionCheck(run, n3.rows, segs);
      if (d3.issues.length < dchk.issues.length && tableSourceHits(run, n3.rows, segs).length <= hits.length) { norm = n3; dchk = d3; r = r3; hits = tableSourceHits(run, n3.rows, segs); }
    }
  }
  const enf = enforceDeletions(run, norm.rows, segs);
  const out = {
    at: new Date().toISOString(), asset_id: run.asset_id, for_analysis: analysisAt, secs: Math.round((Date.now() - t0) / 100) / 10,
    rows: norm.rows, reversal: norm.reversal, fixes: norm.fixes.concat(enf.fixes), source_hits: hits, source_retried: retried,
    delete_max: deleteMax(), delete_issues: delIssues, delete_retried: delRetried, deleted: enf.deleted, deleted_ratio: enf.deleted_ratio,
    locks, ladder: { on: ladder.on, why: ladder.why, segments: ladder.repeated ? ladder.repeated.segments : [], pov_mode: ladder.pov_mode }
  };
  run.function_table = out;
  run.steps.function_table = { status: 'done', secs: out.secs, finished_at: out.at };
  store.saveRun(run);
  return out;
}

// 给蓝图(step1_function.md)看的功能表
function tableBrief(ft) {
  const rows = arr(ft.rows).map(r => '- ' + r.segment + '(原片 ' + Math.round(r.position[0] * 100) + '%–' + Math.round(r.position[1] * 100) + '%)| 作用:' + r.function + ' | 必须保留:' + r.keep + ' | 可以换:' + r.swap +
    ' | 处理:' + r.treatment + (r.treatment === TREATMENTS[1] && r.merge_into ? '(并到 ' + r.merge_into + ')' : '') + (r.treatment === TREATMENTS[2] ? '(占原片 ' + Math.round((r.position[1] - r.position[0]) * 100) + '%)' : '') + (r.locks.length ? ' | 锁定项:' + r.locks.join('、') : '') + (r.reason ? ' | 理由:' + r.reason : '')).join('\n');
  const rv = ft.reversal || {};
  const dels = arr(ft.rows).filter(r => r.treatment === TREATMENTS[2]);
  const delLine = dels.length ? '\n删掉的段:' + dels.map(r => r.segment).join('、') + ',合计占原片 ' + Math.round(dels.reduce((n, r) => n + (r.position[1] - r.position[0]), 0) * 100) + '%(上限 ' + (ft.delete_max != null ? ft.delete_max : deleteMax()) + '%)。这些段的时间分给其他章(讲得更细、多用事实),全片总时长不变;功能表没判删的段,每一段都要写进某一章的 source_segments(合并的写进并入的那一章)。' : '\n功能表没有删掉的段:每一段都要写进某一章的 source_segments(合并的写进并入的那一章)。';
  return rows + delLine + (str(rv.new_reversal).trim() ? '\n新题目自己的反转:' + rv.new_reversal + (arr(rv.fact_ids).length ? '(' + rv.fact_ids.join(',') + ')' : '') : '');
}
function locksBrief(ft) {
  return arr(ft.locks).map(l => '- ' + l.id + ':' + l.label + ',原片在全片 ' + Math.round((l.ratio || 0) * 100) + '% 处(' + l.segment + ')').join('\n');
}
function ladderBrief(ft) {
  if (!(ft.ladder || {}).on) return '(这个框架不是等级 / 重复单元框架,level_focus、level_new_info 填空字符串)';
  return '这个框架是等级 / 重复单元框架(' + ft.ladder.why + ')。每一级(每一个重复单元)的章节都要写:\n' +
    '· level_focus:这一级重点讲什么,只能挑一个,例如「收入」「代价」「规则」「反转」「人际」「风险」「转折事件」;相邻两级不能一样,程序会查;\n' +
    '· level_new_info:这一级独有的新信息(用哪条事实、观众第一次知道什么),不能是上一级讲过的换个说法;\n' +
    '· 不要每一级都走一遍同一个模板(例如每级都是「身份—收入—代价—信条」),原片的每级模板只当参考。';
}
// 框架和时间线只给抽象部分:不给每段的 required_payload、原片做法、高峰的原片理由(实测蓝图会把它们逐条翻成韩文照写)
function frameworkCore(asset) {
  const d = dataOf(parse(asset.framework));
  const keep = ['name', 'description', 'content_profile', 'core_engine', 'audience_psychology', 'title_hook_contract', 'story_engine', 'retention_system', 'emotion_curve', 'transferability', 'migration_rules'];
  const o = {};
  keep.forEach(k => { if (d[k] != null) o[k] = d[k]; });
  return JSON.stringify(o, null, 1);
}
function timelineCore(asset) {
  const d = dataOf(parse(asset.timeline));
  const hw = { ...(d.hook_window || {}) }; delete hw.evidence_refs;
  return JSON.stringify({
    duration_profile: d.duration_profile, hook_window: hw,
    normalized_pattern: arr(d.normalized_pattern).map(p => ({ stage_id: p.stage_id, start_ratio: p.start_ratio, end_ratio: p.end_ratio, function: p.function })),
    peak_points: arr(d.peak_points).map(p => ({ peak_id: p.peak_id, position_ratio: p.position_ratio, peak_type: p.peak_type, strength: p.strength })),
    open_loops: arr(d.open_loops).map(l => ({ loop_id: l.loop_id, open_ms: l.open_ms, close_ms: l.close_ms, payoff_type: l.payoff_type, status: l.status }))
  }, null, 1);
}
// 新方式的 step1 提示词:先填本模块的占位,其余({{analysis}} {{topic}} 等)交给 pipeline.fillTemplate
function step1Template(run, asset, ft) {
  return readPrompt('step1_function.md')
    .replaceAll('{{function_table}}', tableBrief(ft))
    .replaceAll('{{locks}}', locksBrief(ft))
    .replaceAll('{{ladder_rules}}', ladderBrief(ft))
    .replaceAll('{{framework_core}}', frameworkCore(asset))
    .replaceAll('{{timeline_core}}', timelineCore(asset));
}

// ---------- 程序检查(蓝图审的程序部分) ----------
const bpOf = text => { try { return JSON.parse(checks.stripFence(str(text))) || {}; } catch (e) { return checks.extractJsonObject(str(text)) || {}; } };
const chText = c => ['function', 'purpose', 'information_goal', 'emotion_goal', 'retention_goal', 'treatment', 'new_lens', 'answers_prev', 'leaves_question', 'level_focus', 'level_new_info', 'layout_reason'].map(k => str(c[k])).join('\n');
function bigr(s) { const t = str(s).replace(/[\s\p{P}\p{S}_]+/gu, ''); const o = new Set(); for (let i = 0; i < t.length - 1; i++) o.add(t.slice(i, i + 2)); return o; }
function jaccard(a, b) { const A = bigr(a), B = bigr(b); if (!A.size || !B.size) return 0; let n = 0; A.forEach(x => { if (B.has(x)) n++; }); return n / (A.size + B.size - n); }
const SIM_SOFT = 0.3, SIM_HARD = 0.45; // 仓库 1293 对相邻章:中位数 0.04,95% 分位 0.14,超过 0.3 的 50 对几乎都是整篇照模板复制
const normLock = s => str(s).toUpperCase().replace(/\s+/g, '').replace(/[_:：]/g, '-').replace(/-?(OPEN|开)$/, '-open').replace(/-?(CLOSE|收|合)$/, '-close').replace(/-open$/i, '-open').replace(/-close$/i, '-close');
const range = c => { const m = str(c.time_range).match(/(\d+:\d+(?::\d+)?)\s*[-–—~]\s*(\d+:\d+(?::\d+)?)/); return m ? [checks.toSec(m[1]), checks.toSec(m[2])] : null; };

function checkLocks(chs, locks) {
  const total = Math.max(0, ...chs.map(c => (range(c) || [0, 0])[1]));
  const at = {};
  chs.forEach((c, i) => {
    const ids = arr(c.locks).map(normLock).concat(arr(c.carries_peaks).map(normLock));
    const ol = c.open_loop || {};
    (str(ol.open).match(/LOOP\d+/gi) || []).forEach(x => ids.push(x.toUpperCase() + '-open'));
    (str(ol.close).match(/LOOP\d+/gi) || []).forEach(x => ids.push(x.toUpperCase() + '-close'));
    ids.forEach(id => { if (!at[id]) at[id] = { ch: c.id, i, r: range(c) }; });
  });
  const missing = [], moved = [], order = [];
  locks.forEach(l => {
    const id = normLock(l.id);
    let hit = at[id];
    if (l.kind === 'hook') hit = hit || (chs[0] ? { ch: chs[0].id, i: 0, r: range(chs[0]), implicit: true } : null);
    if (l.kind === 'ending') hit = hit || (chs.length ? { ch: chs[chs.length - 1].id, i: chs.length - 1, r: range(chs[chs.length - 1]), implicit: true } : null);
    if (!hit) { missing.push(l); return; }
    if (l.kind === 'hook' && hit.i !== 0) moved.push({ lock: l, ch: hit.ch, why: '开头钩子不在第一章' });
    if (l.kind === 'ending' && hit.i !== chs.length - 1) moved.push({ lock: l, ch: hit.ch, why: '结尾回扣不在最后一章' });
    if (hit.r && total && l.ratio != null && (l.kind === 'peak' || l.kind === 'loop_open' || l.kind === 'loop_close')) {
      const r = (hit.r[0] + hit.r[1]) / 2 / total;
      if (Math.abs(r - l.ratio) > 0.2) moved.push({ lock: l, ch: hit.ch, why: '原片在 ' + Math.round(l.ratio * 100) + '% 处,蓝图放到了 ' + Math.round(r * 100) + '% 处', soft: true });
    }
  });
  const loops = [...new Set(locks.filter(l => l.kind === 'loop_open').map(l => l.loop))];
  loops.forEach(lp => {
    const o = at[lp + '-open'], c = at[lp + '-close'];
    if (o && c && c.i < o.i) order.push({ loop: lp, open: o.ch, close: c.ch });
  });
  return { missing, moved, order };
}

function adjacentSimilar(chs) {
  const out = [];
  for (let i = 0; i + 1 < chs.length; i++) {
    const a = str(chs[i].purpose) + ' ' + str(chs[i].information_goal), b = str(chs[i + 1].purpose) + ' ' + str(chs[i + 1].information_goal);
    const j = jaccard(a, b);
    if (j > SIM_SOFT) out.push({ a: chs[i].id, b: chs[i + 1].id, sim: Math.round(j * 100) / 100, hard: j > SIM_HARD });
  }
  return out;
}

// v1.82 每章「观众第一次知道的新信息」(new_lens,一句话)两两比对:任意两章(不只相邻)写得太像就是在讲同一件事
const NEWINFO_SOFT = 0.35, NEWINFO_HARD = 0.6;
function newInfoSimilar(chs) {
  const out = [];
  for (let i = 0; i < chs.length; i++) for (let j = i + 1; j < chs.length; j++) {
    const a = str(chs[i].new_lens), b = str(chs[j].new_lens);
    if (!a.trim() || !b.trim()) continue;
    const s = jaccard(a, b);
    if (s > NEWINFO_SOFT) out.push({ a: chs[i].id, b: chs[j].id, sim: Math.round(s * 100) / 100, hard: s > NEWINFO_HARD, ta: cut(a, 50), tb: cut(b, 50) });
  }
  return out.sort((x, y) => y.sim - x.sim).slice(0, 6);
}
// v1.82 程序数出的「哪条事实在哪几章展开」(fact_ids 里的,回顾 recap_ids 不算;钩子用的事实、账本行另外标出来)
function factSpread(run, chs) {
  const hook = new Set(hookFactIds(run));
  const at = {};
  chs.forEach(c => {
    const recap = new Set(arr(c.recap_ids).map(String));
    arr(c.fact_ids).map(String).forEach(f => { if (!recap.has(f)) (at[f] = at[f] || []).push(c.id); });
  });
  return Object.keys(at).filter(f => at[f].length >= 2).sort((x, y) => at[y].length - at[x].length)
    .map(f => ({ id: f, chapters: [...new Set(at[f])], note: hook.has(f) ? '钩子用的事实,开头和回扣各一次不算重复' : /^L\d+$/i.test(f) ? '账本行,回顾不算重复' : '' }))
    .filter(x => x.chapters.length >= 2);
}
function spreadText(sp) {
  if (!sp.length) return '';
  return '\n程序数出的「哪条事实在哪几章展开」(fact_ids 里的,recap_ids 不算):\n' + sp.slice(0, 15).map(x => '- ' + x.id + ':' + x.chapters.join('、') + (x.note ? '(' + x.note + ')' : '')).join('\n') +
    '\n一条事实只在最合适的一章讲透;其他章要提就写进 recap_ids 一句带过,或者从新角度带出新信息(在 new_lens 写清新在哪)。';
}

const LEVEL_TAG = /제\s*(\d{1,2})\s*급|第\s*(\d{1,2})\s*级|level\s*(\d{1,2})/i;
const levelNo = c => { const m = str(c.purpose).match(LEVEL_TAG); return m ? Number(m[1] || m[2] || m[3]) : null; };
function checkLadder(chs, ft) {
  const lad = (ft || {}).ladder || {};
  if (!lad.on) return { on: false, same: [], empty: [] };
  const rep = new Set(arr(lad.segments));
  const lv = chs.filter(c => str(c.level_focus).trim() || levelNo(c) != null || arr(c.source_segments).some(s => rep.has(s)));
  const norm = s => str(s).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const same = [], empty = [];
  lv.forEach(c => { if (!str(c.level_focus).trim() || !str(c.level_new_info).trim()) empty.push({ ch: c.id, miss: [!str(c.level_focus).trim() ? 'level_focus' : '', !str(c.level_new_info).trim() ? 'level_new_info' : ''].filter(Boolean) }); });
  for (let i = 0; i + 1 < lv.length; i++) {
    const a = norm(lv[i].level_focus), b = norm(lv[i + 1].level_focus);
    if (a && b && (a === b || jaccard(a, b) > 0.6)) same.push({ a: lv[i].id, b: lv[i + 1].id, focus: str(lv[i].level_focus) });
  }
  return { on: true, chapters: lv.map(c => c.id), same, empty };
}

// 照搬原片小步:章节文字里出现了这一段原片的留存机制代码(英文,和语言无关),或者原片必需内容逐条出现
function checkCopy(chs, segs) {
  const out = [];
  const byId = {};
  segs.forEach(s => { byId[s.id] = s; });
  chs.forEach(c => {
    const t = chText(c), low = t.toLowerCase();
    arr(c.source_segments).forEach(sid => {
      const s = byId[sid];
      if (!s) return;
      const codes = s.triggers.filter(x => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/i.test(x));
      const hitCodes = codes.filter(x => low.includes(x.toLowerCase()));
      const hitPay = s.required_payload.filter(p => { const P = bigr(p); if (P.size < 3) return false; const T = bigr(t); let n = 0; P.forEach(x => { if (T.has(x)) n++; }); return n / P.size >= 0.6; });
      if ((hitCodes.length >= 3 && hitCodes.length >= codes.length * 0.6) || hitPay.length >= 3) {
        out.push({ ch: c.id, segment: sid, codes: hitCodes, payload: hitPay, of: codes.length || s.required_payload.length });
      }
    });
  });
  return out;
}

// 主角够不着的等级:对照表标了 reachable=false 的级,蓝图还让主角当上了(没写旁观)。
// 按等级号认(purpose 开头的「제N급」),或者这一级的原片本地说法写进了 purpose;
// 用了对照表「建议改为『…』」里的替代说法的,算按对照表改过,只交给 AI 判断事实表撑不撑得住(实测 2d20 第 7、8 级就是这样)
const WATCHER = /旁观|旁人|관찰자|구경꾼|지켜보|옆에서\s*(?:보|지켜)|남의\s*(?:이야기|삶|성공)/;
const hangulWords = t => str(t).split(/[\/(),、()·]/).map(x => x.trim()).filter(x => x.length >= 2 && /[가-힣]/.test(x));
function checkUnreachable(run, chs) {
  const ul = consistency.unreachableLevels(run.analysis);
  if (!ul.length) return [];
  const out = [];
  chs.forEach(c => {
    const n = levelNo(c);
    if (n == null) return;
    const head = str(c.purpose);
    ul.forEach(u => {
      const byNo = n === u.n;
      const byName = hangulWords(u.local).some(w => head.includes(w));
      if (!byNo && !byName) return;
      if (WATCHER.test(chText(c))) return;
      const sub = (str(u.why).match(/『([^』]+)』/) || [])[1] || '';
      const subUsed = hangulWords(sub).filter(w => w.length >= 3).some(w => chText(c).includes(w));
      out.push({ ch: c.id, n: u.n, local: u.local, why: u.why, by: byNo ? 'level' : 'name', substituted: subUsed, sub, fact_ids: arr(c.fact_ids).map(String) });
    });
  });
  return out;
}

function checkFacts(run, chs) {
  const facts = arr((run.analysis || {}).facts);
  const ids = new Set(facts.map(f => f.id).concat(arr((run.analysis || {}).ledger).map(l => l && l.id).filter(Boolean))); // 账本行(L1…)也是写前分析里的依据
  const kind = {};
  facts.forEach(f => { kind[f.id] = str(f.kind); });
  const unknown = [], thin = [], none = [];
  chs.forEach((c, i) => {
    const fs_ = arr(c.fact_ids).map(String);
    const bad = fs_.filter(x => !ids.has(x));
    if (bad.length) unknown.push({ ch: c.id, ids: bad });
    const ok = fs_.filter(x => ids.has(x));
    if (!ok.length && i > 0 && i < chs.length - 1) none.push(c.id);
    else if (ok.length && ok.every(x => /待查|记忆|假设|가정|추정/.test(kind[x]))) thin.push({ ch: c.id, ids: ok, kinds: ok.map(x => kind[x]) });
  });
  // 已经做过联网核验的(重画蓝图的老任务):核验判 C/D/E 的制度说法不能当主张用(复用 v1.69 的 weakClaimUses)
  let weak = [];
  try { weak = consistency.weakClaimUses(run, chs.map(c => ({ id: c.id, text: chText(c) }))); } catch (e) { weak = []; }
  return { unknown, thin, none, weak };
}

function checkReversal(run, chs, ft) {
  const rows = arr((ft || {}).rows).filter(r => r.treatment === TREATMENTS[3]);
  const segIds = new Set(rows.map(r => r.segment));
  const holders = chs.filter(c => arr(c.source_segments).some(s => segIds.has(s)));
  const issues = [];
  if (rows.length && !holders.length) issues.push({ hard: true, text: '功能表里的反转段(' + rows.map(r => r.segment).join('、') + ')没有落到任何一章' });
  holders.forEach(c => { if (!arr(c.fact_ids).length) issues.push({ hard: true, ch: c.id, text: c.id + ' 承担反转,但没有写任何事实编号' }); });
  const tc = (run.analysis || {}).thesis_check || {};
  if (arr(tc.contradicts).length) issues.push({ hard: false, text: '写前分析的反转验证:事实 ' + tc.contradicts.join('、') + ' 和反转结论相反' + (tc.note ? '(' + tc.note + ')' : '') });
  return { segments: [...segIds], chapters: holders.map(c => c.id), issues };
}

// 全部程序检查:按 6 项归类;hard = 程序确定是问题(这一项直接不过),soft = 交给 AI 判断
const ITEMS = [
  { key: 'progression', name: '递进' },
  { key: 'reveal', name: '揭示顺序' },
  { key: 'thesis', name: '标题和主线' },
  { key: 'facts', name: '事实支撑' },
  { key: 'reversal', name: '反转' },
  { key: 'forced', name: '硬套' },
  { key: 'deletion', name: '删除是否成立' }
];
// 钩子和埋点回收用到的事实:本来就要在开头和后面各出现一次,不算重复
function hookFactIds(run) {
  const a = (run && run.analysis) || {};
  const h = a.hook || {};
  const c = arr(h.candidates)[Number(h.chosen) || 0] || {};
  return arr(c.fact_ids).map(String);
}
function programChecks(run, asset, text, ft) {
  const bp = bpOf(text);
  const chs = arr(bp.chapters);
  const segs = segmentsOf(asset);
  const locks = arr((ft || {}).locks).length ? ft.locks : locksOf(run, asset, segs);
  const P = {}; ITEMS.forEach(it => { P[it.key] = []; });
  const add = (k, hard, text_, ch) => P[k].push({ by: '程序', hard: !!hard, text: text_, ...(ch ? { chapter: ch } : {}) });

  // v1.79 放松:事实重复只在 3 章以上展开讲时提出来,交给 AI 判断(后面的章带出新东西就不算问题)
  const prog = checks.checkProgression(text, { loose: true, skip: hookFactIds(run) });
  if (prog.ok === false) prog.issues.forEach(x => add('progression', true, x));
  arr(prog.soft).forEach(x => add('progression', false, x + '。请判断:后面的章是不是带出了新东西(新角度、新案例、新推论);只是换个说法把同一件事重讲一遍的才算问题'));
  const sim = adjacentSimilar(chs);
  sim.forEach(s => add('progression', s.hard, s.a + ' 和 ' + s.b + ' 的目的写得很像(相似度 ' + s.sim + ')', s.a));
  const ni = newInfoSimilar(chs);
  ni.forEach(s => add('progression', s.hard, s.a + ' 和 ' + s.b + ' 写的「观众第一次知道的新信息」很像(相似度 ' + s.sim + ':「' + s.ta + '」/「' + s.tb + '」)' + (s.hard ? ',两章在讲同一件事' : '。请判断是不是在讲同一件事'), s.a));
  const lad = checkLadder(chs, ft);
  lad.same.forEach(s => add('progression', true, s.a + ' 和 ' + s.b + ' 这两级的重点一样(都是「' + s.focus + '」),相邻两级要不一样', s.a));
  lad.empty.forEach(e => add('progression', true, e.ch + ' 是等级章,没写 ' + e.miss.join('、'), e.ch));

  const lk = checkLocks(chs, locks);
  lk.missing.forEach(l => add('reveal', true, l.label + '(原片在 ' + l.segment + ')没有落到任何一章'));
  lk.order.forEach(o => add('reveal', true, '悬念 ' + o.loop + ' 先收(' + o.close + ')后开(' + o.open + ')', o.close));
  lk.moved.forEach(m => add('reveal', !m.soft, m.lock.label + ':' + m.why, m.ch));
  const ret = retention.checkBlueprintRetention(text, asset.timeline, an().acceptedGaps(run.analysis));
  if (!ret.ok) ret.issues.forEach(x => add('reveal', /未接住/.test(x), '留存检查:' + x));

  const last = chs[chs.length - 1];
  if (last && !arr(last.locks).map(normLock).includes('ENDING') && !/回扣|回答|标题|제목|처음|첫/.test(chText(last))) add('thesis', false, '最后一章没写结尾回扣(locks 里没有 ENDING,文字里也没提回答标题)', last.id);

  const fc = checkFacts(run, chs);
  fc.unknown.forEach(u => add('facts', true, u.ch + ' 写的事实编号 ' + u.ids.join('、') + ' 不在事实表里', u.ch));
  // v1.82 补搜过的:降级的章写成「可能」「有说法」了就不再提「事实不够」;还写成确定的算问题。相反的新事实要有章正面处理
  const rec = ((run.steps || {}).blueprint_review || {}).research;
  const ri = rs().programItems(rec, chs, fc.thin);
  fc.thin.forEach(t => {
    const id = str(t.ch).toUpperCase();
    if (ri.hedged.has(id)) add('facts', false, t.ch + ' 补搜查不到实录,已经降级写成「可能」「有说法」,按降级后的说法判,不算问题', t.ch);
    else if (ri.unhedged.includes(id)) add('facts', true, t.ch + ' 补搜查不到实录,这一章的主张要降一级写成「可能」「有说法认为」或者并掉,现在还写成确定的事实', t.ch);
    else add('facts', false, t.ch + ' 只用了 ' + t.ids.map((x, i) => x + '[' + t.kinds[i] + ']').join('、') + ',事实不够', t.ch);
  });
  ri.against.forEach(id => add('reversal', true, '补搜到和论点或反转相反的事实 ' + id + ',蓝图没有一章正面处理(要写进某一章的 fact_ids,并写这一章怎么回应它)'));
  if (fc.none.length) add('facts', false, fc.none.join('、') + ' 没写事实编号');
  fc.weak.forEach(w => add('facts', true, '核验判 ' + w.grade + ' 的说法「' + cut(w.claim, 60) + '」在 ' + w.uses.map(u => u.ch).join('、') + ' 还当主张用', (w.uses[0] || {}).ch));

  const rv = checkReversal(run, chs, ft);
  rv.issues.forEach(x => add('reversal', x.hard, x.text, x.ch));

  const cs = consistency.scanBlueprint(run, text);
  if (cs.residue.length) cs.residue.forEach(h => add('forced', true, '原片残留词 ' + h.words.map(w => '「' + w + '」').join('') + '(' + h.ch + ')', h.ch));
  if (cs.levels.missing.length) add('forced', true, '等级编号跳号:缺第 ' + cs.levels.missing.join('、') + ' 级');
  const un = checkUnreachable(run, chs);
  un.forEach(u => {
    if (u.substituted) add('forced', false, u.ch + ' 第 ' + u.n + ' 级原片是主角够不着的「' + u.local + '」,蓝图用了对照表建议的替代说法「' + u.sub + '」。请判断事实表撑不撑得住主角走到这一级(这一章用的事实:' + (u.fact_ids.join('、') || '没写') + '),撑不住就改成旁观,或者停在事实表里的最高点', u.ch);
    else add('forced', true, u.ch + ' 让主角当上了第 ' + u.n + ' 级「' + u.local + '」,对照表标了主角够不着' + (u.why ? '(' + cut(u.why, 60) + ')' : '') + ';要换成主角做得到的,或者改成旁观', u.ch);
  });
  const cp = checkCopy(chs, segs);
  cp.forEach(x => add('forced', true, x.ch + ' 照搬了原片 ' + x.segment + ' 的小步:' + (x.codes.length ? '原片的机制代码 ' + x.codes.slice(0, 8).join('、') + '(' + x.codes.length + '/' + x.of + ')' : '原片必需内容 ' + x.payload.length + ' 条逐条出现'), x.ch));

  const dl = checkDeletions(run, chs, segs, ft);
  dl.dropped.forEach(d => add('deletion', true, d.segment + ' 功能表是「' + d.treatment + '」,蓝图里没有落到任何一章(合并的也要写进并入那一章的 source_segments)', ''));
  if (dl.ratio * 100 > dl.max + 1e-9) add('deletion', true, '蓝图里没有落到任何一章的原片段合计占原片 ' + Math.round(dl.ratio * 100) + '%,超过上限 ' + dl.max + '%');
  dl.deleted.forEach(d => add('deletion', false, '删了 ' + d.segment + '(占原片 ' + Math.round(d.ratio * 100) + '%)。理由:' + (d.reason || '没写') + ';查过的事实:' + (arr(d.checked_facts).join('、') || '没写') + (dl.unused.length ? ';事实表里还没分给任何一章的事实:' + dl.unused.slice(0, 12).join('、') : '') + '。请判断删除成立不成立(事实表里有能完成这段作用的事实就不成立)', ''));
  return { items: P, consistency: cs, retention: ret, progression: prog, similar: sim, new_info: ni, spread: factSpread(run, chs), ladder: lad, locks: lk, copy: cp, unreachable: un, facts: fc, reversal: rv, deletion: dl };
}

// 蓝图这一层的删除:没有落到任何一章的原片段就是删掉了。功能表没判删的不许悄悄丢;合计不超过上限
function checkDeletions(run, chs, segs, ft) {
  const rows = arr((ft || {}).rows);
  const used = new Set(chs.flatMap(c => arr(c.source_segments).map(x => str(x).toUpperCase())));
  const max = ft && ft.delete_max != null ? ft.delete_max : deleteMax();
  // 「合并到相邻章」的段,并入的那一段落到了某一章也算有去处
  const missing = segs.filter(s => {
    if (used.has(s.id)) return false;
    const r = rows.find(x => x.segment === s.id) || {};
    return !(r.treatment === TREATMENTS[1] && r.merge_into && used.has(str(r.merge_into).toUpperCase()));
  });
  const dropped = [], deleted = [];
  missing.forEach(s => {
    const r = rows.find(x => x.segment === s.id) || {};
    const d = { segment: s.id, ratio: Math.round(segShare(s) * 1000) / 1000, secs: Math.round(segShare(s) * (s.dur || 0)), treatment: r.treatment || '(功能表里没有)', reason: str(r.reason), checked_facts: arr(r.checked_facts) };
    if (r.treatment === TREATMENTS[2]) deleted.push(d); else dropped.push(d);
  });
  const facts = arr(((run || {}).analysis || {}).facts).map(f => f && f.id).filter(Boolean);
  const usedFacts = new Set(chs.flatMap(c => arr(c.fact_ids).map(String)));
  return { deleted, dropped, ratio: missing.reduce((n, s) => n + segShare(s), 0), max, unused: facts.filter(f => !usedFacts.has(f)) };
}

// ---------- AI 审 ----------
function reviewPrompt(run, text, ft, pc) {
  const a = run.analysis || {};
  const th = a.thesis_card || {};
  const bp = bpOf(text);
  const keep = ['id', 'time_range', 'function', 'purpose', 'information_goal', 'source_segments', 'treatment', 'layout_reason', 'locks', 'carries_peaks', 'open_loop', 'fact_ids', 'recap_ids', 'answers_prev', 'new_lens', 'leaves_question', 'level_focus', 'level_new_info'];
  const slim = arr(bp.chapters).map(c => { const o = {}; keep.forEach(k => { if (c[k] != null && c[k] !== '') o[k] = c[k]; }); return o; });
  const facts = arr(a.facts).map(f => '- ' + f.id + ' [' + str(f.kind) + '] ' + cut(f.content, 200)).join('\n');
  const prog = ITEMS.map(it => '【' + it.name + '】\n' + (pc.items[it.key].length ? pc.items[it.key].map(p => '- ' + (p.hard ? '(程序确定)' : '(请判断)') + p.text).join('\n') : '- 程序没查出问题')).join('\n');
  const ul = consistency.unreachableLevels(a);
  return readPrompt('blueprint_review.md')
    .replaceAll('{{title}}', str((a.title || {}).final_title) || run.topic || '')
    .replaceAll('{{thesis}}', ['原有认知=' + str(th.viewer_belief), '真相=' + str(th.truth), '一句话论点=' + str(th.one_line_thesis), '结尾落点=' + str(th.ending_landing)].join('\n'))
    .replaceAll('{{facts}}', facts || '(没有)')
    .replaceAll('{{checked}}', checkedBrief(run))
    .replaceAll('{{unreachable}}', ul.length ? ul.map(u => '- 第 ' + u.n + ' 级「' + u.local + '」:' + u.why).join('\n') : '(没有)')
    .replaceAll('{{function_table}}', ft ? tableBrief(ft) : '(没有)')
    .replaceAll('{{program}}', prog)
    .replaceAll('{{research}}', rs().reviewBrief(((run.steps || {}).blueprint_review || {}).research))
    .replaceAll('{{blueprint}}', JSON.stringify({ chapters: slim, hook: bp.hook || {} }, null, 1));
}
// 重画蓝图的老任务:上一版稿子做过联网核验,判 C/D/E 的说法(和核验找到的反例)给 AI 审反转和事实支撑用。
// 核验编号(F01…)是稿子里说法的编号,不是事实表的编号,两边不能混用
function checkedBrief(run) {
  const items = arr(((run.review || {}).factcheck || {}).items).filter(i => /^[CDE]$/.test(str(i.grade)));
  if (!items.length) return '(没有)';
  return items.slice(0, 12).map(i => '- 上一版稿子 ' + str(i.chapter) + ' 的说法「' + cut(i.claim, 120) + '」核验判 ' + i.grade + ':' + cut(i.finding, 160)).join('\n');
}
function parseReview(text) {
  const j = checks.extractJsonObject(checks.stripFence(str(text))) || parse(checks.stripFence(str(text)));
  if (!j || typeof j.items !== 'object' || !j.items) return null;
  return j;
}

// 合并程序和 AI 的结论:程序确定的问题直接不过;AI 判不过的也不过
// 蓝图审每项没过时的通用大白话(AI 没写 plain 时用)
const PLAIN = {
  progression: '好几章在讲同一件事,后面的章节没带来新东西,观众会觉得「这个刚才不是说过了吗」。',
  reveal: '答案或反转说早了,或者开头埋的悬念后面没收,观众没理由看到最后。',
  thesis: '有的章跑题了,或者最后没回答标题提的问题,观众会觉得被标题骗了。',
  facts: '有的章用的事实在事实表里没有,或者只靠「待查」「假设」撑着,写出来容易编、站不住。',
  reversal: '反转不是这个题自己的(照搬原片),或者没有事实撑住,观众不会被说服。',
  forced: '有原片的东西(头衔、制度、器物、例子)被硬塞进这个题,或者主角做了这个题里做不到的事。',
  deletion: '删掉的段其实有素材能写,删了会少一个看点。'
};
function mergeReview(pc, ai) {
  const items = ITEMS.map(it => {
    const prog = pc.items[it.key];
    const x = ((ai || {}).items || {})[it.key] || {};
    const aiProblems = arr(x.problems).map(p => ({ by: 'AI', hard: true, chapter: str(p.chapter), ...(str(p.segment) ? { segment: str(p.segment).toUpperCase() } : {}), text: str(p.problem || p.text), fix: str(p.fix) })).filter(p => p.text);
    const aiPass = ai ? (x.pass === true || (x.pass !== false && !aiProblems.length)) : null;
    const hard = prog.filter(p => p.hard).map(p => ({ ...p }));
    // AI 常把程序已经确定的问题再说一遍:和程序的某条差不多的不重复列,AI 写的改法补到程序那条上
    const own = aiProblems.filter(a => {
      const twin = hard.find(p => (!a.chapter || !p.chapter || a.chapter === p.chapter) && jaccard(p.text, a.text) >= 0.5);
      if (twin) { if (!twin.fix && a.fix) twin.fix = a.fix; return false; }
      return true;
    });
    const pass = !hard.length && aiPass !== false;
    // v1.78:不过的项给一句大白话(AI 写的优先,没写就用程序的通用说法)
    const plain = pass ? '' : (aiPass === false && str(x.plain).trim() ? cut(str(x.plain).trim(), 120) : PLAIN[it.key] || '');
    return { key: it.key, name: it.name, pass, ai_pass: aiPass, plain, problems: hard.concat(aiPass === false ? own : []), notes: prog.filter(p => !p.hard).concat(aiPass !== false ? own.map(p => ({ ...p, hard: false })) : []) };
  });
  return { pass: items.every(i => i.pass), items };
}
function failText(rv) {
  return rv.items.filter(i => !i.pass).map(i => '【' + i.name + '】' + i.problems.map(p => (p.chapter ? p.chapter + ' ' : '') + p.text + (p.fix ? '(改法:' + p.fix + ')' : '')).join(';')).join('\n');
}
// 停下来时给人看的中文原因:每项一句,最多 3 条问题
function reasonsZh(rv) {
  return rv.items.filter(i => !i.pass).map(i => i.name + ':' + i.problems.slice(0, 3).map(p => (p.chapter && !str(p.text).startsWith(p.chapter) ? p.chapter + ' ' : '') + cut(p.text, 90)).join(';') + (i.problems.length > 3 ? ' 等 ' + i.problems.length + ' 条' : ''));
}

const MAX_REVISE = 2;
// 蓝图审:审 → 不过就改(最多 2 次)→ 每次改完再审;还不过就 held。改坏了时长或 JSON 的那次不用,算一次。
// opts:{ run, asset, content, messages, r, callLlm, gate(c) → checkBlueprint 结果, ft }
async function reviewLoop(opts) {
  const { run, asset, callLlm, gate, ft } = opts;
  let { content, messages, r } = opts;
  const rounds = [];
  const t0 = Date.now();
  const doReview = async (label) => {
    const pc = programChecks(run, asset, content, ft);
    let ai = null, aiError = '';
    try {
      const rr = await callLlm([{ role: 'user', content: reviewPrompt(run, content, ft, pc) }], label);
      ai = parseReview(rr.content);
      if (!ai) aiError = 'AI 审的输出不是合法 JSON,这一轮只按程序检查判';
    } catch (e) { aiError = 'AI 审调用失败(' + e.message + '),这一轮只按程序检查判'; }
    const rv = rs().applyKept(mergeReview(pc, ai), ((run.steps || {}).blueprint_review || {}).research, arr(bpOf(content).chapters));
    return { pc, ai, rv, aiError };
  };
  run.steps = { ...(run.steps || {}), blueprint_review: { status: 'running', started_at: new Date().toISOString(), rounds: [] } };
  store.saveRun(run);
  let cur = await doReview('Step 1 蓝图审');
  const record = (x, extra) => {
    rounds.push({ at: new Date().toISOString(), pass: x.rv.pass, items: x.rv.items, summary: str((x.ai || {}).summary), ai_error: x.aiError, ...(extra || {}) });
    run.steps.blueprint_review = { ...run.steps.blueprint_review, rounds: rounds.slice() };
    store.saveRun(run);
  };
  record(cur);
  let revised = 0, researched = false;
  while (!cur.rv.pass && revised < MAX_REVISE) {
    // v1.82「事实支撑」不过:先按点名的章联网补搜(一次),查到的追加进事实表,再按新事实改蓝图
    if (!researched && cur.rv.items.some(i => i.key === 'facts' && !i.pass)) {
      researched = true;
      const rec = await rs().research({ run, asset, ft, content, cur, callLlm });
      rounds.push({ at: new Date().toISOString(), research: { status: rec.status, added: arr(rec.added).length, found: arr(rec.found), downgrade: arr(rec.downgrade).map(d => d.ch), kept: arr(rec.kept).map(d => d.ch), why: rec.why || rec.error || '', secs: rec.secs } });
      run.steps.blueprint_review = { ...run.steps.blueprint_review, rounds: rounds.slice() };
      store.saveRun(run);
      if (rec.status === 'done') {
        cur = { ...cur, rv: rs().applyKept(cur.rv, rec, arr(bpOf(content).chapters)) };
        if (cur.rv.pass) break; // 只剩保持原样的章查不到:不用改了
      }
    }
    revised++;
    const restored = restoreDeletions(run, ft, cur.rv, asset);
    const progFail = cur.rv.items.some(i => i.key === 'progression' && !i.pass);
    const fb = '蓝图审没通过,按下面的意见改蓝图。' + (progFail
      ? '「递进」的问题可以跨章调整:把一件事挪到最合适的一章讲透,其他章要提到它就写进 recap_ids 一句带过,或者换成事实表里还没用上的事实、新角度、新案例;挪完空出来的章可以并到相邻章或写短,不许为了凑时长编事实表里没有的东西。你觉得原来的安排更顺的地方可以不挪。其他问题只改点到的章节和字段。锁定项、功能表、总时长和其余要求不变'
      : '只改点到的章节和字段,功能表、锁定项、总时长和其余要求不变') + ';重新输出完整 JSON(禁止代码围栏):\n' + failText(cur.rv) +
      (restored.length ? '\n功能表已改:' + restored.join('、') + ' 的删除不成立,改成「保留功能换内容」,要排进某一章(可以和相邻章一起讲),写进那一章的 source_segments,时间从其他章匀出来,总时长不变。' : '') +
      (cur.pc.items.progression.some(p => /level_focus/.test(p.text)) ? '\n等级章每一级都要写 level_focus 和 level_new_info,相邻两级的 level_focus 不能一样。' : '') +
      rs().feedback(((run.steps || {}).blueprint_review || {}).research) +
      spreadText(cur.pc.spread || []) +
      '\n每章的 new_lens 用一句话写观众在这一章第一次知道的新信息;改完先把各章 new_lens 排成清单逐对核对,两章讲同一件事的合并或挪走,核对完再输出(清单不要输出)。';
    const m2 = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: fb }];
    let r2 = null, c2 = '', why = '';
    try {
      r2 = await callLlm(m2, 'Step 1 按蓝图审改(第 ' + revised + ' 次)');
      c2 = checks.stripFence(r2.content.trim());
      const g = gate(c2);
      if (g.duration.ok === false) why = '改完的蓝图不合格(' + g.duration.detail + '),没采用,保留上一版';
    } catch (e) { why = '改蓝图的调用失败(' + e.message + '),保留上一版'; }
    if (why) { rounds.push({ at: new Date().toISOString(), revise: revised, rejected: why }); run.steps.blueprint_review.rounds = rounds.slice(); store.saveRun(run); continue; }
    content = c2; r = r2; messages = m2;
    cur = await doReview('Step 1 蓝图审(改后第 ' + revised + ' 次)');
    record(cur, { after_revise: revised });
  }
  // v1.79:改完只剩「递进」没过 → 不停,接着写稿;没过的点交给写稿时提醒(step2Rules)
  const onlyProg = !cur.rv.pass && cur.rv.items.every(i => i.pass || i.key === 'progression');
  const status = cur.rv.pass ? 'passed' : onlyProg ? 'passed_soft' : 'held';
  const research = (run.steps.blueprint_review || {}).research;
  run.steps.blueprint_review = {
    ...(research ? { research } : {}),
    status, secs: Math.round((Date.now() - t0) / 100) / 10, finished_at: new Date().toISOString(), revised, rounds,
    items: cur.rv.items, summary: str((cur.ai || {}).summary), retopic: arr((cur.ai || {}).retopic).map(String).filter(Boolean).slice(0, 3),
    reasons_zh: cur.rv.pass ? [] : reasonsZh(cur.rv),
    plain_zh: cur.rv.pass ? [] : cur.rv.items.filter(i => !i.pass).map(i => i.plain || ''),
    ...(onlyProg ? { soft_notes: arr((cur.rv.items.find(i => i.key === 'progression') || {}).problems).slice().sort((x, y) => (y.by === 'AI') - (x.by === 'AI')).map(p => ((p.chapter && !str(p.text).startsWith(p.chapter)) ? p.chapter + ' ' : '') + cut(p.text, 160) + (p.fix ? '(改法:' + cut(p.fix, 100) + ')' : '')).slice(0, 8) } : {})
  };
  store.saveRun(run);
  return { content, messages, r, held: status === 'held', pc: cur.pc, revised };
}

// 蓝图审判「删除不成立」的段:功能表改回「保留功能换内容」(v1.74),返回改了哪几段
function restoreDeletions(run, ft, rv, asset) {
  const it = arr(rv.items).find(i => i.key === 'deletion');
  if (!ft || !it || it.pass) return [];
  const ids = new Set();
  it.problems.filter(p => p.by === 'AI').forEach(p => { (str(p.segment) + ' ' + str(p.chapter) + ' ' + str(p.text)).toUpperCase().replace(/FS\s?(\d+)/g, (m, n) => { ids.add('FS' + String(n).padStart(2, '0')); return m; }); });
  const out = [];
  arr(ft.rows).forEach(r => {
    if (r.treatment === TREATMENTS[2] && ids.has(r.segment)) {
      r.treatment = TREATMENTS[0];
      r.notes.push('蓝图审判删除不成立,改成「保留功能换内容」');
      out.push(r.segment);
    }
  });
  if (out.length) {
    Object.assign(ft, deletedOf(ft.rows, segmentsOf(asset)));
    ft.review_restored = arr(ft.review_restored).concat(out);
    run.function_table = ft;
    store.saveRun(run);
  }
  return out;
}

// 写进任务记录(每篇都记,严格照原片的也记,方便以后统计):蓝图里没有落到任何一章的原片段
function recordDeletions(run, asset, content) {
  try {
    const segs = segmentsOf(asset);
    const chs = arr(bpOf(content).chapters);
    if (!chs.length || !segs.length) return;
    const dl = checkDeletions(run, chs, segs, modeOf(run) === 'function' ? run.function_table : null);
    const rows = arr((run.function_table || {}).rows);
    run.deleted_segments = dl.deleted.concat(dl.dropped).map(d => ({ segment: d.segment, secs: d.secs, ratio: d.ratio, reason: d.reason || (modeOf(run) === 'function' ? '' : '(严格照原片:蓝图没写这段)'), checked_facts: arr(d.checked_facts), treatment: (rows.find(r => r.segment === d.segment) || {}).treatment || '' }));
    run.deleted_ratio = Math.round(dl.ratio * 1000) / 1000;
  } catch (e) { /* 统计用,出错不挡 */ }
}

// ---------- 停下后的三个选择 ----------
// 回到写稿前:清掉蓝图和蓝图审(蓝图审记录留一份历史),改题目 / 换框架都要求「还没开始写稿」
function backToAnalysis(run) {
  const hist = (run.steps || {}).blueprint_review;
  run.blueprint_history = arr(run.blueprint_history).concat([{ at: new Date().toISOString(), asset_id: run.asset_id, topic: run.topic, blueprint: (run.outputs || {}).step1 || '', review: hist || null }]).slice(-5);
  run.outputs = { ...(run.outputs || {}), step1: '' };
  ['blueprint', 'blueprint_review', 'function_table', 'script', 'audit', 'optimized'].forEach(k => { if (run.steps) delete run.steps[k]; });
  delete run.function_table;
  ['retention', 'progression', 'consistency', 'first_payoff', 'blueprint'].forEach(k => { if (run.checks) delete run.checks[k]; });
  run.analysis_confirmed = false;
  delete run.analysis_auto_confirmed;
  delete run.blueprint_mode;
  run.current_step = 0;
  run.status = 'awaiting_review';
  delete run.error;
}
function holdChoice(runId, body) {
  const run = store.getRun(runId);
  if (!run) throw Object.assign(new Error('任务不存在'), { status: 404 });
  if (run.status !== 'blueprint_hold') throw Object.assign(new Error('这个任务现在不是「蓝图待定」(当前: ' + run.status + ')'), { status: 400 });
  const choice = str((body || {}).choice);
  const br = (run.steps || {}).blueprint_review || {};
  const now = new Date().toISOString();
  if (choice === 'write') {
    run.steps.blueprint_review = { ...br, override: { at: now, choice: 'write' } };
    run.status = 'queued';
    store.saveRun(run);
    if (run.draft_first) require('./review').resumeDraftFirst(runId).catch(() => {});
    else pl().runGeneration(runId).catch(() => {});
    return { ok: true, choice };
  }
  // v1.76:框架在建任务时已定的任务,蓝图审没过只能「仍然写」,不能换框架或改题目
  if (run.no_reframe && (choice === 'retopic' || choice === 'reframe')) throw Object.assign(new Error('这个任务的框架在建任务时已经定了,不能再换框架或改题目;蓝图审没过的地方可以「仍然写」后在审稿里改'), { status: 400 });
  if (choice === 'retopic') {
    const t = str((body || {}).title).trim();
    if (!t) throw Object.assign(new Error('新题目是空的'), { status: 400 });
    if (t === run.topic) throw Object.assign(new Error('新题目和现在的一样'), { status: 400 });
    backToAnalysis(run);
    store.saveRun(run);
    return { ...require('./reframe').retopic(runId, t), choice };
  }
  if (choice === 'reframe') {
    backToAnalysis(run);
    const a = run.analysis || {};
    // 借用 v1.70 的换框架流程:写前分析标成「换框架」,原因写蓝图审没过的那几项;原来的结论记在 verdict_before_blueprint
    a.verdict_before_blueprint = a.verdict_before_blueprint || a.verdict || '';
    a.verdict = '换框架';
    a.verdict_reason = '蓝图审没通过,人选了换框架:' + arr(br.reasons_zh).join(';');
    a.reframe_reasons = arr(br.reasons_zh).slice(0, 6);
    run.analysis = a;
    if (run.reframe && run.reframe.status === 'ignored') run.reframe = { ...run.reframe, status: '' };
    store.saveRun(run);
    return { ...require('./reframe').startSuggest(runId), choice };
  }
  throw Object.assign(new Error('choice 只能是 write(仍然写)/ retopic(改题目)/ reframe(换框架)'), { status: 400 });
}

// ---------- 写稿(step2)用 ----------
// 这一章承接的原片段在功能表里「必须保留」的那一步(观众要经历什么),不是原片内容
function chapterKeep(run, c) {
  const rows = arr(((run || {}).function_table || {}).rows);
  return arr(c && c.source_segments).map(sid => rows.find(r => r.segment === sid)).filter(r => r && str(r.keep).trim() && r.treatment !== TREATMENTS[2]).map(r => r.keep);
}
// 这一章承接的原片段在功能表里「可以换」的东西(换成新题目自己的内容);反转段换成新题目自己的反转
function chapterSwap(run, c) {
  const ft = (run || {}).function_table || {};
  const rows = arr(ft.rows);
  return arr(c && c.source_segments).map(sid => rows.find(r => r.segment === sid)).filter(r => r && r.treatment !== TREATMENTS[2]).map(r => {
    if (r.treatment === TREATMENTS[3] && str((ft.reversal || {}).new_reversal)) return '反转换成新题目自己的:' + str(ft.reversal.new_reversal);
    return str(r.swap);
  }).filter(Boolean);
}
const FN_ONLY = '只能换内容,不能丢功能:「必须保留的功能」是观众在这一章一定要经历的那一步,每一条都要写到;「可以换的内容」用新题目自己的事实换。写不好不能跳过或删掉,换一种内容把这一步写出来。';
// 分章写稿时每章多给的几行(只在按功能重排的蓝图上加;严格照原片的蓝图没有这些字段,一行不加)
function chapterBrief(run, c) {
  if (modeOf(run) !== 'function' || !c) return '';
  const keep = chapterKeep(run, c);
  const swap = chapterSwap(run, c);
  return (str(c.layout_reason).trim() ? '本章为什么这样排(照这个作用写,不要回头照原片那一段的内容补):' + str(c.layout_reason).trim() + '\n' : '') +
    (keep.length ? '本章必须保留的功能(功能表「必须保留」,观众要经历的那一步):' + keep.join(';') + '\n' : '') +
    (swap.length ? '本章可以换的内容(功能表「可以换」,换成新题目自己的):' + swap.join(';') + '\n' : '') +
    (keep.length || swap.length ? FN_ONLY + '\n' : '') +
    (arr(c.locks).length ? '本章承担的锁定项(必须写到):' + arr(c.locks).join('、') + '\n' : '') +
    (str(c.level_focus).trim() ? '这一级只讲的重点:' + str(c.level_focus).trim() + '(其他方面一句带过,不要把身份、收入、代价、信条每样都走一遍)\n' : '') +
    (str(c.level_new_info).trim() ? '这一级观众第一次知道的新信息:' + str(c.level_new_info).trim() + '\n' : '');
}
// 整篇写稿时 step2.md 里 {{function_rules}} 的内容;严格照原片的蓝图是空字符串(提示词和 v1.72 一字不差)
function step2Rules(run, blueprintText) {
  if (modeOf(run) !== 'function') return '';
  const chs = arr(bpOf(blueprintText).chapters);
  const keeps = chs.map(c => { const k = chapterKeep(run, c); return k.length ? c.id + ':' + k.join(';') : ''; }).filter(Boolean);
  const swaps = chs.map(c => { const k = chapterSwap(run, c); return k.length ? c.id + ':' + k.join(';') : ''; }).filter(Boolean);
  return '\n- 这份蓝图是「按功能重排」画的:章节不和原片一一对应,照每章的作用写,不要回头照原片那一段的内容补。每章的 layout_reason 说明这一章为什么这样排;locks 里的锁定项(开头钩子、高峰、悬念的开和收、结尾回扣)本章必须写到;等级章的 level_focus 是这一级只讲的重点(其他方面一句带过,不要每一级都把身份、收入、代价、信条走一遍),level_new_info 是这一级观众第一次知道的新信息,围绕它展开。' +
    (keeps.length ? '\n- 各章必须保留的功能(功能表「必须保留」,写的是作用,不是原片内容):' + keeps.join(' / ') : '') +
    (swaps.length ? '\n- 各章可以换的内容(功能表「可以换」,换成新题目自己的):' + swaps.join(' / ') : '') +
    (keeps.length || swaps.length ? '\n- ' + FN_ONLY : '') + softNotes(run) + researchNotes(run, blueprintText);
}
// v1.79 蓝图审只剩「递进」没过、接着写的:写稿时提醒这几处别讲重复
function softNotes(run) {
  const br = (run.steps || {}).blueprint_review || {};
  if (br.status !== 'passed_soft' || !arr(br.soft_notes).length) return '';
  return '\n- 蓝图审提醒(这几处在蓝图里有点重复,写的时候注意):' + br.soft_notes.join(' / ') + '。同一件事在后面的章再出现时,要么一句带过当回顾,要么带出新东西(新角度、新案例、新推论),不要换个说法重讲一遍。';
}

// v1.82 蓝图补搜查不到的章:写稿时也不许硬编(降级的写成「可能」「有说法」;保持原样的章照蓝图写,但只用事实表里有的)
function researchNotes(run, text) {
  const rec = ((run.steps || {}).blueprint_review || {}).research;
  if (!rec || rec.status !== 'done') return '';
  const chs = arr(bpOf(str(text || ((run || {}).outputs || {}).step1)).chapters);
  const down = [...new Set(arr(rec.downgrade).flatMap(d => rs().mapNow(d, chs)))];
  const kept = [...new Set(arr(rec.kept).flatMap(d => rs().mapNow(d, chs)))];
  return (down.length ? '\n- 蓝图补搜没查到实录的章(' + down.join('、') + '):主张写成「可能」「有说法认为」,不许编具体的实例、人名、年份、数字。' : '') +
    (kept.length ? '\n- 补搜没查到、但按规矩保持原样的章(' + kept.join('、') + '):照蓝图写,只用事实表里有的,不许编具体的实例、人名、年份、数字。' : '');
}

// 初稿检查 / 终审用:每章的「必须保留的功能」和「可以换的内容」(只在按功能重排的蓝图上有;严格照原片返回空对象)
function chapterFunctions(run) {
  if (modeOf(run) !== 'function') return {};
  const out = {};
  arr(bpOf(str(((run || {}).outputs || {}).step1)).chapters).forEach(c => {
    const keep = chapterKeep(run, c), swap = chapterSwap(run, c);
    if (keep.length || swap.length || arr(c.locks).length) out[str(c.id).toUpperCase()] = { keep, swap, locks: arr(c.locks) };
  });
  return out;
}
// 初稿检查第 9 项(严格照原片是空字符串,提示词和 v1.73 一字不差)
function draftCheckItem(run) {
  if (modeOf(run) !== 'function' || !Object.keys(chapterFunctions(run)).length) return '';
  return '\n9. 蓝图功能是否落实:上面每章写了「蓝图功能」(必须保留的功能、可以换的内容)。必须保留的功能每一条都要在这一章写到(内容可以换成本题自己的,功能不能丢);因为不好写而跳过、一句带过、换成别的作用的,都算没落实。没落实的写进问题,类别用「模板出入」,说明以「蓝图功能:」开头,并在二稿里把这一步补上(补的时候也要守住篇幅规则,用替换而不是加长)。';
}

// 页面用:功能表 + 蓝图每章的排法 + 蓝图审
function view(run) {
  const ft = run.function_table || null;
  const br = (run.steps || {}).blueprint_review || null;
  let chapters = [];
  const s1 = (run.outputs || {}).step1;
  if (s1 && modeOf(run) === 'function') {
    chapters = arr(bpOf(s1).chapters).map(c => ({ id: c.id, time_range: c.time_range, source_segments: arr(c.source_segments), treatment: str(c.treatment), layout_reason: str(c.layout_reason), locks: arr(c.locks), level_focus: str(c.level_focus), level_new_info: str(c.level_new_info), purpose: cut(c.purpose, 160) }));
  }
  // v1.89:人选论点时看到的大纲,蓝图哪里和它不一样
  let outlineDiff = '';
  try { if (s1) outlineDiff = str(bpOf(s1).outline_diff); } catch (e) {}
  const picked = !!(run.thesis_scout && run.thesis_scout.user_pick);
  if (!ft && !br && !run.blueprint_mode) return null;
  const fn = modeOf(run) === 'function';
  return { mode: modeOf(run), mode_label: MODES[modeOf(run)], mode_why: str(run.blueprint_mode_why), setting: settingMode(), delete_max: ft && ft.delete_max != null ? ft.delete_max : deleteMax(), deleted_segments: arr(run.deleted_segments), deleted_ratio: run.deleted_ratio, table: fn ? ft : null, chapters, review: fn ? br : null, held: run.status === 'blueprint_hold', outline_diff: outlineDiff, outline_picked: picked && !!s1 };
}

module.exports = { newInfoSimilar, factSpread, spreadText, researchNotes, chapterSwap, chapterFunctions, draftCheckItem, DELETE_MAX_DEFAULT, deleteMax, setDeleteMax, deletionCheck, enforceDeletions, deletedOf, checkDeletions, plannedFacts, restoreDeletions, recordDeletions, MODES, settingMode, setSettingMode, decideMode, modeOf, segmentsOf, locksOf, ladderOf, TREATMENTS, normTreatment, normalizeTable, tableSourceHits, sourceTerms, sourceHits, ensureTable, tableBrief, locksBrief, ladderBrief, frameworkCore, timelineCore, step1Template,
  checkLocks, adjacentSimilar, checkLadder, checkCopy, checkUnreachable, checkFacts, checkReversal, programChecks, ITEMS, reviewPrompt, parseReview, mergeReview, reasonsZh, reviewLoop, MAX_REVISE, holdChoice, backToAnalysis, view, jaccard, chapterKeep, chapterBrief, step2Rules };
