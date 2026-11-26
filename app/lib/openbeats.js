// v1.110 开头节拍表 + 锁定开头(先只开经济拆账赛道)
//
// 证据(用户 2026-11-10):부침개(run_ee2e6bd16c05)、만두(run_179401ad1d73)两篇前 30 秒留存都低于 60%。
// 两篇的初稿开头其实已经照着原片写了(「당신은 부침개 노점을 차리고 싶습니다… 절반 가까이가 18개월 안에 문을 닫습니다」),
// 是后面的终审(删冷开场、8 秒内出标题关键词、前 10 秒数字密度)、事实核验、开头/合规扫描(补本质句、报流程句)一步步改平的。
//
// 做法:
// 1. 写前分析把原片前 45 秒逐拍拆成「开头节拍表」(每拍:原句、作用、新题目示范句、关键词),再列原片的「声音指纹」;
// 2. 蓝图第一章(CH01)就是这张节拍表,写稿照着一拍一拍写;程序逐拍核对(拍在不在、顺序、有没有说破答案、议程句、你);
// 3. CH01 = 锁定开头:后面所有改稿只能原位替换,改完程序逐拍核对,少拍、乱序、说破答案、去掉「你」就退回改之前的开头;
// 4. 「8 秒 3 关键词」「前 10 秒 1 个数字」「删冷开场」「早点说本质」在锁定开头里只提示,不自动改、不挡发布;
// 5. 价值承诺改成「带钩子的承诺」:承诺有个意外的答案,但不说答案;正文里要找到揭晓它的段落(承诺要兑现)。
const checks = require('./checks');

const LOCK_SEC = 45; // 节拍表覆盖原片前 45 秒(用户定的)
const OPEN_CH = 'CH01';
const arr = v => (Array.isArray(v) ? v : []);
const str = v => (v == null ? '' : String(v));

// ---------- 开不开 ----------
function trackOf(run) { try { return require('./craft').trackOf(run); } catch (e) { return ''; } }
// v1.117 开头规则每个任务自己选(新建任务页「开头规则」):
//   source  = 照原片开头:节拍表 + 声音指纹 + 带钩子的承诺 + 锁定开头 + 通用规则让位 + 开头对比(v1.110 那一套,所有赛道都能用)
//   formula = 通用开头公式:8 秒点题、前 10 秒最多 1 个数字、删冷开场、45 秒前给第一个答案,终审后自动改开头(以前非经济拆账赛道的规则)
// 老任务(没选过):拆过节拍表的按照原片开头;没拆过的,经济拆账算照原片开头,其它赛道算通用开头公式
const TRACKS = ['econ', 'history', 'science', 'pov', 'general'];
const TRACK_NAMES = { econ: '经济拆账', history: '历史与古人', science: '心理与动物科普', pov: 'POV 与等级沉浸', general: '通用' };
const RULES = { source: '照原片开头', formula: '通用开头公式' };
function ruleOf(run) {
  if (!run) return 'formula';
  if (run.opening_rule === 'source' || run.opening_rule === 'formula') return run.opening_rule;
  if (arr(((run.analysis || {}).opening_beats)).length) return 'source';
  return trackOf(run) === 'econ' ? 'source' : 'formula';
}
// 写前分析要不要拆节拍表 / 这篇的锁定开头生不生效:看这篇选的开头规则
function wanted(run) { return !!run && ruleOf(run) === 'source'; }
// 任务页显示:这篇用的哪种开头规则;选了照原片开头、但写前分析是之前跑的(没有节拍表)实际按通用公式
function ruleView(run) {
  const rule = ruleOf(run);
  const noBeats = rule === 'source' && !!run.analysis && beatsOf(run).length < 2;
  return { rule, label: RULES[rule], chosen: run.opening_rule === 'source' || run.opening_rule === 'formula', no_beats: noBeats };
}
function trackName(run) { return TRACK_NAMES[trackOf(run)] || '通用'; }
// 这篇有没有节拍表(只对装了以后跑写前分析的新任务生效;老任务没有这张表,什么都不变)
function beatsOf(run) { return arr(((run || {}).analysis || {}).opening_beats).filter(b => b && (str(b.new_line).trim() || str(b.src_line).trim())); }
function on(run) { return wanted(run) && beatsOf(run).length >= 2; }

// ---------- 原片前 45 秒 ----------
function srtCues(srtText) {
  const cues = [];
  for (const b of str(srtText).replace(/^﻿/, '').split(/\r?\n\s*\r?\n/)) {
    const ls = b.trim().split(/\r?\n/);
    const tm = ls[1] && ls[1].match(/^(\d+):(\d+):(\d+)[,.](\d+)/);
    if (tm) cues.push({ sec: (+tm[1] * 60 + +tm[2]) * 60 + +tm[3] + +tm[4] / 1000, text: ls.slice(2).join(' ').trim() });
  }
  return cues;
}
const mmss = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
function sourceOpening(asset, secs) {
  const cues = srtCues(asset && asset.srt).filter(c => c.sec < (secs || LOCK_SEC));
  return cues.map(c => mmss(c.sec) + ' ' + c.text).join('\n');
}

