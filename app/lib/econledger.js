// v1.83 经济拆账:税只算到税前、「如果」推算和全年合计写进账本、论点和账本对账
// 实测 빙수 那篇(여름 메뉴인 줄 알았지? 빙수 장사의 진짜 수익 구조):
// ① 增值税按营业额 ×10%、所得税按营业额 ×1.5% 扣,都是错的;
// ② 论点「夏天赚的被淡季吃掉」被稿子自己的数推翻(淡季每月只亏约 5 万,夏季每月剩几百万);
// ③ 外卖占比 50% → 68% 时保本线应约 735 万,稿子写了 680 万 ——「如果」推算是 AI 在稿子里自己算的,程序不核。
// 做法:税拆不清就只算到税前;「如果」推算、全年合计由 AI 写成账本行(只给公式),程序算数;
// 账本定了以后单独一次小调用核对论点,对不上就换账本撑得住的角度(尽量保住标题)。
// 只给经济拆账(ledgerSayOn)用;每次调用只输出新增的几行或一张小 JSON,不让大 JSON 变长(用户 2026-11-04:一定不能截断)。
const fs = require('fs');
const path = require('path');
const A = () => require('./analysis');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');
const readPrompt = f => fs.readFileSync(path.join(PROMPTS_DIR, f), 'utf-8');
const arr = v => (Array.isArray(v) ? v : []);
const str = v => String(v == null ? '' : v).trim();

const MAX_NEW_ROWS = 10;      // 一次最多补的行
const MAX_LEDGER_ROWS = 40;   // 账本总行数上限(超过就不再补)
const REF_RE = /L\d+[a-z]?(?![a-z\d])/gi;
const MONEY_RE = /KRW|원|won|₩|韩元|韓元/i;

// ---------- 税 ----------
const TAX_RE = /부가세|부가가치세|增值税|VAT|소득세|所得税|법인세|종소세|税金|税费|세금/i;
const VAT_RE = /부가세|부가가치세|增值税|VAT|매출세액|매입세액|销项|进项/i;
const INCOME_TAX_RE = /소득세|所得税|법인세|종소세/;
const PRETAX_RE = /세전|税前|세후|税后|pre-?tax|after-?tax|세금 ?제외|세금 ?빼/i;
const REVENUE_RE = /매출|营业额|營業額|销售额|銷售額|营收|營收|收入|revenue|sales/i;
const PROFIT_RE = /이익|利润|利潤|结余|結餘|순익|수익률|到手|profit/i;

