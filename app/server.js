// 爆款文案生成服务:资产库 + 四阶段自动生成(局域网多用户/多任务并发)
// 用法: node app/server.js  →  http://localhost:8080 (局域网 http://<本机IP>:8080)
const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const { validateBundle, summarize } = require('./lib/validate');
const { parseSrt } = require('./lib/srt');
const pipeline = require('./lib/pipeline');
const analysis = require('./lib/analysis');
const review = require('./lib/review');
const search = require('./lib/search');
const voice = require('./lib/voice');
const topics = require('./lib/topics');
const fingerprint = require('./lib/fingerprint');
const description = require('./lib/description');
const textloc = require('./lib/textloc');
const compliance = require('./lib/compliance');
const opening = require('./lib/opening');
const boost = require('./lib/boost');
const checks = require('./lib/checks');
const video = require('./lib/video');

const PORT = Number(process.env.PORT) || 8080; // 默认 8080,可用 PORT 环境变量覆盖(如调试时不占用正式实例)
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
const DEFAULT_MODELS = ['claude-opus-4-8', 'claude-opus-5']; // 渠道预设缺 models 字段时的兜底(兼容手改的旧配置)

function send(res, status, data, type = 'application/json') {
  if (Buffer.isBuffer(data)) {
    res.writeHead(status, { 'Content-Type': type });
    res.end(data);
    return;
  }
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')); } catch (e) { reject(new Error('请求体不是合法 JSON')); } });
    req.on('error', reject);
  });
}

// ---------- 视频推送记录 ----------
// 每个任务在自身 run 文件里保留推送历史(video_pushes),列表与详情只展示最新一条;
// 一条记录对应"某版本文案 → 视频网站某项目",status 由推送结果与按需刷新共同维护。
const PUSH_STATUS_LABELS = {
  draft: '草稿',
  running: '生产中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败'
};

// 单条推送记录 → 前端展示形态(补状态中文与项目链接);列表索引与全量 run 共用同一套口径
function videoPushView(p, baseUrl) {
  if (!p) return null;
  const base = (baseUrl || video.DEFAULT_BASE_URL).replace(/\/+$/, '');
  return {
    push_id: p.push_id,
    version: p.version,
    mode: p.mode,
    status: p.status,
    status_label: PUSH_STATUS_LABELS[p.status] || p.status,
    stage: p.stage || null,
    stage_label: p.stage_label || null,
    project_id: p.project_id || null,
    project_title: p.project_title || '',
    channel_id: p.channel_id || null,
    channel_name: p.channel_name || '',
    error: p.error || null,
    created_at: p.created_at || null,
    updated_at: p.updated_at || null,
    project_url: p.project_id
      ? base + '/#/project/' + encodeURIComponent(p.project_id) + '/auto_progress'
      : null
  };
}

function latestVideoPush(run, baseUrl) {
  const pushes = Array.isArray(run.video_pushes) ? run.video_pushes : [];
  if (!pushes.length) return null;
  return videoPushView(pushes[pushes.length - 1], baseUrl);
}

// 推送时读取任务的最新快照再追加,避免长时间请求期间其他写入被整对象覆盖
function appendVideoPush(runId, record) {
  const fresh = store.getRun(runId);
  if (!fresh) return null;
  fresh.video_pushes = [...(Array.isArray(fresh.video_pushes) ? fresh.video_pushes : []), record].slice(-40);
  store.saveRun(fresh);
  return fresh;
}

// 文案语言 → 视频 locale;不支持时抛出可读错误(用户确认:不支持的语言直接禁止推送)
function requireLocale(run) {
  const language = (run.audience || {}).target_language || 'English';
  const locale = video.localeForLanguage(language);
  if (!locale) {
    const supported = Object.keys(video.LOCALE_BY_LANGUAGE).join(' / ');
    throw new Error('该任务的语言「' + language + '」视频网站不支持,只支持:' + supported + '。请用受支持的语言重新生成文案后再推送');
  }
  return locale;
}

// 推送:create=建项目(草稿);auto=建项目后立即提交并开始全链路自动生产
async function pushToVideo(run, { version, mode, confirmDuplicate }) {
  if (!run) throw new Error('任务不存在');
  if (run.status !== 'done') throw new Error('仅已完成的任务可推送视频(当前:' + (run.status || '?') + ')');
  const text = description.versionText(run, version);
  if (!text) throw new Error('该版本文案不存在');

  const binding = video.loadBinding();
  if (!binding) throw new Error('尚未绑定视频网站账号,请先在「设置」页完成绑定');
  if (!run.channel_id) throw new Error('该任务未选择频道,请在创建任务时选择频道');

  const locale = requireLocale(run);
  const script = video.cleanScript(text);
  if (!script) throw new Error('该版本文案清洗后为空,无法推送');

  // 频道以实时拉取为准:刚在视频网站改过的默认角色图/风格/音色立即生效
  const channels = await video.fetchChannels(binding);
  const channel = channels.find(c => c.id === run.channel_id) || null;
  video.assertChannelReady(channel);

  // 幂等:同一版本已推送过时需显式确认"再建一个"
  const pushes = Array.isArray(run.video_pushes) ? run.video_pushes : [];
  const previous = pushes.filter(p => p.version === version).slice(-1)[0] || null;
  if (previous && !confirmDuplicate) {
    const err = new Error('该任务的 ' + version.toUpperCase() + ' 文案已推送过(' + (PUSH_STATUS_LABELS[previous.status] || previous.status) + '),如需再建一个视频项目请确认');
    err.code = 'already_pushed';
    err.push = previous;
    throw err;
  }

  const now = () => new Date().toISOString();
  const record = {
    push_id: video.newPushId(),
    version,
    mode: mode === 'auto' ? 'auto' : 'draft',
    project_id: null,
    project_title: run.topic || '',
    channel_id: channel.id,
    channel_name: channel.name,
    locale,
    status: 'draft',
    stage: null,
    stage_label: null,
    error: null,
    duplicate_of: previous ? previous.push_id : null,
    created_at: now(),
    updated_at: now()
  };

  const project = await video.createProject(binding, video.buildProjectPayload({
    title: run.topic,
    channel,
    script,
    locale
  }));
  record.project_id = project.id;
  record.status = 'draft';
  record.stage_label = '草稿';

  if (record.mode === 'auto') {
    try {
      await video.startProduction(binding, project.id);
      record.status = 'running';
      record.stage = 'NARRATION';
      record.stage_label = '生产中';
    } catch (e) {
      // 项目已落库但自动生产未启动:如实记为草稿并带原因,不假装成功也不回滚(用户确认:后续在视频网站处理)
      record.status = 'draft';
      record.stage_label = '草稿';
      record.error = '自动生产未启动:' + e.message;
    }
  }

  record.updated_at = now();
  const fresh = appendVideoPush(run.id, record);
  if (!fresh) throw new Error('任务记录写入失败');
  return record;
}