// ---------- 写前分析:多拆一张节拍表 ----------
// v1.116 各赛道的节拍作用、本质词、承诺示范(经济拆账照 v1.110 原样)
const TRACK_NOTE = {
  econ: {
    roles: '让观众当店主 / 美好想象 / 一句反转 / 内行大数字 / 同样生意也会亏 / 价值承诺 / 过渡到算账',
    spoil: '수익구조、객단가、업셀 这类机制名',
    tie: '和观众自己挂钩:你如果开一家会站在哪边,你上次结账为什么多花钱',
    place: '放在「内行大数字 / 同样生意也会亏」那一拍之后、开始算账之前',
    demo: '   示范(부침개):「같은 철판, 같은 3,000원인데 한 사람은 1년에 6천만 원을 가져가고, 한 사람은 1년을 못 버팁니다. 그 차이는 맛이 아닙니다. 장부에 안 적히는 숫자 하나입니다. 끝까지 보면, 당신이 차리면 어느 쪽일지 계산이 나옵니다.」\n' +
      '   示范(만두):「8,000원짜리 만두 먹으러 들어갔는데 계산서는 1만 8,000원. 우연이 아닙니다. 메뉴판 안에 당신 지갑을 여는 장치가 있습니다. 그게 뭔지, 한 줄씩 따라가 보겠습니다.」\n',
    shape: '「장부에 안 적히는 숫자 하나」「메뉴판 안의 장치」',
    no: '「맛이 아닙니다」'
  },
  history: {
    roles: '一个人物的处境 / 一个反常的事实 / 时代背景一句话 / 悬念提问 / 一句反转 / 价值承诺 / 过渡到正文',
    spoil: '真正原因或结局的名字,例如某个制度名、某场事件名、某个人物的真实下场',
    tie: '和观众挂钩:原片对观众说 you 的(「如果你生在那个年代…」),新稿也这样说;原片是旁白讲故事的,就挂到观众熟悉的东西上(今天也有的制度、习惯、地名),不要硬加「你」',
    place: '放在交代完人物处境 / 反常事实之后、开始讲来龙去脉之前',
    demo: '',
    shape: '「教科书里没写的一道命令」「那一年多出来的一笔税」',
    no: '「不是因为战争」'
  },
  science: {
    roles: '一个反常现象 / 一个具体的动物或人 / 常识被推翻 / 一句反转 / 惊人的数字 / 价值承诺 / 过渡到解释',
    spoil: '机制名或学术名词,例如某种激素、某个效应名、某种进化解释',
    tie: '和观众挂钩:原片对观众说 you 的(「你也有过这种感觉…」),新稿也这样说;原片是旁白讲现象的,就挂到观众日常里见得到的场景上,不要硬加「你」',
    place: '放在反常现象 / 常识被推翻之后、开始解释原因之前',
    demo: '',
    shape: '「大脑里一个很小的开关」「它身上一个你没注意过的部位」',
    no: '「不是因为它聪明」'
  },
  pov: {
    roles: '让观众代入身份 / 交代规则 / 第一个等级或场景 / 代价或危险 / 一句反转 / 价值承诺 / 过渡到第一级',
    spoil: '最后一级、结局或隐藏规则的名字',
    tie: '和观众挂钩:这类片子通常全程对观众说 you,原片说 you 的拍新稿都用「당신」',
    place: '放在交代完身份和规则之后、进入第一级之前',
    demo: '',
    shape: '「最后一级只有一个人活下来的理由」「规则里没写的一条」',
    no: '「不是靠运气」'
  },
  general: {
    roles: '一个场景或人物 / 冲突 / 一句反转 / 惊人的事实 / 价值承诺 / 过渡到正文',
    spoil: '答案本身的关键名词(机制名、原因名、结局名)',
    tie: '和观众挂钩:原片对观众说 you 的,新稿也这样说;原片是旁白讲述的,挂到观众熟悉的东西上,不要硬加「你」',
    place: '放在原片里承诺 / 预告的那一拍(通常在冲突或反转之后、正文开始之前)',
    demo: '',
    shape: '「一个大家都忽略的数字」「一条没人说过的规则」',
    no: '「不是大家以为的那样」'
  }
};
function trackNote(run) { return TRACK_NOTE[trackOf(run)] || TRACK_NOTE.general; }

