// v1.94「赛道」页(只读):把程序实际在用的赛道规则拼成一份给人看。
// 不另存一份规则:每次都从程序读的那几个文件现读(终审赛道配置 final_tracks/*.md、写法规则 craft_rules.md、
// 赛道证据卡 track_cards.md、赛道默认口气 voices/_track_*.json),所以页面显示的就是程序用的,不会对不上。
// 改规则不在页面上改:用户说给 Claude,改代码同步。
const craft = require('./craft');
const voice = require('./voice');

const LANG_NAME = { ko: '韩语', en: '英语', ja: '日语', zh: '中文' };
// 论点卡现在所有赛道共用一种形状(写前分析 analysis.md 的 thesis_card)
const THESIS_FIELDS = [
  ['viewer_belief', '观众原来以为的'],
  ['truth', '本片要讲的真相'],
  ['one_line_thesis', '一句话论点'],
  ['ending_landing', '结尾落在哪'],
  ['contrast', '反差有多大:翻案 / 揭示 / 只是加强已有印象'],
  ['double_standard', '同事不同命(没有就写「无」)'],
  ['boundary', '论点不适用于谁']
];

function trackView(key) {
  const review = require('./review');
  const an = require('./analysis');
  const tr = review.loadTrack(key);
  let card = null;
  try { card = (an.loadTrackCards ? an.loadTrackCards() : []).find(c => c.name === tr.match) || null; } catch (e) { card = null; }
  const rules = craft.rulesForTrackView(tr.key);
  const voices = voice.listTrackDefaults().filter(v => v.track === tr.key).map(v => ({ lang: LANG_NAME[v.lang] || v.lang, ...v.voice }));
  return {
    key: tr.key, name: tr.name, audience: tr.audience, position: tr.position, retention: tr.retention,
    mechanism: tr.mechanism, dim4_name: tr.dim4_name, dim4: tr.dim4,
    dims: ['框架与结构', '核心矛盾', '信息递进', tr.dim4_name, '留存与承诺兑现', '目标国家母语口播', '结尾完整性与整体一致性'],
    deai_protect: tr.deai_protect, deai_focus: tr.deai_focus,
    card: card ? card.text.replace(/^【[^】]*】\n?/, '') : '',
    thesis_fields: THESIS_FIELDS.map(([k, label]) => ({ key: k, label })),
    thesis_note: '现在所有赛道共用这一种论点卡(「观众以为 / 真相是」)。按赛道换形状是第二批要改的。',
    rules, voices
  };
}

function allTracks() {
  return require('./review').TRACK_KEYS.map(trackView);
}

module.exports = { trackView, allTracks };
