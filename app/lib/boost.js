// 开头强化(外挂独立模块,不影响生成管线):
// 对已完成任务的任意版本(V1/V2/V1.5/V2.5)按勾选的 CH01/CH02 做逐句 1:1 仿写重写。
// 写回规则:v1→script_v2、v2→script_v2_5(目标已存在需 overwrite 确认);v1_5/v2_5 原地更新。
// 每次执行都调用 LLM,不做结果缓存。
const checks = require('./checks');
const pipeline = require('./pipeline'); // 复用 llmCall / fillTemplate / loadTemplates(提示词与调用的单一来源)
const textnorm = require('./textnorm'); // 模型把标签行写成 **[CH..]** 时先剥装饰,避免闸门逐字比较失败白跑一次重试

const CH_IDS = ['CH01', 'CH02']; // 仅开头两章可强化(源锚点数据只覆盖前两段)

function parseSrt(srt) {
  const cues = [];
  for (const b of srt.split(/\r?\n\r?\n/)) {
    const lines = b.split(/\r?\n/).filter(Boolean);
    if (lines.length < 3) continue;
    const m = lines[1].match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->/);
    if (!m) continue;
    const ms = (+m[1]) * 3600000 + (+m[2]) * 60000 + (+m[3]) * 1000 + (+m[4].padEnd(3, '0').slice(0, 3));
    cues.push({ startMs: ms, text: lines.slice(2).join(' ') });
  }
  return cues;
}

// 按 timeline.observed_segments 前两段(promise_setup 及下一段)的精确 timecode 切源 SRT,附留存设计与词数
// 返回 { segTexts, segWords, rulesText }:segTexts[i] ↔ CH0(i+1);无锚点数据时 segTexts 为空
function buildOpeningAnchor(asset) {
  let tl = null;
  try { tl = JSON.parse(asset.timeline || '{}'); } catch (e) {}
  const segs = ((tl && tl.data && tl.data.observed_segments) || []).slice(0, 2);
  const rules = ((tl && tl.data && tl.data.pacing_rules) || []).map(r => r.rule).filter(Boolean);
  if (!segs.length || !asset.srt) return { segTexts: [], segWords: [], rulesText: '' };
  const cues = parseSrt(asset.srt);
  const wc = t => t.split(/\s+/).filter(Boolean).length;
  const segWords = [];
  const segTexts = segs.map((s, i) => {
    const text = cues.filter(c => c.startMs >= (s.start_ms || 0) && c.startMs < (s.end_ms || Infinity)).map(c => c.text).join(' ');
    segWords.push(wc(text));
    return `--- 锚点段 ${i + 1}:${s.primary_function || ''}(${s.start_timecode || ''} - ${s.end_timecode || ''},约 ${segWords[i]} 词) ---\n信息动作:${s.information_move || '-'}\n留存触发:${(s.retention_triggers || []).join(', ') || '-'}\n原文:\n${text || '(空)'}`;
  });
  const rulesText = rules.length ? '--- 节奏规则 ---\n' + rules.map(r => '- ' + r).join('\n') : '';
  return { segTexts, segWords, rulesText };
}

// 截取底版的前几章(CH01 标签行起,到第 count+1 章标签行前),只给模型局部上下文防止锚定全文做最小编辑
function sliceChapters(base, count) {
  const tagRe = /^\[CH(\d+)\s*\|[^\]]*\]$/;
  const lines = base.split('\n');
  const idx = [];
  lines.forEach((l, i) => { if (tagRe.test(l.trim())) idx.push(i); });
  if (!idx.length) return base;
  const end = idx.length > count ? idx[count] : lines.length;
  return lines.slice(idx[0], end).join('\n').trim();
}