// ---------- v1.132 前 30 秒四步(照原片开头、通用开头公式都按它) ----------
// 0–5 秒兑现标题 → 5–15 秒和观众扯上关系 → 15–25 秒留一个没答案的问题 → 25–30 秒直接进第一个数字/第一幕
const FOUR_STEP = {
  econ: { payoff: '标题里那个反常识的结果或数字,第一句就说出来(例:「같은 3,000원 붕어빵인데, 한 집은 한 달에 600만 원을 남기고 한 집은 문을 닫습니다」)', tie: '你也想开一家 / 你也是这家店的客人 / 你也算过这笔账(1–2 句)', question: '钱到底漏在哪 / 差在哪一笔(不说答案)', first: '开始算账的第一笔:原价、租金、一天卖多少(一个数)' },
  pov: { payoff: '身份落差的终点或代价(从哪里到哪里、要付出什么)', tie: '「당신」的具体处境:你几岁、在哪、手里有什么(1–2 句)', question: '哪一个选择会改变你的命运', first: '进入第一级处境(第一级的规则或第一个场景)' },
  history: { payoff: '标题里那个反常识的事实,第一句就说出来', tie: '和今天有关:今天还在用的制度、习惯、东西、地名(1–2 句)', question: '为什么没人说清 / 后来到底发生了什么', first: '时间、地点、人物,进第一幕' },
  science: { payoff: '答案里反常识的那一半(另一半留到后面)', tie: '你身上也有 / 你也见过这个现象(1–2 句)', question: '这个证据是怎么找到的 / 为什么会这样', first: '第一个证据:一个实验、一个案例或一个数' },
  general: { payoff: '标题说的那件事或结果,第一句就说出来', tie: '和观众自己有关(1–2 句)', question: '一个还没答案、观众想知道的问题', first: '第一个具体的事实、案例或数字' },
  // v1.135 代入为主(POV、故事式历史):四步就是开场合同,「你是谁 + 你和题目的关系」必须在细节之前
  immersive: null // 代入为主:四步就是开场合同,从 qchain 的定义生成(见 immersiveStep)
};
function immersiveRun(run) { try { return require('./qchain').immersive(run); } catch (e) { return false; } }
function immersiveStep() {
  const Q = require('./qchain'), C = Q.CONTRACT, D = Q.CONTRACT_DESC;
  return { payoff: C.hook + ' ' + D.hook, tie: C.who + '(' + D.who + ')+ ' + C.link + '(' + D.link + ')', question: C.want + ',面前只留一个没答案的问题(加上全片的大问题,开头一共不超过两个)', first: '进入第一级 / 第一幕的场景(不另起报站、不再开新问题)' };
}
function fourStep(run) { return (immersiveRun(run) && immersiveStep()) || FOUR_STEP[trackOf(run)] || FOUR_STEP.general; }
const AVOID_TEXT = '开头避坑:不打招呼(안녕하세요、여러분 반갑습니다)、不自我介绍(저는 ~입니다、채널 소개)、不用「오늘은 ~ 알아보겠습니다」这种报流程的句子;场景描写最多一句,不要慢热铺垫;开头说的和标题对得上(标题里的数字、说法第一两句就出现);30 秒内不说破最终答案;不堆数字(前 10 秒最多 1 个,兑现标题那句的数字就算这一个)。';
const TITLE_KIND_TEXT = '标题类型(title_kind):标题说了一个具体的结果、数字或说法(例如「붕어빵 하나 팔면 남는 돈」「월 600만 원 버는 김밥집」「4시 반에 문 닫는 중국집」),写「具体说法」;标题只是一个话题(例如「빵집 창업의 경제학」「조선의 노비」),写「话题」。';
function fourStepText(run) {
  const S = fourStep(run);
  return '前 30 秒四步(' + trackName(run) + '):\n' +
    '① 0–5 秒 兑现标题:' + S.payoff + ';\n' +
    '② 5–15 秒 和观众扯上关系:' + S.tie + ';\n' +
    '③ 15–25 秒 留一个没答案的问题:' + S.question + ';\n' +
    '④ 25–30 秒 直接进正文:' + S.first + '。\n' + AVOID_TEXT + contractNote(run);
}
// 代入为主的片子:张力链排好以后,把开场合同的具体内容接在四步后面;还没排的(写前分析阶段)只提醒顺序
function contractNote(run) {
  if (!immersiveRun(run)) return '';
  let ct = '';
  try { ct = require('./qchain').contractText(run); } catch (e) { ct = ''; }
  return ct ? '\n' + ct : '\n代入开头:' + require('./qchain').CONTRACT_RULES + '。';
}
function titleKindOf(run, a) {
  const k = str(((a || (run || {}).analysis) || {}).title_kind);
  return /具体/.test(k) ? '具体说法' : /话题/.test(k) ? '话题' : '';
}
function analysisNote(run, asset) {
  const lang = str(((run || {}).audience || {}).target_language) || '目标语言';
  const src = sourceOpening(asset, LOCK_SEC + 3);
  const T = trackNote(run);
  return '【第 7 步 开头节拍表(' + trackName(run) + '赛道必做;和上面第 6 步的钩子冲突时以这里为准)】\n' +
    '原片前 45 秒字幕(左边是秒数):\n' + (src || '(没有原片字幕,按「开场契约」和留存地图里开头那一段拆)') + '\n\n' +
    '0. 先判断新标题的类型,写进 title_kind;' + TITLE_KIND_TEXT + 'title_payoff 写标题向观众承诺了什么(一句中文,开头第一句要兑现它)。\n' +
    '   - 「具体说法」:原片的内容不扔,但按前 30 秒四步重排:第一拍(B1,0–5 秒)新加一拍「兑现标题」,把标题说的结果 / 数字直接说出来(src_line 写「(新加:兑现标题)」);原片的想象、场景那几拍压成 1–2 句当「代入」;原片的反转 / 承诺挪到 25 秒前当「悬念」;接着直接进第一个数字(第一幕);原片其余的拍照原顺序接在后面。\n' +
    '   - 「话题」:可以照原片的顺序拍,但第一句也要说到标题那件事,不要慢热。\n' +
    '   ' + fourStepText(run).split('\n').join('\n   ') + '\n' +
    '1. 把原片前 45 秒逐拍拆开(一拍 = 一个作用,通常 5–8 拍),写进 opening_beats。每一拍写:\n' +
    '   - src_time(原片几秒到几秒)、src_line(原片原句);\n' +
    '   - role:这一拍的作用,用短语写,例如:' + T.roles + '(照原片这一拍实际起的作用写,不要套);\n' +
    '   - new_line:新题目这一拍说什么,用' + lang + '写一句示范。照原片这一拍的句式、长短和语气写(不是直译);数字只用事实表或账本里有出处的;\n' +
    '   - fact_ids:这一拍用到事实表哪几条;\n' +
    '   - anchors:2–3 个' + lang + '关键词(名词为主,不要数字),这一拍不管怎么换说法都会留着的词,程序用它逐拍核对这一拍在不在、顺序对不对;\n' +
    '   - you:这一拍是不是直接对观众说「你/당신」(原片是 you 的拍写 true;原片这一拍是旁白在讲别人、没有对观众说 you,写 false,新稿也不要硬加「당신」)。\n' +
    '2. 声音指纹(voice_prints):原片的口头禅和固定句式,例如「Okay, so you want to own a…」「What could go wrong? Almost everything.」。每个给 1–2 个' + lang + '的对应说法(不是直译,是这个语言里同样口气的说法),写明放在哪一拍。\n' +
    '3. 价值承诺要有,但必须是「带钩子的承诺」:承诺观众会得到一个出乎意料的答案,但不告诉他答案是什么。写进 hook_promise,同时作为节拍表里 role 为「价值承诺」的那一拍:\n' +
    '   ① 承诺结果,不报流程:不要单独出现「오늘은 ~를 계산해보겠습니다 / 알아보겠습니다」这种议程句;\n' +
    '   ② 点出有个答案、而且很意外,但把答案藏住:可以否定大家以为的答案(像' + T.no + '这样),可以给答案一个具体的形状(像' + T.shape + '这样);不能说出本质词(' + T.spoil + ');只说「놀라운 비밀」这种空话不合格;\n' +
    '   ③ ' + T.tie + ';\n' +
    '   ④ ' + T.place + ',大约 20–35 秒,一两句话。原片前 45 秒里本来就有承诺 / 预告的,照它的位置放。\n' +
    T.demo +
    '   hook_promise 写:beat(哪一拍)、shape(答案的形状,开头怎么说)、answer(真正的答案,只给后面写稿看,开头不说)、reveal_at(正文哪一段揭晓)、reveal_anchors(揭晓那段一定会出现的 2–3 个' + lang + '关键词)。\n' +
    '4. spoiler_terms:本题的本质词(答案的关键名词,' + lang + ',例如 ' + T.spoil + '),开头 45 秒里一个都不许出现。按这篇的题目写,程序就按这几个词查。\n' +
    '5. 保留这几条:第一句(5 秒内)兑现标题(题目要清楚,藏的是答案);45 秒前给出第一个甜头(一半答案),最晚 60 秒;一句最多 2 个数字;全篇一种语体。\n' +
    '   下面这几条通用开头规则在这张节拍表里让位,冲突时按节拍表:「8 秒内至少 3 个标题关键词」「前 10 秒最多 1 个数字」「删冷开场」「早点说本质」。\n' +
    '在输出的 JSON 里多加这几个字段:\n' +
    '"title_kind": "具体说法 或 话题", "title_payoff": "",\n' +
    '"opening_beats": [{"id": "B1", "src_time": "0:00-0:04", "src_line": "", "role": "", "new_line": "", "fact_ids": [], "anchors": [""], "you": true}],\n' +
    '"voice_prints": [{"source": "原片说法", "targets": ["对应说法"], "beat": "B1"}],\n' +
    '"hook_promise": {"beat": "B5", "shape": "", "answer": "", "reveal_at": "", "reveal_anchors": [""]},\n' +
    '"spoiler_terms": [""]';
}

