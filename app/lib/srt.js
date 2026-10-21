'use strict';

// 解析 SRT 字幕为 [{ index, start, end, text }]
// text 为该条目多行合并后的单行文本（不含序号与时间轴）
function parseSrt(text) {
  if (!text) return [];
  const cues = [];
  const blocks = String(text).replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    let i = 0;
    if (/^\d+$/.test(lines[i])) i++;
    const tm = lines[i];
    if (!tm || !tm.includes('-->')) continue;
    const [start, end] = tm.split('-->').map(s => s.trim().split(' ')[0]);
    cues.push({ index: cues.length + 1, start, end, text: lines.slice(i + 1).join(' ') });
  }
  return cues;
}

module.exports = { parseSrt };
