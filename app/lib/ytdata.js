// YouTube 真实数据(插件 extension/ 从 Studio 数据分析页抓来):按视频标题找到对应的文案任务存起来,
// 把留存曲线按字数比例对到每一章、每一句,给人看「观众在哪几句走掉的」,也打成分析包交给 AI 复盘。
// 原始抓取(含 Studio 接口原样返回)存 data/yt_analytics/<视频ID>/,不入库;任务文件里只留指标、曲线和摘要。
const fs = require('fs');
const path = require('path');
const store = require('./store');
const checks = require('./checks');

const RAW_ROOT = path.join(__dirname, '..', 'data', 'yt_analytics');
const RUNS_ROOT = path.join(__dirname, '..', 'data', 'runs');

// Studio 界面的指标名(简中 / 英文 / 韩文界面)
const METRICS = {
  views: ['观看次数', 'Views', '조회수'],
  watch_hours: ['观看时长（小时）', '观看时长(小时)', 'Watch time (hours)', '시청 시간(단위: 시간)'],
  subscribers: ['订阅人数', 'Subscribers', '구독자'],
  impressions: ['缩略图展示次数', '展示次数', 'Impressions', '노출수'],
  ctr: ['缩略图点击率', '展示点击率', 'Impressions click-through rate', '노출 클릭률'],
  engaged_views: ['深度观看次数', 'Engaged views'],
  avg_view_duration: ['平均观看时长', 'Average view duration', '평균 시청 지속 시간'],
  avg_view_pct: ['平均观看百分比', 'Average percentage viewed', '평균 조회율'],
  unique_viewers: ['唯一身份观看者人数', '独立观看者', 'Unique viewers', '순시청자수', '순 시청자수'],
  returning_viewers: ['回访观看者', 'Returning viewers', '재방문 시청자'],
  new_viewers: ['新观看者', 'New viewers', '신규 시청자']
};
const VALUE = /^[-+]?[\d.,:]+\s*(%|万|千|亿|K|M|천|만)?$/;

function parseMetrics(tabs) {
  const out = {};
  // 先看 概览/覆盖面/互动(主指标卡);观众页里「观看次数 · 自上传以来」下面跟的是地区占比,不能当观看次数
  const order = ['overview', 'reach', 'engagement', 'audience'];
  const list = Object.entries(tabs || {}).sort((a, b) => (order.indexOf(a[0]) + 1 || 9) - (order.indexOf(b[0]) + 1 || 9)).map(x => x[1]);
  for (const tab of list) {
    const lines = String((tab && tab.text) || '').split('\n').map(s => s.trim()).filter(Boolean);
    for (const [key, labels] of Object.entries(METRICS)) {
      if (out[key]) continue;
      for (let i = 0; i < lines.length && !out[key]; i++) {
        if (!labels.includes(lines[i])) continue;
        const v = VALUE.test(lines[i + 1] || '') ? lines[i + 1] : null; // 只认紧跟的下一行(「—」表示没数据,不往下找)
        if (v) out[key] = v;
      }
    }
  }
  return out;
}

// YouTube 自己给的说明句(如「在 0:30 左右的标记时段有 42% 的观看者仍在观看」)
function parseInsights(tabs) {
  const seen = new Set(), out = [];
  for (const [k, tab] of Object.entries(tabs || {})) {
    String((tab && tab.text) || '').split('\n').map(s => s.trim())
      .filter(s => s.length >= 15 && s.length <= 300 && /\d/.test(s) && /%|观看者|观众|viewers|시청자/.test(s))
      .forEach(s => { if (!seen.has(s)) { seen.add(s); out.push({ tab: k, text: s }); } });
  }
  return out.slice(0, 40);
}

// 留存曲线首选 Studio 接口里的 retentionValues(100 个点,均匀铺满全片,精确值);
// 接口里没有才用页面图表换算的曲线。
function retentionFromResponses(responses, vid, duration) {
  for (const r of responses || []) {
    if (!/get_screen|get_cards/.test(r.url || '')) continue;
    let j; try { j = JSON.parse(r.body); } catch (e) { continue; }
    const stack = [j];
    while (stack.length) {
      const o = stack.pop();
      if (!o || typeof o !== 'object') continue;
      if (Array.isArray(o.videosData)) {
        const v = o.videosData.find(x => x && Array.isArray(x.retentionValues) && (!vid || x.videoId === vid));
        if (v && v.retentionValues.length > 10) {
          const n = v.retentionValues.length, mt = v.metricTotals || {};
          const dur = duration || (mt.avgViewDurationMillis && mt.avgPercentageWatched ? Math.round(mt.avgViewDurationMillis / 1000 / mt.avgPercentageWatched) : null);
          if (!dur) continue;
          // 每个值都是「1/人数」的整数倍(如 2.17% = 1/46):最小的非零值≈ 一个人占的百分比,用来估这条曲线是多少人算出来的
          const minV = Math.min(...v.retentionValues.filter(x => x > 0));
          return { source: 'studio_api', duration_sec: dur, sample_viewers: isFinite(minV) && minV < 50 ? Math.round(100 / minV) : null,
            points: v.retentionValues.map((x, i) => [Math.round(i * dur / (n - 1) * 10) / 10, x]),
            totals: mt, highlights: v.highlights || [] };
        }
      }
      Object.values(o).forEach(x => { if (x && typeof x === 'object') stack.push(x); });
    }
  }
  return null;
}

