// 配音语速:篇幅、词数预算、密度都按成片的真实配音速度算,不按原片字幕语速。
// 实测 run_2713e3885236(韩文,TTS 配音):1,887 词配出 16:51,约 112 词/分钟;
// 原片字幕是 172 词/分钟,按它算预算,12 分钟的目标会写成 17 分钟的稿子。
// 取值顺序:频道声音设定里的 narration_wpm > 同语言已发布视频的实测中位数 > 语言默认值 > 原片语速
const store = require('./store');
const checks = require('./checks');
const voice = require('./voice');

const DEFAULT_WPM = { Korean: 113 };
const WPM_MIN = 60, WPM_MAX = 260; // 超出这个范围的实测值当成数据有误,不用

// 一条已发布视频的实测语速:推出去那版的词数 ÷ 视频时长
function measuredWpmOf(run) {
  const curve = run.yt_analytics && run.yt_analytics.latest && run.yt_analytics.latest.curve;
  const dur = curve && curve.duration_sec;
  if (!dur) return null;
  const ytdata = require('./ytdata'); // ytdata 依赖较多,用到时再载入
  const words = checks.parseChapters(ytdata.publishedText(run).text).reduce((n, c) => n + c.words, 0);
  const wpm = Math.round(words / dur * 60);
  return wpm >= WPM_MIN && wpm <= WPM_MAX ? wpm : null;
}

// 所有已发布视频的实测语速;读全部任务文件较慢,缓存一分钟
let cache = null;
function measuredAll() {
  if (cache && Date.now() - cache.at < 60000) return cache.list;
  let list = [];
  try {
    list = store.listRuns().filter(r => r.yt_analytics).map(r => ({ id: r.id, lang: (r.audience || {}).target_language || '', voice: r.voice_used || null, wpm: measuredWpmOf(r) })).filter(x => x.wpm);
  } catch (e) { list = []; }
  cache = { at: Date.now(), list };
  return list;
}

const median = a => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2); };

// sourceWpm:原片字幕语速(没有就传 null)。返回 { wpm, from, source_wpm, samples? }
function narrationWpm(run, sourceWpm) {
  const lang = (run.audience || {}).target_language || '';
  const v = voice.voiceForRun(run);
  const vw = v && Number(v.narration_wpm);
  if (vw >= WPM_MIN && vw <= WPM_MAX) return { wpm: Math.round(vw), from: 'voice', voice: v.name, source_wpm: sourceWpm || null };
  const all = measuredAll().filter(x => x.id !== run.id && x.lang === lang);
  let samples = all.filter(x => run.voice_used && x.voice === run.voice_used);
  if (!samples.length) samples = all;
  samples = samples.map(x => ({ id: x.id, wpm: x.wpm }));
  if (samples.length) return { wpm: median(samples.map(s => s.wpm)), from: 'measured', samples, source_wpm: sourceWpm || null };
  if (DEFAULT_WPM[lang]) return { wpm: DEFAULT_WPM[lang], from: 'default', source_wpm: sourceWpm || null };
  return { wpm: sourceWpm || null, from: 'source', source_wpm: sourceWpm || null };
}

const FROM_LABEL = { voice: '频道声音设定', measured: '已发布视频实测', default: '语言默认值', source: '原片字幕语速' };
function narrationLabel(n) {
  if (!n || !n.wpm) return '';
  return n.wpm + ' 词/分钟(' + (FROM_LABEL[n.from] || n.from) + (n.samples ? ',' + n.samples.length + ' 条视频' : '') + ')' +
    (n.source_wpm && n.from !== 'source' ? ',原片 ' + n.source_wpm : '');
}

// 按配音语速重算蓝图每章的 word_budget(章节时长 × 语速 / 60)。蓝图不可解析时原样返回
function rescaleBlueprint(text, wpm) {
  if (!wpm) return { text, changed: 0 };
  let bp;
  try { bp = JSON.parse(checks.stripFence(text)); } catch (e) { return { text, changed: 0 }; }
  let changed = 0;
  (bp.chapters || []).forEach(c => {
    const [a, b] = String(c.time_range || '').split(/[-–—]/).map(s => checks.toSec(String(s).trim()));
    if (!(b > a)) return;
    const want = Math.round((b - a) * wpm / 60);
    if (Number(c.word_budget) !== want) { c.word_budget = want; changed++; }
  });
  return changed ? { text: JSON.stringify(bp, null, 2), changed } : { text, changed: 0 };
}

module.exports = { DEFAULT_WPM, narrationWpm, narrationLabel, measuredWpmOf, rescaleBlueprint };
