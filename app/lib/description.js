// YouTube 视频简介生成(独立于生成管线的外挂模块,模式对齐 fingerprint.js)
// LLM 只产出内容素材(hook/小节行/要点/收尾段/免责选择键),固定骨架由 assemble() 在代码侧拼接;
// 骨架文案按任务目标语言本地化(12 语言包);输出校验失败时带原因反馈重试一次。
// 本模块不认识 HTTP 与 store,唯一外部依赖是 pipeline.llmCall 与 checks.stripFence。
const fs = require('fs');
const path = require('path');
const pipeline = require('./pipeline');
const checks = require('./checks');

const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'description.md');

// 文案版本键 → run 字段(v1 兜底 final_script,与 server 指纹接口同一约定)
function versionText(run, version) {
  switch (version) {
    case 'v1': return run.script_v1 || run.final_script || '';
    case 'v2': return run.script_v2 || '';
    case 'v1_5': return run.script_v1_5 || '';
    case 'v2_5': return run.script_v2_5 || '';
    default: return '';
  }
}

// ---------- 语言包:固定骨架的本地化文案(与前端"目标语言"下拉的 12 种一一对应) ----------
// 每包字段:timestamps(小节区标题)/ intro(引子行前缀)/ learn(要点区标题)/ subscribe(订阅行,保留【频道名】占位符)
// / disclaimer_label(免责声明前缀)/ disclaimers(三套模板,LLM 只负责三选一)。措辞可事后直接改这里。
const LOCALES = {
  en: {
    name: 'English',
    timestamps: 'TIMESTAMPS', intro: 'Intro', learn: "What You'll Learn:",
    subscribe: 'Subscribe to 【频道名】 for weekly videos.',
    disclaimer_label: 'DISCLAIMER',
    disclaimers: {
      general: 'This video is for educational and entertainment purposes only. The content is based on publicly available information and narrative interpretation. Always do your own research.',
      finance: 'This video is for educational and entertainment purposes only. Nothing in this video constitutes financial, investment, or legal advice. Always do your own research and consult a licensed financial professional before making investment decisions.',
      sensitive: 'This video is a work of educational and entertainment content. It does not endorse, glorify, or encourage any illegal, violent, or harmful activities. Viewer discretion is advised.'
    }
  },
  zh: {
    name: 'Chinese',
    timestamps: '时间轴', intro: '引子', learn: '你将学到:',
    subscribe: '订阅【频道名】,每周收看新视频。',
    disclaimer_label: '免责声明',
    disclaimers: {
      general: '本视频仅供教育与娱乐用途。内容基于公开资料与叙事性解读,请自行核实相关信息。',
      finance: '本视频仅供教育与娱乐用途。视频中任何内容均不构成投资、金融或法律建议。做出投资决策前请自行研究并咨询持牌金融专业人士。',
      sensitive: '本视频为教育与娱乐性质的内容,不宣扬、不美化、不鼓励任何违法、暴力或有害行为。请观众自行斟酌观看。'
    }
  },
  ko: {
    name: 'Korean',
    timestamps: '타임스탬프', intro: '인트로', learn: '이 영상에서 배우게 될 것:',
    subscribe: '【频道名】 채널을 구독하고 매주 새로운 영상을 받아 보세요.',
    disclaimer_label: '면책 조항',
    disclaimers: {
      general: '이 영상은 교육 및 오락 목적으로만 제작되었습니다. 공개된 자료와 서사적 해석을 바탕으로 하며, 관련 정보는 직접 확인하시기 바랍니다.',
      finance: '이 영상은 교육 및 오락 목적으로만 제작되었습니다. 이 영상의 어떤 내용도 금융, 투자 또는 법률 조언에 해당하지 않습니다. 투자 결정을 내리기 전에 반드시 스스로 조사하고 공인 금융 전문가와 상담하시기 바랍니다.',
      sensitive: '이 영상은 교육 및 오락 목적의 콘텐츠입니다. 어떠한 불법적, 폭력적 또는 유해한 행위도 옹호하거나 미화하거나 조장하지 않습니다. 시청에 주의하시기 바랍니다.'
    }
  },
  ja: {
    name: 'Japanese',
    timestamps: 'タイムスタンプ', intro: 'イントロ', learn: 'この動画で学べること:',
    subscribe: '【频道名】をチャンネル登録して、毎週の新着動画をお見逃しなく。',
    disclaimer_label: '免責事項',
    disclaimers: {
      general: 'この動画は教育および娯楽目的でのみ作成されています。公開情報と物語的解釈に基づく内容です。関連情報はご自身でご確認ください。',
      finance: 'この動画は教育および娯楽目的でのみ作成されています。この動画のいかなる内容も、金融・投資・法律に関する助言を構成するものではありません。投資判断を行う前に、必ずご自身で調査し、資格を持つ金融専門家にご相談ください。',
      sensitive: 'この動画は教育および娯楽目的のコンテンツです。違法、暴力的、有害な行為を支持、美化、奨励するものではありません。視聴の際はご注意ください。'
    }
  },
  es: {
    name: 'Spanish',
    timestamps: 'MARCAS DE TIEMPO', intro: 'Intro', learn: 'Lo que aprenderás:',
    subscribe: 'Suscríbete a 【频道名】 para ver videos nuevos cada semana.',
    disclaimer_label: 'AVISO LEGAL',
    disclaimers: {
      general: 'Este video tiene fines exclusivamente educativos y de entretenimiento. El contenido se basa en información pública e interpretación narrativa. Investiga siempre por tu cuenta.',
      finance: 'Este video tiene fines exclusivamente educativos y de entretenimiento. Nada de lo contenido en este video constituye asesoramiento financiero, de inversión o legal. Investiga siempre por tu cuenta y consulta a un profesional financiero autorizado antes de tomar decisiones de inversión.',
      sensitive: 'Este video es un contenido educativo y de entretenimiento. No respalda, glorifica ni fomenta ninguna actividad ilegal, violenta o dañina. Se recomienda discreción al espectador.'
    }
  },
  pt: {
    name: 'Portuguese',
    timestamps: 'MARCAS DE TEMPO', intro: 'Introdução', learn: 'O que você vai aprender:',
    subscribe: 'Inscreva-se no 【频道名】 para receber vídeos novos toda semana.',
    disclaimer_label: 'AVISO LEGAL',
    disclaimers: {
      general: 'Este vídeo tem fins exclusivamente educacionais e de entretenimento. O conteúdo é baseado em informações públicas e interpretação narrativa. Faça sempre sua própria pesquisa.',
      finance: 'Este vídeo tem fins exclusivamente educacionais e de entretenimento. Nada neste vídeo constitui aconselhamento financeiro, de investimento ou jurídico. Faça sempre sua própria pesquisa e consulte um profissional financeiro licenciado antes de tomar decisões de investimento.',
      sensitive: 'Este vídeo é um conteúdo educacional e de entretenimento. Não endossa, glorifica nem incentiva nenhuma atividade ilegal, violenta ou prejudicial. Recomenda-se discrição do espectador.'
    }
  },
  hi: {
    name: 'Hindi',
    timestamps: 'समय-चिह्न', intro: 'भूमिका', learn: 'आप क्या सीखेंगे:',
    subscribe: 'हर हफ्ते नए वीडियो के लिए 【频道名】 को सब्सक्राइब करें।',
    disclaimer_label: 'अस्वीकरण',
    disclaimers: {
      general: 'यह वीडियो केवल शैक्षिक और मनोरंजन उद्देश्यों के लिए है। सामग्री सार्वजनिक रूप से उपलब्ध जानकारी और कथात्मक व्याख्या पर आधारित है। कृपया संबंधित जानकारी स्वयं सत्यापित करें।',
      finance: 'यह वीडियो केवल शैक्षिक और मनोरंजन उद्देश्यों के लिए है। इस वीडियो की कोई भी सामग्री वित्तीय, निवेश या कानूनी सलाह नहीं है। निवेश का निर्णय लेने से पहले हमेशा स्वयं शोध करें और लाइसेंस प्राप्त वित्तीय पेशेवर से परामर्श करें।',
      sensitive: 'यह वीडियो शैक्षिक और मनोरंजन उद्देश्य की सामग्री है। यह किसी भी अवैध, हिंसक या हानिकारक गतिविधि का समर्थन, महिमामंडन या प्रोत्साहन नहीं करता है। दर्शक विवेक का प्रयोग करें।'
    }
  },
  id: {
    name: 'Indonesian',
    timestamps: 'STEMPEL WAKTU', intro: 'Pembuka', learn: 'Yang akan Anda pelajari:',
    subscribe: 'Berlangganan 【频道名】 untuk video baru setiap minggu.',
    disclaimer_label: 'PENAFIAN',
    disclaimers: {
      general: 'Video ini hanya untuk tujuan edukasi dan hiburan. Konten didasarkan pada informasi yang tersedia untuk umum dan interpretasi naratif. Selalu lakukan riset Anda sendiri.',
      finance: 'Video ini hanya untuk tujuan edukasi dan hiburan. Tidak ada bagian dari video ini yang merupakan nasihat keuangan, investasi, atau hukum. Selalu lakukan riset Anda sendiri dan konsultasikan dengan profesional keuangan berlisensi sebelum membuat keputusan investasi.',
      sensitive: 'Video ini adalah konten edukasi dan hiburan. Video ini tidak mendukung, mengagungkan, atau mendorong aktivitas ilegal, kekerasan, atau berbahaya apa pun. Kebijaksanaan penonton disarankan.'
    }
  },
  de: {
    name: 'German',
    timestamps: 'ZEITMARKEN', intro: 'Intro', learn: 'Das lernst du in diesem Video:',
    subscribe: 'Abonniere 【频道名】 für wöchentliche Videos.',
    disclaimer_label: 'HAFTUNGSAUSSCHLUSS',
    disclaimers: {
      general: 'Dieses Video dient ausschließlich Bildungs- und Unterhaltungszwecken. Der Inhalt basiert auf öffentlich verfügbaren Informationen und narrativer Interpretation. Recherchiere immer selbst.',
      finance: 'Dieses Video dient ausschließlich Bildungs- und Unterhaltungszwecken. Nichts in diesem Video stellt eine Finanz-, Anlage- oder Rechtsberatung dar. Recherchiere immer selbst und konsultiere einen lizenzierten Finanzberater, bevor du Anlageentscheidungen triffst.',
      sensitive: 'Dieses Video ist ein Bildungs- und Unterhaltungsinhalt. Es befürwortet, verherrlicht oder fördert keine illegalen, gewalttätigen oder schädlichen Aktivitäten. Es wird zur Zurückhaltung beim Ansehen geraten.'
    }
  },
  fr: {
    name: 'French',
    timestamps: 'HORODATAGES', intro: 'Intro', learn: 'Ce que vous allez apprendre :',
    subscribe: 'Abonnez-vous à 【频道名】 pour de nouvelles vidéos chaque semaine.',
    disclaimer_label: 'AVERTISSEMENT',
    disclaimers: {
      general: 'Cette vidéo est destinée uniquement à des fins éducatives et de divertissement. Le contenu repose sur des informations publiques et une interprétation narrative. Faites toujours vos propres recherches.',
      finance: "Cette vidéo est destinée uniquement à des fins éducatives et de divertissement. Rien dans cette vidéo ne constitue un conseil financier, d'investissement ou juridique. Faites toujours vos propres recherches et consultez un professionnel financier agréé avant de prendre des décisions d'investissement.",
      sensitive: "Cette vidéo est un contenu éducatif et de divertissement. Elle n'approuve, ne glorifie ni n'encourage aucune activité illégale, violente ou nuisible. La discrétion du spectateur est conseillée."
    }
  },
  vi: {
    name: 'Vietnamese',
    timestamps: 'MỐC THỜI GIAN', intro: 'Mở đầu', learn: 'Bạn sẽ học được:',
    subscribe: 'Đăng ký 【频道名】 để xem video mới hàng tuần.',
    disclaimer_label: 'TUYÊN BỐ MIỄN TRỪ',
    disclaimers: {
      general: 'Video này chỉ nhằm mục đích giáo dục và giải trí. Nội dung dựa trên thông tin công khai và diễn giải mang tính tự sự. Hãy luôn tự nghiên cứu.',
      finance: 'Video này chỉ nhằm mục đích giáo dục và giải trí. Không có nội dung nào trong video này cấu thành lời khuyên tài chính, đầu tư hoặc pháp lý. Hãy luôn tự nghiên cứu và tham khảo ý kiến chuyên gia tài chính được cấp phép trước khi đưa ra quyết định đầu tư.',
      sensitive: 'Video này là nội dung giáo dục và giải trí. Video không xác nhận, tôn vinh hay khuyến khích bất kỳ hoạt động bất hợp pháp, bạo lực hoặc có hại nào. Người xem cân nhắc khi xem.'
    }
  },
  ar: {
    name: 'Arabic',
    timestamps: 'الطوابع الزمنية', intro: 'المقدمة', learn: 'ما ستتعلمه:',
    subscribe: 'اشترك في قناة 【频道名】 لمشاهدة فيديوهات جديدة كل أسبوع.',
    disclaimer_label: 'إخلاء مسؤولية',
    disclaimers: {
      general: 'هذا الفيديو لأغراض تعليمية وترفيهية فقط. يستند المحتوى إلى معلومات متاحة للعامة وتفسير سردي. قم دائمًا بإجراء بحثك الخاص.',
      finance: 'هذا الفيديو لأغراض تعليمية وترفيهية فقط. لا يُعد أي محتوى في هذا الفيديو نصيحة مالية أو استثمارية أو قانونية. قم دائمًا بإجراء بحثك الخاص واستشر متخصصًا ماليًا مرخصًا قبل اتخاذ قرارات الاستثمار.',
      sensitive: 'هذا الفيديو محتوى تعليمي وترفيهي. لا يؤيد أو يمجد أو يشجع أي أنشطة غير قانونية أو عنيفة أو ضارة. يُنصح المشاهدون بالحذر.'
    }
  }
};

