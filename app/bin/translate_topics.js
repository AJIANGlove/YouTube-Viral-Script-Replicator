// 任务列表「主题」中文译文批量补译(维护用)。
// 用法: node app/bin/translate_topics.js [--force] [--concurrency 4]
//   --force        已有译文的主题也重译(换模型/改提示词后刷一遍)
//   --concurrency 并发数,默认 4(不要太高,DeepSeek 免费额度有限流)
// 走「微调按钮」渠道(config.tweak,本项目为 DeepSeek),译文写 data/topic_zh.json。
// 平时不需要跑:列表接口在缺译时会自动后台补,这个脚本只是把 55 个存量主题一次跑完。
const topiczh = require('../lib/topiczh');
const store = require('../lib/store');

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const ci = argv.indexOf('--concurrency');
const concurrency = ci >= 0 ? Number(argv[ci + 1]) || 4 : 4;

(async () => {
  const runs = store.listRuns();
  const topics = [...new Set(runs.map(r => String(r.topic || '').trim()).filter(Boolean))];
  console.log(`任务 ${runs.length} 个,去重主题 ${topics.length} 个 → ${topiczh.CACHE_PATH}`);
  const r = await topiczh.backfill({ topics, force, concurrency, log: s => console.log(s) });
  console.log(`\n完成:译出 ${r.ok} · 原文即中文 ${r.skipped} · 失败 ${r.failed} · 待译 ${r.todo}`);
  if (r.failed) process.exitCode = 1;
})().catch(e => {
  console.error('补译失败:', e.message);
  process.exitCode = 1;
});
