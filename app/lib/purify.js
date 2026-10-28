// 旁白纯净:目标语言不是中文/日文时,去掉稿子里混进的汉字和日文假名。
// 先按规则修(checks.cleanForeignScript),剩下的整行交给模型改写(prompts/foreign_fix.md);
// 改不掉的原样保留,写进日志给人看,不阻断流程。
const fs = require('fs');
const path = require('path');
const checks = require('./checks');

const PROMPT = path.join(__dirname, '..', 'prompts', 'foreign_fix.md');
const fill = (t, vars) => t.replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));

// ask(prompt) => Promise<模型输出文本>;不给 ask 就只做规则修正
async function purifyScript(text, audience, ask) {
  const aud = audience || {};
  const r1 = checks.cleanForeignScript(text, aud.target_language);
  const log = { fixed: r1.fixed, rewritten: [], left: r1.left };
  if (!r1.left.length || !ask) return { text: r1.text, log };
  let content = '';
  try {
    content = await ask(fill(fs.readFileSync(PROMPT, 'utf-8'), {
      target_language: aud.target_language || '目标语言', target_country: aud.target_country || '',
      lines: r1.left.map((l, i) => (i + 1) + '. ' + l.text).join('\n')
    }));
  } catch (e) { log.error = e.message; return { text: r1.text, log }; }
  const lines = r1.text.split('\n');
  const parts = String(content || '').split(/^===\s*LINE\s*(\d+)\s*===\s*$/m);
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const L = r1.left[Number(parts[i]) - 1];
    if (!L) continue;
    const nl = parts[i + 1].replace(/===\s*END\s*===[\s\S]*$/, '').trim().split('\n').map(s => s.trim()).filter(Boolean).join(' ');
    if (/^[(（]\s*删除\s*[)）]?$/.test(nl)) {
      // 只删真不是旁白的行(大半是中文);正常旁白不许整行删
      if (checks.isMetaNoteLine(L.text, aud.target_language)) { lines[L.line] = null; log.rewritten.push({ before: L.text, after: '' }); }
      continue;
    }
    // 改完还带外文字符、空了、或长度离谱(超过原句两倍):不采用
    if (!nl || /[぀-ヿ㐀-鿿豈-﫿]/.test(nl) || nl.length > L.text.length * 2 + 20) continue;
    const indent = (lines[L.line].match(/^\s*/) || [''])[0];
    lines[L.line] = indent + nl;
    log.rewritten.push({ before: L.text, after: nl });
  }
  const out = lines.filter(l => l !== null).join('\n').replace(/\n{3,}/g, '\n\n');
  log.left = checks.foreignLines(out);
  return { text: out, log };
}

// 日志是否值得留(有修改或有剩余)
const hasLog = log => !!(log && (log.fixed.length || log.rewritten.length || log.left.length || log.error));

module.exports = { purifyScript, hasLog };
