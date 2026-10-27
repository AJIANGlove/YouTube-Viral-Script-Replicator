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
5. ~~**原片译文资产级缓存**~~（v1.3 曾加，**v1.6 起移除**）：v1.6 去掉了原片段中文对照、翻译改为按文本哈希（同任务内自动去重），资产级缓存失去作用对象。`app/data/source_zh.json` 与 `.gitignore` 对应两条已删。

恢复方式：见本段所属提交（feature/draft-first-v1.3 上 v1.3 两个 `git am` 提交之后的那一个）。

## 本地修补（v1.6 二稿审稿报告合并后，合并上游补丁时不要弄丢）

上游 v1.6 累计包（`v1.6二稿审稿报告.zip`，0001–0005）**不含**这几处；其中 1–4 是从 v1.3 自修适配重打（上游 v1.4/v1.5 重写了同区域代码，每次合并都要确认仍在）：

1. **接管/防复活/面板屏蔽/stale 标记**＝上一节 1–4 条在 v1.6 代码上的适配重打（`finishDraftFirst` 尾部改为 `runPasses`；其余位置相同）。
2. **`/review/pass` 并发守卫（`review.passBusy`）**：进程内 Set，任一 pass（初稿检查/审稿报告/终审）在跑就 409。用进程内集合而非 run 文件的 running 状态——进程重启后集合自然清空，崩溃留下的假 running 不会挡续跑。`startFinal` 同样先查它。
3. **启动时的崩溃 passes 处理**：状态停在 `done` 的卡住任务（`draft_check`/`reverse_audit` 卡 running）对 draft_first 自动 `resumeDraftFirst` 续跑（只补检查和报告）；卡在 `final_review` 的、及非 draft_first 任务手动重跑被中断的，把假 running 落成 failed（可在审稿页手动重跑）——**终审绝不自动跑**。

恢复方式：见本段所属提交（feature/draft-first-v1.6 上合并提交之后的那一个）。

> **v1.8 重打记录**：上游 v1.8（0008/0009）依然不含上述修复；终审从单次调用改成 `runFinal` 三步（审稿→修改→复审，分赛道），但重打点不变——`runPasses`（守卫包住 runFinal 路由）、`startFinal`（passBusy + 赛道存取）、`runDraftFirst`/`resumeDraftFirst`/`writeScript`/exports 逐项重打，提交见 feature/final-tracks-v1.8 上合并提交之后的那一个。server.js 上游连续三轮未触碰，本地修复无损存活。
>
> **v1.10 重打记录**：上游 v1.10（0010–0015）仍不含上述修复，但**增量叠加可行**——在 `claude-v18-series` 链顶（已入本地历史）直接 `git am 0010-0015`，合并基点是真祖先，唯一冲突是 review.js exports 行（合并双方导出名即可）。另新增一处本地修复：**启动崩溃清理扩展到 `steps.deai`**（去AI感卡 running 会被 `deaiGuard` 永久挡死；落成 failed 手动重跑，去AI感绝不自动续跑）。

## 视频推送文案 == 纯净稿（2026-10-26，跨文件不变量，改清洗规则时两处必须同步）

「存草稿 / 自动生视频」推送的正文必须与「下载纯净稿」逐字节相同，否则同一版本文案在两处内容不同。

- 前端：`app/public/index.html` 的 `cleanScriptText`（作用在页面 DOM 文本，下载/复制/弹窗预览共用）。
- 服务端：`app/lib/video.js` 的 `cleanScript`（作用在 run 里的原始字段，`server.js` 的 `pushToVideo` 调用）。
- 规则：去 `Optimized Script` / `Final Script` 标题行（含 `# Optimized Script: XXX` 整行）、`[CH..]` 章节标签行、Markdown 小标题行、分隔线（`---` 等），剥整行加粗外壳，折叠多余空行。
- 历史差异（已修）：服务端只删标题**前缀**，`# Optimized Script: XXX` 会留 `: XXX` 残片；且未删 `---` / `##` 小标题 / 加粗外壳 —— 52 个有文案版本里 18 个不一致。
- 改任一处的校验方法：从 index.html 抽 `CH_TAG_LINE`→`cleanScriptText` 整段 eval 出函数，与 `video.cleanScript` 对 `app/data/runs/*.json` 的四个脚本字段逐字节比对，必须 0 差异。

