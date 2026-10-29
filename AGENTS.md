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

## 确认文案版本（2026-10-27 新增，本地功能）

详情页四张文案卡各有一个「确认此版本」按钮（卡内按钮组最右、竖线分隔），标记该任务最终交付的文案版本；任务列表「状态」右侧新增「确认文案版本」列展示该值。

- **数据**：`run.confirmed_version = { version: 'v1'|'v1_5'|'v2'|'v2_5', at, hash }`。行级单一值（确认 B 自动顶掉 A），再点同一版 = 取消（置 null）。`hash` 是该版文本的 sha1，只用于详情页判断「确认后内容被改过」。
- **接口**：`POST /api/runs/:id/confirm-version`，body `{version}` 或 `{version:null}` 取消。仅 `status=done` 可确认（与其它卡片按钮同一口径，未完成时按钮隐藏）；不刷新 `updated_at`（沿用 `setRunViral` 的 `touch:false`）。
- **索引**：`store.indexEntry` 增加 `confirmed`（只存 version/at，不存 hash），`INDEX_VERSION` 升到 2，旧索引自动重建。列宽：min-width 1180，主题 18 / 框架 13 / 目标 10 / 频道 7 / 状态 7 / 确认 7 / 视频 9 / 步骤 5 / 创建 9 / 结束 9 / 操作 7。
- **失效提示不自动取消确认**：V1.5/V2.5 会被指纹替换、商业化/留存采纳、强化开头原地覆盖；V1 会被终审/去AI感/补改/单章重写改写（`review.js` 的 `writeScript`）。内容变了详情页按钮/标题变琥珀色「✓ 已确认 · 内容已改」，确认本身保留。
- **样式用绿色（#059669），不用红色**：红色在本项目已固定表示失败/危险（`badge-failed`、`button.danger`、`.v13` 纯净稿红字）。
- **不联动视频推送**（每版仍各有视频按钮，推哪个版本由按钮决定）；不参与列表筛选与顶部统计（沿用爆款那套口径）。

## 检测面板类型筛选（2026-10-27 改造，三面板同口径）

详情页三个检测面板（指纹 / 商业化 / 开头留存）的类型芯片此前只控制正文高亮、列表视图完全不联动，点上去像没反应。现改为「筛选即作用域」：

- **语义（2026-10-28 改为单选）**：点芯片 = 只看该类型；**再点同一个 = 取消**；点另一个 = **直接切换**（不叠加）；首个「全部 N」还原。空数组 = 全部（`filterTypes` 仍存数组，函数保留并集能力，UI 上最多 1 个）。
- **列表与高亮同源**：`pickHits(hits, filterTypes)` 同时供 `renderXxxPanel` 的列表与 `renderXxxScript` 的正文高亮，避免"列表筛了、正文没筛"。
- **作用域（2026-10-28 按用户要求修正，勿再改回）**：`替换选中(N)/采纳选中(N)` 的 N = **全部已勾选且未替换**的项，不受筛选影响——点下去替换的就是这 N 条（含筛选外看不见的）。`全选/全不选` 仍只作用于**当前显示项**。toolbar 提示「已筛选:显示 x/y 处,全选只作用于显示项,替换含 Z 条筛选外勾选项」。
- **实现要点**：`selCount` 与 `xxxRefreshApplyBtn`、`applyXxxReplace` 取 `state.scan.hits`（全量）；只有 `renderXxxPanel` 的列表、`renderXxxScript` 的高亮、`xxxToggleAll`、toolbar 的 `offSel` 计算走 `pickHits`（筛选后）。
- **交互细节**：点芯片自动 `showList = true`（否则收起态点了没有可见结果）；选中态用 `.chip.on`（蓝底白字），不再用已删除的 `.fp-chip-off`；筛选后 0 条时给「显示全部 N 处」还原入口。
- **共用函数**：`app/public/index.html` 的 `pickHits` / `typeChipsHtml` / `filterEmptyHtml`（三个面板共用，改这里即三处同步）；面板状态字段由 `hiddenTypes` 改为 `filterTypes`（数组）。
- **不改**：服务端、检测结果结构、替换/采纳接口、`hits[].checked` 存储；筛选态不持久化（关面板即清，沿用 `closeXxxPanel` 置 null）。


## 框架库分类筛选（2026-10-27 新增，本地功能）

第 1 步「选择框架资产」与资料库「框架资产库」的筛选栏新增一行赛道 chip，按终审 5 赛道把现有 179 个框架人工归类；**只做浏览筛选，不参与 autoTrack**（终审赛道判定仍走 `track_card_name` → `MATCH` 精确相等，见 `app/lib/review.js` 的 `autoTrack`）。

