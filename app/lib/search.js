// 联网搜索:只在写前分析的「AI 先调整」「我的意见」里用。
// 流程:AI 先列查询 → 程序调搜索取前 N 条(权威、较新的优先)→ AI 只能用结果里的内容填,带链接和日期。
// 普通对话接口不会自动联网,所以这里由程序显式调用。按次计费(见设置页说明),一次调整最多 MAX_QUERIES 个查询。
// 渠道做成适配器:不同搜索服务的路径、鉴权、请求体、返回字段都不一样,这里统一映射成
// { title, url, site, date, authority, score, summary }。当前只接了 DeepSeek,新增渠道往 ADAPTERS 里加一项即可。
// pipeline 延迟加载(pipeline → analysis → search 有循环依赖)
const pl = () => require('./pipeline');

const SEARCH_TIMEOUT_MS = 60 * 1000;
const MAX_QUERIES = 8;
const SUMMARY_MAX = 700;
const QUOTE_MAX = 240; // 落盘的原文摘录长度
const DEFAULT_PROVIDER = 'deepseek';

const ADAPTERS = {
  // POST https://api.deepseek.com/v1/tools/search
  // 请求:{ query, count(1-50), ori_question?, need_content }
  // 返回:{ results: [{ title, url, site_name, date, authority(0-4), rerank_score(0-3), summary, snippet }] }
  deepseek: {
    name: 'DeepSeek',
    default_base: 'https://api.deepseek.com',
    path: '/v1/tools/search',
    build: (q, s, ori) => Object.assign(
      { query: q, count: Math.max(s.count * 2, 8), need_content: false },
      ori ? { ori_question: String(ori).slice(0, 128) } : {}
    ),
    headers: key => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }),
    parse: data => (Array.isArray(data && data.results) ? data.results : []).map(r => ({
      title: r.title || '',
      url: r.url || '',
      site: r.site_name || '',
      date: (r.date || '').slice(0, 10),
      authority: r.authority,
      score: r.rerank_score,
      summary: String(r.summary || r.snippet || '')
    }))
  }
};

function channels() {
  return Object.keys(ADAPTERS).map(id => ({ id, name: ADAPTERS[id].name }));
}

function adapterOf(id) {
  return ADAPTERS[id] || ADAPTERS[DEFAULT_PROVIDER];
}

// config.json 里的 search 块:
//   { enabled, provider: 'deepseek', count: 5, api_key?, base_url?, channels: { deepseek: { api_key?, base_url? } } }
// 取值顺序:channels[渠道] → search 顶层 → providers[同名渠道] → 适配器默认值
function searchConfig(cfg) {
  cfg = cfg || pl().loadConfig() || {};
  const s = cfg.search || {};
  const providerId = ADAPTERS[s.provider] ? s.provider : DEFAULT_PROVIDER;
  const ad = ADAPTERS[providerId];
  const ch = (s.channels || {})[providerId] || {};
  const preset = (cfg.providers || {})[providerId] || {};
  const key = ch.api_key || s.api_key || preset.api_key || '';
  return {
    enabled: !!s.enabled,
    provider: providerId,
    provider_name: ad.name,
    base_url: (ch.base_url || s.base_url || preset.base_url || ad.default_base).replace(/\/+$/, ''),
    api_key: /YOUR_API_KEY/.test(key) ? '' : key,
    count: Math.min(Math.max(Number(s.count) || 5, 1), 10)
  };
}

function searchStatus(cfg) {
  const s = searchConfig(cfg);
  return {
    enabled: s.enabled, provider: s.provider, provider_name: s.provider_name,
    count: s.count, has_key: !!s.api_key, ready: s.enabled && !!s.api_key,
    channels: channels()
  };
}

// 排序:权威度高的在前,同权威度时日期新的在前,最后看相关度
function rankResults(items) {
  const t = d => { const v = Date.parse(d || ''); return isFinite(v) ? v : 0; };
  return items.slice().sort((a, b) =>
    (Number(b.authority) || -1) - (Number(a.authority) || -1) || t(b.date) - t(a.date) || (Number(b.score) || 0) - (Number(a.score) || 0));
}

async function webSearch(query, oriQuestion, cfg) {
  const s = searchConfig(cfg);
  if (!s.api_key) throw new Error('联网搜索没有可用的 ' + s.provider_name + ' API Key');
  const q = String(query || '').trim().slice(0, 128);
  if (!q) return { query: q, results: [] };
  const ad = adapterOf(s.provider);
  const resp = await pl().postJson(s.base_url + ad.path, ad.headers(s.api_key), ad.build(q, s, oriQuestion), SEARCH_TIMEOUT_MS);
  if (resp.status === 402) throw new Error(s.provider_name + ' 余额不足(HTTP 402),请先充值');
  if (resp.status < 200 || resp.status >= 300) throw new Error('搜索失败 HTTP ' + resp.status + ': ' + (resp.text || '').slice(0, 200));
  let data;
  try { data = JSON.parse(resp.text); } catch (e) { throw new Error('搜索返回的不是 JSON'); }
  const results = rankResults(ad.parse(data)).slice(0, s.count).map(r => Object.assign({}, r, {
    summary: String(r.summary || '').slice(0, SUMMARY_MAX)
  }));
  return { query: q, results };
}

// 依次跑一组查询;单个查询失败只记错,不中断整批。结果统一编号 R1、R2…,方便 AI 引用
async function runQueries(queries, oriQuestion, cfg) {
  const out = [];
  let n = 0;
  for (const item of (Array.isArray(queries) ? queries : []).slice(0, MAX_QUERIES)) {
    const q = typeof item === 'string' ? { query: item } : (item || {});
    try {
      const r = await webSearch(q.query, oriQuestion, cfg);
      r.results.forEach(x => { x.ref = 'R' + (++n); });
      out.push({ ...q, results: r.results });
    } catch (e) {
      out.push({ ...q, results: [], error: e.message });
    }
  }
  return out;
}

// 写进提示词的搜索结果文本
function resultsBrief(batches) {
  if (!batches || !batches.length) return '(本次没有联网搜索)';
  return batches.map(b => '查询「' + b.query + '」' + (b.target ? '(为 ' + b.target + ')' : '') + ':\n' +
    (b.error ? '  搜索出错:' + b.error : (Array.isArray(b.results) && b.results.length)
      ? b.results.map(r => '  [' + r.ref + '] ' + r.title + ' | ' + (r.site || '') + ' | ' + (r.date || '日期不详') + ' | ' + r.url + '\n      ' + r.summary.replace(/\s+/g, ' ')).join('\n')
      : '  (没有结果)')).join('\n');
}

// 把 AI 引用的 R 编号换回链接和日期;引用了不存在的编号就丢掉
function resolveEvidence(refs, batches) {
  const all = {};
  (batches || []).forEach(b => (Array.isArray(b.results) ? b.results : []).forEach(r => { all[r.ref] = r; }));
  return (Array.isArray(refs) ? refs : []).map(x => typeof x === 'string' ? all[x] : (x && all[x.ref]) || null)
    .filter(Boolean).filter((r, i, arr) => arr.findIndex(x => x.url === r.url) === i)
    .map(r => ({ ref: r.ref, title: r.title, url: r.url, date: r.date, site: r.site, quote: String(r.summary || '').replace(/\s+/g, ' ').slice(0, QUOTE_MAX) }));
}

module.exports = { searchConfig, searchStatus, channels, ADAPTERS, webSearch, runQueries, resultsBrief, resolveEvidence, MAX_QUERIES, QUOTE_MAX };