const rowsOf = a => arr(a && a.ledger).filter(l => l && typeof l === 'object' && !Array.isArray(l));
const idOf = (l, i) => String(l.id || ('L' + (i + 1)));
const refsOf = l => (String((l && l.formula) || '').match(REF_RE) || []);
function taxRows(a) { return rowsOf(a).filter(l => TAX_RE.test(String(l.item || '')) && !PRETAX_RE.test(String(l.item || ''))); }
// 税有没有出处:引用的事实里至少一条是「事实」且写了来源
function taxSourced(a, l) {
  const facts = arr(a && a.facts);
  return arr(l.fact_ids).some(id => { const f = facts.find(x => x && x.id === id); return f && /事实/.test(f.kind || '') && str(f.source); });
}
// 程序查得出来的税的问题(只给经济拆账):[{ id, kind:'tax', text }]
function taxProblems(a) {
  const rows = rowsOf(a);
  const byId = {};
  rows.forEach((l, i) => { byId[idOf(l, i)] = l; });
  const out = [];
  rows.forEach((l, i) => {
    const id = idOf(l, i), item = String(l.item || '');
    if (!TAX_RE.test(item) || PRETAX_RE.test(item)) return;
    const head = id + ' ' + item;
    const drop = '拿不准就删掉这一行,引用它的公式里把它去掉,利润行的 item 写成「세전 …」(税前),稿子里一句「세금은 따로」带过';
    if (!taxSourced(a, l)) { out.push({ id, kind: 'tax', unsourced: true, text: head + ' 是税,但事实表里没有税率和计税方法的出处:按规则利润只算到税前——' + drop }); return; }
    const f = String(l.formula || '').replace(/\s+/g, '');
    const refs = refsOf(l).filter(r => byId[r]);
    const revRef = refs.find(r => REVENUE_RE.test(String(byId[r].item || '')) && !PROFIT_RE.test(String(byId[r].item || '')));
    if (VAT_RE.test(item) && f && refs.length === 1 && /[*/]/.test(f) && !f.includes('-')) {
      out.push({ id, kind: 'tax', text: head + ' 的公式 ' + f + ' 把增值税当成「某个数 × 税率」直接扣了。卖价含增值税:销项税 = 含税营业额 × 10/110(不是 × 10%),进项税 = 能抵扣的含税进货额(食材、包装、平台手续费)× 10/110,增值税 = 销项 - 进项,拆成三行写公式;' + drop });
      return;
    }
    if (INCOME_TAX_RE.test(item) && revRef) out.push({ id, kind: 'tax', text: head + ' 的公式 ' + f + ' 按营业额(' + revRef + ')算所得税:所得税要按利润(税前利润那一行)算,不按营业额;' + drop });
  });
  return out;
}
// AI 修了一轮税还是不对:程序把税的行去掉,利润只算到税前(引用它的公式里删掉「- Lx」「+ Lx」,利润行 item 标「세전」)
function detax(a, ids) {
  const rows = rowsOf(a);
  const drop = new Set(arr(ids));
  if (!drop.size) return [];
  const removed = [];
  const keep = [];
  rows.forEach((l, i) => { if (drop.has(idOf(l, i))) removed.push({ id: idOf(l, i), item: l.item || '' }); else keep.push(l); });
  const changed = new Set();
  keep.forEach(l => {
    let f = String(l.formula || '');
    if (!f) return;
    drop.forEach(id => { f = f.replace(new RegExp('\\s*[+\\-]\\s*' + id + '(?![a-z\\d])', 'gi'), ''); });
    f = f.replace(/\(\s*\)/g, '').trim();
    if (f !== String(l.formula || '')) { l.formula = f; changed.add(l); }
    // 还引用着被删的行(乘除、开头):这一行算不了,去掉公式,后面体检会标「不许用」
    if (refsOf(l).some(r => drop.has(r))) { l.formula = ''; l.bad = '依据的税的行已删掉(税只算到税前)'; }
  });
  // 跟着变的利润行标「세전」
  const changedIds = new Set([...changed].map(l => l.id));
  keep.forEach(l => {
    const hit = changed.has(l) || refsOf(l).some(r => changedIds.has(r));
    if (hit && PROFIT_RE.test(String(l.item || '')) && !PRETAX_RE.test(String(l.item || ''))) { l.item = String(l.item || '') + ' (세전)'; changedIds.add(l.id); }
  });
  a.ledger = keep;
  return removed;
}

// ---------- 「如果」推算和全年合计 ----------
const SEASON_RE = /계절|여름|겨울|봄|가을|비수기|성수기|시즌|淡季|旺季|夏|冬|季节|季節|全年|一年|整年|一整年|연간|1년|일 년|한 해|일년|年度|年底|年收/;
const SCENARIO_RE = /^\s*(만약|如果|假如|가정|假设|假定|if\b)/i;
const ANNUAL_ITEM_RE = /연간|년간|全年|一年|整年|1년|일 ?년|한 ?해|annual|yearly/i;
function thesisText(a) {
  const t = (a && a.thesis_card) || {}, ti = (a && a.title) || {};
  const h = (a && a.hook) || {}, ch = arr(h.candidates)[h.chosen || 0] || {};
  return [ti.final_title, ti.viewer_question, ti.expected_answer_direction, t.viewer_belief, t.truth, t.one_line_thesis, t.ending_landing, t.contrast, ch.text].map(str).filter(Boolean).join(' / ');
}
function needsAnnual(a) { return SEASON_RE.test(thesisText(a)); }
function isAnnualRow(l) {
  const u = String((l && l.unit) || '').split('/').slice(1).join('/');
  return !!(l && (l.annual || (str(l.formula) && (/年|년|year/i.test(u) || ANNUAL_ITEM_RE.test(String(l.item || ''))))));
}
function annualRows(a) { return rowsOf(a).filter(isAnnualRow); }
function scenarioRows(a) { return rowsOf(a).filter(l => l.scenario); }
function nextId(rows) {
  let n = 0;
  rows.forEach((l, i) => { const m = idOf(l, i).match(/^L(\d+)/i); if (m) n = Math.max(n, Number(m[1])); });
  return n + 1;
}
const normItem = s => String(s || '').replace(/[\s()()\[\]:：·,.,。-]/g, '').toLowerCase();

