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
- **完整正文（2026-11-12 修，11-13 再修）**：`/tasks/:id` 的 `reply` / `message` 是列表用的 **300 字摘要**；完整正文在 `fullReply`（复制纯文本，可能带弯引号）和 `fullMarkdown`（复制 Markdown，直引号）。`localWait` 取值：`fullMarkdown` 存在且以 `{` 开头（JSON 类）优先用它，否则 `fullReply`，最后 `reply`。稿件以 `[CH01 |` 开头不会误取 Markdown。`hasFullBody === false` 直接判失败。
- **弯引号修复（2026-11-13）**：网页版中文语境会把键名/值边界写成 `“”`（`#5149` 实测 2,918 个，`JSON.parse` 第 2 字符就崩）。`checks.repairCurlyQuotes` 用状态机只换字符串边界的弯引号（正文 `「」` 与值内不跟结构符号的弯引号原样保留）；`analysis.js` 的 `parseJsonLoose` 只在文本含 `“` 时才调它，不影响本来合法的内容。曾因只读 `reply` 摘要误判缺章、又只读 `fullReply` 撞弯引号。
- **等待原因实时同步（2026-11-13 修）**：`localWait` 的去重键从 `status` 改成 `status + reason`。本地服务把 `reason` 从「拟人间隔 25s」换成「额度提示仍在（已过重置时间）…」时，界面跟着更新；`waiting_for` 里带「额度 / 用尽 / 限制 / quota / limit」的标橙色 `#b45309`，其余保持紫色。曾有一条卡了 15 小时，界面一直显示过期的「拟人间隔 25s」，真实原因是 `quota.blocked: true`（Claude 账号额度用完，需在比特浏览器手动刷新）。
- **队列级原因**：入队后查一次 `GET /queue`，把 `paused` / `stats.waitingFor` / `quota.blocked` 写进 `p.local.waiting_for` + `wait_ms`；任务自身的 `reason` 在状态变化时同步。界面显示「静默时段 2-7，暂不发送 · 约 22:00 恢复」。静默时段按 `quietTz: America/Los_Angeles`，不是北京时间。
- **没有管理权限**：普通 token 调 `POST /tasks/:seq/cancel` 返回「管理操作需要管理员令牌（本机访问免令牌）」。**入队后无法从我们这边取消或删除**，只能在那台 Mac 的本地服务页面上操作。
- **完成留痕（2026-11-11 补）**：`finish(web, p, content, how, meta)` 增加第 5 个参数，`answer(runId, id, text, opts)` 增加 `opts.by` / `opts.meta`。本地提交记 `by:'local'` 并写 `task_id` / `elapsed_ms` / `timed_out` / `sent` / `total` / `started_at`；人工粘贴仍是 `'paste'`，`useApi` 仍是 `'api'`。旧记录没有这些字段，前端按「人工」显示。
- **界面反馈（2026-11-11 补）**：面板顶部加「最近完成」绿色横幅（取 30 分钟内最后一条 `by:'local'`，不是严格最后一条，避免随后的人工粘贴把它顶掉）；「已完成 N 条」改成可展开列表（来源 / 字数 / 耗时 / 时间）；进行中显示 排队 / 发送 / 生成 / 已返回 / 提交 五段文案 + 已等时长 + 上一条耗时；提交后空窗提示「上一条已提交(来源),程序正在跑下一步」。
- **会话段调度（2026-11-16 大改，取代上面的「全局串行」）**：本地服务是「每账号一个独立 worker、跨账号可并行、同账号严格串行」，`chatPolicy: never` 复用的是**该账号当前打开的 tab**（与 source/批次无关），`always` 会 SPA 新建会话并改掉当前窗口，没有入队时的会话快照。会话窗口按账号隔离，所以**段必须绑定账号**。
  - **段定义**：一个 `always` 起头 + 之后所有 `never`（直到下一个 `always` 之前）算一段；段内独占账号（含卡与卡之间的 API 步骤闲着也不让号），段与段之间可以换号或让给别人。
  - **进程内状态**：`segAccounts: Map<account, {owner, busy, chain}>`（每账号一条串行链 + 段级 owner）、`segFifo`（按 `ticket` 严格 FIFO）、`segAccountsCache`（10 秒）。**没有长文本全局锁**：服务侧的全局剪贴板锁已覆盖 `doPaste`(write+press) 与 `captureReplyMarkdown`(Copy 读回完整周期)，无锁外写剪贴板路径；曾加 `longChain` 把 `POST + localWait` 全程串行，与服务侧粘贴时刻不重叠，反而让多账号并行失效，已删。跨账号互斥交给服务侧那把锁，我方只保证同账号段级串行。
  - **落盘 `data/web/<run>.json`**：`web.segment = {account, chat_url, started_at}`（段绑定，**重启不清**）、`web.force_new`（「上一张卡被粘贴/API 打断」的一次性标记）、`web.segment_notice = {kind, text, at}`（常驻提示，刷新/切页/重启回来都在）。`kind`: `switch` 换段 / `ended` 强制结束 / `broken` 上下文中断 / `error` 普通失败 / `warn` 告警。
  - **段边界判定**（`localRun` 同步完成，立即回 200）：`retry = p.local.status==='failed' || !!p.local.account`；`force_new` 优先（一律新段）；否则 `!retry && p.how!=='continue'` 才算新段。**失败重试同一段、回原账号、不换号**；段首 `always` 失败重试仍要发 `always`（`open_anchor` 重建锚点）。
  - **分配**：`pumpSeg()` 按 ticket 顺序分配；`segChoose` 硬排除 `enabled:false/offline/paused`，软闸门（`quota.blocked`/`waitingFor`）只降权不排除，主排序 `usage.last24h` 升序 + 平手按 id。新段 `avoid_account` 排除刚释放的旧账号（**只有一个可用账号时允许复用，防死锁**）。`need_account` 的段内卡被别的段占着就排队等，绝不换号。全部账号不可用 → 停下报错，不自动换号（D3）。
  - **严格 FIFO**：run1 出现下一张 `always` 卡时释放旧账号，排队最久的 run3 先拿；run1 的新段去按均衡选另一个账号；另一个账号也被占则 run1 排队尾，不抢占、不回退。
  - **释放时机**：段切换（下一张 `always` 卡被点）、run 终态（`segSweepTerminal` 在 `pumpSeg` 里懒扫描，不依赖前端通知）、`turnOff` / `cancelRun` / 强制结束段。仍 busy 时标 `release_pending`，job 结束再放。
  - **强制结束段**：人工粘贴 `by:'paste'`、`useApi`、`turnOff` 都调 `segForceEnd()`（释放占用 + 清锚点 + `force_new=true` + notice）。**本地自动提交 `by:'local'` 属于段内延续，不结束段**。被打断后原本 `how:'continue'` 的卡只带最后一句 → 从 `waiters` 取完整 `messages` 用 `flatten()` 重发；`waiters` 空则**停下报错提示人工粘贴，绝不静默发半截**。
  - **锚点校验**：段首 `always` 完成后的 `task.url` 存 `web.segment.chat_url`；之后每批发送前用 `GET /health` **顶层** `accounts[].url` 比对（`/queue` 的 `accounts[]` 没有 url），每条 `done` 后再比 `task.url`；不一致 → 中止链、落 `failed`、红字「上下文已中断」。拿不到 url 就不拦，避免误伤。
  - **显式账号**：`localSend` 一定传 `account`，**绝不用 `auto`**（服务端按每条消息独立选号会拆断同一段）；返回里若 `tasks[0].account` 与段绑定不一致也停下。`localQueueState(cfg, account)` 必须按本链账号读 `accounts[]`（顶层 `stats`/`quota` 只代表默认账号）。
  - **其它**：`markdownSource === 'copy'` 且是 JSON 类才用 `fullMarkdown`，否则降级 `fullReply` + 弯引号修复并写 `warn`；`blocked` 状态判失败；waiting 超 6 小时只橙色告警不自动重发（额度放行以提示消失为准，不设短超时）；不设自动超时/自动重发。
  - **界面**：面板常驻横幅（中断/结束/告警）+ 「当前连续会话:账号 X」；`continue` 卡显示「连续会话 · 账号 · 段内第 N 条」；进度条显示账号与排队原因；`webRenderedKey` 含 `segment`/`notice`/`account`/`waiting_for`，否则 3 秒轮询不重绘。
  - **弯引号解析补齐（2026-11-16）**：`checks.parseJsonLoose`（原样 parse → 含 `“` 才 `repairCurlyQuotes` → 数组类补回 `{` 之前的前缀）替换 `checkBlueprint` / `checkProgression` / `checkOptimized` 三处裸 `JSON.parse`；`checkOptimized` 与 `extractFinalScript` 的 Change Log 正则/`openArr` 也兼容 `“before”`。曾因只读 `reply` 摘要误判缺章、只读 `fullReply` 撞弯引号、蓝图又提示「格式不对」。
  - **错误分层与自愈时钟（2026-11-18 根治「服务重启后任务永久卡住」）**：以前所有本地失败一律落 `failed` 终态，服务恢复后也不会自己继续；且故障期 `pumpSeg` 把账号列表降级成虚拟账号 `__default__` 写盘，服务恢复后反而被「绑定的账号不可用」挡死。根子在两处结构性缺陷：**错误无结构**（靠 `/上下文已中断/.test(msg)` 从文案猜类别）与**调度无时钟**（`server.js` 无 `setInterval`，推进全靠有人点按钮，`segKick().catch` 吞异常不重入）。根治：
    - **结构化错误** `localErr(lkind, msg, extra)`：`lkind` ∈ `infra`(连不上/服务重启/任务丢失,瞬时) / `content`(模型没跑完、格式坏、弹窗、配置错) / `context`(会话窗口或锚点变了)；`phase` ∈ `connect`(POST 之前) / `wait`(已入队) / `anchor` / `list`。全部裸 `new Error` 已改造；判断只认 `lkind`,不再 `/.test(msg)`。
    - **状态机** `queued → running → done`；`infra+connect+无 task_id` 不落终态,写 `retry_wait`(带 `attempt`/`next_at`/`task_id`/`auto_retried`)；`content`/`context` 或重投过仍失败 → `failed`。**只有 A 类(未入队)自动重投 1 次**(`/health` 恢复后,零重复点火);**B 类(已入队)绝不重新点火**,`retryReuse` 用 `GET /tasks/:id` 回查:服务侧已 `done+hasFullBody` → `localReplyOf` 直接复用提交(记 `reused:true`),否则落 `failed` 等人点一次重试。
    - **自愈时钟** `localTick()`(`server.js` 启动 `startLocalTick()`,30s):只扫 `localActive`(有待推进状态的 run,不全量读盘)。僵死 `queued`(不在 fifo、无链在跑、超 2 分钟)重置;`retry_wait` 到点自动重投/回查;`segFifo` 有人就 `segKick`。`pumpSeg` 账号列表拿不到时 `break`(job 留 fifo 不写盘),由 tick 慢速重入,不忙循环。
    - **虚拟账号禁止落盘**:`segListAccounts` 区分「网络失败(抛 infra)」与「老服务明确回 200 但无 `accounts` 字段(才用运行时虚拟槽)」;`segBind` 拒绝写 `VIRTUAL_ACCOUNT`;`localRun` 遇虚拟段/虚拟 account 一律清掉按新段重新选号。
    - **双份点火防线**:`localWait` 里 `GET /tasks/:id` 断连必须重新标成 `wait+taskId`(否则继承 `localRequest` 的 connect 标记,被当成未入队自动重投);`segJob` 的 `taskId` 只信 `localSend` 成功后的返回值或 `localWait` 带回来的,**绝不用 `lastTaskId` 兜底**(多条消息第 N 条失败时 lastTaskId 还是第 1 条的,复用会交错答案)。
    - **服务侧真相源**:`POST /queue` 返回 `tasks[0].accountId`(不是 `account`;旧字段名让 mismatch 检测一直失效,已修),不一致只记录+warn、不改锁。
    - **存量迁移**:`resetInterrupted()` 启动时自动:清虚拟段、`running/queued`(重启假状态)转 `retry_wait`、旧 `failed` 的 infra 类(按 `lkind` 或文案 `isInfraText`)转 `retry_wait`。**服务重启后无需人工清 JSON、无需手点,重启进程代码自己恢复**。红线保持:`content`/`context` 仍落 `failed` 停下等人,不自动重跑。
  - **只读诊断（2026-11-18）**：`manual.localDebug()` + `server.js` 的 `GET /api/local/debug`，**仅 `127.0.0.1`/`::1` 可访问**（`HOST='0.0.0.0'` 且全站无鉴权，不能把账号 id / runId 暴露到局域网）。输出内存里的 `segAccounts` / `segFifo` / `localActive` / 调度标志位，并复算每个排队 job 在 `segChoose` 里的 `ok`/`pool`/`free`/`owners`/`verdict`，同时并排列出磁盘 `web.segment`，用于定位「排队没推进」「账号幽灵占用」。严格只读：不写盘、不改状态、不重新拉 `/queue`（用 10s 缓存）、不点火；**不进前端页面**（避免把内部状态变成人工干预入口）。`lib/*`/`server.js` 改动需用户自行重启才生效。
  - **排队真实归因同源 + 静默兜底（2026-11-18）**：解决「卡在 `queued` 很久但界面只会硬编码『按点击顺序,前面还有任务』」。目标不是把服务侧账号面板搬进项目页，而是让卡片上「为什么没动」与调度器真实看到的阻塞原因同源。
    - `whyBlocked(job)`：只读复算 `segChoose` 判定（`ok`/`excluded_by_avoid`/`pool`/`free`/`owners`/`verdict`/`text`/`hint`），供 `localDebug()` 与卡片展示**共用同一份归因**；刻意不调用 `segChoose`（它 `need_account` 分支有清 owner 的副作用）。账号缓存为空时 `verdict` 明确写「缓存为空,还没拉过 /queue,无法判定」，不误报「无空闲账号」。
    - `localDisplay(runId, id, patch)`：只写 `p.local.block_reason` / `wait_hint` 两个展示字段，不动 `status`/`phase`/`next`/`task_id`，**不刷新 `at`**（`at` 是僵死排队判据）；结论未变不写盘，避免 30s 一轮空转刷盘。
    - `localTick()` 的 `queued` 分支：job 仍在 `segFifo` 时写回 `whyBlocked(job)` 的真实原因（点名占用者 / 绑定账号被占 / 无空闲账号）；job 已出队但已分到账号时写「等本地服务接收」。**不动状态机、不新增终态、不重发**；`segStart()` 成功开跑时清空这两个展示字段。
    - 服务侧权威原因（静默时段 / 长休息 / 5 小时额度闸门）**只在相关时转述一句稳定原文**到 `wait_hint`：不写相对时长、不写 `waitMs`/`resetsAtMs`（会随轮询变小,导致每轮写盘）。`connected`/`workerStarted` 只作解释信息，**不进 `segListAccounts()` 的 `ok` 过滤**（服务侧页面只把 enabled/offline/default/paused 当账号状态,无真实故障证据），不改变可用性判定。
    - 前端 `webLocalBar()` 的 `queued` 分支删除硬编码「前面还有任务」，改读 `L.block_reason` / `L.wait_hint`；`webRenderedKey` 指纹加入这两个字段，保证 3 秒轮询在归因变化时重绘。
    - 范围边界：**不动调度状态机、不新增终态、不碰账号可用性过滤**。P3（放开 `avoid_account`）因会把 `always` 改窗口导致的上下文中断常态化而撤销；P2（超时落 `failed`）因 `failed`+`account=''` 会造「没有记录绑定账号」新死锁而降级为只写展示字段。
  - **服务侧终态开放集合与 `send_failed` 事故根治（2026-11-19）**：用户截图「自动本地模型调用好像卡死」并猜「静默时间等问题」。只读排查推翻猜测：静默时段结束后服务侧确实开跑，任务 32 秒就以 `send_failed` 终态结束（`/tasks/76ec2cba`、`/tasks/20337`，`finishedAt` 有值、`error="发送未确认：输入未落地…"`）。真正原因是我方把服务侧状态当成**封闭白名单**：`localWait()` 只显式认 `done/timeout/interrupted/cancelled/blocked/failed/legacy`，未知状态一律继续 `for(;;)`；`send_failed` 没被识别 → `segJob` 的 `await sendAndWait()` 永不返回 → `finally` 不释放账号 → `onPhase` 还把 `phase=send_failed` 写进盘上却把 `status` 写死 `running` → `localTick()` 的 running 分支只 `busy=true` → `segReleaseAccounts()` 对 busy 只标 `release_pending` → 同一 run 占住两个号、三个号全卡、fifo 三条全「无空闲账号」。**服务侧状态是开放集合,每新增一个终态就死等一次,必须从结构根治。**
    - **`LOCAL_ACTIVE_ST` + `localTerminal(t)`（单一终态真相源，`localWait()` 与 `healStaleRunning()` 共用）**：活跃态 `''/queued/waiting/running/sending/long_wait` 一律 `null` 继续等（**即使带 `finishedAt` 也不误杀**,避免误伤静默/额度长等）；`done` → `null` 走提交；显式终态按语义映射（`timeout` 半截内容不提交；`interrupted` = `infra`；`cancelled`/`blocked`/`failed`/`legacy` = `content` 停下等人）；**`send_failed` = `content`**，文案要求「先到那台机器确认会话里有没有重复内容,再点『本地模型调用』重试」，**程序绝不自动重发**（内容可能已粘进输入框但没成功发出，重发会重复点火）；**未知状态只要带 `finishedAt` 也当终态收敛**，点名状态并停下等人。
    - **服务侧状态清单（登记,服务升级后逐条核对）**：活跃 `queued/waiting/running/sending/long_wait`；终态 `done`（`finishedAt`，可提交）、`timeout`、`interrupted`、`cancelled`、`blocked`、`failed`、`legacy`、`send_failed`，以及未来任何带 `finishedAt` 的新终态。`send_failed` 实测 `hasFullBody:true` 但 `markdownSource:'none'`、`reply` 为空，**不能当成功或可复用**。
    - **P1-a 旧轮询不覆盖收敛结果**：`segJob()` 的 `mine()`/`onPhase` 写盘前判本链仍持有该卡（status 仍是 queued/running 且 task_id 未变）；被自愈接管时 `alive()` 失败抛 `halted:true`，`catch` 直接 return 不覆盖盘上状态，`finally` 仍释放账号。**`lock_id` 锁身份**：`segStart()` 发单调递增 `segLockSeq`，`finally` 只在 `slot.lock_id` 没变时清 busy，避免旧链结束把新链的 `busy=true` 清掉；不用 `seg_at`（同毫秒会碰撞）。
    - **P1-b `running` 黑盒自愈 + `release_pending` 孤儿回收**：`healStaleRunning()` 在 `running` 且盘上 `at` 超 45 分钟没动、有 `task_id` 时回查 `/tasks/:id`：服务侧仍活跃一律不动；终态或 `done` 但本地没接上 → 落 `failed`（**保留 status 不清空**,否则 `autoKick` 会重新点火）+ `segNotice()` + `segReclaim()`（清该 run 全部 owner/busy/release_pending、清 `web.segment`、置 `force_new`，不假装续旧锚点）；`heal_at` 节流,每 10 分钟最多回查一次。`localTick()` 末尾回收 `release_pending` 孤儿的判据是「owner 盘上已无任何 `queued/running/retry_wait` 活跃卡且不在 fifo」——**不按固定时间回收**,否则会误伤正常跑几十分钟的段。
    - **前端不动**：收敛成 `failed` 后按钮按原 `busy` 逻辑自动解禁。`lib/*` 改动需**用户自行重启**；重启后 `localTick()` 会自动收敛存量僵死 `running`、回收孤儿账号，**无需人工改 JSON**。
    - 自测 `tools/_seg_selftest.js` 新增 27–33 组契约（send_failed 收敛 / 未知终态 / 单一真相源 / 旧轮询不覆盖 / tick 回查收敛 / 服务侧仍活跃不打扰 / lock_id 对抗）。
  - 自测:`tools/_seg_selftest.js`（内存 fs + 模拟本地服务，186 项，不点火 LLM）。改动后必须 `node --check` 三处 + 跑它；vm 沙箱已补 `process` stub（`localDebug()` 会读 `process.pid/uptime()`），不影响产品语义。
  - **孤儿卡自愈收敛 + run 终态不变量（2026-11-20）**：用户要求「让系统更智能、减少用户感知和操作量」，推翻了「新增『丢弃』按钮由人点」的最初方案（那是把系统脏状态转嫁给人）。目标重新定义为：系统自己认出并清掉「已经没有意义的待粘贴卡」、自己解开残留账号占用，用户不该看到多余卡片、不该为清理点任何东西。
    - **真相源 `orphanCard(runId,p)`（重启安全，单一判据供全链路共用）**：主判据是**落盘**的 `cardStepDone(runId,p)`（该卡 label 经 `CARD_STEP_RE` 映射到 `steps[key].status` 为 `done/passed_soft/passed/skipped`，或 `reverse_audit` 且 `review.audit` 已存在）。`waiters` 是纯内存态，进程重启后必然为空，**只用 `waiting` 会把「重启后管线还没重新跑到」的真卡误删** —— 现场 M12 对应 `optimized=running`，落盘判据永不命中，重启也删不掉。附加条件：`check==='edits'`（人工交互卡）永不自动清、`local.status==='running'` 不碰、`waiters.has()` 为真不碰、必须带点火痕迹（`task_id`/`task_seq`/`ticket`/`account`，排除「重启后还没跑到」的合法卡）、状态属于 `queued/failed/stopped/retry_wait`。误删可自恢复：`relay0`/`relayWrite0` 按 key 找卡，找不到会重挂，`answers` 缓存优先直接返回。
    - **`sweepOrphans(runId)` / `sweepAllOrphans()` / `dropCard(runId,id)`**：一次读一次写清卡 + `segDrop` 清 fifo job + `waiters.delete`（防御性，不 reject 任何管线）+ `releaseIfIdle()`（只有该 run 已无任何活跃本地卡才 `segReleaseAccounts`，否则段内独占还在、不能让号被抢）。**不动 `done`/`answers`/`run.status`、不点火、不写横幅**（用户零感知，只 `console.log`）。`resetInterrupted()` **开头**先 `sweepAllOrphans()` 再重建段占用锁（顺序反了过期卡会继续占号，交叉死锁重启后原样复现）。`action:'drop'` 只作应急出口。
    - **`localTick()` 阶段 0**：在原来的 `if (!localActive.size && !segFifo.length) return` **之前**执行「扫 `touched`（`localActive ∪ segFifo ∪ owner`）的孤儿卡 + `reclaimResidualOwners()`」，否则 fifo 清空 / `localActive` 清空后就再也没有入口解开残留 owner。
    - **`reclaimResidualOwners()` 用活跃证据，不用空闲状态**：路径 A 保留原 `release_pending` 孤儿语义（owner 盘上无活跃卡且不在 fifo，**即使 `busy=true` 也回收**，服务故障期防永久占死）；路径 B 新增普通残留 owner，`busy=true` 一律跳过，只有 `ownerAlive()` 为假才静默回收。`ownerAlive` = 「run 未终态 **且** `web.segment.chat_url` 已建立 **且** `segment.account===本账号`」（段内 API 空闲时 pending 可能为空、`busy=false`，必须靠锚点保护，否则会串窗口）或「盘上还有 `running` 卡」或「fifo 里有该 run 明确 `need_account===本账号` 的 job」。run 终态后即使锚点有效也回收。
    - **run 终态不变量**：`autoWanted(web,p,runId)` 增加「`RUN_END` 或 `review.audit` 已存在 ⇒ 不自动」检查（`autoKick`/`setAuto`/`segNotice` 三处都传 runId）；`setAuto(true)` 不再 `delete web.auto_local_done`，在终态 / 报告已出时直接拒绝打开并写 `auto_local_done`（同时顺手收敛过期卡），正常时只点「最新 + 无 `local.status` + `waiting=true`」的一张卡。**这是堵住再生源头**：原实现遍历所有 pending 卡点火 + 清停止标记，正是「一个已 done 的任务还在挂 M6/M10、占着账号」的机制根因。
    - **前端减感知**：`webLocalBar()` 删除逐卡渲染的 run 级自动开关（多卡时一个页面出现几套按钮的直接原因），改到 `renderWebPanel()` 顶部只渲染一次；多卡只展开「当前该处理的那一张」（`waiting` 优先），其余折到 `<details>`；`webFailText()` 把服务侧那一大段 Playwright/超时日志压成一句能执行的话，完整原文放 `<details>`（落盘 `error` 不变）；`view()` 给每张卡加 `droppable` 标记（后端按 `orphanCard` 算），`webRenderedKey` 指纹加入该字段。
    - 自测新增 34–38 组契约（孤儿判据含「重启安全」反例 / `setAuto` 终态不变量与不覆盖 `auto_local_done` / `dropCard` 零副作用 / `localTick` 交叉死锁收敛 + 段内锚点保护 / 启动全量收敛只清 3 张、当前步骤 running 的失败卡不误删）。**真实数据只读干跑**（vm 沙箱 + 写盘代理）确认：当前现场会清 `15ec05dd M6/M10`、`d8854742 M9` 共 3 张，保留「无点火痕迹的 API 步骤卡」与「对应步骤未 done 的新任务卡」。
