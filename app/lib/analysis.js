// 写前分析(流程 B②–⑧)与稿件检查(流程 B⑬⑭)
// 写前分析:一次 LLM 调用跑完六步(适配/标题/论点/事实表/留存地图与取舍/钩子),产物存 run.analysis,
// 任务置为 awaiting_review 等人工确认(③⑤⑦⑨ 合并为一次确认),确认后才进入四步写稿。
// 稿件检查:程序先算稿件数据(retention.scriptStats),再由 LLM 按 K1–K5 出报告;只有 K3 自动改稿,其余给选项。
const fs = require('fs');
const path = require('path');
const store = require('./store');
const checks = require('./checks');
const retention = require('./retention');
const voice = require('./voice');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');
const GATE_MAX_RETRIES = 2;
const readPrompt = f => fs.readFileSync(path.join(PROMPTS_DIR, f), 'utf-8');
const parse = t => { try { return JSON.parse(t); } catch (e) { return null; } };
const dataOf = j => (j && j.data) || j || {};
const list = a => (Array.isArray(a) && a.length ? a.join(';') : '(无)');

// ---------- 赛道证据卡(A4 的产物,存于 prompts/track_cards.md) ----------
function loadTrackCards() {
  const text = readPrompt('track_cards.md');
  return text.split(/^## /m).slice(1).map(block => {
    const lines = block.split('\n');
    const name = lines[0].trim();
    const kwLine = lines.find(l => l.startsWith('关键词:')) || '';
    const keywords = kwLine.replace('关键词:', '').split(/[,，]/).map(s => s.trim().toLowerCase()).filter(Boolean);
    const body = lines.slice(1).filter(l => !l.startsWith('关键词:')).join('\n').trim();
    return { name, keywords, text: '【' + name + '】\n' + body };
  });
}

