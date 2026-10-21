// 资产包严格校验:以现有 5 个资产为通过标准
const EXPECTED = {
  framework: 'framework',
  timeline: 'timeline',
  style: 'style',
  examples: 'reference_examples'
};

function validateBundle(files) {
  const errors = [];
  const parsed = {};

  for (const key of ['framework', 'timeline', 'style', 'examples']) {
    if (!files[key] || !files[key].trim()) { errors.push(`缺少 ${key}.json 内容`); continue; }
    try { parsed[key] = JSON.parse(files[key]); }
    catch (e) { errors.push(`${key}.json 不是合法 JSON: ${e.message.slice(0, 60)}`); }
  }
  if (errors.length) return { ok: false, errors };

  for (const [key, expected] of Object.entries(EXPECTED)) {
    if (parsed[key].asset_type !== expected) errors.push(`${key}.json 的 asset_type 应为 "${expected}",实际 "${parsed[key].asset_type}"`);
  }

  const versions = new Set(Object.values(parsed).map(j => j.schema_version));
  if (versions.size !== 1) errors.push(`schema_version 不一致: ${[...versions].join(' / ')}`);

  const bundles = new Set(Object.values(parsed).map(j => j.asset_bundle_id));
  if (bundles.size !== 1) errors.push(`asset_bundle_id 不一致: ${[...bundles].join(' / ')}`);

  const fwId = parsed.framework.framework_id;
  if (!fwId) errors.push('framework.json 缺少 framework_id');
  for (const key of ['timeline', 'style', 'examples']) {
    if (parsed[key].framework_id !== fwId) errors.push(`${key}.json 的 framework_id 与 framework.json 不一致`);
  }

  const caseIds = new Set(Object.values(parsed).map(j => j.source_case_id));
  if (caseIds.size !== 1) errors.push(`source_case_id 不一致: ${[...caseIds].join(' / ')}`);

  if (!parsed.framework.data || !parsed.framework.data.structure_pattern) errors.push('framework.json 缺少 data.structure_pattern');
  if (!parsed.timeline.data || !parsed.timeline.data.observed_segments) errors.push('timeline.json 缺少 data.observed_segments');
  if (!parsed.style.data || !parsed.style.data.voice_persona) errors.push('style.json 缺少 data.voice_persona');

  const exList = parsed.examples.examples;
  if (!Array.isArray(exList)) errors.push('examples.json 缺少 examples 数组');
  else if (exList.length < 1) errors.push('examples.json 的 examples 数组为空');

  return { ok: errors.length === 0, errors, parsed };
}

// 从资产提取摘要卡
function summarize(parsed) {
  const fw = parsed.framework, tl = parsed.timeline, ex = parsed.examples;
  const d = fw.data || {}, tld = tl.data || {};
  return {
    name: d.name || '(未命名框架)',
    description: (d.description || '').slice(0, 200),
    content_type: (d.content_profile || {}).content_type || '',
    narrative_mode: (d.content_profile || {}).narrative_mode || '',
    source_title: (fw.provenance || {}).source_title || '',
    source_title_zh: (fw.provenance || {}).source_title_zh || '',
    source_duration_ms: (fw.provenance || {}).source_duration_ms || (tld.duration_profile || {}).observed_duration_ms || null,
    wpm: (tld.subtitle_metrics || {}).average_words_per_minute || null,
    chapters: (d.structure_pattern || []).length,
    example_count: (ex.examples || []).length,
    best_topic_traits: ((d.transferability || {}).best_topic_traits || []).slice(0, 3),
    status: fw.status || 'candidate',
    channel: (fw.provenance || {}).channel || ''
  };
}

module.exports = { validateBundle, summarize };