const LANG_ALIASES = {
  english: 'en', chinese: 'zh', '中文': 'zh', korean: 'ko', japanese: 'ja',
  spanish: 'es', portuguese: 'pt', hindi: 'hi', indonesian: 'id',
  german: 'de', french: 'fr', vietnamese: 'vi', arabic: 'ar'
};

// 脚本检测兜底:谚文→韩语,假名→日语,CJK 占比>20%→中文,否则英文
function detectFromScript(script) {
  const s = script || '';
  if (/[가-힣]/.test(s)) return 'ko';
  if (/[぀-ヿ]/.test(s)) return 'ja';
  const cjk = (s.match(/[一-鿿]/g) || []).length;
  if (cjk / Math.max(s.length, 1) > 0.2) return 'zh';
  return 'en';
}

// 语言键解析:任务 audience.target_language(权威)优先,缺失时脚本检测,再兜底英文
function resolveLanguage(targetLanguage, script) {
  return LANG_ALIASES[String(targetLanguage || '').trim().toLowerCase()] || detectFromScript(script);
}

const DISCLAIMER_KEYS = ['general', 'finance', 'sensitive'];
const DIVIDER = '─'.repeat(41);

// 解析并校验 LLM 输出;不合格抛错(由 generate 捕获后反馈重试)
function parsePayload(content) {
  let obj;
  try {
    obj = JSON.parse(checks.stripFence(content));
  } catch (e) {
    const m = content.match(/\{[\s\S]*\}/); // 模型裹了解说文字时,捞第一个 JSON 对象
    try { obj = m ? JSON.parse(m[0]) : null; } catch (e2) { obj = null; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('输出不是合法 JSON 对象');
  const clean = s => String(s == null ? '' : s).replace(/#/g, '').trim(); // 防御性剔除 # 符号
  const hook = clean(obj.hook);
  if (!hook) throw new Error('缺少 hook 字段');
  const segments = Array.isArray(obj.segments) ? obj.segments.map(clean).filter(Boolean) : [];
  if (segments.length < 5) throw new Error('小节行不足 5 条(实际 ' + segments.length + ')');
  const learn = Array.isArray(obj.learn_points) ? obj.learn_points.map(clean).filter(Boolean) : [];
  if (learn.length < 5) throw new Error('要点不足 5 条(实际 ' + learn.length + ')');
  const closing = clean(obj.closing);
  if (!closing) throw new Error('缺少 closing 字段');
  const key = DISCLAIMER_KEYS.includes(obj.disclaimer_key) ? obj.disclaimer_key : 'general';
  return {
    hook,
    intro_title: clean(obj.intro_title) || 'Introduction',
    segments: segments.slice(0, 9),
    learn_points: learn.slice(0, 7),
    closing,
    disclaimer_key: key
  };
}

// 固定骨架拼接(纯函数):emoji 小节标题、订阅行、免责声明由代码控制并按语言包本地化,LLM 内容只填槽位
function assemble(p, lang) {
  const L = LOCALES[lang] || LOCALES.en;
  return [
    p.hook,
    '',
    '⏱️ ' + L.timestamps,
    L.intro + ': ' + p.intro_title,
    ...p.segments,
    '',
    '💡 ' + L.learn,
    ...p.learn_points.map(x => '→ ' + x),
    '',
    '📌 ' + p.closing,
    '',
    DIVIDER,
    '🔔 ' + L.subscribe,
    DIVIDER,
    '',
    '⚠️ ' + L.disclaimer_label + ': ' + L.disclaimers[p.disclaimer_key]
  ].join('\n');
}

// 生成入口:LLM 调用 + 校验,校验失败带原因反馈重试一次
async function generate(cfg, topic, script, targetLanguage) {
  const lang = resolveLanguage(targetLanguage, script);
  const langName = (LOCALES[lang] || LOCALES.en).name;
  const tpl = fs.readFileSync(PROMPT_PATH, 'utf-8');
  const prompt = tpl
    .replaceAll('{{topic}}', topic || '')
    .replaceAll('{{language}}', langName)
    .replaceAll('{{script}}', script);
  const genCfg = { ...cfg, temperature: 0.4 }; // 简介需要一点创造性,但格式优先
  const messages = [{ role: 'user', content: prompt }];
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await pipeline.llmCall(genCfg, messages, '视频简介');
    try {
      const p = parsePayload(r.content);
      return {
        content: assemble(p, lang),
        disclaimer_key: p.disclaimer_key,
        language: lang,
        model: cfg.model || '',
        secs: Math.round(r.secs * 10) / 10
      };
    } catch (e) {
      lastErr = e;
      messages.push({ role: 'assistant', content: r.content });
      messages.push({ role: 'user', content: '输出未通过校验:' + e.message + '。请严格按输出契约重新输出完整 JSON 对象,不要输出任何其他内容。' });
    }
  }
  throw new Error('两次生成均未通过校验: ' + (lastErr && lastErr.message));
}

module.exports = { versionText, parsePayload, assemble, generate, resolveLanguage, LOCALES };