- 代码与注释统一叫「本地模型」，不写「桥接」。合并上游时按本节逐条核对。

- **自动本地模型调用（v1.124）**：论点页「选这个,自动本地模型调用」(`thesis-choice` 带 `web:true, auto_local:true` → `turnOn(run,{autoLocal})`)，或接力页按钮(`POST /web {action:'auto', on}` → `manual.setAuto`，打开时立刻把正在等的条目交给本地)。`web.auto_local` 落盘；`relay0`/`relayWrite0` 挂出新卡后 `autoKick` 自动 `localRun`。**只碰没有 `p.local.status` 的卡**：失败(`failed`)或发送前就报错(记 `stopped`，不记 `failed`，免得被当成同段重试)都停在那条不自动重试；人点本地模型调用/粘贴/改用 API 处理好后，后面新卡照旧自动。`review.js` 二稿审稿报告存好后调 `autoLocalDone` 写 `web.auto_local_done`，之后不再自动；终审「修改」(`check:'edits'`)永远不自动。**2026-11-20 修正**（见上一段）：`setAuto(true)` 不再遍历所有 pending 卡点火、不再 `delete auto_local_done`；run 终态 / 报告已出时拒绝打开并写停止标记，正常时只点「最新 + 无 `local.status` + 有活管线」的一张卡，并顺手收敛过期卡。

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