// 解析模型输出的选中章并机械拼接回底版(标签行用底版原文,未选中章逐字不变)
// chapters 为 CH_IDS 的子集;expectedWords: { CH01: n, CH02: n }(锚点段词数,缺省回退底版原章词数)
function spliceChapters(base, out, chapters, expectedWords) {
  const tagRe = /^\[CH(\d+)\s*\|[^\]]*\]$/;
  const normTag = l => l.trim().replace(/\s+/g, ' ');
  const words = t => t.split(/\s+/).filter(Boolean).length;

  const baseLines = base.split('\n');
  const baseIdx = [];
  baseLines.forEach((l, i) => { if (tagRe.test(l.trim())) baseIdx.push(i); });
  const chNums = chapters.map(c => parseInt(c.slice(2), 10)).sort((a, b) => a - b);
  const maxCh = chNums[chNums.length - 1]; // 最大选中章序号(1 起)
  if (baseIdx.length < maxCh + 1) return { err: '底版章节标签不足 ' + (maxCh + 1) + ' 个' };

  const outLines = out.split('\n');
  const outIdx = [];
  outLines.forEach((l, i) => { if (tagRe.test(l.trim())) outIdx.push(i); });
  if (outIdx.length !== chNums.length) {
    return { err: '输出应恰好包含 ' + chNums.length + ' 个章节标签(' + chapters.join('、') + '),实际 ' + outIdx.length + ' 个' };
  }
  // 输出标签必须与底版对应章标签逐字一致(规范化空白后比较)
  for (let k = 0; k < outIdx.length; k++) {
    const baseTag = normTag(baseLines[baseIdx[chNums[k] - 1]]);
    const outTag = normTag(outLines[outIdx[k]]);
    if (outTag !== baseTag) return { err: '章节标签被改: "' + baseTag + '" → "' + outTag + '"' };
  }

  // 逐章提取输出正文并校验(无元评论 / 不过短 / 词数 ±15% 闸门)
  const metaRe = /^(change\s*log|fact_check|notes?\b|备注|说明|优化记录)/im;
  const newBodies = {};
  for (let k = 0; k < outIdx.length; k++) {
    const chId = 'CH' + String(chNums[k]).padStart(2, '0');
    const end = k + 1 < outIdx.length ? outIdx[k + 1] : outLines.length;
    const body = outLines.slice(outIdx[k] + 1, end).join('\n').trim();
    if (metaRe.test(body)) return { err: '输出混入附加说明(Change Log 等),请只输出章节正文' };
    if (words(body) < 20) return { err: '重写章节正文为空或过短(' + chId + ')' };
    const pos = chNums[k] - 1;
    const baseBody = baseLines.slice(baseIdx[pos] + 1, baseIdx[pos + 1]).join('\n');
    const exp = (expectedWords && expectedWords[chId]) || words(baseBody);
    const ratio = words(body) / Math.max(1, exp);
    if (ratio < 0.85 || ratio > 1.15) {
      return { err: '重写后词数漂移超 ±15%(' + chId + ' ' + Math.round(ratio * 100) + '%)' };
    }
    newBodies[chId] = body;
  }

  // 机械拼接:标签行与未选中章正文逐字保留
  const chunks = [];
  const prefix = baseLines.slice(0, baseIdx[0]).join('\n').replace(/\s+$/, '');
  if (prefix) chunks.push(prefix);
  for (let pos = 0; pos < maxCh; pos++) {
    chunks.push(baseLines[baseIdx[pos]]);
    const chId = 'CH' + String(pos + 1).padStart(2, '0');
    const body = newBodies[chId] !== undefined
      ? newBodies[chId]
      : baseLines.slice(baseIdx[pos] + 1, baseIdx[pos + 1]).join('\n').trim();
    if (body) chunks.push(body);
  }
  const tail = baseLines.slice(baseIdx[maxCh]).join('\n').replace(/^\s+/, '');
  if (tail) chunks.push(tail);
  return { merged: chunks.join('\n\n') };
}

// 写回规则:返回 { version, target, field, label };目标版本已存在且未确认覆盖时返回 { conflict, target }
function resolveWriteBack(run, version, overwrite) {
  const map = {
    v1: { target: 'v2', field: 'script_v2', label: 'V2' },
    v2: { target: 'v2_5', field: 'script_v2_5', label: 'V2.5' },
    v1_5: { target: 'v1_5', field: 'script_v1_5', label: 'V1.5' },
    v2_5: { target: 'v2_5', field: 'script_v2_5', label: 'V2.5' }
  };
  const m = map[version];
  if (!m) return { err: 'version 必须是 v1/v2/v1_5/v2_5 之一' };
  if (m.target !== version && run[m.field] && !overwrite) {
    return { conflict: m.label + ' 已存在,强化将覆盖其当前内容', target: m.target };
  }
  return { version, ...m };
}

