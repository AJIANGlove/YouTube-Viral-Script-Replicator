// 四阶段生成管线:Blueprint → Script → Audit → Optimization
// 步间确定性校验;Step 1 蓝图不合格(JSON 解析失败/输出过短/时长漂移)、Step 2 无章节标记、Step 3 输出非 JSON 时自动反馈重试(各最多 3 次);
// Step 2 max_tokens 截断时退到章节边界续写(上限为 Blueprint 章数 + 2 轮:每轮至少完成一章,写得完且不会无限烧额度)。
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const store = require('./store');
const checks = require('./checks');
const purify = require('./purify');
const textnorm = require('./textnorm');
const retention = require('./retention');
const analysis = require('./analysis');
const voice = require('./voice');
const narration = require('./narration');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

// 传输层:默认流式(stream:true)请求,生成期间字节持续流动,不限制单次调用总时长;
// 空闲上限 10 分钟指"响应流连续 10 分钟无任何新字节"才判定连接死亡(socket 有数据自动重置计时,慢渠道与长思考模型不再被误杀);
// 重试:网络错误/空闲超时/空响应/408/429/5xx 最多重试 3 次(退避 30s→1m→2m),其余 4xx(鉴权/欠费/参数错误)重试无意义直接失败;
// 连通性探测 120 秒(思考型模型留余量,探测仍有界)
const LLM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const LLM_MAX_RETRIES = 3;
const LLM_BACKOFF_MS = [30 * 1000, 60 * 1000, 120 * 1000];
const GATE_MAX_RETRIES = 3;
const PROBE_TIMEOUT_MS = 120 * 1000;

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); }
  catch (e) { return null; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
}

// 从 providers 预设解析出生效连接参数(base_url 去尾斜杠);providerId 缺省取 cfg.provider,未命中返回 null
function resolveProvider(cfg, providerId) {
  const preset = (cfg.providers || {})[providerId || cfg.provider];
  if (!preset) return null;
  return {
    protocol: preset.protocol || 'anthropic',
    base_url: (preset.base_url || '').replace(/\/+$/, ''),
    api_key: preset.api_key || '',
    omit_temperature: !!preset.omit_temperature, // 部分渠道的模型拒收/固定 temperature 字段(如 CloseAI 的 claude-opus-4-8/5、Kimi K3)
    use_max_completion_tokens: !!preset.use_max_completion_tokens // 部分新模型的长度字段名为 max_completion_tokens(如 Kimi K3)
  };
}

// 微调按钮(选题推荐/生成简介/指纹检测/商业化检查/开头留存检查/强化开头)的生效配置:
// 读 tweak 块选择值,逐项回退主配置(旧 config.json 无 tweak 块时行为与现状一致),渠道经 resolveProvider 现解析;
// 渠道未知时 api_key 为空,由调用方按惯例报错
function loadTweakConfig() {
  const cfg = loadConfig();
  if (!cfg) return null;
  const tw = cfg.tweak || {};
  const providerId = tw.provider || cfg.provider;
  const resolved = resolveProvider(cfg, providerId) || { protocol: 'anthropic', base_url: '', api_key: '', omit_temperature: false, use_max_completion_tokens: false };
  return {
    provider: providerId || '',
    ...resolved,
    model: tw.model || cfg.model || '',
    temperature: typeof tw.temperature === 'number' ? tw.temperature : (cfg.temperature ?? 0.7),
    max_tokens: tw.max_tokens || cfg.max_tokens || 8192
  };
}

function loadTemplates() {
  const dir = path.join(__dirname, '..', 'prompts');
  return [1, 2, 3, 4, 5].map(i => fs.readFileSync(path.join(dir, 'step' + i + '.md'), 'utf-8'));
}

// 今天的日期写进提示词:模型不知道今天是哪年,会把旧年份的法定数字(最低工资等)当成现行值
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function fillTemplate(tpl, ctx, tools) {
  const script = ctx.script || '';
  const hits = script ? tools.findOverlaps(script) : [];
  const plag = script
    ? (hits.length ? hits.slice(0, 30).map(g => '- "' + g + '"').join('\n') : '无连续重合(英文等按 6 词、韩中日按 12 字计)。')
    : '(空)';
  const dens = script ? tools.densityLines(script).lines.join('\n') : '(空)';
  return tpl
    .replaceAll('{{today}}', todayStr())
    .replaceAll('{{framework}}', ctx.framework || '(未加载)')
    .replaceAll('{{timeline}}', ctx.timeline || '(未加载)')
    .replaceAll('{{style}}', ctx.style || '(未加载)')
    .replaceAll('{{examples}}', ctx.examples || '(未加载)')
    .replaceAll('{{topic}}', ctx.topic || '(未填写)')
    .replaceAll('{{audience}}', ctx.audience || '(空)')
    .replaceAll('{{blueprint}}', ctx.blueprint || '(空)')
    .replaceAll('{{script}}', script || '(空)')
    .replaceAll('{{audit}}', ctx.audit || '(空)')
    .replaceAll('{{opening_anchor}}', ctx.opening_anchor || '(空)')
    .replaceAll('{{chapters}}', ctx.chapters || '(未指定)')
    .replaceAll('{{chapter_rules}}', ctx.chapter_rules || '')
    .replaceAll('{{analysis}}', ctx.analysis || '(无写前分析,按原流程执行)')
    .replaceAll('{{narration_wpm}}', String(ctx.narration_wpm || tools.targetWpm || ''))
    .replaceAll('{{listen_rules}}', checks.LISTEN_RULES)
    .replaceAll('{{voice}}', ctx.voice || '(未设定频道声音,按 Style 执行)')
    .replaceAll('{{plagiarism_report}}', plag)
    .replaceAll('{{density_report}}', dens);
}

