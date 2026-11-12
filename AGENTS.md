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
> **v1.29 清理扩展**：上游 v1.29 新增 `steps.opening_fix`（自动改开头，后台跑 2–3 分钟），包内**未**加启动清理；本地已在 `server.js` 的 `stuck` 列表补 `opening_fix`，崩溃后落 failed、页面可手动重跑，**不自动续改**（避免自动改稿）。以后合并上游需确认该键仍在。

## 本地模型调用（2026-11-10，本地功能，合并上游补丁时不要弄丢）

详情页「网页版写稿·等你粘贴」每张卡新增「本地模型调用」：把这一条自动发给局域网里的本地模型服务，拿回回答直接当作人工粘贴提交。**不是 API 渠道**，不出现在设置页的渠道单选/步骤渠道里。

- **配置**：`config.json` 的 `local_service`（`url` / `token` / `enabled` / `poll_ms` / `max_missing_polls`）。不进 `providers`，`GET /api/settings` 不返回，页面不渲染。token 明文，`config.json` 不入库。
- **入口**：`manual.localRun(runId, id)` ← `POST /api/runs/:id/web` `{ action: 'local', id }`；前端 `webLocalBar` 生成按钮与进度，`webLocal` 发请求。
- **窗口策略**：第 1 条按卡片 `p.how`（`new`→`always`、`continue`→`never`），同一条 pending 的后续消息一律 `never`（写稿分批在同一个对话里接着发）。
- **顺序**：`localChain` 全局串行（进程内 Promise 链），一次只跑一条链，保证 `never` 复用对话时不会插进别的任务的消息。
- **失败**：停在待粘贴，`p.local.next` 记失败那条，再点从那条继续，已成功的批次不重发；不做自动重试。
- **重启**：`resetInterrupted()` 在 `server.listen` 里把 `local.running/queued` 落成 `failed`，不自动重投。
- **提交**复用 `manual.answer()`，章节解析、对话记录、唤醒管线与人工粘贴完全一致。
- **轮询（2026-11-11 改单任务查询）**：`GET /tasks/:id`（同时接受 id 和 seq，返回 `{ok, task}`），5 秒一次；不再每次拉全量 `/queue`（队列越积越多，单次几百 KB）。`config.json` 的 `poll_ms` 默认 5000。
- **状态映射（2026-11-11 适配新版服务）**：`done` → 提交；`failed` / `timeout` / `interrupted` / `cancelled` / `legacy` → 一律判失败，**不提交半截内容**（`timeout` 的 `reply` 是半截正文 + 网页 UI 噪音，如 `2m 59s` / `running`）。等待本身不设上限，交给本地服务的 30 分钟无变化超时。
- **完整正文（2026-11-12 修）**：`/tasks/:id` 的 `reply` / `message` 是列表用的 **300 字摘要**，完整正文在 `fullReply` / `fullMessage`；`localWait` 必须取 `fullReply || reply`，`hasFullBody === false` 直接判失败。曾因只读 `reply` 导致写稿只解析出 CH01、误报「还缺 CH02…CH10」，事后还错怪本地服务截断。
- **队列级原因**：入队后查一次 `GET /queue`，把 `paused` / `stats.waitingFor` / `quota.blocked` 写进 `p.local.waiting_for` + `wait_ms`；任务自身的 `reason` 在状态变化时同步。界面显示「静默时段 2-7，暂不发送 · 约 22:00 恢复」。静默时段按 `quietTz: America/Los_Angeles`，不是北京时间。
- **没有管理权限**：普通 token 调 `POST /tasks/:seq/cancel` 返回「管理操作需要管理员令牌（本机访问免令牌）」。**入队后无法从我们这边取消或删除**，只能在那台 Mac 的本地服务页面上操作。
- **完成留痕（2026-11-11 补）**：`finish(web, p, content, how, meta)` 增加第 5 个参数，`answer(runId, id, text, opts)` 增加 `opts.by` / `opts.meta`。本地提交记 `by:'local'` 并写 `task_id` / `elapsed_ms` / `timed_out` / `sent` / `total` / `started_at`；人工粘贴仍是 `'paste'`，`useApi` 仍是 `'api'`。旧记录没有这些字段，前端按「人工」显示。
- **界面反馈（2026-11-11 补）**：面板顶部加「最近完成」绿色横幅（取 30 分钟内最后一条 `by:'local'`，不是严格最后一条，避免随后的人工粘贴把它顶掉）；「已完成 N 条」改成可展开列表（来源 / 字数 / 耗时 / 时间）；进行中显示 排队 / 发送 / 生成 / 已返回 / 提交 五段文案 + 已等时长 + 上一条耗时；提交后空窗提示「上一条已提交(来源),程序正在跑下一步」。
- 代码与注释统一叫「本地模型」，不写「桥接」。合并上游时按本节逐条核对。

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

