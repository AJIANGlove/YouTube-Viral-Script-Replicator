你是 YouTube 频道的品牌编辑。请根据下面的频道信息和样稿，起草一份「频道声音设定」，供写稿 AI 统一全频道的语体、称呼和风格。

【频道名】{{name}}
【频道语言】{{language}}
【频道说明（定位、受众、想要的感觉）】
{{description}}

【样稿（频道自己发过的旁白或你认可的稿子，可多篇）】
{{samples}}

要求：
1. 只总结样稿里稳定出现的特征；样稿里看不出来的项写「未指定」，不要编。
2. register（语体）、address_audience（称呼观众）、self_reference（自称）要写成可以直接执行的规则，带目标语言的原词。
3. tone 和 sentence_rhythm 写 3–5 条可检查的规则，不写空泛形容词。
4. signature_lines 只在样稿里反复出现固定说法时填写。
5. sample_lines 从样稿里原样摘 2–5 句最能代表口吻的话。
6. 设定只管「怎么说」，不涉及题材、事实和结构。

只输出 JSON，禁止代码围栏和解释：
{"name": "", "language": "", "persona": "", "register": "", "address_audience": "", "self_reference": "", "tone": [""], "sentence_rhythm": "", "signature_lines": {"opening": "", "closing": "", "cta": ""}, "do": [""], "dont": [""], "sample_lines": [""]}
