// 频道声音设定(流程 A4 的第二个产物):每个频道一份,规定语体、称呼、自称、风格和固定用语。
// 存在 app/voices/<名字>.json(下划线开头的是模板,不列出);写稿时注入 step2/step4 和写前分析的 {{voice}}。
// 与资产的 style.json 分工:style.json 是原片的写法(节奏、修辞),声音设定是自己频道的口吻;两者冲突时语体/称呼/自称/固定用语以声音设定为准。
const fs = require('fs');
const path = require('path');
const checks = require('./checks');

const VOICES_DIR = path.join(__dirname, '..', 'voices');
const NONE = '__none__';
const AUTO = '__auto__';

// 文件名只去掉路径分隔符等危险字符,保留中文/韩文频道名
const fileOf = name => path.join(VOICES_DIR, String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() + '.json');

function listVoices() {
  if (!fs.existsSync(VOICES_DIR)) return [];
  return fs.readdirSync(VOICES_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(VOICES_DIR, f), 'utf-8')); } catch (e) { return null; } })
    .filter(v => v && v.name);
}

function getVoice(name) {
  if (!name) return null;
  try { return JSON.parse(fs.readFileSync(fileOf(name), 'utf-8')); } catch (e) { return null; }
}

// 返回错误说明或 null
function voiceShapeError(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return '不是 JSON 对象';
  if (!v.name || !String(v.name).trim()) return '缺少 name';
  if (String(v.name).startsWith('_')) return 'name 不能以下划线开头';
  for (const k of ['register', 'address_audience']) if (!v[k]) return '缺少 ' + k;
  return null;
}

function saveVoice(v) {
  fs.mkdirSync(VOICES_DIR, { recursive: true });
  const out = { ...v, name: String(v.name).trim(), confirmed: true, updated_at: new Date().toISOString() };
  fs.writeFileSync(fileOf(out.name), JSON.stringify(out, null, 2), 'utf-8');
  return out;
}

function deleteVoice(name) {
  const f = fileOf(name);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

// 任务用哪份设定:显式选择 > 按频道名自动匹配 > 不用
function voiceForRun(run) {
  const sel = run.voice_name == null ? AUTO : run.voice_name;
  if (sel === NONE || sel === '') return null;
  if (sel !== AUTO) return getVoice(sel);
  return run.channel_name ? getVoice(run.channel_name) : null;
}

function voiceBrief(v) {
  if (!v) return '(未设定频道声音,按 Style 执行)';
  const list = a => (Array.isArray(a) ? a : (a ? [a] : [])).filter(Boolean);
  const sig = v.signature_lines || {};
  const out = [];
  out.push('频道:' + v.name + (v.language ? '(' + v.language + ')' : '') + (v.persona ? ';叙述者:' + v.persona : ''));
  if (v.register) out.push('语体:' + v.register);
  if (v.address_audience) out.push('称呼观众:' + v.address_audience);
  if (v.self_reference) out.push('自称:' + v.self_reference);
  if (list(v.tone).length) out.push('风格:' + list(v.tone).join(';'));
  if (v.sentence_rhythm) out.push('句子节奏:' + v.sentence_rhythm);
  const sl = ['opening', 'closing', 'cta'].filter(k => sig[k]).map(k => ({ opening: '固定开场', closing: '固定结尾', cta: '互动引导' })[k] + ':' + sig[k]);
  if (sl.length) out.push(sl.join(';'));
  if (list(v.do).length) out.push('必须:' + list(v.do).join(';'));
  if (list(v.dont).length) out.push('禁止:' + list(v.dont).join(';'));
  if (list(v.sample_lines).length) out.push('口吻样句(只学语感,不照抄):\n' + list(v.sample_lines).map(s => '- ' + s).join('\n'));
  return out.join('\n');
}

// AI 起草(不保存,交人工确认后 saveVoice)
async function draftVoice({ name, language, description, samples }) {
  const pipeline = require('./pipeline');
  const cfg = pipeline.loadConfig();
  if (!cfg || !cfg.api_key) throw new Error('未配置 API Key');
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'voice_draft.md'), 'utf-8')
    .replaceAll('{{name}}', name || '(未填)')
    .replaceAll('{{language}}', language || '(未填)')
    .replaceAll('{{description}}', description || '(无)')
    .replaceAll('{{samples}}', samples || '(无样稿:只能按频道说明起草,多数项会是「未指定」)');
  const r = await pipeline.llmCall(cfg, [{ role: 'user', content: tpl }], '频道声音起草');
  const s = checks.stripFence(r.content.trim());
  let v = null;
  try { v = JSON.parse(s); } catch (e) { v = checks.extractJsonObject(s); }
  if (!v || typeof v !== 'object') throw new Error('起草结果不是 JSON');
  if (name) v.name = name;
  v.confirmed = false;
  return v;
}

module.exports = { VOICES_DIR, NONE, AUTO, listVoices, getVoice, saveVoice, deleteVoice, voiceShapeError, voiceForRun, voiceBrief, draftVoice };
