# 测试基线 v1 · 咖啡主题（2026-07-28)

## 用途

本文件夹保存了工作流**首次完整四步测试**的全部输入配置、提示词模板与各步产物,作为**回归基线**。
后续修改任何提示词或流程后,用完全相同的输入重跑,与本基线逐项对照,即可判断改动是否有效。

## 目录结构

```
test_baseline_v1_coffee/
├── README.md                  ← 本文件
├── prompts/                   ← 四步提示词(保存时点的页面默认模板,未修改)
│   ├── step1_blueprint.md
│   ├── step2_script.md
│   ├── step3_audit.md
│   └── step4_optimization.md
└── outputs/                   ← 四步实际产物(原样保存,未做任何修正)
    ├── step1_blueprint.json
    ├── step2_script.md
    ├── step3_audit.json
    └── step4_optimized_script.md
```

## 测试输入(复测时必须保持一致)

- **四层资产**:`../BND_0c0c47e2-78b6-8cc0-dcb5-9b2c47ab256a/` 下的 framework / timeline / style / examples.json(源案例:When Did Ancient Humans Start Smoking,21:53)
- **选题**:When did ancient humans begin drinking coffee?
- **Audience Context**:目标语言 English;目标国家 US;目标受众 18-45岁;视频目的 10分钟
- **运行方式**:`node serve.js` → `http://localhost:8000/test_workflow.html`,逐步手动执行 Step 1-4
- **模型/协议**:____(本次未记录,复测时填入并尽量保持一致)
- **温度 / Max Tokens**:页面默认值(0.7 / 8192)

## 基线结论(本次测试评分)

结构层仿写约 90%:13 章对原片 13 段比例 1:1,留存事件约 24/27 落位,声音指纹基本到位。
产物总体可用,但存在下列已确认缺陷。

## 已知缺陷清单(复测验收对照表)

改提示词后重跑,逐项检查缺陷是否消失:

| # | 缺陷 | 位置 | 修复后期望 |
|---|------|------|-----------|
| D1 | 蓝图预写了原文重命名句的落点(“社会基础设施”/“咖啡瘾重构”/“第四驱动力”),导致下游照抄 | outputs/step1 FS09/FS11/FS13 | 蓝图只规定功能与情绪目标,并带原创性约束,不出现落点词/人名 |
| D2 | 3 处签名句与原文几乎逐字重合:"It was infrastructure."(原文 cue 1703)、"That's not an addiction."(cue 1995)、"fourth drive alongside hunger, thirst..."(cue 1123) | outputs/step4 CH09/CH11/CH13 | 机制保留、落点词原创;n-gram 查重无 6 词以上重合 |
| D3 | CH06 伪造验证弧:卡尔迪传说被"研究证实"("the goats checked out"),实际无此验证 | outputs/step2 CH06(Step 4 未修) | 诚实处理为传说,或替换为可验证轶事;Audit 应能报出 |
| D4 | 开场词密度超标:CH01 约 84 词/12 秒(≈420 wpm)、CH02 约 90 词/18 秒(≈300 wpm),远超资产标定 149 wpm,无法口播 | outputs/step2 CH01/CH02 | 每章词数 ≤ 时长×149/60 ±10%;Hook 窗口短句化 |
| D5 | Step 2 五处"该具体却模糊"(CH03 量级、CH05 遗址、CH08 发现、CH09 署名、CH10 第三文明),Step 3 才被抓、Step 4 才补 | outputs/step2 → step3 issues | 蓝图提供事实候选后,Step 2 一次到位,Audit 此类 issue 清零 |
| D6 | Audit 两个盲区:无原创性维度(D2 全漏)、无事实核查维度(D3 漏);评分无量纲(87 分无扣分依据) | outputs/step3 | Audit 增加 originality 与 factual_claims 维度,issue 带 severity |
| D7 | Step 4 输出混入元评论:"Note: 我在 CH08 手误…"(内容自相矛盾)及结尾 "All five fixes are surgical—…" 自我总结 | outputs/step4 末尾 | 只输出 Optimized Script + Change Log,无任何注释 |

## 复测方法

1. 打开测试页,确认四个资产、选题、Audience Context 与本基线一致。
2. 依次运行 Step 1-4(每步输出不要人工编辑,保持与基线相同的"零干预"条件)。
3. 对照上表 D1-D7 逐项打勾:消失 = 改动有效;仍在 = 改动无效或提示词未生效。
4. 额外检查:不得引入新问题(章节数≠13、比例偏移、风格漂移、新的事实错误)。
5. 将新产物另存为新基线文件夹(如 `test_baseline_v2_coffee/`),不要覆盖本文件夹。

## 备注

- `prompts/` 保存的是 `test_workflow.html` 中的默认模板。若本次测试时在页面临时改过提示词,以页面 localStorage 为准,需手动同步到本文件夹。
- Step 4 注入的 4 处考据点(Cahokia 黑饮、Santa Ana-La Florida、Ronald Siegel 第四驱动力、瓜拉尼人马黛茶)经人工核实**均为真实**;但工作流无事实校验环节,此结果不代表下次必然可靠(见 D6)。
