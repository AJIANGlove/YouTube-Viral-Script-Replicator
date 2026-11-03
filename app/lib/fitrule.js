// v1.74 判断框架合不合适:跟 v1.73 的蓝图对齐。
// 蓝图「按功能重排」以后,普通段落可以换内容、合并,必要时删掉(合计不超过原片 15%),
// 所以适配判断只看三样:锁定项(开头钩子、留存高峰、悬念的开和收、结尾回扣、反转)能不能做到、
// 核心套路题目里有没有(等级框架要有往上走的路,拆账框架要算得出账)、使用前提满不满足。
// 普通段做不到不算「不合适」,记进 weak_segments 交给功能表。
// 只在设置为「按功能重排」时生效;「严格照原片」时三处提示词和结论处理都和 v1.73 一字不差。
//
// 程序这一层:AI 给每条卡住的地方标类别(锁定项 / 核心套路 / 使用前提 / 普通段);
// AI 判了「换框架」但卡住的全是普通段,程序改判「调整后可写」,原结论和改判原因都记下来。
// AI 没标类别时,按文字粗分(兜底,不如 AI 标的准)。
const fs = require('fs');
const path = require('path');

const arr = v => (Array.isArray(v) ? v : []);
const str = v => String(v == null ? '' : v).trim();
const PROMPTS = path.join(__dirname, '..', 'prompts');
const readPrompt = f => fs.readFileSync(path.join(PROMPTS, f), 'utf-8');

function on() {
  try { return require('./blueprint').settingMode() === 'function'; } catch (e) { return false; }
}

const KINDS = { lock: '锁定项', core: '核心套路', prereq: '使用前提', segment: '普通段' };
const HARD = ['lock', 'core', 'prereq'];
function normKind(k) {
  const s = str(k).toLowerCase();
  if (!s) return '';
  if (/lock|锁定|钩子|高峰|悬念|回扣|反转/.test(s)) return 'lock';
  if (/core|核心|套路|机制/.test(s)) return 'core';
  if (/prereq|前提|材料/.test(s)) return 'prereq';
  if (/segment|普通|段/.test(s)) return 'segment';
  return '';
}
// 兜底:AI 没标类别时按文字粗分。宁可分成「硬」的(锁定项 / 核心套路 / 前提),不轻易把真问题放过去
const LOCK_RE = /高峰|PK\d|悬念|LOOP\d|开头钩子|开场钩子|钩子|结尾回扣|回扣|回环|反转|首尾呼应/;
const CORE_RE = /必须保留的?机制|核心机制|核心动作|核心套路|核心承诺|标题契约|must_deliver|叙事方式|第二人称|往上(?:走|爬)|一级一?级|逐级|阶梯|梯子|等级序列|社会流动|晋升|爬升|攀升|没有.{0,8}(?:等级|阶层|上升的?路)|算不出|没法算|算不了|拆不了账|没有可以算的账|美化|权力幻想|핵심|기제|서사 방식/;
const PREREQ_RE = /使用前提|前提|必须有的材料|核心材料|材料缺失|根本不存在|材料.{0,6}(?:没有|不存在)|전제|확보 불가/;
function classifyText(t) {
  const s = str(t);
  if (LOCK_RE.test(s)) return 'lock';
  if (CORE_RE.test(s)) return 'core';
  if (PREREQ_RE.test(s)) return 'prereq';
  return 'segment';
}

// 卡住的地方:优先用 AI 写的 blocking(带 kind),没有就用 reframe_reasons 的文字
function blockers(blocking, reasons) {
  const bl = arr(blocking).map(b => (b && typeof b === 'object' ? b : { why: str(b) })).map(b => {
    const text = (str(b.segment) ? str(b.segment) + ':' : '') + str(b.why);
    const k = normKind(b.kind);
    return { segment: str(b.segment), why: str(b.why), kind: k || classifyText(text), kind_by: k ? 'AI' : '程序' };
  }).filter(b => b.segment || b.why);
  if (bl.length) return bl;
  return arr(reasons).map(r => ({ segment: '', why: str(r), kind: classifyText(r), kind_by: '程序' })).filter(b => b.why);
}
const kindLabel = b => KINDS[b.kind] || b.kind;
const bText = b => (b.segment ? b.segment + ':' : '') + b.why;