// 按"赛道 + 题目 + 资产名/题材"命中关键词最多的卡;都不命中返回 null
function pickTrackCard(track, topic, asset) {
  const fw = dataOf(parse((asset && asset.framework) || ''));
  const hay = [track, topic, asset && asset.id, asset && asset.meta && asset.meta.name, ((fw.content_profile || {}).genres || []).join(' ')]
    .filter(Boolean).join(' ').toLowerCase();
  let best = null, bestScore = 0;
  for (const c of loadTrackCards()) {
    const score = c.keywords.filter(k => hay.includes(k)).length;
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return best;
}

// 写前分析与「AI 先调整」「标题审核」共用的框架侧变量
function frameworkVars(run, asset) {
  const fw = dataOf(parse(asset.framework || ''));
  const tr = fw.transferability || {};
  const mr = fw.migration_rules || {};
  const ce = fw.core_engine || {};
  const cards = retention.cardsForAsset(asset);
  const aud = run.audience || {};
  const card = run.track_card_name
    ? loadTrackCards().find(c => c.name === run.track_card_name)
    : pickTrackCard(run.track, run.topic, asset);
  const structure = (fw.structure_pattern || []).map(s => '- ' + s.stage_id + ' ' + s.function + ':' + (s.purpose || '')).join('\n');
  const vars = {
    today: require('./pipeline').todayStr(),
    topic: run.topic,
    target_language: aud.target_language || '',
    target_country: aud.target_country || '',
    video_goal: aud.video_goal || '',
    target_audience: aud.target_audience || '(未填)',
    framework_name: fw.name || asset.id,
    core_engine: [ce.surface_promise_pattern, (ce.deep_emotional_promise || []).join('、')].filter(Boolean).join(';'),
    best_traits: list(tr.best_topic_traits),
    avoid_traits: list(tr.avoid_topic_traits),
    prerequisites: list(tr.prerequisites),
    risk_flags: list(tr.risk_flags),
    must_preserve: list(mr.must_preserve),
    title_contract: JSON.stringify(fw.title_hook_contract || {}),
    structure: structure || '(无)',
    source_conclusion: ((fw.story_engine || {}).belief_shift || {}).new_belief || '(未记录)',
    retention_map: retention.cardsSummary(cards) || '(资产缺少 timeline)',
    hook_contract: retention.hookContract(asset.timeline),
    retention_library: retention.librarySummary(4, 8),
    track_card: card ? card.text : '(没有匹配的赛道证据卡:事实按通用标准填写,来源、年份、地区缺一不可)',
    materials: require('./fitcheck').materialsFor(run), // v1.75:改过题目的,资料前注明是按原题目准备的
    voice: voice.voiceBrief(voice.voiceForRun(run)),
    craft_rules: require('./craft').craftBrief(run) || '(没有适用的写法规则)',
    thesis_research: require('./thesis').researchText(run.thesis_scout) // v1.77
  };
  return { vars, card };
}

function fillVars(tpl, vars) {
  for (const k of Object.keys(vars)) tpl = tpl.replaceAll('{{' + k + '}}', vars[k] == null ? '' : String(vars[k]));
  return tpl;
}

function buildAnalysisPrompt(run, asset) {
  const { vars, card } = frameworkVars(run, asset);
  const keep = keepNotesText(run, 'analysis');
  // v1.74:按功能重排时「第 1 步 适配判定」换成新标准(严格照原片时原样)
  // v1.83:经济拆账另加账本规则(税前、论点要账本撑得住、账本行数上限);其他赛道提示词不变
  const econ = ledgerSayOn(run) ? '\n\n' + ECON_ANALYSIS_NOTE : '';
  return { prompt: fillVars(require('./fitrule').analysisPrompt(readPrompt('analysis.md')), vars) + econ + (keep ? '\n\n' + keep : ''), track_card_name: card ? card.name : null };
}

const ECON_ANALYSIS_NOTE = '【经济拆账账本补充规则(本题适用;和上面第 4 步说法冲突时以这里为准)】\n' +
  '- 税:账本默认只算到「税前」,不放增值税、所得税的行,利润行 item 写「세전」;稿子里一句「세금은 따로예요」带过。只有事实表里有税率和计税方法的出处时才细算,而且要按规则:卖价含增值税,销项税 = 含税营业额 × 10/110(不是 × 10%);增值税 = 销项 - 进项(能抵扣的进货、平台手续费 × 10/110);所得税按利润算,不按营业额。拿不准的一律只算到税前。\n' +
  '- 论点要账本撑得住:定论点时先想好用账本哪几行证明。要靠季节对比、「一年下来」才成立的论点,账本里必须能算出全年合计(旺季、淡季各几个月 × 每月结余);算不出来就换一个一张月账就能证明的角度(哪一项成本吃掉了钱、谁拿走了钱、保本线在哪)。\n' +
  '- 「如果……会怎样」的推算和全年合计可以先不写进账本:写前分析之后程序会单独补这些行并按公式算数,再核对论点和账本对不对得上。这里的账本最多 30 行,只放原始数和一张月账,不要写长。';

// 都套不上、人选了「不改,继续写」(v1.71):框架里写不成立的段落和换法,写前分析、蓝图、写稿、复审都带上
// 只在 run.keep_notes 存在时出现,其他任务的提示词一字不变
function keepNotesText(run, mode) {
  const k = run && run.keep_notes;
  if (!k || !Array.isArray(k.segments) || !k.segments.length) {
    // v1.76:框架在建任务时已定,写前分析不判换框架
    if (run && run.no_reframe && mode === 'analysis') return '【框架已在建任务时选定,不换框架】不要判「换框架」。有写不成立的段落,结论按「调整后可写」处理,这几段在 adjustments 里记成「换内容保功能」,用本题真实存在的事实换个讲法完成同一个留存动作;不能为了对上框架硬编一个题目里不存在的东西。';
    return '';
  }
  const lines = k.segments.map(x => '- ' + [x.segment, x.why].filter(Boolean).join(':') + (x.how ? '。换法:' + x.how : ''));
  const head = mode === 'analysis'
    ? '【人已决定:不改题目,仍用这个框架写】下面这几段在本题写不成立。不要因为它们判「换框架」:结论按「调整后可写」处理,这几段在 adjustments 里记成「换内容保功能」,用本题真实存在的事实换个讲法完成同一个留存动作;不能为了对上框架硬编一个题目里不存在的东西。'
    : '【写不成立的段落(人选了「不改题目,仍按这个框架写」)】这几段照原片写会硬编。写的时候换个讲法,如实说明;审稿和复审时逐条检查这几段有没有硬编出题目里不存在的东西(制度、身份、等级、事件),有就算问题。';
  return head + (k.summary ? '\n为什么写不成立:' + k.summary : '') + '\n' + lines.join('\n');
}

// 写进 step1–4 的 {{analysis}}:只放写稿需要的部分(论点、标题、事实、取舍、留存地图、钩子)
// run 给了就在末尾加上按本篇赛道、语言筛好的【写法规则】(trackKey:终审用自己选的赛道)
// 钩子类型(写法规则 R1):写前分析给每段标一种
const HOOK_TYPES = ['问题清单', '分段答案', '揭秘预告', '反转', '延迟兑现', '预警', '回扣', '观众自测', '反方', '异常'];
const HOOK_PLAN_AT = { background: '开头之后的背景段', midpoint: '中点(40%–65%)', final15: '最后 15%' };
function hookType(t) {
  const s = String(t || '').replace(/[①-⑩\d.、\s]/g, '');
  return HOOK_TYPES.find(h => s.includes(h)) || s;
}
// 写进写前分析摘要(蓝图、写稿、审稿、复审都读它):对照表 + 叙事方式 + 等级
const POV_RULES = {
  climb: '同一个人往上爬:全片是同一个「你」。每一级开头交代你是怎么从上一级上来的(钱从哪来、身份怎么变、靠什么机会),写清这时你大概几岁、手里有什么;上一章刚说做不到的事,下一章不能直接写成已经做到。',
  per_level: '每一级换一个人:每一级都是重新开始。每章开头明说「这次你生在…/如果你是…」,不能写成接着上一章的经历(不能出现上一章说不可能、这一章已经做到却不交代的情况),也不要交代怎么从上一级爬上来。',
  none: ''
};
function sourceMappingBrief(a) {
  const sm = a && a.source_mapping;
  if (!sm) return '';
  const out = [];
  const mode = sm.pov_mode;
  if (mode && mode !== 'none') {
    out.push('叙事方式(按原片判断' + (sm.pov_mode_by === 'user' ? ',人确认过' : '') + ',不许改成另一种,也不许两种混写):' + POV_RULES[mode] + (sm.pov_basis ? '(依据:' + sm.pov_basis + ')' : '') +
      '\n不管哪种:每一章都要有第二人称「你」(韩文 당신),不能写到后半篇变成第三人称讲解;等级从第 1 级连续编号,不跳号,讲案例、讲分岔的章不占等级号;每一级都必须是标题里的主角在本题设定下有可能做到的。');
    const lv = (Array.isArray(sm.levels) ? sm.levels : []).filter(l => l && l.local);
    if (lv.length) out.push('等级(按原片顺序;本题用右边的说法):\n' + lv.map(l => '- 第 ' + l.n + ' 级:' + (l.source ? l.source + ' → ' : '') + l.local + (l.reachable === false ? '(主角做不到' + (l.why ? ':' + l.why : '') + ';这一级要换成主角做得到的,或者删掉、改成旁观视角)' : '')).join('\n'));
  }
  const items = (Array.isArray(sm.items) ? sm.items : []).filter(x => x && x.source);
  if (!sm.same_context && items.length) out.push('原片 → 本地对照表(原片的头衔、建筑、器物、制度、文化梗只属于原片那个国家和时代,蓝图和稿子里一律用右边的本地说法,写「删掉」的不写;不许照抄原片说法,也不许直译——程序会按「不许出现」里的词扫描,出现就挡发布):\n' +
    items.map(x => '- ' + x.source + (x.kind ? '(' + x.kind + ')' : '') + ' → ' + (x.local || '删掉') + (x.residue && x.residue.length ? ';不许出现:' + x.residue.join('、') : '')).join('\n') +
    ((sm.extra_residue || []).length ? '\n- 其他不许照抄的原片说法:' + sm.extra_residue.join('、') : ''));
  return out.join('\n\n');
}
// mode='review':审稿、复审、补改用,写法规则只作参考,不按它扣分、不列为问题(不因此多出自动补改)
const PICKED_RULE = '论点是人亲自选的(选的时候已经联网核对过资料,确认站得住):写稿、改稿、终审都不能换论点的意思,结尾落点照它。核验或账本里有和论点对不上的数时,用这几种办法让论点站住:' +
  '① 换成核验过的正确数字,论点照说;② 把范围缩小到证据支持的那部分(哪类人、哪段时间、哪种店),意思不变;③ 把相反的事实正面讲出来,再讲为什么论点仍然成立;④ 事实表里还有没用上、支持论点的事实,换上去。' +
  '这几种都做不到时也不改论点,在问题清单里单独写一条「论点撑不住:哪条事实、为什么」给人看。';
function analysisBrief(a, run, trackKey, mode) {
  if (!a) return '(无写前分析,按原流程执行)';
  const out = [];
  const t = a.title || {};
  out.push('标题:' + (t.final_title || '') + (t.viewer_question ? '(观众想知道:' + t.viewer_question + ';期待方向:' + (t.expected_answer_direction || '') + ')' : ''));
  const pr = a.protagonist || {};
  if (String(pr.who || '').trim()) out.push('主角设定(全稿必须一致;原片主角的身份、性别、亲属称呼、年代一律不许沿用):' + [pr.who, pr.gender, pr.era, pr.place].filter(Boolean).join(' / ') + (pr.mapping ? '。原片→本题:' + pr.mapping : ''));
  const smText = sourceMappingBrief(a);
  if (smText) out.push(smText);
  const keepText = keepNotesText(run, 'brief');
  if (keepText) out.push(keepText);
  const th = a.thesis_card || {};
  out.push('论点卡:原有认知=' + (th.viewer_belief || '') + ';真相=' + (th.truth || '') + ';一句话论点=' + (th.one_line_thesis || '') + ';结尾落点=' + (th.ending_landing || '')
    + (th.contrast ? ';反差=' + th.contrast : '') + (th.double_standard && !/^无$/.test(String(th.double_standard).trim()) ? ';同事不同命=' + th.double_standard : '') + (th.boundary ? ';不适用于=' + th.boundary : ''));
  // v1.92:论点是人亲自选的(选的时候联网核对过):写稿、改稿、终审都不换论点的意思,对不上的数用办法让它站住
  if (run && run.thesis_scout && run.thesis_scout.user_pick) out.push(PICKED_RULE);
  // v1.89:人选论点时看到的大纲,蓝图和写稿照它排
  const tsOut = run && mode !== 'review' ? require('./thesis').chosenOutline(run.thesis_scout) : [];
  if (tsOut.length) out.push('人选论点时看到的「整篇大概会这样讲」(蓝图按这个顺序和内容排章;哪一章实在要不一样,在蓝图的 outline_diff 里写明哪里不一样、为什么):\n' + require('./thesis').outlineText(tsOut));
  const twText = run ? require('./twist').briefText(run) : ''; // v1.84:建任务时核对过的能证明反转的角度
  if (twText) out.push(twText);
  out.push('事实表(只能用这些;[估算] 的数不用逐个声明,全片在开始算账时说一次「下面按公开数据估算」即可;[假设] 的在用到时说一次「假设」;[待查] 的数不要写成确定的事实;[网友说法] 是论坛、博客、评论里网友的经历和原话,可以当感受、故事讲,第一次出现带半句说明这是听来的说法(网友评论、听人说、看过这样一种说法都行,说法不固定),不能当确定的官方数据或统计、不能进账本、不能当证明论点的主证据):\n' + (a.facts || []).map(f => '- ' + f.id + ' [' + (f.kind || '') + '] ' + (f.content || '') + '(' + [f.source, f.year, f.region].filter(Boolean).join(',') + ')' + (f.method ? ' 算法:' + f.method : '')).join('\n'));
  const stale = a.stale || {};
  const staleTag = (arr, key) => (Array.isArray(arr) && arr.includes(key) ? '(依据的事实已更新,这一行的数作废,按事实表重算)' : '');
  if ((a.ledger || []).length) {
    verifyLedger(a.ledger);
    // 账本锁数(实测 run_ee2e6bd16c05:写稿自己加了账本没有的「인심·양념 480만」,영업이익写成 9,641만/9,278만,账本是 9,703만;
    // 每次改稿只改一两章,同一个量在稿子里同时有三个数,论点核对每轮都报账对不上)
    const econOn = ledgerSayOn(run, trackKey);
    const econMark = l => (econOn ? require('./econledger').markLedger(l).trim() : '');
    out.push('账本(程序已按公式重算;标「程序重算」的以程序的数为准)。金额锁定:稿子里的收入、成本、利润、时薪、倍数、回本时间,只能用这张账本里的数(或事实表里的数),照抄后面「稿中写」的写法,可以四舍五入但不许重算出别的数;同一个量全文只能有一个数值。账本里有的量(总收入、总成本、利润、时薪等),事实表里估算出来的合计和账本不一样时,一律用账本的(实测事实表 F18 估算利润 9,641만、账本 9,703만,稿子两个都用了)。账本里没有的项目(比如想多算一项调味料成本),不许自己加进合计重新算,只能不提或只做定性说明:\n' + a.ledger.map(l => '- ' + (l.id ? l.id + ' ' : '') + econMark(l) + (econMark(l) ? ' ' : '') + l.item + ' = ' + (l.value || ((l.amount != null ? l.amount : '') + (l.unit ? ' ' + l.unit : ''))) +
      (l.formula ? ' [= ' + l.formula + ']' : '') + (l.mismatch ? '(程序重算:' + l.program_amount + (l.unit ? ' ' + l.unit : '') + ',原来写错了)' : '') + krLedgerForm(l) +
      (l.fact_ids && l.fact_ids.length ? '(' + l.fact_ids.join(',') + ')' : '') + staleTag(stale.ledger, l.item) +
      (l.bad ? '(这一行有问题,稿子里不要用这个数:' + l.bad + ')' : '')).join('\n'));
    const sayText = ledgerSayOn(run, trackKey) ? ledgerSayText(ledgerSay(a.ledger), mode !== 'review') : '';
    if (sayText) out.push(sayText);
    if (econOn) out.push(require('./econledger').briefText(a)); // v1.83:「如果」推算、全年合计、税前、百分比
    // 账本假设和报道值不一样的行(v1.61):第一次出现时说一句是假设、比报道高/低多少,点到为止
    const devs = ledgerDeviations(a);
    if (devs.length) out.push('账本假设和报道值不一样的行(这个数在稿子里第一次出现时,用一句话说明这是假设、比报道的数高还是低,例如「보도된 평균은 하루 3만 원대지만, 오늘은 목 좋은 가게 기준으로 6만 원으로 잡아볼게요」;只在第一次出现时说一次,后面照账本的数讲,不加「정확하지 않을 수 있습니다」这类免责句):\n' + devs.map(l => {
      const fc = l.fact_check;
      const alt = l.alt && Array.isArray(l.alt.rows) && l.alt.rows.length ? ';人选了「两种都算、对照着讲」:讲到这个数时把两种算法对照讲一次——按报道值算,' + l.alt.rows.slice(0, 6).map(r => r.id + ' ' + r.item + ' 是 ' + r.reported_text + '(按假设值是 ' + r.assumed_text + ')').join(',') + ';之后照账本(假设值)讲' : '';
      return '- ' + l.id + ' ' + (l.item || '') + ':账本取 ' + fc.value_text + ',报道值约 ' + fc.fact_text + '(' + fc.fact_ids.join(',') + (fc.basis ? ';' + fc.basis : '') + '),' + devPct(fc) + (String(l.deviation_reason || '').trim() ? ';取这个数的理由:' + l.deviation_reason : '') + alt;
    }).join('\n'));
  }
  const cs = (Array.isArray(a.cases) ? a.cases : []).filter(c => c && String(c.nick || c.who || '').trim());
  if (cs.length) out.push(casesBrief(cs));
  const tc = a.thesis_check || {};
  if (Array.isArray(tc.contradicts) && tc.contradicts.length) out.push('反转验证:事实 ' + tc.contradicts.join('、') + ' 和反转结论相反(' + (tc.note || '') + ')。写稿时反转的说法必须和这些事实一致,不能回避。');
  out.push('模块取舍(「保留」只保留功能和节奏,内容用本题事实):\n' + (a.modules || []).map(m => '- ' + m.segment + ' ' + m.decision + (m.hook_type && !/删除/.test(m.decision || '') ? '[钩子:' + hookType(m.hook_type) + ']' : '') + ':' + (m.reason || '') + (m.fact_ids && m.fact_ids.length ? '(' + m.fact_ids.join(',') + ')' : '') + staleTag(stale.modules, m.segment)).join('\n'));
  out.push('留存地图:\n' + (a.retention_map || []).map(r => '- ' + r.source_peak + '(' + (r.source_segment || '') + ')→' + (r.new_chapter_hint || '') + ' ' + r.status + (r.fact_ids && r.fact_ids.length ? '(' + r.fact_ids.join(',') + ')' : '')).join('\n'));
  const h = a.hook || {};
  const chosen = (h.candidates || [])[h.chosen || 0];
  if (chosen) out.push('钩子(已选定):' + chosen.text + '(事实 ' + (chosen.fact_ids || []).join(',') + ';第一个甜头 ' + chosen.first_payoff_sec + ' 秒)');
  // 钩子布局(写法规则 R5、R6、R8):观众最容易走神的三个位置
  const hp = a.hook_plan || {};
  const hpl = Object.keys(HOOK_PLAN_AT).filter(k => hp[k] && (hp[k].hook_type || hp[k].how)).map(k => '- ' + HOOK_PLAN_AT[k] + (hp[k].segment ? '(' + hp[k].segment + ')' : '') + ':' + hookType(hp[k].hook_type) + (hp[k].how ? ',' + hp[k].how : ''));
  if (hpl.length) out.push('钩子布局(这三处观众最容易走神,写稿时按这里放钩子):\n' + hpl.join('\n'));
  // 埋点回收、核心两难、评论问题(写法规则 C1、D1、D2):写稿照着埋、照着收、结尾照着问
  const pp = a.planted_payoff || {};
  if (String(pp.what || '').trim()) out.push('埋点与回收:' + pp.what + '(' + [pp.plant_at && '在 ' + pp.plant_at + ' 埋', pp.payoff_at && '在 ' + pp.payoff_at + ' 回收'].filter(Boolean).join(',') + ');埋的时候明说「后面会回来」,回收时点明。');
  if (String(a.core_dilemma || '').trim()) out.push('核心两难:' + a.core_dilemma);
  if (String(a.comment_question || '').trim()) out.push('结尾评论问题(可选,只问这一个,一句话能答;正文中间的反问不超过两次):' + a.comment_question);
  if (run) { const cb = require('./craft').craftBrief(run, trackKey, mode); if (cb) out.push(cb); }
  return out.join('\n\n');
}

// 账本里的金额写成韩文口播写法(9,703만 원、1억 8,720만 원),写稿和改稿照抄,同一个量不会写出好几个数
function krMoney(n) {
  n = Math.round(Number(n));
  if (!isFinite(n)) return '';
  const a = Math.abs(n), sign = n < 0 ? '-' : '';
  if (a >= 1e8) { const eok = Math.floor(a / 1e8), man = Math.round((a % 1e8) / 1e4); return sign + eok + '억' + (man ? ' ' + man.toLocaleString('en-US') + '만' : '') + ' 원'; }
  if (a >= 1e4) { const man = Math.floor(a / 1e4), rest = Math.round(a % 1e4); return sign + man.toLocaleString('en-US') + '만' + (rest ? ' ' + rest.toLocaleString('en-US') : '') + ' 원'; }
  return sign + a.toLocaleString('en-US') + ' 원';
}
function krLedgerForm(l) {
  // 单位写了但不是钱(%、个、倍)的不给;单位写「韩元」「万韩元」的也给(原来只认「원」,账本里大半行单位是「韩元」,一直没有口播写法)
  if (l.unit && !MONEY_RE.test(String(l.unit))) return '';
  if (!MONEY_RE.test([l.unit, l.value, l.item].join(' '))) return '';
  const n = (l.program_amount != null ? l.program_amount : Number(String(l.amount == null ? '' : l.amount).replace(/,/g, ''))) * moneyScale(l.unit);
  return isFinite(n) && Math.abs(n) >= 100 ? '(稿中写:' + krMoney(n) + ')' : '';
}

// 账本念法(学 Mr. Finance 的念账:一家店,从收入开始一项一项减,每减一项说一次还剩多少;大数换成每天)。
// 「还剩多少」「每天多少」都由程序按账本算好,写稿照念,不让写手自己加减(实测写手自己凑合计、自己加成本项,论点核对每轮报账对不上)。
// 只认公式是「某行 - 某行 - …」的行;被减的行如果本身是「加起来」的合计,拆成明细。单位都是钱且一致才出瀑布。
const MONEY_RE = /KRW|원|won|₩|韩元|韓元/i;
const VOLUME_RE = /^(个|개|份|그릇|줄|杯|잔|건|单|명|人|位|台|대|장|张|件|碗|봉지|판|마리|只)/;
// 单位写成「万韩元」「만원」的,amount 要乘回去再写成口播(实测 run_eadb 账本 amount 3000、unit 万韩元,原来会写成 3,000 원)
function moneyScale(unit) {
  const u = String(unit || '').split('/')[0];
  return /亿|억/.test(u) ? 1e8 : /万|萬|만/.test(u) ? 1e4 : /千|천/.test(u) ? 1e3 : 1;
}
// 这一行是每月、每年还是每天的量:先看单位斜杠后面,没有再看项目名里先出现的那个
function periodOf(l) {
  const u = String((l && l.unit) || '').split('/').slice(1).join('/');
  if (u) return /月|월|month/i.test(u) ? 'month' : /年|년|연|year/i.test(u) ? 'year' : /日|일|天|day/i.test(u) ? 'day' : 'unit';
  const t = String((l && l.item) || '');
  const im = t.search(/月|월|한 ?달|monthly/i), iy = t.search(/年|연간|년간|annual|yearly/i);
  if (im < 0 && iy < 0) return '';
  return iy < 0 || (im >= 0 && im < iy) ? 'month' : 'year';
}
const KEY_RE = /收入|营收|營收|营业额|销售额|매출|수입|利润|盈利|이익|순익|수익|到手|结余|結餘|亏损|적자|손익|保本|profit|revenue|income/i;
// 只看括号前的项目名(实测「월 식재료 원가 (매출의 34%)」括号里的「매출」让成本行也被换成每天)
const headOf = t => String(t || '').split(/[(（]/)[0];
// 只给「经济拆账」(账本赛道)用:历史、POV 这些赛道的账本只是背景,不需要一项一项念账(用户 2026-10-31)
function ledgerSayOn(run, trackKey) {
  if (!run) return false;
  return (trackKey || require('./craft').trackOf(run)) === 'econ';
}
function ledgerSay(ledger, valIn) {
  const rows = (Array.isArray(ledger) ? ledger : []).filter(l => l && typeof l === 'object');
  const byId = {}, val = valIn || {};
  rows.forEach((l, i) => {
    const id = String(l.id || ('L' + (i + 1)));
    byId[id] = l;
    if (!(id in val)) { const n = l.program_amount != null ? Number(l.program_amount) : Number(String(l.amount == null ? '' : l.amount).replace(/,/g, '')); val[id] = n * (MONEY_RE.test(String(l.unit || '')) ? moneyScale(l.unit) : 1); }
  });
  const unitKey = l => String((l && l.unit) || '').replace(/\s+/g, '');
  const isMoney = l => l && MONEY_RE.test(unitKey(l));
  const f = id => String((byId[id] || {}).formula || '').replace(/\s+/g, '');
  const sumParts = id => { const m = f(id).replace(/^\((.*)\)$/, '$1'); return /^L\d+[a-z]?(\+L\d+[a-z]?)+$/i.test(m) ? m.split('+') : null; };
  const expand = (id, depth) => { const p = depth < 3 ? sumParts(id) : null; return p ? p.flatMap(x => expand(x, depth + 1)) : [id]; };
  // 公式「A - B - (C+D)」:返回 { first: A, minus: [B, C, D] };不是这种形状返回 null
  const subParts = id => {
    let s = f(id);
    if (!s || !/^[L\da-z+\-()]+$/i.test(s)) return null;
    const terms = []; let depth = 0, cur = '', sign = '+';
    for (const ch of s) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if ((ch === '-' || ch === '+') && depth === 0) { if (cur) terms.push([sign, cur]); sign = ch; cur = ''; continue; }
      cur += ch;
    }
    if (cur) terms.push([sign, cur]);
    if (terms.length < 2 || terms[0][0] !== '+' || terms.slice(1).some(t => t[0] !== '-')) return null;
    const one = t => t.replace(/^\((.*)\)$/, '$1');
    if (!/^L\d+[a-z]?$/i.test(one(terms[0][1]))) return null;
    const minus = [];
    for (const [, t] of terms.slice(1)) {
      const x = one(t);
      if (/^L\d+[a-z]?$/i.test(x)) minus.push(x);
      else if (/^L\d+[a-z]?(\+L\d+[a-z]?)+$/i.test(x)) minus.push(...x.split('+'));
      else return null;
    }
    return { first: one(terms[0][1]), minus };
  };
  const build = (id, depth) => {
    const p = depth < 4 ? subParts(id) : null;
    if (!p) return { top: id, steps: [] };
    const base = build(p.first, depth + 1);
    p.minus.flatMap(x => expand(x, 0)).forEach(x => base.steps.push(x));
    return base;
  };
  const r0 = n => Math.round(n);
  const pctOf = (x, top) => { const p = x / top * 100; return Math.abs(p) >= 10 ? Math.round(p) : Math.round(p * 10) / 10; };
  const cand = [];
  rows.forEach((l, i) => {
    const id = String(l.id || ('L' + (i + 1)));
    if (!subParts(id)) return;
    const w = build(id, 0);
    const ids = [w.top, ...w.steps, id];
    if (!ids.every(x => byId[x] && isMoney(byId[x]) && isFinite(val[x]))) return;
    const u = unitKey(byId[id]);
    if (ids.some(x => unitKey(byId[x]) !== u)) return;
    // 被减的行本身是「A - B」算出来的结果(比如拿利润减利润算差多少),不是一笔成本,不念成瀑布
    if (w.steps.some(x => subParts(x))) return;
    const steps = w.steps.filter(x => val[x]);
    const top = val[w.top];
    if (steps.length < 2 || !top) return;
    let left = top;
    const out = { id, item: l.item || '', unit: l.unit || '', top: { id: w.top, item: byId[w.top].item || '', amount: r0(top) }, steps: [], end: r0(val[id]) };
    steps.forEach(x => { left -= val[x]; out.steps.push({ id: x, item: byId[x].item || '', amount: r0(val[x]), pct: pctOf(val[x], top), left: r0(left) }); });
    out.end_pct = pctOf(val[id], top);
    cand.push(out);
  });
  // 被别的瀑布当成中间一步(作为起点或被拆进去)的不单独列;步数多的在前,最多 3 张
  const used = new Set();
  cand.forEach(w => { cand.forEach(o => { if (o !== w && (o.top.id === w.id || o.steps.some(s => s.id === w.id))) used.add(w.id); }); });
  // 同一个起点、减的项目是另一张的子集(那张多减一项老板人工),只留多的那张,少的那张的结果就是它中间的「还剩」
  cand.forEach(w => cand.forEach(o => { if (o !== w && o.top.id === w.top.id && o.steps.length > w.steps.length && w.steps.every(s => o.steps.some(t => t.id === s.id))) used.add(w.id); }));
  const waterfalls = cand.filter(w => !used.has(w.id)).sort((a, b) => b.steps.length - a.steps.length).slice(0, 3);
  // 每天换算:按月的收入、利润、到手 ÷ 每月营业天数;按年的 ÷ 12 换成每月;按月的销量 ÷ 营业天数。
  // 营业天数先看账本自己写的(公式里「×26」、项目名里「26일 영업」),没有才按 30 天(实测김밥집账本按 26 天算月营收,÷30 会和它的「하루 매출」对不上)
  let days = 30;
  for (const l of rows) {
    const m = String(l.formula || '').match(/\*\s*(2[0-9]|3[01])(?![\d.])/) || String(l.item || '').match(/(2[0-9]|3[01])\s*(?:일|天|日)/);
    if (m) { days = Number(m[1]); break; }
  }
  const daily = [];
  rows.forEach((l, i) => {
    const id = String(l.id || ('L' + (i + 1)));
    const n = val[id];
    if (!isFinite(n) || !n) return;
    const per = periodOf(l);
    const money = isMoney(l), vol = VOLUME_RE.test(unitKey(l));
    if (money && KEY_RE.test(headOf(l.item)) && per === 'year') daily.push({ id, item: l.item || '', amount: r0(n), per: '月', value: r0(n / 12), money: true });
    else if (money && KEY_RE.test(headOf(l.item)) && per === 'month') daily.push({ id, item: l.item || '', amount: r0(n), per: '天', value: r0(n / days), money: true });
    else if (vol && per === 'month') daily.push({ id, item: l.item || '', amount: r0(n), per: '天', value: Math.ceil(n / days), money: false, unit: unitKey(l).replace(/\/.*$/, '') });
  });
  return { waterfalls, daily: daily.slice(0, 6), days };
}
// 账本念法里程序算出来的数(还剩多少、每天多少):账外的数扫描要认它们
function ledgerSayAmounts(say) {
  const out = [];
  (say.waterfalls || []).forEach(w => w.steps.forEach(s => out.push(Math.abs(s.left), Math.abs(sayRound(s.left)))));
  (say.daily || []).forEach(d => out.push(Math.abs(d.value), Math.abs(sayRound(d.value))));
  return out.filter(n => n);
}
// 念出来的数四舍五入(Mr. Finance 也只说「대략 1.6만 달러」):100만 以上到「만」,10만 以上到「천」,1만 以上到「백」;账外的数扫描的容差本来就是 5,000 원
function sayRound(n) { const a = Math.abs(n); return a >= 1e6 ? Math.round(n / 1e4) * 1e4 : a >= 1e5 ? Math.round(n / 1e3) * 1e3 : a >= 1e4 ? Math.round(n / 100) * 100 : Math.round(n); }
function sayAmt(n, money, unit) { return money ? krMoney(sayRound(n)) : n.toLocaleString('en-US') + (unit || ''); }
function ledgerSayText(say, withHints) {
  const lines = [];
  (say.waterfalls || []).forEach(w => {
    lines.push('- 从' + w.top.item + '减到' + w.item + ':');
    const m = n => sayAmt(n, true);
    lines.push('  ' + w.top.id + ' ' + w.top.item + ' ' + m(w.top.amount));
    w.steps.forEach(s => lines.push('  − ' + s.id + ' ' + s.item + ' ' + m(s.amount) + '(占 ' + s.pct + '%)→ 还剩 ' + m(s.left)));
    lines.push('  = ' + w.id + ' ' + w.item + ' ' + m(w.end) + '(占 ' + w.end_pct + '%)');
  });
  if ((say.daily || []).length) {
    lines.push('- 换成每天/每月(一个月按 ' + (say.days || 30) + ' 天营业算):');
    say.daily.forEach(d => lines.push('  ' + d.id + ' ' + d.item + ' ' + sayAmt(d.amount, d.money, d.unit) + ' → 每' + d.per + '约 ' + sayAmt(d.value, d.money, d.unit)));
  }
  if (!lines.length) return '';
  const head = '账本念法(程序按账本算好的,已四舍五入成好念的数,念账时照这个顺序一项一项减,每减一项说一次「还剩多少」;这里的「还剩」「每天」也是账本里的数,可以直接用,不许自己另算):';
  const hints = withHints ? '\n念账写法:\n- 全片只用这一家店的账,前 2 分钟内说出它一天或一个月卖多少。\n- 说比例时紧接着换成这家店的钱(「매출의 30%, 우리 가게로 치면 1,200원」),比例和钱只各说一次。\n- 一句只放一个新数,数后面接一句它意味着什么(「그러니까…」「다시 말해…」)。\n- 大数换成每天、每份(「하루에 X개는 팔아야 본전」)更好记。\n- 老板自己干活的,老板工资和真正的利润分开说。' : '';
  return head + '\n' + lines.join('\n') + hints;
}

// 账本由程序核算:有 formula 的行按引用的行重算,和模型写的 amount 差超过 1% 记为对不上,写稿以程序算的数为准。
// 按出现顺序算,引用的行要先算好(引用后面的行、或者公式里有别的字符,记为算不了)。返回 { rows, mismatches, errors }
function verifyLedger(ledger) {
  const rows = (Array.isArray(ledger) ? ledger : []).filter(l => l && typeof l === 'object');
  const val = {};
  const mismatches = [], errors = [];
  rows.forEach((l, i) => {
    const id = String(l.id || ('L' + (i + 1)));
    const amount = Number(String(l.amount == null ? '' : l.amount).replace(/,/g, ''));
    const f = String(l.formula || '').trim();
    delete l.program_amount; delete l.mismatch;
    if (f) {
      const expr = f.replace(/L\d+[a-z]?(?![a-z\d])/gi, ref => (ref in val ? '(' + val[ref] + ')' : 'NaN'));
      let calc = NaN;
      if (/^[\d.\s+\-*/()NaN]+$/.test(expr)) { try { calc = Function('"use strict";return (' + expr + ')')(); } catch (e) { calc = NaN; } }
      if (!isFinite(calc)) { errors.push(id + ' 的公式算不了:' + f); val[id] = isFinite(amount) ? amount : NaN; return; }
      calc = Math.round(calc * 100) / 100;
      l.program_amount = calc;
      if (!isFinite(amount) || Math.abs(calc - amount) > Math.max(1, Math.abs(calc) * 0.01)) {
        l.mismatch = true;
        mismatches.push(id + ' ' + (l.item || '') + ':写的是 ' + (isFinite(amount) ? amount : '(空)') + ',按 ' + f + ' 算是 ' + calc);
      }
      val[id] = calc;
    } else val[id] = isFinite(amount) ? amount : NaN;
  });
  return { rows: rows.length, mismatches, errors };
}

// ---------- 账本体检(写稿之前把账做对) ----------
// 实测(2026-10-31 统计已推的 21 本带公式的账本):10 本有算错的行,共 33 行;稿子照错账写,终审再改一个数牵出好几章,补改基本改不成。
// 所以在写稿之前:① 有公式的行一律改成程序按公式算的数(AI 只负责填原始数和写公式,合计、利润、保本这些由程序算);
// ② 公式算不了、加减时单位混用(月和天、万韩元和韩元)、改正幅度很大(多半是公式引用错了行)、没出处的原始数,交给 AI 只修账本一轮;
// ③ 还修不好的行标出来,写稿时不许用这个数(AI 改一轮,不行人看,用户 2026-10-31)。
const LEDGER_BIG_FIX = 0.1;
const ASSUME_RE = /假设|假定|가정|추정|估算|예시|assum/i;
function ledgerId(l, i) { return String(l.id || ('L' + (i + 1))); }
function ledgerValueText(l, n) {
  const u = String(l.unit || '');
  if (MONEY_RE.test(u) && Math.abs(n * moneyScale(u)) >= 100) return krMoney(n * moneyScale(u)) + (u.includes('/') ? ' /' + u.split('/').slice(1).join('/') : '');
  const r = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
  return r.toLocaleString('en-US') + (u ? ' ' + u : '');
}
// 有公式的行改成程序算的数(amount 和 value 都改,原来的记在 program_fixed),返回改了哪些
function ledgerWriteBack(a) {
  const rows = (a && Array.isArray(a.ledger) ? a.ledger : []).filter(l => l && typeof l === 'object');
  if (!rows.length) return [];
  verifyLedger(rows);
  const fixes = [];
  rows.forEach((l, i) => {
    if (!l.mismatch || !isFinite(Number(l.program_amount))) return;
    const to = Number(l.program_amount);
    const from = Number(String(l.amount == null ? '' : l.amount).replace(/,/g, ''));
    fixes.push({ id: ledgerId(l, i), item: l.item || '', from: isFinite(from) ? from : null, to, unit: l.unit || '', from_text: ledgerValueText(l, isFinite(from) ? from : 0), to_text: ledgerValueText(l, to) });
    l.program_fixed = { from: isFinite(from) ? from : null, value: l.value || '' };
    l.amount = Math.abs(to) >= 100 ? Math.round(to) : Math.round(to * 100) / 100;
    l.value = ledgerValueText(l, to);
  });
  verifyLedger(rows);
  // 原始数行 value 空着的(AI 补的成本行常这样),按 amount 填上
  rows.forEach(l => { const n = Number(String(l.amount == null ? '' : l.amount).replace(/,/g, '')); if (!l.formula && !String(l.value || '').trim() && String(l.amount == null ? '' : l.amount).trim() && isFinite(n)) l.value = ledgerValueText(l, n); });
  // 公式行的 value 只写了「계산」「计算」这类字、没有数的,填上程序算的数(页面和写稿都看得到具体数)
  rows.forEach(l => { if (l.formula && isFinite(Number(l.program_amount)) && !/\d/.test(String(l.value || ''))) l.value = ledgerValueText(l, Number(l.program_amount)); });
  return fixes;
}
// 程序查得出来的账本问题(不调 AI):[{ id, kind, text }]
function ledgerProblems(a, run, fixes) {
  const rows = (a && Array.isArray(a.ledger) ? a.ledger : []).filter(l => l && typeof l === 'object');
  if (!rows.length) return [];
  const out = [];
  const chk = verifyLedger(rows);
  chk.errors.forEach(e => { const id = String(e).split(' ')[0]; out.push({ id, kind: 'formula', text: e + '(只能用行编号、数字和 + - * / ( ),引用的行要排在前面)' }); });
  const byId = {};
  rows.forEach((l, i) => { byId[ledgerId(l, i)] = l; });
  const desc = l => { const u = String(l.unit || ''); const money = MONEY_RE.test(u); return { money, scale: money ? moneyScale(u) : 1, per: periodOf(l), pct: /%|비율|比率/.test(u) }; };
  rows.forEach((l, i) => {
    const id = ledgerId(l, i), f = String(l.formula || '').replace(/\s+/g, '');
    if (f && !/[*/]/.test(f)) {
      const refs = (f.match(/L\d+[a-z]?(?![a-z\d])/gi) || []).filter(r => byId[r]);
      const ds = [l, ...refs.map(r => byId[r])].map(desc);
      const known = ds.filter(d => d.money || d.pct);
      const diff = (k, label) => { const vs = [...new Set(known.map(d => d[k]).filter(Boolean))]; return vs.length > 1 ? label : ''; };
      const why = [known.some(d => d.money) && known.some(d => d.pct) ? '钱和百分比' : '', diff('scale', '万韩元和韩元'), diff('per', '每月、每天、每年这些不同周期的数')].filter(Boolean);
      if (why.length) out.push({ id, kind: 'unit', text: id + ' ' + (l.item || '') + ' 的公式 ' + f + ' 把' + why.join('、') + '直接加减了(单位:' + [l, ...refs.map(r => byId[r])].map(x => (x.id || '') + '=' + (x.unit || '无')).join(',') + ')' });
    }
    if (!f && MONEY_RE.test(String(l.unit || '')) && !(Array.isArray(l.fact_ids) && l.fact_ids.length) && !ASSUME_RE.test([l.item, l.value].join(' ')))
      out.push({ id, kind: 'nosource', text: id + ' ' + (l.item || '') + ' 是原始数,但没写来自哪条事实(fact_ids 为空),也没标「假设」' });
  });
  // 只报「源头」算错的行:引用的行本身也被改过的,是跟着上游变的,不单独报(实测一处加错牵出下面 6 行都差很多)
  const fixedIds = new Set((fixes || []).map(x => x.id));
  (fixes || []).forEach(x => {
    if (x.from == null || !x.to) return;
    if ((String((byId[x.id] || {}).formula || '').match(/L\d+[a-z]?(?![a-z\d])/gi) || []).some(r => fixedIds.has(r))) return;
    if (Math.abs(x.to - x.from) / Math.abs(x.to) > LEDGER_BIG_FIX) out.push({ id: x.id, kind: 'bigfix', text: x.id + ' ' + x.item + ':账本写的是 ' + x.from_text + ',按公式 ' + ((byId[x.id] || {}).formula || '') + ' 算是 ' + x.to_text + ',差得多,程序已经改成按公式算的数;如果其实是公式引用错了行,要改公式' });
  });
  if (ledgerSayOn(run) && !ledgerSay(rows).waterfalls.length) out.push({ id: '', kind: 'shape', text: '经济拆账题的账本里没有一行「利润 = 收入 - 成本1 - 成本2 …」(或「收入 - 成本合计」)的公式,程序排不出念账顺序' });
  // v1.83 税(只管经济拆账):没出处的税、增值税按营业额 ×10%、所得税按营业额算,都交给 AI 修账本;修不好程序去掉税、利润只算到税前
  if (ledgerSayOn(run)) out.push(...require('./econledger').taxProblems(a));
  return out;
}
// 账本「漏成本」(v1.60):合计/成本/保本行,模型写的数比按公式算的大很多 → 多半是公式里漏了成本项,不是写错了总数。
// 实测 run_a8886e8f0744:L9 총비용写 5,462만、各项加起来只有 3,234만,程序锁成 3,234만 → 利润 2,766만、4 个月回本,和论点相反。
// 这种行先不锁数,交给 AI 补上漏掉的成本(按面积的房租、够接待客流的人手、税…),补到对得上再锁
const LEDGER_GAP_RE = /비용|원가|코스트|成本|费用|支出|开支|손익분기|保本|盈亏/;
function ledgerGaps(a) {
  const rows = (a && Array.isArray(a.ledger) ? a.ledger : []).filter(l => l && typeof l === 'object');
  if (!rows.length) return [];
  verifyLedger(rows);
  const byId = {};
  rows.forEach((l, i) => { byId[ledgerId(l, i)] = l; });
  const written = l => (l.program_fixed && l.program_fixed.from != null ? Number(l.program_fixed.from) : Number(String(l.amount == null ? '' : l.amount).replace(/,/g, '')));
  const changed = l => !!(l && (l.mismatch || l.program_fixed));
  const out = [];
  rows.forEach((l, i) => {
    const id = ledgerId(l, i), f = String(l.formula || '').replace(/\s+/g, '');
    if (!f || !changed(l)) return;
    const to = Number(l.program_amount), from = written(l);
    if (!isFinite(to) || !isFinite(from) || !from) return;
    // 只报源头:引用的行自己也变过的,是跟着上游变的
    if ((f.match(/L\d+[a-z]?(?![a-z\d])/gi) || []).some(r => changed(byId[r]))) return;
    const sum = /\+/.test(f) && !/[*/]/.test(f);
    if (!sum && !LEDGER_GAP_RE.test(String(l.item || ''))) return;
    if (Math.abs(from) <= Math.abs(to) * (1 + LEDGER_BIG_FIX)) return;
    const ft = ledgerValueText(l, from), tt = ledgerValueText(l, to);
    out.push({ id, item: l.item || '', from, to, text: id + ' ' + (l.item || '') + ':你写的是 ' + ft + ',按公式 ' + f + ' 算只有 ' + tt + '。多半是漏了或低估了成本,不是总数写错了:对照题目(面积、座位、每天客流、营业时间)检查房租、人手(够不够接待当天的客流)、税、保险、折旧、设备维护、损耗;补上漏掉的成本行(事实表里有依据写 fact_ids,没有就在 item 里标「假设」并写清怎么估的),加进公式,直到按公式算出来和 ' + ft + ' 差不多。不要把 ' + id + ' 改小去迁就公式' });
  });
  return out;
}
// 合理性兜底(v1.60,只管经济拆账的餐饮题):经营利润率高于 25%、或回本短于 12 个月,多半是成本漏了,写稿前标出来重查
const FOOD_RE = /음식|식당|가게|카페|커피|치킨|분식|김밥|고기|짜장|중국집|요식|외식|레스토랑|베이커리|빵집|국밥|떡볶이|피자|술집|호프|주점|포차|테이블|메뉴|餐|饭|面馆|咖啡|奶茶|小吃|食堂/;
const SANE_MARGIN = 0.25, SANE_PAYBACK = 12;
function ledgerSanity(a, run) {
  const rows = (a && Array.isArray(a.ledger) ? a.ledger : []).filter(l => l && typeof l === 'object');
  if (!rows.length || !ledgerSayOn(run)) return [];
  if (!FOOD_RE.test([run && run.topic, ((a.title || {}).final_title) || ''].concat(rows.map(l => l.item || '')).join(' '))) return [];
  verifyLedger(rows);
  const val = l => (isFinite(Number(l.program_amount)) ? Number(l.program_amount) : Number(String(l.amount == null ? '' : l.amount).replace(/,/g, '')));
  const out = [];
  let best = null;
  ledgerSay(rows).waterfalls.forEach(w => { if (w.top && w.top.amount > 0 && isFinite(Number(w.end))) { const m = Number(w.end) / w.top.amount; if (!best || m > best.m) best = { m, w }; } });
  if (best && best.m > SANE_MARGIN) out.push({ id: best.w.id, kind: 'sanity', text: best.w.id + ' ' + (best.w.item || '') + ' 占收入 ' + Math.round(best.m * 100) + '%:餐饮店经营利润率一般在 5–15%,高于 ' + SANE_MARGIN * 100 + '% 多半是漏了成本。重查:房租和面积对不对得上、人手够不够接待每天的客流、有没有漏了税、保险、折旧、设备维护、食材损耗;漏了就补成本行。真的这么高,在 notes 里写依据' });
  let months = null;
  rows.filter(l => /회수|回本|回收|payback/i.test(String(l.item || '')) && /개월|月|month/i.test(String(l.unit || ''))).forEach(l => { const v = val(l); if (isFinite(v) && v > 0 && (months == null || v < months)) months = v; });
  if (months == null && best && /월|月/.test(String(best.w.unit || ''))) {
    const inv = rows.find(l => /투자|창업 ?비|창업 ?자금|초기 ?비용|开店|投资|启动资金/.test(String(l.item || '')) && MONEY_RE.test(String(l.unit || '')) && !String(l.unit || '').includes('/'));
    if (inv && Number(best.w.end) > 0) months = val(inv) * moneyScale(inv.unit) / Number(best.w.end);
  }
  if (months != null && months > 0 && months < SANE_PAYBACK) out.push({ id: '', kind: 'sanity', text: '按账本 ' + (Math.round(months * 10) / 10) + ' 个月就回本:餐饮店一般要 2–4 年,短于 ' + SANE_PAYBACK + ' 个月多半是利润算高了(漏了成本)或投资算少了。重查成本和开店投资;真的这么快,在 notes 里写依据' });
  return out;
}
// 给 AI 修账本看的账本:漏成本的行(和跟着它变的行)还原成模型原来写的数,让 AI 看到「写的数」和「公式」对不上的地方
function gapClosure(a, gapIds) {
  const rows = (a.ledger || []).filter(l => l && typeof l === 'object');
  const set = new Set(gapIds);
  rows.forEach((l, i) => { const f = String(l.formula || ''); if ((f.match(/L\d+[a-z]?(?![a-z\d])/gi) || []).some(r => set.has(r))) set.add(ledgerId(l, i)); });
  return set;
}
function ledgerForFix(a, gapIds) {
  const rows = (a.ledger || []).filter(l => l && typeof l === 'object');
  const set = gapClosure(a, gapIds);
  return rows.map((l, i) => {
    const { program_amount, mismatch, program_fixed, bad, ...rest } = l;
    if (set.has(ledgerId(l, i)) && program_fixed && program_fixed.from != null) { rest.amount = program_fixed.from; rest.value = program_fixed.value || rest.value; }
    return rest;
  });
}
// 写稿前的账本体检:程序改正 → 有问题交给 AI 只修账本一轮 → 再改正 → 还有问题的行标「不许用」。会改 a.ledger,结果记在 a.ledger_checkup
async function ledgerCheckup(run, cfg, a, vars) {
  if (!a || !Array.isArray(a.ledger) || !a.ledger.length) return null;
  // v1.83:上一轮补的「如果」推算、全年合计行先拿掉(连同引用它们的行),体检完重新补,不会越补越长
  const econ = ledgerSayOn(run) ? require('./econledger') : null;
  if (econ) stripEconRows(a);
  // v1.83:没出处的税按规则直接去掉(默认只算到税前),不用 AI 修;有出处但算法错的交给 AI 修一轮
  const detaxed0 = econ ? econ.detax(a, econ.taxProblems(a).filter(p => p.unsourced).map(p => p.id)) : [];
  // 漏成本的行在程序锁数之前找(锁过的按 program_fixed 里原来写的数比)
  const gaps0 = ledgerGaps(a);
  const rec = { at: new Date().toISOString(), program_fixed: ledgerWriteBack(a), ...(detaxed0.length ? { detaxed: detaxed0 } : {}) };
  const gapIds = new Set(gaps0.map(g => g.id));
  if (gaps0.length) rec.gaps = gaps0.map(g => { const l = a.ledger.find((x, i) => x && ledgerId(x, i) === g.id) || {}; return { id: g.id, item: g.item, from_text: ledgerValueText(l, g.from), to_text: ledgerValueText(l, g.to) }; });
  const closure = gapClosure(a, [...gapIds]);
  const before = ledgerProblems(a, run, rec.program_fixed).filter(p => !(p.kind === 'bigfix' && gapIds.has(p.id)))
    .concat(gaps0.map(g => ({ id: g.id, kind: 'gap', text: g.text })), ledgerSanity(a, run));
  rec.problems = before.map(p => p.text);
  let after = before;
  const fixable = before.filter(p => p.kind !== 'shape' || ledgerSayOn(run));
  if (fixable.length && cfg) {
    try {
      const prompt = fillVars(readPrompt('ledger_fix.md'), {
        ...(vars || {}), topic: run.topic || '', title: ((a.title || {}).final_title) || run.topic || '',
        track_hint: ledgerSayOn(run) ? '这是经济拆账题(一家店的账),按下面「经济拆账账本的样子」整理。' : '这不是经济拆账题,账本只要算对、单位一致,不用套店铺的样子。',
        facts: (a.facts || []).map(f => '- ' + f.id + ' [' + (f.kind || '') + '] ' + (f.content || '')).join('\n') || '(无)',
        ledger_json: JSON.stringify(ledgerForFix(a, [...gapIds])),
        problems: fixable.map(p => '- ' + p.text).join('\n')
      });
      const n0 = a.ledger.length;
      const out = await callJson(run, cfg, prompt, 'AI 修账本', o => o && Array.isArray(o.ledger) && o.ledger.filter(l => l && typeof l === 'object').length >= Math.ceil(n0 / 2));
      a.ledger = out.ledger.filter(l => l && typeof l === 'object' && !Array.isArray(l));
      rec.ai = { ran: true, notes: String(out.notes || '').slice(0, 500), rows_before: n0, rows_after: a.ledger.length };
      // 漏成本的行(和跟着它变的行)交给 AI 补成本了,不算「程序改正」
      rec.program_fixed = rec.program_fixed.filter(x => !closure.has(x.id));
      const gaps1 = ledgerGaps(a);
      rec.ai_fixed = ledgerWriteBack(a);
      after = ledgerProblems(a, run, []).concat(gaps1.map(g => ({ id: g.id, kind: 'gap', text: g.text + '(AI 补了一轮还没对上,程序已按公式锁数,利润可能偏高,写稿前请人看一下)' })), ledgerSanity(a, run));
    } catch (e) { rec.ai = { ran: false, error: e.message }; }
  }
  // v1.83:税还是不对(没出处、按营业额扣):程序去掉税的行,利润只算到税前,稿子里一句「세금은 따로」带过
  if (econ && after.some(p => p.kind === 'tax')) {
    rec.detaxed = (rec.detaxed || []).concat(econ.detax(a, after.filter(p => p.kind === 'tax').map(p => p.id)));
    ledgerWriteBack(a);
    after = after.filter(p => p.kind !== 'tax');
  }
  // 还修不好的:公式算不了、单位混用的行,写稿时不许用它的数
  a.ledger.forEach(l => { if (l && typeof l === 'object' && !/税的行已删掉/.test(String(l.bad || ''))) delete l.bad; });
  after.filter(p => p.kind === 'formula' || p.kind === 'unit').forEach(p => { const l = a.ledger.find((x, i) => x && ledgerId(x, i) === p.id); if (l) l.bad = p.text; });
  rec.remaining = after.map(p => p.text);
  a.ledger_checkup = rec;
  // 关键假设和事实表报道的数对一对(软约束:可以不一样,差很多又没写理由的才停下让人选)
  if (cfg) rec.facts_compare = await ledgerFactCheck(run, cfg, a);
  // v1.83 经济拆账:补「如果」推算和全年合计(单独小调用,只输出新增的行),再核对论点和账本对不对得上,对不上换账本撑得住的角度
  if (econ && cfg) await econ.afterCheckup(run, cfg, a);
  a.ledger_check = verifyLedger(a.ledger);
  return rec;
}
// 拿掉上一轮补的经济拆账推算行(added_by=econ),以及公式引用它们的行
function stripEconRows(a) {
  const rows = (a && Array.isArray(a.ledger) ? a.ledger : []);
  const drop = new Set(rows.filter(l => l && l.added_by === 'econ').map((l, i) => String(l.id || '')));
  if (!drop.size) return 0;
  for (let k = 0; k < 4; k++) rows.forEach(l => { if (l && !drop.has(String(l.id || '')) && (String(l.formula || '').match(/L\d+[a-z]?(?![a-z\d])/gi) || []).some(r => drop.has(r))) drop.add(String(l.id || '')); });
  a.ledger = rows.filter(l => !(l && drop.has(String(l.id || ''))));
  return drop.size;
}

// ---------- 账本假设 vs 事实表(v1.61,软约束,用户 2026-11-01 明确不要「必须一致」) ----------
// 实测 run_902550ad6154:L3「기계 1대당 일평균 매출」按 40회 × 1,500원 = 6만 원/일,事实表 F03 报道的是每台每天约 3.3만 원(差 1.8 倍),
// 账本和稿子都没说为什么,后面利润、时薪全跟着偏高。现在:差 10% 以上的行,稿子里第一次出现时说一句「是假设、比报道高/低多少」;
// 差 1.5 倍以上又没写理由(deviation_reason)的,先写后改的任务停在分析后,让人选按报道值 / 按假设值 / 两种都算对照讲。
const DEV_NOTE = 1.1, DEV_HOLD = 1.5;
function ledgerNum(l) { return l.program_amount != null ? Number(l.program_amount) : Number(String(l.amount == null ? '' : l.amount).replace(/,/g, '')); }
function ledgerRows(a) { return (a && Array.isArray(a.ledger) ? a.ledger : []).filter(l => l && typeof l === 'object' && !Array.isArray(l)); }
const roundAmt = n => (Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100);
// 按现在的账本数重算每行和报道值差几倍
function devRefresh(a) {
  const rows = ledgerRows(a);
  verifyLedger(rows);
  rows.forEach(l => {
    const fc = l.fact_check;
    if (!fc || typeof fc !== 'object') return;
    const v = ledgerNum(l), f = Number(fc.fact_value);
    if (!(v > 0 && f > 0)) { fc.ratio = null; return; }
    fc.ratio = Math.round(Math.max(v, f) / Math.min(v, f) * 100) / 100;
    fc.dir = v > f ? 'higher' : v < f ? 'lower' : 'same';
    fc.value_text = ledgerValueText(l, v);
    fc.fact_text = ledgerValueText(l, f);
  });
}
function ledgerDeviations(a) {
  return ledgerRows(a).filter(l => l.fact_check && l.fact_check.ratio > DEV_NOTE && l.fact_check.dir !== 'same');
}
// 要人选的行:差 1.5 倍以上、没写理由、人还没选过。只报「源头」:公式引用的上游行已经要人选的,下游跟着变,不重复问
function ledgerPending(a) {
  const rows = ledgerRows(a);
  const byId = {};
  rows.forEach((l, i) => { byId[ledgerId(l, i)] = l; });
  const p0 = new Set(rows.filter(l => l.fact_check && l.fact_check.ratio > DEV_HOLD && !String(l.deviation_reason || '').trim() && !l.ledger_choice).map((l, i) => ledgerId(l, rows.indexOf(l))));
  const refs = l => (String(l.formula || '').match(/L\d+[a-z]?(?![a-z\d])/gi) || []).filter(r => byId[r]);
  const upstreamPending = (id, seen) => refs(byId[id]).some(r => !seen.has(r) && (seen.add(r), p0.has(r) || upstreamPending(r, seen)));
  return [...p0].filter(id => !upstreamPending(id, new Set([id]))).map(id => byId[id]);
}
function devPct(fc) {
  const v = Number(fc.ratio);
  if (!(v > 1)) return '';
  if (v >= 2) return (fc.dir === 'higher' ? '是报道值的 ' : '只有报道值的 1/') + (Math.round(v * 10) / 10) + (fc.dir === 'higher' ? ' 倍' : '');
  return (fc.dir === 'higher' ? '高 ' : '低 ') + Math.round(fc.dir === 'higher' ? (v - 1) * 100 : (1 - 1 / v) * 100) + '%';
}
async function ledgerFactCheck(run, cfg, a) {
  const rows = ledgerRows(a);
  const facts = (Array.isArray(a.facts) ? a.facts : []).filter(f => f && f.id && String(f.content || '').trim());
  if (!rows.length || !facts.length) return null;
  try {
    const prompt = fillVars(readPrompt('ledger_vs_facts.md'), {
      topic: run.topic || '',
      facts: facts.map(f => '- ' + f.id + ' [' + (f.kind || '') + '] ' + f.content).join('\n'),
      ledger: rows.map((l, i) => '- ' + ledgerId(l, i) + ' ' + (l.item || '') + ' = ' + ledgerValueText(l, ledgerNum(l)) + '(amount ' + roundAmt(ledgerNum(l)) + ',unit ' + (l.unit || '无') + ')' + (l.formula ? ' [= ' + l.formula + ']' : '') + (String(l.value || '') ? ' 说明:' + String(l.value).slice(0, 120) : '') + (Array.isArray(l.fact_ids) && l.fact_ids.length ? '(' + l.fact_ids.join(',') + ')' : '')).join('\n')
    });
    const out = await callJson(run, cfg, prompt, '账本对照事实', o => o && Array.isArray(o.rows));
    const factIds = new Set(facts.map(f => f.id));
    rows.forEach(l => { delete l.fact_check; });
    let n = 0;
    out.rows.forEach(r => {
      if (!r || typeof r !== 'object') return;
      const l = rows.find((x, i) => ledgerId(x, i) === String(r.id || ''));
      const fv = Number(String(r.fact_value == null ? '' : r.fact_value).replace(/,/g, ''));
      const ids = (Array.isArray(r.fact_ids) ? r.fact_ids : []).map(String).filter(id => factIds.has(id));
      if (!l || !(fv > 0) || !ids.length) return;
      l.fact_check = { fact_value: roundAmt(fv), fact_ids: ids, basis: String(r.basis || '').slice(0, 200) };
      n++;
    });
    devRefresh(a);
    return { ran: true, compared: n, deviations: ledgerDeviations(a).length, pending: ledgerPending(a).map(l => l.id) };
  } catch (e) { return { ran: false, error: e.message }; }
}
// 「两种都算」:把这一行换成报道值另算一遍,记下跟着变的行(写稿时对照讲)
function altScenario(a, l, fv) {
  const rows = ledgerRows(a);
  const clone = cloneJson(rows);
  const i = rows.indexOf(l);
  clone[i].amount = roundAmt(fv); clone[i].formula = '';
  verifyLedger(rows); verifyLedger(clone);
  const out = [];
  rows.forEach((x, j) => {
    if (j === i || !x.formula) return;
    const v0 = ledgerNum(x), v1 = ledgerNum(clone[j]);
    if (!isFinite(v0) || !isFinite(v1) || Math.abs(v0 - v1) <= Math.max(1, Math.abs(v0) * 0.01)) return;
    out.push({ id: ledgerId(x, j), item: x.item || '', assumed_text: ledgerValueText(x, v0), reported_text: ledgerValueText(x, v1), reported: roundAmt(v1) });
  });
  // 收入、利润、到手这些观众最关心的行排前面(写稿只给前几行)
  const key = x => (KEY_RE.test(headOf(x.item)) ? 0 : 1);
  out.sort((x, y) => key(x) - key(y));
  return { fact_value: roundAmt(fv), rows: out.slice(0, 10) };
}
const LEDGER_CHOICES = { reported: '按报道值算', assumed: '按假设值算', both: '两种都算、对照着讲' };
// 人选完一行:程序重算账本;要选的都选完了,先写后改的任务接着写稿
function ledgerChoice(runId, body) {
  const run = store.getRun(runId);
  if (!run) throw Object.assign(new Error('任务不存在'), { status: 404 });
  assertReviewable(run);
  const a = run.analysis || {};
  const rows = ledgerRows(a);
  const id = String((body || {}).id || '');
  const choice = String((body || {}).choice || '');
  const l = rows.find((x, i) => ledgerId(x, i) === id);
  if (!l || !l.fact_check) throw Object.assign(new Error('找不到要选的账本行: ' + id), { status: 400 });
  if (!LEDGER_CHOICES[choice]) throw Object.assign(new Error('选项不对: ' + choice), { status: 400 });
  const fc = l.fact_check, fv = Number(fc.fact_value);
  const before = { amount: l.amount, formula: l.formula || '', value: l.value || '', value_text: fc.value_text || '' };
  delete l.alt;
  if (choice === 'reported') {
    l.amount = roundAmt(fv);
    l.formula = '';
    l.value = ledgerValueText(l, fv) + '(按报道值,' + fc.fact_ids.join(',') + ')';
    l.fact_ids = [...new Set([...(Array.isArray(l.fact_ids) ? l.fact_ids : []), ...fc.fact_ids])];
    delete l.program_fixed;
    delete l.deviation_reason;
  } else {
    if (!String(l.deviation_reason || '').trim()) l.deviation_reason = '你选了' + LEDGER_CHOICES[choice] + '(报道值约 ' + (fc.fact_text || fv) + ')';
    if (choice === 'both') l.alt = altScenario(a, l, fv);
  }
  l.ledger_choice = { choice, label: LEDGER_CHOICES[choice], at: new Date().toISOString(), before };
  const fixed = ledgerWriteBack(a); // 下游的合计、利润、时薪按新数重算
  devRefresh(a);
  // 下游行因为这次选择和报道值差开了(实测 L3 按报道值后,L7 月营收按 20 个营业日算,比报道的月营收低 34%):
  // 是人选出来的结果,记上理由,不再追问第二次
  const byId = {};
  rows.forEach((x, i) => { byId[ledgerId(x, i)] = x; });
  const dependsOn = (x, seen) => (String(x.formula || '').match(/L\d+[a-z]?(?![a-z\d])/gi) || []).some(r => byId[r] && !seen.has(r) && (seen.add(r), r === id || dependsOn(byId[r], seen)));
  rows.forEach(x => {
    if (x === l || !x.fact_check || !(x.fact_check.ratio > DEV_HOLD) || String(x.deviation_reason || '').trim() || x.ledger_choice) return;
    if (dependsOn(x, new Set())) x.deviation_reason = '跟着 ' + id + ' 的选择(' + LEDGER_CHOICES[choice] + ')重算出来的数';
  });
  a.ledger_check = verifyLedger(a.ledger);
  const pending = ledgerPending(a);
  run.steps = run.steps || {};
  const st = run.steps.ledger_choice;
  let resume = false;
  if (st && st.status === 'waiting') {
    st.rows = pending.map(x => ({ id: x.id, item: x.item || '' }));
    if (!pending.length) { st.status = 'done'; st.finished_at = new Date().toISOString(); resume = !!run.draft_first; }
  }
  run.analysis_edited = true;
  store.saveRun(run);
  if (resume) require('./review').resumeDraftFirst(run.id).catch(() => {});
  return { ok: true, id, choice, recalculated: fixed.map(x => x.id), pending: pending.map(x => x.id), resumed: resume };
}

function acceptedGaps(a) {
  return ((a && a.retention_map) || []).filter(r => /接受弱化/.test(r.status || '')).map(r => r.source_peak);
}

// 前端编辑分析时要用的对照数据:原片高峰集合 + 第一个甜头秒数(用于"钩子晚于原片"提示与 PK 编号校验)
// 只读资产,不落盘;资产或 timeline 缺失时返回空结构,绝不抛错
function analysisContext(assetId) {
  const out = { peaks: [], source_first_payoff_sec: null, segments: [], framework: null };
  try {
    const asset = store.getAsset(assetId);
    try {
      out.segments = retention.cardsForAsset(asset).map(c => ({
        stage_id: c.stage_id, function: c.function, deletability: c.deletability,
        peaks: (c.peaks || []).map(p => p.peak_id), abstract_move: c.abstract_move || ''
      }));
      const fw = dataOf(parse(asset.framework || ''));
      const ce = fw.core_engine || {};
      out.framework = {
        name: fw.name || asset.id,
        core_engine: [ce.surface_promise_pattern, (ce.deep_emotional_promise || []).join('、')].filter(Boolean).join(';'),
        title_contract: fw.title_hook_contract || {},
        must_preserve: (fw.migration_rules || {}).must_preserve || []
      };
    } catch (e) { /* 留存卡或框架缺失:前端不显示可删性校验和标题提示词里的框架方向 */ }
    const tl = dataOf(parse(asset && asset.timeline));
    out.peaks = (tl.peak_points || []).map(p => ({
      peak_id: p.peak_id, peak_type: p.peak_type || '', strength: p.strength,
      time_ms: p.time_ms, position_ratio: p.position_ratio
    }));
    const first = (tl.hook_window || {}).first_payoff_ms;
    out.source_first_payoff_sec = first != null ? Math.round(first / 100) / 10 : null;
  } catch (e) { /* 忽略:前端退化为不做这两项校验 */ }
  return out;
}

function cloneJson(v) {
  try { return JSON.parse(JSON.stringify(v)); } catch (e) { return null; }
}

// 分析 JSON 的最低结构要求;返回错误说明或 null
// 数组类型必须是数组:模型偶尔把这几项输出成对象,前端表格会直接崩
function analysisShapeError(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return '不是 JSON 对象';
  for (const k of ['verdict', 'title', 'thesis_card', 'facts', 'modules', 'retention_map', 'hook']) {
    if (a[k] == null) return '缺少字段 ' + k;
  }
  for (const k of ['facts', 'modules', 'retention_map']) {
    if (!Array.isArray(a[k])) return k + ' 必须是数组';
  }
  if (!a.facts.length) return 'facts 为空';
  for (const k of ['adjustments', 'reframe_reasons']) {
    if (a[k] != null && !Array.isArray(a[k])) return k + ' 必须是数组';
  }
  return null;
}

function parseJsonLoose(text) {
  const s = checks.stripFence((text || '').trim());
  return parse(s) || checks.repairJsonQuotes(s) || checks.extractJsonObject(s);
}

// 单次 LLM 调用 + 流水记录(与 runGeneration 的 attempts 同结构)
// opts 原样交给 llmCall(如 allowPartial:断流时把已收到的正文交回,由调用方续写)
function mergeAttempts(a, b) {
  const seen = new Set(), out = [];
  [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].forEach(x => {
    if (!x) return;
    const k = x.ts + '|' + x.label + '|' + x.secs + '|' + x.ok;
    if (seen.has(k)) return;
    seen.add(k); out.push(x);
  });
  return out.sort((x, y) => String(x.ts).localeCompare(String(y.ts))).slice(-100);
}
// v1.86 渠道卡住(只发心跳、一个字都没写)时自动调短输出:opts.stall 是调用方带的一个对象,同一份输出的几轮续写共用。
// 调短后被 max_tokens 截断,调用方照旧接着写;只对这一份输出有效,下一步用回设置里的值(设置不改)。
const STALL_MIN_TOKENS = 2048;
function stallCfg(cfg, st) { return st && st.max_tokens ? { ...cfg, max_tokens: st.max_tokens } : cfg; }
async function callWithLog(run, cfg, messages, label, opts) {
  const st = opts && opts.stall;
  if (!st) return callWithLogOnce(run, cfg, messages, label, opts);
  const o = { ...opts, stall: undefined, shortenOnStall: true }; // 卡住时 llmCall 不原样重试,马上交回这里
  for (let lb = label; ; lb = label + '·调短') {
    try { return await callWithLogOnce(run, stallCfg(cfg, st), messages, lb, o); }
    catch (e) {
      if (!e.stall) throw e;
      const cur = st.max_tokens || cfg.max_tokens || 8192;
      const next = Math.max(STALL_MIN_TOKENS, Math.floor(cur / 2));
      if (st.tried || next >= cur) {
        throw Object.assign(new Error('「' + label + '」渠道连续两次很久只发心跳、一个字都没写' + (st.max_tokens ? '(第二次已把这一份的输出调短到 ' + st.max_tokens + ' token)' : '') + ',多半是渠道卡住了。请换一个渠道,再点「重跑」。' + e.message), { kind: 'empty', stall: true });
      }
      st.tried = true; st.from = cur; st.max_tokens = next;
    }
  }
}
// 调短后续写的轮数要放宽(原来一轮的量现在要几轮)
function stallRounds(base, cfg, st) { return st && st.max_tokens ? Math.ceil(base * (st.from || cfg.max_tokens || 8192) / st.max_tokens) : base; }
async function callWithLogOnce(run, cfg, messages, label, opts) {
  const pipeline = require('./pipeline'); // 延迟加载,避免与 pipeline 循环依赖
  const t0 = Date.now();
  // 只把 attempts / 取消标记并进盘上的最新版本,不整对象写回:
  // 这个调用可能持续几分钟,期间接口可能已经保存过分析、确认过任务,旧快照写回会把它们覆盖掉。
  const log = extra => {
    // v1.75:建任务前的预判(还没有任务)只记在内存对象上,不落盘,免得任务列表里多出一条假任务
    const U = require('./usage');
    if (run.ephemeral) { if (usage) U.record(run, label, usage); run.attempts = [...(run.attempts || []), { ts: new Date().toISOString(), label, provider: cfg.provider || '', model: cfg.model || '', ...extra }].slice(-100); return; }
    const fresh = store.getRun(run.id) || run;
    // v1.85 token 用量:加在盘上最新的那份上(同一任务可能有几个调用同时跑),内存里的 run 跟着更新,免得后面整对象写回时丢掉
    if (usage) { fresh.usage = U.newer(fresh.usage, run.usage); U.record(fresh, label, usage); run.usage = fresh.usage; }
    if (fresh.cancel_requested) run.cancel_requested = true;
    // v1.80:同一任务可能有两个检查同时跑,各自的 attempts 合并,不互相覆盖
    run.attempts = mergeAttempts(fresh.attempts, [...(run.attempts || []), { ts: new Date().toISOString(), label, provider: cfg.provider || '', model: cfg.model || '', ...extra }]);
    fresh.attempts = run.attempts;
    if (run.cancel_requested) fresh.cancel_requested = run.cancel_requested;
    store.saveRun(fresh);
  };
  let usage = null;
  try {
    const r = await pipeline.llmCall(cfg, messages, label, opts);
    usage = r.usage || null;
    log({ ok: true, secs: Math.round(r.secs * 10) / 10, stop_reason: r.stopReason, ...(r.partial ? { partial: true } : {}), ...require('./usage').attemptFields(r.usage) });
    usage = null;
    return r;
  } catch (e) {
    log({ ok: false, secs: Math.round((Date.now() - t0) / 100) / 10, error: e.message });
    throw e;
  }
}

// ---------- 原片 → 本地对照表 + 叙事方式(v1.69) ----------
// 实测 run_cb26dc06a1f8:英格兰原片「农民→骑士→男爵→伯爵→王冠」被一级对一级换成朝鲜女性,稿子里留下城堡、王冠、
// 「奇幻作品」、untitled 直译成「무작위」;第 8 级是国王(女主角做不到)。写前分析结束时单独问一次(写稿前就要有),
// 旧任务可以在审稿页点按钮补一次。失败不挡写前分析,只记下错误
const SOURCE_TEXT_MAX = 9000;
function sourceTextBrief(asset) {
  try {
    const segs = require('./review').sourceSegments(asset);
    let left = SOURCE_TEXT_MAX;
    return segs.map(s => {
      const t = String(s.text || '').slice(0, Math.max(0, Math.min(900, left)));
      left -= t.length;
      return '- ' + s.stage_id + ' ' + (s.function || '') + ':' + (t || '(无字幕)');
    }).join('\n') || '(没有原片字幕)';
  } catch (e) { return '(没有原片字幕)'; }
}
function sourceMappingOk(out) { return out && typeof out === 'object' && !Array.isArray(out) && typeof out.pov_mode === 'string' && Array.isArray(out.items); }
function cleanSourceMapping(out) {
  const list = v => (Array.isArray(v) ? v : []);
  const str = v => String(v == null ? '' : v).trim();
  const mode = ['climb', 'per_level', 'none'].includes(out.pov_mode) ? out.pov_mode : 'none';
  return {
    at: new Date().toISOString(), by: 'ai',
    pov_mode: mode, pov_basis: str(out.pov_basis),
    levels: list(out.levels).filter(l => l && typeof l === 'object').map((l, i) => ({ n: Number(l.n) || i + 1, source: str(l.source), local: str(l.local), reachable: l.reachable !== false, why: str(l.why) })).slice(0, 15),
    same_context: out.same_context === true,
    items: list(out.items).filter(x => x && typeof x === 'object' && str(x.source)).map(x => ({ source: str(x.source), kind: str(x.kind), local: str(x.local), residue: list(x.residue).map(str).filter(Boolean).slice(0, 12) })).slice(0, 40),
    extra_residue: list(out.extra_residue).map(str).filter(Boolean).slice(0, 30)
  };
}
async function buildSourceMapping(run, cfg, asset, a) {
  const { vars } = frameworkVars(run, asset);
  const t = (a && a.title) || {};
  const prompt = fillVars(readPrompt('source_mapping.md'), {
    ...vars, final_title: t.final_title || run.topic, protagonist: JSON.stringify((a && a.protagonist) || {}), source_text: sourceTextBrief(asset)
  });
  const out = await callJson(run, cfg, prompt, '原片对照表', sourceMappingOk);
  return cleanSourceMapping(out);
}
// 审稿页「生成原片对照表」(旧任务没有)/ 重新生成:只调这一次,不动稿子
const mappingBusy = new Set();
async function runSourceMapping(runId) {
  const pipeline = require('./pipeline');
  const cfg = pipeline.loadConfig();
  const run = store.getRun(runId);
  if (!run || !run.analysis) throw Object.assign(new Error('这篇没有写前分析,没法生成对照表'), { status: 400 });
  require('./fitcheck').assertFull(run);
  if (!cfg || !cfg.api_key) throw Object.assign(new Error('未配置 API Key'), { status: 400 });
  const asset = store.getAsset(run.asset_id);
  if (!asset) throw Object.assign(new Error('资产不存在: ' + run.asset_id), { status: 400 });
  if (mappingBusy.has(runId)) return { ok: true, running: true };
  mappingBusy.add(runId);
  const set = patch => { const f = store.getRun(runId); if (!f) return; f.steps = { ...(f.steps || {}), source_mapping: { ...((f.steps || {}).source_mapping || {}), ...patch } }; store.saveRun(f); return f; };
  set({ status: 'running', started_at: new Date().toISOString(), error: '' });
  (async () => {
    try {
      const sm = await buildSourceMapping(run, cfg, asset, run.analysis);
      const f = store.getRun(runId);
      const old = (f.analysis || {}).source_mapping;
      // 人改过的叙事方式保留
      if (old && old.pov_mode_by === 'user') { sm.pov_mode = old.pov_mode; sm.pov_mode_by = 'user'; }
      f.analysis = { ...(f.analysis || {}), source_mapping: sm };
      if (run.attempts) f.attempts = (store.getRun(runId) || run).attempts;
      store.saveRun(f);
      set({ status: 'done', finished_at: new Date().toISOString() });
    } catch (e) {
      set({ status: 'failed', error: e.message });
    } finally { mappingBusy.delete(runId); }
  })();
  return { ok: true, started: true };
}
// 人改叙事方式(分析页、审稿页的下拉框)
function setPovMode(runId, mode) {
  const run = store.getRun(runId);
  if (!run || !run.analysis) throw Object.assign(new Error('这篇没有写前分析'), { status: 400 });
  require('./fitcheck').assertFull(run);
  if (!['climb', 'per_level', 'none'].includes(mode)) throw Object.assign(new Error('叙事方式只能是 climb / per_level / none'), { status: 400 });
  const sm = run.analysis.source_mapping || { at: new Date().toISOString(), by: 'user', levels: [], same_context: true, items: [], extra_residue: [], pov_basis: '' };
  run.analysis.source_mapping = { ...sm, pov_mode: mode, pov_mode_by: 'user' };
  store.saveRun(run);
  return { ok: true, pov_mode: mode };
}

// ---------- B②–⑧:写前分析 ----------
async function runAnalysis(runId) {
  const pipeline = require('./pipeline');
  const run = store.getRun(runId);
  if (!run) return;
  const cfg = pipeline.loadConfig();
  if (!cfg || !cfg.api_key) { run.status = 'failed'; run.error = '未配置 API Key(POST /api/settings)'; store.saveRun(run); return; }
  const asset = store.getAsset(run.asset_id);
  if (!asset || !asset.framework) { run.status = 'failed'; run.error = '资产不存在: ' + run.asset_id; store.saveRun(run); return; }

  run.status = 'analyzing';
  delete run.error;
  delete run.cancel_requested;
  run.steps = { ...(run.steps || {}), analysis: { status: 'running', started_at: new Date().toISOString() } };
  delete run.steps.ledger_choice; // 重做分析(含换框架)后账本是新的,上一份分析的「账本选择」作废
  // 快速适配判断(v1.70):推荐框架时已经预判过的(人选了那个框架)直接带进来,不再跑一次;
  // 人选了「仍按现在的框架写」就不判,直接做完整分析
  const fitcheck = require('./fitcheck');
  const carry = run.fit_carry && run.fit_carry.asset_id === run.asset_id ? run.fit_carry : null;
  delete run.fit_carry;
  const skipQuick = (run.reframe || {}).status === 'ignored';
  // v1.89:人在论点卡上选完(或改一句、重出)接着跑:快速适配判断上次已经做过,不再做一遍
  const thesisResume = !!run.thesis_resume && !!(run.fit_quick || (run.steps || {}).fit_quick);
  // 人坚持用这个框架时保留之前那次快速判断(判的是换框架),完整分析的结论记在它后面,以后统计两者一致率
  if (!thesisResume && !(skipQuick && run.fit_quick && run.fit_quick.asset_id === run.asset_id)) delete run.fit_quick;
  if (carry) run.fit_quick = { ...carry, by: 'prejudge' };
  store.saveRun(run);
  try {
    if (!carry && !skipQuick && !thesisResume) {
      const prevA = run.analysis && !run.analysis.quick_only ? run.analysis : null;
      const prev = prevA ? { title: (prevA.title || {}).final_title, thesis_card: prevA.thesis_card, protagonist: prevA.protagonist } : ((run.reframe || {}).prev || {});
      run.steps.analysis = { ...run.steps.analysis, stage: '快速适配判断' };
      store.saveRun(run);
      let fit = null;
      try {
        fit = await fitcheck.quickFit(run, cfg, asset, prev);
        fitcheck.logQuick(run, fit, 'quick');
        run.fit_quick = { ...fit, by: 'quick' };
        run.steps.fit_quick = { status: 'done', secs: fit.secs, finished_at: fit.at };
      } catch (e) {
        // 快速判断失败不挡:照现在的流程直接做完整分析
        run.steps.fit_quick = { status: 'failed', error: e.message };
      }
      if (run.cancel_requested) {
        run.status = 'cancelled';
        run.steps.analysis = { ...run.steps.analysis, status: 'failed' };
        store.saveRun(run);
        return;
      }
      if (fit && fit.verdict === '换框架') {
        // 判了「换框架」:不做完整分析,也不生成原片对照表,直接去推荐框架(先写后改模式在 finishDraftFirst 里停住并推荐)
        run.analysis = fitcheck.stubAnalysis(run, fit, prev);
        delete run.analysis_raw;
        run.steps.analysis = { ...run.steps.analysis, status: 'done', quick_only: true, secs: fit.secs, finished_at: new Date().toISOString() };
        delete run.steps.analysis.stage;
        run.status = 'awaiting_review';
        store.saveRun(run);
        // 人从推荐里选过框架:自动换下一个候选(v1.71);否则人工确认模式出推荐(先写后改在 finishDraftFirst 里停住并推荐)
        if (!require('./reframe').autoNext(runId) && !run.draft_first) require('./reframe').suggest(runId).catch(() => {});
        return;
      }
      run.steps.analysis = { ...run.steps.analysis, stage: '写前分析' };
      store.saveRun(run);
    }
    // v1.77:先定论点 —— 出 3 个角度 → 联网搜正反资料 → 核对挑选,结果带进写前分析(失败不挡)
    await require('./thesis').ensure(run, cfg, asset, stage => { run.steps.analysis = { ...run.steps.analysis, stage }; store.saveRun(run); });
    if (run.cancel_requested || (store.getRun(run.id) || {}).cancel_requested) {
      run.status = 'cancelled';
      run.steps.analysis = { ...run.steps.analysis, status: 'failed' };
      store.saveRun(run);
      return;
    }
    delete run.thesis_resume;
    // v1.89:建任务时选了「我来选论点」:出完论点卡停下来等人选(选完从这里接着跑,一键生成的一路往下写)
    if (require('./thesis').needHold(run)) {
      run.status = 'thesis_hold';
      run.steps.analysis = { ...run.steps.analysis, status: 'waiting', stage: '等你选论点' };
      run.steps.thesis_pick = { status: 'waiting', at: new Date().toISOString() };
      store.saveRun(run);
      return;
    }
    run.steps.analysis = { ...run.steps.analysis, stage: '写前分析' };
    store.saveRun(run);
    const built = buildAnalysisPrompt(run, asset);
    run.track_card_name = built.track_card_name;
    let messages = [{ role: 'user', content: built.prompt }];
    let r = await callWithLog(run, cfg, messages, '写前分析');
    let a = parseJsonLoose(r.content);
    let err = r.stopReason === 'max_tokens' ? '输出被 max_tokens 截断' : analysisShapeError(a);
    for (let retry = 1; err && retry <= GATE_MAX_RETRIES; retry++) {
      run.steps.analysis.gate_retry = { reason: err, attempt: retry };
      store.saveRun(run);
      const feedback = err.indexOf('截断') !== -1
        ? '上一次输出被长度上限截断。请压缩每个字段的文字(理由一句话以内),一次性输出完整 JSON,禁止代码围栏和解释。'
        : '上一次输出不合格:' + err + '。请严格只输出格式要求里的 JSON 对象,字段齐全,禁止代码围栏和解释。';
      messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: feedback }];
      r = await callWithLog(run, cfg, messages, '写前分析重试');
      a = parseJsonLoose(r.content);
      err = r.stopReason === 'max_tokens' ? '输出被 max_tokens 截断(请在设置里调大 Max Tokens)' : analysisShapeError(a);
    }
    if (err) throw new Error(err);
    if (run.cancel_requested) {
      run.status = 'cancelled';
      run.steps.analysis = { ...run.steps.analysis, status: 'failed' };
      store.saveRun(run);
      return;
    }
    // 有公式的行先改成程序算的数(AI 修账本在「AI 先调整」里做)
    // v1.74:按功能重排时,判了换框架但卡住的全是普通段的,程序改判「调整后可写」(原结论记在 verdict_before_fit_rule)
    if (require('./fitrule').on()) require('./fitrule').applyFull(a);
    // v1.76:框架在建任务时已定的任务,完整分析判了换框架也不换:改成调整后可写,写不成立的段落交给后面换个讲法
    require('./reframe').settleLocked(run, a);
    const pf = ledgerWriteBack(a);
    if (pf.length) a.ledger_checkup = { at: new Date().toISOString(), program_fixed: pf, problems: ledgerProblems(a, run, pf).map(p => p.text) };
    a.ledger_check = verifyLedger(a.ledger);
    // 原片 → 本地对照表 + 叙事方式(v1.69):写稿前就要有;失败不挡分析,审稿页可以补
    try {
      run.steps.analysis = { ...run.steps.analysis, stage: '原片对照表' };
      store.saveRun(run);
      a.source_mapping = await buildSourceMapping(run, cfg, asset, a);
      run.steps.source_mapping = { status: 'done', finished_at: new Date().toISOString() };
    } catch (e) {
      run.steps.source_mapping = { status: 'failed', error: e.message };
    }
    run.analysis = a;
    run.analysis_raw = r.content;
    run.steps.analysis = { ...run.steps.analysis, status: 'done', secs: Math.round(r.secs * 10) / 10, finished_at: new Date().toISOString() };
    delete run.steps.analysis.stage;
    fitcheck.logFull(run, run.asset_id, a.verdict, a.verdict === '换框架' ? a.reframe_reasons : null);
    run.status = 'awaiting_review';
    store.saveRun(run);
    // 人工确认模式判了「换框架」:顺手出框架推荐,人在分析页直接换(先写后改模式在 finishDraftFirst 里停住并推荐)
    // 人已经选了「仍按现在的框架写」(快速判断判了换框架,人坚持用这个框架才做的完整分析)就不再推荐
    // 人从推荐里选过框架、这个仍判换框架:自动按预判换下一个候选(v1.71),换了或停了都不再出新推荐
    if (a.verdict === '换框架' && !skipQuick && require('./reframe').autoNext(runId)) return;
    if (!run.draft_first && a.verdict === '换框架' && !skipQuick) require('./reframe').suggest(runId).catch(() => {});
  } catch (e) {
    run.status = 'failed';
    run.error = '写前分析失败: ' + e.message;
    run.steps.analysis = { ...(run.steps.analysis || {}), status: 'failed' };
    store.saveRun(run);
  }
}

