// 框架资产打包导出:把一个资产目录(7 个 JSON/SRT)打成一个 zip,并附一份给外部 AI 看的 README.md
// 依赖为零:zip 用 node 内置 zlib 手写(本地文件头 + 中央目录 + EOCD),不引第三方包
// 口径:原始文件逐字节照搬(不做二次序列化);某个文件缺失或损坏也照原样打进去,并在 README 里如实标注
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const store = require('./store');

// ---------- ZIP 写入 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

// entries: [{ name, data(Buffer|string) }] —— 名称一律用 ASCII,避免解压端编码差异
function zipFiles(entries) {
  const { time, date } = dosDateTime(new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf-8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf-8');
    const crc = crc32(raw);
    const packed = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = packed.length < raw.length;
    const body = useDeflate ? packed : raw;
    const method = useDeflate ? 8 : 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // 解压所需版本 2.0
    lh.writeUInt16LE(0x0800, 6);      // bit 11:名称按 UTF-8 解释(全 ASCII 时无副作用)
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);          // extra 长度
    cd.writeUInt16LE(0, 32);          // 注释长度
    cd.writeUInt16LE(0, 34);          // 起始磁盘号
    cd.writeUInt16LE(0, 36);          // 内部属性
    cd.writeUInt32LE(0x20, 38);       // 外部属性:归档位(普通文件)
    cd.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([cd, nameBuf]));

    offset += lh.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

// ---------- 格式化helper ----------
const CONTENT_TYPE_ZH = {
  business_economics_explainer: '商业经济解说',
  documentary_explainer: '纪录片解说',
  educational_explainer: '教育解说',
  history_engineering_explainer: '历史工程解说',
  immersive_documentary_fiction: '沉浸纪实故事',
  narrative_explainer: '叙事解说',
  science_explainer: '科普解说',
  science_psychology_explainer: '心理科普解说',
  speculative_science_explainer: '推演科普解说',
  video_essay_explainer: '视频散文解说'
};
const DELIVERY_ZH = { immediate_payoff: '即时兑现', partial_payoff: '部分兑现', delayed_payoff: '延迟兑现', promise_reframe: '重构承诺' };
const TYPE_ZH = { hook: '钩子', transition: '过渡', information_reveal: '信息揭示', emotional_payoff: '情绪回报', humor: '幽默', worldview_shift: '世界观升级', ending: '结尾' };
const POS_ZH = { opening: '开场', early: '前段', early_middle: '中前段', middle: '中段', late_middle: '中后段', late: '后段', ending: '结尾' };
const SRC_ZH = { observed: '原片习惯', system_guardrail: '系统规则' };

