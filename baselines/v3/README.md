# 测试基线 v3(方案 1-3 修复验证批)· 2026-07-28

## 用途

验证三项修复是否生效(对照 `../test_baseline_v2_coffee/` 同轮数据):

1. **P1 时长漂移**:prompt1 增加"全片总时长 = video_goal"硬约束 + 校验器总时长检查;
2. **P4 偏稀章节**:prompt2 词数规则从"±10%"改为"90%-110%,不足按 information_goal 扩写,禁止注水";
3. **P2 签名句残留**:prompt3 原创性豁免必须举证具体 pattern_id,否则默认 blocker。

## 测试范围

仅重跑 v2 中时长漂移的两轮:

| 本目录 | 主题 | v2 对照 | v2 问题 |
|--------|------|---------|---------|
| outputs1 | The Economics of Owning a Casino | v2 outputs2 | 全片 16:00(目标 10:00),5 章偏稀 |
| outputs2 | Why Mongol Armies Never Starved | v2 outputs4 | 全片 14:59(目标 10:00),2 章偏稀 |

输入与 v2 完全相同(资产、主题、Audience、模型配置),唯一变量为上述三处提示词/校验改动。

## 验收标准

- 末章结束时间 = 10:00(蓝图与脚本);
- 偏稀章数较 v2 同轮下降,且无 200wpm+ 超标回潮;
- 查重命中不回升(0-2 处,公式句式豁免须有 pattern_id);
- audit 的 evidence_quote 零幻觉、Change Log 零伪造(修复不得引起质检回退)。

## 流程约定(方案 4 · P0 人工事实核对)

Step 3 跑完后、Step 4 之前:人工逐条核对 audit 的 `factual_claims` 清单,确认错误的断言在 audit JSON 中追加一条 `severity: "blocker"` 的 issue,再运行 Step 4。批量脚本模式无人工程序,故批量产物的 factual_claims 均为**未核实**状态,使用时需知。

## 注意

- 提示词来源:`test_workflow.html` DEFAULT_PROMPTS(v3 版,随 outputsN/prompts/ 存档);v2 版快照在 `../test_baseline_v2_coffee/prompts/`。
- 第三梯队(事实候选池/检索 Agent)仍未实施。