// ---------- B⑬⑭:稿件检查 ----------
function buildCheckPrompt(run, asset, stats) {
  const a = run.analysis || {};
  const t = a.title || {};
  const vars = {
    title: t.final_title || run.topic,
    title_promise: (t.viewer_question || '') + ' → ' + (t.expected_answer_direction || ''),
    thesis_card: JSON.stringify(a.thesis_card || {}),
    facts: (a.facts || []).map(f => '- ' + f.id + ' [' + (f.kind || '') + '] ' + (f.content || '') + '(' + [f.source, f.year, f.region].filter(Boolean).join(',') + ')').join('\n') || '(无事实表)',
    search_log: (a.search_log || []).map(s => '- ' + s.looked_for + ':' + s.result + (s.note ? '(' + s.note + ')' : '')).join('\n') || '(无)',
    retention_map: (a.retention_map || []).map(r => '- ' + r.source_peak + ' → ' + (r.new_chapter_hint || '') + ' ' + r.status).join('\n') || '(无)',
    program_stats: JSON.stringify({
      length: stats.length, source_density_max: stats.source_density_max, density_limit: stats.density_limit,
      dense_chapters: stats.dense_chapters, mixed_year_chapters: stats.mixed_year_chapters, stale_facts: stats.stale_facts,
      chapters: stats.chapters.map(c => ({ id: c.id, words: c.words, density: c.density, years: c.years }))
    }),
    script: v1Text(run)
  };
  let tpl = readPrompt('script_check.md');
  for (const k of Object.keys(vars)) tpl = tpl.replaceAll('{{' + k + '}}', vars[k]);
  return tpl;
}