// 由生效配置构造一次对话请求的 url/headers/body(协议与渠道参数差异的唯一出口):
// anthropic/openai 协议、omit_temperature(模型拒收或官方固定 temperature)、use_max_completion_tokens(如 Kimi K3 的长度字段);
// 默认流式(stream:true,两种协议同名字段),opts.stream === false 时关闭(连通性探测保持非流式)
function buildRequest(cfg, messages, opts) {
  const isAnthropic = cfg.protocol === 'anthropic';
  const url = cfg.base_url.replace(/\/+$/, '') + (isAnthropic ? '/v1/messages' : '/v1/chat/completions');
  const headers = { 'Content-Type': 'application/json' };
  if (isAnthropic) { headers['x-api-key'] = cfg.api_key; headers['anthropic-version'] = '2023-06-01'; }
  else headers['Authorization'] = 'Bearer ' + cfg.api_key;
  const body = { model: cfg.model, messages };
  if (!opts || opts.stream !== false) body.stream = true;
  if (!isAnthropic && cfg.use_max_completion_tokens) body.max_completion_tokens = cfg.max_tokens || 8192; // 守卫:仅 openai 协议渠道适用,防标记误配到 anthropic 渠道
  else body.max_tokens = cfg.max_tokens || 8192;
  if (!cfg.omit_temperature) body.temperature = cfg.temperature ?? 0.7; // 渠道标记 omit_temperature 时省略该字段
  return { isAnthropic, url, headers, body };
}

// 传输层:POST JSON 并读完整响应文本(基于 node:http/https,零依赖)。
// 不用全局 fetch:其 undici 默认 headersTimeout=300s 且不可调,K3 等长思考模型会撞超时;
// node:http socket 默认无超时,此处仅设空闲上限(模型思考期间连接静默,必须给足)。
// 不发送 Accept-Encoding(服务端按 identity 原文返回,规避解压差异);不跟随 302(以 HTTP 3xx 显式暴露)。
// 导出仅供连通性探测(probeProvider)与测试复用;LLM 调用的唯一入口仍是 llmCall。
function postJson(url, headers, payload, idleTimeoutMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf-8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(idleTimeoutMs, () => req.destroy(new Error('请求超过 ' + Math.round(idleTimeoutMs / 60000) + ' 分钟无响应(空闲超时)')));
    req.write(body);
    req.end();
  });
}

// SSE 流式响应解析:把 data: 帧拼回完整 content 与 stop_reason。
// 收齐完整响应文本后整体解析(不边收边拼,规避半行/多字节字符截断问题);
// 检测不到 SSE 帧时返回 null(部分中转渠道会忽略 stream 参数直接返回普通 JSON),由调用方回退到 JSON 解析路径。
//
// 多流防护:中转层(lk888 等)在上游中断后重试/续写时,可能把「前一段被截断的流 + 后一段完整流」
// 塞进同一个 HTTP 响应体。旧实现把所有 data: 帧无差别拼接,结果就是终稿里整篇章节重复
// (实测 run_a3cb19c5b8a6:CH11 断在半句后直接重起 CH01,终稿 23 个标签)。
// 现在按流边界分段(anthropic: message_start;openai: [DONE] 或首帧 delta.role),
// 取最长的一段作为结果,并把流数量返回给调用方留痕;真正的结构正确性由 checks.chapterStructureError 二次把关。
function parseSSE(text, isAnthropic) {
  if (!/^data:/m.test(text)) return null;
  const segments = [];
  let cur = { content: '', stopReason: null, sawRole: false };
  const flush = () => {
    if (cur.content) segments.push(cur);
    cur = { content: '', stopReason: null, sawRole: false };
  };
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue; // 跳过 event: 行/心跳空行/注释行
    const payload = t.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') { flush(); continue; } // 一个流的结束
    let d;
    try { d = JSON.parse(payload); } catch (e) { continue; } // 单帧损坏不致命,跳过
    if (isAnthropic) {
      if (d.type === 'message_start') flush(); // 新的一条消息(第一帧时 cur 为空,flush 不产生空段)
      if (d.type === 'content_block_delta' && d.delta && typeof d.delta.text === 'string') cur.content += d.delta.text;
      if (d.type === 'message_delta' && d.delta && d.delta.stop_reason) cur.stopReason = d.delta.stop_reason;
    } else {
      const ch = d.choices && d.choices[0];
      if (ch) {
        // 只有「当前段已产出内容、且本段还没见过 role」时才当作新流起始,避免重复 role 帧把正文切碎
        if (ch.delta && ch.delta.role && cur.content && !cur.sawRole) flush();
        if (ch.delta && ch.delta.role) cur.sawRole = true;
        if (ch.delta && typeof ch.delta.content === 'string') cur.content += ch.delta.content;
        if (ch.finish_reason) cur.stopReason = ch.finish_reason;
      }
    }
  }
  if (cur.content) segments.push(cur);
  if (!segments.length) return { content: '', stopReason: null, streams: 0 };
  const best = segments.reduce((a, b) => (b.content.length > a.content.length ? b : a));
  return { content: best.content, stopReason: best.stopReason, streams: segments.length };
}

// 带状态码的 HTTP 错误,供 isRetryable 分类(不靠字符串匹配)
function httpError(status, text) {
  const e = new Error('HTTP ' + status + ': ' + (text || '').slice(0, 300));
  e.status = status;
  return e;
}

// 可重试:网络错误/空闲超时/空响应/响应解析失败(无 status)、408/429/5xx;
// 不可重试:其余 4xx(400 参数错误、401/403 鉴权与欠费等,重试只会白等)
function isRetryable(e) {
  if (e.status == null) return true;
  if (e.status === 408 || e.status === 429) return true;
  if (e.status >= 400 && e.status < 500) return false;
  return true;
}

