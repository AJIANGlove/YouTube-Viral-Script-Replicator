// v1.69 原片残留 + 人物连贯 + 没出处的说法
// 实测 run_cb26dc06a1f8(조선 여성 거상):写前分析把英格兰原片的「农民→骑士→男爵→伯爵→王冠」一级对一级换成朝鲜女性,
// 稿子里留下「성곽(城堡)」「왕관」「환상 작품(奇幻作品)」「무작위(untitled 直译成随机)」;CH08–CH14 七章没有「당신」;
// 等级从第 4 级跳到第 6 级、第 8 级是国王(女主角做不到);事实核验判 C 的「法律上身份分五等」照样当论点写。
// 这里只放程序能确定的检查(查词、数章、对编号、按关键词找句子),人物身份前后一致、稿子内换算交给复审和论点核对的提示词。
const arr = v => (Array.isArray(v) ? v : []);
const HANGUL = /[가-힣]/;
const HAN = /[一-鿿]/;

// ---------- 叙事方式 ----------
// climb:同一个人一级一级往上爬;per_level:每一级换一个人(「这次你生在…」);none:不是代入「你」的写法
const POV_MODES = { climb: '同一个人往上爬', per_level: '每一级换一个人', none: '不是第二人称代入' };
function povModeOf(a) {
  const sm = (a && a.source_mapping) || {};
  return POV_MODES[sm.pov_mode] ? sm.pov_mode : '';
}
// POV 项开不开:写前分析判了叙事方式就按它;旧任务没判过的,按终审赛道是不是 pov
function povOn(run, trackKey) {
  const m = povModeOf(run && run.analysis);
  if (m) return m !== 'none';
  return trackKey === 'pov';
}
// 第二人称:按稿子语言
function youRe(lang) {
  // 韩文:당신,也认半语的「너/네가」和「그대」(실측 run_77b4651152ef 궁녀 全篇用「너」);「네」单独是「是/四」,不算
  if (/Korean/i.test(lang || '')) return /당신|(?:^|[^가-힣])(?:너(?:는|를|의|에게|도|만|와|랑|한테|조차|부터|라고|라면|희)?|네가|그대(?:는|를|의|에게|도|가)?)(?![가-힣])/;
  if (/Japanese/i.test(lang || '')) return /あなた/;
  if (/Chinese/i.test(lang || '')) return /你/;
  if (/English/i.test(lang || '') || !lang) return /\byou(?:r|rs|rself)?\b/i;
  return null;
}