// K3 的自动修改:before 在终稿里恰好出现一次才替换,否则降级为"待选择"
function applyK3(script, issues) {
  let text = script;
  for (const it of issues) {
    if (it.type !== 'K3' || it.status !== '已修改') continue;
    const before = it.before || '';
    const n = before ? text.split(before).length - 1 : 0;
    if (n === 1 && it.after) { text = text.replace(before, it.after); it.applied = true; }
    else { it.applied = false; it.status = '待选择'; it.problem = (it.problem || '') + '(自动修改未执行:原句在终稿中' + (n ? '出现多次' : '找不到') + ')'; }
  }
  return text;
}

// 稿件检查只针对 V1(写稿产物);强化开头生成 V2 后 final_script 会变成 V2,所以优先取 script_v1
function v1Text(run) { return run.script_v1 || run.final_script || ''; }

// 稿件数据统计(片长/密度/数字与年份/事实时效);输入输出与 runScriptCheck 里原来那段一致
function scriptProgramStats(run) {
  const asset = store.getAsset(run.asset_id);
  if (!asset) return null;
  const nw = require('./narration').narrationWpm(run, null); // 预计片长按配音语速估
  return retention.scriptStats(v1Text(run), {
    timeline: asset.timeline, framework: asset.framework, srt: asset.srt, facts: (run.analysis || {}).facts,
    wpm: nw.from === 'source' ? null : nw.wpm
  });
}

