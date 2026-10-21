# 测试基线 v2(修复后复测)· 2026-07-28

## 用途

本目录保存**第一梯队(确定性校验)+ 第二梯队(提示词修复)落地后**的 4 轮复测产物,与 `../test_baseline_v1_coffee/`(修复前基线)逐项对照,验证修复是否有效。

## 与 v1 的对照关系

- 输入完全相同:同样的 4 个资产目录、4 个新主题、Audience Context(English / US / 18-45岁 / 10分钟)、模型配置(claude-opus-4-8 / 0.7 / 8192)。
- 唯一变量:提示词(v2 修复版,取自 test_workflow.html DEFAULT_PROMPTS,随各轮 outputsN/prompts/ 存档)+ 程序校验报告注入 Step 3。
- 验收标准:`../test_baseline_v1_coffee/README.md` 的 D1-D7 缺陷表 + `../test_baseline_v1_coffee/ATTRIBUTION_ANALYSIS.md` 的复测验收项。

## 目录结构

每个 outputsN/ 与 v1 同构,另多一个:

- `checks.txt` —— 确定性校验报告(蓝图/脚本查重、词密度、audit 引用存在性、终稿元评论/before校验/时间漂移),v1 没有此文件。
- `prompts/` —— v2 测试实际使用的四步提示词冻结快照(2026-07-28 存档;后续提示词改动不影响本目录含义)。

## 轮次对照

| 轮次 | 主题 | v1 位置 |
|------|------|---------|
| outputs1 | The Psychology of Cats That Slowly Blink at You | v1 outputs1 |
| outputs2 | The Economics of Owning a Casino | v1 outputs2 |
| outputs3 | When Did Ancient Humans First Eat Chili Peppers? | v1 outputs3 |
| outputs4 | Why Mongol Armies Never Starved | v1 outputs4 |
| outputs5 | When did ancient humans begin drinking coffee?(吸烟资产,补测) | v1 根目录 outputs/(人工基线) |

## 注意

- 第三梯队(事实候选池)未实施,D3 类问题(事实硬伤)预期**不会**因本次修复消失,验收时不计入失败。
- 脚本执行:`API_KEY=... node run_batch.js`(提示词从 test_workflow.html 提取,页面模板改动会直接反映到批量执行)。
