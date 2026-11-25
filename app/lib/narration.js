// 配音语速:篇幅、词数预算、密度都按成片的真实配音速度算,不按原片字幕语速。
// 实测 run_2713e3885236(韩文,TTS 配音):1,887 词配出 16:51,约 112 词/分钟;
// 原片字幕是 172 词/分钟,按它算预算,12 分钟的目标会写成 17 分钟的稿子。
// 取值顺序:频道声音设定里的 narration_wpm > 同语言已发布视频的实测中位数 > 语言默认值 > 原片语速
const store = require('./store');
const checks = require('./checks');
const voice = require('./voice');

// v1.126 韩文默认改成 106:yt-studio 导出(2026-11-20)15 条已发布韩文经济视频,推出去那版词数 ÷ 成片时长 = 96–118 词/分钟,中位 106。
// 按 113 算,稿子正好写满预算成片也会长 5%–15%(호떡집 3,029 词 / 31.6 分钟 = 96)。导入了 YouTube 数据的任务会自动改用实测中位数
const DEFAULT_WPM = { Korean: 106 };
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

// v1.134 每个赛道配音的人不一样(用户 2026-11-25):设置页里每个赛道粘一篇文案、填实际配出来的时长,算出这个赛道的语速,存在 config.track_wpm
const TRACK_LABEL = { econ: '经济', history: '历史', science: '科普', pov: 'POV', general: '通用' };
function countWords(text) {
  return String(text || '').split('\n').filter(l => !/^\s*\[CH\d+[^\]]*\]\s*$/i.test(l)).join(' ').split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
}
function parseDuration(v) {
  if (typeof v === 'number') return v > 0 ? Math.round(v) : 0;
  const s = String(v || '').trim().replace(/[分′']/g, ':').replace(/[秒″"]/g, '').replace(/\s+/g, '');
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 60); // 只写一个数:当成分钟
  const m = s.match(/^(?:(\d+):)?(\d+):(\d{1,2})$/);
  return m ? (Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) : 0;
}
function trackCalib(track) {
  const cfg = require('./pipeline').loadConfig() || {};
  const c = (cfg.track_wpm || {})[track];
  return c && c.wpm >= WPM_MIN && c.wpm <= WPM_MAX ? c : null;
}
function trackOfRun(run) {
  const k = run && run.review_track;
  return k && TRACK_LABEL[k] ? k : '';
}
function calibrateTrack(track, text, duration) {
  if (!TRACK_LABEL[track]) throw Object.assign(new Error('不认识的赛道:' + track), { status: 400 });
  const words = countWords(text), secs = parseDuration(duration);
  if (words < 100) throw Object.assign(new Error('文案太短(' + words + ' 词),至少粘一篇完整的、拿去配音的那版'), { status: 400 });
  if (!secs) throw Object.assign(new Error('时长看不懂,写成 9:52 或 9分52秒'), { status: 400 });
  const wpm = Math.round(words / secs * 60);
  if (wpm < WPM_MIN || wpm > WPM_MAX) throw Object.assign(new Error('算出来每分钟 ' + wpm + ' 词,不太对,检查一下文案和时长是不是同一篇'), { status: 400 });
  const pl = require('./pipeline');
  const cfg = pl.loadConfig() || {};
  cfg.track_wpm = { ...(cfg.track_wpm || {}), [track]: { wpm, words, secs, at: new Date().toISOString(), sample: String(text).trim().slice(0, 60) } };
  pl.saveConfig(cfg);
  return { track, wpm, words, secs };
}
function clearTrack(track) {
  const pl = require('./pipeline');
  const cfg = pl.loadConfig() || {};
  if (cfg.track_wpm) { delete cfg.track_wpm[track]; pl.saveConfig(cfg); }
  return { ok: true };
}
function trackWpmView() {
  return Object.keys(TRACK_LABEL).map(k => ({ key: k, name: TRACK_LABEL[k], calib: trackCalib(k) }));
}

// sourceWpm:原片字幕语速(没有就传 null)。返回 { wpm, from, source_wpm, samples? }
// 取值顺序:这个赛道实测过的配音语速 > 频道声音设定 > 已发布视频实测 > 语言默认 > 原片
function narrationWpm(run, sourceWpm) {
  const lang = (run.audience || {}).target_language || '';
  const tk = trackOfRun(run);
  const tc = tk ? trackCalib(tk) : null;
  if (tc) return { wpm: tc.wpm, from: 'track', track: tk, source_wpm: sourceWpm || null };
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

const FROM_LABEL = { track: '这个赛道配音实测', voice: '频道声音设定', measured: '已发布视频实测', default: '语言默认值', source: '原片字幕语速' };
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
    const [a, b] = require('./textnorm').normalizeTimeRange(String(c.time_range || '')).split(/[-–—~〜～∼至到]/).map(s => checks.toSec(String(s).trim()));
    if (!(b > a)) return;
    const want = Math.round((b - a) * wpm / 60);
    if (Number(c.word_budget) !== want) { c.word_budget = want; changed++; }
  });
  return changed ? { text: JSON.stringify(bp, null, 2), changed } : { text, changed: 0 };
}

module.exports = { TRACK_LABEL, countWords, parseDuration, trackCalib, calibrateTrack, clearTrack, trackWpmView, DEFAULT_WPM, narrationWpm, narrationLabel, measuredWpmOf, rescaleBlueprint };