// "采用某个选项"的落地:find 必须在稿中恰好出现一次,否则不动;改完结构不合格也不动
function applyOptionExact(script, find, replace) {
  const text = String(script || '');
  const f = String(find || '');
  const rep = String(replace == null ? '' : replace);
  if (!f.trim()) return { ok: false, reason: '原句为空' };
  // 章节标签行是结构锚点,不允许被改掉
  if (/\[\s*CH\d+\s*\|/.test(f) || /\[\s*CH\d+\s*\|/.test(rep)) return { ok: false, reason: '改动涉及章节标签行' };
  const n = text.split(f).length - 1;
  if (n === 0) return { ok: false, reason: '原句在稿子里找不到(可能已被改过)' };
  if (n > 1) return { ok: false, reason: '原句在稿子里出现 ' + n + ' 次,无法确定改哪一处' };
  const after = text.replace(f, rep);
  const structErr = checks.chapterStructureError(after);
  if (structErr) return { ok: false, reason: '改完章节结构不合格:' + structErr };
  return { ok: true, text: after };
}

async function runScriptCheck(runId) {
  const pipeline = require('./pipeline');
  const run = store.getRun(runId);
  if (!run || !v1Text(run)) return;
  const cfg = pipeline.loadConfig();
  const asset = store.getAsset(run.asset_id);
  if (!cfg || !cfg.api_key || !asset) return;
  run.steps = { ...(run.steps || {}), script_check: { status: 'running', started_at: new Date().toISOString() } };
  store.saveRun(run);
  try {
    const stats = scriptProgramStats(run);
    let messages = [{ role: 'user', content: buildCheckPrompt(run, asset, stats) }];
    let r = await callWithLog(run, cfg, messages, '稿件检查');
    let rep = parseJsonLoose(r.content);
    for (let retry = 1; !(rep && Array.isArray(rep.issues)) && retry <= GATE_MAX_RETRIES; retry++) {
      messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: '上一次输出不是合法 JSON。请只输出 {"issues": [...]} 这个 JSON 对象,禁止代码围栏和解释。' }];
      r = await callWithLog(run, cfg, messages, '稿件检查重试');
      rep = parseJsonLoose(r.content);
    }
    if (!(rep && Array.isArray(rep.issues))) throw new Error('输出不是合法 JSON');
    const issues = rep.issues;
    const before = v1Text(run);
    if (run.script_v2) {
      // 已基于 V1 生成 V2:V1 锁定,不再自动改,只提示
      issues.filter(i => i.type === 'K3' && i.status === '已修改').forEach(i => { i.status = '待选择'; i.problem = (i.problem || '') + '(已生成 V2,V1 不再自动修改)'; });
    }
    const after = checks.cleanForeignScript(applyK3(before, issues), (run.audience || {}).target_language).text;
    if (after !== before) {
      // 改前版本留档;改后结构不合格则整体放弃自动修改
      if (checks.chapterStructureError(after)) issues.filter(i => i.applied).forEach(i => { i.applied = false; i.status = '待选择'; });
      else {
        run.final_script_before_check = before;
        if (run.script_v1) run.script_v1 = after; else run.final_script = after;
        // V1 文案已变:该版本的扫描与简介缓存过期
        ['compliance_scans', 'opening_scans', 'descriptions'].forEach(k => { if (run[k] && run[k].v1) run[k].v1.stale = true; });
      }
    }
    run.script_check = { at: new Date().toISOString(), program: stats, issues, applied: issues.filter(i => i.applied).length, pending: issues.filter(i => i.status === '待选择').length };
    run.steps.script_check = { ...run.steps.script_check, status: 'done', secs: Math.round(r.secs * 10) / 10, finished_at: new Date().toISOString() };
    store.saveRun(run);
  } catch (e) {
    run.steps.script_check = { ...(run.steps.script_check || {}), status: 'failed', error: e.message };
    store.saveRun(run);
  }
}

