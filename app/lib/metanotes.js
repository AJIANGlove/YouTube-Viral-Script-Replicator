// v1.135 稿子里不该出现的两类东西(用户 2026-11-27:V1.5 纯净稿里冒出「【待制片人确认】」+ 一段「我根据史料重建了这个世界……都是虚构的」)
// 1. 给人看的备注:【待制片人确认】(需核实)[TODO] 这类,配音稿里一律不要,程序直接删;
// 2. 创作者声明:跟观众交代「这个视频怎么做的、哪些是虚构的」。用户定了不要这种声明。
const str = v => (v == null ? '' : String(v));
// 括号里带「待…确认 / 需核实 / TODO / 占位」的备注(中文【】、方括号、圆括号)
const META_RE = /[【\[(（]\s*(?:待[^】\])）\n]{0,12}(?:确认|核实|补充|定|审)|需要?(?:确认|核实|补充|核对)|请(?:确认|核实)|TODO|TBD|FIXME|占位|placeholder|확인\s*필요|확인\s*요망)[^】\])）\n]{0,16}[】\])）]/gi;
const CREATOR_RE = [
  /(?:都是|均为|纯属|全是)虚构/, /本(?:视频|片|期|集)[^。!?\n]{0,16}(?:虚构|还原|重现|演绎|改编)/,
  /(?:我|我们)(?:根据|依据|参考)[^。!?\n]{0,30}(?:重建|还原|复原|再现)(?:了)?(?:这个世界|这段历史|当时|那个时代)/,
  /허구(?:입니다|예요|이에요|임을|라는)|픽션(?:입니다|이에요)|이 영상은[^.!?\n]{0,30}(?:허구|재구성|각색|상상)/,
  /(?:기록|사료|유적)[^.!?\n]{0,30}(?:재구성|재현|복원)(?:했습니다|했어요|한 것입니다|한 겁니다)/,
  /\b(?:is|are) (?:entirely |purely )?fictional\b/i, /\bdramati[sz]ed\b/i, /\b(?:I|we) (?:have )?reconstructed\b/i, /this video is (?:a )?(?:work of fiction|dramati)/i
];
function stripMeta(s) {
  const notes = [];
  const out = str(s).replace(META_RE, m => { notes.push(m.trim()); return ''; }).replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
  return { text: out, notes };
}
const sentences = t => str(t).split(/(?<=[.?!。？！])\s*|\n+/).map(x => x.trim()).filter(Boolean);
// 按章节扫:给人看的备注、创作者声明;返回 [{ ch, kind:'meta'|'creator', quote }]
function scan(text) {
  const hits = [];
  let ch = 'CH01';
  str(text).split('\n').forEach(line => {
    const m = line.match(/^\s*\[(CH\d+)/i);
    if (m) { ch = m[1].toUpperCase(); return; }
    (line.match(META_RE) || []).forEach(q => hits.push({ ch, kind: 'meta', quote: q.trim() }));
    sentences(line).forEach(s => { if (CREATOR_RE.some(re => re.test(s))) hits.push({ ch, kind: 'creator', quote: s }); });
  });
  return hits;
}
const hasCreator = s => sentences(s).some(x => CREATOR_RE.some(re => re.test(x)));
module.exports = { META_RE, CREATOR_RE, stripMeta, scan, hasCreator };