// 账本(带程序算的数、[如果]/[全年] 标记)给 AI 看
function ledgerText(a) {
  const an = A();
  const rows = rowsOf(a);
  an.verifyLedger(rows);
  return rows.map((l, i) => {
    const n = l.program_amount != null ? Number(l.program_amount) : Number(String(l.amount == null ? '' : l.amount).replace(/,/g, ''));
    return '- ' + idOf(l, i) + (l.scenario ? ' [如果]' : '') + (isAnnualRow(l) ? ' [全年]' : '') + ' ' + (l.item || '') + ' = ' + (isFinite(n) ? an.ledgerValueText(l, n) : '(算不了)') +
      (l.formula ? ' [= ' + l.formula + ']' : '') + (arr(l.fact_ids).length ? '(' + l.fact_ids.join(',') + ')' : '') + (l.bad ? '(有问题,不许用)' : '');
  }).join('\n') || '(无)';
}
function annualNote(a) {
  if (!needsAnnual(a)) return '';
  return annualRows(a).length
    ? '【全年】论点涉及季节或全年,账本里的 [全年] 行就是全年合计,季节、全年的说法要拿它检验。'
    : '【全年】论点涉及季节或全年,但账本里还没有全年合计行。';
}

// 新增行:编号冲突的换新号(连同新行之间的引用一起换),公式算不了的丢掉(连同依赖它的新行),最多 MAX_NEW_ROWS 行
function mergeNewRows(a, rowsIn) {
  const an = A();
  const old = rowsOf(a);
  const room = Math.max(0, Math.min(MAX_NEW_ROWS, MAX_LEDGER_ROWS - old.length));
  const have = new Set(old.map(idOf));
  // 重复 = 项目名一样、公式也一样(原始数:数也一样);「如果」的行项目名常和原来那行一样(변동비율、손익분기),公式不同就不算重复
  const sig = l => normItem(l.item) + '|' + (str(l.formula) ? String(l.formula).replace(/\s+/g, '') : '=' + Number(String(l.amount == null ? '' : l.amount).replace(/,/g, '')));
  const haveItems = new Set(old.map(sig));
  // 换新号从「旧行和模型想用的编号」里最大的往后排,不会撞上后面新行自己的编号
  let next = Math.max(nextId(old), nextId(arr(rowsIn).filter(l => l && typeof l === 'object').map(l => ({ id: str(l.id) || 'L0' }))));
  const rename = {};
  const add = [];
  arr(rowsIn).filter(l => l && typeof l === 'object' && !Array.isArray(l) && str(l.item)).forEach(l => {
    if (add.length >= room) return;
    if (haveItems.has(sig(l)) || haveItems.has(sig({ ...l, item: String(l.item || '').replace(SCENARIO_RE, '').replace(/^\s*[::]\s*/, '') }))) return; // 已经有了,不重复加
    const want = str(l.id);
    const id = !want || have.has(want) || add.some(x => x.id === want) ? 'L' + (next++) : want;
    if (want && id !== want) rename[want] = id;
    const m = id.match(/^L(\d+)/i); if (m) next = Math.max(next, Number(m[1]) + 1);
    const kind = str(l.kind);
    const row = { id, item: str(l.item), value: '', amount: Number(String(l.amount == null ? 0 : l.amount).replace(/,/g, '')) || 0, unit: str(l.unit), formula: str(l.formula), fact_ids: arr(l.fact_ids).map(String), added_by: 'econ', ...(str(l.for) ? { for: str(l.for).slice(0, 120) } : {}) };
    if (/如果|만약|if/i.test(kind) || SCENARIO_RE.test(row.item)) row.scenario = true;
    if (/全年|연간|annual/i.test(kind)) row.annual = true;
    if (/比例|%/.test(kind)) row.ratio = true;
    add.push(row);
    haveItems.add(sig(row));
  });
  // 新行之间引用的旧编号换成新编号(只换新行里的;旧行编号不动)
  if (Object.keys(rename).length) add.forEach(l => { l.formula = l.formula.replace(REF_RE, r => (rename[r] && add.some(x => x.id === rename[r]) && !have.has(r) ? rename[r] : r)); });
  // 公式算不了的新行丢掉,依赖它的新行也丢掉
  const dropped = [];
  for (let k = 0; k < 5; k++) {
    const test = old.concat(add);
    const chk = an.verifyLedger(test);
    const bad = new Set(chk.errors.map(e => String(e).split(' ')[0]).filter(id => add.some(x => x.id === id)));
    if (!bad.size) break;
    for (let i = add.length - 1; i >= 0; i--) if (bad.has(add[i].id)) dropped.push({ id: add[i].id, item: add[i].item, why: '公式算不了' }), add.splice(i, 1);
  }
  // 引用了「如果」行的,也是「如果」推算
  const scen = new Set(old.concat(add).filter(l => l.scenario).map(l => l.id));
  for (let k = 0; k < 4; k++) add.forEach(l => { if (!l.scenario && refsOf(l).some(r => scen.has(r))) { l.scenario = true; scen.add(l.id); } });
  // 「如果」行 item 不是「만약」开头的补上;没出处的原始数标「가정」(否则体检报没出处)
  add.forEach(l => {
    if (l.scenario && !SCENARIO_RE.test(l.item)) l.item = '만약: ' + l.item;
    if (!l.formula && !l.fact_ids.length && !/假设|假定|가정|추정|估算|예시|assum/i.test(l.item)) l.item += ' (가정)';
  });
  a.ledger = old.concat(add);
  an.ledgerWriteBack(a);
  an.verifyLedger(a.ledger);
  return { added: add.map(l => ({ id: l.id, item: l.item, scenario: !!l.scenario, annual: isAnnualRow(l), value_text: an.ledgerValueText(l, Number(l.program_amount != null ? l.program_amount : l.amount)) })), dropped, room };
}

