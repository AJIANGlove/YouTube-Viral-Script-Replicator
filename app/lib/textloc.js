// 脚本文本定位与替换的共享工具(从 fingerprint.js 抽出的纯函数,行为不变)
// 供指纹检测(fingerprint.js)与商业化检查(compliance.js)两个外挂模块共用;
// 替换 = 以「CH 章节标签 + 原句精确文本」双锚点定位,段内精确替换,失败项不猜不动。
// 本模块不认识 HTTP、store 与 LLM。
// 与 pipeline/spliceOpening 相同的章节标签行格式:[CH01 | 0:00-0:32 | promise_setup]
const CH_TAG_LINE = /^\[CH(\d+)\s*\|[^\]]*\]$/;

// ---------- 章节切分 ----------
// 返回 [{ tag: 'CH01', start, end }] — start/end 为该章(含标签行)在全文中的字符区间;
// 标签行之前的前缀(如 "Optimized Script" 标题)作为 tag 为 null 的一段返回。
function splitChapters(script) {
  const lines = script.split('\n');
  const offsets = [];
  let pos = 0;
  lines.forEach((l, i) => { offsets.push(pos); pos += l.length + 1; });
  const tags = [];
  lines.forEach((l, i) => {
    const m = l.trim().match(CH_TAG_LINE);
    if (m) tags.push({ tag: 'CH' + m[1], lineIdx: i, offset: offsets[i] });
  });
  if (!tags.length) return [{ tag: null, start: 0, end: script.length }];
  const sections = [];
  if (tags[0].offset > 0) sections.push({ tag: null, start: 0, end: tags[0].offset });
  tags.forEach((t, i) => {
    const end = i + 1 < tags.length ? tags[i + 1].offset : script.length;
    sections.push({ tag: t.tag, start: t.offset, end });
  });
  return sections;
}

function chapterOf(script, sections, index) {
  for (const s of sections) { if (index >= s.start && index < s.end) return s.tag; }
  return null;
}

// ---------- 替换:双锚点(章节 + 原句精确文本),逐条顺序应用 ----------
// items: [{ id?, chapter, original, suggestion }];从 base 原文重新生成,不做增量叠加
function applyReplacements(script, items) {
  let text = script;
  const replaced = [];
  const failed = [];
  for (const item of items) {
    const original = (item.original || '').trim();
    const suggestion = (item.suggestion || '').trim();
    const fail = reason => failed.push({ id: item.id || null, chapter: item.chapter || null, original, reason });
    if (!original) { fail('原句为空'); continue; }
    if (!suggestion) { fail('改写建议为空'); continue; }
    if (suggestion === original) { fail('改写与原句相同'); continue; }

    const sections = splitChapters(text);
    // 定位目标章节:指定了 chapter 就在该章内找;未指定(或文中无章节)退化为全范围
    let scope = { start: 0, end: text.length };
    if (item.chapter) {
      const sec = sections.find(s => s.tag === item.chapter);
      if (!sec) { fail('未找到章节 ' + item.chapter); continue; }
      scope = sec;
    }
    const within = text.slice(scope.start, scope.end);
    if (!within.includes(original)) { fail('未在指定位置找到原句(可能已被前序替换改动)'); continue; }
    const count = within.split(original).length - 1;
    // 同一句在本章出现多处时全部替换(同一指纹不应留一半),替换次数记入日志
    const newWithin = within.split(original).join(suggestion);
    text = text.slice(0, scope.start) + newWithin + text.slice(scope.end);
    replaced.push({ id: item.id || null, chapter: item.chapter || null, original, replacement: suggestion, occurrences: count });
  }
  return { result: text, replaced, failed };
}

module.exports = { CH_TAG_LINE, splitChapters, chapterOf, applyReplacements };