// 写前分析出来以后整理一遍:编号、关键词、布尔值(模型偶尔写成字符串)
function normalize(a) {
  if (!a || typeof a !== 'object') return a;
  if (Array.isArray(a.opening_beats)) {
    a.opening_beats = a.opening_beats.filter(b => b && typeof b === 'object').map((b, i) => ({
      id: str(b.id).trim() || 'B' + (i + 1), src_time: str(b.src_time), src_line: str(b.src_line), role: str(b.role), new_line: str(b.new_line),
      fact_ids: arr(b.fact_ids).map(str), anchors: (Array.isArray(b.anchors) ? b.anchors : str(b.anchors).split(/[,，、]/)).map(x => str(x).trim()).filter(x => x && !/^\d[\d,.]*$/.test(x)).slice(0, 5),
      you: b.you === true || /^(true|是|yes)$/i.test(str(b.you))
    }));
    // id 重复的按顺序重编
    const seen = new Set();
    a.opening_beats.forEach((b, i) => { if (seen.has(b.id)) b.id = 'B' + (i + 1); seen.add(b.id); });
  }
  if (Array.isArray(a.voice_prints)) a.voice_prints = a.voice_prints.filter(v => v && typeof v === 'object').map(v => ({ source: str(v.source), targets: arr(v.targets).map(str).filter(Boolean), beat: str(v.beat) }));
  if (a.hook_promise && typeof a.hook_promise === 'object') {
    const h = a.hook_promise;
    a.hook_promise = { beat: str(h.beat), shape: str(h.shape), answer: str(h.answer), reveal_at: str(h.reveal_at), reveal_anchors: arr(h.reveal_anchors).map(x => str(x).trim()).filter(Boolean).slice(0, 5) };
  }
  if (a.title_kind != null) a.title_kind = /具体/.test(str(a.title_kind)) ? '具体说法' : /话题/.test(str(a.title_kind)) ? '话题' : '';
  if (a.title_payoff != null) a.title_payoff = str(a.title_payoff);
  if (a.spoiler_terms != null) a.spoiler_terms = (Array.isArray(a.spoiler_terms) ? a.spoiler_terms : str(a.spoiler_terms).split(/[,，、]/)).map(x => str(x).trim()).filter(Boolean).slice(0, 12);
  return a;
}

