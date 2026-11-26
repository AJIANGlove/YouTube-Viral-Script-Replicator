// v1.134 文案总标准(prompts/script_standard.md):写稿、重写、检查都拿同一份标准量。
// text('ABCD') 取其中几部分塞进提示词;items() 给检查结果按编号显示名字。
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '..', 'prompts', 'script_standard.md');

// 本地修补(2026-11-26):Windows 下文件是 CRLF,而下面 items()/sections() 的正则用 `.`+`$` 断言行尾,
// `.` 不匹配 \r 会导致 items() 返回 0 条(标准等于没生效)。读入时统一成 LF,不改语义。
function raw() { try { return fs.readFileSync(FILE, 'utf-8').replace(/\r\n?/g, '\n'); } catch (e) { return ''; } }
function sections() {
  const out = {};
  let cur = null;
  raw().split('\n').forEach(l => {
    const m = l.match(/^##\s+([A-E])\s/);
    if (m) { cur = m[1]; out[cur] = [l]; return; }
    if (cur) out[cur].push(l);
  });
  return out;
}
// parts:要哪几部分,例如 'ABCD';没传就是 A–D(E 是流程,写稿的 AI 不用看)
function text(parts) {
  const s = sections();
  const keys = String(parts || 'ABCD').toUpperCase().split('').filter(k => s[k]);
  if (!keys.length) return '';
  return keys.map(k => s[k].join('\n').trim()).join('\n\n');
}
function items() {
  const out = [];
  raw().split('\n').forEach(l => {
    const m = l.match(/^-\s+\*\*([A-E]\d+)\s+([^*]+)\*\*[::]?\s*(.*)$/);
    if (m) out.push({ id: m[1], name: m[2].trim(), desc: m[3].trim() });
  });
  return out;
}
function nameOf(id) {
  const k = String(id || '').toUpperCase().match(/[A-E]\d+/);
  const it = k && items().find(x => x.id === k[0]);
  return it ? it.id + ' ' + it.name : '';
}
// 提示词里的 {{standard}} / {{standard:BD}} 统一换成标准原文
function fill(tpl) {
  return String(tpl).replace(/\{\{standard(?::([A-E]+))?\}\}/g, (_, p) => text(p || 'ABCD'));
}

module.exports = { text, items, nameOf, fill, FILE };
