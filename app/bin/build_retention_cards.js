// 流程 A1:给资产生成留存卡(7 项),写入 assets/<id>/retention_cards.json
// 用法:
//   node bin/build_retention_cards.js                全部资产,程序生成 7 项(后三项文字取自拆解阶段已有字段)
//   node bin/build_retention_cards.js <id>           只处理一个资产
//   node bin/build_retention_cards.js [id] --ai      另外调用 LLM(prompts/retention_card.md)重写 原片做法/抽象动作/替换条件
//   --force                                          覆盖已有的 AI 润色或人工修改(默认保留)
//   --library                                        另外导出替换库 assets/_library/retention_library.{json,md}
// 可删性始终按规则由程序判定;文件里的文字字段可以人工直接改,程序读取时以文件为准。
const fs = require('fs');
const path = require('path');
const store = require('../lib/store');
const retention = require('../lib/retention');
const checks = require('../lib/checks');
const pipeline = require('../lib/pipeline');

const args = process.argv.slice(2);
const useAi = args.includes('--ai');
const force = args.includes('--force');
const withLibrary = args.includes('--library');
const only = args.find(a => !a.startsWith('--'));

async function aiNotes(asset, cards) {
  const cfg = pipeline.loadConfig();
  if (!cfg || !cfg.api_key) throw new Error('未配置 API Key');
  const fw = JSON.parse(asset.framework);
  const structure = ((fw.data || fw).structure_pattern || []).map(s => '- ' + s.stage_id + ' ' + s.function + ':' + (s.purpose || '') +
    ((s.required_payload || []).length ? ';原片要素:' + s.required_payload.join('、') : '')).join('\n');
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'retention_card.md'), 'utf-8')
    .replace('{{structure}}', structure)
    .replace('{{cards}}', retention.cardsSummary(cards));
  const r = await pipeline.llmCall(cfg, [{ role: 'user', content: tpl }], '留存卡 ' + asset.id);
  const s = checks.stripFence(r.content.trim());
  const m = s.match(/\[[\s\S]*\]/);
  const arr = m ? JSON.parse(m[0]) : null;
  if (!Array.isArray(arr)) throw new Error('输出不是 JSON 数组');
  return arr;
}

function writeLibrary() {
  const lib = retention.buildLibrary(true);
  const dir = path.join(store.ASSETS_ROOT, '_library');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'retention_library.json'), JSON.stringify({ generated_at: new Date().toISOString(), version: retention.CARD_VERSION, by_peak_type: lib }, null, 2), 'utf-8');
  const types = Object.keys(lib).sort((a, b) => lib[b].length - lib[a].length);
  const md = ['# 留存功能替换库', '', '按高峰类型归类：同一类留存高峰，在别的资产里由什么抽象动作完成、需要哪类事实。每类按强度从高到低。', ''];
  types.forEach(k => {
    md.push('## ' + k + '（' + lib[k].length + ' 条）', '');
    lib[k].slice(0, 15).forEach(x => md.push('- **' + x.asset_id + ' ' + x.stage_id + '**（强度 ' + x.strength + '）动作：' + (x.abstract_move || '') + '；需要：' + (x.replacement_needs || []).join('、')));
    md.push('');
  });
  fs.writeFileSync(path.join(dir, 'retention_library.md'), md.join('\n'), 'utf-8');
  console.log('替换库:' + types.length + ' 类高峰 → assets/_library/');
}

(async () => {
  const ids = only ? [only] : store.listAssets().filter(a => !a.broken && !a.id.startsWith('_')).map(a => a.id);
  let okN = 0;
  for (const id of ids) {
    const asset = store.getAsset(id);
    if (!asset || !asset.framework || !asset.timeline) { console.log('跳过(缺 framework/timeline): ' + id); continue; }
    // --force 时从程序初稿重来;否则保留文件里已有的 AI 润色或人工修改
    let cards = force ? retention.buildCards(asset.framework, asset.timeline) : retention.cardsForAsset(asset);
    let refined = cards.some(c => c.ai_refined);
    if (useAi && (force || !refined)) {
      try {
        const notes = await aiNotes(asset, cards);
        const byId = {};
        notes.forEach(n => { if (n && n.stage_id) byId[n.stage_id] = n; });
        cards = cards.map(c => {
          const n = byId[c.stage_id];
          if (!n) return c;
          return {
            ...c,
            original_moves: Array.isArray(n.original_moves) && n.original_moves.length ? n.original_moves : c.original_moves,
            abstract_move: n.abstract_move || c.abstract_move,
            replacement_needs: Array.isArray(n.replacement_needs) && n.replacement_needs.length ? n.replacement_needs : c.replacement_needs,
            ai_refined: true
          };
        });
        refined = true;
      } catch (e) { console.log('AI 润色失败(仍写入程序版): ' + id + ' — ' + e.message); }
    }
    const out = {
      version: retention.CARD_VERSION,
      generated_at: new Date().toISOString(),
      source: refined ? 'program + ai' : 'program',
      field_sources: {
        position_peaks_loops: 'timeline.json(normalized_pattern / peak_points / open_loops / retention_events)',
        original_moves: refined ? 'LLM(prompts/retention_card.md)' : 'timeline.observed_segments.information_move',
        abstract_move: refined ? 'LLM(prompts/retention_card.md)' : 'framework.structure_pattern.purpose',
        replacement_needs: refined ? 'LLM(prompts/retention_card.md)' : 'framework.structure_pattern.required_payload(缺失时用 exit_condition)',
        deletability: '程序规则:持有高峰/跨段悬念/开场段=不可删;只有段内小悬念=可并入;都没有=可删'
      },
      cards
    };
    fs.writeFileSync(path.join(store.ASSETS_ROOT, id, 'retention_cards.json'), JSON.stringify(out, null, 2), 'utf-8');
    const peaks = cards.reduce((n, c) => n + c.peaks.length, 0);
    const del = ['不可删', '可并入', '可删'].map(k => k + ' ' + cards.filter(c => c.deletability === k).length).join(' / ');
    console.log('✓ ' + id + ':' + cards.length + ' 段,' + peaks + ' 个高峰,' + del);
    okN++;
  }
  console.log('完成 ' + okN + '/' + ids.length);
  if (withLibrary) writeLibrary();
})();