// 页面图表换算的曲线:概览页带 100%/0% 刻度、第一个点接近 100% 的那条线
function pickRetention(tabs) {
  const charts = [];
  for (const k of ['overview', 'engagement']) ((tabs || {})[k] || {}).charts && tabs[k].charts.forEach(c => charts.push(c));
  let best = null;
  for (const c of charts) for (const s of c.series || []) {
    const pts = (s.points || []).filter(p => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]));
    if (pts.length < 10 || pts[0][1] < 60) continue;
    const score = (s.dashed ? 0 : 1000) + pts.length;
    if (!best || score > best.score) best = { score, duration_sec: c.duration_sec, points: pts, title: c.title };
  }
  if (!best) return null;
  // 最多留 400 个点
  const step = Math.max(1, Math.ceil(best.points.length / 400));
  return { duration_sec: best.duration_sec, title: best.title, points: best.points.filter((p, i) => i % step === 0 || i === best.points.length - 1).map(p => [p[0], Math.min(100, Math.max(0, Math.round(p[1] * 10) / 10))]) };
}

function retentionAt(curve, sec) {
  const p = curve.points;
  if (sec <= p[0][0]) return p[0][1];
  for (let i = 1; i < p.length; i++) if (p[i][0] >= sec) {
    const [x0, y0] = p[i - 1], [x1, y1] = p[i];
    return Math.round((y0 + (y1 - y0) * (sec - x0) / Math.max(x1 - x0, 1e-9)) * 10) / 10;
  }
  return p[p.length - 1][1];
}

// ---------- 找任务 ----------
const norm = s => String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim();
function allRuns() {
  try { return fs.readdirSync(RUNS_ROOT).filter(f => /^run_\w+\.json$/.test(f)).map(f => store.getRun(f.slice(0, -5))).filter(Boolean); } catch (e) { return []; }
}
const runTitles = r => [r.topic, ...((r.video_pushes || []).map(p => p.project_title))].map(norm).filter(t => t.length >= 6);
function titleMatches(run, lines) {
  return runTitles(run).some(t => lines.some(l => l === t || l.includes(t) || (l.length >= 10 && t.startsWith(l))));
}
function candidateLines(payload) {
  const texts = [...(payload.titles || []), ...Object.values(payload.tabs || {}).map(t => String((t && t.text) || '').slice(0, 5000))];
  const lines = new Set();
  texts.forEach(t => String(t).split('\n').forEach(l => {
    const s = norm(l).replace(/\s*(…|\.\.\.)$/, '').replace(/\s*-\s*YouTube Studio$/i, '');
    if (s.length >= 8 && s.length <= 300) lines.add(s);
  }));
  return [...lines];
}
const runLabel = r => (r.topic || r.id) + ' · ' + String(r.created_at || '').slice(0, 10) + ((r.video_pushes || []).length ? ' · 已推视频' : '');

// 返回 { run } 或 { error, status, candidates }
function findRun(payload) {
  if (payload.run_id) {
    const r = store.getRun(payload.run_id);
    return r ? { run: r, matched_by: '手选' } : { status: 404, error: '任务不存在:' + payload.run_id };
  }
  const runs = allRuns();
  const bound = runs.filter(r => r.yt_analytics && r.yt_analytics.video_id === payload.video_id);
  if (bound.length) return { run: bound.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0], matched_by: '视频 ID' };
  const lines = candidateLines(payload);
  const hits = runs.filter(r => titleMatches(r, lines));
  if (!hits.length) return { status: 404, error: '没找到标题对得上的文案任务。可以在插件里填任务 ID 再发,或者确认视频标题和任务标题一致。', candidates: [] };
  // 同标题跑过多次:优先推过视频的那篇
  const pushed = hits.filter(r => (r.video_pushes || []).length);
  const pool = pushed.length ? pushed : hits;
  if (pool.length === 1) return { run: pool[0], matched_by: '标题' };
  return { status: 409, error: '有 ' + pool.length + ' 篇同标题的文案,请选这条视频用的是哪一篇:',
    candidates: pool.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map(r => ({ run_id: r.id, label: runLabel(r) })) };
}

// ---------- 保存 ----------
function saveCapture(payload, run, matchedBy) {
  const at = new Date().toISOString();
  const vid = String(payload.video_id || 'unknown').replace(/[^\w-]/g, '');
  const dir = path.join(RAW_ROOT, vid);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, at.replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(file, JSON.stringify({ ...payload, run_id: run.id, saved_at: at }), 'utf-8');
  const metrics = parseMetrics(payload.tabs);
  const latest = {
    at, period: payload.period || '', file: path.relative(path.join(__dirname, '..'), file),
    tabs: Object.keys(payload.tabs || {}), responses: (payload.responses || []).length,
    metrics, insights: parseInsights(payload.tabs), curve: null
  };
  const chart = pickRetention(payload.tabs);
  latest.curve = retentionFromResponses(payload.responses, vid, chart && chart.duration_sec) || (chart && { source: 'chart', ...chart });
  const prev = run.yt_analytics || {};
  run.yt_analytics = {
    video_id: vid, matched_by: matchedBy, latest,
    history: [...(prev.history || []), { at, period: latest.period, metrics }].slice(-30)
  };
  store.saveRun(run, { touch: false });
  return latest;
}