第 1 步「选择框架资产」与资料库「框架资产库」的筛选栏新增一行赛道 chip，按终审 5 赛道把现有 179 个框架人工归类；**只做浏览筛选，不参与 autoTrack**（终审赛道判定仍走 `track_card_name` → `MATCH` 精确相等，见 `app/lib/review.js` 的 `autoTrack`）。**（2026-11-05 修正：分类还会作为第 2 步「频道方向（审稿赛道）」的默认值，见下下节；`autoTrack` 函数本身仍不读分类。）**

- **数据**：`assets/_library/asset_categories.json`。`cats[]` 定顺序与中文名（经济拆账 / 历史与古人 / POV 与等级沉浸 / 心理与动物科普 / 通用），`items{}` 为 `asset_id → key`。**以文件实际条目为准**（2026-10-31 扩充后为 213 条：econ 79 / history 87 / pov 27 / science 18 / general 2，随新增资产增长）。新增资产未登记时 `track = ''`，前端单列「未分类 N」，**不并入「通用」**。
- **不写 framework.json**：`store.listAssets()` 读该文件后给每项附 `track` 字段，资产本体不动（避免被上游重跑覆盖）。按 mtime 缓存，改分类文件不需要重启进程。
- **接口变更**：`GET /api/assets` 由「数组」改为 `{ items, tracks }`；前端 `normalizeAssetPayload()` 兼容旧数组——旧接口下分类行整行不渲染，不会出现「未分类 179」。
- **前端**：`genFilter` / `libFilter` 加 `track`；`assetMatches` 先判分类、再判频道与关键词（三者「与」关系）；`trackChipsHtml()` 渲染芯片（该类有条目才显示，`:empty` 时整行隐藏）。分类行独占一行、位于频道行之上。
- **不动**：`app/prompts/final_tracks/*.md`、`app/prompts/track_cards.md`、`review.js` 的 `TRACK_KEYS` 与 `autoTrack`；卡片上不加分类标签。
- **归类口径**：按「这条框架能拍什么题」归，不按频道；同一频道可分属多类（Mack 的框架分散在 history / science / econ），同类里重复样本（服装品牌①②、墨西哥卡特尔①②、饮酒①②③）各自独立。
- **分面联动（2026-10-28 追加）**：分类行数字按「频道 + 搜索」算（忽略自身分类），频道行数字按「分类 + 搜索」算（忽略自身频道），两行的「全部」同样动态，因此 **chip 数字永远等于点进去后的条数**。搜索关键词参与联动（三条件「与」）。
- **0 条 chip 置灰不可点**（`.chip.off`，保留位置防止整行跳动）；但**已选中的 chip 即使 0 条也可点**，用于取消。
- **排序（2026-10-30 定为固定顺序，勿再改成动态排序）**：分类行按 `cats[]` 顺序、频道行按全量条数降序；筛选时**只变数字与置灰，chip 位置不动**。曾试过「按当前数字降序 + 选中项钉前」（2026-10-28），用户反馈点完 chip 整行重排、第二次点击容易点错，已回退——0 条只置灰不后置。
- **频道空名用 `__none` 哨兵**：原实现里 `channel === ''` 同时表示"全部"和"未分类频道"，导致「未分类」chip 点了等于没筛；现在 `f.channel === '__none'` 单独表示空频道，`assetMatches` 与 chip 的 onclick 都已适配。
- **频道行独占一行、单行横向滚动**（`nowrap + overflow-x:auto`）；分类行 5+1 个 chip 一行放得下，走换行。
- **空态**：保留已选 chip 高亮，列表区显示「没有匹配的框架」+「清除分类 / 清除频道 / 清除搜索」入口（`emptyStateHtml`）。
- **顶部计数**改为「共 N 个框架 · 当前 M 个」（筛选生效才带后半句，`assetCountText`）。
- **实现**：`facetBase(list, f, ignore)` 只对「另一维度 + 搜索」求交集；`facetChip(label, count, on, onclick)` 统一两行芯片；`channelChipsHtml(all, base, f, target)` 的 all 决定频道全集与顺序、base 只决定数字。
- **不做**：筛选状态不写 URL（与资产库其余筛选一致）。