// 把强化结果写入任务记录(V1 兜底 / final_script 同步 / 缓存过期 / boost_log),由调用方 store.saveRun
function applyResult(run, wb, baseText, result, chapters) {
  // V1→V2 与旧第五阶段口径一致:先兜住 script_v1,再同步 final_script
  if (wb.target === 'v2') {
    run.script_v1 = run.script_v1 || checks.extractFinalScript(baseText);
    run.final_script = result.content;
  }
  run[wb.field] = result.content;
  // target 文案已变:该版本的商业化/留存扫描与视频简介缓存一律过期;指纹缓存无 stale 机制,V2 被覆盖时直接删除
  if (run.compliance_scans && run.compliance_scans[wb.target]) run.compliance_scans[wb.target].stale = true;
  if (run.opening_scans && run.opening_scans[wb.target]) run.opening_scans[wb.target].stale = true;
  if (run.descriptions && run.descriptions[wb.target]) run.descriptions[wb.target].stale = true;
  if (wb.target === 'v2' && run.fingerprint_scans) delete run.fingerprint_scans.v2;
  // 完整明细日志(最近 50 条封顶)
  run.boost_log = [...(run.boost_log || []), {
    ts: new Date().toISOString(), version: wb.version, target: wb.target, chapters,
    secs: Math.round(result.secs * 10) / 10, chars: result.content.length, stop_reason: result.stopReason,
    ...(result.gateRetry ? { gate_retry: result.gateRetry } : {})
  }].slice(-50);
}

// 执行强化:拼提示词 → LLM(温度 0)→ 结构校验(不合格反馈重试一次)→ 机械拼接
// 返回 { content, secs, stopReason, gateRetry };失败抛错
async function boost(cfg, { asset, topic, baseText, chapters }) {
  const anchor = buildOpeningAnchor(asset);
  const expectedWords = {};
  const anchorParts = [];
  chapters.forEach(ch => {
    const i = CH_IDS.indexOf(ch);
    if (anchor.segTexts[i]) { anchorParts.push(anchor.segTexts[i]); expectedWords[ch] = anchor.segWords[i]; }
  });
  if (anchor.rulesText) anchorParts.push(anchor.rulesText);
  const templates = pipeline.loadTemplates();
  const tools = checks.makeRefTools({ examples: asset.examples, srt: asset.srt, timeline: asset.timeline });
  const ctx = {
    topic,
    script: sliceChapters(baseText, 3), // 只给 CH01-CH03,防止模型锚定全文做最小编辑
    opening_anchor: anchorParts.length ? anchorParts.join('\n\n') : '(无锚点数据)',
    chapters: chapters.join('、'),
    chapter_rules: chapters.map(ch => ch + ' 仿写"锚点段 ' + (CH_IDS.indexOf(ch) + 1) + '"').join(',') + '。'
  };
  const prompt = pipeline.fillTemplate(templates[4], ctx, tools);
  const boostCfg = { ...cfg, temperature: 0 }; // 结构保真优先,关掉随机性
  let messages = [{ role: 'user', content: prompt }];
  let r = await pipeline.llmCall(boostCfg, messages, '开头强化');
  let out = textnorm.normalizeChapterTags(checks.stripFence(r.content.trim()));
  let sp = spliceChapters(baseText, out, chapters, expectedWords);
  let gateRetry = null;
  if (sp.err) {
    gateRetry = { reason: sp.err };
    const feedback = '你的输出不合格:' + sp.err + '。请只输出仿写后的 ' + chapters.join('、') +
      ',每章第一行必须是与底版完全相同的章节标签行,不要输出其他章节,不要任何附加说明。';
    messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: feedback }];
    r = await pipeline.llmCall(boostCfg, messages, '开头强化 结构重试');
    out = textnorm.normalizeChapterTags(checks.stripFence(r.content.trim()));
    sp = spliceChapters(baseText, out, chapters, expectedWords);
    if (sp.err) throw new Error('强化重试后仍不合格: ' + sp.err);
  }
  // 清洗尾部可能残留的 Change Log 标题(底版旧数据带入、或模型附加说明)
  return { content: checks.extractFinalScript(sp.merged), secs: r.secs, stopReason: r.stopReason, gateRetry };
}

module.exports = { CH_IDS, buildOpeningAnchor, sliceChapters, spliceChapters, resolveWriteBack, applyResult, boost };
