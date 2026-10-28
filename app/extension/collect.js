// 运行在 Studio 页面(插件环境):右下角放一个小面板,一键依次打开 概览/覆盖面/互动/观众 四个标签,
// 每个标签抓三样东西:页面文字(各项指标)、图表曲线(按坐标轴换算成 秒→百分比)、Studio 数据接口的原始返回,
// 最后发到本机文案程序(POST /api/yt-analytics),程序按视频标题找到对应的文案任务存起来。
(() => {
  const TABS = [
    { key: 'overview', slug: 'tab-overview', name: '概览' },
    { key: 'reach', slug: 'tab-reach_viewers', name: '覆盖面' },
    { key: 'engagement', slug: 'tab-interest_viewers', name: '互动' },
    { key: 'audience', slug: 'tab-build_audience', name: '观众' }
  ];
  const MAX_RESPONSES_CHARS = 15e6;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const store = {
    get: k => new Promise(r => chrome.storage.local.get(k, o => r(o[k]))),
    set: (k, v) => new Promise(r => chrome.storage.local.set({ [k]: v }, r)),
    del: k => new Promise(r => chrome.storage.local.remove(k, r))
  };

  function pageInfo() {
    const m = location.pathname.match(/\/video\/([\w-]{6,})\/analytics(?:\/([\w-]+))?(?:\/([\w-]+))?/);
    if (!m) return null;
    const tab = TABS.find(t => t.slug === m[2]) || null;
    return { vid: m[1], tab: tab ? tab.key : (m[2] || 'other'), period: m[3] || 'period-default' };
  }
  // 同一份抓取记录有两处在写(接口返回、页面快照),排队改,免得互相覆盖
  let chain = Promise.resolve();
  const update = (vid, fn) => (chain = chain.then(async () => {
    const k = 'yta_' + vid, st = (await store.get(k)) || { vid, tabs: {}, responses: [] };
    await fn(st);
    await store.set(k, st);
  }));
  const tabUrl = (vid, t, period) => location.origin + '/video/' + vid + '/analytics/' + t.slug + '/' + (period || 'period-default');

  // ---------- 接口返回:hook.js 转过来的,按视频累积 ----------
  let pending = [];
  window.addEventListener('message', e => {
    if (e.source !== window || !e.data || !e.data.__yta) return;
    const info = pageInfo();
    if (!info) return;
    pending.push({ url: e.data.url, tab: info.tab, at: e.data.at, body: e.data.body });
    flushSoon(info.vid);
  });
  let flushTimer = null;
  function flushSoon(vid) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(async () => {
      const batch = pending; pending = [];
      await update(vid, st => {
        let size = st.responses.reduce((n, r) => n + r.body.length, 0);
        for (const r of batch) { if (size + r.body.length > MAX_RESPONSES_CHARS) break; st.responses.push(r); size += r.body.length; }
      });
    }, 800);
  }

  // ---------- 图表:找带「100%」「0%」刻度的图,把折线按坐标轴换算成 [秒, 百分比] ----------
  const ownText = el => Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim() || (el.children.length ? '' : (el.textContent || '').trim());
  const toSec = t => { const p = t.split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
  const center = el => { const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height }; };
  function readCharts() {
    const out = [];
    const svgs = Array.from(document.querySelectorAll('svg')).filter(s => { const b = s.getBoundingClientRect(); return b.width > 200 && b.height > 80; });
    for (const svg of svgs) {
      // 刻度可能是 SVG 文字,也可能是旁边的 HTML,往上找几层容器
      let box = svg, labels = [];
      for (let i = 0; i < 5 && box; i++, box = box.parentElement) {
        labels = Array.from(box.querySelectorAll('*')).filter(el => el.getBoundingClientRect().width > 0).map(el => ({ el, t: ownText(el) })).filter(x => x.t);
        if (labels.some(x => /^100\s?%$/.test(x.t)) && labels.some(x => /^0\s?%$/.test(x.t))) break;
        labels = [];
      }
      if (!labels.length) continue;
      const y100 = center(labels.find(x => /^100\s?%$/.test(x.t)).el).y, y0 = center(labels.find(x => /^0\s?%$/.test(x.t)).el).y;
      const times = labels.filter(x => /^\d{1,2}:\d{2}(:\d{2})?$/.test(x.t)).map(x => toSec(x.t));
      const duration = times.length ? Math.max(...times) : null;
      if (!(y0 > y100) || !duration) continue;
      const series = [];
      for (const p of svg.querySelectorAll('path, polyline')) {
        let len = 0; try { len = p.getTotalLength(); } catch (e) {}
        const ctm = p.getScreenCTM && p.getScreenCTM();
        if (len < 100 || !ctm) continue;
        const pts = [];
        for (let i = 0; i <= 400; i++) {
          const q = p.getPointAtLength(len * i / 400), s = new DOMPoint(q.x, q.y).matrixTransform(ctm);
          pts.push([s.x, s.y]);
        }
        const xs = pts.map(q => q[0]), minX = Math.min(...xs), maxX = Math.max(...xs);
        if (maxX - minX < svg.getBoundingClientRect().width * 0.5) continue; // 网格短线、图例等
        // 按秒去重(同一秒取最后一个点),换成 [秒, 百分比]
        const bySec = new Map();
        pts.forEach(([x, y]) => bySec.set(Math.round((x - minX) / (maxX - minX) * duration), Math.round((y0 - y) / (y0 - y100) * 1000) / 10));
        const points = [...bySec.entries()].sort((a, b) => a[0] - b[0]);
        if (points.every(q => q[1] === points[0][1])) continue; // 水平网格线
        const cs = getComputedStyle(p);
        series.push({ stroke: cs.stroke, dashed: cs.strokeDasharray !== 'none', points });
      }
      if (!series.length) continue;
      // 图的标题:往上找最近的一段短文字
      let title = '', a = svg;
      for (let i = 0; i < 8 && a && !title; i++, a = a.parentElement) {
        const line = (a.innerText || '').split('\n').map(s => s.trim()).find(s => s && s.length < 40 && !/^\d/.test(s));
        if (line) title = line;
      }
      out.push({ title, duration_sec: duration, axis: labels.filter(x => /%$|^\d+:\d+/.test(x.t)).map(x => x.t).slice(0, 20), series });
    }
    return out;
  }

  function pageTitles() {
    const t = [document.title];
    document.querySelectorAll('#entity-name, .entity-name, [class*="entity-name"], ytcp-navigation-drawer, #video-title, [id*="video-title"]').forEach(el => t.push((el.innerText || '').slice(0, 600)));
    return t.filter(Boolean);
  }

  async function snapshot(info) {
    // 等图表和指标画出来(最多 15 秒),再多等 2 秒让剩下的接口回来
    for (let i = 0; i < 30; i++) { if (/\d/.test(document.body.innerText) && document.querySelector('svg')) break; await sleep(500); }
    await sleep(info.tab === 'overview' ? 4000 : 3000);
    const snap = { url: location.href, at: Date.now(), text: (document.body.innerText || '').replace(panel ? panel.innerText : '\u0000', '').slice(0, 80000), charts: readCharts() }, titles = pageTitles();
    await update(info.vid, st => {
      st.tabs[info.tab] = snap;
      st.titles = Array.from(new Set([...(st.titles || []), ...titles]));
      st.period = info.period;
    });
  }

  // ---------- 发送 ----------
  async function send(vid, runId) {
    await sleep(1000);
    await chain;
    const st = (await store.get('yta_' + vid)) || { tabs: {}, responses: [] };
    const server = (await store.get('yta_server')) || 'http://localhost:8080';
    setStatus('正在发送到文案程序…');
    const payload = { video_id: vid, period: st.period, page_url: location.href, titles: st.titles || [], tabs: st.tabs, responses: st.responses, run_id: runId || undefined, ext_version: chrome.runtime.getManifest().version };
    const r = await new Promise(res => chrome.runtime.sendMessage({ type: 'yta-send', server, payload }, res));
    if (r && r.ok) {
      const d = r.data || {};
      setStatus('✓ 已存进任务「' + (d.topic || d.run_id) + '」' + (d.summary_text ? '\n' + d.summary_text : ''));
      await store.del('yta_' + vid);
    } else if (r && r.status === 409 && r.data && r.data.candidates) {
      setStatus(r.data.error || '找到多篇同名文案,请选一篇:', r.data.candidates.map(c => ({ label: c.label, act: () => send(vid, c.run_id) })));
    } else setStatus('✗ ' + ((r && r.data && r.data.error) || '发送失败'));
  }

  // 下载成文件(.txt,里面是 JSON;聊天里 .json 附件会被拦)。原始接口返回最多留 5MB,文件太大不好发
  async function download(vid) {
    await sleep(1000);
    await chain;
    const st = (await store.get('yta_' + vid)) || { tabs: {}, responses: [] };
    let size = 0; const responses = [];
    for (const r of st.responses) { if (size + r.body.length > 5e6) break; responses.push(r); size += r.body.length; }
    const payload = { video_id: vid, period: st.period, page_url: location.href, titles: st.titles || [], tabs: st.tabs, responses, responses_dropped: st.responses.length - responses.length, captured_at: new Date().toISOString(), ext_version: chrome.runtime.getManifest().version };
    const d = new Date(), pad = n => String(n).padStart(2, '0');
    const name = 'yt-data_' + vid + '_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.txt';
    const r = await new Promise(res => chrome.runtime.sendMessage({ type: 'yta-download', name, text: JSON.stringify(payload) }, res));
    if (!r || !r.ok) { setStatus('✗ 下载失败:' + ((r && r.error) || '未知原因'), [{ label: '再试一次', act: () => download(vid) }]); return; }
    const charts = Object.values(st.tabs || {}).reduce((n, t) => n + ((t && t.charts) || []).length, 0);
    setStatus('✓ 已下载 ' + name + '(在浏览器的下载文件夹里),把这个文件发给我就行。\n抓到 ' + Object.keys(st.tabs || {}).length + ' 个标签、' + charts + ' 张曲线图、' + st.responses.length + ' 份接口数据。',
      [{ label: '再下载一次', act: () => download(vid) }]);
  }

  async function startAuto(mode) {
    const info = pageInfo();
    if (!info) return;
    await update(info.vid, st => { st.tabs = {}; st.responses = []; st.titles = []; });
    await store.set('yta_auto', { vid: info.vid, period: info.period, mode: mode === 'send' ? 'send' : 'download', queue: TABS.map(t => t.key) });
    location.href = tabUrl(info.vid, TABS[0], info.period);
  }

  async function runAuto() {
    const auto = await store.get('yta_auto'), info = pageInfo();
    if (!auto || !info || info.vid !== auto.vid) return;
    const cur = TABS.find(t => t.key === auto.queue[0]);
    if (!cur) { await store.del('yta_auto'); return; }
    setStatus('正在抓「' + cur.name + '」(' + (TABS.length - auto.queue.length + 1) + '/' + TABS.length + '),请别操作页面…');
    if (info.tab !== cur.key) { location.href = tabUrl(info.vid, cur, auto.period); return; }
    await snapshot(info);
    auto.queue.shift();
    if (auto.queue.length) { await store.set('yta_auto', auto); location.href = tabUrl(info.vid, TABS.find(t => t.key === auto.queue[0]), auto.period); return; }
    await store.del('yta_auto');
    if (auto.mode === 'send') await send(info.vid); else await download(info.vid);
  }

  // ---------- 面板 ----------
  let panel = null;
  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;width:300px;background:#fff;border:1px solid #d0d7de;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.15);font:13px/1.6 system-ui,sans-serif;color:#1f2328;padding:12px';
    panel.innerHTML = '<div style="font-weight:600;margin-bottom:6px">文案程序 · 数据抓取</div>' +
      '<button data-a="auto" style="width:100%;padding:8px;border:0;border-radius:6px;background:#cc0000;color:#fff;font-weight:600;cursor:pointer">一键抓取并下载</button>' +
      '<div data-s style="white-space:pre-wrap;margin-top:8px;color:#57606a"></div><div data-c></div>' +
      '<details style="margin-top:6px"><summary style="cursor:pointer;color:#57606a">设置</summary>' +
      '程序地址 <input data-server style="width:100%;box-sizing:border-box;margin:4px 0;padding:4px" placeholder="http://localhost:8080">' +
      '<button data-a="save" style="padding:4px 10px">保存</button>' +
      '<button data-a="send" style="display:block;margin-top:6px;padding:4px 10px">抓取并发送到文案程序</button></details>';
    document.body.appendChild(panel);
    panel.querySelector('[data-a=auto]').onclick = () => startAuto('download');
    panel.querySelector('[data-a=send]').onclick = () => startAuto('send');
    panel.querySelector('[data-a=save]').onclick = async () => { await store.set('yta_server', panel.querySelector('[data-server]').value.trim() || 'http://localhost:8080'); setStatus('已保存'); };
    store.get('yta_server').then(v => { panel.querySelector('[data-server]').value = v || 'http://localhost:8080'; });
    return panel;
  }
  function setStatus(text, choices) {
    const p = ensurePanel();
    p.querySelector('[data-s]').textContent = text;
    const c = p.querySelector('[data-c]'); c.innerHTML = '';
    (choices || []).forEach(ch => { const b = document.createElement('button'); b.textContent = ch.label; b.style.cssText = 'display:block;width:100%;text-align:left;margin-top:4px;padding:4px 6px;cursor:pointer'; b.onclick = ch.act; c.appendChild(b); });
  }
  async function updatePanel() {
    const info = pageInfo();
    if (!info) { if (panel) panel.style.display = 'none'; return; }
    ensurePanel().style.display = '';
    if (await store.get('yta_auto')) return;
    const st = await store.get('yta_' + info.vid);
    if (!st) { setStatus('打开的是视频数据分析页。点上面按钮,会依次打开 4 个标签抓数据(约 40 秒),然后下载成一个文件,把文件发给我就行。'); return; }
  }

  let lastPath = '';
  setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; updatePanel(); } }, 1000);
  runAuto();
})();