## 框架分类手动更改（2026-11-05 新增，本地功能）

框架卡底栏（「详情」与「查看原文」之间）新增「更改分类」小按钮，用于人工修正赛道分类；数据仍写 `assets/_library/asset_categories.json` 的 `items[asset_id]`，**不写 `meta.json` / `framework.json`**。

- **口径（用户 2026-11-05 明确）**：只能从现有 5 个赛道里选，**不允许清空为「未分类」**，因此接口没有「清除」路径，面板也不列「未分类」。新导入资产（`POST /api/assets` 后未登记）仍是 `track:''`，可以在面板里"新增归类"，但已归类的永远回不到未分类。
- **接口**：`POST /api/assets/:id/category`，body `{track}`；只接受 `cats[].key`（econ/history/pov/science/general），传空或未知 key 一律 400。返回 `{ok,id,track,unchanged}`。
- **写入**：`store.setAssetTrack(id,key)` 读-改-写整份 JSON，保留 `version` / `note` / `cats` 与 `items` 原有键序、2 空格缩进、末尾换行；落盘走 `asset_categories.json.tmp` + `rename`（tmp 已加 `.gitignore`），写失败不留半截文件。同分类再点 = `unchanged:true` 且**不写盘、不动 mtime**。写完重置 `catCache`，下次读取按新 mtime 重载，**改分类不需要重启进程**。
- **入口只有两处**：第 1 步选择框架、资料库框架资产库（`groupedAssetHtml(..., {allowTrackEdit:true, trackTarget})`）。第 2 步「已选框架」预览卡**不加**（避免建任务前手滑改掉刚定好的框架）。
- **交互**：点按钮在下方弹 `.track-pop` 小面板（5 项，当前项打勾高亮，顶部写「当前：XX」），**选中即存、无二次确认**；再点同一按钮 / 点空白 / Esc / 滚动 / 缩放都收起。按钮 `title` 里带当前分类（卡面**仍不加**分类标签，避免与频道 tag 混淆）。
- **保存后**：同时更新 `genAssets` / `libAssets` 内存值并双双重绘（重绘后补回「已选」蓝框，见 `renderGenAssetList` 尾部）；当前筛选是别的分类时卡片会立刻消失，toast 明确说「当前筛选下不再显示它」。
- **影响面**：改完分类后，**新建任务**的第 2 步「频道方向」默认值会跟着变（index.html 的 `gotoStep2` 取 `a.track`）；**已建任务不受影响**（`run.review_track` 建任务时已锁定，`lockedTrack` 优先）。
- **不改**：`app/prompts/final_tracks/*.md`、`track_cards.md`、`review.js` 的 `TRACK_KEYS` / `autoTrack`；新增赛道必须另配提示词，不能只往 json 里加 key。
- **提交**：改分类只产生该 json 的一行 diff，**不自动 commit / 不自动 push**（`assets/` 在公开仓库里，对外动作由人决定）。

## Step 2 分章生成与断流续写（2026-10-29，渠道 90 秒断流根治）

渠道（lk888 等中转）会在约 90 秒处切断 SSE 流且不带 `message_delta.stop_reason`。27 分钟韩文稿 Step 2 需约 1.2 万字符，90 秒产能只有 5000–9000，单次必然写不完；原实现把断流当整步失败、4 次从头重写，重试必然复现。