## POV 真人题与亲历感(v1.125,2026-11-19)

起因:「궁녀에서 황귀비까지」(run_b9f643517854)用真人엄씨当「你」,记录断档 + 内心对白都标假设,稿子退成人生节点清单(「记录/资料/无法确认」每千字 7.5 处,其余 14 篇 POV ≤1.2;篇幅 5,742 字,同框架同日的재벌 3세 篇 11,974 字且有完整处境)。结论:是题目问题,不是赛道规则坏了,也不是 v1.121–1.124 的更新。

- **真人题改无名视角(硬规则)**:`track_cards.md` 的 POV 卡——主角是有名有姓的真实人物时,「你」改成同时代、在这个人身边的无名人物,真人只当背景人物、只写有来源的事;无名主角的处境/心理/对话是虚构设定,按时代真实制度写,不逐句写「记录未载」;`title.final_title` 带上无名视角。写前分析和定论点都读这张卡。
- **亲历感(只 POV)**:`analysis.js` 的 `POV_FOUR` 接在叙事方式规则后(仅 `pov_mode` 为 climb/per_level 时进摘要);`craft_rules.md` P5(待验证=建议);`step1.md`/`step1_function.md`/`step2.md` 的 POV 条;`reverse_audit.md` B 段 POV 条件检查;`final_tracks/pov.md` C2。硬要求只有「每一级至少有一个『你』的具体处境,不能只报节点」;失去/能决定/决定不了是建议,不每级凑齐(其余 POV 稿逐章统计这三样本来就时有时无,硬凑会每级一个套路,和 DEAI_FOCUS 冲突)。