- **数据**：`assets/_library/asset_categories.json`。`cats[]` 定顺序与中文名（经济拆账 / 历史与古人 / POV 与等级沉浸 / 心理与动物科普 / 通用），`items{}` 为 `asset_id → key`。**以文件实际条目为准**（2026-10-28 中午扩充后为 209 条：econ 78 / history 87 / pov 24 / science 18 / general 2，随新增资产增长）。新增资产未登记时 `track = ''`，前端单列「未分类 N」，**不并入「通用」**。
- **不写 framework.json**：`store.listAssets()` 读该文件后给每项附 `track` 字段，资产本体不动（避免被上游重跑覆盖）。按 mtime 缓存，改分类文件不需要重启进程。
- **接口变更**：`GET /api/assets` 由「数组」改为 `{ items, tracks }`；前端 `normalizeAssetPayload()` 兼容旧数组——旧接口下分类行整行不渲染，不会出现「未分类 179」。
- **前端**：`genFilter` / `libFilter` 加 `track`；`assetMatches` 先判分类、再判频道与关键词（三者「与」关系）；`trackChipsHtml()` 渲染芯片（该类有条目才显示，`:empty` 时整行隐藏）。分类行独占一行、位于频道行之上。
- **不动**：`app/prompts/final_tracks/*.md`、`app/prompts/track_cards.md`、`review.js` 的 `TRACK_KEYS` 与 `autoTrack`；卡片上不加分类标签。
- **归类口径**：按「这条框架能拍什么题」归，不按频道；同一频道可分属多类（Mack 的框架分散在 history / science / econ），同类里重复样本（服装品牌①②、墨西哥卡特尔①②、饮酒①②③）各自独立。
- **分面联动（2026-10-28 追加）**：分类行数字按「频道 + 搜索」算（忽略自身分类），频道行数字按「分类 + 搜索」算（忽略自身频道），两行的「全部」同样动态，因此 **chip 数字永远等于点进去后的条数**。搜索关键词参与联动（三条件「与」）。
- **0 条 chip 置灰不可点**（`.chip.off`，保留位置防止整行跳动）；但**已选中的 chip 即使 0 条也可点**，用于取消。
- **排序（2026-10-28 二次调整，覆盖原先的固定顺序）**：分类行与频道行都按**当前数字降序**，0 条自动后置；**选中项钉在「全部」之后**（即使 0 条也钉住，否则选完会滚出视野、无法取消）；数字并列时分类按 `cats[]` 固定顺序、频道按全量条数降序兜底。副作用（用户已知情接受）：切换筛选时 chip 会重排。
- **频道空名用 `__none` 哨兵**：原实现里 `channel === ''` 同时表示"全部"和"未分类频道"，导致「未分类」chip 点了等于没筛；现在 `f.channel === '__none'` 单独表示空频道，`assetMatches` 与 chip 的 onclick 都已适配。
- **频道行独占一行、单行横向滚动**（`nowrap + overflow-x:auto`）；分类行 5+1 个 chip 一行放得下，走换行。
- **空态**：保留已选 chip 高亮，列表区显示「没有匹配的框架」+「清除分类 / 清除频道 / 清除搜索」入口（`emptyStateHtml`）。
- **顶部计数**改为「共 N 个框架 · 当前 M 个」（筛选生效才带后半句，`assetCountText`）。
- **实现**：`facetBase(list, f, ignore)` 只对「另一维度 + 搜索」求交集；`facetChip(label, count, on, onclick)` 统一两行芯片；`channelChipsHtml(all, base, f, target)` 的 all 决定频道全集与顺序、base 只决定数字。
- **不做**：筛选状态不写 URL（与资产库其余筛选一致）。

## Step 2 分章生成与断流续写（2026-10-29，渠道 90 秒断流根治）

渠道（lk888 等中转）会在约 90 秒处切断 SSE 流且不带 `message_delta.stop_reason`。27 分钟韩文稿 Step 2 需约 1.2 万字符，90 秒产能只有 5000–9000，单次必然写不完；原实现把断流当整步失败、4 次从头重写，重试必然复现。

- **分章阈值**：`pipeline.CHAPTER_SPLIT_MIN_WORDS = 1200`。蓝图 `word_budget` 合计 ≥ 1200 且章数 ≥ 2 时，Step 2 走 `runScriptByChapters`：逐章调用（每章 200–400 词，30–60 秒），拼回整篇后照常过结构/篇幅/听感闸门。
- **断点**：`run.steps.script.segments[CHxx] = { text, chars, secs, at }`，每章写完立即 `saveRun`；任务重试/进程重启后已完成章直接复用。**步骤初始化处已用 `prevStep.segments` 保留，改 Step 2 时不要清空**。
- **断流续写**：`llmCall(cfg, messages, label, { allowPartial:true })` 断流时返回 `partial:true` 而不是抛错，分章内从断点续写本章；Step 4 整篇断流时按蓝图章节边界续写（最多 4 轮），不再整篇重来。
- **空响应降级**：`fastFailEmpty:true` 时首轮空响应不原地重试 4 次（原实现每次白等约 90 秒），且**直接抛原始错误**（保留 `kind='empty'` 与留痕文件名）；分章层给每章 `CHAPTER_EMPTY_TRIES=3` 次机会，前两次空响应后分别等 `EMPTY_BACKOFF_MS=[5000,15000]` 并换「不要思考、直接写正文」的提示重发；三次仍空才报「Step 2 分章失败(CHxx)」。
- **错误字段不能丢**：`llmCall` 包装"共 N 次调用均失败"时**必须**带上 `lastErr.kind` / `lastErr.partial`。2026-10-29 就因为这两行缺失，外层 `e.kind === 'empty'` 永远不成立，兜底重试被短路（日志显示「共 1 次」而非 3 次）。以后改这段务必保留。
- **闸门重试**：分章模式下篇幅/听感闸门的整篇重写会再次撞断流，已改为 `reset:true` 逐章全量重写（`listenGate` 第 7 个参数 `rewriteAll`）。**以后新增任何闸门重试，若在分章模式走整篇 `callLlm`，会退化成必然失败**。
- **失败留痕**：`llmCall` 对 HTTP 错误/空响应/断流把响应体前 4KB 写 `app/data/logs/llm_*.txt`（已 gitignore），错误信息带文件名。排查渠道问题先看这里：能区分「只吐 thinking」「渠道 200 带 error 体」「流被网关切断」。
- **单测**：`runScriptByChapters` 是模块级导出，用桩 `callLlm` 可覆盖正常/空响应降级/断流续写/断点续跑/多写章节五条路径。
