# 项目工作约定

## SRT 入库前置质检（硬性闸门）

对任何待分析的 SRT，**必须先做结尾截断检测，再启动八阶段工作流**：

- 检测方法：`perl tools/stage1_parse.pl <file.srt> <title>` 后检查最后一个 cue 的文本——若末句没有终止标点（. ! ? 等）、在句子中间戛然而止，即判定为**结尾截断**。
- 结尾截断属于**严重隐患**：它使 closure 功能段、结尾机制分析、主承诺兑现判断建立在残缺文本上，且 duration_ms 失真导致全部 normalized 比例尺偏差。
- 处理方式：**不分析、不入库**。先把所有存在该问题的文件完整列出，提醒用户提供完整 SRT 后重跑；禁止用模型补写缺失句子。
- 建议在批量处理时对整目录统一执行此检测并一次性汇报。

## 本地修补（commit `e87e7d5`，合并上游补丁时不要弄丢）

上游 `claude-优化方案/` 的补丁**不含**这三处，重装/换机器或应用新补丁后需确认仍在：

1. **`app/server.js` 启动恢复接管 `analyzing`**：原逻辑只接 `running`，写前分析被重启打断会永久卡在「分析中」，且 UI 无出口。现在会重跑分析（停在 `awaiting_review`），已请求取消的直接落成 `cancelled`。
2. **`app/lib/retention.js` 相邻高峰间隔基准**：改用 `expected`（剔除「缺口-接受弱化」后的高峰）算原片基准。否则标了接受弱化的任务必然被判超差，软闸门白重试 2 次并永久挂 ⚠。
3. **`app/public/index.html` 的 `RUNS_STATUS_ORDER`**：补 `analyzing` / `awaiting_review`，否则列表状态筛选 chip 不渲染、URL 里的 `status=awaiting_review` 被丢弃（服务端本身支持）。

恢复方式：`git cherry-pick e87e7d5`（若与上游冲突，按上面三条逐处合并）。

## 本地修补（先写后改 v1.3 合并后，合并上游补丁时不要弄丢）

上游 v1.3 补丁（`先写后改v1.3.zip`）**不含**这几处，重装/换机器或应用新补丁后需确认仍在：

1. **`app/server.js` 启动恢复接管 `awaiting_review + draft_first`**：一键生成的「AI 先调整」阶段状态停在 `awaiting_review`（联网搜索时可达数分钟），原孤儿筛选只接 `running`/`analyzing`，进程死在这里会永久卡在「AI 调整中」。现在一并接管（走 `review.resumeDraftFirst`，分析已完成的从调整续跑不重跑）；取消清理循环同步扩展。
2. **`app/lib/review.js` `finishDraftFirst` 取消防复活**：取消接口对 `awaiting_review` 是直接落 `cancelled`（不打 `cancel_requested` 标记），原 `runDraftFirst` 只查标记，会把调整期间被取消的任务重新写成 `queued` 并点火写稿。现在两种痕迹都查。
3. **draft_first 任务屏蔽分析面板人工操作**：前端 `renderAnalysisPanel` 对 draft_first 只给只读视图（不渲染确认/保存/重跑/调整入口，`anRerunBox` 条件加 `!r.draft_first`）；服务端 `/analysis/confirm`、`/analysis/update`、`/analysis/rerun`、`/analysis/(auto-adjust|revise|title-audit)` 对 draft_first 一律 409。否则调整窗口期点「确认」会与一键生成并发双点火。
4. **`writeScript` 标 `script_check.stale_after_adopt`**：单章重写/压成过渡/撤回后，稿件检查卡沿用既有「稿子已改」提示。留存检查**不标**——它跑在 Step1 蓝图上，单章重写不动蓝图。
5. **原片译文资产级缓存**（`app/data/source_zh.json`，已入 `.gitignore`，第三方字幕衍生译文不进公开仓库）：`translateRun` 按 asset_id+分段指纹查缓存，只翻缺失段；指纹不同自动作废。上游原实现是每个 run 各翻一遍原片。

恢复方式：见本段所属提交（feature/draft-first-v1.3 上 v1.3 两个 `git am` 提交之后的那一个）。