- **分章阈值**：`pipeline.CHAPTER_SPLIT_MIN_WORDS = 1200`。蓝图 `word_budget` 合计 ≥ 1200 且章数 ≥ 2 时，Step 2 走 `runScriptByChapters`：逐章调用（每章 200–400 词，30–60 秒），拼回整篇后照常过结构/篇幅/听感闸门。
- **断点**：`run.steps.script.segments[CHxx] = { text, chars, secs, at }`，每章写完立即 `saveRun`；任务重试/进程重启后已完成章直接复用。**步骤初始化处已用 `prevStep.segments` 保留，改 Step 2 时不要清空**。
- **断流续写**：`llmCall(cfg, messages, label, { allowPartial:true })` 断流时返回 `partial:true` 而不是抛错，分章内从断点续写本章；Step 4 整篇断流时按蓝图章节边界续写（最多 4 轮），不再整篇重来。
- **空响应降级**：`fastFailEmpty:true` 时首轮空响应不原地重试 4 次（原实现每次白等约 90 秒），且**直接抛原始错误**（保留 `kind='empty'` 与留痕文件名）；分章层给每章 `CHAPTER_EMPTY_TRIES=3` 次机会，前两次空响应后分别等 `EMPTY_BACKOFF_MS=[5000,15000]` 并换「不要思考、直接写正文」的提示重发；三次仍空才报「Step 2 分章失败(CHxx)」。
- **错误字段不能丢**：`llmCall` 包装"共 N 次调用均失败"时**必须**带上 `lastErr.kind` / `lastErr.partial`。2026-10-29 就因为这两行缺失，外层 `e.kind === 'empty'` 永远不成立，兜底重试被短路（日志显示「共 1 次」而非 3 次）。以后改这段务必保留。
- **闸门重试**：分章模式下篇幅/听感闸门的整篇重写会再次撞断流，已改为 `reset:true` 逐章全量重写（`listenGate` 第 7 个参数 `rewriteAll`）。**以后新增任何闸门重试，若在分章模式走整篇 `callLlm`，会退化成必然失败**。
- **失败留痕**：`llmCall` 对 HTTP 错误/空响应/断流把响应体前 4KB 写 `app/data/logs/llm_*.txt`（已入库，2026-10-29 用户要求不排除），错误信息带文件名。排查渠道问题先看这里：能区分「只吐 thinking」「渠道 200 带 error 体」「流被网关切断」。
- **单测**：`runScriptByChapters` 是模块级导出，用桩 `callLlm` 可覆盖正常/空响应降级/断流续写/断点续跑/多写章节五条路径。

## 列表「进行中」阶段副标（2026-10-30 新增，本地功能）

列表的「状态」列原来只显示 `run.status`（完成/生成中/失败），进行中的任务看不出卡在哪一步（详情页红圈那种「进行中（补改后复审）」列表里没有）。现在进行中的任务在徽标下方多一行深蓝药丸：`● 终审 · 复审`。

- **数据**：`store.indexEntry` 新增 `active_pass = { key, label, stage, at }`，`INDEX_VERSION` 升到 **3**（旧索引自动重建）。`queryRuns` 整条 item 透传，无需再改接口。
- **判定**（`store.activePass`）：仅 `status ∈ {running, analyzing, awaiting_review}` 有值；遍历 `ACTIVE_STEP_LABELS`，取 `steps[key].status === 'running'` 且 `started_at` 最新的一个；`at` **取 `run.updated_at`**（阶段切换才落盘，用它判「卡住」比 started_at 准，长阶段不会被误判）；过程记录缺失时按 `current_step` 兜底成「第N步 蓝图/脚本/审核/优化」。
- **前端**（`index.html` 的 `runProgressHtml`）：药丸 `font-size:10.5px`、深蓝 `#1d4ed8` 实底 + 白点 `pulse` 动画 + 外发光；文本最多 2 行（`-webkit-line-clamp`），完整内容在 `title`；**与状态徽标重复时整块隐藏**（如徽标「AI 调整中」+ 副标「AI 调整」）。
- **卡死转灰**：`Date.now() - at > 15 分钟` 时加 `.stale`（灰底、圆点停闪），title 提示「进程可能已停」，避免崩溃残留一直闪把警示用掉。
- **必须同步的指纹**：`loadRuns` 的 `runsSig` 里已加 `active_pass`。**不加的话阶段变化不触发重绘，副标会一直停在旧阶段**（3s 轮询靠这个签名去抖）。
- **列宽**：状态 7%→10%、主题 18%→15%（合计仍 101%）、`min-width` 1180→1200，避免挤到操作列换行。
- **不动**：状态机、`STATUS_LABELS`/`statusLabel`（「待换赛道/待选审稿意见」等派生状态照旧）、筛选 chip、爆款、详情页。