// ---------- 给蓝图、写稿、改稿的说明 ----------
const YIELD_RULES = '「8 秒内至少 3 个标题关键词」「前 10 秒最多 1 个数字」「删冷开场」「早点说本质」';
function beatLine(b) {
  return '- ' + b.id + (b.src_time ? '(原片 ' + b.src_time + ')' : '') + ' [' + (b.role || '?') + '] 原片「' + b.src_line + '」→ 示范「' + b.new_line + '」' +
    (b.fact_ids.length ? '(' + b.fact_ids.join(',') + ')' : '') + (b.anchors.length ? ' 关键词:' + b.anchors.join('、') : '') + (b.you ? ' 对观众说「你」' : '');
}
function promiseText(a, run) {
  const h = a.hook_promise || {};
  const sp = spoilers(a, run);
  return '价值承诺(带钩子的承诺' + (h.beat ? ',在 ' + h.beat : '') + '):承诺观众会得到一个出乎意料的答案,但不说答案是什么;可以说答案「不是什么」,可以给答案一个具体的形状' + (h.shape ? '(这篇:「' + h.shape + '」)' : '') +
    (trackOf(run) === 'econ' ? ',和观众自己挂钩(你开一家会站在哪边 / 你上次为什么多花钱)' : ',和观众挂钩(原片对观众说 you 的才对观众说「你」,不要硬加)') + ';不要「오늘은 ~를 계산해보겠습니다 / 알아보겠습니다」这种只报流程的议程句' +
    (sp.length ? ';开头 45 秒里不许出现本质词:' + sp.join('、') : '') +
    (h.answer ? '。答案是「' + h.answer + '」,' + (h.reveal_at ? '在 ' + h.reveal_at + ' 揭晓' : '在正文里揭晓') + ',揭晓时明确点回开头那句承诺' : '') + '。';
}
function titleLine(run, a) {
  const k = titleKindOf(run, a);
  const p = str((a || {}).title_payoff).trim();
  return (k ? '标题类型:' + k + (k === '具体说法' ? '(第一句就兑现标题,原片的场景铺垫压到 1–2 句)' : '(可以照原片顺序,但第一句要说到标题那件事)') : '') + (p ? (k ? ';' : '') + '标题承诺:' + p : '');
}
// v1.132 通用开头公式:写前分析的钩子、蓝图、写稿、改稿都按前 30 秒四步
function formulaBrief(run, a, mode) {
  const tl = titleLine(run, a);
  if (mode === 'review') return '开头(通用开头公式):改开头时按下面的前 30 秒四步检查,不合的地方只换词、挪句、删句,不加长。\n' + (tl ? tl + '\n' : '') + fourStepText(run);
  return '开头(通用开头公式):第一章开头按前 30 秒四步写,写前分析选定的钩子放进第 ① 步。\n' + (tl ? tl + '\n' : '') + fourStepText(run);
}
function formulaAnalysisNote(run) {
  return '【开头:前 30 秒四步(第 6 步的 3 个开场候选都按它写)】\n' +
    '先判断新标题的类型,写进 title_kind;' + TITLE_KIND_TEXT + 'title_payoff 写标题向观众承诺了什么(一句中文)。\n' +
    fourStepText(run) + '\n' +
    '每个开场候选的 text 按四步写成 4–6 句(目标语言),第一句兑现标题。\n' +
    '在输出的 JSON 里多加:"title_kind": "具体说法 或 话题", "title_payoff": ""';
}
function briefText(run, a, mode) {
  a = a || (run || {}).analysis;
  if (!on(run)) return a ? formulaBrief(run, a, mode) : '';
  const beats = beatsOf(run).map(b => normalize({ opening_beats: [b] }).opening_beats[0]);
  const vp = arr(a.voice_prints).filter(v => v.source || arr(v.targets).length);
  const vpText = vp.length ? '声音指纹(原片的口头禅、固定句式,放进对应的拍):\n' + vp.map(v => '- 原片「' + v.source + '」→ ' + arr(v.targets).map(t => '「' + t + '」').join(' / ') + (v.beat ? '(' + v.beat + ')' : '')).join('\n') : '';
  if (mode === 'review') {
    return '锁定开头(' + trackName(run) + ':' + OPEN_CH + ' 就是按原片前 45 秒节拍写的开头,观众留不留下来全看这一段):\n' +
      '- 在 ' + OPEN_CH + ' 里只能在原句位置替换:换数字、换说法、改语法。不许删拍、并拍、调顺序;不许提前说出答案(本质词不许出现);原片对观众说「你」的拍不许把「당신/你」去掉;不要加报流程的议程句。\n' +
      '- 开头的数字没出处:换成事实表里有出处的数,或改成不带数字的说法,这一拍要留着,不能整拍删。\n' +
      '- ' + YIELD_RULES + '这几条通用开头规则在 ' + OPEN_CH + ' 里只做提示,不要按它们改 ' + OPEN_CH + ';「本质未点明」在开头不算问题。\n' +
      '- 程序改完会逐拍核对,少了拍、顺序变了、说破答案、没了「你」,这一章会退回改之前的样子。\n' +
      (titleLine(run, a) ? titleLine(run, a) + '\n' : '') + '节拍(按顺序):\n' + beats.map(beatLine).join('\n') + '\n' + promiseText(a, run);
  }
  return '开头节拍表(' + trackName(run) + ':开头照原片前 45 秒的节拍写。和' + YIELD_RULES + '这些通用开头规则冲突时,按节拍表来):\n' +
    '- 蓝图:第一章 ' + OPEN_CH + ' 就是这张节拍表,时长从 0:00 到约 0:45(不超过 1:00),不放别的内容;' + OPEN_CH + ' 的 key_points 按拍写,每拍几秒、说什么;在 ' + OPEN_CH + ' 里加一个字段 "opening_beats": [' + beats.map(b => '"' + b.id + '"').join(', ') + '],按顺序列出全部拍。\n' +
    '- 写稿:' + OPEN_CH + ' 一拍一拍照着写,顺序不变,不删拍、不并拍;示范句可以润色,但保留它的句式、长短和作用;原片对观众说「你」的拍,新稿也对观众说「당신/你」。\n' +
    (titleLine(run, a) ? titleLine(run, a) + '\n' : '') +
    beats.map(beatLine).join('\n') + '\n' + (vpText ? vpText + '\n' : '') + promiseText(a, run) + '\n' +
    (contractNote(run) ? contractNote(run).trim() + '(节拍里要把合同的几项放进对应的拍)\n' : '') +
    '保留:第一句(5 秒内)兑现标题(题目要清楚,藏的是答案);45 秒前给出第一个甜头(一半答案),最晚 60 秒;一句最多 2 个数字;全篇一种语体。\n' + AVOID_TEXT;
}