// ---------- 原片残留词 ----------
function termOk(w) {
  if (HANGUL.test(w)) return w.replace(/\s/g, '').length >= 2;
  if (HAN.test(w)) return w.length >= 2;
  return /^[A-Za-z][A-Za-z\s'’-]{2,}$/.test(w);
}
function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function termRe(w) {
  const e = escRe(w).replace(/\s+/g, '\\s*');
  // 韩文:词首匹配(前面不是韩文字),后面可以接助词;英文:整词,可带复数
  if (HANGUL.test(w)) return new RegExp('(?:^|[^\\uac00-\\ud7a3])' + e);
  if (HAN.test(w)) return new RegExp(e);
  return new RegExp('(?:^|[^A-Za-z])' + e + '(?:e?s)?(?![A-Za-z])', 'i');
}
// 韩文里本来就常用的同形词,单独列出来查必然误报(실측 버스걸 篇:knight 列了「기사」,稿子里是「신문 기사」新闻报道;
// 「기사」还是司机、「영주」「성주」是地名)。对照表里列了也不查,要查就列更长的说法(「기사 작위」「기사단」)
const AMBIG_KO = new Set(['기사', '영주', '성주', '경', '공', '백', '후', '자', '왕', '성', '칼', '검', '관', '주인', '사형', '귀족']);
// 对照表 → 残留词清单。本地说法里本来就有的词、标题里的词不算(题目自己要用)
function residueTerms(run) {
  const a = (run && run.analysis) || {};
  const sm = a.source_mapping;
  if (!sm || sm.same_context) return [];
  const items = arr(sm.items).filter(x => x && typeof x === 'object');
  const locals = items.map(i => String(i.local || '')).join(' ');
  const title = [run.topic, (a.title || {}).final_title].filter(Boolean).join(' ');
  const out = [];
  const add = (w, it) => {
    w = String(w || '').trim();
    if (!w || !termOk(w) || AMBIG_KO.has(w.replace(/\s+/g, '')) || out.some(t => t.word.toLowerCase() === w.toLowerCase())) return;
    if (locals.includes(w) || title.toLowerCase().includes(w.toLowerCase())) return;
    out.push({ word: w, source: it ? String(it.source || '') : '', local: it ? String(it.local || '') : '', re: termRe(w) });
  };
  items.forEach(it => arr(it.residue).forEach(w => add(w, it)));
  arr(sm.extra_residue).forEach(w => add(w, null));
  return out;
}
// 句子:按句末标点 + 空白、换行切
function sentencesOf(text) {
  return String(text || '').split(/\n+|(?<=[.!?。！？…])\s+/).map(s => s.trim()).filter(Boolean);
}
// chapters:[{ id, text }];返回 [{ ch, word, source, local, text }],同一句只列一次(多个词合在一起)
function residueHits(run, chapters) {
  const terms = residueTerms(run);
  if (!terms.length) return [];
  const out = [];
  arr(chapters).forEach(c => sentencesOf(c.text).forEach(s => {
    let hit = terms.filter(t => t.re.test(s));
    // 「무작위」和「무작」同时命中只列长的那个
    hit = hit.filter(t => !hit.some(o => o !== t && o.word.length > t.word.length && o.word.includes(t.word)));
    if (!hit.length) return;
    out.push({ ch: c.id, words: hit.map(t => t.word), source: hit.map(t => t.source).filter(Boolean).join('、'), local: hit.map(t => t.local).filter(Boolean).join('、'), text: s });
  }));
  return out;
}

// ---------- 等级编号 ----------
const KO_ORD = { 첫: 1, 두: 2, 둘: 2, 세: 3, 셋: 3, 네: 4, 넷: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10 };
const ZH_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const EN_ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
// 段落开头的等级标记:「제3급,」「네 번째 등급,」「第三级」「Level 3」「The fourth rank」
function levelAtStart(p) {
  const s = String(p || '').replace(/^[\s*#>\-–—"“'‘(「【\[]+/, '').slice(0, 40);
  let m = s.match(/^제\s*(\d{1,2})\s*(?:급|등급|단계|계단|계층)/) || s.match(/^(\d{1,2})\s*(?:급|등급|단계)(?:[\s,.:]|$)/);
  if (m) return Number(m[1]);
  m = s.match(/^(첫|두|둘|세|셋|네|넷|다섯|여섯|일곱|여덟|아홉|열)\s*(?:번)?\s*째\s*(?:등급|단계|계단|급|계층)/);
  if (m) return KO_ORD[m[1]];
  m = s.match(/^第\s*([一二三四五六七八九十]|\d{1,2})\s*(?:级|等|层|阶)/);
  if (m) return ZH_NUM[m[1]] || Number(m[1]);
  m = s.match(/^(?:the\s+)?(?:(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:level|rank|tier|rung|step)|(?:level|rank|tier|rung|step)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten))\b/i);
  if (m) return m[1] ? EN_ORD[m[1].toLowerCase()] : (EN_ORD[String(m[2]).toLowerCase()] || Number(m[2]));
  return null;
}
// 章节里出现的等级号 → { levels:[{n, ch}], missing:[n] };少于 3 级不算阶梯,不查
function levelGaps(chapters) {
  const seen = new Map();
  arr(chapters).forEach(c => String(c.text || '').split(/\n+/).forEach(p => {
    const n = levelAtStart(p);
    if (n && n <= 12 && !seen.has(n)) seen.set(n, c.id);
  }));
  const ns = [...seen.keys()].sort((x, y) => x - y);
  if (ns.length < 3) return { levels: [], missing: [] };
  // 只查中间跳号:第一级常常不写编号(开头直接进场景),最低一级以下的不算缺
  const missing = [];
  for (let i = ns[0] + 1; i < ns[ns.length - 1]; i++) if (!seen.has(i)) missing.push(i);
  return { levels: ns.map(n => ({ n, ch: seen.get(n) })), missing };
}

// ---------- 每章有没有「你」 ----------
// 连续 3 章以上没有 → 关键(挡发布);零散一两章(免责声明、总结)→ 只提示
const NO_YOU_RUN = 3;
function noYou(chapters, lang) {
  const re = youRe(lang);
  if (!re) return { missing: [], runs: [] };
  const list = arr(chapters);
  const missing = list.filter(c => !re.test(c.text || '')).map(c => c.id);
  const runs = [];
  let cur = [];
  list.forEach(c => { if (missing.includes(c.id)) cur.push(c.id); else { if (cur.length) runs.push(cur); cur = []; } });
  if (cur.length) runs.push(cur);
  return { missing, runs: runs.filter(r => r.length >= NO_YOU_RUN) };
}

// 对照表里标了「主角做不到」的等级(例如女性巨商当国王)
function unreachableLevels(a) {
  const sm = (a && a.source_mapping) || {};
  return arr(sm.levels).filter(l => l && l.reachable === false).map(l => ({ n: l.n, local: String(l.local || ''), why: String(l.why || '') }));
}

// ---------- 没出处的说法 ----------
// 事实核验判 C(部分证据)/D(证据不足)/E(和证据矛盾)的事实、因果类主张:稿子里还在用就列出来。
// 只看定性说法:计算、口径类的数在账本、论点核对和「没出处的数」里查
const WEAK_GRADES = ['C', 'D', 'E'];
const PARTICLE_RE = /(?:에서|으로|에게|까지|부터|이며|이고|이나|하며|하고|보다|처럼|은|는|이|가|을|를|의|에|로|도|와|과|만|며)$/;
function claimWords(claim) {
  const ws = (String(claim || '').match(/[가-힣]{2,}/g) || []).map(w => (w.length >= 3 ? w.replace(PARTICLE_RE, '') : w)).filter(w => w.length >= 2);
  return [...new Set(ws)];
}
function chaptersOfItem(ch, chapters) {
  const ids = String(ch || '').toUpperCase().match(/CH\d+/g);
  if (!ids) return arr(chapters);
  return arr(chapters).filter(c => ids.includes(c.id));
}
// 一条主张在稿子里落在哪几句:主张里的韩文词至少 3 个,一半以上(至少 3 个)出现在同一句或相邻的最多 3 句里(比较时去掉空格)
const CLAIM_WINDOW = 3;
function claimSentences(claim, chapters, top) {
  const ws = claimWords(claim);
  if (ws.length < 3) return [];
  const need = Math.max(3, Math.ceil(ws.length * 0.5));
  const cnt = t => { const c = t.replace(/\s+/g, ''); return ws.filter(w => c.includes(w)).length; };
  const out = [];
  chapters.forEach(c => {
    const ss = sentencesOf(c.text);
    for (let i = 0; i < ss.length; i++) {
      if (!cnt(ss[i])) continue;
      for (let k = 1; k <= CLAIM_WINDOW && i + k <= ss.length; k++) {
        const t = ss.slice(i, i + k).join(' ');
        const n = cnt(t);
        if (n >= need) { if (!out.some(o => o.ch === c.id && (o.text.includes(ss[i]) || t.includes(o.text)))) out.push({ ch: c.id, text: t, score: n, ctx: ss.slice(Math.max(0, i - 2), i + k).join(' ') }); break; }
      }
    }
  });
  return out.sort((x, y) => y.score - x.score).slice(0, top || 2);
}
// 不列的几种(扫全部已有任务时这几种几乎都是误报):
// - 估算、假设:账本里本来就标了「估算/假设」,由账本检查管,不是「没出处的制度说法」;
// - 核验自己说可以留:「观众不易察觉」「原文已标明估算/假设」这类;
// - 已经按核验改过:主张里的数在那几句里一个都没有了,或者核验给的改法原句已经在稿子里。
const WEAK_SKIP_TYPE = /计算|口径|估算|假设/;
const WEAK_OK_FINDING = /察觉|无需核实|눈치\s*채기\s*어려|불인지|低风险|无需核验|무需核验|无需验证|已明示|已标明|已标注|已명시|已명|已제시|已说明|명시했|명시되/;
// 只管「制度说法」(法律、身份、官制、规定、权利义务这类):数字、个案、比喻由「没出处的数」和复审管。
// 扫全部已有任务时,不限定的话经济类每篇列出 3–9 条估算和个案,几乎都是误报
const INSTITUTION_RE = /법적|법률|법령|법으로|법상|불법|합법|[가-힣]*법(?:에|은|이|상)|규정|제도|경국대전|대전|조례|신분|품계|관직|관부|관청|세금|납부|의무|권리|재산권|허가|금지|法律|法令|法规|法定|规定|制度|法典|大典|身份|官府|官制|品级|服色|税|义务|权利|产权|禁止|合法|违法/;
// 核验的改法就是「保留」(不要求补出处、不要求删)
const WEAK_KEEP_FIX = /^\s*(?:保留|보류|유지)/;
const WEAK_NEED_FIX = /待补|来源|出处|删|출처/;
// 改法里的说明用词,不算「改后的词」
const FIX_STOP = new Set(['명시', '표기', '삭제', '추정치', '확인', '보완', '기준', '필요', '개별', '증언', '기반', '언급', '또는', '한정', '참조', '보도', '언론', '구체적', '수치', '조문', '시점', '통계', '없음', '존재', '일반', '연구', '보존', '논리']);
function claimNums(t) {
  return [...new Set((String(t || '').match(/\d[\d,.]*/g) || []).map(n => n.replace(/[,.]$/, '').replace(/,/g, '')).filter(n => n.length >= 2 || Number(n) >= 2))];
}
function fixQuotes(fix) {
  return (String(fix || '').match(/[「“"]([^」”"]{6,})[」”"]/g) || []).map(q => q.slice(1, -1)).filter(q => HANGUL.test(q));
}
// 这几句是不是已经按核验改过了。text 是命中的句子,ctx 是连同前两句
function fixApplied(item, text, ctx) {
  const tn = claimNums(text), cn = claimNums(item.claim), fn = claimNums(item.fix);
  // 核验给了新数:新数在句子里、旧数一个都不在了
  const newN = fn.filter(n => !cn.includes(n)), oldN = cn.filter(n => !fn.includes(n));
  if (newN.some(n => tn.includes(n)) && !oldN.some(n => tn.includes(n))) return true;
  const c = String(ctx || text).replace(/\s+/g, '');
  const cws = claimWords(item.claim), cw = new Set(cws);
  const related = w => cws.some(x => x.includes(w) || w.includes(x));
  // 改法里新出现的词(主张里没有、也不是主张里某个词的一部分)已经在这几句里
  if (claimWords(item.fix).some(w => !related(w) && !FIX_STOP.has(w) && w.length >= 2 && c.includes(w))) return true;
  // 核验给了改写的原句:主张里有、改法里没有的词,这几句里一个都没有了
  const qs = fixQuotes(item.fix);
  if (qs.length) {
    const fw = new Set(qs.flatMap(claimWords));
    const only = [...cw].filter(w => !fw.has(w));
    if (only.length && !only.some(w => c.includes(w))) return true;
  }
  return false;
}
function weakClaimUses(run, chapters) {
  const fc = (run.review || {}).factcheck;
  if (!fc) return [];
  return arr(fc.items).filter(i => WEAK_GRADES.includes(i.grade) && !WEAK_SKIP_TYPE.test(i.type || '') && !WEAK_OK_FINDING.test((i.finding || '') + ' ' + (i.fix || ''))
    && INSTITUTION_RE.test([i.claim, i.finding, i.fix].join(' '))
    && !(WEAK_KEEP_FIX.test(i.fix || '') && !WEAK_NEED_FIX.test(i.fix || ''))).map(i => {
    const nums = claimNums(i.claim), ws = claimWords(i.claim);
    const cand = claimSentences(i.claim, chaptersOfItem(i.chapter, chapters), 6);
    // 有一处已经按核验改过,就当这条处理过了(同一主张在别的句子里只剩没问题的半句)
    // 前两句也算进来(「조선시대에는 이런 전통이 있었습니다」这种限定常写在前一句)
    if (cand.some(u => fixApplied(i, u.text, u.ctx))) return null;
    const uses = cand.filter(u => {
      // 主张里的数一个都不在了、词也只对上一部分:多半是改写过,不算
      const c = u.text.replace(/\s+/g, '');
      return !(nums.length && !nums.some(n => claimNums(u.text).includes(n)) && ws.filter(w => c.includes(w)).length < ws.length * 0.8);
    }).slice(0, 2).map(u => ({ ch: u.ch, text: u.text, score: u.score }));
    return { id: i.id, grade: i.grade, type: i.type || '', claim: i.claim || '', finding: i.finding || '', fix: i.fix || '', action: i.action || '', uses };
  }).filter(x => x && x.uses.length);
}

// ---------- 汇总 ----------
// 审稿页、挡发布、「AI 改一轮」共用:chapters 是当前稿子的章节
function scan(run, chapters, trackKey) {
  const a = run.analysis || {};
  const lang = (run.audience || {}).target_language || '';
  const pov = povOn(run, trackKey);
  const sm = a.source_mapping || null;
  return {
    has_mapping: !!sm,
    mapping_at: sm ? sm.at || '' : '',
    pov_mode: povModeOf(a), pov_on: pov,
    residue: residueHits(run, chapters),
    no_you: pov ? noYou(chapters, lang) : { missing: [], runs: [] },
    levels: pov ? levelGaps(chapters) : { levels: [], missing: [] },
    unreachable: pov ? unreachableLevels(a) : [],
    weak: weakClaimUses(run, chapters)
  };
}

// 蓝图(Step 1 JSON):每章的文字字段拼起来当一章查
function blueprintChapters(text) {
  let bp;
  try { bp = JSON.parse(String(text || '').replace(/^```(?:json)?\s*|```\s*$/g, '')); } catch (e) { return []; }
  const chs = arr((bp || {}).chapters || (bp || {}).blueprint || bp);
  return chs.filter(c => c && typeof c === 'object').map((c, i) => ({
    id: String(c.id || c.chapter_id || 'CH' + String(i + 1).padStart(2, '0')),
    text: ['purpose', 'information_goal', 'treatment', 'new_lens', 'answers_prev', 'leaves_question', 'retention_goal'].map(k => typeof c[k] === 'string' ? c[k] : '').filter(Boolean).join('\n')
  }));
}
function scanBlueprint(run, text) {
  const chs = blueprintChapters(text);
  const pov = povOn(run, '');
  return { at: new Date().toISOString(), residue: residueHits(run, chs), levels: pov ? levelGaps(chs) : { levels: [], missing: [] } };
}
// 蓝图闸门的反馈(一次):残留词和跳号
function blueprintFeedback(run, res) {
  const parts = [];
  if (res.residue.length) {
    const ws = [...new Set(res.residue.flatMap(h => h.words))];
    const map = residueTerms(run).filter(t => ws.includes(t.word)).map(t => t.word + (t.local ? ' → ' + t.local : t.source ? ' → 删掉' : ' → 换成本题里的说法'));
    parts.push('蓝图里还有原片专属的东西(' + res.residue.map(h => h.ch).filter((v, i, s) => s.indexOf(v) === i).join('、') + '):' + map.join(';') + '。按写前分析的「原片 → 本地对照表」换成本地说法,不能照抄原片的头衔、建筑、器物、制度');
  }
  if (res.levels.missing.length) parts.push('等级编号跳号:有 ' + res.levels.levels.map(l => l.n).join('、') + ' 级,缺第 ' + res.levels.missing.join('、') + ' 级。等级要连续编号,中间分岔、讲案例的章不占等级号,或者补上缺的那一级');
  return parts.join(';');
}

module.exports = { POV_MODES, povModeOf, povOn, youRe, residueTerms, residueHits, levelAtStart, levelGaps, noYou, unreachableLevels, claimWords, claimSentences, weakClaimUses, scan, scanBlueprint, blueprintChapters, blueprintFeedback, sentencesOf, NO_YOU_RUN };