## 列表「评分」列（2026-10-30 新增，本地功能）

「状态」列右侧新增「评分」列，把原先只有进详情页才看得到的两个分数搬到列表：上排灰底 = 二稿审稿报告分（`审稿 65`，0–100），下排蓝底 = 终审七维平均分（`终审 4.6`，0–10）。

- **数据**：`store.indexEntry` 新增 `score = { audit, final }`，`INDEX_VERSION` 升到 **4**（旧索引自动重建）。`queryRuns` 整条透传，`/api/runs` 已在 `{...it}` 里带出，无需改接口。
  - `audit` ← `steps.reverse_audit.score`（审稿报告总评分，AI 每份报告给一个 0–100）。
  - `final` ← `review.final.scores_after` 按 `review.final.dims` 取数值平均（1 位小数），即**最后一次复审/补审后的七维平均**；`dims` 缺失时退回对 `scores_after` 全部数值取平均。
  - 两个分数**口径不同（0–100 vs 0–10），只分开展示，不加权、不合成**；没跑到该阶段为 `null`。
- **前端**：`scoreCell(r.score)`。两个都空 → 单个 `—`（与频道/视频列的空值一致）；只有一个时另一个显示灰字「审稿 —」/「终审 —」，方便一眼看出「报告出了但还没终审」。
- **颜色**：审稿用中性灰（`#f3f4f6`/`#4b5563`）、终审用蓝（`#dbeafe`/`#1d4ed8`）。**不用红色**——红色在本项目固定表示失败/危险；分数低不等于任务失败。
- **必须同步的指纹**：`loadRuns` 的 `runsSig` 里已加 `r.score = [audit, final]`，否则重跑审稿/终审后列表 3s 轮询不重绘。
- **列宽**：新增列 6%，框架 13%→12%、目标 10%→9%、频道 7%→6%、确认文案版本 7%→6%、是否生成视频 9%→8%、步骤 5%→4%、操作 7%→6%（主题 15%、状态 10%、两个时间列 9% 不动，合计 100%），`min-width` 1200→1260。
- **不动**：筛选/排序/CSV（本来就没有排序与导出）、详情页、爆款逻辑、`reverse_audit` 与 `review.final` 的写入路径。

## 列表「主题」中文译文（2026-10-30 新增，本地功能）

主题多是韩文/英文，列表里看不出讲什么。现在主题原文下方多一行小字中文译文（灰字，比「源:」那行深一档）：

- **数据**：`app/data/topic_zh.json`（`{version, items:{"<主题原文>": {zh, at, skipped?}}}`），按**主题文本**缓存——同一选题的多个任务共用一条译文。**不入库**（`.gitignore` 已加，与 `runs.index.json` 同性质）；换机器重跑 `node app/bin/translate_topics.js` 即可。**不写 run 文件**，所以 `INDEX_VERSION` 没动。
- **接口**：`GET /api/runs` 里 `topiczh.ensure(items.map(i=>i.topic))` 排后台队列，返回体每条 `{...it, topic_zh}` 现查现拼（不 await 翻译）。
- **前端**：`runRowHtml` 主题单元格加 `<span class="sub topic-zh">`；`runsSig` **必须**含 `r.topic_zh`（否则译文补上后 3s 轮询不重绘）。样式（2026-10-30 按要求加强）：**字号继承 td，与主题同大**（不再缩成 11px）；浅灰底 `#f1f5f9` + 左蓝条 `3px #93c5fd` + 右圆角做成引文块，`width:fit-content`（短译文只占文字宽、长的自动换行），`margin: 8px 0 4px` 与主题上下留空。
- **翻译渠道**：走 `pipeline.loadTweakConfig()`（「微调按钮」渠道，本项目 = DeepSeek `deepseek-flash`），提示词内联在 `lib/topiczh.js`（三行指令，不进 `prompts/`、不用同步 README 表）。
- **并发**：固定并发池 **4**（`TOPIC_ZH_CONCURRENCY` 环境变量可覆盖，上限 8），单进程内排队逐条落盘；同一主题失败 10 分钟冷却、连续 3 次放弃（仅内存，重启重置）。
- **三个触发点**：①建任务 `POST /api/runs` 后立刻 `ensure([topic])`；②`GET /api/runs` 兜底（漏译的、进程重启期间建的）；③启动时把存量任务主题全挂一遍（只排缺译的）。都有缓存/`isChinese` 拦截，不会重复烧 token。
- **原文即中文**：`isChinese()` 判定（CJK 数 ≥ 拉丁/谚文/假名数）→ 缓存记 `skipped:'zh'`，前端不显示（显示就是重复一遍原文）。
- **`max_tokens` 必须 ≥800**：给 200 实测出现「空响应」和截断（「汗蒸房门票30」），因为 DeepSeek 会先花 token 思考。
- **只有列表展示**：详情页标题、搜索关键词匹配（`queryRuns` 的 `q` 仍只搜原文）都不动。