## 开头前 30 秒四步 + 避坑检查 + 开头三选一(v1.132,2026-11-23)

用户定的前 30 秒框架:0–5 秒兑现标题 → 5–15 秒和观众扯上关系 → 15–25 秒留一个没答案的问题 → 25–30 秒直接进第一个数字(第一幕)。避坑:打招呼、自我介绍、报流程议程句、慢热场景、开头和标题对不上。数据依据:5 条有 30 秒留存的视频里,붕어빵(10 秒内数字+反差+问题)61%,부침개(议程式)42%;最近经济拆账都照 the-economics-of-owning-a-bakery 的慢热想象式开头,第一个数字约 25 秒才出来。
- **标题类型**:写前分析多出 `title_kind`(具体说法 / 话题)和 `title_payoff`(`openbeats.normalize` 整理)。
- **照原片开头**(`openbeats.analysisNote` 第 0 步):标题是「具体说法」时,节拍表第一拍新加「兑现标题」,原片想象/场景拍压成 1–2 句,反转/承诺挪到 25 秒前,原片其余拍照原顺序接后面——重排发生在节拍表里,后面逐拍核对、锁定开头都照新顺序;标题是「话题」可以照原片顺序。`briefText` 写上标题类型,「8 秒内用一个人或场景说出标题冲突」改成「第一句兑现标题」。
- **通用开头公式**:`briefText` 不再返回空,给 `formulaBrief`(四步 + 避坑,不带节拍表);写前分析加 `formulaAnalysisNote`(钩子候选按四步写)。各赛道四步填法在 `openbeats.FOUR_STEP`(econ/pov/history/science/general)。`checks.LISTEN_RULES`、`opening_fix.md`、`opening_card.md`、`draft_check.md`、`final_recheck.md` 同步改了。「前 10 秒最多 1 个数字」保留(兑现标题那句的数字算这一个)。
- **避坑检查**(`checks.listenCheck`):前 15 秒打招呼/自我介绍(`GREET_RE`)、前 30 秒议程句(`AGENDA_RE`,从 openbeats 挪到 checks)算问题,文字以「前 N 秒」开头,所以进 `openingIssues`(挡发布 listen_open、自动改开头会改);照原片开头时打招呼进 hints,由 `openbeats.check` 报(改稿新加打招呼也会被锁定开头退回)。软提示放 `lc.avoid`(不挡发布,进「还不能发布」的 notes 和开头单独审):标题里的数字 15 秒内没说到;经济拆账第一个数字晚于 30 秒(`listenCheck` 新参数 `track`)。
- **开头三选一**:`review.runOpeningVariants`(提示词 `opening_variants.md`,存 `review.opening_variants`,步骤 `steps.opening_variants`,重启时落成 failed)按四步写 3 个 CH01(数字先说 / 人先说 / 反常识先说),每个用 `variantIssues` 跑一遍程序检查;照原片开头时要求保留每拍关键词和顺序(只许在第一拍前加兑现标题句、压场景拍),免得换上后节拍核对报顺序乱。`applyOpeningVariant`(人点「用这个」)换 CH01、不过锁、记 CH01 历史(可撤回)、终审前同步二稿、触发重审开头;开头在出版本后又被改过就 409。界面在「开头单独审」底部。AI 同时推荐一个(`pick` + 大白话 `pick_why`,界面顶上蓝框、卡片标「AI 推荐」);它推荐的那个没过程序检查而别的版本全过时,程序改推全过的那个并在 `pick_note` 写明。只是推荐,不自动换。
- **建议点哪个按钮**(`review.openingAdvice`,进 `openingView` 的 `advice`):开头审判「建议改」时,标题说的事 15 秒后才出来/没出来、打招呼或议程句、经济拆账第一个数字晚于 30 秒、前 30 秒 ≤4 分 → 推「按四步写 3 个开头」;否则推「按开头审意见改开头」。显示在「怎么改(大白话)」框顶上。

