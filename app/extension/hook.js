// 运行在页面里(MAIN world):Studio 的数据分析页靠 youtubei 接口取数,这里把这些接口的返回原样转给 collect.js。
// 只转 Studio 自己的数据接口,不碰登录、上传等其他请求。
(() => {
  if (window.__ytaHooked) return;
  window.__ytaHooked = true;
  const WANT = /\/youtubei\/v1\/(yta_web|analytics_data|creator|yta_)/;
  const post = (url, text) => {
    if (!text || text.length > 8e6) return;
    window.postMessage({ __yta: true, url: String(url), body: text, at: Date.now() }, location.origin);
  };
  const of = window.fetch;
  window.fetch = async function (input, init) {
    const res = await of.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (WANT.test(url)) res.clone().text().then(t => post(url, t)).catch(() => {});
    } catch (e) {}
    return res;
  };
  const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, url) { this.__ytaUrl = url; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    if (WANT.test(this.__ytaUrl || '')) this.addEventListener('load', () => { try { post(this.__ytaUrl, typeof this.response === 'string' ? this.response : this.responseText); } catch (e) {} });
    return os.apply(this, arguments);
  };
})();
