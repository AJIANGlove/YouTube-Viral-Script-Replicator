# 爆款文案生成平台(app/)

资产库 + 四阶段自动生成管线的正式产品。局域网内多用户、多任务并发可用。

## 启动

```bash
node app/server.js
```

- 本机:http://localhost:8080
- 局域网:http://<本机IP>:8080(启动时会打印)

## 功能

1. **资产库**:上传四层 JSON(+ 可选源 SRT),严格校验(asset_type、schema_version、asset_bundle_id、framework_id、source_case_id 跨文件一致),不合格拒收;现有 5 个资产已全部预置并通过校验。
2. **新建生成**:选框架资产 → 填新主题 + Audience Context → 自动执行 Blueprint → Script → Audit → Optimization。多任务并行,互不阻塞。
3. **任务页**:所有任务实时进度(每 3 秒轮询),点进详情可见每步耗时、校验报告、各步产物、最终脚本(复制/下载)、fact_check_list 待核实清单。
4. **指纹检测与替换(任务详情页)**:对已完成任务的 V1 / V2 文案做"爆款声音指纹"检测(俗见反转、泛称主语、无人告知、转折拐杖四类),逐条给出改写建议;勾选后一键替换,生成 V1.5 / V2.5(底版原样保留,.5 永远 = 底版 + 最近一次确认的勾选),完整明细记入任务的 fingerprint_log。
   - 检测为"正则预筛 + LLM 复核改写"混合架构:模式库 `prompts/fingerprints.json` 提供各语言表面正则(候选)与语言无关的结构判定要点,LLM 做最终判定并逐句改写;已保存的检测结果再次打开不重新扣费,显式点"重新检测"才会再次调用。
   - 模式库维护:直接编辑 `prompts/fingerprints.json`(改 version 即可生效,服务端按文件 mtime 自动重载);候选句型可用 `node tools/mine_fingerprints.js` 从资产库与历史生成稿中挖掘,人工筛选后入库。