## 二稿审稿报告重跑后不再一直「进行中」(v1.131,2026-11-20)

点「重跑」二稿审稿报告后程序重启:`steps.reverse_audit` 一直是 running,而 `runPasses` 已经不在了,重启续跑(`resumeRun`)也不补已经终审过的任务;本地模型那张卡还会被 `manual.cardStepDone` 当成完成清掉(旧的 `review.audit` 还在,`key === 'reverse_audit' && run.review.audit` 判成 done),页面上没有要粘贴的卡。现在视图里 `passes.audit` 走 `passStepView`:running 但 `passRunning` 里没有这个任务,就显示「上次被中断了」并放出「重跑」按钮。`manual.js` 的判据没改。

## 信息重复检查不再一直转圈(v1.130,2026-11-20)

`steps.info_check.status` 写成 running 后程序重启(或进程中途退出),任务文件里一直是 running,页面一直转圈、「重新检查」也被 409 挡住。现在 `review.js` 用内存里的 `infoBusy` 记正在查的任务:视图里 running 但不在 `infoBusy` 的显示成「上次检查被中断了」,`startInfoCheck` 只按 `infoBusy` 判断在不在查,能直接重新检查。

## 篇幅放进二稿审稿报告(v1.129,2026-11-20;取代 v1.127 的终稿后自动篇幅调整)