async function llmCall(cfg, messages, label) {
  const { isAnthropic, url, headers, body } = buildRequest(cfg, messages);

  let lastErr;
  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, LLM_BACKOFF_MS[Math.min(attempt - 1, LLM_BACKOFF_MS.length - 1)]));
    const t0 = Date.now();
    try {
      const resp = await postJson(url, headers, body, LLM_IDLE_TIMEOUT_MS);
      if (resp.status < 200 || resp.status >= 300) throw httpError(resp.status, resp.text);
      // 优先按 SSE 流式解析;渠道忽略 stream 参数返回普通 JSON 时自动回退
      const sse = parseSSE(resp.text, isAnthropic);
      let content, stopReason, streams = 1;
      if (sse) {
        content = sse.content;
        stopReason = sse.stopReason;
        streams = sse.streams || 1;
      } else {
        const data = JSON.parse(resp.text);
        if (isAnthropic) content = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
        else content = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
        stopReason = data.stop_reason || (data.choices && data.choices[0] && data.choices[0].finish_reason) || null;
      }
      if (!content) throw new Error('空响应');
      // 归一化截断信号:openai 系的 finish_reason='length' 等价于 anthropic 的 'max_tokens'(Step 2 截断续写依赖该标记)
      if (stopReason === 'length') stopReason = 'max_tokens';
      return { content, secs: (Date.now() - t0) / 1000, stopReason, streams };
    } catch (e) {
      lastErr = e;
      if (!isRetryable(e)) break;
    }
  }
  throw new Error(label + ' 共 ' + (LLM_MAX_RETRIES + 1) + ' 次调用均失败: ' + lastErr.message);
}

// 渠道连通性探测:单次调用(不重试),120s 有界;max_tokens 提到 512(思考型模型如 K3 会把 16 全烧在思考上,致 content 为空误判);
// 协议与渠道参数差异(omit_temperature/use_max_completion_tokens)由 buildRequest 统一处理。返回结构即设置页测试按钮的约定响应。
async function probeProvider(cfg) {
  const { isAnthropic, url, headers, body } = buildRequest({ ...cfg, max_tokens: 512, temperature: 0 }, [{ role: 'user', content: 'hi' }], { stream: false });
  const t0 = Date.now();
  try {
    const resp = await postJson(url, headers, body, PROBE_TIMEOUT_MS);
    const latency = Date.now() - t0;
    if (resp.status < 200 || resp.status >= 300) {
      return { ok: false, latency_ms: latency, error: 'HTTP ' + resp.status + ': ' + resp.text.slice(0, 300) };
    }
    const data = JSON.parse(resp.text);
    const hasContent = isAnthropic ? (data.content || []).length > 0 : !!(data.choices && data.choices[0]);
    return { ok: hasContent, latency_ms: latency, model: data.model || body.model, error: hasContent ? undefined : '响应无内容' };
  } catch (e) {
    return { ok: false, latency_ms: Date.now() - t0, error: e.message };
  }
}

// 主流程(异步,不阻塞 HTTP)
// 篇幅:全稿词数对比蓝图 word_budget 合计(蓝图没写预算时按目标时长 × 语速)。上限 115%;
// 下限:低于即不合格(实测 run_61f5f188d286 只写了开头和 CTA,4% 也判通过),低于警告线记警告。
// 韩文按空格数词,同样时长的词数天然只有英文的六成左右(历史完整稿 29%–86%,中位 57%),所以下限单独放低,
// 否则会误伤正常韩文稿;英文完整稿最低 55%,用 50% / 70%
const LENGTH_MAX_RATIO = 1.15;
const FIRST_PAYOFF_MAX = 45; // 秒:第一个答案最晚落点
const LENGTH_MIN = { default: [0.5, 0.7], Korean: [0.25, 0.4] }; // [不合格线, 警告线]
function lengthCheck(script, blueprint, audience, wpm) {
  let budget = 0;
  try { budget = (JSON.parse(checks.stripFence(blueprint || '')).chapters || []).reduce((n, c) => n + (Number(c.word_budget) || 0), 0); } catch (e) {}
  if (!budget) {
    const goal = checks.goalSeconds((audience || {}).video_goal);
    budget = goal && wpm ? Math.round(goal * wpm / 60) : 0;
  }
  if (!budget) return null;
  const words = checks.parseChapters(script || '').reduce((n, c) => n + c.words, 0);
  const ratio = Math.round(words / budget * 100) / 100;
  const [minR, warnR] = LENGTH_MIN[(audience || {}).target_language] || LENGTH_MIN.default;
  const short = ratio < minR;
  const ok = ratio <= LENGTH_MAX_RATIO && !short;
  const warn = !short && ratio < warnR;
  return { words, budget, ratio, ok, ...(short ? { short: true } : {}), ...(warn ? { warn: true } : {}),
    detail: words + ' 词,预算 ' + budget + ' 词(' + Math.round(ratio * 100) + '%' +
      (short ? ',低于下限 ' + Math.round(minR * 100) + '%' : !ok ? ',超过上限 ' + Math.round(LENGTH_MAX_RATIO * 100) + '%' : warn ? ',偏短(低于 ' + Math.round(warnR * 100) + '%)' : '') + ')' };
}