5. **视频简介生成(任务详情页)**:对已完成任务的 V1 / V2 / V1.5 / V2.5 任一版本点"生成简介",以该版本文案生成 YouTube 视频简介(钩子段 + TIMESTAMPS 小节行 + What You'll Learn 要点 + 收尾段 + 订阅引导 + 免责声明)。整篇语言跟随任务的"目标语言"(audience.target_language,缺失时按脚本检测兜底);简介中不含 # 标签与时间码;订阅行的【频道名】为占位符,发布前自行替换。
   - 固定骨架(emoji 小节标题、订阅行、免责声明)由代码按语言包拼接,LLM 只产出内容素材;语言包覆盖前端支持的 12 种目标语言(en/zh/ko/ja/es/pt/hi/id/de/fr/vi/ar),免责声明每语种三套(通用/金融/敏感题材)由 LLM 按题材三选一,全部措辞见 `lib/description.js` 的 LOCALES 常量,可直接改。
   - 按版本各自缓存在任务的 descriptions 字段,重复打开不重复扣费,点"重新生成"才再次调用;结果支持复制与下载 .txt。
6. **开头留存检查(任务详情页)**:对已完成任务的 V1 / V2 / V1.5 / V2.5 任一版本点"开头留存检查",按章节时间标签锁定前 60 秒:前 30 秒检查现象/冲突/本质是否交代,30–60 秒检查价值承诺是否明确(知识拆解/方法/认知纠偏/具体步骤),并结合全文校验承诺与后文实际内容是否一致;产出两个 10 分制评分 + 分段检查表 + 可定位命中(现象缺失/冲突不足/本质未点明/价值承诺缺失/钩子偏弱/承诺与内容不符 六类),命中在文案中高亮、点击查看双语对照与修改建议,逐条采纳/忽略(改写=替换原句,插入=新句加到锚点句后)。
   - 采纳写回规则与商业化检查一致:V1/V2 → 生成对应 .5(已存在需确认覆盖),V1.5/V2.5 → 原地更新;结果按版本缓存(opening_scans),重复打开不扣费,点"重新检测"才再次调用;无章节时间戳的版本拒绝检测;明细记入 opening_log。
7. **强化开头(任务详情页)**:对已完成任务的 V1 / V2 / V1.5 / V2.5 任一版本点"强化开头",勾选 CH01 / CH02(至少一章)后以源爆款开头为模板做逐句 1:1 仿写重写,选好章节直接重写并机械拼接写回(未选章节逐字保留,词数 ±15% 闸门,不合格自动反馈重试一次)。写回规则:V1 → 生成 V2、V2 → 生成 V2.5(目标已存在时需确认覆盖,此后底版锁定),V1.5 / V2.5 → 原地更新可反复强化;每次执行都调用 LLM,不做结果缓存;无章节标签的版本拒绝强化;被改动版本的商业化/留存扫描与简介缓存自动标记过期。明细记入 boost_log。(旧"第五阶段"已下线:新建不再含强化勾选,历史任务的 V2 与步骤痕迹只读保留。)

## 管线内置质量闸门(来自 v1-v3 测试的修复成果)

- Step 1 蓝图:字段查重;**JSON 解析失败 / 输出过短(<500 字符)/ 总时长 ≠ video_goal 时自动反馈模型重试一次,重试仍不合格则任务置失败**;
- Step 2 脚本:n-gram 查重(vs 源 SRT + examples)、每章词密度对账;**章节结构不合格(未解析到 [CHxx]、章号重复或乱序)时反馈重试一次;max_tokens 截断时退到章节边界续写(最多 2 轮),合并后校验章数/时间衔接/末章时长,不合格则置失败**;
- Step 3 审核:**输出非合法 JSON(如只输出思考过程)自动反馈重试一次**;evidence_quote 逐字存在性校验;
- Step 4 终稿:元评论/占位符检测、Change Log before 逐字校验、时间轴漂移检测;**章节结构闸门(章号必须 CH01 起严格递增不重复,不合格反馈重试 1 次,仍不合格置失败)**;
- 终稿正文自动从 Change Log 中分离提取;**首个章节标签之前混入的计划/自我说明(如英文 "I need to fix...")会被整块丢弃,只保留标题行**,并在 `checks.optimized.preamble` 留痕。
- Step 2 / Step 4 的章节标签行在入库边界统一归一化(`lib/textnorm.js`):模型偶尔输出 `**[CH01 | ...]**`,会先剥离 Markdown 装饰再进闸门与校验,不浪费 LLM 重试。

## 文本格式约定(章节标签行)

- 唯一规范形态:`[CH01 | 0:00-0:41 | promise_setup]`,整行独占,不加粗、不加标题符、不加列表符。
- `lib/store.js` 在 `getRun` / `saveRun` 两侧对 `final_script`、`script_v1`、`script_v2`、`script_v1_5`、`script_v2_5` 调用 `lib/textnorm.js#normalizeChapterTags`:只剥离整行独占标签两侧的 Markdown 装饰,`[]` 内与正文逐字节不变,幂等。`outputs.stepN` 保留模型原始输出,不在此列。
- 解析侧保持严格(`checks.parseChapters`、`opening.CH_TIME_LINE`、`textloc.CH_TAG_LINE`、`boost.spliceChapters` 的闸门);归一化只在入口做一次,不要在各个解析器里各放宽一套格式。
- 存量修复:`node tools/normalize_chapter_tags.js`(默认 dry-run)/ `--write`(写前备份到 `tools/.work/runs_backup_<ts>/`)/ `--refresh-checks`(本地重算 `checks.optimized`,修 `timeDrift` 静默为 null);自测:`node tools/check_chapter_tags.js [--runs]`。

## 传输层防护(SSE 多流)

- 中转渠道在上游中断后重试/续写时,可能把「前一段被截断的流 + 后一段完整流」塞进**同一个 HTTP 响应体**。实测事故(`run_a3cb19c5b8a6`):CH11 断在半句后直接重起 CH01,终稿出现 23 个章节标签。
- `lib/pipeline.js#parseSSE` 按流边界分段(anthropic:`message_start`;openai:`[DONE]` 或首帧 `delta.role`),取**最长的一段**作为结果,并把 `streams` 写进 `attempts` 流水;结构是否可用由 `checks.chapterStructureError` 二次把关(不合格触发闸门重试,不会静默落盘)。
- 自测:`node tools/check_pipeline_guards.js`(章节结构闸门 + SSE 多流检测)。

## 配置

`app/config.json` 为全局 API 配置:`providers` 存各渠道预设(协议/base_url/Key/models,可选 omit_temperature、use_max_completion_tokens 标记;Key 仅在该文件维护,前端不展示);「主流程」(四阶段生成)与「微调按钮」(选题推荐/生成简介/指纹检测/YouTube 商业化检查/开头留存检查/强化开头)为两套独立配置,均可在页面"设置"中修改,互不干扰。

商业化检查的替换正文语言以任务 `audience.target_language` 为准,缺失时检测/采纳接口明确报错,不从原文推断或默认英文。提示词覆盖现有 12 种目标语言:`suggestion` 输出目标语言的可口播正文,`original_zh`/`suggestion_zh` 输出中文意译,分析说明使用中文;允许原文已有的外文专名、术语和短引文。主体语言明显冲突由模型返回 `TARGET_LANGUAGE_CONFLICT`,接口报错且不保存本次结果。此流程不增加程序语种识别或自动纠正重试。

商业化采纳继续逐条定位替换:成功项写回,失败项保留原句并显示原因;全部失败时不生成/覆盖文案,不改动扫描、下游缓存或日志。已保存的检查结果仍按原有方式读取,应用新提示词需点击「重新检测」;历史扫描和文案不会自动重写。

## 目录

```
app/
├── server.js        HTTP 服务(API + 静态;默认 8080,可用 PORT 环境变量覆盖)
├── lib/             checks(确定性校验) / textnorm(章节标签行归一化) / validate(资产校验) / pipeline(生成管线) / store(持久化) / textloc(文本定位与替换共享工具) / fingerprint(指纹检测与替换,外挂独立模块) / compliance(YouTube 商业化检查,外挂独立模块) / opening(开头留存检查,外挂独立模块) / boost(开头强化,外挂独立模块) / description(视频简介生成,外挂独立模块)
├── prompts/         step1-4.md(v3 版管线提示词,单一来源,改这里即改管线) / step5.md(开头强化仿写提示词) / fingerprint_detect.md(检测提示词) / fingerprints.json(指纹模式库) / compliance_check.md(商业化检查提示词) / opening_retention_check.md(开头留存检查提示词) / description.md(简介素材提示词)
├── public/          前端 SPA
├── data/runs/       生成记录(每任务一个 JSON)
└── config.json      API 配置
```

## 注意

- 开发调试用的单步测试台仍在 `tools/`(`node tools/serve.js` → http://localhost:8000/test_workflow.html),与产品互不干扰;
- 生成任务中 audit 的 factual_claims 均为**未核实**状态,发布前需人工核对(见 baselines/v3/README.md 的流程约定);
- API 调用费用按所选模型由中转站计费,批量使用注意成本。
