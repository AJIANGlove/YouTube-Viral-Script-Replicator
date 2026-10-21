# 测试基线存档区

## 目录说明(2026-07-28 归档后)

- `v1/` —— 修复前基线(原 test_baseline_v1_coffee):人工咖啡轮 + 批量 4 轮,含 D1-D7 缺陷表与归因分析
- `v2/` —— 第一/二梯队修复后复测(原 test_baseline_v2_coffee):5 轮,含 prompts/ 冻结快照
- `v3/` —— 方案 1-3(时长/词数下限/原创性举证)验证批:5 轮
- `dev/` —— 开发自测的默认导出目录(tools/serve.js /export 与 tools/run_batch.js 的默认落点)

## 注意

1. v1-v3 各目录内 README/归因文档中引用的资产路径(如 `BND_0c0c47e2-...`、`The Economics of Owning an Airport/`)是**归档前旧路径**;归档后资产统一在 `../assets/<slug>/`,映射关系见 `../tools/regen_checks.js` 的 `NAME_TO_SLUG`。
2. v1-v3 为只读存档,新测试请导出到 `dev/` 或新建 `v4/`。
3. 正式产品已移至 `../app/`(资产库 + 自动生成);本目录仅作回归测试基线。