async function extendLedger(run, cfg, a) {
  const an = A();
  const old = rowsOf(a);
  if (old.length >= MAX_LEDGER_ROWS) return { ran: false, why: '账本已有 ' + old.length + ' 行,到上限 ' + MAX_LEDGER_ROWS + ' 行,不再补' };
  const room = Math.min(MAX_NEW_ROWS, MAX_LEDGER_ROWS - old.length);
  const prompt = an.fillVars(readPrompt('ledger_extend.md'), {
    topic: run.topic || '', title: ((a.title || {}).final_title) || run.topic || '',
    thesis: JSON.stringify(a.thesis_card || {}),
    hook: str((arr((a.hook || {}).candidates)[(a.hook || {}).chosen || 0] || {}).text) || '(无)',
    modules: arr(a.modules).filter(m => m && !/删除/.test(m.decision || '')).map(m => '- ' + (m.segment || '') + ':' + String(m.reason || '').slice(0, 160)).join('\n') || '(无)',
    facts: arr(a.facts).filter(f => f && f.id).map(f => '- ' + f.id + ' [' + (f.kind || '') + '] ' + String(f.content || '').slice(0, 200)).join('\n') || '(无)',
    ledger: ledgerText(a),
    annual_note: needsAnnual(a) && !annualRows(a).length ? '【要补全年合计】论点涉及季节或全年,账本里还没有全年合计行:按下面第 2 条补上。' : '【不用补全年合计】' + (needsAnnual(a) ? '账本里已经有全年合计行。' : '论点不涉及季节、全年。'),
    next_id: 'L' + nextId(old), max_rows: room
  });
  const out = await an.callJson(run, cfg, prompt, '账本补推算行', o => o && typeof o === 'object' && Array.isArray(o.rows));
  const m = mergeNewRows(a, out.rows);
  return { ran: true, ...m, notes: str(out.notes).slice(0, 300) };
}