// ---------- 审核辅助:AI 先调整 / 我的意见(单行重做)/ 标题审核 ----------
// 三个动作都不改 run.status,也不自动确认;改动记在 analysis.ai_marks[target](界面上标蓝),
// 依据类型:查到(搜索结果或参考资料)/ 估算(写明算法)/ 记忆待核(没查到,只凭模型知识)/ 推理(非数字改动)。
const search = require('./search');
const BASIS = ['查到', '估算', '记忆待核', '推理'];

// target 写法:title / thesis_card / hook / facts.F04 / modules.FS03 / retention_map.PK02
function getTarget(a, target) {
  const [k, id] = String(target || '').split(/\.(.+)/);
  if (!a) return null;
  if (['title', 'thesis_card', 'hook'].includes(k)) return a[k] || null;
  if (k === 'facts') return (a.facts || []).find(f => f.id === id) || null;
  if (k === 'modules') return (a.modules || []).find(m => m.segment === id) || null;
  if (k === 'retention_map') return (a.retention_map || []).find(m => m.source_peak === id) || null;
  return null;
}

// 合并一行:模型没给的键保留旧值;显式给空值([] / '' / null)则覆盖为空,
// 这样模型想清空 fact_ids、理由这类字段时能清掉,不会把旧内容强行留下。
function mergeRow(oldRow, item, key, id) {
  const out = (oldRow && typeof oldRow === 'object' && !Array.isArray(oldRow)) ? { ...oldRow } : {};
  for (const k of Object.keys(item)) {
    if (k === key) continue;
    out[k] = item[k];
  }
  out[key] = id;
  return out;
}