起因:yt-studio 导出(2026-11-20)对上 15 条已发布韩文视频,成片时长 = 推出去那版词数 ÷ 配音语速,词数占蓝图预算 73%–111%,配音 96–118 词/分钟(中位 106);26 分钟目标成片 20–31.6 分钟,长的居多,整体完播差。v1.127 在终审那一串跑完后再自动删/补,问题列表和调整后的稿子对不上、撤回也说不清为什么撤;用户要求改成:篇幅当成审稿报告里的一条问题,勾了就和别的问题一起在终审里改,复审一次全查。

- **语速**:`narration.js` 的 `DEFAULT_WPM.Korean` 113 → 106(优先级不变:声音设定 narration_wpm > 已发布视频实测中位数 > 语言默认值)。写稿时的篇幅闸门(`pipeline.lengthCheck`)不改。
- **X-LEN**:`review.js` 的 `lengthIssue` 由 `auditExtras` 调用。按终审底稿(`finalBaseText`,和 `runFinal` 一样:二稿之后没动过就是二稿)算词数,目标 = `video_goal` 秒 × 配音语速 / 60;> 105% 偏长、< 90% 偏短才出这一条(S 级 P0,新任务默认勾上,页面标「篇幅」)。detail 写给终审:目标词数区间(95%–105%)、优先在勾选的其他问题重合处删/补、开头章节(起点在前 2 分钟内,`openingChapters`)和核心论点(`infoThesis`)不动、不改事实数字、为篇幅做的修改「类别」写 X-LEN(同时解决别的问题写多个编号)、「理由」用中文大白话。
- **终审**:`runFinal` 勾了 X-LEN 且偏短时,`limit.maxWords` 放宽到目标 × 105%(原来只许比底稿多 3%)。没有单独的篇幅调整步骤,也没有撤回;不想要就取消勾选 X-LEN 再终审。
- **显示**:`lengthView` → `final.length`:二稿 → 终稿词数和分钟、是否在范围内、`used_selection` 勾了 X-LEN 时列出 d3.edits 里类别带 X-LEN 的每一处(删/补、理由、同时解决的编号)。页面 `rvLengthHtml` 在终审区「篇幅调整」一栏;没勾且终稿偏了只显示一行提示。