// ---------- 论点和账本对账 ----------
function normVerdict(v) {
  const s = String(v || '');
  if (/对不上|對不上|不成立|推翻|矛盾/.test(s)) return '对不上';
  if (/算不出|没算|沒算|无法|無法/.test(s)) return '账本算不出';
  if (/对得上|對得上|成立/.test(s)) return '对得上';
  return '';
}
function checkOk(o) { return o && typeof o === 'object' && !Array.isArray(o) && !!normVerdict(o.verdict); }
// 账本 + 事实里出现过的数(钱按「원」,百分比按数值),新论点里的数要在里面
function knownNumbers(a) {
  const an = A();
  const rows = rowsOf(a);
  an.verifyLedger(rows);
  const out = [];
  rows.forEach(l => { const n = l.program_amount != null ? Number(l.program_amount) : Number(String(l.amount == null ? '' : l.amount).replace(/,/g, '')); if (isFinite(n) && n) out.push(Math.abs(n), Math.abs(n * (MONEY_RE.test(String(l.unit || '')) ? an.moneyScale(l.unit) : 1))); });
  const say = an.ledgerSay(rows);
  arr(say.waterfalls).forEach(w => { out.push(Math.abs(w.end_pct)); w.steps.forEach(s => out.push(Math.abs(s.pct), Math.abs(s.left))); });
  arr(say.daily).forEach(d => out.push(Math.abs(d.value)));
  arr(a.facts).forEach(f => (String(f.content || '').match(/\d[\d,]*(?:\.\d+)?/g) || []).forEach(x => out.push(Number(x.replace(/,/g, '')))));
  return out.filter(n => isFinite(n) && n);
}
// 文字里的数:「735만」「1억 2,000만」「68%」「5만 원」;年份、个位数不管
function numbersIn(text) {
  const out = [];
  const s = String(text || '');
  for (const m of s.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(억|천만|백만|만|천)?\s*(%|퍼센트|원|元)?/g)) {
    const raw = m[0].trim(); let v = Number(m[1].replace(/,/g, ''));
    if (!isFinite(v)) continue;
    v *= ({ '억': 1e8, '천만': 1e7, '백만': 1e6, '만': 1e4, '천': 1e3 }[m[2]] || 1);
    const pct = !!m[3] && /%|퍼센트/.test(m[3]);
    if (!m[2] && !m[3] && (v < 100 || (v >= 1900 && v <= 2100))) continue;
    out.push({ raw, value: v, pct });
  }
  return out;
}
function unverifiedNumbers(a, obj) {
  const known = knownNumbers(a);
  const text = Object.values(obj || {}).map(str).join(' ');
  return numbersIn(text).filter(x => !known.some(k => x.pct ? Math.abs(k - x.value) <= 0.6 : Math.abs(k - x.value) <= Math.max(x.value * 0.01, 5000))).map(x => x.raw);
}
function hashOf(a) {
  const an = A();
  const rows = rowsOf(a);
  an.verifyLedger(rows);
  const t = (a && a.thesis_card) || {};
  const s = JSON.stringify([rows.map((l, i) => [idOf(l, i), l.program_amount != null ? l.program_amount : l.amount, l.formula || '']), t.truth, t.one_line_thesis, t.ending_landing, ((a.title || {}).final_title) || '']);
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}
async function checkOnce(run, cfg, a, label) {
  const an = A();
  const t = a.title || {};
  const prompt = an.fillVars(readPrompt('thesis_vs_ledger.md'), {
    target_language: (run.audience || {}).target_language || '',
    title: t.final_title || run.topic || '', viewer_question: t.viewer_question || '',
    thesis: JSON.stringify(a.thesis_card || {}),
    hook: str((arr((a.hook || {}).candidates)[(a.hook || {}).chosen || 0] || {}).text) || '(无)',
    ledger: ledgerText(a),
    say: an.ledgerSayText(an.ledgerSay(rowsOf(a)), false) || '',
    annual_note: annualNote(a)
  });
  const o = await an.callJson(run, cfg, prompt, label, checkOk);
  const ids = new Set(rowsOf(a).map(idOf));
  const nt = o.new_thesis_card && typeof o.new_thesis_card === 'object' && !Array.isArray(o.new_thesis_card) ? o.new_thesis_card : {};
  return {
    verdict: normVerdict(o.verdict), calc: str(o.calc).slice(0, 600),
    conflicts: arr(o.conflicts).filter(x => x && typeof x === 'object' && str(x.claim)).slice(0, 6).map(x => ({ claim: str(x.claim).slice(0, 200), rows: arr(x.rows).map(String).filter(r => ids.has(r)), why: str(x.why).slice(0, 300) })),
    assumption_only: arr(o.assumption_only).map(str).filter(Boolean).slice(0, 6),
    new_thesis_card: Object.fromEntries(['viewer_belief', 'truth', 'one_line_thesis', 'ending_landing', 'contrast'].filter(k => str(nt[k])).map(k => [k, str(nt[k])])),
    supported_by: arr(o.supported_by).map(String).filter(r => ids.has(r)),
    title_ok: o.title_ok !== false, new_title: str(o.new_title), new_title_zh: str(o.new_title_zh), title_reason: str(o.title_reason).slice(0, 300),
    hook_text: str(o.hook_text)
  };
}
// 对不上就换角度:论点卡换成账本撑得住的(尽量保住标题),保不住标题才改标题;都记进 adjustments
function applyAngle(a, c) {
  const changes = [];
  const nt = c.new_thesis_card || {};
  if (!(nt.truth || nt.one_line_thesis)) return changes;
  const before = { ...(a.thesis_card || {}) };
  a.thesis_card_before_ledger = a.thesis_card_before_ledger || before;
  a.thesis_card = { ...before, ...nt };
  const reason = '论点和账本对不上:' + (c.calc || c.conflicts.map(x => x.claim + '→' + x.why).join(';')).slice(0, 300) + (c.supported_by.length ? '。新论点由账本 ' + c.supported_by.join('、') + ' 撑住' : '');
  a.adjustments = arr(a.adjustments).concat([{ type: '改论点', target: 'thesis_card', segments: [], peaks: [], fact_ids: [], reason, by: 'ledger_check' }]);
  changes.push('thesis_card');
  if (!c.title_ok && c.new_title) {
    a.title = a.title && typeof a.title === 'object' ? a.title : {};
    const from = a.title.final_title || '';
    if (c.new_title !== from) {
      a.title.candidates = [...new Set([...arr(a.title.candidates), from, c.new_title].filter(Boolean))];
      a.title.final_title = c.new_title;
      a.title.changed_by_ledger = { from, to: c.new_title, to_zh: c.new_title_zh, reason: c.title_reason, at: new Date().toISOString() };
      a.adjustments = a.adjustments.concat([{ type: '改标题', target: 'title', segments: [], peaks: [], fact_ids: [], reason: '换了论点还是和账本冲突:' + (c.title_reason || '标题的主张账本撑不住') + '(原标题:' + from + ')', by: 'ledger_check' }]);
      changes.push('title');
    }
  }
  if (c.hook_text) {
    const h = a.hook && typeof a.hook === 'object' ? a.hook : (a.hook = { candidates: [] });
    h.candidates = arr(h.candidates);
    const old = h.candidates[h.chosen || 0] || {};
    h.candidates.push({ text: c.hook_text, fact_ids: arr(old.fact_ids), first_payoff_sec: old.first_payoff_sec || 0, by: 'ledger_check' });
    h.chosen = h.candidates.length - 1;
    changes.push('hook');
  }
  return changes;
}
async function thesisCheck(run, cfg, a) {
  const rec = { at: new Date().toISOString(), rounds: [] };
  const c1 = await checkOnce(run, cfg, a, '论点对账');
  rec.rounds.push(c1);
  if (c1.verdict !== '对得上') {
    rec.changed = applyAngle(a, c1);
    rec.unverified = unverifiedNumbers(a, c1.new_thesis_card);
    // 换过角度复核一次(只一次;还对不上就把冲突写进写稿提醒,不再改)
    if (rec.changed.length) { try { rec.rounds.push(await checkOnce(run, cfg, a, '论点对账复核')); } catch (e) { rec.recheck_error = e.message; } }
  }
  const last = rec.rounds[rec.rounds.length - 1];
  rec.verdict = last.verdict;
  rec.assumption_only = [...new Set(rec.rounds.flatMap(r => r.assumption_only))].slice(0, 6);
  rec.remaining = last.verdict === '对得上' ? [] : last.conflicts;
  rec.hash = hashOf(a);
  return rec;
}