// 有 id 的行:找到就合并(不是整行替换),找不到就追加(只有事实允许新增)
function setTarget(a, target, item) {
  const [k, id] = String(target || '').split(/\.(.+)/);
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  if (['title', 'thesis_card', 'hook'].includes(k)) {
    const old = (a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) ? a[k] : {};
    a[k] = { ...old, ...item };
    if (k === 'hook') {
      const c = a[k].candidates;
      const n = Number(a[k].chosen);
      if (Array.isArray(c) && !(Number.isInteger(n) && n >= 0 && n < c.length)) a[k].chosen = 0;
    }
    return true;
  }
  const key = { facts: 'id', modules: 'segment', retention_map: 'source_peak' }[k];
  if (!key) return false;
  const arr = Array.isArray(a[k]) ? a[k] : (a[k] = []);
  const i = arr.findIndex(x => x && x[key] === id);
  if (i >= 0) arr[i] = mergeRow(arr[i], item, key, id);
  else if (k === 'facts') arr.push(mergeRow(null, item, key, id));
  else return false;
  return true;
}

function markChange(a, target, mark, batches) {
  a.ai_marks = a.ai_marks || {};
  a.ai_marks[target] = {
    fields: Array.isArray(mark.fields) ? mark.fields : [],
    basis: BASIS.includes(mark.basis) ? mark.basis : '推理',
    reason: mark.reason || '',
    evidence: search.resolveEvidence(mark.evidence, batches),
    by: mark.by || 'auto',
    note: mark.note || '',
    at: new Date().toISOString()
  };
}

// 需要补的内容清单(给查询词提示词用)
function needsList(a, run) {
  const out = [];
  (a.facts || []).forEach(f => {
    const miss = ['content', 'source', 'year', 'region'].filter(k => !String(f[k] || '').trim());
    if (f.kind === '待查' || miss.length || (f.kind === '估算' && !f.method) || f.freshness === '时效风险') {
      out.push('- facts.' + f.id + ' [' + (f.kind || '未标') + '] ' + (f.slot || '') + ':' + (f.content || '(空)') +
        (miss.length ? '(缺 ' + miss.join('/') + ')' : '') + (f.freshness === '时效风险' ? '(数据太旧)' : '') + (f.region ? ' 地区:' + f.region : ''));
    }
  });
  (a.adjustments || []).filter(x => x.type === '补料').forEach(x => out.push('- ' + (x.target || '补料') + ':' + (x.reason || '')));
  (a.retention_map || []).filter(r => /缺口-补料/.test(r.status || '')).forEach(r => out.push('- retention_map.' + r.source_peak + '(' + (r.source_segment || '') + ')缺事实承担'));
  (a.modules || []).forEach(m => (m.research_tasks || []).forEach(t => out.push('- modules.' + m.segment + ' 补料任务:' + t)));
  // 经济拆账题要 4–5 个有来源的真人案例(v1.60:实测 run_a8886e8f0744 只有统计数,后半段反复讲同一组统计)
  if (run && ledgerSayOn(run)) {
    const cs = (Array.isArray(a.cases) ? a.cases : []).filter(c => c && String(c.nick || c.who || '').trim());
    const sourced = cs.filter(c => String(c.source || c.url || '').trim()).length;
    if (sourced < CASES_MIN) out.push('- cases 真人案例:现在有 ' + cs.length + ' 个(有来源的 ' + sourced + ' 个),要 ' + CASES_MIN + '–5 个有来源的真实店主或案例:店主采访、电视节目、判决、高赞评论里的具体店主,记细节(数字、原话、结果)和来源');
  }
  return out;
}
const CASES_MIN = 4;

// v1.87:原片每讲一个真人、案例、圈内人的话,开口就交代从哪来的(每 1000 字 2.8 次,我们 0.2 次);
// 只有一个人的说法(本人采访、评论、宣传稿)时加半句点明(原片约每 1000 字 0.9 次);报道里的经过和细节要用上,不只用数字
const ONE_VOICE = /本人|评论|帖子|宣传|自己的视频|个人/;
function caseOneVoice(c) { return ONE_VOICE.test(String((c && c.source_kind) || '')); }
function caseLine(c) {
  const stories = (Array.isArray(c.stories) ? c.stories : []).map(x => String(x || '').trim()).filter(Boolean);
  const src = c.source || c.year ? '(' + [c.source, c.year].filter(Boolean).join(',') + ')' : '(没有来源)';
  return '- 「' + (c.nick || c.who) + '」' + (c.nick && c.who ? c.who + ':' : ':') + (c.detail || '') + src +
    (String(c.source_kind || '').trim() ? ' 出处类型:' + c.source_kind + (caseOneVoice(c) ? '(只有一个人的说法)' : '') : '') +
    (Array.isArray(c.fact_ids) && c.fact_ids.length ? '[' + c.fact_ids.join(',') + ']' : '') +
    (stories.length ? ' 经过和细节:' + stories.join(';') : '') +
    (Array.isArray(c.appear_at) && c.appear_at.length ? ' 出场:' + c.appear_at.map(x => (x && x.segment || '') + (x && x.reveals ? '(' + x.reveals + ')' : '')).join(';') : '');
}
function casesBrief(cs) {
  const one = cs.some(caseOneVoice), anyStory = cs.some(c => Array.isArray(c.stories) && c.stories.some(x => String(x || '').trim()));
  return '真人案例(用外号称呼;按「出场」安排在对应的段出场,每次带出写好的新信息,不许重复同一句话;没有来源的要明说是假设或传闻;' +
    '每个案例第一次出场时用半句话交代从哪来的,照出处说,例如「방송에 나온 한 사장님은」「한 언론 인터뷰에서」「판결문을 보면」「한 커뮤니티 댓글에」,不要像是我们自己知道的' +
    (one ? ';标了「只有一个人的说法」的,第一次出场时再加半句点明,例如「사장님 본인 말이에요」「한 사람의 경험이긴 해요」,只说一次,不要说成全行业都这样' : '') +
    (anyStory ? ';「经过和细节」是来源里写着的具体经过,讲这个人时用上它,让中段有人有事,不要只报这个人的数字' : '') +
    '):\n' + cs.map(caseLine).join('\n');
}

// 素材够不够(v1.61):事实少于 16 条,或 fit_check 里「证据/数据」类条目判了不符合,写稿前自动多搜一轮。
// 实测 run_902550ad6154(인형뽑기방)只有 12 条事实、「공개 데이터…증거 체인 구성 → 불부합」照样写,二稿 56 分;
// 38 篇统计里事实少的几篇分数都偏低。只看 trait 写的内容,不看 type(那篇把证据项错标成了 avoid)。
const FACTS_MIN = 16;
const FIT_BAD_RE = /不符合|不符|불부합|미부합|부적합|not ?fit/i;
const EVIDENCE_RE = /证据|数据|资料|统计|报道|研究|实验|데이터|증거|자료|통계|보도|연구|실험|evidence|data/i;
// 「只靠无法核实的指标」这类是反面条目,判不符合反而是好事
const NEG_TRAIT_RE = /의존|依赖|只靠|불가능|无法|不可|검증 불가/;
function evidenceWeak(a) {
  const facts = (Array.isArray(a && a.facts) ? a.facts : []).filter(f => f && String(f.content || '').trim());
  const fits = (Array.isArray(a && a.fit_check) ? a.fit_check : []).filter(x => x && typeof x === 'object'
    && FIT_BAD_RE.test(String(x.result || '')) && EVIDENCE_RE.test(String(x.trait || '')) && !NEG_TRAIT_RE.test(String(x.trait || '')));
  const why = [];
  if (facts.length < FACTS_MIN) why.push('事实只有 ' + facts.length + ' 条(少于 ' + FACTS_MIN + ' 条)');
  fits.forEach(x => why.push('证据项「' + String(x.trait).slice(0, 60) + '」判了' + x.result));
  return { weak: why.length > 0, facts: facts.length, fits, why };
}
function evidenceNeeds(a, run, ev) {
  const out = [];
  if (ev.facts < FACTS_MIN) out.push('- facts 事实只有 ' + ev.facts + ' 条,要补到 ' + FACTS_MIN + ' 条以上:优先补能直接撑住论点和账本的硬数据(行业统计、政府/协会数据、财报、公开研究、媒体报道里的具体数字和具体店主案例),不要重复已有的事实');
  ev.fits.forEach(x => out.push('- fit_check 证据不够:「' + x.trait + '」判了' + x.result + '(' + String(x.reason || '').slice(0, 200) + '),找能补上这条证据链的公开数据、研究或可归属的实验/调查'));
  return out.concat(needsList(a, run)).slice(0, 30);
}

async function planAndSearch(run, cfg, vars, a, needs, note, maxQ) {
  if (!needs.length && !note) return [];
  const prompt = fillVars(readPrompt('adjust_queries.md'), {
    ...vars, thesis: ((a.thesis_card || {}).one_line_thesis) || '', needs: needs.join('\n') || '(见人工意见)',
    note: note || '(无)', max_queries: maxQ
  });
  const r = await callWithLog(run, cfg, [{ role: 'user', content: prompt }], '联网查询词');
  const q = parseJsonLoose(r.content);
  const queries = (Array.isArray(q && q.queries) ? q.queries : []).filter(x => x && x.query).slice(0, maxQ);
  const batches = await search.runQueries(queries, run.topic);
  // 落盘的是检索账本:摘要只留前 QUOTE_MAX 字作原文出处(全文 700 字 ×40 条 ×20 次会把 run 文件撑到几百 KB),
  // 人核实时能看到「这个数原文怎么写的」,不用再去搜
  const ledger = batches.map(b => ({
    query: b.query, target: b.target || '', error: b.error || null,
    hits: (Array.isArray(b.results) ? b.results : []).map(x => ({ ref: x.ref, title: x.title, url: x.url, date: x.date, site: x.site, quote: String(x.summary || '').replace(/\s+/g, ' ').slice(0, search.QUOTE_MAX) }))
  }));
  run.search_runs = [...(Array.isArray(run.search_runs) ? run.search_runs : []), { at: new Date().toISOString(), note: note || '', batches: ledger }].slice(-20);
  return batches;
}

function loadRunAsset(runId) {
  const pipeline = require('./pipeline');
  const run = store.getRun(runId);
  if (!run) throw Object.assign(new Error('任务不存在'), { status: 404 });
  const cfg = pipeline.loadConfig();
  if (!cfg || !cfg.api_key) throw Object.assign(new Error('未配置 API Key(POST /api/settings)'), { status: 400 });
  const asset = store.getAsset(run.asset_id);
  if (!asset || !asset.framework) throw Object.assign(new Error('资产不存在: ' + run.asset_id), { status: 400 });
  return { run, cfg, asset };
}

function assertReviewable(run) {
  require('./fitcheck').assertFull(run); // 只做了快速判断(判了换框架)的没有完整分析可改(v1.70)
  if (run.status !== 'awaiting_review' || run.analysis_confirmed) {
    throw Object.assign(new Error('仅待确认且未确认的任务可调整分析(当前: ' + run.status + ')'), { status: 400 });
  }
}

// 把调用流水/搜索记录并进盘上最新版本:这些接口可能跑几分钟,
// 中途用户可能保存过分析或确认过任务,整对象写回会把它们覆盖掉。
function saveRunMerge(run) {
  const fresh = store.getRun(run.id) || run;
  if (run.attempts !== undefined) fresh.attempts = run.attempts;
  if (run.search_runs !== undefined) fresh.search_runs = run.search_runs;
  store.saveRun(fresh);
  return fresh;
}

// 渠道中途断流时不丢已收到的内容,让模型接着写完 JSON(实测 run_7c467c8e0a71「AI 先调整」第 202 秒断流、已收到 2.1 万字,
// 原样重试 4 次全断,调整失败后事实表 30 条全是「待查」就写了稿)
async function callContinued(run, cfg, messages, label) {
  const stall = {};
  let r = await callWithLog(run, cfg, messages, label, { allowPartial: true, minPartial: 500, stall });
  let text = r.content, msgs = messages;
  const maxK = stallRounds(3, cfg, stall);
  // v1.83:被 max_tokens 截断的也接着写(原来只续断流的;账本变长后 JSON 更容易写到上限,用户 2026-11-04:一定不能截断)
  for (let k = 1; (r.partial || (r.stopReason === 'max_tokens' && String(r.content || '').length >= 200)) && k <= maxK; k++) {
    msgs = [...msgs, { role: 'assistant', content: r.content }, { role: 'user', content: '输出在中途断了。从你上一条最后一个字接着往下写,不要重复已经写过的内容,不要重新开头,不要代码围栏和解释,直到把整个 JSON 写完。' }];
    r = await callWithLog(run, cfg, msgs, label + '续写' + k, { allowPartial: true, minPartial: 1, stall });
    text += r.content;
  }
  return { ...r, content: text };
}

async function callJson(run, cfg, prompt, label, ok) {
  let messages = [{ role: 'user', content: prompt }];
  let r = await callContinued(run, cfg, messages, label);
  let out = parseJsonLoose(r.content);
  for (let retry = 1; !(out && ok(out)) && retry <= GATE_MAX_RETRIES; retry++) {
    messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: r.stopReason === 'max_tokens'
      ? '上一次输出被长度上限截断。只输出改动的部分,理由一句话以内,一次性输出完整 JSON。'
      : '上一次输出不是格式要求里的 JSON。请只输出那个 JSON 对象,禁止代码围栏和解释;字符串里引用原句用「」,不要用没转义的英文双引号,也不要换行。' }];
    r = await callContinued(run, cfg, messages, label + '重试');
    out = parseJsonLoose(r.content);
  }
  if (!(out && ok(out))) {
    // 留下最后一次的完整输出,才能看出是 JSON 写坏了还是缺字段
    let file = '';
    try {
      const dir = path.join(__dirname, '..', 'data', 'logs');
      fs.mkdirSync(dir, { recursive: true });
      file = 'llm_badjson_' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt';
      fs.writeFileSync(path.join(dir, file), 'label=' + label + '\nparsed=' + !!out + '\nstop_reason=' + r.stopReason + '\n\n' + String(r.content || '').slice(0, 60000), 'utf-8');
    } catch (e) { file = ''; }
    throw new Error(label + (out ? '输出缺内容(格式对但没有要的字段)' : '输出不是合法 JSON') + (file ? '(已留痕 ' + file + ')' : ''));
  }
  return out;
}

