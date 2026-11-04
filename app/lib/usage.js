// v1.85 记录 token 用量:每次调用 AI 的输入、输出、缓存 token 累加到 run.usage(按步骤汇总)。
// 调用记录 run.attempts 只留最近 100 条(一篇常有 70–100 次调用),所以另记一份累计数,不会被截掉。
// 渠道没返回用量时按字数估算(est),页面上标「估算」。
const STEP_RULES = [
  [/^Step 2\b.*/, 'Step 2 写稿'],
  [/^中文对照.*/, '中文对照'],
  [/^建任务前预判·.*/, null] // 预判的子步骤保留原名
];
// 同一步的续写、重试、被拒重试、分章、第 n 次,并成一组
function stepOf(label) {
  let s = String(label || '').trim();
  for (const [re, name] of STEP_RULES) if (re.test(s)) return name || s.replace(/(续写|重试|·被拒重试|JSON 重试|结构重试)\s*\d*$/g, '').trim();
  s = s.replace(/[((]第\s*\d+\s*次[))]/g, '')
    .replace(/(·被拒重试\d*|续写\d*|重试\d*|JSON 重试|结构重试|·补评分)+$/g, '')
    .replace(/\s+(CH|FS)\d+\b.*$/, '')
    .trim();
  return s || '其他';
}
const ZERO = () => ({ calls: 0, in: 0, out: 0, cache_read: 0, cache_write: 0, est_calls: 0 });
function addTo(b, u) {
  b.calls++; b.in += u.in || 0; b.out += u.out || 0; b.cache_read += u.cache_read || 0; b.cache_write += u.cache_write || 0;
  if (u.est) b.est_calls++;
}
// 记一次调用:run.usage = { total, steps: { 步骤: {...} }, since }
function record(run, label, u) {
  if (!run || !u) return;
  const us = run.usage && typeof run.usage === 'object' ? run.usage : (run.usage = { since: new Date().toISOString(), total: ZERO(), steps: {} });
  us.total = us.total || ZERO(); us.steps = us.steps || {};
  const k = stepOf(label);
  addTo(us.total, u);
  addTo(us.steps[k] = us.steps[k] || ZERO(), u);
}
// 同一任务在内存和盘上各有一份时,取记得多的那份(两路调用同时跑时不互相盖掉)
function newer(a, b) {
  const n = x => (x && x.total && x.total.calls) || 0;
  const w = n(a) >= n(b) ? a : b;
  return w ? JSON.parse(JSON.stringify(w)) : undefined;
}
// 把另一份用量并进来(建任务前预判的用量并进新任务,步骤名前加前缀)
function merge(run, other, prefix) {
  if (!run || !other || !other.steps) return;
  Object.entries(other.steps).forEach(([k, b]) => {
    const us = run.usage && typeof run.usage === 'object' ? run.usage : (run.usage = { since: new Date().toISOString(), total: ZERO(), steps: {} });
    const key = (prefix || '') + k;
    const t = us.steps[key] = us.steps[key] || ZERO();
    ['calls', 'in', 'out', 'cache_read', 'cache_write', 'est_calls'].forEach(f => { t[f] += b[f] || 0; us.total[f] += b[f] || 0; });
  });
}
// 调用记录里每条带的 token 字段
function attemptFields(u) {
  if (!u) return {};
  return { in_tok: u.in || 0, out_tok: u.out || 0, ...(u.cache_read ? { cache_read: u.cache_read } : {}), ...(u.cache_write ? { cache_write: u.cache_write } : {}), ...(u.est ? { tok_est: true } : {}) };
}
// 按字数估 token:中日韩字大约 1 字 1 token 弱,其他文字大约 4 个字符 1 token
function estTokens(text) {
  const s = String(text || '');
  const cjk = (s.match(/[぀-ヿ㐀-鿿가-힯豈-﫿]/g) || []).length;
  return Math.ceil(cjk * 0.9 + (s.length - cjk) / 4);
}
function estimate(messages, content) {
  const inText = (Array.isArray(messages) ? messages : []).map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')).join('\n');
  return { in: estTokens(inText), out: estTokens(content), cache_read: 0, cache_write: 0, est: true };
}
// 渠道返回的用量 → 统一格式(in 是没走缓存的输入)
function fromAnthropic(u) {
  if (!u) return null;
  return { in: Number(u.input_tokens) || 0, out: Number(u.output_tokens) || 0, cache_read: Number(u.cache_read_input_tokens) || 0, cache_write: Number(u.cache_creation_input_tokens) || 0 };
}
function fromOpenAI(u) {
  if (!u) return null;
  const cached = Number(((u.prompt_tokens_details || {}).cached_tokens) || u.cached_tokens || 0);
  return { in: Math.max(0, (Number(u.prompt_tokens) || 0) - cached), out: Number(u.completion_tokens) || 0, cache_read: cached, cache_write: 0 };
}
module.exports = { newer, stepOf, record, merge, attemptFields, estimate, estTokens, fromAnthropic, fromOpenAI, ZERO };