## 详情页「开头留存检查」面板跨任务残留（2026-10-30 修复）

切任务（换文章/新建任务/换框架跳到新任务）后，详情页下方仍显示上一篇任务的「开头留存检查 — V1.5 文案 · N 处命中」、评分与原文摘录，点「收起」才消失。

- **根因**：`openRun()` 只清了 `fpState` / `cpState` 并隐藏 `#fp-panel` / `#cp-panel`，漏了 `orState` 与 `#or-panel`。面板是静态 `div`，不随 `loadRunDetail` 重绘，旧 innerHTML 一直留着；而 `orHitsFor()` 有 runId 守卫，所以正文高亮没了、面板内容还在，看起来像「结果还挂在这篇新文章上」。
- **修法**：`openRun()` 里补 `orState = null` + `#or-panel` 加 `hidden`；`renderOrPanel()` 开头加兜底 `if (!orState || orState.runId !== currentRunId) { orState = null; 隐藏; return; }`。以后新增同类"检测面板"（有独立 state + 常驻 div）必须同时在这两处登记。
- **不需要重启**：只改 `app/public/index.html`，刷新页面即生效。

- **列宽**：主题 15%→17%、框架 12%→11%，`min-width` 1260→1300。

## 资产详情弹窗（2026-11-02 新增，本地功能，纯只读）

资料库「框架资产库」与第 1 步「选择框架资产」的卡片各有一个「详情」入口（`assetCard` 共用渲染，一次改动两处生效），打开资产详情弹窗，五个 tab 展示四层资产 + 留存卡，**不加编辑、不改资产文件**。

- **接口**：`GET /api/assets/:id` 由「仅 meta」扩展为 `{ id, meta, framework, timeline, style, examples, retention_cards }`（后五层解析成 JSON 对象，缺失/损坏为 null）。`source.srt` 不进首包，仍走既有的 `/api/assets/:id/source`（source.html 原文对照页在用）。
- **前端**：`#asset-modal`（复用 `.modal-mask` 体系，`.ad-box` 加宽到 1080），状态 `adState` + `adCache`（按 id 缓存）；`openAssetDetail(id)` / `closeAssetDetail()` / `adTab(t)` / `adExFilter(t)`。六个 tab：**怎么写（默认 tab，施工视角：一句话套路/适合与别碰 → 前 30 秒清单(标题公式+兑现方式+节奏锚点+must_deliver 勾选单) → 写作步骤卡(按 normalized_pattern×原片时长/总词数换算「约N秒/约N词」，任务取留存卡 abstract_move、备料取 replacement_needs，可删性 pill 同留存卡 tab) → 禁区(style.forbidden_style+migration_rules) → 语气速记；留存卡缺失时回退 structure_pattern 的 purpose/required_payload）**、框架（概览→核心引擎→标题契约→受众→故事引擎→结构段卡→留存机制→情绪曲线→迁移规则）、时间轴（纯 SVG：段带 + 高峰气泡(大小=强度) + 悬念开合线(虚线=未闭合、嵌套在第二行) + 留存事件刻度 + Hook 窗口琥珀带，悬停原生 title 出详情；下方段时间列表 + 节奏规则）、风格（人格/语气条/句长实测或低质量说明/节奏/语言模式/禁用）、样本（类型 chip 单选筛选 + 原文引文块 + 中文四行说明）、留存卡（7 项全展示，可删性 pill：不可删蓝/可并入琥珀/可删灰）。
- **「用这个框架写稿」按钮**：弹窗 `modal-foot` 常驻（左「查看原文」链接、右主按钮），`adWriteWith(id)` = 关弹窗 → `showView('generate')` → `await loadGenAssets()` → `selectAsset(id)` → `gotoStep1(true)`。loadGenAssets 幂等，重复调用安全。
- **约定**：全部类名 `ad-` 前缀；红色只表失败/危险（弹窗内不用）；样本原文保持源语言、说明中文；`adState` 为常驻 state，开新弹窗时整体重置（不同资产不串数据，参考 or-panel 残留修复的教训）。
- **验证方法**：`node tools/.work/test_asset_detail.js`（从 index.html 抽 ad* 模块喂真实资产做渲染冒烟：六个 tab 无 undefined/NaN、SVG 有图形、样本筛选工作、空数据降级 ad-empty、无留存卡时「怎么写」回退正常、写稿跳转链路顺序正确）。改弹窗渲染后应重跑。

