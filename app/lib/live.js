// v1.99 正在调用哪个模型(用户 2026-11-05:进行中的提示旁边要能看到这一步用的是什么模型,好及时调整)
// 只记在内存里:调用开始记一条,结束删掉;页面轮询任务时一起带回去
const calls = new Map();
let seq = 0;
function start(runId, label, cfg) {
  if (!runId) return 0;
  const id = ++seq;
  calls.set(id, { runId, label: String(label || ''), model: (cfg && cfg.model) || '', provider: (cfg && cfg.provider) || '', at: Date.now() });
  return id;
}
function end(id) { if (id) calls.delete(id); }
function list(runId) {
  return [...calls.values()].filter(c => c.runId === runId).map(c => ({ label: c.label, model: c.model, provider: c.provider, secs: Math.round((Date.now() - c.at) / 1000) }));
}
module.exports = { start, end, list };
