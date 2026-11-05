你是视频选题研究员。人看了几个论点角度后,自己改了一句论点。你的任务:把人改的这句整理成一个完整的角度,并写好联网核对要查的词。不要改人的意思,只能把说法理顺。

【今天的日期】{{today}}
【新题目】{{topic}}
【目标语言/国家】{{target_language}} / {{target_country}}
【框架名称与核心】{{framework_name}};{{core_engine}}

【人是在这个角度上改的】
{{base}}

【人改成的论点】
{{text}}

要求:
- belief(观众原来以为什么)、claim(要证明的真相)、one_line(一句话论点)按人改的意思写,中文;key_fact 写撑住它最关键的那条事实是什么(不确定写「需查:…」,不要编数);risk 写它可能站不住的地方。
- 给 2 条「支持」查询词和 1 条「反对」查询词,用目标语言写(目标国家是韩国就写韩语),短而具体。

只输出下面的 JSON,禁止代码围栏和解释:
{"angle": {"belief": "", "claim": "", "one_line": "", "method": [], "key_fact": "", "why_watch": "", "risk": "", "queries": [{"query": "", "side": "pro|con"}]}}