function dur(ms) {
  if (ms == null || isNaN(ms)) return '-';
  const s = Math.round(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function arr(v) { return Array.isArray(v) ? v.filter(x => x != null && x !== '') : []; }
function bullet(list, mark) {
  const a = arr(list);
  return a.length ? a.map(x => '- ' + (mark || '') + String(x)).join('\n') : '- （无）';
}
function code(v) { return v == null || v === '' ? '—' : '`' + String(v) + '`'; }

// ---------- 字段字典(逐文件逐字段) ----------
// 说明文本与界面同一套口径(「怎么写 / 框架 / 时间轴 / 风格 / 样本 / 留存卡」六页标签);
// 只解释「这个字段是什么、拿它干什么」,不描述具体取值
const DICT = {
  'meta.json': [
    ['name', '框架名 = 一句话套路(括号里是结构说明)', '识别这个包是什么;选框架时先看它'],
    ['description', '长描述:这个框架从什么内容里长出来、大概怎么讲', '判断能不能套你手上的选题'],
    ['content_type', '内容类型枚举(如 documentary_explainer=纪录片解说)', '判断是否符合你的频道形态'],
    ['narrative_mode', '叙事模式标识(机器名)', '同模式可直接复用,跨模式要改造'],
    ['source_title / source_title_zh', '原片标题(英文 / 中文)', '溯源;source.srt 就是这部片'],
    ['source_duration_ms', '原片时长(毫秒)', '所有时长换算的基准'],
    ['wpm', '原片语速(词/分钟)', '估算某一段该写多少词'],
    ['chapters', '原片章节数', '了解原片分段粒度'],
    ['example_count', '抽取的原句样本条数(对应 examples.json)', '判断样本量够不够支撑归纳'],
    ['best_topic_traits', '最适合的选题特征(与 framework.data.transferability 同源)', '选题自查'],
    ['status', '框架状态(candidate = 单案例候选框架)', 'candidate 表示只由 1 个案例归纳,套用前先低成本试写一篇'],
    ['channel', '原片来源频道', '判断语感/受众是否接近'],
    ['has_srt', '是否带原片字幕文件', '决定能不能核对原句'],
    ['created_at', '入库时间', '版本追溯']
  ],
  'framework.json': [
    ['data.name', '框架名(等于 meta.name)', '一眼知道这是什么套路'],
    ['data.description', '长描述', '同上'],
    ['data.content_profile.*', '内容类型 / 题材标签(genres) / 叙事模式 / 建议时长区间(recommended_duration_ms)', '排时长、判断适配'],
    ['data.core_engine.surface_promise_pattern', '表层承诺:标题和开场答应观众什么', '写第一句时必须兑现它'],
    ['data.core_engine.deep_emotional_promise', '深层情绪承诺(数组)', '决定观众为什么愿意看完'],
    ['data.core_engine.audience_transformation.before_state / after_state', '观众看前 → 看后的状态差', '完稿自查:观众有没有被推动'],
    ['data.audience_psychology.target_identity_traits / pain_points / desires / click_triggers', '目标观众的身份特征 / 痛点 / 欲望 / 点击触发点', '定选题角度与措辞'],
    ['data.title_hook_contract.title_formula', '标题公式(把主题词填进去即得标题)', '写标题照抄公式结构,不要自创'],
    ['data.title_hook_contract.opening_delivery_mode', '开场兑现方式:immediate_payoff 即时 / partial_payoff 部分 / delayed_payoff 延迟 / promise_reframe 重构承诺', '决定开场给多少答案'],
    ['data.title_hook_contract.must_deliver', '标题-开场契约必须兑现的清单(全片口径:前 30 秒是主战场,清单里也有结尾要落的账)', '逐条打勾,缺一条就算没做到契约'],
    ['data.title_hook_contract.risk_flags', '该契约的已知风险', '写完对照,避免标题党'],
    ['data.title_hook_contract.thumbnail_contract', '封面契约(有内容才填,空对象表示未归纳)', '做封面时参考'],
    ['data.story_engine.engine_type', '故事引擎类型(驱动全片的动力机制)', '决定用什么推进叙事'],
    ['data.story_engine.core_question_pattern', '核心问题句式(全片围绕它展开)', '开场与结尾都要回扣它'],
    ['data.story_engine.tension_source', '张力来源(数组)', '判断你的选题有没有同样的张力'],
    ['data.story_engine.belief_shift.old_belief / new_belief', '旧认知 → 新认知', '写稿必须完成这个翻转'],
    ['data.structure_pattern[]', '骨架:一个元素 = 一个结构段,按 order 执行', '写稿的主干,逐段写'],
    ['  · stage_id', '段标识', 'timeline / style / examples / 留存卡都用它对齐同一段'],
    ['  · order', '顺序号', '排稿顺序'],
    ['  · function', '这一段承担的功能', '写之前先确认这段要干什么'],
    ['  · purpose', '为什么要这一段', '功能说不清就别写'],
    ['  · entry_condition / exit_condition', '进入 / 退出条件(上一段做到什么才能进下一段)', '自查段与段之间有没有断'],
    ['  · required_payload / optional_payload', '必备 / 可选素材', '动笔前先备齐,缺料这段写不实'],
    ['data.retention_system.mechanisms', '留存机制清单(为什么观众不走)', '每 2-3 段至少命中一条'],
    ['data.retention_system.open_loop_policy', '悬念(开环)策略', '中段必须持续开环'],
    ['data.retention_system.payoff_policy', '回报(闭环)策略', '开了的环要还,别烂尾'],
    ['data.retention_system.information_release_strategy', '信息释放顺序策略', '决定先说什么后说什么'],
    ['data.emotion_curve[]', '每段的情绪与目的(stage_id / emotion / purpose)', '画情绪曲线,查太平的地方'],
    ['data.transferability.best_topic_traits / avoid_topic_traits', '适合 / 不适合的选题特征', '选题阶段就能否掉一半错方向'],
    ['data.transferability.prerequisites', '使用前提(素材/资料/事实门槛)', '没这些前提不要硬套'],
    ['data.transferability.risk_flags', '迁移风险', '换主题后最容易崩的点'],
    ['data.migration_rules.must_preserve', '换主题时必须保留的', '删了框架就失效'],
    ['data.migration_rules.must_replace', '必须替换的原片专属素材', '不换就是洗稿'],
    ['data.migration_rules.forbidden_copy_elements', '禁止复制的元素(标志性表达/桥段)', '硬红线']
  ],
  'timeline.json': [
    ['provenance.*', '溯源:原片标题、字幕 sha256、语言、时长、分析批次、提示词与解析器版本、生成时间', '核对这批数据和 source.srt 是不是同一份;source_srt_sha256 可校验'],
    ['data.duration_profile.observed_duration_ms / duration_type / recommended_duration_ms', '原片实测时长 / 时长来源(实测或估算) / 建议复用区间', '选目标时长'],
    ['data.subtitle_metrics.cue_count / token_or_word_count / average_words_per_minute / measurement_quality', '字幕条数 / 总词数 / 实测语速 / 测量质量', '某段该写多少词,用总词数按占比换算'],
    ['data.hook_window.*', '开场窗口:起止时间、钩子类型、第一刺激时间、第一回报时间、证据 cue', '写前 30 秒的硬指标'],
    ['data.observed_segments[]', '原片实际分段:时间码、占比、功能、观众目标、信息动作、情绪、留存触发、开闭环、对应 cue、置信度', '想精确模仿节奏时读它'],
    ['data.normalized_pattern[]', '归一化骨架:stage_id、start_ratio / end_ratio(0-1)、function、required_retention_events、scaling_rule', '换算新时长时只看这个:占比 × 你的总时长 = 该段的秒数'],
    ['data.retention_events[]', '逐个留存事件:时间点、占比、类型、机制、观众继续看的理由', '查节奏密度够不够'],
    ['data.open_loops[]', '悬念环:开/闭时间、状态、张力功能、回报类型与强度', '检查有没有开了不还的环'],
    ['data.peak_points[]', '情绪高峰:时间点、占比、类型、强度、原因', '把最强的料放在高峰位置'],
    ['data.pacing_rules[]', '节奏规则(附证据条数与置信度)', '写的时候照着排句子长短'],
    ['quality', '数据质量标记', '置信度低的字段别当铁律']
  ],
  'style.json': [
    ['data.voice_persona.*', '讲述者人设:名称、描述、与观众的关系、权威姿态、置信度、证据', '定"谁在讲"'],
    ['data.tone_profile.primary_tones / formality_score / emotional_intensity_score / humor_level_score / certainty_style', '主语气标签 / 正式度 / 情绪强度 / 幽默浓度(0-100)/ 确定性表达风格', '定"什么调子讲"'],
    ['data.measured_sentence_profile.*', '实测句长分布:短/中/长句占比、平均句长、测量质量', '控制句子长度节奏'],
    ['data.rhythm_rules[]', '节奏规则:规则、作用、置信度、证据', '改稿时逐条对照'],
    ['data.narration_rules.person_usage / dialogue_usage / pause_and_emphasis / transition_style', '人称用法 / 对话用法 / 停顿与重音 / 转场方式', '写旁白时的具体手法'],
    ['data.humor_system.*', '幽默类型、频率、放置规则、禁用规则', '要幽默就照它放,不要自由发挥'],
    ['data.language_patterns[]', '可复用句式模板:pattern_id、名称、formula(公式)、purpose、证据', '语法级复用:把主题词填进 formula'],
    ['data.lexicon_profile.preferred_traits / avoid_traits', '用词偏好 / 回避', '选词'],
    ['data.forbidden_style[]', '禁区(rule + source:observed 原片习惯 / system_guardrail 系统规则)', '写完逐条自查'],
    ['data.transfer_guardrails[]', '迁移护栏:换主题时不能越的线', '改稿时的边界'],
    ['provenance / quality', '溯源与质量标记', '判断可信度']
  ],
  'examples.json': [
    ['policy.*', '采样策略:条数上下限、单条词数上限、必须原文摘录、禁止拼接相邻 cue', '理解样本是怎么切出来的'],
    ['examples[]', '原句样本集合,每条见下', '找语感;只学机制,不抄句子'],
    ['  · example_id / type / function / position', '编号 / 类型(钩子、过渡、信息揭示、情绪回报、幽默、世界观升级、结尾)/ 功能 / 所处位置', '按类型找你要的那一句'],
    ['  · source_start_ms / source_end_ms / source_cue_ids', '原片位置与对应字幕 cue', '回 source.srt 核对上下文'],
    ['  · psychological_goal', '心理目的:这句想让观众产生什么反应', '这是"学什么"的核心'],
    ['  · expression_mechanism', '表达机制:它用什么手法达成那个目的', '换素材时要保留的是这个机制'],
    ['  · example_text', '原句(原片字幕原文)', '只作参考,禁止直接搬'],
    ['  · word_count', '该句词数', '估自己写的长度'],
    ['  · usage_instruction', '学什么(可复用的部分)', '动笔前读'],
    ['  · negative_instruction', '禁复制什么(专属名词/桥段/措辞)', '硬红线'],
    ['quality.*', '样本质量:条数、是否全部符合词数上限、重复/相邻标记、警告', '样本质量差就别过度依赖']
  ],
  'retention_cards.json': [
    ['version / generated_at / source', '版本、生成时间、来源', '追溯'],
    ['field_sources.*', '每类字段来自哪一步分析(位置高峰悬念 / 原片做法 / 抽象动作 / 替换条件 / 可删性)', '人工复核时对照'],
    ['cards[]', '逐段施工卡,与 framework.data.structure_pattern 一一对应(同 stage_id)', '真正动笔时按卡写'],
    ['  · function / position_label / start_ratio / end_ratio / start_sec / end_sec', '功能 / 位置文字 / 起止占比 / 起止秒', '排时长'],
    ['  · purpose', '这一段的目的', '写完自查有没有达成'],
    ['  · peaks[]', '这段持有的情绪高峰(id、类型、强度、时间、原因)', '把最强料放在这段'],
    ['  · loops_opened[] / loops_closed[] / loops_open_ended[]', '这段开了/闭合了/故意不闭合的悬念', '保证环环相扣'],
    ['  · retention_events[] / required_retention_events[]', '这段实际发生 / 必须发生的留存事件', '缺了这段就留不住人'],
    ['  · original_moves[]', '原片的具体做法(只作理解)', '看它怎么做的,不要照抄'],
    ['  · abstract_move', '抽象动作:去掉原片素材后,这一段到底该做什么', '写稿就照这句写,这是最该用的一栏'],
    ['  · replacement_needs[]', '换主题时需要备的料', '动笔前的采购清单'],
    ['  · deletability / deletability_reason / merge_keep', '可删性(不可删 / 可并入 / 可删)+ 原因 + 并入时保留什么', '时长不够时按这个删,别乱删'],
    ['  · loss_if_deleted[]', '删掉会失去什么(哪个高峰、强度多少)', '判断能不能承担'],
    ['  · hook{}', '若这段是开场,附钩子窗口与第一刺激/第一回报', '开场专用'],
    ['  · ai_refined', '是否经 AI 二次精修', '影响字段可信度']
  ],
  'source.srt': [
    ['(整份文件)', '原片英文字幕:cue 编号 / 时间码 / 文本', '上面所有 source_cue_ids 都指向这里的编号,是量化数据的唯一证据源']
  ]
};

function dictBlock(file, rows) {
  const head = '| 字段 | 是什么 | 拿它干什么 |\n| --- | --- | --- |';
  const body = rows.map(r => '| ' + r.map(c => String(c).replace(/\|/g, '\\|')).join(' | ') + ' |').join('\n');
  return '### ' + file + '\n\n' + head + '\n' + body + '\n';
}

// ---------- README ----------
function buildReadme(ctx) {
  const { id, meta, fw, tl, st, ex, rc, hasSrt, hasSrtZh, track, broken, generatedAt } = ctx;
  const d = (fw && fw.data) || {};
  const t = (tl && tl.data) || {};
  const s = (st && st.data) || {};
  const cards = ((rc || {}).cards) || [];
  const sp = arr(d.structure_pattern);
  const np = arr(t.normalized_pattern);
  const npOf = {};
  np.forEach(p => { if (p && p.stage_id) npOf[p.stage_id] = p; });
  const cardOf = {};
  cards.forEach(c => { if (c && c.stage_id) cardOf[c.stage_id] = c; });

  const observed = (t.duration_profile || {}).observed_duration_ms || meta.source_duration_ms || 0;
  const totalWords = (t.subtitle_metrics || {}).token_or_word_count || 0;
  const hw = t.hook_window || {};
  const peaks = arr(t.peak_points);
  const pk0 = peaks[0];
  const thc = d.title_hook_contract || {};
  const tr = d.transferability || {};
  const mr = d.migration_rules || {};
  const ce = d.core_engine || {};
  const se = d.story_engine || {};
  const tp = s.tone_profile || {};
  const lp = arr(s.language_patterns);
  const forbidden = arr(s.forbidden_style);

  const L = [];
  const push = (...x) => L.push(...x);

  push('# 框架包:' + (meta.name || id), '');
  push('> 这是从「爆款文案生成平台」导出的**单个框架资产包**,打包时间 ' + generatedAt + '。');
  push('> 如果你是 AI:先读第 0 节拿到全貌,再读第 3 节(可直接照做的写作指令),遇到字段不认识就查第 2 节字段字典。', '');
  push('---', '');

  // 0
  push('## 0. 30 秒速读', '');
  push('| 项 | 值 |', '| --- | --- |');
  push('| 框架 ID | `' + id + '` |');
  push('| 框架名(一句话套路) | ' + (d.name || meta.name || '—') + ' |');
  push('| 源片 | ' + [meta.source_title_zh, meta.source_title].filter(Boolean).join(' / ') + ' |');
  push('| 来源频道 | ' + (meta.channel || '—') + ' |');
  push('| 内容类型 | ' + (CONTENT_TYPE_ZH[meta.content_type] || meta.content_type || '—') + ' |');
  push('| 分类(赛道) | ' + (track && track.name ? track.name : '未分类') + ' |');
  push('| 原片时长 / 语速 | ' + dur(observed) + ' / ' + (meta.wpm || (t.subtitle_metrics || {}).average_words_per_minute || '—') + ' wpm |');
  push('| 原片章节 / 样本条数 | ' + (meta.chapters || '—') + ' 章 / ' + (meta.example_count || arr((ex || {}).examples).length || '—') + ' 条 |');
  push('| 骨架步数 | ' + sp.length + ' 步 |');
  push('| 标题公式 | ' + code(thc.title_formula) + ' |');
  push('| 开场兑现方式 | ' + (DELIVERY_ZH[thc.opening_delivery_mode] || thc.opening_delivery_mode || '—') + ' |');
  push('| 适合写 | ' + (arr(tr.best_topic_traits).join(';') || '—') + ' |');
  push('| 别碰 | ' + (arr(tr.avoid_topic_traits).join(';') || '—') + ' |');
  push('');
  push(d.description || meta.description || '', '');

  // 0.1 骨架总表
  push('### 骨架总表(' + sp.length + ' 步,写稿按这个顺序)', '');
  push('| # | stage_id | 功能 | 位置占比 | 折算时长 | 折算词数 | 可删性 |', '| --- | --- | --- | --- | --- | --- | --- |');
  sp.forEach((x, i) => {
    const c = cardOf[x.stage_id] || {};
    const p = npOf[x.stage_id] || {};
    const span = (p.start_ratio != null && p.end_ratio != null) ? (p.end_ratio - p.start_ratio) : null;
    const pos = (p.start_ratio != null && p.end_ratio != null)
      ? (p.start_ratio * 100).toFixed(1) + '%–' + (p.end_ratio * 100).toFixed(1) + '%'
      : (c.position_label || '—');
    const sec = (span != null && observed) ? Math.round(span * observed / 1000) + ' 秒' : '—';
    const words = (span != null && totalWords) ? Math.max(10, Math.round(span * totalWords / 10) * 10) + ' 词' : '—';
    push('| ' + (i + 1) + ' | `' + (x.stage_id || '') + '` | ' + (x.function || '') + ' | ' + pos + ' | ' + sec + ' | ' + words + ' | ' + (c.deletability || '—') + ' |');
  });
  push('');

  // 1 文件清单
  push('## 1. 包内文件清单', '');
  push('| 文件 | 是什么 | 什么时候必须读 |', '| --- | --- | --- |');
  push('| `README.md` | 本说明 | 先读 |');
  push('| `framework.json` | 骨架:标题契约 / 核心引擎 / 受众心理 / 结构段 / 留存系统 / 迁移规则 | 决定"讲什么、按什么顺序讲" |');
  push('| `retention_cards.json` | 逐段施工卡:每段写什么、要备什么料、能不能删 | 真正逐段动笔时 |');
  push('| `timeline.json` | 原片节奏量化:分段、留存事件、悬念环、情绪高峰、归一化比例 | 排时长、排节奏 |');
  push('| `style.json` | 文风:讲述者人设、语气分值、句长、句式模板、禁区 | 定语气、写句子 |');
  push('| `examples.json` | 原句样本 + 每条"学什么 / 禁复制什么" | 找语感(禁止照抄) |');
  push('| `meta.json` | 索引信息(名称/类型/源片/时长/语速/样本数) | 识别与检索 |');
  push('| `source.srt` | 原片英文字幕 | 溯源、核对原句(版权见第 4 节) |');
  if (hasSrtZh) push('| `source_zh.srt` | 原片字幕中译 | 只看中文时用它 |');
  if (Object.keys(broken).length) {
    push('');
    push('> ⚠ 本包有文件缺失或解析失败,已按原样打入,内容可能不完整:' + Object.keys(broken).map(k => '`' + k + '`(' + broken[k] + ')').join('、') + '。');
  }
  push('');

  // 2 字段字典
  push('## 2. 字段字典', '');
  push('规则:`data.xxx` 表示 JSON 顶层的 data 对象下的字段;`xxx[]` 表示数组,里面的字段用 `·` 缩进两格列出。空值一律为 `null` 或空数组,表示这一项没归纳出来。', '');
  push(dictBlock('meta.json', DICT['meta.json']));
  push(dictBlock('framework.json', DICT['framework.json']));
  push(dictBlock('timeline.json', DICT['timeline.json']));
  push(dictBlock('style.json', DICT['style.json']));
  push(dictBlock('examples.json', DICT['examples.json']));
  push(dictBlock('retention_cards.json', DICT['retention_cards.json']));
  push(dictBlock('source.srt', DICT['source.srt']));

  // 3 写作指令
  push('## 3. 怎么用这个框架写稿(可直接复制给 AI)', '');
  push('把下面代码块里的整段文字复制给任意 AI,并把「主题」换成你的选题即可。这段是由本包的 framework + timeline + retention_cards 现场编译的,不依赖本平台其它任何东西。', '');
  push('```text');
  push('你是短视频/纪录片解说写手。下面是一条从已验证爆款里拆出来的结构,请用它写一篇新稿。', '');
  push('【主题】<在这里填你的选题>');
  push('【目标时长】' + (observed ? dur(observed) + '(可按比例缩放)' : '<填目标时长>'));
  push('【语速基准】原片 ' + (meta.wpm || (t.subtitle_metrics || {}).average_words_per_minute || '—') + ' 词/分钟;下表已按原片比例折算成词数,若写中文请按你自己的语速折算成字数。', '');
  push('【这条结构是什么】');
  push('- 一句话套路:' + (d.name || meta.name || '—'));
  push('- 表层承诺:' + (ce.surface_promise_pattern || '—'));
  push('- 观众转变:' + ((ce.audience_transformation || {}).before_state || '—') + ' → ' + ((ce.audience_transformation || {}).after_state || '—'));
  push('- 核心问题:' + (se.core_question_pattern || '—'));
  push('- 认知翻转:' + ((se.belief_shift || {}).old_belief || '—') + ' → ' + ((se.belief_shift || {}).new_belief || '—'), '');
  push('【硬性契约(不满足就算失败)】');
  push('1. 标题必须套这个公式:' + (thc.title_formula || '—'));
  push('2. 开场兑现方式:' + (DELIVERY_ZH[thc.opening_delivery_mode] || thc.opening_delivery_mode || '—'));
  if (arr(thc.must_deliver).length) {
    push('3. 下面 ' + arr(thc.must_deliver).length + ' 条必须在成片里全部兑现(前 30 秒是主战场,逐条打勾):');
    arr(thc.must_deliver).forEach((x, i) => push('   ' + (i + 1) + ') ' + x));
  }
  const anchors = [
    hw.first_stimulus_ms != null ? '第一刺激 ' + dur(hw.first_stimulus_ms) : null,
    hw.first_payoff_ms != null ? '第一回报 ' + dur(hw.first_payoff_ms) : null,
    pk0 ? '第一高峰 ' + dur(pk0.time_ms) + '(强度 ' + (pk0.strength != null ? pk0.strength : '?') + ')' : null
  ].filter(Boolean);
  if (anchors.length) push('4. 节奏锚点:' + anchors.join(' / '));
  push('');

  push('【分步施工表】共 ' + sp.length + ' 步,按顺序写,不许跳步、不许合并');
  sp.forEach((x, i) => {
    const c = cardOf[x.stage_id] || {};
    const p = npOf[x.stage_id] || {};
    const span = (p.start_ratio != null && p.end_ratio != null) ? (p.end_ratio - p.start_ratio) : null;
    const posLabel = (p.start_ratio != null && p.end_ratio != null)
      ? (p.start_ratio * 100).toFixed(1) + '%–' + (p.end_ratio * 100).toFixed(1) + '%'
        + (observed ? '(' + dur(p.start_ratio * observed) + '–' + dur(p.end_ratio * observed) + ')' : '')
      : (c.position_label || '');
    const words = (span != null && totalWords) ? Math.max(10, Math.round(span * totalWords / 10) * 10) : null;
    push('');
    push('第 ' + (i + 1) + ' 步 · ' + (x.stage_id || '') + '(' + (x.function || '') + ')');
    if (posLabel || words) push('  位置 ' + (posLabel || '—') + (words ? ',约 ' + words + ' 词' : ''));
    push('  这一段要写:' + (c.abstract_move || x.purpose || '—'));
    if (arr(c.replacement_needs).length) push('  需要备的料:' + arr(c.replacement_needs).join(';'));
    else if (arr(x.required_payload).length) push('  需要备的料:' + arr(x.required_payload).join(';'));
    if (x.purpose && c.abstract_move) push('  目的:' + x.purpose);
    push('  ' + (c.deletability ? '可删性:' + c.deletability + (c.deletability_reason ? '(' + c.deletability_reason + ')' : '') : ''));
  });
  push('');

  if (forbidden.length || arr(mr.forbidden_copy_elements).length) {
    push('【禁区(写完逐条自查)】');
    forbidden.forEach(f => push('- ' + (f.rule || '') + '(' + (SRC_ZH[f.source] || f.source || '') + ')'));
    if (arr(mr.forbidden_copy_elements).length) push('- 禁止复制原片元素:' + arr(mr.forbidden_copy_elements).join(';'));
    push('');
  }
  push('【语气】');
  push('- 主语气:' + (arr(tp.primary_tones).join('、') || '—'));
  push('- 正式度 ' + (tp.formality_score != null ? tp.formality_score : '?') + '/100,情绪强度 ' + (tp.emotional_intensity_score != null ? tp.emotional_intensity_score : '?') + '/100,幽默浓度 ' + (tp.humor_level_score != null ? tp.humor_level_score : '?') + '/100');
  if (lp.length) {
    push('- 可直接套的句式模板:');
    lp.slice(0, 8).forEach(p => push('  · ' + (p.pattern_name || p.pattern_id || '') + ':' + (p.formula || '')));
  }
  push('');
  push('【输出要求】');
  push('1) 严格按 ' + sp.length + ' 步输出,每步以 "## 第N步 stage_id" 开头;');
  push('2) 不照抄原片原句,不使用上面禁区的元素;');
  push('3) 每步末尾标注该步字数,方便核对比例;');
  push('4) 只输出标题与正文,不要解释你的思路。');
  push('```', '');

  // 4 来源与限制
  push('## 4. 数据来源与使用限制', '');
  push('- 数据来自原片字幕的逐句分析(见 `timeline.json` 的 `provenance`),所有 `source_cue_ids` 都能在 `source.srt` 里查到对应句子。');
  push('- `source.srt` 与 `examples.json` 中的原句属于第三方内容,随包提供**仅用于研究与结构分析**,不得直接转载、朗读或作为成品二次发布;实际写稿请替换为自己的素材。');
  push('- `framework.json` 的 `status` 为 `candidate` 时表示该框架由单案例归纳,套用前建议先写一篇小成本试稿。');
  push('');
  return L.join('\n');
}

// ---------- 组装 ----------
function safeRead(dir, file) {
  try { return fs.readFileSync(path.join(dir, file), 'utf-8'); } catch (e) { return null; }
}
function tryParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

// 返回 { buffer, filename, asciiFilename, bytes } ;资产不存在返回 null
function build(id) {
  if (!/^[\w-]+$/.test(String(id || ''))) return null;
  const a = store.getAsset(id);
  if (!a) return null;
  const dir = path.join(store.ASSETS_ROOT, id);

  const broken = {};
  const rawMeta = safeRead(dir, 'meta.json');
  const rawSrtZh = safeRead(dir, 'source_zh.srt');
  const files = {
    'meta.json': rawMeta,
    'framework.json': a.framework,
    'timeline.json': a.timeline,
    'style.json': a.style,
    'examples.json': a.examples,
    'retention_cards.json': a.retention_cards,
    'source.srt': a.srt
  };
  const parsed = {};
  for (const [name, text] of Object.entries(files)) {
    if (name === 'source.srt') continue;
    if (text == null) { broken[name] = '文件缺失'; continue; }
    const j = tryParse(text);
    if (!j) { broken[name] = 'JSON 解析失败'; continue; }
    parsed[name] = j;
  }
  if (files['source.srt'] == null) broken['source.srt'] = '文件缺失';

  const meta = parsed['meta.json'] || a.meta || {};
  let track = { key: '', name: '' };
  try { track = store.assetTrack(id); } catch (e) { /* 分类文件损坏时按未分类处理 */ }

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const generatedAt = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());

  const readme = buildReadme({
    id, meta,
    fw: parsed['framework.json'], tl: parsed['timeline.json'], st: parsed['style.json'],
    ex: parsed['examples.json'], rc: parsed['retention_cards.json'],
    hasSrt: files['source.srt'] != null, hasSrtZh: rawSrtZh != null,
    track, broken, generatedAt
  });

  const entries = [{ name: id + '/README.md', data: readme }];
  // 原始文件逐字节照搬;缺失的用空占位,避免包内文件清单与实际不符
  for (const name of ['meta.json', 'framework.json', 'timeline.json', 'style.json', 'examples.json', 'retention_cards.json', 'source.srt']) {
    const text = files[name];
    entries.push({ name: id + '/' + name, data: text == null ? '' : text });
  }
  if (rawSrtZh != null) entries.push({ name: id + '/source_zh.srt', data: rawSrtZh });

  const buffer = zipFiles(entries);
  return {
    buffer,
    filename: '框架-' + id + '.zip',
    asciiFilename: 'frame-' + id + '.zip',
    bytes: buffer.length
  };
}

module.exports = { build, buildReadme, zipFiles, crc32 };