const server = http.createServer(async (req, res) => {
  const fullUrl = req.url || '/';
  const qAt = fullUrl.indexOf('?');
  const url = qAt === -1 ? fullUrl : fullUrl.slice(0, qAt);
  const query = new URLSearchParams(qAt === -1 ? '' : fullUrl.slice(qAt + 1));
  const method = req.method;
  try {
    // ---------- 设置 ----------
    // config.json 结构: provider(主流程当前渠道) + providers(各渠道预设:协议/Base URL/Key/models,Key 服务端保管,前端不展示)
    //               + 渠道可选 omit_temperature:true 表示其模型拒收/固定 temperature 字段,请求时省略
    //               + 渠道可选 use_max_completion_tokens:true 表示其长度字段名为 max_completion_tokens(如 Kimi K3),请求时改名发送(仅 openai 协议生效)
    //               + 顶层 protocol/base_url/api_key/omit_temperature 为主流程渠道解析后的生效值(管线直接读取)
    //               + tweak 块为微调按钮(选题推荐/简介/指纹/商业化/留存/强化开头)的独立选择值,加载时经 pipeline.resolveProvider 现解析
    // 两套作用域共享同一份 providers 预设,Key 只在一处维护
    if (url === '/api/settings' && method === 'GET') {
      const cfg = pipeline.loadConfig() || {};
      const providers = Object.entries(cfg.providers || {}).map(([id, p]) => ({
        id, name: p.name || id, has_key: !!p.api_key,
        models: Array.isArray(p.models) && p.models.length ? p.models : DEFAULT_MODELS
      }));
      const tw = cfg.tweak || {};
      return send(res, 200, {
        provider: cfg.provider || '',
        providers,
        model: cfg.model || '',
        temperature: cfg.temperature ?? 0.7,
        max_tokens: cfg.max_tokens || 8192,
        tweak: { // 与 pipeline.loadTweakConfig 同一套缺省回退规则
          provider: tw.provider || cfg.provider || '',
          model: tw.model || cfg.model || '',
          temperature: typeof tw.temperature === 'number' ? tw.temperature : (cfg.temperature ?? 0.7),
          max_tokens: tw.max_tokens || cfg.max_tokens || 8192
        }
      });
    }
    if (url === '/api/settings' && method === 'POST') {
      const body = await readBody(req);
      const prev = pipeline.loadConfig() || {};
      const providers = prev.providers || {};
      // scope: main=主流程(顶层字段,含解析后的生效值) / tweak=微调按钮(tweak 块,只存选择值,加载时经 resolveProvider 现解析)
      const scope = body.scope === 'tweak' ? 'tweak' : 'main';
      // 两套配置共用的读取+校验:渠道必须存在,模型必须在该渠道 models 列表内(拦截渠道+模型错配)
      const providerId = body.provider || (scope === 'tweak' ? (prev.tweak || {}).provider : prev.provider);
      const preset = providers[providerId];
      if (!preset) return send(res, 400, { error: '未知渠道商: ' + providerId });
      const models = Array.isArray(preset.models) && preset.models.length ? preset.models : DEFAULT_MODELS;
      const model = body.model || models[0];
      if (!models.includes(model)) return send(res, 400, { error: '渠道 ' + (preset.name || providerId) + ' 不支持模型: ' + model });
      const picked = {
        provider: providerId,
        model,
        temperature: typeof body.temperature === 'number' ? body.temperature : 0.7,
        max_tokens: body.max_tokens || 8192
      };
      const cfg = { ...prev, providers }; // 保留 tweak 等其余字段,只覆盖本作用域
      if (scope === 'tweak') {
        cfg.tweak = picked;
      } else {
        // 生效值统一经 resolveProvider 解析透传(含 omit_temperature/use_max_completion_tokens 等渠道标记),新增标记不再漏流
        Object.assign(cfg, pipeline.resolveProvider(prev, providerId), {
          provider: providerId,
          model: picked.model,
          temperature: picked.temperature,
          max_tokens: picked.max_tokens
        });
      }
      pipeline.saveConfig(cfg);
      return send(res, 200, { ok: true });
    }

    // 渠道连通性测试:探测实现收在 pipeline.probeProvider(与 llmCall 同一传输层,120s 有界单次,512 token 探针),
    // 此处只做作用域分流与前置校验;body: { scope: 'main'|'tweak'(默认 main), provider, model },provider/model 缺省取该作用域已保存值,即测的是页面当前选中项
    if (url === '/api/settings/test' && method === 'POST') {
      const body = await readBody(req);
      const cfg = pipeline.loadConfig() || {};
      const scope = body.scope === 'tweak' ? 'tweak' : 'main';
      const saved = scope === 'tweak' ? (cfg.tweak || {}) : cfg;
      const providerId = body.provider || saved.provider || cfg.provider;
      const resolved = pipeline.resolveProvider(cfg, providerId);
      if (!resolved) return send(res, 400, { error: '未知渠道商: ' + providerId });
      if (!resolved.api_key) return send(res, 400, { error: '该渠道未配置 API Key' });
      const r = await pipeline.probeProvider({ ...resolved, model: body.model || saved.model || cfg.model || 'claude-opus-4-8' });
      return send(res, 200, r);
    }

    // ---------- 资产库 ----------
    if (url === '/api/assets' && method === 'GET') return send(res, 200, store.listAssets());

    if (url === '/api/assets' && method === 'POST') {
      const files = await readBody(req);
      const result = validateBundle(files);
      if (!result.ok) return send(res, 400, { ok: false, errors: result.errors });
      const title = (result.parsed.framework.provenance || {}).source_title || files.name || 'untitled';
      const id = store.newAssetId(title);
      const meta = {
        ...summarize(result.parsed),
        has_srt: !!files.srt,
        created_at: new Date().toISOString()
      };
      if (typeof files.channel === 'string' && files.channel.trim()) meta.channel = files.channel.trim();
      store.saveAsset(id, meta, files);
      return send(res, 200, { ok: true, id, meta });
    }

    const assetMatch = url.match(/^\/api\/assets\/([\w-]+)$/);
    if (assetMatch && method === 'GET') {
      const a = store.getAsset(assetMatch[1]);
      return a ? send(res, 200, { id: a.id, meta: a.meta }) : send(res, 404, { error: '资产不存在' });
    }
    if (assetMatch && method === 'DELETE') {
      store.deleteAsset(assetMatch[1]);
      return send(res, 200, { ok: true });
    }

    const sourceMatch = url.match(/^\/api\/assets\/([\w-]+)\/source$/);
    if (sourceMatch && method === 'GET') {
      const dir = path.join(store.ASSETS_ROOT, sourceMatch[1]);
      const read = f => { try { return fs.readFileSync(path.join(dir, f), 'utf-8'); } catch (e) { return null; } };
      const en = read('source.srt');
      if (en === null) return send(res, 404, { error: '原文不存在' });
      const zh = read('source_zh.srt');
      const zhByIndex = new Map(parseSrt(zh).map(c => [c.index, c.text]));
      const cues = parseSrt(en).map(c => ({ index: c.index, start: c.start, end: c.end, en: c.text, zh: zhByIndex.get(c.index) || null }));
      let meta = {};
      try { meta = JSON.parse(read('meta.json') || '{}'); } catch (e) { /* meta 损坏时忽略 */ }
      return send(res, 200, { id: sourceMatch[1], name: meta.name || sourceMatch[1], source_title: meta.source_title || '', source_title_zh: meta.source_title_zh || '', cues }, 'application/json; charset=utf-8');
    }

    // ---------- 选题推荐 ----------
    // 同步短调用:结合所选框架资产为赛道推荐选题,不落盘、不进任务系统
    if (url === '/api/topics/suggest' && method === 'POST') {
      const body = await readBody(req);
      if (!body.asset_id || !(body.track || '').trim()) return send(res, 400, { error: '缺少 asset_id 或 track' });
      if (!store.getAsset(body.asset_id)) return send(res, 404, { error: '资产不存在: ' + body.asset_id });
      const cfg = pipeline.loadTweakConfig();
      if (!cfg || !cfg.api_key) return send(res, 400, { error: '未配置微调按钮的 API Key,请在设置页「微调按钮 API 配置」中选择有效渠道' });
      try {
        const result = await topics.suggestTopics({
          asset_id: body.asset_id,
          track: body.track.trim(),
          audience: body.audience || {},
          current_batch: Array.isArray(body.current_batch) ? body.current_batch : []
        });
        return send(res, 200, { ok: true, ...result });
      } catch (e) {
        return send(res, 502, { ok: false, error: e.message });
      }
    }

    // ---------- 视频网站集成:账号绑定与频道 ----------
    // 全局单账号(用户确认):绑定时登录校验并把频道缓存到 data/video_binding.json;
    // 密码仅供 token(12 小时)过期后自动重登,不下发前端。
    if (url === '/api/video/binding' && method === 'GET') {
      return send(res, 200, video.publicBinding(video.loadBinding()));
    }

    if (url === '/api/video/binding' && method === 'POST') {
      const body = await readBody(req);
      try {
        const binding = await video.bind({ base_url: body.base_url, username: body.username, password: body.password });
        return send(res, 200, { ok: true, ...video.publicBinding(binding) });
      } catch (e) {
        return send(res, 400, { ok: false, error: e.message });
      }
    }

    if (url === '/api/video/binding' && method === 'DELETE') {
      video.clearBinding();
      return send(res, 200, { ok: true, ...video.publicBinding(null) });
    }

    if (url === '/api/video/channels/refresh' && method === 'POST') {
      const binding = video.loadBinding();
      if (!binding) return send(res, 400, { ok: false, error: '尚未绑定视频网站账号' });
      try {
        await video.fetchChannels(binding);
        return send(res, 200, { ok: true, ...video.publicBinding(binding) });
      } catch (e) {
        return send(res, 400, { ok: false, error: e.message });
      }
    }

    // 批量刷新:对每个有推送记录的任务查一次最新项目状态(串行,避免打爆视频网站)
    if (url === '/api/video/refresh-all' && method === 'POST') {
      const binding = video.loadBinding();
      if (!binding) return send(res, 400, { ok: false, error: '尚未绑定视频网站账号' });
      const targets = store.listRuns().filter(r => Array.isArray(r.video_pushes) && r.video_pushes.length);
      let updated = 0;
      const failures = [];
      for (const item of targets) {
        const last = item.video_pushes[item.video_pushes.length - 1];
        if (!last || !last.project_id) continue;
        try {
          const state = await video.fetchProjectState(binding, last.project_id);
          const fresh = store.getRun(item.id);
          if (!fresh) continue;
          const list = Array.isArray(fresh.video_pushes) ? fresh.video_pushes : [];
          const target = list.find(p => p.push_id === last.push_id);
          if (!target) continue;
          target.status = state.status;
          target.stage = state.stage;
          target.stage_label = state.stage_label;
          target.updated_at = new Date().toISOString();
          store.saveRun(fresh);
          updated += 1;
        } catch (e) {
          failures.push({ run_id: item.id, error: e.message });
        }
      }
      return send(res, 200, { ok: true, total: targets.length, updated, failures });
    }

    // ---------- 生成任务 ----------
    // 任务列表:筛选 + 分页全部在服务端完成(数据来自 runs.index.json,不解析完整 run 文件)
    // 查询参数:q(关键词) / status(逗号分隔多选) / lang(语言多选) / video(视频状态多选)
    //          / viral=1(只看爆款) / from,to(ISO 时间,按 created_at) / page / page_size(20|50|100)
    if (url === '/api/runs' && method === 'GET') {
      const binding = video.loadBinding();
      const baseUrl = binding ? binding.base_url : null;
      const csv = key => (query.get(key) || '').split(',').map(s => s.trim()).filter(Boolean);
      const result = store.queryRuns({
        q: query.get('q') || '',
        statuses: csv('status'),
        languages: csv('lang'),
        videos: csv('video'),
        viralOnly: query.get('viral') === '1',
        from: query.get('from') || '',
        to: query.get('to') || '',
        page: query.get('page'),
        pageSize: query.get('page_size')
      });
      return send(res, 200, {
        items: result.items.map(it => ({ ...it, video: videoPushView(it.video, baseUrl) })),
        total: result.total,
        total_all: result.total_all,
        page: result.page,
        pages: result.pages,
        page_size: result.page_size,
        facets: result.facets,
        built_at: result.built_at
      });
    }

    if (url === '/api/runs' && method === 'POST') {
      const body = await readBody(req);
      if (!body.asset_id || !body.topic) return send(res, 400, { error: '缺少 asset_id 或 topic' });
      const asset = store.getAsset(body.asset_id);
      if (!asset) return send(res, 404, { error: '资产不存在: ' + body.asset_id });
      const cfg = pipeline.loadConfig();
      if (!cfg || !cfg.api_key) return send(res, 400, { error: '未配置 API Key,请先在设置中填写' });
      // 频道(选填):推送视频时按此频道建项目;名称以绑定缓存的频道名为准,避免前端传旧名
      const channelId = typeof body.channel_id === 'string' && body.channel_id.trim() ? body.channel_id.trim() : null;
      let channelName = typeof body.channel_name === 'string' ? body.channel_name.trim() : '';
      if (channelId) {
        const binding = video.loadBinding();
        const ch = binding ? video.findChannel(binding, channelId) : null;
        if (ch) channelName = ch.name;
      }
      const run = store.newRun({
        asset_id: body.asset_id,
        asset_name: asset.meta.name || body.asset_id,
        topic: body.topic,
        channel_id: channelId,
        channel_name: channelName || null,
        audience: {
          target_language: (body.audience || {}).target_language || 'English',
          target_country: (body.audience || {}).target_country || 'US',
          target_audience: (body.audience || {}).target_audience || '',
          video_goal: (body.audience || {}).video_goal || '10分钟'
        },
        prompt_version: 'v3',
        // 写前分析(新流程):先跑分析,人工确认后才写稿;track 用于挑赛道证据卡,materials 是人工提供的参考资料
        // 先写后改(draft_first):分析和 AI 先调整自动跑完,不等确认直接写稿,写完在逐段对照里审
        draft_first: !!body.draft_first,
        pre_analysis: !!body.pre_analysis || !!body.draft_first,
        track: typeof body.track === 'string' ? body.track.trim() : '',
        materials: typeof body.materials === 'string' ? body.materials.trim() : '',
        // 频道声音设定:'__auto__' 按频道名匹配(默认) / '__none__' 不用 / 设定名
        voice_name: typeof body.voice_name === 'string' ? body.voice_name : voice.AUTO
      });
      if (run.draft_first) {
        review.runDraftFirst(run.id).catch(e => {
          const r = store.getRun(run.id);
          if (r) { r.status = 'failed'; r.error = '一键生成异常: ' + e.message; store.saveRun(r); }
        });
        return send(res, 200, { ok: true, id: run.id });
      }
      if (run.pre_analysis) {
        analysis.runAnalysis(run.id).catch(e => {
          const r = store.getRun(run.id);
          if (r) { r.status = 'failed'; r.error = '写前分析异常: ' + e.message; store.saveRun(r); }
        });
        return send(res, 200, { ok: true, id: run.id });
      }
      // 异步执行,不阻塞响应(多任务并发)
      pipeline.runGeneration(run.id).catch(e => {
        const r = store.getRun(run.id);
        if (r) { r.status = 'failed'; r.error = '管线异常: ' + e.message; store.saveRun(r); }
      });
      return send(res, 200, { ok: true, id: run.id });
    }

    const runMatch = url.match(/^\/api\/runs\/([\w-]+)$/);
    if (runMatch && method === 'GET') {
      const r = store.getRun(runMatch[1]);
      if (!r) return send(res, 404, { error: '任务不存在' });
      // 编辑分析用的对照数据(原片高峰、第一个甜头),只随响应返回,不落盘
      r.analysis_context = analysis.analysisContext(r.asset_id);
      return send(res, 200, r);
    }

    // ---------- 写前分析:人工确认 / 保存修改 / 重新分析 ----------
    // 确认:可带上人工编辑过的 analysis(整份 JSON),确认后进入四步写稿
    const anConfirmMatch = url.match(/^\/api\/runs\/([\w-]+)\/analysis\/confirm$/);
    if (anConfirmMatch && method === 'POST') {
      const body = await readBody(req);
      const r = store.getRun(anConfirmMatch[1]);
      if (!r) return send(res, 404, { error: '任务不存在' });
      if (r.status !== 'awaiting_review') return send(res, 400, { error: '仅待确认分析的任务可确认(当前: ' + r.status + ')' });
      if (body.analysis != null) {
        const shapeErr = analysis.analysisShapeError(body.analysis);
        if (shapeErr) return send(res, 400, { error: '分析结果不合格: ' + shapeErr });
        if (r.analysis && !r.analysis_original) r.analysis_original = analysis.cloneJson(r.analysis);
        r.analysis = body.analysis;
        r.analysis_edited = true;
      }
      r.analysis_confirmed = true;
      r.analysis_confirmed_at = new Date().toISOString();
      r.status = 'queued';
      store.saveRun(r);
      pipeline.runGeneration(r.id).catch(e => {
        const rr = store.getRun(r.id);
        if (rr) { rr.status = 'failed'; rr.error = '管线异常: ' + e.message; store.saveRun(rr); }
      });
      return send(res, 200, { ok: true, id: r.id });
    }

    // 保存修改(不写稿):只覆盖 analysis,不碰 status、不点火管线
    const anUpdateMatch = url.match(/^\/api\/runs\/([\w-]+)\/analysis\/update$/);
    if (anUpdateMatch && method === 'POST') {
      const body = await readBody(req);
      const r = store.getRun(anUpdateMatch[1]);
      if (!r) return send(res, 404, { error: '任务不存在' });
      if (r.status !== 'awaiting_review' || r.analysis_confirmed) {
        return send(res, 400, { error: '仅待确认且未确认的任务可保存分析(当前: ' + r.status + ')' });
      }
      const shapeErr = analysis.analysisShapeError(body.analysis);
      if (shapeErr) return send(res, 400, { error: '分析结果不合格: ' + shapeErr });
      if (r.analysis && !r.analysis_original) r.analysis_original = analysis.cloneJson(r.analysis);
      r.analysis = body.analysis;
      r.analysis_edited = true;
      r.analysis_saved_at = new Date().toISOString();
      store.saveRun(r);
      return send(res, 200, { ok: true, id: r.id, analysis: r.analysis, analysis_saved_at: r.analysis_saved_at });
    }

    // 重新分析:可补充参考资料(materials)、指定赛道证据卡(track_card_name)
    const anRerunMatch = url.match(/^\/api\/runs\/([\w-]+)\/analysis\/rerun$/);
    if (anRerunMatch && method === 'POST') {
      const body = await readBody(req);
      const r = store.getRun(anRerunMatch[1]);
      if (!r) return send(res, 404, { error: '任务不存在' });
      if (!['awaiting_review', 'failed', 'cancelled'].includes(r.status) || r.analysis_confirmed) {
        return send(res, 400, { error: '仅未确认分析、且待确认/失败/已取消的任务可重新分析(当前: ' + r.status + ')' });
      }
      if (typeof body.materials === 'string') r.materials = body.materials.trim();
      if (typeof body.track_card_name === 'string') r.track_card_name = body.track_card_name || null;
      r.pre_analysis = true;
      store.saveRun(r);
      analysis.runAnalysis(r.id).catch(e => {
        const rr = store.getRun(r.id);
        if (rr) { rr.status = 'failed'; rr.error = '写前分析异常: ' + e.message; store.saveRun(rr); }
      });
      return send(res, 200, { ok: true, id: r.id });
    }

    // ---------- 先写后改:逐段对照审稿 ----------
    // GET 视图(每次按当前稿子现算);POST status/undo 立即返回;rewrite/fact 等模型返回再响应(单章约 0.5–2 分钟)
    const rvMatch = url.match(/^\/api\/runs\/([\w-]+)\/review(?:\/(status|rewrite|undo|fact|translate|pass|final))?$/);
    if (rvMatch) {
      const [, id, action] = rvMatch;
      try {
        if (!action && method === 'GET') return send(res, 200, review.getView(id));
        if (action && method === 'POST') {
          const body = await readBody(req);
          if (action === 'status') return send(res, 200, review.setStatus(id, body.chapter, body.status));
          if (action === 'undo') return send(res, 200, review.undo(id, body.chapter));
          if (action === 'rewrite') return send(res, 200, await review.rewriteChapter(id, body.chapter, body.compress ? (body.note || review.COMPRESS_NOTE) : body.note, { compress: !!body.compress }));
          if (action === 'fact') return send(res, 200, await review.updateFact(id, body.id, body.patch || {}));
          if (action === 'pass') {
            // 重跑初稿检查(会接着出审稿报告)、只重跑审稿报告或只重跑终审;后台跑,页面轮询看进度
            const kind = ['final', 'audit'].includes(body.kind) ? body.kind : 'check';
            review.runPasses(id, kind).catch(() => {});
            return send(res, 200, { ok: true });
          }
          // 看完二稿审稿报告:带着勾选的问题、修改路线和备注去终审(后台跑)
          if (action === 'final') return send(res, 200, review.startFinal(id, body));
          if (action === 'translate') {
            review.translateRun(id).catch(() => {});
            return send(res, 200, { ok: true });
          }
        }
      } catch (e) {
        return send(res, e.status || 500, { error: e.message });
      }
    }

    // ---------- 写前分析审核辅助(v1.2):AI 先调整 / 我的意见 / 标题审核 ----------
    // 三个都是同步接口(等模型返回再响应,通常 0.5–3 分钟);都不改任务状态
    const anAdjustMatch = url.match(/^\/api\/runs\/([\w-]+)\/analysis\/(auto-adjust|revise|title-audit)$/);
    if (anAdjustMatch && method === 'POST') {
      const body = await readBody(req);
      const [, id, action] = anAdjustMatch;
      try {
        if (action === 'auto-adjust') return send(res, 200, await analysis.runAutoAdjust(id, body.analysis, { search: body.search }));
        if (action === 'revise') return send(res, 200, await analysis.reviseItem(id, body.analysis, body.target, body.note, { search: body.search }));
        return send(res, 200, await analysis.auditTitle(id, body.analysis, body.title));
      } catch (e) {
        return send(res, e.status || 500, { error: e.message });
      }
    }

    // 联网搜索设置(渠道适配器,当前接 DeepSeek):开关、渠道、每个查询取几条;Key 默认用同名渠道的 Key
    if (url === '/api/search-settings' && method === 'GET') {
      return send(res, 200, search.searchStatus());
    }
    if (url === '/api/search-settings' && method === 'POST') {
      const body = await readBody(req);
      const cfg = pipeline.loadConfig();
      if (!cfg) return send(res, 400, { error: '还没有 config.json,请先保存一次主设置' });
      const prev = cfg.search || {};
      const wanted = search.channels().some(c => c.id === body.provider) ? body.provider : (prev.provider || 'deepseek');
      cfg.search = { ...prev, provider: wanted };
      if (typeof body.enabled === 'boolean') cfg.search.enabled = body.enabled;
      if (body.count != null) cfg.search.count = Math.min(Math.max(Number(body.count) || 5, 1), 10);
      // 每个渠道单独存 Key(换渠道不会把上一家的 Key 覆盖掉);顶层 api_key 保留,兼容旧配置
      if (typeof body.api_key === 'string' && body.api_key.trim()) {
        cfg.search.channels = { ...(prev.channels || {}) };
        cfg.search.channels[wanted] = { ...(cfg.search.channels[wanted] || {}), api_key: body.api_key.trim() };
        cfg.search.api_key = body.api_key.trim();
      }
      pipeline.saveConfig(cfg);
      return send(res, 200, search.searchStatus(cfg));
    }
    if (url === '/api/search-settings/test' && method === 'POST') {
      const body = await readBody(req);
      try {
        const r = await search.webSearch(body.query || '서울 최저임금 2026', null);
        return send(res, 200, { ok: true, ...r });
      } catch (e) { return send(res, 400, { ok: false, error: e.message }); }
    }

    // 稿件检查(K1–K5):任意已完成任务可手动(重新)检查;新流程任务在写稿后自动跑一次
    const scMatch = url.match(/^\/api\/runs\/([\w-]+)\/script-check$/);
    if (scMatch && method === 'POST') {
      const r = store.getRun(scMatch[1]);
      if (!r) return send(res, 404, { error: '任务不存在' });
      if (r.status !== 'done' || !(r.script_v1 || r.final_script)) return send(res, 400, { error: '仅已完成的任务可检查(当前: ' + r.status + ')' });
      if ((r.steps || {}).script_check && r.steps.script_check.status === 'running') return send(res, 409, { error: '稿件检查进行中' });
      analysis.runScriptCheck(r.id).catch(() => {});
      return send(res, 200, { ok: true, id: r.id });
    }

    // 采用某个检查选项:只替换一次,失败一字不改;option_index=-1 表示用该条的 before/after(K3 改失败的存量)
    const scApplyMatch = url.match(/^\/api\/runs\/([\w-]+)\/script-check\/apply$/);
    if (scApplyMatch && method === 'POST') {
      const body = await readBody(req);
      const r = store.getRun(scApplyMatch[1]);
      if (!r) return send(res, 404, { error: '任务不存在' });
      if (r.status !== 'done') return send(res, 400, { error: '仅已完成的任务可改稿(当前: ' + r.status + ')' });
      if (r.script_v2) return send(res, 400, { error: '已生成 V2,V1 已锁定;请在 V2 上重跑检查' });
      if ((r.steps || {}).script_check && r.steps.script_check.status === 'running') return send(res, 409, { error: '稿件检查进行中,稍后再试' });
      const sc = r.script_check;
      if (!sc || !Array.isArray(sc.issues)) return send(res, 400, { error: '还没有检查结果' });
      const idx = Number(body.issue_index);
      const it = sc.issues[idx];
      if (!it) return send(res, 404, { error: '问题不存在' });
      if (it.status !== '待选择') return send(res, 409, { error: '该问题已处理过,不能重复采用' });

      const oi = Number(body.option_index);
      let apply = null, label = '';
      if (oi === -1) {
        if (!it.before || !it.after) return send(res, 400, { error: '该问题没有可直接应用的改法,请用复制' });
        apply = { find: it.before, replace: it.after };
        label = 'K3 改法';
      } else {
        const opt = (it.options || [])[oi];
        apply = opt && typeof opt === 'object' ? opt.apply : null;
        label = opt ? (typeof opt === 'string' ? opt : (opt.label || '')) : '';
      }
      if (!apply || typeof apply.find !== 'string') return send(res, 400, { error: '该选项没有结构化改法,请用「复制」手动改' });
      if (String(apply.find).length > 4000 || String(apply.replace || '').length > 4000) return send(res, 400, { error: '单条改动过长' });

      const src = analysis.v1Text(r);
      const applied = analysis.applyOptionExact(src, apply.find, apply.replace || '');
      if (!applied.ok) return send(res, 409, { error: applied.reason + ',未做任何改动。请用「复制」手动改' });

      if (!r.script_check_before_adopt) r.script_check_before_adopt = src;
      sc.adoptions = [...(sc.adoptions || []), {
        at: new Date().toISOString(), issue_index: idx, issue_id: it.id, option_index: oi,
        label, find: apply.find, replace: apply.replace || '',
        before_text: src, after_text: applied.text
      }].slice(-50);

      if (r.script_v1) r.script_v1 = applied.text; else r.final_script = applied.text;
      it.status = '已采用';
      it.applied = true;
      it.adopted = true;
      it.applied_option = oi;
      it.applied_at = new Date().toISOString();
      it.before = apply.find;
      it.after = apply.replace || '';
      ['compliance_scans', 'opening_scans', 'descriptions'].forEach(k => { if (r[k] && r[k].v1) r[k].v1.stale = true; });
      sc.applied = sc.issues.filter(i => i.applied).length;
      sc.pending = sc.issues.filter(i => i.status === '待选择').length;
      sc.program = analysis.scriptProgramStats(r) || sc.program;
      sc.adopted_at = new Date().toISOString();
      sc.stale_after_adopt = true; // 稿子已变:建议重新检查
      store.saveRun(r);
      return send(res, 200, { ok: true, applied: it.id, label, program: sc.program, applied_count: sc.applied, pending: sc.pending });
    }

    // 撤销"最后一次采用":只在当前稿仍等于那次改动后的文本时才允许,不猜
    const scUndoMatch = url.match(/^\/api\/runs\/([\w-]+)\/script-check\/undo$/);
    if (scUndoMatch && method === 'POST') {
      const r = store.getRun(scUndoMatch[1]);
      if (!r) return send(res, 404, { error: '任务不存在' });
      if (r.status !== 'done') return send(res, 400, { error: '仅已完成的任务可撤销' });
      if (r.script_v2) return send(res, 400, { error: '已生成 V2,V1 已锁定' });
      const sc = r.script_check;
      const list = (sc && sc.adoptions) || [];
      const last = list[list.length - 1];
      if (!last) return send(res, 400, { error: '没有可撤销的采用' });
      if (analysis.v1Text(r) !== last.after_text) return send(res, 409, { error: '稿子在这次采用之后又被改过,无法安全撤销' });
      if (r.script_v1) r.script_v1 = last.before_text; else r.final_script = last.before_text;
      const it = sc.issues && sc.issues[last.issue_index];
      if (it) { it.status = '待选择'; it.applied = false; it.adopted = false; delete it.applied_option; delete it.applied_at; }
      sc.adoptions = list.slice(0, -1);
      sc.applied = sc.issues.filter(i => i.applied).length;
      sc.pending = sc.issues.filter(i => i.status === '待选择').length;
      sc.program = analysis.scriptProgramStats(r) || sc.program;
      if (!sc.adoptions.length) sc.stale_after_adopt = false;
      ['compliance_scans', 'opening_scans', 'descriptions'].forEach(k => { if (r[k] && r[k].v1) r[k].v1.stale = true; });
      store.saveRun(r);
      return send(res, 200, { ok: true, undone: last.issue_id, applied_count: sc.applied, pending: sc.pending });
    }

    // ---------- 频道声音设定(流程 A4):列表 / 读取 / 保存(即人工确认)/ 删除 / AI 起草 ----------
    if (url === '/api/voices' && method === 'GET') return send(res, 200, voice.listVoices());
    if (url === '/api/voices' && method === 'POST') {
      const body = await readBody(req);
      const err = voice.voiceShapeError(body.voice);
      if (err) return send(res, 400, { error: '声音设定不合格: ' + err });
      return send(res, 200, voice.saveVoice(body.voice));
    }
    if (url === '/api/voices/draft' && method === 'POST') {
      const body = await readBody(req);
      try { return send(res, 200, await voice.draftVoice(body)); }
      catch (e) { return send(res, 500, { error: '起草失败: ' + e.message }); }
    }
    const voiceMatch = url.match(/^\/api\/voices\/([^/]+)$/);
    if (voiceMatch && (method === 'GET' || method === 'DELETE')) {
      const name = decodeURIComponent(voiceMatch[1]);
      if (method === 'DELETE') { voice.deleteVoice(name); return send(res, 200, { ok: true }); }
      const v = voice.getVoice(name);
      return v ? send(res, 200, v) : send(res, 404, { error: '没有这个声音设定' });
    }

    // 赛道证据卡列表(供重新分析时手动指定)
    if (url === '/api/track-cards' && method === 'GET') {
      return send(res, 200, analysis.loadTrackCards().map(c => ({ name: c.name, keywords: c.keywords })));
    }

    // ---------- 推送视频:存草稿 / 自动生视频 ----------
    // draft = 只建项目(视频网站里是 DRAFT 阶段);auto = 建项目后立即提交并开始全链路自动生产。
    // 同一版本重复推送需 confirm_duplicate=true(用户确认:已推送过先提示,可选择再建一个)。
    const pushVideoMatch = url.match(/^\/api\/runs\/([\w-]+)\/video$/);
    if (pushVideoMatch && method === 'POST') {
      const body = await readBody(req);
      const version = ['v1', 'v2', 'v1_5', 'v2_5'].includes(body.version) ? body.version : null;
      if (!version) return send(res, 400, { error: 'version 必须是 v1/v2/v1_5/v2_5 之一' });
      const mode = body.mode === 'auto' ? 'auto' : 'draft';
      try {
        const record = await pushToVideo(store.getRun(pushVideoMatch[1]), {
          version,
          mode,
          confirmDuplicate: !!body.confirm_duplicate
        });
        return send(res, 200, { ok: true, push: record, warning: record.error || null });
      } catch (e) {
        if (e.code === 'already_pushed') {
          return send(res, 409, { error: e.message, code: 'already_pushed', push: e.push });
        }
        return send(res, e.status ? 502 : 400, { error: e.message });
      }
    }

    // 爆款标记:行级、不绑定版本、仅已完成任务可标记;取消标记不限状态(防止状态回退后锁死)
    const viralMatch = url.match(/^\/api\/runs\/([\w-]+)\/viral$/);
    if (viralMatch && method === 'POST') {
      const body = await readBody(req);
      const r = store.getRun(viralMatch[1]);
      if (!r) return send(res, 404, { error: '任务不存在' });
      const current = !!(r.viral && r.viral.marked);
      const marked = typeof body.marked === 'boolean' ? body.marked : !current;
      if (marked && r.status !== 'done') return send(res, 400, { error: '仅已完成的任务可标记爆款(当前: ' + r.status + ')' });
      const saved = store.setRunViral(r.id, marked);
      if (!saved) return send(res, 404, { error: '任务不存在' });
      return send(res, 200, { ok: true, id: r.id, viral: saved.viral });
    }

    // 取消任务:排队中直接取消;生成中打标记,当前步骤跑完后由管线停置为 cancelled
    const cancelMatch = url.match(/^\/api\/runs\/([\w-]+)\/cancel$/);
    if (cancelMatch && method === 'POST') {
      const r = store.getRun(cancelMatch[1]);
      if (!r) return send(res, 404, { error: '任务不存在' });
      if (r.status === 'queued' || r.status === 'awaiting_review') {
        r.status = 'cancelled';
        store.saveRun(r);
        return send(res, 200, { ok: true, id: r.id, status: 'cancelled' });
      }
      if (r.status === 'running' || r.status === 'analyzing') {
        r.cancel_requested = true;
        store.saveRun(r);
        return send(res, 200, { ok: true, id: r.id, status: 'cancelling' });
      }
      return send(res, 400, { error: '仅排队中/分析中/待确认/生成中的任务可取消(当前: ' + r.status + ')' });
    }

    // ---------- 开头强化(外挂功能,不影响生成管线) ----------
    // 任意版本可强化:v1→V2、v2→V2.5(目标已存在时需 overwrite 确认),v1_5/v2_5 原地更新;
    // 每次执行都调用 LLM,不做结果缓存
    const boostMatch = url.match(/^\/api\/runs\/([\w-]+)\/boost$/);
    if (boostMatch && method === 'POST') {
      const body = await readBody(req);
      const r = store.getRun(boostMatch[1]);
      if (!r) return send(res, 404, { error: '任务不存在' });
      if (r.status !== 'done') return send(res, 400, { error: '仅已完成的任务可强化(当前: ' + r.status + ')' });
      const version = ['v1', 'v2', 'v1_5', 'v2_5'].includes(body.version) ? body.version : null;
      if (!version) return send(res, 400, { error: 'version 必须是 v1/v2/v1_5/v2_5 之一' });
      const baseText = description.versionText(r, version);
      if (!baseText) return send(res, 400, { error: '该版本文案不存在' });
      const chapters = [...new Set(Array.isArray(body.chapters) ? body.chapters : [])].filter(c => boost.CH_IDS.includes(c));
      if (!chapters.length) return send(res, 400, { error: '请至少选择一章(仅支持 ' + boost.CH_IDS.join('/') + ')' });
      if (!checks.parseChapters(baseText).length) return send(res, 400, { error: '该版本无章节时间戳标签,无法强化' });
      const wb = boost.resolveWriteBack(r, version, !!body.overwrite);
      if (wb.err) return send(res, 400, { error: wb.err });
      if (wb.conflict) return send(res, 409, { error: wb.conflict, code: 'overwrite_confirm' });
      const asset = store.getAsset(r.asset_id);
      if (!asset || !asset.srt || !asset.timeline) return send(res, 400, { error: '资产缺少 SRT 或 timeline,无法强化' });
      const cfg = pipeline.loadTweakConfig();
      if (!cfg || !cfg.api_key) return send(res, 400, { error: '未配置微调按钮的 API Key,请在设置页「微调按钮 API 配置」中选择有效渠道' });
      try {
        const result = await boost.boost(cfg, { asset, topic: r.topic, baseText, chapters });
        // 等待 LLM 期间任务可能被其他操作改动,合入最新记录再存,避免整对象覆盖
        const fresh = store.getRun(r.id);
        if (!fresh) return send(res, 404, { error: '任务不存在' });
        boost.applyResult(fresh, wb, baseText, result, chapters);
        store.saveRun(fresh);
        return send(res, 200, { ok: true, version, target: wb.target, chapters, secs: Math.round(result.secs * 10) / 10 });
      } catch (e) {
        return send(res, 502, { ok: false, error: e.message });
      }
    }

    // 从失败/已取消步骤续跑(已完成的步骤不重复调用)
    const retryMatch = url.match(/^\/api\/runs\/([\w-]+)\/retry$/);
    if (retryMatch && method === 'POST') {
      const r = store.getRun(retryMatch[1]);
      if (!r) return send(res, 404, { error: '任务不存在' });
      if (r.status !== 'failed' && r.status !== 'cancelled') {
        return send(res, 400, { error: '仅失败/已取消任务可重试(当前: ' + r.status + ')' });
      }
      // 历史任务若四步产物齐全、仅失败/取消于旧第五阶段:管线已回归四步,直接置 done(之后可用新版强化入口),避免无谓全量重跑
      const outs = r.outputs || {};
      const obStep = (r.steps || {}).opening_boost;
      if (obStep && obStep.status !== 'done' && outs.step1 && outs.step2 && outs.step3 && outs.step4) {
        r.status = 'done';
        r.current_step = 4;
        r.finished_at = new Date().toISOString();
        delete r.error;
        delete r.cancel_requested;
        store.saveRun(r);
        return send(res, 200, { ok: true, id: r.id });
      }
      if (r.draft_first) {
        review.resumeDraftFirst(r.id).catch(e => {
          const rr = store.getRun(r.id);
          if (rr) { rr.status = 'failed'; rr.error = '一键生成异常: ' + e.message; store.saveRun(rr); }
        });
        return send(res, 200, { ok: true, id: r.id });
      }
      // 新流程任务停在写前分析(未确认)时,重试 = 重新分析,不能跳过人工确认直接写稿
      if (r.pre_analysis && !r.analysis_confirmed) {
        analysis.runAnalysis(r.id).catch(e => {
          const rr = store.getRun(r.id);
          if (rr) { rr.status = 'failed'; rr.error = '写前分析异常: ' + e.message; store.saveRun(rr); }
        });
        return send(res, 200, { ok: true, id: r.id });
      }
      pipeline.runGeneration(r.id).catch(e => {
        const rr = store.getRun(r.id);
        if (rr) { rr.status = 'failed'; rr.error = '管线异常: ' + e.message; store.saveRun(rr); }
      });
      return send(res, 200, { ok: true, id: r.id });
    }

    const outputMatch = url.match(/^\/api\/runs\/([\w-]+)\/output\/(\w+)$/);
    if (outputMatch && method === 'GET') {
      const r = store.getRun(outputMatch[1]);
      if (!r || !r.outputs) return send(res, 404, { error: '产物不存在' }, 'text/plain; charset=utf-8');
      const key = outputMatch[2];
      if (key === 'final') return send(res, 200, r.final_script || '', 'text/plain; charset=utf-8');
      const map = { blueprint: 'step1', script: 'step2', audit: 'step3', optimized: 'step4' };
      if (!map[key] || !r.outputs[map[key]]) return send(res, 404, { error: '产物不存在' }, 'text/plain; charset=utf-8');
      return send(res, 200, r.outputs[map[key]], 'text/plain; charset=utf-8');
    }

    // ---------- 爆款指纹检测与替换(外挂功能,不影响生成管线) ----------
    // 检测:已存有该版本结果时直接返回(查看免费);force=true 才重新调 LLM 并覆盖旧结果
    const fpDetectMatch = url.match(/^\/api\/runs\/([\w-]+)\/fingerprint\/detect$/);
    if (fpDetectMatch && method === 'POST') {
      const body = await readBody(req);
      const r = store.getRun(fpDetectMatch[1]);
      if (!r) return send(res, 404, { error: '任务不存在' });
      if (r.status !== 'done') return send(res, 400, { error: '仅已完成的任务可检测(当前: ' + r.status + ')' });
      const base = body.base === 'v2' ? 'v2' : 'v1';
      const baseText = base === 'v2' ? r.script_v2 : (r.script_v1 || r.final_script);
      if (!baseText) return send(res, 400, { error: base === 'v2' ? '该任务无 V2 文案(未强化开头)' : '该任务暂无文案' });
      const scans = r.fingerprint_scans || {};
      if (scans[base] && !body.force) return send(res, 200, { ok: true, cached: true, scan: scans[base] });
      const cfg = pipeline.loadTweakConfig();
      if (!cfg || !cfg.api_key) return send(res, 400, { error: '未配置微调按钮的 API Key,请在设置页「微调按钮 API 配置」中选择有效渠道' });
      try {
        const scan = await fingerprint.detect(cfg, baseText);
        scan.scanned_at = new Date().toISOString();
        // 等待 LLM 期间任务可能被其他操作改动(如强化开头),合入最新记录再存,避免整对象覆盖
        const fresh = store.getRun(r.id);
        if (!fresh) return send(res, 404, { error: '任务不存在' });
        fresh.fingerprint_scans = { ...(fresh.fingerprint_scans || {}), [base]: scan };
        store.saveRun(fresh);
        return send(res, 200, { ok: true, cached: false, scan });
      } catch (e) {
        return send(res, 502, { ok: false, error: e.message });
      }
    }

    // 替换:始终从 base 原文重新生成 .5 版本(.5 = base + 本次确认的勾选),失败项标出原因不静默
    const fpReplaceMatch = url.match(/^\/api\/runs\/([\w-]+)\/fingerprint\/replace$/);
    if (fpReplaceMatch && method === 'POST') {
      const body = await readBody(req);
      const r = store.getRun(fpReplaceMatch[1]);
      if (!r) return send(res, 404, { error: '任务不存在' });
      if (r.status !== 'done') return send(res, 400, { error: '仅已完成的任务可替换(当前: ' + r.status + ')' });
      const base = body.base === 'v2' ? 'v2' : 'v1';
      const baseText = base === 'v2' ? r.script_v2 : (r.script_v1 || r.final_script);
      if (!baseText) return send(res, 400, { error: '该版本文案不存在' });
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return send(res, 400, { error: '未选择任何替换项' });
      if (items.length > 100) return send(res, 400, { error: '单次最多替换 100 处' });
      for (const it of items) {
        if (!it || typeof it.original !== 'string' || typeof it.suggestion !== 'string') {
          return send(res, 400, { error: '替换项格式不正确(需含 original 与 suggestion)' });
        }
        if (it.original.length > 2000 || it.suggestion.length > 2000) return send(res, 400, { error: '单条替换内容过长' });
      }
      const { result, replaced, failed } = fingerprint.applyReplacements(baseText, items);
      r[base === 'v2' ? 'script_v2_5' : 'script_v1_5'] = result;
      // 覆盖 .5 后,该版本的商业化检查、开头留存检查结果与视频简介基于旧文案,标记过期
      const halfVersion = base === 'v2' ? 'v2_5' : 'v1_5';
      if (r.compliance_scans && r.compliance_scans[halfVersion]) r.compliance_scans[halfVersion].stale = true;
      if (r.opening_scans && r.opening_scans[halfVersion]) r.opening_scans[halfVersion].stale = true;
      if (r.descriptions && r.descriptions[halfVersion]) r.descriptions[halfVersion].stale = true;
      // 回写检测结果中的命中状态(若该版本已检测过)
      const scan = (r.fingerprint_scans || {})[base];
      if (scan && Array.isArray(scan.hits)) {
        const statusById = {};
        replaced.forEach(x => { if (x.id) statusById[x.id] = 'replaced'; });
        failed.forEach(x => { if (x.id) statusById[x.id] = 'failed'; });
        scan.hits.forEach(h => { if (statusById[h.id]) h.status = statusById[h.id]; });
      }
      // 完整明细日志(最近 50 条封顶)
      r.fingerprint_log = [...(r.fingerprint_log || []), {
        ts: new Date().toISOString(), base,
        replaced_count: replaced.length, failed_count: failed.length,
        items: replaced.map(x => ({ chapter: x.chapter, original: x.original, replacement: x.replacement, occurrences: x.occurrences })),
        failed: failed.map(x => ({ chapter: x.chapter, original: x.original, reason: x.reason }))
      }].slice(-50);
      store.saveRun(r);
      return send(res, 200, { ok: true, replaced_count: replaced.length, failed });
    }

    // ---------- YouTube 商业化检查(外挂功能,不影响生成管线) ----------
    // 检测:与指纹检测同一约定,已存有该版本结果时直接返回(查看免费);force=true 才重新调 LLM 并覆盖
    const cpDetectMatch = url.match(/^\/api\/runs\/([\w-]+)\/compliance\/detect$/);
    if (cpDetectMatch && method === 'POST') {
      const body = await readBody(req);
      const r = store.getRun(cpDetectMatch[1]);
      if (!r) return send(res, 404, { error: '任务不存在' });
      if (r.status !== 'done') return send(res, 400, { error: '仅已完成的任务可检测(当前: ' + r.status + ')' });
      const version = ['v1', 'v2', 'v1_5', 'v2_5'].includes(body.version) ? body.version : null;
      if (!version) return send(res, 400, { error: 'version 必须是 v1/v2/v1_5/v2_5 之一' });
      const baseText = description.versionText(r, version);
      if (!baseText) return send(res, 400, { error: '该版本文案不存在' });
      let targetLanguage;
      try { targetLanguage = compliance.requireTargetLanguage((r.audience || {}).target_language); }
      catch (e) { return send(res, 400, { error: e.message, code: e.code }); }
      const scans = r.compliance_scans || {};
      if (scans[version] && !body.force) return send(res, 200, { ok: true, cached: true, scan: scans[version] });
      const cfg = pipeline.loadTweakConfig();
      if (!cfg || !cfg.api_key) return send(res, 400, { error: '未配置微调按钮的 API Key,请在设置页「微调按钮 API 配置」中选择有效渠道' });
      try {
        const scan = await compliance.detect(cfg, baseText, targetLanguage);
        scan.scanned_at = new Date().toISOString();
        scan.stale = false;
        // 等待 LLM 期间任务可能被其他操作改动,合入最新记录再存,避免整对象覆盖
        const fresh = store.getRun(r.id);
        if (!fresh) return send(res, 404, { error: '任务不存在' });
        fresh.compliance_scans = { ...(fresh.compliance_scans || {}), [version]: scan };
        store.saveRun(fresh);
        return send(res, 200, { ok: true, cached: false, scan });
      } catch (e) {
        return send(res, e.code === 'TARGET_LANGUAGE_CONFLICT' ? 422 : 502, { ok: false, error: e.message, code: e.code });
      }
    }

    // 替换:采纳自 v1/v2 生成对应 .5(已存在时需 overwrite 确认);采纳自 v1_5/v2_5 原地更新该版本
    const cpReplaceMatch = url.match(/^\/api\/runs\/([\w-]+)\/compliance\/replace$/);
    if (cpReplaceMatch && method === 'POST') {
      const body = await readBody(req);
      const r = store.getRun(cpReplaceMatch[1]);
      if (!r) return send(res, 404, { error: '任务不存在' });
      if (r.status !== 'done') return send(res, 400, { error: '仅已完成的任务可替换(当前: ' + r.status + ')' });
      const version = ['v1', 'v2', 'v1_5', 'v2_5'].includes(body.version) ? body.version : null;
      if (!version) return send(res, 400, { error: 'version 必须是 v1/v2/v1_5/v2_5 之一' });
      const baseText = description.versionText(r, version);
      if (!baseText) return send(res, 400, { error: '该版本文案不存在' });
      try { compliance.requireTargetLanguage((r.audience || {}).target_language); }
      catch (e) { return send(res, 400, { error: e.message, code: e.code }); }
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return send(res, 400, { error: '未选择任何替换项' });
      if (items.length > 100) return send(res, 400, { error: '单次最多替换 100 处' });
      for (const it of items) {
        if (!it || typeof it.original !== 'string' || typeof it.suggestion !== 'string') {
          return send(res, 400, { error: '替换项格式不正确(需含 original 与 suggestion)' });
        }
        if (it.original.length > 6000 || it.suggestion.length > 6000) return send(res, 400, { error: '单条替换内容过长' });
      }
      const target = version === 'v1' ? 'v1_5' : version === 'v2' ? 'v2_5' : version;
      const field = target === 'v1_5' ? 'script_v1_5' : 'script_v2_5';
      const { result, replaced, failed } = textloc.applyReplacements(baseText, items);
      // 没有成功项时只返回失败原因,不生成/覆盖文案或改动缓存、日志。
      if (!replaced.length) return send(res, 200, { ok: true, replaced_count: 0, failed, target });
      if (target !== version && r[field] && !body.overwrite) {
        return send(res, 409, { error: (target === 'v1_5' ? 'V1.5' : 'V2.5') + ' 已存在,采纳将覆盖其当前内容', code: 'overwrite_confirm' });
      }
      r[field] = result;
      // 回写检测结果中的命中状态(结果来自哪个版本的检测,就回写哪个)
      const scan = (r.compliance_scans || {})[version];
      if (scan && Array.isArray(scan.hits)) {
        const statusById = {};
        replaced.forEach(x => { if (x.id) statusById[x.id] = 'replaced'; });
        failed.forEach(x => { if (x.id) statusById[x.id] = 'failed'; });
        scan.hits.forEach(h => { if (statusById[h.id]) h.status = statusById[h.id]; });
        // 采纳自 .5 的原地修改使本次扫描基于旧文案,标记过期;v1/v2 底版未动,其扫描不过期
        if (target === version) scan.stale = true;
      }
      // 被覆盖版本(v1/v2 → .5)的旧缓存一律过期:商业化扫描与视频简介
      if (target !== version && r.compliance_scans && r.compliance_scans[target]) r.compliance_scans[target].stale = true;
      // 商业化采纳改动了 target 文案(覆盖或原地),该版本的开头留存检查结果同样基于旧文案,标记过期
      if (r.opening_scans && r.opening_scans[target]) r.opening_scans[target].stale = true;
      if (r.descriptions && r.descriptions[target]) r.descriptions[target].stale = true;
      // 完整明细日志(最近 50 条封顶)
      r.compliance_log = [...(r.compliance_log || []), {
        ts: new Date().toISOString(), version, target,
        replaced_count: replaced.length, failed_count: failed.length,
        items: replaced.map(x => ({ chapter: x.chapter, original: x.original, replacement: x.replacement, occurrences: x.occurrences })),
        failed: failed.map(x => ({ chapter: x.chapter, original: x.original, reason: x.reason }))
      }].slice(-50);
      store.saveRun(r);
      return send(res, 200, { ok: true, replaced_count: replaced.length, failed, target });
    }

    // ---------- 开头留存检查(外挂功能,不影响生成管线;模式与商业化检查一致) ----------
    // 检测:已存有该版本结果时直接返回(查看免费);force=true 才重新调 LLM 并覆盖;无章节时间戳的版本拒绝检测
    const orDetectMatch = url.match(/^\/api\/runs\/([\w-]+)\/opening\/detect$/);
    if (orDetectMatch && method === 'POST') {
      const body = await readBody(req);
      const r = store.getRun(orDetectMatch[1]);
      if (!r) return send(res, 404, { error: '任务不存在' });
      if (r.status !== 'done') return send(res, 400, { error: '仅已完成的任务可检测(当前: ' + r.status + ')' });
      const version = ['v1', 'v2', 'v1_5', 'v2_5'].includes(body.version) ? body.version : null;
      if (!version) return send(res, 400, { error: 'version 必须是 v1/v2/v1_5/v2_5 之一' });
      const baseText = description.versionText(r, version);
      if (!baseText) return send(res, 400, { error: '该版本文案不存在' });
      if (!opening.hasChapterTimestamps(baseText)) return send(res, 400, { error: '该版本无章节时间戳,无法按 30 秒口径检查' });
      const scans = r.opening_scans || {};
      if (scans[version] && !body.force) return send(res, 200, { ok: true, cached: true, scan: scans[version] });
      const cfg = pipeline.loadTweakConfig();
      if (!cfg || !cfg.api_key) return send(res, 400, { error: '未配置微调按钮的 API Key,请在设置页「微调按钮 API 配置」中选择有效渠道' });
      try {
        const scan = await opening.detect(cfg, baseText, { topic: r.topic, audience: r.audience });
        scan.scanned_at = new Date().toISOString();
        scan.stale = false;
        // 等待 LLM 期间任务可能被其他操作改动,合入最新记录再存,避免整对象覆盖
        const fresh = store.getRun(r.id);
        if (!fresh) return send(res, 404, { error: '任务不存在' });
        fresh.opening_scans = { ...(fresh.opening_scans || {}), [version]: scan };
        store.saveRun(fresh);
        return send(res, 200, { ok: true, cached: false, scan });
      } catch (e) {
        return send(res, 502, { ok: false, error: e.message });
      }
    }

    // 替换:采纳自 v1/v2 生成对应 .5(已存在时需 overwrite 确认);采纳自 v1_5/v2_5 原地更新该版本
    const orReplaceMatch = url.match(/^\/api\/runs\/([\w-]+)\/opening\/replace$/);
    if (orReplaceMatch && method === 'POST') {
      const body = await readBody(req);
      const r = store.getRun(orReplaceMatch[1]);
      if (!r) return send(res, 404, { error: '任务不存在' });
      if (r.status !== 'done') return send(res, 400, { error: '仅已完成的任务可替换(当前: ' + r.status + ')' });
      const version = ['v1', 'v2', 'v1_5', 'v2_5'].includes(body.version) ? body.version : null;
      if (!version) return send(res, 400, { error: 'version 必须是 v1/v2/v1_5/v2_5 之一' });
      const baseText = description.versionText(r, version);
      if (!baseText) return send(res, 400, { error: '该版本文案不存在' });
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return send(res, 400, { error: '未选择任何替换项' });
      if (items.length > 100) return send(res, 400, { error: '单次最多替换 100 处' });
      for (const it of items) {
        if (!it || typeof it.original !== 'string' || typeof it.suggestion !== 'string') {
          return send(res, 400, { error: '替换项格式不正确(需含 original 与 suggestion)' });
        }
        if (it.original.length > 6000 || it.suggestion.length > 6000) return send(res, 400, { error: '单条替换内容过长' });
      }
      const target = version === 'v1' ? 'v1_5' : version === 'v2' ? 'v2_5' : version;
      const field = target === 'v1_5' ? 'script_v1_5' : 'script_v2_5';
      if (target !== version && r[field] && !body.overwrite) {
        return send(res, 409, { error: (target === 'v1_5' ? 'V1.5' : 'V2.5') + ' 已存在,采纳将覆盖其当前内容', code: 'overwrite_confirm' });
      }
      const { result, replaced, failed } = textloc.applyReplacements(baseText, items);
      r[field] = result;
      // 回写检测结果中的命中状态(结果来自哪个版本的检测,就回写哪个)
      const scan = (r.opening_scans || {})[version];
      if (scan && Array.isArray(scan.hits)) {
        const statusById = {};
        replaced.forEach(x => { if (x.id) statusById[x.id] = 'replaced'; });
        failed.forEach(x => { if (x.id) statusById[x.id] = 'failed'; });
        scan.hits.forEach(h => { if (statusById[h.id]) h.status = statusById[h.id]; });
        // 采纳自 .5 的原地修改使本次扫描基于旧文案,标记过期;v1/v2 底版未动,其扫描不过期
        if (target === version) scan.stale = true;
      }
      // target 文案已变:该版本的商业化扫描与视频简介一律过期;覆盖场景下 target 已有的留存扫描同样过期
      if (r.compliance_scans && r.compliance_scans[target]) r.compliance_scans[target].stale = true;
      if (target !== version && r.opening_scans && r.opening_scans[target]) r.opening_scans[target].stale = true;
      if (r.descriptions && r.descriptions[target]) r.descriptions[target].stale = true;
      // 完整明细日志(最近 50 条封顶)
      r.opening_log = [...(r.opening_log || []), {
        ts: new Date().toISOString(), version, target,
        replaced_count: replaced.length, failed_count: failed.length,
        items: replaced.map(x => ({ chapter: x.chapter, original: x.original, replacement: x.replacement, occurrences: x.occurrences })),
        failed: failed.map(x => ({ chapter: x.chapter, original: x.original, reason: x.reason }))
      }].slice(-50);
      store.saveRun(r);
      return send(res, 200, { ok: true, replaced_count: replaced.length, failed, target });
    }

    // ---------- 视频简介生成(外挂功能,不影响生成管线) ----------
    // 与指纹检测同一约定:已存有该版本结果时直接返回(查看免费);force=true 才重新调 LLM 并覆盖
    const descMatch = url.match(/^\/api\/runs\/([\w-]+)\/description$/);
    if (descMatch && method === 'POST') {
      const body = await readBody(req);
      const r = store.getRun(descMatch[1]);
      if (!r) return send(res, 404, { error: '任务不存在' });
      if (r.status !== 'done') return send(res, 400, { error: '仅已完成的任务可生成简介(当前: ' + r.status + ')' });
      const version = ['v1', 'v2', 'v1_5', 'v2_5'].includes(body.version) ? body.version : null;
      if (!version) return send(res, 400, { error: 'version 必须是 v1/v2/v1_5/v2_5 之一' });
      const baseText = description.versionText(r, version);
      if (!baseText) return send(res, 400, { error: '该版本文案不存在' });
      const descs = r.descriptions || {};
      if (descs[version] && !body.force) return send(res, 200, { ok: true, cached: true, description: descs[version] });
      const cfg = pipeline.loadTweakConfig();
      if (!cfg || !cfg.api_key) return send(res, 400, { error: '未配置微调按钮的 API Key,请在设置页「微调按钮 API 配置」中选择有效渠道' });
      try {
        const desc = await description.generate(cfg, r.topic, baseText, (r.audience || {}).target_language);
        desc.generated_at = new Date().toISOString();
        // 等待 LLM 期间任务可能被其他操作改动,合入最新记录再存,避免整对象覆盖
        const fresh = store.getRun(r.id);
        if (!fresh) return send(res, 404, { error: '任务不存在' });
        fresh.descriptions = { ...(fresh.descriptions || {}), [version]: desc };
        store.saveRun(fresh);
        return send(res, 200, { ok: true, cached: false, description: desc });
      } catch (e) {
        return send(res, 502, { ok: false, error: e.message });
      }
    }

    // ---------- 静态文件 ----------
    if (method === 'GET') {
      let p = url === '/' ? '/index.html' : url;
      const file = path.join(PUBLIC_DIR, path.normalize(p).replace(/^([/\\])+/, ''));
      if (file.startsWith(PUBLIC_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
      }
    }

    send(res, 404, { error: 'Not found: ' + method + ' ' + url });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  store.ensureDirs();
  // 预热任务列表索引(不存在/已过期则在此重建一次),避免第一次打开列表页时要等全量解析
  try { store.queryRuns({ page: 1, pageSize: 50 }); } catch (e) { console.log('任务索引预热失败(不影响运行): ' + e.message); }
  const os = require('os');
  const nets = os.networkInterfaces();
  const lan = Object.values(nets).flat().find(n => n && n.family === 'IPv4' && !n.internal);
  console.log(`服务已启动:`);
  console.log(`  本机:   http://localhost:${PORT}`);
  console.log(`  局域网: http://${lan ? lan.address : '<本机IP>'}:${PORT}`);

  // 启动恢复:上次进程退出(重启/崩溃)时被中断的任务会永久卡在"生成中",此处自动接管,从断点步骤续跑(已完成步骤的产物已落盘,不重复调用)。
  // 前提:单实例运行(多实例共用同一数据目录会重复调用且 run 文件有写竞争);用户已点取消的任务尊重意图不接管
  const orphans = store.listRuns().filter(r => (r.status === 'running' || r.status === 'analyzing') && !r.cancel_requested);
  for (const r of orphans) {
    // 一键生成:还没写稿就从头跑,写稿中断就接着写
    if (r.draft_first) {
      console.log(`接管中断的一键生成: ${r.id} (${r.topic || ''})`);
      review.resumeDraftFirst(r.id).catch(e => {
        const rr = store.getRun(r.id);
        if (rr) { rr.status = 'failed'; rr.error = '一键生成异常: ' + e.message; store.saveRun(rr); }
      });
      continue;
    }
    // 写前分析没有断点产物:接管 = 重跑一次分析(停在 awaiting_review,不会自动写稿)
    if (r.status === 'analyzing') {
      console.log(`接管中断的写前分析: ${r.id} (${r.topic || ''})`);
      analysis.runAnalysis(r.id).catch(e => {
        const rr = store.getRun(r.id);
        if (rr) { rr.status = 'failed'; rr.error = '写前分析异常: ' + e.message; store.saveRun(rr); }
      });
      continue;
    }
    console.log(`接管中断任务: ${r.id} (${r.topic || ''})`);
    pipeline.runGeneration(r.id).catch(e => {
      const rr = store.getRun(r.id);
      if (rr) { rr.status = 'failed'; rr.error = '管线异常: ' + e.message; store.saveRun(rr); }
    });
  }
  // 分析中已请求取消但进程已退出:没有活着的调用会来落实这个标记,直接落成已取消(否则永久卡在"分析中",界面无出口)
  for (const r of store.listRuns().filter(x => x.status === 'analyzing' && x.cancel_requested)) {
    r.status = 'cancelled';
    r.steps = { ...(r.steps || {}), analysis: { ...((r.steps || {}).analysis || {}), status: 'failed' } };
    store.saveRun(r);
    console.log(`取消中断的写前分析: ${r.id}`);
  }
});