## 框架包下载 zip（2026-11-11 新增，本地功能）

资产详情弹窗标题栏右侧（关闭按钮左边）新增「下载框架 zip」，把当前框架的**全部原始数据** + 一份说明文件打成 zip，供外部 AI/同事直接使用。

- **接口**：`GET /api/assets/:id/download` → `application/zip`；`Content-Disposition` 同时给 `filename="frame-<id>.zip"`（ASCII 兜底）与 `filename*=UTF-8''框架-<id>.zip`（中文名）。内存直出，不落盘、不留临时文件。
- **打包内容**：`<id>/` 目录下 `README.md` + `meta.json` / `framework.json` / `timeline.json` / `style.json` / `examples.json` / `retention_cards.json` / `source.srt`；有 `source_zh.srt` 的资产一并带上（当前 10 个）。原始文件逐字节照搬，不做重新序列化。
- **README.md 结构**：0 三十秒速读（含骨架总表：步号 / stage_id / 功能 / 占比 / 折算秒数 / 折算词数 / 可删性）→ 1 包内文件清单 → 2 字段字典（逐文件逐字段：是什么 + 拿它干什么）→ 3 可直接复制给 AI 的写作指令（由 framework + timeline + retention_cards 现场编译：标题公式、兑现方式、must_deliver 清单、节奏锚点、逐步施工表、禁区、语气、输出要求）→ 4 来源与使用限制（原片字幕仅研究用途）。
- **实现**：`app/lib/assetzip.js`，零依赖——`zlib.deflateRawSync` 手写本地文件头 + 中央目录 + EOCD，CRC32 自算；包内文件名全 ASCII，避免解压端编码乱码。`store.assetTrack(id)` 为新增只读方法，只用于往 README 里写分类名。
- **异常口径**：文件缺失或 JSON 解析失败**不阻断下载**，坏文件照原样打进包，README 顶部标 ⚠ 列出是哪些文件；资产不存在返回 404 JSON。前端按钮走 fetch（不是直接跳转），失败时按钮显示「下载失败」并 alert 原因，不会把浏览器带到一段 JSON 报错页。
- **与「怎么写」tab 的差异（勿改回）**：tab 把 `title_hook_contract.must_deliver` 放在「前 30 秒必须完成」里，但这批条目含结尾要落的账；README 改称「必须在成片里全部兑现（前 30 秒是主战场）」，不对外宣称只是前 30 秒。
- **验证方法**：`node -e "const az=require('./app/lib/assetzip.js');require('fs').writeFileSync('x.zip',az.build('<id>').buffer)"` 后 `unzip -t x.zip`；或遍历 `assets/*/` 逐个 build，检查 README 不出现 `undefined` / `NaN` / `[object Object]`。既有弹窗冒烟 `node tools/.work/test_asset_detail.js` 仍应全绿。
- **需要重启**：改了 `app/server.js` + 新增 `app/lib/assetzip.js`，必须重启进程；`index.html` 部分刷新即可。
