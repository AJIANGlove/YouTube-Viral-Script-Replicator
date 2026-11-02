// 章节标签行归一化:只剥离「整行独占标签」两侧的 Markdown 装饰,[] 内字节一律原样保留。
// 规范形态(下游唯一认的形态):[CH01 | 0:00-0:41 | promise_setup]
//
// 背景:Step4 优化阶段的模型偶尔把标签行写成 **[CH01 | 0:00-0:53 | xxx]**,而下游解析器
// (checks.parseChapters / opening.CH_TIME_LINE / textloc.CH_TAG_LINE / boost.spliceChapters)
// 都要求标签整行独占且不带修饰 —— 行尾的 ** 夹在 ] 与换行之间,会让整篇文案解析出 0 章,
// 表现为「该版本无章节时间戳标签,无法强化」「该版本无章节时间戳,无法按 30 秒口径检查」。
//
// 本模块是唯一的归一化实现,不 require 任何项目模块(store 会在模块加载期 require 它)。
// 不做:时间格式改写(如 0:00-0:30 重排;只把 ~ 〜 至 这类分隔符换成 -)、标签行删除、标签内部空白整理、正文任何改动。
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

// 时间段分隔符(v1.62):模型偶尔把「0:00-1:47」写成「0:00~1:47」「0:00〜1:47」「0:00 至 1:47」,
// 下游解析器只认 - – —,整章被判「标签格式不合法」,逐章写稿每次重试都原样失败(实测 [CH01 | 0:00~1:47 | paradox_hook])。
// 只改两个时间之间的分隔符,别的字一律不动。
const TIME = '\\d{1,2}:\\d{2}(?::\\d{2})?';
const ODD_SEP_RE = new RegExp('(' + TIME + ')[ \\t]*(?:~|〜|～|∼|〰|至|到)[ \\t]*(' + TIME + ')', 'g');
function normalizeTimeSep(text) {
  if (typeof text !== 'string') return text;
  return text.replace(ODD_SEP_RE, '$1-$2');
}
const TAG_RE = new RegExp(TAG, 'g');

function normalizeChapterTags(text) {
  if (typeof text !== 'string' || text.indexOf('[CH') === -1) return text; // 快路径:绝大多数文本直接返回
  // 标签行里的时间分隔符统一成「-」(只动 [CH… ] 里面,正文不动)
  return text.replace(TAG_LINE_RE, '$1$2').replace(TAG_RE, t => normalizeTimeSep(t));
}

// 蓝图章节编号(v1.66):下游只认 CH01、CH02…(写稿标签、分章截取、各解析器都是 [CHnn |)。
// 实测 run_cb26dc06a1f8:蓝图把 14 章编号写成原片段编号 FS01–FS14,逐章写稿每次都「模型没有输出 FS01 的章节标签」,重试多少次都一样。
// 编号都是 CHnn、不重复、从小到大的,一个字都不动;否则按位置改成 CH01…CHnn,只换 id,别的字段和内容都不动。
// 返回 { text, fixed }:fixed 为 null 表示没改;改了时 fixed = { from: [...], to: [...] }
function parseBlueprintJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try { return JSON.parse(t); } catch (e) {}
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch (e) {} }
  return null;
}
function chapterIdsOk(chapters) {
  let prev = 0;
  const seen = new Set();
  for (const c of chapters) {
    const m = /^CH(\d+)$/.exec(String((c || {}).id || ''));
    if (!m || seen.has(m[1]) || +m[1] <= prev) return false;
    seen.add(m[1]); prev = +m[1];
  }
  return true;
}
function normalizeChapterIds(text) {
  if (typeof text !== 'string' || !text.trim()) return { text, fixed: null };
  const bp = parseBlueprintJson(text);
  const chs = bp && Array.isArray(bp.chapters) ? bp.chapters : null;
  if (!chs || !chs.length || chapterIdsOk(chs)) return { text, fixed: null };
  const from = chs.map(c => String((c || {}).id || ''));
  const to = chs.map((c, i) => 'CH' + String(i + 1).padStart(2, '0'));
  chs.forEach((c, i) => { if (c && typeof c === 'object') c.id = to[i]; });
  return { text: JSON.stringify(bp, null, 2), fixed: { from, to } };
}
// 页面提示用:「FS01–FS14」这种首尾写法
function idRange(ids) { const xs = (ids || []).map(x => x || '(空)'); return xs.length > 1 ? xs[0] + '–' + xs[xs.length - 1] : (xs[0] || ''); }

module.exports = { normalizeChapterTags, normalizeTimeSep, normalizeChapterIds, idRange };
