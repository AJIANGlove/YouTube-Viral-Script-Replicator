// 流程 A1:给资产生成留存卡,写入 assets/<id>/retention_cards.json
// 用法:
//   node bin/build_retention_cards.js              只生成程序部分(高峰、悬念按位置比例挂到段上),全部资产
//   node bin/build_retention_cards.js --ai         另外调用 LLM(prompts/retention_card.md)给每段补 abstract_action / replace_when
//   node bin/build_retention_cards.js <id> [--ai]  只处理一个资产
// 已有 AI 说明的资产再次运行时保留原说明,除非加 --force
const fs = require('fs');
const path = require('path');
const store = require('../lib/store');
const retention = require('../lib/retention');
const checks = require('../lib/checks');
const pipeline = require('../lib/pipeline');

const args = process.argv.slice(2);
const useAi = args.includes('--ai');
const force = args.includes('--force');
const only = args.find(a => !a.startsWith('--'));

async function aiNotes(asset, cards) {
  const cfg = pipeline.loadConfig();
  if (!cfg || !cfg.api_key) throw new Error('未配置 API Key');
  const fw = JSON.parse(asset.framework);
  const structure = ((fw.data || fw).structure_pattern || []).map(s => '- ' + s.stage_id + ' ' + s.function + ':' + (s.purpose || '')).join('\n');
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'retention_card.md'), 'utf-8')
    .replace('{{structure}}', structure)
    .replace('{{cards}}', retention.cardsSummary(cards));
  const r = await pipeline.llmCall(cfg, [{ role: 'user', content: tpl }], '留存卡 ' + asset.id);
  const s = checks.stripFence(r.content.trim());
  const m = s.match(/\[[\s\S]*\]/);
  const arr = m ? JSON.parse(m[0]) : [];
  if (!Array.isArray(arr)) throw new Error('输出不是 JSON 数组');
  return arr;
}

(async () => {
  const ids = only ? [only] : store.listAssets().filter(a => !a.broken).map(a => a.id);
  let okN = 0;
  for (const id of ids) {
    const asset = store.getAsset(id);
    if (!asset || !asset.framework || !asset.timeline) { console.log('跳过(缺 framework/timeline): ' + id); continue; }
    let cards = retention.cardsForAsset(asset); // 已含旧的 AI 说明
    if (useAi && (force || !cards.some(c => c.abstract_action))) {
      try {
        const notes = await aiNotes(asset, cards);
        const byId = {};
        notes.forEach(n => { if (n && n.stage_id) byId[n.stage_id] = n; });
        cards = cards.map(c => ({ ...c, abstract_action: (byId[c.stage_id] || {}).abstract_action || c.abstract_action, replace_when: (byId[c.stage_id] || {}).replace_when || c.replace_when }));
      } catch (e) { console.log('AI 说明失败(仍写入程序部分): ' + id + ' — ' + e.message); }
    }
    const out = { generated_at: new Date().toISOString(), source: 'build_retention_cards.js' + (useAi ? ' --ai' : ''), cards };
    fs.writeFileSync(path.join(store.ASSETS_ROOT, id, 'retention_cards.json'), JSON.stringify(out, null, 2), 'utf-8');
    const peaks = cards.reduce((n, c) => n + c.peaks.length, 0);
    console.log('✓ ' + id + ':' + cards.length + ' 段,' + peaks + ' 个高峰');
    okN++;
  }
  console.log('完成 ' + okN + '/' + ids.length);
})();