// 账本体检之后(经济拆账):补「如果」推算和全年合计 → 论点对账。失败不挡,结果记在 a.ledger_thesis
async function afterCheckup(run, cfg, a, opts) {
  const rec = { at: new Date().toISOString() };
  if (!(opts && opts.noExtend)) {
    try { rec.extend = await extendLedger(run, cfg, a); } catch (e) { rec.extend = { ran: false, error: e.message }; }
  } else if (a.ledger_thesis && a.ledger_thesis.extend) rec.extend = a.ledger_thesis.extend;
  rec.annual_needed = needsAnnual(a);
  rec.annual_rows = annualRows(a).map(l => l.id);
  try { Object.assign(rec, await thesisCheck(run, cfg, a)); rec.status = 'done'; } catch (e) { rec.status = 'failed'; rec.error = e.message; }
  // 换了论点以后:涉及季节、全年的新说法,账本里没全年行 → 写稿提醒里说清
  rec.annual_needed = needsAnnual(a);
  rec.annual_missing = rec.annual_needed && !annualRows(a).length;
  a.ledger_thesis = rec;
  return rec;
}
// 写稿前补一次(人工确认的任务没跑过「AI 先调整」、或者人选完账本假设后账变了):没跑过就补推算行 + 对账;账变了只重新对账
async function ensure(run, cfg) {
  const a = run && run.analysis;
  if (!a || !rowsOf(a).length || !cfg || !A().ledgerSayOn(run)) return null;
  const lt = a.ledger_thesis;
  if (lt && lt.status === 'done' && lt.hash === hashOf(a)) return null;
  return afterCheckup(run, cfg, a, { noExtend: !!(lt && lt.extend && lt.extend.ran) });
}

