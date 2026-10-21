// 章节标签行归一化:只剥离「整行独占标签」两侧的 Markdown 装饰,[] 内字节一律原样保留。
// 规范形态(下游唯一认的形态):[CH01 | 0:00-0:41 | promise_setup]
//
// 背景:Step4 优化阶段的模型偶尔把标签行写成 **[CH01 | 0:00-0:53 | xxx]**,而下游解析器
// (checks.parseChapters / opening.CH_TIME_LINE / textloc.CH_TAG_LINE / boost.spliceChapters)
// 都要求标签整行独占且不带修饰 —— 行尾的 ** 夹在 ] 与换行之间,会让整篇文案解析出 0 章,
// 表现为「该版本无章节时间戳标签,无法强化」「该版本无章节时间戳,无法按 30 秒口径检查」。
//
// 本模块是唯一的归一化实现,不 require 任何项目模块(store 会在模块加载期 require 它)。
// 不做:时间格式改写(如 0:00-0:30 重排)、标签行删除、标签内部空白整理、正文任何改动。
// 故意不修(宁可交给严格闸门报错,也不猜):
//   - 行尾带正文的 "**[CH01 | ...]** 说明文字"(删掉会改正文,无法判断该不该删)
//   - 行内代码 `[CH01 | ...]`、有序列表 "1. [CH01 | ...]"
//   - "***[CH01 | ...]***" 三连星、全角「【CH01】」/「［CH01］」/全角竖线(属标签本体被改写)
//   - 纯前后空白缩进的标签行(各解析器已 trim 或未锚定行首,本来就能识别,无需改写)

// 标签本体:从 [CH 到同行的第一个 ],捕获后原样回填
const TAG = '\\[CH\\d+[^\\]\\r\\n]*\\]';
// 行首装饰:可叠加(如 "> ## **"),每层允许前置空白
const DECOR = '(?:[ \\t]*(?:#{1,6}|>|[-*+]|__|\\*\\*))+[ \\t]*';
// 行尾闭合装饰:仅对称的 ** 或 __,其余一律不认
const CLOSE = '(?:[ \\t]*(?:\\*\\*|__))?[ \\t]*';
// 整行锚定:装饰 + 标签 + 闭合装饰 + 可选 \r(CRLF 保留)
const TAG_LINE_RE = new RegExp('^' + DECOR + '(' + TAG + ')' + CLOSE + '(\\r?)$', 'gm');

function normalizeChapterTags(text) {
  if (typeof text !== 'string' || text.indexOf('[CH') === -1) return text; // 快路径:绝大多数文本直接返回
  return text.replace(TAG_LINE_RE, '$1$2');
}

module.exports = { normalizeChapterTags };