## 文案版本「弃用」标记（2026-11-23 新增，本地功能）

详情页每张版本卡标题行最右端（「确认此版本」之后）加「弃用」按钮，点一次标红「✓ 已弃用」，再点取消；列表「确认文案版本」列在版本号下面显示一个红色「弃」小胶囊。**纯状态标识：不改稿、不挡推送/复制/确认/下载**。

- **存法**：`run.deprecated_versions = { v1: {at}, v1_5: {at} }`，可同时弃多版（用户口径 1=B）。`store.setRunDeprecated(id, version, deprecated)` 增删单版；`store.deprecatedVersions(run)` 是唯一读口（只认四个版本键）。不入库。
- **清除时机**：成功确认任意版本（`setRunConfirmed` 的 version 非空）→ 整体清空弃标（含刚确认那版自己的）；**取消确认（version 为空）不清**。前端再点同一卡「弃用」= 取消该版。
- **列表**：`store.indexEntry` 加 `deprecated`（按弃用时间升序）；`INDEX_VERSION` 7→8 强制重建。`confirmVersionCell(r)` 已改为接收**整行**（原来是 `r.confirmed`），没有确认版本但仍有弃标时在「—」下面照挂「弃」；hover 列全并给最近弃用时间。`loadRuns()` 的 `runsSig` 必须含 `r.deprecated`，否则 3 秒轮询不重绘。
- **接口**：`POST /api/runs/:id/deprecate-version` `{version, deprecated}`；仅 `status==='done'` 且该版本文案存在时可用（与「确认此版本」同口径），失败 400。
- 合并上游补丁时注意这三处：四张卡的 `dp-btn-*`/`dp-pill-*`、`confirmVersionCell` 的调用签名、`indexEntry` 的 `deprecated` 字段与 `INDEX_VERSION`。