// ---------- 程序检查 ----------
// 经济拆账另外固定查这几个机制名;其他赛道只查写前分析按这篇题目写的 spoiler_terms(v1.116)
const DEFAULT_SPOILERS = ['수익구조', '수익 구조', '객단가', '업셀', '업셀링', '비즈니스 모델', '收益结构', '盈利模式', '客单价', 'profit structure', 'business model', 'upsell'];
function spoilers(a, run) {
  const own = arr((a || {}).spoiler_terms).map(str).filter(t => t.trim().length >= 2);
  return [...new Set(run && trackOf(run) !== 'econ' ? own : own.concat(DEFAULT_SPOILERS))];
}
// 只报流程的议程句:「오늘은 ~를 계산해보겠습니다 / 알아보겠습니다」
const AGENDA_RE = checks.AGENDA_RE; // v1.132 挪到 checks.js,通用开头公式也查
const YOU_RE = /당신|여러분|(^|[\s"“])(너|네가|니가)(?=[\s,.!?은는가를의도])|\byou\b|\byour\b|你|您|あなた/i;
function sentences(text) {
  return str(text).split('\n').map(l => l.trim()).filter(l => l && !/^\[CH\d+/.test(l)).flatMap(l => l.split(/(?<=[.!?。！？…]["”’」)]?)\s+/)).map(t => t.trim()).filter(Boolean);
}
// 稿子切章(和 review.js 同一套写法;这里自带一份,免得互相 require)
function chaptersOf(script) {
  const re = /^\[(CH\d+)\s*\|\s*([^|\]]*?)\s*\|\s*([^\]]*?)\s*\]\s*$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(script)) !== null) marks.push({ id: m[1], range: m[2], index: m.index, end: m.index + m[0].length });
  return marks.map((k, i) => {
    const bodyEnd = i + 1 < marks.length ? marks[i + 1].index : script.length;
    const r = k.range.match(/(\d+:\d+(?::\d+)?)\s*[-–—~]\s*(\d+:\d+(?::\d+)?)/);
    return { id: k.id, start: r ? checks.toSec(r[1]) : null, end: r ? checks.toSec(r[2]) : null, text: script.slice(k.end, bodyEnd).trim(), bodyStart: k.end, bodyEnd };
  });
}
function openingOf(script) { return chaptersOf(str(script)).find(c => c.id === OPEN_CH) || null; }
function replaceOpening(script, body) {
  const ch = openingOf(script);
  if (!ch) return null;
  const tail = script.slice(ch.bodyEnd);
  return script.slice(0, ch.bodyStart) + '\n' + str(body).trim() + (tail ? '\n\n' + tail.replace(/^\s+/, '') : '\n');
}
const low = t => str(t).toLowerCase().replace(/\s+/g, ' ');
// 逐拍核对:每拍的关键词按顺序找(找到一个就算这一拍在);顺序乱了、没找到的、说破答案、议程句、有没有「你」
function check(run, script, aIn) {
  const a = aIn || (run || {}).analysis || {};
  const beats = arr(a.opening_beats).length ? normalize({ opening_beats: a.opening_beats }).opening_beats : [];
  const ch = openingOf(script);
  if (!ch) return { ok: false, no_opening: true, issues: ['稿子里找不到开头章 ' + OPEN_CH], beats: [], missing: [], out_of_order: [], spoilers: [], agenda: [], you: false, you_needed: beats.some(b => b.you) };
  const text = low(ch.text);
  let pos = 0;
  const rows = beats.map(b => {
    if (!b.anchors.length) return { id: b.id, role: b.role, checked: false, found: true };
    const hits = b.anchors.map(w => ({ w, at: text.indexOf(low(w), pos) })).filter(x => x.at >= 0).sort((x, y) => x.at - y.at);
    if (hits.length) { pos = hits[0].at; return { id: b.id, role: b.role, checked: true, found: true, at: hits[0].at, word: hits[0].w }; }
    const anywhere = b.anchors.some(w => text.includes(low(w)));
    return { id: b.id, role: b.role, checked: true, found: anywhere, out_of_order: anywhere };
  });
  const missing = rows.filter(r => r.checked && !r.found).map(r => r.id);
  const outOfOrder = rows.filter(r => r.out_of_order).map(r => r.id);
  const sp = spoilers(a, run).filter(t => text.includes(low(t)));
  const sents = sentences(ch.text);
  const agenda = sents.filter(s => AGENDA_RE.some(re => re.test(s)));
  const you = YOU_RE.test(ch.text);
  const youNeeded = beats.some(b => b.you);
  const greet = sents.slice(0, 4).filter(s => checks.GREET_RE.some(re => re.test(s)));
  const issues = [];
  if (missing.length) issues.push('开头少了拍:' + missing.map(id => id + '「' + ((beats.find(b => b.id === id) || {}).role || '') + '」').join('、'));
  if (outOfOrder.length) issues.push('开头的拍顺序乱了:' + outOfOrder.join('、'));
  if (sp.length) issues.push('开头 45 秒里说破了答案(本质词:' + sp.join('、') + ')');
  if (agenda.length) issues.push('开头的价值承诺是报流程的议程句:「' + agenda[0] + '」');
  if (youNeeded && !you) issues.push('开头没有对观众说「당신/你」');
  if (greet.length) issues.push('开头在打招呼或自我介绍:「' + greet[0] + '」');
  return { ok: !issues.length, issues, beats: rows, missing, out_of_order: outOfOrder, spoilers: sp, agenda, greet, you, you_needed: youNeeded, chars: ch.text.length, end_sec: ch.end };
}

// 蓝图第一章:时长、有没有按拍列 opening_beats
function checkBlueprint(run, bpText) {
  let bp = null;
  try { bp = JSON.parse(checks.stripFence(str(bpText))); } catch (e) { bp = checks.extractJsonObject(str(bpText)); }
  const chs = arr((bp || {}).chapters);
  const c1 = chs[0];
  if (!c1) return { ok: false, issues: ['蓝图没有章节'] };
  const ids = beatsOf(run).map((b, i) => str(b.id).trim() || 'B' + (i + 1));
  const issues = [];
  const range = str(c1.time_range || c1.range || c1.time || '');
  const m = range.match(/(\d+:\d+)\s*[-–—~]\s*(\d+:\d+)/);
  const end = m ? checks.toSec(m[2]) : (Number(c1.end_sec) || null);
  if (end != null && end > 60) issues.push('第一章到 ' + mmss(end) + ' 才结束,开头章只放节拍表那 45 秒左右(不超过 1:00),后面的内容挪到第二章');
  if (end != null && end < 25) issues.push('第一章只有 ' + mmss(end) + ',放不下整张节拍表(原片前 45 秒)');
  const got = arr(c1.opening_beats).map(x => str(x).trim());
  const lack = ids.filter(id => !got.includes(id));
  if (lack.length) issues.push('第一章的 opening_beats 少了 ' + lack.join('、') + '(要按顺序列出全部拍:' + ids.join(', ') + ')');
  else if (got.filter(x => ids.includes(x)).join() !== ids.join()) issues.push('第一章 opening_beats 的顺序和节拍表不一样(要按 ' + ids.join(', ') + ')');
  return { ok: !issues.length, issues, end };
}

// 写稿后开头不合格:只重写开头章的反馈
function rewriteFeedback(run, c) {
  return '开头章 ' + OPEN_CH + ' 没按开头节拍表写:' + c.issues.join(';') + '。\n请只重写 ' + OPEN_CH + ':一拍一拍照节拍表写,顺序不变,不删拍不并拍;价值承诺用带钩子的承诺,不说出答案、不报流程;原片对观众说「你」的拍,新稿也说「당신/你」。' +
    '只输出 ' + OPEN_CH + ' 这一章(第一行是原来的 [' + OPEN_CH + ' | …] 标签行,下面是正文),不要输出别的章,不要解释。\n节拍表:\n' + beatsOf(run).map(b => normalize({ opening_beats: [b] }).opening_beats[0]).map(beatLine).join('\n');
}
// 模型只回了开头章:换进稿子
function spliceOpening(script, reply) {
  const body = (openingOf(str(reply)) || {}).text || '';
  if (!body.trim()) return null;
  return replaceOpening(script, body);
}

// ---------- 锁定开头:改稿以后逐拍核对,改坏了退回 ----------
function lockReasons(cb, ca) {
  const out = [];
  if (!ca || ca.no_opening) return cb && !cb.no_opening ? ['开头章没了'] : [];
  const newMissing = ca.missing.filter(id => !cb.missing.includes(id));
  if (newMissing.length) out.push('删了拍 ' + newMissing.join('、'));
  const newOrder = ca.out_of_order.filter(id => !cb.out_of_order.includes(id));
  if (newOrder.length) out.push('调了顺序 ' + newOrder.join('、'));
  const newSp = ca.spoilers.filter(t => !cb.spoilers.includes(t));
  if (newSp.length) out.push('提前说破答案(' + newSp.join('、') + ')');
  if (ca.agenda.length > cb.agenda.length) out.push('加了报流程的议程句');
  if (arr(ca.greet).length > arr(cb.greet).length) out.push('加了打招呼 / 自我介绍');
  if (cb.you_needed && cb.you && !ca.you) out.push('去掉了「당신/你」'); // 原片对观众说 you 的才管(v1.116 历史类等旁白片不强加)
  return out;
}
// before → after 的改动如果把开头改坏了,开头章换回 before 的,返回 { text, reverted, reasons }
function guard(run, before, after, stage) {
  if (!on(run) || !before || !after || before === after) return { text: after, reverted: false };
  const ob = openingOf(before), oa = openingOf(after);
  if (!ob) return { text: after, reverted: false };
  if (oa && ob.text === oa.text) return { text: after, reverted: false };
  // v1.118 照原片开头:终审、补改、自动改开头一律不许动开头(哪怕只换词);开头只在「开头单独审」那一栏人点按钮改
  const strict = /^(终审|补改|自动改开头)/.test(String(stage || ''));
  let reasons = lockReasons(check(run, before), check(run, after));
  if (strict && !reasons.length) reasons = ['照原片开头已锁定,' + stage + '不改开头(要改开头在「开头单独审」里点「按开头审意见改开头」)'];
  if (!reasons.length) return { text: after, reverted: false };
  const restored = oa ? replaceOpening(after, ob.text) : null;
  if (!restored) return { text: after, reverted: false, reasons };
  logEvent(run, { stage: stage || '改稿', reasons, before: ob.text.slice(0, 600), tried: oa ? oa.text.slice(0, 600) : '' });
  return { text: restored, reverted: true, reasons };
}
function logEvent(run, ev) {
  run.opening_lock = run.opening_lock || {};
  run.opening_lock.events = [...arr(run.opening_lock.events), { at: new Date().toISOString(), ...ev }].slice(-30);
}
// ---------- 承诺要兑现 ----------
function promiseKept(run, script) {
  if (!on(run)) return null;
  const h = ((run.analysis || {}).hook_promise) || {};
  const words = arr(h.reveal_anchors).map(str).filter(Boolean);
  if (!words.length) return null;
  const ch = openingOf(script);
  const rest = low(ch ? str(script).slice(ch.bodyEnd) : script);
  const hit = words.filter(w => rest.includes(low(w)));
  return { ok: hit.length > 0, shape: h.shape || '', answer: h.answer || '', reveal_at: h.reveal_at || '', words, hit };
}

// ---------- 开头对比:原片节拍 / 初稿开头 / 当前开头 ----------
function beatSentences(run, script) {
  const ch = openingOf(script);
  const beats = beatsOf(run).map(b => normalize({ opening_beats: [b] }).opening_beats[0]);
  if (!ch) return beats.map(() => '');
  const sents = sentences(ch.text);
  // 每拍从第一个含关键词的句子开始(按顺序往后找),到下一拍开始前为止;没有关键词或没找到的拍留空
  let k = 0;
  const starts = beats.map(b => {
    if (!b.anchors.length) return -1;
    for (let i = k; i < sents.length; i++) if (b.anchors.some(w => low(sents[i]).includes(low(w)))) { k = i; return i; }
    return -1;
  });
  return beats.map((b, j) => {
    const st = starts[j];
    if (st < 0) return '';
    const nexts = starts.slice(j + 1).filter(x => x > st);
    const end = nexts.length ? Math.min(...nexts) : sents.length;
    return sents.slice(st, Math.max(st + 1, end)).join(' ');
  });
}
function compare(run, draftText, curText) {
  if (!on(run)) return null;
  const beats = beatsOf(run).map(b => normalize({ opening_beats: [b] }).opening_beats[0]);
  const d = beatSentences(run, draftText), c = beatSentences(run, curText);
  const cd = check(run, draftText), cc = check(run, curText);
  const od = openingOf(draftText), oc = openingOf(curText);
  return {
    rows: beats.map((b, i) => {
      const rd = cd.beats[i] || {}, rc = cc.beats[i] || {};
      const state = rc.checked && !rc.found ? 'deleted' : rc.out_of_order ? 'moved' : (d[i] && c[i] && d[i] !== c[i]) ? 'changed' : 'same';
      return { id: b.id, role: b.role, src_time: b.src_time, src_line: b.src_line, demo: b.new_line, draft: d[i], current: c[i], draft_found: rd.found !== false, state };
    }),
    draft_text: od ? od.text : '', current_text: oc ? oc.text : '', same: !!(od && oc && od.text === oc.text),
    draft_check: cd, current_check: cc, events: arr((run.opening_lock || {}).events)
  };
}

module.exports = { trackOf, FOUR_STEP, fourStep, contractNote, immersiveRun, fourStepText, AVOID_TEXT, TITLE_KIND_TEXT, titleKindOf, titleLine, formulaBrief, formulaAnalysisNote, TRACKS, TRACK_NAMES, RULES, ruleOf, ruleView, trackName, TRACK_NOTE, LOCK_SEC, OPEN_CH, wanted, on, beatsOf, sourceOpening, analysisNote, normalize, briefText, check, checkBlueprint, rewriteFeedback, spliceOpening, guard, lockReasons, promiseKept, compare, openingOf, replaceOpening, spoilers, AGENDA_RE, YOU_RE };
