// 选题推荐:结合所选框架的关键资产字段(标题公式/选题宜忌/受众心理),为指定赛道生成 1 个板块 × 5 条"中文+目标语言"选题。
// 与四阶段生成管线解耦:仅复用 pipeline 的 loadTweakConfig/llmCall(走「微调按钮」配置),不触碰 runGeneration;不落盘、不进任务系统。
const fs = require('fs');
const path = require('path');
const store = require('./store');
const checks = require('./checks');
const { loadTweakConfig, llmCall } = require('./pipeline');

const TOPICS_TPL_PATH = path.join(__dirname, '..', 'prompts', 'topics.md');
const MAX_EXCLUDE = 50; // 注入 prompt 的去重名单上限(防 token 膨胀)

// 通用 {{key}} 填充。不复用 pipeline.fillTemplate(其变量集固定且耦合查重工具),保持本模块独立。
function fill(tpl, vars) {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll('{{' + k + '}}', v == null || v === '' ? '(无)' : String(v));
  }
  return out;
}

// 从 framework.json 提取选题推荐所需字段(getAsset 返回的 framework 是字符串,需解析)
function frameworkFields(asset) {
  let fw;
  try { fw = JSON.parse(asset.framework); } catch (e) { throw new Error('framework.json 解析失败: ' + e.message); }
  const d = fw.data || {};
  const t = d.transferability || {};
  const ap = d.audience_psychology || {};
  const meta = asset.meta || {};
  return {
    framework_name: meta.name || d.name || asset.id,
    title_formula: (d.title_hook_contract || {}).title_formula || '(未定义)',
    source_title: meta.source_title || '',
    source_title_zh: meta.source_title_zh || '',
    best_topic_traits: JSON.stringify(t.best_topic_traits || [], null, 2),
    avoid_topic_traits: JSON.stringify(t.avoid_topic_traits || [], null, 2),
    audience_psychology: JSON.stringify({
      target_identity_traits: ap.target_identity_traits || [],
      pain_points: ap.pain_points || [],
      desires: ap.desires || [],
      click_triggers: ap.click_triggers || []
    }, null, 2)
  };
}

// 去重名单 = 同框架已提交任务的 topic(跨框架不排除)+ 前端当前批次(仅当次请求临时加入,不留存)
function buildExcludeList(assetId, currentBatch) {
  const fromRuns = store.listRuns()
    .filter(r => r.asset_id === assetId && r.topic)
    .map(r => r.topic);
  return [...new Set([...(currentBatch || []), ...fromRuns])].slice(0, MAX_EXCLUDE);
}

// 容错解析 LLM 输出:剥围栏 → 提取花括号区间 → 结构校验 → 截断/兜底
function parseTopicsJson(raw) {
  const stripped = checks.stripFence(raw);
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('输出中未找到 JSON 对象');
  let obj;
  try { obj = JSON.parse(stripped.slice(start, end + 1)); }
  catch (e) { throw new Error('JSON 解析失败: ' + e.message); }
  if (!obj || typeof obj.module !== 'string' || !obj.module.trim()) throw new Error('缺少 module 字段');
  if (!Array.isArray(obj.topics)) throw new Error('topics 字段不是数组');
  const topics = obj.topics
    .filter(t => t && typeof t.zh === 'string' && typeof t.target === 'string' && t.zh.trim() && t.target.trim())
    .map(t => ({ zh: t.zh.trim(), target: t.target.trim() }));
  if (topics.length < 3) throw new Error('有效选题不足 3 条(实际 ' + topics.length + ' 条)');
  return { module: obj.module.trim(), topics: topics.slice(0, 5) };
}

async function suggestTopics({ asset_id, track, audience, current_batch }) {
  const asset = store.getAsset(asset_id);
  if (!asset) throw new Error('资产不存在: ' + asset_id);
  const cfg = loadTweakConfig(); // 微调按钮配置,每次现取,设置页改动即时生效
  if (!cfg || !cfg.api_key) throw new Error('未配置微调按钮的 API Key,请在设置页「微调按钮 API 配置」中选择有效渠道');
  const a = audience || {};
  const exclude = buildExcludeList(asset_id, current_batch);
  const tpl = fs.readFileSync(TOPICS_TPL_PATH, 'utf-8');
  const prompt = fill(tpl, {
    ...frameworkFields(asset),
    track,
    target_language: a.target_language || 'English',
    target_country: a.target_country || 'US',
    target_audience: a.target_audience || '',
    exclude_titles: exclude.length ? exclude.map(t => '- ' + t).join('\n') : '(无)'
  });

  // 首轮 + 不合格反馈重试 1 次;网络层失败由 llmCall 内部重试,此处最多再补一轮
  const messages = [{ role: 'user', content: prompt }];
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let r;
    try { r = await llmCall(cfg, messages, '选题推荐'); }
    catch (e) { lastErr = e; continue; }
    try { return parseTopicsJson(r.content); }
    catch (e) {
      lastErr = e;
      messages.push({ role: 'assistant', content: r.content });
      messages.push({ role: 'user', content: '上次输出不合格: ' + e.message + '。请重新输出,只输出符合格式要求的 JSON,不要输出任何解释。' });
    }
  }
  throw new Error('选题推荐失败: ' + lastErr.message);
}

module.exports = { suggestTopics };