// ---------- 对到文案 ----------
// 推到视频的那一版;没有推送记录就用确认的版本,再没有就用 V1
function publishedText(run) {
  const pushes = run.video_pushes || [];
  const ver = (pushes.length && pushes[pushes.length - 1].version) || (run.confirmed_version && run.confirmed_version.version) || 'v1';
  const pick = { v1: run.script_v1 || run.final_script, v2: run.script_v2, v1_5: run.script_v1_5, v2_5: run.script_v2_5 }[ver];
  return { version: ver, text: checks.extractFinalScript(pick || run.script_v1 || run.final_script || '') };
}

// 配音语速基本均匀:按字数比例估每句在视频里的时间,再查那一秒还剩多少观众
function alignScript(run) {
  const ya = run.yt_analytics, curve = ya && ya.latest && ya.latest.curve;
  if (!curve) return null;
  const { version, text } = publishedText(run);
  const lines = text.split('\n');
  const weight = l => /^\s*\[CH\d+/.test(l) || /^\s*(---|#)/.test(l) ? 0 : Math.max(checks.countWords(l), l.trim() ? 1 : 0);
  const total = lines.reduce((n, l) => n + weight(l), 0) || 1;
  const dur = curve.duration_sec;
  let acc = 0, ch = null;
  const rows = [], chapters = [];
  for (const l of lines) {
    const tag = l.match(/^\s*\[CH(\d+)\s*\|[^|]*\|\s*([^\]]+)\]/);
    if (tag) { ch = { ch: 'CH' + tag[1], fn: tag[2].trim(), start_sec: Math.round(acc / total * dur), lines: 0 }; chapters.push(ch); continue; }
    const w = weight(l);
    if (!w || !l.trim()) continue;
    const s = acc / total * dur, e = (acc + w) / total * dur;
    rows.push({ ch: ch ? ch.ch : '', start_sec: Math.round(s), end_sec: Math.round(e), ret_start: retentionAt(curve, s), ret_end: retentionAt(curve, e), text: l.trim() });
    if (ch) ch.lines++;
    acc += w;
  }
  chapters.forEach((c, i) => {
    c.end_sec = i + 1 < chapters.length ? chapters[i + 1].start_sec : dur;
    c.ret_start = retentionAt(curve, c.start_sec);
    c.ret_end = retentionAt(curve, c.end_sec);
    c.lost = Math.round((c.ret_start - c.ret_end) * 10) / 10; // 百分点
    c.lost_share = c.ret_start > 0 ? Math.round((c.ret_start - c.ret_end) / c.ret_start * 1000) / 10 : null; // 进这章的人里走了多少 %
  });
  // 掉得最多的句子(每句流失的百分点)
  const worst = rows.map((r, i) => ({ i, drop: Math.round((r.ret_start - r.ret_end) * 10) / 10 })).sort((a, b) => b.drop - a.drop).slice(0, 12).map(x => ({ ...rows[x.i], drop: x.drop }));
  return { version, duration_sec: dur, chapters, lines: rows, worst_lines: worst };
}

// 分析包:真实数据 + 推出去的文案 + 程序自己的各项打分,给 AI 复盘用
function bundle(run) {
  const ya = run.yt_analytics || {}, latest = ya.latest || {};
  let raw = null;
  try { raw = latest.file ? JSON.parse(fs.readFileSync(path.join(__dirname, '..', latest.file), 'utf-8')) : null; } catch (e) {}
  const rv = run.review || {}, fin = rv.final || {};
  const op = ((run.opening_scans || {})[publishedText(run).version] || {}).summary || null;
  return {
    run_id: run.id, topic: run.topic, framework: run.asset_name, audience: run.audience,
    video_id: ya.video_id, captured_at: latest.at, period: latest.period,
    metrics: latest.metrics, insights: latest.insights, history: ya.history,
    retention_curve: latest.curve, aligned: alignScript(run),
    published_script: publishedText(run),
    internal_scores: {
      final_review: fin.scores_before ? { before: fin.scores_before, after: fin.scores_after, verdict: fin.verdict, track: fin.track_name } : null,
      opening_check: op, retention_check: (run.checks || {}).retention || null
    },
    studio_text: raw ? Object.fromEntries(Object.entries(raw.tabs || {}).map(([k, t]) => [k, String(t.text || '').slice(0, 20000)])) : null
  };
}

module.exports = { parseMetrics, parseInsights, pickRetention, retentionFromResponses, retentionAt, findRun, saveCapture, alignScript, bundle, publishedText };
