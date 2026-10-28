// 发送到本机文案程序:放在后台发,避开 Studio 页面的跨域限制
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.type !== 'yta-send') return;
  const base = String(msg.server || 'http://localhost:8080').replace(/\/+$/, '');
  fetch(base + '/api/yt-analytics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg.payload) })
    .then(async r => { let j = {}; try { j = await r.json(); } catch (e) {} reply({ ok: r.ok, status: r.status, data: j }); })
    .catch(e => reply({ ok: false, status: 0, data: { error: '连不上文案程序(' + base + '):' + e.message + '。请确认程序已启动,地址对不对。' } }));
  return true;
});
