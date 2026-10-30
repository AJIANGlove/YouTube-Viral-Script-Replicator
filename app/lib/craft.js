// 写法规则(prompts/craft_rules.md):从高手文案里学来的论点、开头、留存、互动、幽默规则。
// 按本篇的赛道和目标语言筛选:通用 + 本赛道 + 本语言;状态「确认」的当要求,其余当建议(不拦稿)。
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'prompts', 'craft_rules.md');
// 规则表里的赛道名 → 程序的赛道 key(final_tracks/*.md)
const TRACK_ALIAS = { pov: 'pov', 'pov 与等级沉浸': 'pov', 经济: 'econ', 经济拆账: 'econ', 历史: 'history', 历史与古人: 'history', 科普: 'science', 心理与动物科普: 'science', 通用: 'general' };
// 赛道证据卡名 → 赛道 key
const CARD_TRACK = { 'POV 与等级沉浸': 'pov', 经济拆账: 'econ', 历史与古人: 'history', 心理与动物科普: 'science' };
const TRACK_KEYS = ['econ', 'history', 'science', 'pov', 'general'];
const LANG_ALIAS = [[/korean|韩|한국/i, '韩语'], [/english|英/i, '英语'], [/japanese|日/i, '日语'], [/chinese|中文|汉语/i, '中文']];

function loadRules() {
  let text = '';
  try { text = fs.readFileSync(FILE, 'utf-8'); } catch (e) { return []; }
  const rows = [];
  text.split('\n').forEach(l => {
    if (!/^\s*\|/.test(l) || /^\s*\|[\s:|-]+\|\s*$/.test(l)) return;
    const c = l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim());
    if (c.length < 5 || c[0] === '编号') return;
    rows.push({ id: c[0], dim: c[1], rule: c[2], scope: c[3], status: c[4], evidence: c[5] || '' });
  });
  return rows;
}

function langOf(run) {
  const l = String(((run || {}).audience || {}).target_language || '');
  const hit = LANG_ALIAS.find(([re]) => re.test(l));
  return hit ? hit[1] : l;
}
// 本篇的赛道:建任务时锁定的 > 任务的赛道 > 写前分析匹配到的证据卡
function trackOf(run) {
  if (!run) return 'general';
  if (TRACK_KEYS.includes(run.review_track)) return run.review_track;
  if (TRACK_KEYS.includes(run.track)) return run.track;
  return CARD_TRACK[run.track_card_name] || 'general';
}

function applies(r, track, lang) {
  const s = r.scope.replace(/\s+/g, '');
  if (/^通用$/.test(s)) return true;
  let m;
  if ((m = s.match(/^赛道[:：](.+)$/))) return m[1].split('/').some(n => TRACK_ALIAS[n.toLowerCase()] === track || TRACK_ALIAS[n] === track);
  if ((m = s.match(/^语言[:：](.+)$/))) return m[1].split('/').some(n => n === lang);
  return false;
}

function rulesFor(run, trackKey) {
  const track = trackKey || trackOf(run), lang = langOf(run);
  return loadRules().filter(r => applies(r, track, lang)).map(r => ({ ...r, must: /^确认/.test(r.status) }));
}

// 发给 AI 的【写法规则】;没有适用的规则返回空字符串
// mode='review'(审稿、复审、补改):全部只作参考,不按它扣分、不列为问题
function craftBrief(run, trackKey, mode) {
  const rs = rulesFor(run, trackKey);
  if (!rs.length) return '';
  if (mode === 'review') return '【写法规则(只供参考)】(从同类爆款里学来的写法。审稿时不按这些规则扣分,也不把没做到的规则列为问题;只有本来就违反了评分维度的才按评分维度处理)\n'
    + rs.map(r => '- [' + r.id + ' ' + r.dim + '] ' + r.rule).join('\n');
  return '【写法规则】(从同类爆款里学来的写法。标「要求」的必须做到;标「建议」的能做到就做,做不到不要硬凑,也不要为了套规则改动事实和论点)\n'
    + rs.map(r => '- [' + r.id + ' ' + r.dim + '|' + (r.must ? '要求' : '建议') + '] ' + r.rule).join('\n');
}

module.exports = { loadRules, rulesFor, craftBrief, trackOf, langOf };