// 把结论按新标准过一遍。o 是快速判断或完整分析的结果(会被改),blocking / reasons 是 AI 的原始输出
function apply(o, blocking, reasons) {
  const bl = blockers(blocking, reasons);
  const hard = bl.filter(b => HARD.includes(b.kind));
  const soft = bl.filter(b => b.kind === 'segment');
  o.fit_standard = 'function';
  o.fit_blocking = bl.map(b => ({ ...b, kind_label: kindLabel(b) }));
  o.weak_segments = [...new Set(arr(o.weak_segments).map(str).concat(soft.map(bText)))].filter(Boolean).slice(0, 20);
  if (o.verdict === '换框架' && !hard.length && soft.length) {
    o.fit_rule = { downgraded: true, from: '换框架', to: '调整后可写', at: new Date().toISOString(), why: '卡住的 ' + soft.length + ' 处都是普通段要求,按功能重排的蓝图可以换内容或合并处理,不算不合适', segment_only: soft.map(bText).slice(0, 12) };
    o.verdict_before_fit_rule = '换框架';
    o.reframe_reasons_segment = arr(o.reframe_reasons).slice();
    o.verdict = '调整后可写';
    o.verdict_reason = '(程序按新标准改判)' + o.fit_rule.why + (str(o.verdict_reason) ? ';原结论:' + str(o.verdict_reason) : '');
    o.reframe_reasons = [];
  } else if (o.verdict === '换框架') {
    // 仍判换框架:换框架原因只留锁定项 / 核心套路 / 前提这几条,普通段的放进 weak_segments(推荐新框架时不被普通段的要求带偏)
    o.fit_rule = { downgraded: false, hard: hard.map(b => kindLabel(b) + ' ' + bText(b)).slice(0, 12), segment_only: soft.map(bText).slice(0, 12) };
    if (soft.length && hard.length) o.reframe_reasons = hard.map(b => '[' + kindLabel(b) + '] ' + bText(b)).slice(0, 12);
  } else {
    o.fit_rule = { downgraded: false, segment_only: soft.map(bText).slice(0, 12) };
  }
  return o;
}

// 快速判断(fitcheck.cleanFit 之后):fit.blocking 只有 segment/why,kind 从原始输出里取
function applyQuick(fit, raw) {
  const rawBl = arr((raw || {}).blocking);
  // AI 标了类别就用 AI 的;没标的留空,由 blockers() 按文字兜底分(记为「程序」分的)
  fit.blocking = fit.blocking.map((b, i) => ({ ...b, kind: normKind((rawBl[i] || {}).kind) }));
  apply(fit, fit.blocking, fit.reframe_reasons);
  if (fit.fit_rule && fit.fit_rule.downgraded) fit.adjust = fit.adjust.concat(fit.weak_segments.map(s => '换内容保功能:' + s)).slice(0, 12);
  return fit;
}
// 完整写前分析:AI 按新标准写了 fit_blocking(带 kind)和 weak_segments
function applyFull(a) {
  if (!a || typeof a !== 'object') return a;
  apply(a, a.fit_blocking, a.reframe_reasons);
  if (a.fit_rule && a.fit_rule.downgraded) {
    a.adjustments = arr(a.adjustments).concat(a.fit_rule.segment_only.map(s => ({ type: '换内容保功能', target: 'modules', segments: (s.match(/FS\d+/g) || []), peaks: [], fact_ids: [], reason: '(程序按新标准改判)普通段要求,交给蓝图功能表处理:' + s })));
  }
  return a;
}

// ---------- 提示词 ----------
// 快速判断换一份提示词(结构和输出字段一样,多一个 kind)
function fitPromptFile() { return on() ? 'fit_check_function.md' : 'fit_check.md'; }

// 写前分析:「第 1 步 适配判定」那一段换成新标准;找不到原文就整段附在最后(不会静默失效)
const AN_START = '第 1 步 适配判定';
const AN_END = '第 2 步 标题承诺';
function analysisPrompt(tpl) {
  if (!on()) return tpl;
  const block = readPrompt('analysis_fit_function.md').trim();
  const i = tpl.indexOf(AN_START), j = tpl.indexOf(AN_END);
  if (i < 0 || j < i) return tpl + '\n\n' + block;
  return tpl.slice(0, i) + block + '\n\n' + tpl.slice(j);
}

// 推荐框架:第 3 条「看必须保留的机制和使用前提」换成新标准
const SG_OLD = /^3\. 看「必须保留的机制」和「使用前提」[^\n]*$/m;
const SG_NEW = '3. 只按三样挑(蓝图现在按功能重排:普通段落做不到可以换内容、合并,必要时删一点,不算不合适):① 锁定项能不能做到:开头钩子、留存高峰、悬念的开和收、结尾回扣、反转(反转要是题目自己的、有事实撑住);② 核心套路题目里有没有:按叙事方式(narrative_mode)和「必须保留的机制」看,例如等级框架题目里要真有一条往上走的路,拆账框架要算得出账;③「使用前提」满不满足。上面「判定换框架的原因」里,标了[普通段]的不用管,只避开标了[锁定项][核心套路][使用前提]的同类毛病。';
function suggestPrompt(tpl) {
  if (!on()) return tpl;
  return SG_OLD.test(tpl) ? tpl.replace(SG_OLD, SG_NEW) : tpl + '\n\n' + SG_NEW;
}

module.exports = { on, KINDS, normKind, classifyText, blockers, apply, applyQuick, applyFull, fitPromptFile, analysisPrompt, suggestPrompt };