async function runGeneration(runId) {
  const run = store.getRun(runId);
  if (!run) return;
  if (run.checks && run.checks.gate_fail) { delete run.checks.gate_fail; } // 续跑:上次的失败记录作废
  const cfg = loadConfig();
  if (!cfg || !cfg.api_key) {
    run.status = 'failed'; run.error = '未配置 API Key(POST /api/settings)'; store.saveRun(run); return;
  }
  const asset = store.getAsset(run.asset_id);
  if (!asset || !asset.framework) {
    run.status = 'failed'; run.error = '资产不存在: ' + run.asset_id; store.saveRun(run); return;
  }

  const templates = loadTemplates();
  const audienceStr = JSON.stringify(run.audience, null, 2);
  const ctx = {
    framework: asset.framework, timeline: asset.timeline, style: asset.style, examples: asset.examples,
    topic: run.topic, audience: audienceStr,
    // 写前分析经人工确认后才注入四步提示词(未确认/旧任务按原流程)
    analysis: run.analysis_confirmed ? analysis.analysisBrief(run.analysis) : null,
    // 频道声音设定(语体/称呼/自称/固定用语),写稿与优化时注入
    voice: voice.voiceBrief(voice.voiceForRun(run))
  };
  run.voice_used = (voice.voiceForRun(run) || {}).name || null;
  // 篇幅/预算/密度按配音语速算(见 lib/narration.js);原片字幕语速只做参照
  const refAsset = { examples: asset.examples, srt: asset.srt, timeline: asset.timeline };
  const nw = narration.narrationWpm(run, checks.makeRefTools(refAsset).sourceWpm);
  const tools = checks.makeRefTools(refAsset, { wpm: nw.wpm });
  ctx.narration_wpm = nw.wpm;
  run.checks = { ...(run.checks || {}), narration: { ...nw, label: narration.narrationLabel(nw) } };
  // 听感检查(开头 8 秒点题、前 10 秒数字、一句连念 3 个以上数字、语体混用)用的标题
  const listenOpts = () => ({ wpm: nw.wpm, title: (((run.analysis || {}).title || {}).final_title) || run.topic, lang: (run.audience || {}).target_language });

  // 听感闸门:不合格反馈重写一次;重写后结构完好、篇幅没坏、问题更少才采用,否则保留原稿,结果都记进 checks
  const listenGate = async (step, content, messages, r, extract, valid) => {
    const lc = checks.listenCheck(extract(content), listenOpts());
    if (!lc || lc.ok) return { content, r, messages, lc };
    const name = stepNames[step - 1];
    run.steps[name].gate_retry = { reason: '听感检查: ' + lc.issues.join(';'), attempt: 1 };
    store.saveRun(run);
    const feedback = '这份稿子是配音给人听的,听感检查不合格:\n' + checks.listenFeedback(lc) + '\n\n' + checks.LISTEN_RULES +
      '\n\n只改上面点到的句子和开头,其他句子原样保留,不要加长;章节标签和时间范围不变。' +
      (step === 4 ? '只输出一份完整终稿,格式要求不变(Change Log 与 fact_check_list 放在终稿之后)。' : '输出完整脚本,不要解释。');
    const m2 = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: feedback }];
    const r2 = await callLlm(m2, 'Step ' + step + ' 听感重试');
    const c2 = textnorm.normalizeChapterTags(r2.content.trim());
    const lc2 = checks.listenCheck(extract(c2), listenOpts());
    if (r2.stopReason !== 'max_tokens' && lc2 && valid(c2) && checks.listenScore(lc2) < checks.listenScore(lc)) {
      return { content: c2, r: r2, messages: m2, lc: { ...lc2, retried: true, before: lc.issues } };
    }
    return { content, r, messages, lc: { ...lc, retried: true, retry_rejected: true } };
  };

  // 每次 LLM 调用(首轮/闸门重试/截断续写)都记一条流水到 run.attempts(封顶 100 条),失败原因不再随重试丢失
  const logAttempt = (label, result) => {
    run.attempts = [...(run.attempts || []), {
      ts: new Date().toISOString(), label,
      provider: cfg.provider || '', model: cfg.model || '',
      ...result
    }].slice(-100);
    store.saveRun(run);
  };
  const callLlm = async (messages, label) => {
    const t0 = Date.now();
    try {
      const r = await llmCall(cfg, messages, label);
      logAttempt(label, {
        ok: true, secs: Math.round(r.secs * 10) / 10, stop_reason: r.stopReason,
        ...(r.streams > 1 ? { streams: r.streams } : {}) // 中转层把多段流塞进一个响应体时留痕
      });
      return r;
    } catch (e) {
      logAttempt(label, { ok: false, secs: Math.round((Date.now() - t0) / 100) / 10, error: e.message });
      throw e;
    }
  };

  run.status = 'running';
  if (!run.started_at) run.started_at = new Date().toISOString();
  delete run.error;
  delete run.cancel_requested; // 重试/续跑时清除旧的取消标记
  store.saveRun(run);

  // 断点续跑:沿用已完成的产物,从第一个空缺步骤开始
  const outputs = run.outputs || { step1: '', step2: '', step3: '', step4: '' };
  if (outputs.step1) ctx.blueprint = outputs.step1;
  if (outputs.step2) ctx.script = outputs.step2;
  if (outputs.step3) ctx.audit = outputs.step3;
  let startStep = 5;
  for (let n = 1; n <= 4; n++) { if (!outputs['step' + n]) { startStep = n; break; } }
  if (startStep > 4) startStep = 1; // 没有产物则从头跑

  const stepNames = ['blueprint', 'script', 'audit', 'optimized'];

  for (let step = startStep; step <= 4; step++) {
    // 步骤间取消检查:用户在当前步骤执行期间点了取消,则本步不再启动,任务置为已取消
    const fresh = store.getRun(runId);
    if (fresh && fresh.cancel_requested) {
      run.status = 'cancelled';
      run.current_step = step - 1;
      store.saveRun(run);
      return;
    }
    run.current_step = step;
    run.steps[stepNames[step - 1]] = { status: 'running', started_at: new Date().toISOString() };
    store.saveRun(run);
    try {
      const prompt = fillTemplate(templates[step - 1], ctx, tools);
      let messages = [{ role: 'user', content: prompt }];
      let r = await callLlm(messages, 'Step ' + step);
      let content = r.content.trim();
      if (step === 1 || step === 3) content = checks.stripFence(content);
      // Step 2/4 是脚本文本:模型偶尔把章节标签行写成 **[CH01 | m:ss - m:ss | fn]**
      // (实测量产记录,见 tools/normalize_chapter_tags.js),下游闸门与解析器只认规范行。
      // 在入库前统一归一化,后续闸门(2 的章节标记/截断续写)、校验、提示词上下文与 final_script 全部拿到干净文本;
      // 原始模型字节不落盘,但保留"发生过归一化"这一事实,便于事后追查渠道格式漂移。
      if (step === 2 || step === 4) {
        const normed = textnorm.normalizeChapterTags(content);
        if (normed !== content) {
          const name = stepNames[step - 1];
          const before = content.split('\n'), after = normed.split('\n'); // 归一化不改行数
          const changed = after.filter((l, i) => l !== before[i]).length;
          run.steps[name] = { ...(run.steps[name] || {}), tag_normalized: { lines: changed, at: new Date().toISOString() } };
          content = normed;
        }
      }

      // Step 1 蓝图闸门:JSON 解析失败 / 输出过短 / 总时长漂移 >30s 时自动反馈重试(最多 GATE_MAX_RETRIES 次),仍不合格则置失败
      let gate = null;
      if (step === 1) {
        gate = checks.checkBlueprint(content, tools, (run.audience || {}).video_goal);
        for (let retry = 1; gate.duration.ok === false && retry <= GATE_MAX_RETRIES; retry++) {
          run.steps.blueprint.gate_retry = { reason: gate.duration.detail, attempt: retry };
          store.saveRun(run);
          let feedback;
          if (gate.duration.parseError) {
            feedback = '上一次输出无法解析为 JSON(可能是思考过程或无关内容)。请严格只输出 Blueprint 的 JSON 对象,禁止代码围栏、解释、前后缀文字,格式见原始要求。';
          } else if (gate.duration.detail.indexOf('过短') !== -1) {
            feedback = '上一次输出内容过短,不是一份完整蓝图。请按格式要求输出完整的 Blueprint JSON(包含全部章节),禁止代码围栏。';
          } else {
            feedback = '上一次输出的蓝图总时长不合格:' + gate.duration.detail +
              '。请保持各章节功能与相对比例不变,将整体时间轴缩放至 video_goal 时长,重新输出完整 JSON(禁止代码围栏)。';
          }
          messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: feedback }];
          r = await callLlm(messages, 'Step 1 闸门重试');
          content = checks.stripFence(r.content.trim());
          gate = checks.checkBlueprint(content, tools, (run.audience || {}).video_goal);
        }
        if (gate && gate.duration.ok === false) throw new Error('Step 1 重试后仍不合格: ' + gate.duration.detail);

        // 留存检查(流程 B⑪):蓝图每章的 carries_peaks 对照原片高峰、第一个甜头秒数、相邻高峰最大间隔。
        // 只对确认过写前分析的任务反馈重试;仍不合格不置失败,结果写进 run.checks.retention 交人工终审
        let ret = retention.checkBlueprintRetention(content, asset.timeline, analysis.acceptedGaps(run.analysis));
        for (let retry = 1; run.analysis_confirmed && !ret.ok && retry <= GATE_MAX_RETRIES - 1; retry++) {
          run.steps.blueprint.gate_retry = { reason: '留存检查: ' + ret.issues.join(';'), attempt: retry };
          store.saveRun(run);
          const feedback = '蓝图的留存检查不合格:' + ret.issues.join(';') + '。请按写前分析的留存地图,把每个应承担的高峰编号写进对应章节的 carries_peaks,' +
            '在顶层 hook.first_payoff_sec 写明第一个甜头的秒数(不晚于 ' + (ret.source_first_payoff_sec || '原片') + ' 秒),相邻高峰不要隔得比原片更远;其余要求不变,重新输出完整 JSON(禁止代码围栏)。';
          messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: feedback }];
          const r2 = await callLlm(messages, 'Step 1 留存重试');
          const c2 = checks.stripFence(r2.content.trim());
          const g2 = checks.checkBlueprint(c2, tools, (run.audience || {}).video_goal);
          if (g2.duration.ok === false) break; // 留存重试把时长弄坏了:保留上一版蓝图
          r = r2; content = c2; gate = g2;
          ret = retention.checkBlueprintRetention(content, asset.timeline, analysis.acceptedGaps(run.analysis));
        }
        run.checks = { ...(run.checks || {}), retention: ret };

        // 第一个答案不晚于 45 秒(实测 run_2713e3885236:0:10–0:20 走了一半观众)。晚了反馈一次,改坏时长就保留原版
        const payoffOf = t => { try { return Number(((JSON.parse(checks.stripFence(t)) || {}).hook || {}).first_payoff_sec) || null; } catch (e) { return null; } };
        let payoff = payoffOf(content);
        if (payoff > FIRST_PAYOFF_MAX) {
          run.steps.blueprint.gate_retry = { reason: '第一个答案在 ' + payoff + ' 秒,晚于 ' + FIRST_PAYOFF_MAX + ' 秒', attempt: 1 };
          store.saveRun(run);
          const feedback = '蓝图的第一个答案(hook.first_payoff_sec)在 ' + payoff + ' 秒,太晚:观众在前 20 秒就会走一半。请把第一个答案提前到 ' + FIRST_PAYOFF_MAX +
            ' 秒以内(可以先给一半答案,完整答案留到后面),开头 8 秒用一个人或一个场景说出标题里的冲突;总时长和其余要求不变,重新输出完整 JSON(禁止代码围栏)。';
          messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: feedback }];
          const r2 = await callLlm(messages, 'Step 1 开头重试');
          const c2 = checks.stripFence(r2.content.trim());
          const g2 = checks.checkBlueprint(c2, tools, (run.audience || {}).video_goal);
          if (g2.duration.ok !== false && payoffOf(c2) && payoffOf(c2) < payoff) { r = r2; content = c2; gate = g2; payoff = payoffOf(c2); }
        }
        run.checks.first_payoff = { sec: payoff, max: FIRST_PAYOFF_MAX, ok: payoff == null ? null : payoff <= FIRST_PAYOFF_MAX };

        // 词数预算按配音语速重算:模型照原片字幕语速算的预算会把稿子写长
        if (nw.from !== 'source') {
          const rs = narration.rescaleBlueprint(content, nw.wpm);
          if (rs.changed) { content = rs.text; run.checks.narration = { ...run.checks.narration, rescaled_chapters: rs.changed }; }
        }
      }

      // Step 3 JSON 闸门:输出无法解析为 JSON 时自动反馈重试(最多 GATE_MAX_RETRIES 次)
      if (step === 3) {
        let probe = checks.checkAudit(content, outputs.step2);
        for (let retry = 1; !probe.jsonOk && retry <= GATE_MAX_RETRIES; retry++) {
          run.steps.audit.gate_retry = { reason: '输出非合法 JSON(' + (probe.parseError || '解析失败') + ')', attempt: retry };
          store.saveRun(run);
          const feedback = '上一次输出不包含可解析的 JSON(你输出了思考过程而非结果)。请严格只输出审核结果的 JSON 对象,不要任何解释、推理或前后缀文字。';
          messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: feedback }];
          r = await callLlm(messages, 'Step 3 JSON 重试');
          content = checks.stripFence(r.content.trim());
          probe = checks.checkAudit(content, outputs.step2);
        }
        if (!probe.jsonOk) throw new Error('Step 3 重试后仍非合法 JSON');
      }

      // Step 2 闸门 A:章节结构不合格时反馈重试(最多 GATE_MAX_RETRIES 次),仍不合格则置失败。
      // 判定同时覆盖「未解析到任何章节」与「章号重复/乱序」——后者实测于中转层把两段流拼进同一响应体、
      // 或模型自己从头重写一遍(见 checks.chapterStructureError 注释),这类输出拼接出来必然错位。
      if (step === 2) {
        let bpChapters = [];
        try { bpChapters = JSON.parse(checks.stripFence(ctx.blueprint)).chapters || []; } catch (e) {}
        // 被 max_tokens 截断的稿子由闸门 B 续写补全,这里先不按蓝图章数要求
        const wantChapters = () => (r.stopReason === 'max_tokens' ? 0 : bpChapters.length);
        let structErr = checks.chapterStructureError(content, wantChapters());
        for (let retry = 1; structErr && retry <= GATE_MAX_RETRIES; retry++) {
          run.steps.script.gate_retry = { reason: structErr, attempt: retry };
          store.saveRun(run);
          const feedback = '上一次输出不合格:' + structErr + '。请严格按 Blueprint 逐章输出旁白正文,每章以 [CHxx | m:ss - m:ss | function] 标签行开头,' +
            '章号必须从 CH01 起严格递增、每个章号只能出现一次,禁止把已写过的章节再写一遍;不要输出解释或元说明。';
          messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: feedback }];
          r = await callLlm(messages, 'Step 2 结构重试');
          content = textnorm.normalizeChapterTags(r.content.trim());
          structErr = checks.chapterStructureError(content, wantChapters());
        }
        if (structErr) throw new Error('Step 2 重试后仍不合格: ' + structErr);

        // Step 2 闸门 B:max_tokens 截断时退到章节边界续写,绝不从句子中间拼接。
        // 轮数上限 = Blueprint 章数 + 2:续写每轮强制从下一章标签行开始(至少完成一章),该上限正常路径永远碰不到;
        // 仅在渠道系统性截断(每轮都写不完一章)时触发,防止无限烧额度;蓝图不可解析时固定 4 轮兜底,始终有界
        const maxContRounds = bpChapters.length ? bpChapters.length + 2 : 4;
        let continued = false;
        let contRound = 0;
        while (r.stopReason === 'max_tokens') {
          if (contRound >= maxContRounds) throw new Error('Step 2 续写 ' + maxContRounds + ' 轮后仍被 max_tokens 截断(疑似渠道系统性截断,详见 attempts 流水)');
          contRound++;
          continued = true;
          const chs = checks.parseChapters(content);
          const doneCount = chs.length - 1; // 最后一章无法证明写完,视为未完成章
          if (doneCount < 1) {
            // 第一章都没写完:续写无意义,整篇压缩重试一次
            run.steps.script.gate_retry = { reason: 'max_tokens 截断且无完整章节,整篇重试' };
            store.saveRun(run);
            const feedback = '输出因长度上限中断,且未写完任何完整章节。请压缩篇幅,一次性完整输出全部章节(每章以 [CHxx | m:ss - m:ss | function] 标签行开头),不要任何解释。';
            messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: feedback }];
            r = await callLlm(messages, 'Step 2 截断重试');
            content = textnorm.normalizeChapterTags(r.content.trim());
            if (r.stopReason === 'max_tokens') throw new Error('Step 2 整篇重试后仍被 max_tokens 截断,请调大 max_tokens');
            continue;
          }
          // 拼接点:最后一个被解析章(未完成章)标签行的起始位置,prefix 只保留 CH01-CHk 完整内容
          const tagRe = /^\[CH\d+\s*\|[^\]]*\]\s*$/gm;
          let m, lastTag = null;
          while ((m = tagRe.exec(content)) !== null) lastTag = { index: m.index, line: m[0].trim() };
          let expectedTag = lastTag && lastTag.line;
          if (!expectedTag) {
            const c = bpChapters[doneCount];
            if (!c) throw new Error('Step 2 续写失败: 无法确定续写章节标签');
            expectedTag = '[' + (c.id || '') + ' | ' + (c.time_range || '') + ' | ' + (c.function || '') + ']';
          }
          const prefix = lastTag ? content.slice(0, lastTag.index).replace(/\s+$/, '') : content;
          const remaining = bpChapters.slice(doneCount).map(c =>
            '- ' + (c.id || '') + ' | ' + (c.time_range || '') + ' | ' + (c.function || '') + ' | word_budget=' + (c.word_budget || '')
          ).join('\n');
          run.steps.script.gate_retry = { reason: 'max_tokens 截断,于 ' + expectedTag + ' 边界续写(第' + contRound + '轮)' };
          store.saveRun(run);
          const feedback = '输出因长度上限中断,CH01-CH' + String(doneCount).padStart(2, '0') + ' 已完成并通过校验。\n' +
            '请仅从下面这一行开始继续输出剩余章节,第一行必须与该行完全一致:\n' + expectedTag + '\n' +
            '不要重复已完成章节,不要任何解释或前后缀。' +
            (remaining ? '\n剩余章节(必须全部覆盖,不得遗漏或改动结构):\n' + remaining : '');
          messages = [messages[0], { role: 'assistant', content: prefix }, { role: 'user', content: feedback }];
          r = await callLlm(messages, 'Step 2 续写');
          let cont = r.content.trim();
          const normTag = l => (l || '').trim().replace(/\s+/g, ' ');
          let firstLine = cont.split('\n').find(l => l.trim()) || '';
          if (normTag(firstLine) !== normTag(expectedTag)) {
            messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: '续写不合格:第一行必须是 "' + expectedTag + '" 标签行。请只从该标签行开始输出剩余章节,不要输出其他内容。' }];
            r = await callLlm(messages, 'Step 2 续写重试');
            cont = r.content.trim();
            firstLine = cont.split('\n').find(l => l.trim()) || '';
            if (normTag(firstLine) !== normTag(expectedTag)) throw new Error('Step 2 续写输出首行与期望章节标签 ' + expectedTag + ' 不符');
          }
          content = textnorm.normalizeChapterTags((prefix ? prefix + '\n\n' : '') + cont);
        }

        // 截断处理过后整体校验:章数对齐 Blueprint、相邻章时间码衔接、末章结束 ≈ video_goal(±30s)
        if (continued) {
          const goalSec = checks.goalSeconds((run.audience || {}).video_goal);
          const validate = () => {
            const mc = checks.parseChapters(content);
            if (!mc.length) return '未解析到章节标记';
            const structErr = checks.chapterStructureError(content);
            if (structErr) return structErr;
            if (bpChapters.length && mc.length !== bpChapters.length) return '章节数不符: 解析到 ' + mc.length + ' 章,Blueprint 要求 ' + bpChapters.length + ' 章';
            for (let i = 1; i < mc.length; i++) {
              if (Math.abs(checks.toSec(mc[i].start) - checks.toSec(mc[i - 1].end)) > 1) {
                return '章节时间不衔接: CH' + mc[i - 1].ch + ' 结束于 ' + mc[i - 1].end + ',CH' + mc[i].ch + ' 开始于 ' + mc[i].start;
              }
            }
            if (goalSec != null) {
              const endSec = checks.toSec(mc[mc.length - 1].end);
              const drift = Math.abs(endSec - goalSec);
              if (drift > 30) return '末章结束于 ' + checks.fmt(endSec) + ',与 video_goal ' + checks.fmt(goalSec) + ' 漂移 ' + drift + 's';
            }
            return null;
          };
          let vErr = validate();
          if (vErr) {
            run.steps.script.gate_retry = { reason: '截断处理后校验失败: ' + vErr };
            store.saveRun(run);
            const feedback = '生成的脚本不合格:' + vErr + '。请严格按 Blueprint 完整输出全部章节正文(每章以 [CHxx | m:ss - m:ss | function] 标签行开头,章节时间连续且末章结束于 video_goal 时长),不要任何解释。';
            messages = [messages[0], { role: 'user', content: feedback }];
            r = await callLlm(messages, 'Step 2 校验重试');
            content = textnorm.normalizeChapterTags(r.content.trim());
            vErr = validate();
            if (vErr) throw new Error('Step 2 校验重试后仍不合格: ' + vErr);
          }
        }

        // Step 2 闸门 C:篇幅下限。低于预算 50% 反馈重写一次,仍不合格置失败,不让残缺稿进入审核和终审
        let len = lengthCheck(content, ctx.blueprint, run.audience, tools.targetWpm);
        if (len && len.short) {
          run.steps.script.gate_retry = { reason: '篇幅不合格: ' + len.detail, attempt: 1 };
          store.saveRun(run);
          const feedback = '上一次输出篇幅不合格:' + len.detail + '。请按 Blueprint 把每一章的旁白正文完整写出来(每章接近该章的 word_budget),' +
            '每章以 [CHxx | m:ss - m:ss | function] 标签行开头,章号从 CH01 起严格递增;不要只写开头和结尾,不要输出解释。';
          messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: feedback }];
          r = await callLlm(messages, 'Step 2 篇幅重试');
          content = textnorm.normalizeChapterTags(r.content.trim());
          const e2 = checks.chapterStructureError(content, wantChapters());
          if (e2) throw new Error('Step 2 篇幅重试后结构不合格: ' + e2);
          len = lengthCheck(content, ctx.blueprint, run.audience, tools.targetWpm);
          if (len && len.short) throw new Error('Step 2 篇幅重试后仍不合格: ' + len.detail);
        }
        run.checks = { ...(run.checks || {}), script_length: len };

        // Step 2 闸门 D:听感(开头点题、前 10 秒数字、连念数字、语体)
        const words0 = len ? len.words : checks.parseChapters(content).reduce((n, c) => n + c.words, 0);
        const lg = await listenGate(2, content, messages, r, t => t, c2 => {
          if (checks.chapterStructureError(c2, bpChapters.length)) return false;
          const l2 = lengthCheck(c2, ctx.blueprint, run.audience, tools.targetWpm);
          return !(l2 && l2.short) && (!l2 || l2.words <= words0 * 1.05);
        });
        content = lg.content; r = lg.r; messages = lg.messages;
        run.checks.script_listen = lg.lc;
        if (lg.lc && lg.lc.retried && !lg.lc.retry_rejected) run.checks.script_length = lengthCheck(content, ctx.blueprint, run.audience, tools.targetWpm);
      }

      // Step 4 章节结构闸门:终稿必须是一份「CH01 起、章号严格递增不重复」的完整脚本。
      // 中转层把两段流拼进一个响应体、或模型自己整篇重写时,这里会拦住(反馈重试 1 次,仍不合格置失败),
      // 避免把重复/错位的终稿当成品存进 final_script。
      if (step === 4) {
        let bp4 = [];
        try { bp4 = JSON.parse(checks.stripFence(ctx.blueprint)).chapters || []; } catch (e) {}
        let structErr = checks.chapterStructureError(checks.extractFinalScript(content), bp4.length);
        if (structErr) {
          run.steps.optimized.gate_retry = { reason: structErr, attempt: 1 };
          store.saveRun(run);
          const feedback = '上一次输出不合格:' + structErr + '。请只输出一份完整终稿:[CH01 | ...] 到末章,章号严格递增、每章只出现一次,' +
            '禁止把已经写过的章节再写一遍,禁止重复粘贴;Change Log 与 fact_check_list 放在终稿之后。';
          messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: feedback }];
          r = await callLlm(messages, 'Step 4 结构重试');
          content = textnorm.normalizeChapterTags(r.content.trim());
          structErr = checks.chapterStructureError(checks.extractFinalScript(content), bp4.length);
          if (structErr) throw new Error('Step 4 章节结构不合格: ' + structErr);
        }
        // Step 4 篇幅闸门:优化只修问题,不许把稿子撑大。实测韩文稿因词数统计失效被判「偏稀」,
        // 优化把 7,785 字撑到 16,959 字(预算的 184%)。超出预算 115% 反馈压缩一次;仍超标不置失败,结果写进 checks 交人工
        let len = lengthCheck(checks.extractFinalScript(content), ctx.blueprint, run.audience, tools.targetWpm);
        // 优化后反而不到预算一半:说明优化把正文删没了,不交给审核
        if (len && len.short) throw new Error('Step 4 终稿篇幅不合格: ' + len.detail);
        if (len && !len.ok) {
          run.steps.optimized.gate_retry = { reason: len.detail, attempt: 1 };
          store.saveRun(run);
          const feedback = '终稿篇幅不合格:' + len.detail + '。请在不改章节标签和时间范围的前提下删减到预算的 90%–110%:' +
            '先删重复的观点和数字、空泛的感叹和过渡,不要删事实、悬念和高峰。只输出一份完整终稿,格式要求不变。';
          messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: feedback }];
          const r2 = await callLlm(messages, 'Step 4 篇幅重试');
          const c2 = textnorm.normalizeChapterTags(r2.content.trim());
          if (!checks.chapterStructureError(checks.extractFinalScript(c2), bp4.length)) {
            r = r2; content = c2;
            len = lengthCheck(checks.extractFinalScript(content), ctx.blueprint, run.audience, tools.targetWpm);
            if (len && len.short) throw new Error('Step 4 篇幅重试后不合格: ' + len.detail);
          }
        }
        run.checks = { ...(run.checks || {}), length: len };

        // Step 4 听感闸门:同 Step 2;重写后篇幅不许比原来超得更多
        const lg = await listenGate(4, content, messages, r, checks.extractFinalScript, c2 => {
          if (checks.chapterStructureError(checks.extractFinalScript(c2), bp4.length)) return false;
          const l2 = lengthCheck(checks.extractFinalScript(c2), ctx.blueprint, run.audience, tools.targetWpm);
          return !(l2 && l2.short) && (!l2 || !len || l2.words <= Math.max(len.words * 1.03, len.budget * LENGTH_MAX_RATIO));
        });
        if (lg.content !== content) { content = lg.content; r = lg.r; messages = lg.messages; run.checks.length = lengthCheck(checks.extractFinalScript(content), ctx.blueprint, run.audience, tools.targetWpm); }
        run.checks.optimized_listen = lg.lc;
      }

      outputs['step' + step] = content;
      run.steps[stepNames[step - 1]] = {
        status: 'done', secs: Math.round(r.secs * 10) / 10, chars: content.length,
        stop_reason: r.stopReason, finished_at: new Date().toISOString(),
        ...(run.steps[stepNames[step - 1]].gate_retry ? { gate_retry: run.steps[stepNames[step - 1]].gate_retry } : {}),
        ...(run.steps[stepNames[step - 1]].tag_normalized ? { tag_normalized: run.steps[stepNames[step - 1]].tag_normalized } : {})
      };
      // 每步校验结果即时持久化
      if (step === 1) run.checks = { ...(run.checks || {}), blueprint: checks.checkBlueprint(content, tools, (run.audience || {}).video_goal) };
      if (step === 2) run.checks = { ...(run.checks || {}), script: checks.checkScript(content, tools) };
      if (step === 3) run.checks = { ...(run.checks || {}), audit: checks.checkAudit(content, outputs.step2) };
      if (step === 4) {
        run.checks = { ...(run.checks || {}), optimized: checks.checkOptimized(content, outputs.step2) };
        // 正文里混进的修改说明行(如「(删除三处中的后两处,只保留第一处)」)不是旁白,去掉并留痕
        const meta = checks.stripMetaNotes(checks.extractFinalScript(content), (run.audience || {}).target_language);
        // 非中文稿里混进的汉字/日文假名(如「에레베타가루 (エレベーターガール)」):规则修 + 模型逐行改写,改不掉的留痕
        const pure = await purify.purifyScript(meta.text, run.audience, async p => (await callLlm([{ role: 'user', content: p }], 'Step 4 外文字符修正')).content);
        run.final_script = pure.text;
        run.checks.listen = checks.listenCheck(run.final_script, listenOpts());
        if (meta.removed.length) run.checks.optimized.meta_lines = meta.removed;
        if (purify.hasLog(pure.log)) run.checks.optimized.foreign = pure.log;
      }
      if (step === 1) ctx.blueprint = content;
      if (step === 2) ctx.script = content;
      if (step === 3) ctx.audit = content;
      run.outputs = outputs; // 每步产物即时落盘,失败不丢
      store.saveRun(run);
    } catch (e) {
      run.status = 'failed';
      run.error = 'Step ' + step + ' 失败: ' + e.message;
      run.checks = { ...(run.checks || {}), gate_fail: { step, reason: e.message, at: new Date().toISOString() } };
      run.steps[stepNames[step - 1]].status = 'failed';
      store.saveRun(run);
      return;
    }
  }

  run.outputs = outputs;
  run.current_step = 4;
  store.saveRun(run);

  // 稿件检查(流程 B⑬⑭):仅新流程任务自动跑;失败不影响成稿,结果在 run.script_check
  if (run.analysis_confirmed) await analysis.runScriptCheck(runId);

  const done = store.getRun(runId) || run;
  done.status = 'done';
  done.current_step = 4;
  done.finished_at = new Date().toISOString();
  store.saveRun(done);
}

module.exports = { lengthCheck, todayStr, loadConfig, saveConfig, resolveProvider, loadTweakConfig, buildRequest, postJson, probeProvider, runGeneration, fillTemplate, loadTemplates, llmCall, parseSSE, isRetryable };
