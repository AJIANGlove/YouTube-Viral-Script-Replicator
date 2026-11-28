// 审稿赛道清单(唯一一处):终审赛道配置 prompts/final_tracks/<key>.md、写法规则范围、频道方向下拉、开头规则都按这里认赛道。
// 加一个赛道:这里加 key 和中文名 → 写 prompts/final_tracks/<key>.md(MATCH 对上 track_cards.md 的卡名)→ track_cards.md 加一张卡
//   → 需要的话在 craft_rules.md 用「赛道:<ALIAS 里的名字>」给它挂规则。下拉、/api/assets 都从这里取,不用再改页面。
// v1.137 加「历史悬疑」「企业与系统兴衰」(key 沿用框架分类 asset_categories.json 的 history_mystery / national_history)
const TRACK_KEYS = ['econ', 'history', 'science', 'pov', 'history_mystery', 'national_history', 'general'];
const TRACK_NAMES = { econ: '经济拆账', history: '历史与古人', science: '心理与动物科普', pov: 'POV 与等级沉浸', history_mystery: '历史悬疑', national_history: '企业与系统兴衰', general: '通用' };
module.exports = { TRACK_KEYS, TRACK_NAMES };