// 写稿、审稿看的提醒(经济拆账才有)
function briefText(a) {
  const out = [];
  const sc = scenarioRows(a), an = annualRows(a);
  const lt = (a && a.ledger_thesis) || {};
  if (sc.length) out.push('「如果」推算(账本里标了「만약」的行):稿子里说「如果……会怎样」只能用这些行的数,说的时候必须说成「만약 …라면」「…로 가정하면」,不能说成已经发生的事:' + sc.map(l => l.id).join('、') + '。');
  if (an.length) out.push('全年合计:涉及季节、「一年下来」的说法只能用这几行的数:' + an.map(l => l.id).join('、') + '。');
  else if (lt.annual_missing || needsAnnual(a)) out.push('账本里没有全年合计:不许说「一年下来」「旺季赚的被淡季吃掉」这类要算全年才知道的结论,季节只做定性描述。');
  if (!taxRows(a).length) out.push('税:账本里的利润都是税前。第一次说到利润时加一句「세금은 따로예요」(全片只说一次),不要自己扣增值税、所得税。');
  if (arr(lt.assumption_only).length) out.push('只在假设下成立的说法(必须说成「만약…」):' + lt.assumption_only.join(';'));
  if (arr(lt.remaining).length) out.push('论点对账还有对不上的地方(写前核对过,稿子里不许这么说):' + lt.remaining.map(x => x.claim + '(' + x.why + ')').join(';'));
  if (arr(lt.unverified).length) out.push('论点里这几个数账本里没有,稿子里不要用:' + lt.unverified.join('、'));
  out.push('百分比也一样:稿子里的百分比只能用账本或事实表里的数(念账表里的「占 X%」可以直接用),要说的比例账本里没有就不说。');
  return '【经济拆账:账本规则】\n' + out.map(x => '- ' + x).join('\n');
}

// 终审「论点核对」看的账本说明(经济拆账才有)
function claimNote(a) {
  const lt = (a && a.ledger_thesis) || {};
  const lines = ['(经济拆账)核对时再加三条:',
    '- 标 [如果] 的行是假设推算:稿子里用到它的结论必须说成「만약…」「…라면」,说成已经发生的事 → 关键,fix 改成假设语气。',
    '- 涉及季节、「一年下来」、全年的结论要和 [全年] 行对得上;账本里没有 [全年] 行却下了这种结论 → 关键,fix 改成账本撑得住的说法。',
    '- 税:增值税按营业额 ×10%、所得税按营业额扣都是错的(卖价含增值税,增值税 = 销项 - 进项,所得税按利润算);账本没算税时,稿子里的利润是税前,不许自己扣税另算一个数。'];
  if (arr(lt.changed).length) lines.push('- 写前分析已按账本把论点改成:' + str(((a.thesis_card || {}).one_line_thesis) || ((a.thesis_card || {}).truth)) + ';稿子还按旧论点(' + str(((a.thesis_card_before_ledger || {}).one_line_thesis)) + ')讲的 → 关键。');
  return lines.join('\n');
}
function markLedger(l) { return (l.scenario ? ' [如果]' : '') + (isAnnualRow(l) ? ' [全年]' : ''); }

module.exports = { taxRows, taxProblems, detax, needsAnnual, annualRows, scenarioRows, isAnnualRow, mergeNewRows, extendLedger, thesisCheck, checkOnce, applyAngle, afterCheckup, ensure, briefText, claimNote, markLedger, ledgerText, hashOf, unverifiedNumbers, numbersIn, normVerdict, MAX_NEW_ROWS, MAX_LEDGER_ROWS };