// 把「AI 先调整」的输出合并进分析;返回改动条数
function mergeAdjust(a, out, batches) {
  let n = 0;
  const list = v => (Array.isArray(v) ? v : []);
  const changes = list(out.changes);
  const changeFor = t => changes.find(c => c && c.target === t) || {};
  const apply = (target, item) => {
    if (!setTarget(a, target, item)) return;
    markChange(a, target, changeFor(target), batches);
    n++;
  };
  list(out.facts).forEach(f => f && f.id && apply('facts.' + f.id, f));
  list(out.modules).forEach(m => m && m.segment && apply('modules.' + m.segment, m));
  list(out.retention_map).forEach(m => m && m.source_peak && apply('retention_map.' + m.source_peak, m));
  // 账本整张替换(adjust.md 要求给完整新账本):旧实现不收账本,改了事实以后账本还是旧数,写稿照旧数算账(实测 run_a2f108398c13)
  const changedFacts = list(out.facts).filter(f => f && f.id).map(f => f.id);
  if (list(out.ledger).length) {
    a.ledger = list(out.ledger).filter(l => l && typeof l === 'object' && !Array.isArray(l));
    markChange(a, 'ledger', changeFor('ledger').target ? changeFor('ledger') : { fields: ['ledger'], basis: '估算', reason: '事实更新后重算账本' }, batches);
    n++;
  }
  // 模型没重算的:账本行、模块里引用了改过的事实 → 标记作废,写稿时按事实表重算
  const touches = x => list(x && x.fact_ids).some(id => changedFacts.includes(id));
  a.stale = {
    ledger: list(out.ledger).length ? [] : list(a.ledger).filter(touches).map(l => l.item),
    modules: list(a.modules).filter(m => touches(m) && !list(out.modules).some(o => o && o.segment === m.segment)).map(m => m.segment)
  };
  if (out.thesis_check && typeof out.thesis_check === 'object' && !Array.isArray(out.thesis_check)) a.thesis_check = out.thesis_check;
  // fit_check 重新判定(补素材那一轮):按 trait 合并,模型只给了改的条目时,其他条目保留
  const fits = list(out.fit_check).filter(x => x && typeof x === 'object' && !Array.isArray(x) && String(x.trait || '').trim());
  if (fits.length) {
    const merged = list(a.fit_check).map(x => ({ ...x }));
    fits.forEach(x => { const i = merged.findIndex(y => y && String(y.trait || '').trim() === String(x.trait).trim()); if (i >= 0) merged[i] = { ...merged[i], ...x }; else merged.push({ ...x }); });
    a.fit_check = merged;
    n++;
  }
  // 写法规则要的几项(埋点回收、核心两难、评论问题):AI 调整补上或改了就收下
  if (out.planted_payoff && typeof out.planted_payoff === 'object' && !Array.isArray(out.planted_payoff) && String(out.planted_payoff.what || '').trim()) a.planted_payoff = out.planted_payoff;
  if (out.hook_plan && typeof out.hook_plan === 'object' && !Array.isArray(out.hook_plan) && Object.keys(HOOK_PLAN_AT).some(k => out.hook_plan[k])) a.hook_plan = out.hook_plan;
  ['core_dilemma', 'comment_question'].forEach(k => { if (typeof out[k] === 'string' && out[k].trim()) a[k] = out[k].trim(); });
  // 主角设定:实测 run_658212aa497e 标题是「재벌가 며느리」,模块和假设场景却沿用原片的入赘女婿(妻子、岳父),稿子写成了男主角
  // 真人案例:整张替换(只收有外号或身份的)
  const cases = list(out.cases).filter(c => c && typeof c === 'object' && !Array.isArray(c) && String(c.nick || c.who || '').trim());
  if (cases.length) { a.cases = cases; markChange(a, 'cases', changeFor('cases').target ? changeFor('cases') : { fields: ['cases'], basis: '查到', reason: '补真人案例' }, batches); n++; }
  if (out.protagonist && typeof out.protagonist === 'object' && !Array.isArray(out.protagonist) && String(out.protagonist.who || '').trim()) a.protagonist = out.protagonist;
  if (out.thesis_card && typeof out.thesis_card === 'object' && !Array.isArray(out.thesis_card)) apply('thesis_card', out.thesis_card);
  if (out.hook && typeof out.hook === 'object' && !Array.isArray(out.hook) && Array.isArray(out.hook.candidates) && out.hook.candidates.length) apply('hook', out.hook);
  const addTitles = list(out.title_candidates_add).filter(t => typeof t === 'string' && t && !list((a.title || {}).candidates).includes(t));
  if (addTitles.length) {
    a.title = a.title && typeof a.title === 'object' ? a.title : {};
    a.title.candidates = [...list(a.title.candidates), ...addTitles];
    a.title.ai_added = [...list(a.title.ai_added), ...addTitles];
    markChange(a, 'title', { fields: ['candidates'], basis: '推理', reason: (changeFor('title').reason) || '补充与框架方向一致的候选标题' }, batches);
    n++;
  }
  // 调整清单按「类型 + 位置 + 影响段」合并:模型漏掉的旧项保留,只更新它这次提到的项
  if (list(out.adjustments).length) {
    const keyOf = x => [x && x.type, x && x.target, list(x && x.segments).join('/')].join('|');
    const merged = list(a.adjustments).map(x => ({ ...x }));
    list(out.adjustments).forEach(x => {
      if (!x || typeof x !== 'object' || Array.isArray(x)) return;
      const i = merged.findIndex(y => keyOf(y) === keyOf(x));
      if (i >= 0) merged[i] = { ...merged[i], ...x };
      else merged.push({ ...x });
    });
    a.adjustments = merged;
  }
  if (list(out.search_log_add).length) {
    const key = x => (x && x.looked_for || '') + '|' + (x && x.note || '');
    const seen = new Set(list(a.search_log).map(key));
    a.search_log = [...list(a.search_log), ...list(out.search_log_add).filter(x => x && !seen.has(key(x)) && seen.add(key(x)))];
  }
  return n;
}

const EVIDENCE_ROUND_NOTE = '【这一轮是补素材】上一轮调整后素材还不够:{{why}}。这一轮只做两件事:① 用上面的搜索结果补事实(新事实接着现有编号往后编,补到 {{facts_min}} 条以上,只收查得到来源的;已有事实里能补上来源、年份的也补上);② 补完后重新判定 fit_check,输出完整的 fit_check 数组(每条重新写 result 和 reason,证据补上了就改成符合或部分符合,还是不够就照实写)。其他部分只在新事实推翻了原来的数时才改。\n';

// 「AI 先调整」:可先联网查询,再一次性改事实表、论点卡、模块、留存地图、钩子、候选标题。
// draft:界面上当前的草稿(可能还没保存),以它为底;结果写回 run.analysis,改前版本存 analysis_before_adjust 便于撤回
async function runAutoAdjust(runId, draft, opts) {
  const { run, cfg, asset } = loadRunAsset(runId);
  assertReviewable(run);
  const base = draft || run.analysis;
  const shapeErr = analysisShapeError(base);
  if (shapeErr) throw Object.assign(new Error('分析结果不合格: ' + shapeErr), { status: 400 });
  const a = cloneJson(base);
  const { vars } = frameworkVars(run, asset);
  const useSearch = !!(opts && opts.search) && search.searchStatus(cfg).ready;
  const batches = useSearch ? await planAndSearch(run, cfg, vars, a, needsList(a, run), '', search.MAX_QUERIES) : [];
  const forModel = cloneJson(a);
  delete forModel.ai_marks;
  if (ledgerSayOn(run)) { stripEconRows(forModel); delete forModel.ledger_thesis; } // v1.83:补的推算行体检后重新补,不让「AI 先调整」整本抄一遍
  const prompt = fillVars(readPrompt('adjust.md'), { ...vars, search_results: search.resultsBrief(batches), analysis_json: JSON.stringify(forModel), round_note: '' });
  const out = await callJson(run, cfg, prompt, 'AI 先调整', o => typeof o === 'object' && !Array.isArray(o));
  let n = mergeAdjust(a, out, batches);
  // 素材不够就自动多搜一轮(只一轮,v1.61):补事实、重新判定 fit_check;还不够只在分析页提示,不挡写稿
  const ev0 = useSearch ? evidenceWeak(a) : { weak: false };
  if (ev0.weak) {
    const rec = { at: new Date().toISOString(), facts_before: ev0.facts, why: ev0.why };
    try {
      const b2 = await planAndSearch(run, cfg, vars, a, evidenceNeeds(a, run, ev0), '', search.MAX_QUERIES);
      const fm2 = cloneJson(a);
      delete fm2.ai_marks;
      if (ledgerSayOn(run)) { stripEconRows(fm2); delete fm2.ledger_thesis; }
      const p2 = fillVars(readPrompt('adjust.md'), { ...vars, search_results: search.resultsBrief(b2), analysis_json: JSON.stringify(fm2), round_note: EVIDENCE_ROUND_NOTE.replace('{{why}}', ev0.why.join(';')).replace('{{facts_min}}', FACTS_MIN) });
      const o2 = await callJson(run, cfg, p2, 'AI 补素材', o => typeof o === 'object' && !Array.isArray(o));
      n += mergeAdjust(a, o2, b2);
      rec.queries = b2.length;
    } catch (e) { rec.error = e.message; }
    const ev1 = evidenceWeak(a);
    rec.facts_after = ev1.facts;
    rec.still_weak = ev1.weak;
    rec.still_why = ev1.why;
    a.evidence_round = rec;
  }
  // 写稿前的账本体检:程序改正算错的行,单位混用/算不了/没出处的交给 AI 只修账本一轮
  await ledgerCheckup(run, cfg, a, vars);
  a.ledger_check = verifyLedger(a.ledger);
  const fresh = store.getRun(run.id) || run;
  // 这段可能跑了几分钟:期间任务若已确认、已进入写稿,这次结果就不能再写,
  // 否则会把分析覆盖回「未确认版」,和已经开始的稿子对不上。
  if (fresh.status !== 'awaiting_review' || fresh.analysis_confirmed) {
    throw Object.assign(new Error('任务状态已变化(当前: ' + (fresh.status || '未知') + ',可能已确认或已开始写稿),本次 AI 调整结果没有保存'), { status: 409 });
  }
  if (fresh.analysis && !fresh.analysis_original) fresh.analysis_original = cloneJson(fresh.analysis);
  // 撤销点取盘上最后一版(用户等待期间若保存过,撤销回到他保存的那版,而不是请求开始时的旧草稿)
  fresh.analysis_before_adjust = cloneJson(fresh.analysis || base);
  if (fresh.analysis && fresh.analysis.source_mapping) a.source_mapping = fresh.analysis.source_mapping; // 调整期间人改过叙事方式,以盘上为准
  fresh.analysis = a;
  fresh.analysis_edited = true;
  fresh.analysis_ai_adjusted = true;
  if (run.attempts !== undefined) fresh.attempts = run.attempts;
  if (run.search_runs !== undefined) fresh.search_runs = run.search_runs;
  fresh.analysis_adjusted_at = new Date().toISOString();
  store.saveRun(fresh);
  return { analysis: a, changed: n, searched: useSearch, queries: batches.map(b => ({ query: b.query, target: b.target, hits: (b.results || []).length, error: b.error })) };
}

// 「我的意见」要用的相关留存卡:段 → 本段卡;高峰 → 持有它的卡;事实 → 引用它的段/高峰所属卡
function cardText(asset, target, a) {
  const [k, id] = String(target || '').split(/\.(.+)/);
  const cards = retention.cardsForAsset(asset);
  let segs = [];
  if (k === 'modules') segs = [id];
  else if (k === 'retention_map') segs = cards.filter(c => (c.peaks || []).some(p => p.peak_id === id)).map(c => c.stage_id);
  else if (k === 'facts' && a) {
    const mods = (Array.isArray(a.modules) ? a.modules : []).filter(m => (Array.isArray(m.fact_ids) ? m.fact_ids : []).includes(id)).map(m => m.segment);
    const peaks = (Array.isArray(a.retention_map) ? a.retention_map : []).filter(r => (Array.isArray(r.fact_ids) ? r.fact_ids : []).includes(id)).map(r => r.source_peak);
    const peakSegs = cards.filter(c => (c.peaks || []).some(p => peaks.includes(p.peak_id))).map(c => c.stage_id);
    segs = [...new Set([...mods, ...peakSegs])];
  }
  segs = segs.filter(Boolean).slice(0, 2);
  if (!segs.length) return '(无)';
  return retention.cardsSummary(cards.filter(c => segs.includes(c.stage_id))) || '(无)';
}

// 「我的意见」:只重做一行,返回改前/改后,不落盘;人点「采用」后由前端写进草稿
async function reviseItem(runId, draft, target, note, opts) {
  const { run, cfg, asset } = loadRunAsset(runId);
  assertReviewable(run);
  const a = draft || run.analysis;
  const before = getTarget(a, target);
  if (!before) throw Object.assign(new Error('找不到要改的行: ' + target), { status: 400 });
  if (!String(note || '').trim()) throw Object.assign(new Error('意见为空'), { status: 400 });
  const { vars } = frameworkVars(run, asset);
  const useSearch = !!(opts && opts.search) && search.searchStatus(cfg).ready;
  const need = ['- ' + target + ':' + JSON.stringify(before)];
  const batches = useSearch ? await planAndSearch(run, cfg, vars, a, need, note, 4) : [];
  const prompt = fillVars(readPrompt('revise.md'), {
    ...vars,
    title: (a.title || {}).final_title || run.topic,
    thesis: JSON.stringify(a.thesis_card || {}),
    facts: (Array.isArray(a.facts) ? a.facts : []).map(f => '- ' + f.id + ' [' + (f.kind || '') + '] ' + (f.content || '') + '(' + [f.source, f.year, f.region].filter(Boolean).join(',') + ')').join('\n'),
    card: cardText(asset, target, a),
    search_results: search.resultsBrief(batches),
    target, item_json: JSON.stringify(before), note
  });
  const out = await callJson(run, cfg, prompt, '按意见重做', o => o.item && typeof o.item === 'object' && !Array.isArray(o.item));
  const ch = out.change || {};
  const tmp = { ai_marks: {} };
  markChange(tmp, target, { ...ch, by: 'revise', note }, batches);
  saveRunMerge(run); // 留住调用流水与搜索记录,不动盘上的分析/状态
  return { target, before, after: out.item, mark: tmp.ai_marks[target], reply: out.reply || '', searched: useSearch };
}

// 自写标题审核:可以用 / 不能用 + 理由;可以用时附上观众问题和期待方向,由前端写回 title
async function auditTitle(runId, draft, title) {
  const { run, cfg, asset } = loadRunAsset(runId);
  assertReviewable(run); // 审核结果只落在待确认的草稿里,已确认任务没有落点
  const t = String(title || '').trim();
  if (!t) throw Object.assign(new Error('标题为空'), { status: 400 });
  const a = draft || run.analysis || {};
  const { vars } = frameworkVars(run, asset);
  const prompt = fillVars(readPrompt('title_audit.md'), { ...vars, thesis: JSON.stringify(a.thesis_card || {}), title: t });
  const out = await callJson(run, cfg, prompt, '标题审核', o => /可以用|不能用/.test(o.verdict || ''));
  out.ok = /可以用/.test(out.verdict);
  out.title = t;
  saveRunMerge(run);
  return out;
}

module.exports = { PICKED_RULE, casesBrief, caseOneVoice, keepNotesText, buildSourceMapping, runSourceMapping, setPovMode, sourceMappingBrief, cleanSourceMapping, POV_RULES, ledgerWriteBack, ledgerProblems, ledgerCheckup, ledgerGaps, ledgerSanity, krMoney, moneyScale, ledgerSayOn, ledgerSay, ledgerSayText, ledgerSayAmounts,
  loadTrackCards, pickTrackCard, buildAnalysisPrompt, analysisBrief, HOOK_TYPES, hookType, acceptedGaps, verifyLedger,
  analysisContext, cloneJson, analysisShapeError, runAnalysis, buildCheckPrompt,
  applyK3, applyOptionExact, scriptProgramStats, v1Text, runScriptCheck,
  frameworkVars, fillVars, callJson, callWithLog, stallRounds, mergeAttempts, getTarget, setTarget, needsList, mergeAdjust, runAutoAdjust, reviseItem, auditTitle, evidenceWeak, FACTS_MIN, ledgerPending, ledgerDeviations, ledgerChoice, devPct, devRefresh, altScenario,
  ledgerValueText, ledgerId, callContinued, ECON_ANALYSIS_NOTE
};
