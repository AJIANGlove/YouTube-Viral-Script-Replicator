// 上传表格(xlsx / csv / tsv)转成文字,拼进参考资料(run.materials)给写前分析用。
// 不依赖第三方库:xlsx 是 zip 包,用 zlib 解压后按 XML 读;csv 自动认 UTF-8 / UTF-16 / EUC-KR / GBK。
// 大表按行截断(写前分析的提示词有长度限制),截掉多少行返回给页面提示。
const zlib = require('zlib');
const path = require('path');

const MAX_ROWS = 300;      // 每个工作表最多放多少行(含表头)
const MAX_CHARS = 30000;   // 一个文件转出来的文字最多多少字
const MAX_CELL = 300;      // 单元格超长就截断

// ---------- zip ----------
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('不是有效的 xlsx 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let k = 0; k < count && buf.readUInt32LE(p) === 0x02014b50; k++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nl).toString('utf-8');
    files[name] = { method, size, off };
    p += 46 + nl + el + cl;
  }
  return name => {
    const f = files[name];
    if (!f) return null;
    const start = f.off + 30 + buf.readUInt16LE(f.off + 26) + buf.readUInt16LE(f.off + 28);
    const raw = buf.slice(start, start + f.size);
    return (f.method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf-8');
  };
}

// ---------- xlsx ----------
const unesc = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()]);
const attr = (tag, name) => { const m = tag.match(new RegExp('\\s' + name + '="([^"]*)"')); return m ? unesc(m[1]) : null; };
const texts = xml => (String(xml).replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').match(/<t\b[^>]*>[\s\S]*?<\/t>/g) || []).map(t => unesc(t.replace(/^<t\b[^>]*>|<\/t>$/g, ''))).join('');
const colIndex = ref => { let n = 0; for (const ch of String(ref).replace(/\d+/g, '').toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

// 单元格样式 → 日期 / 百分比(Excel 里日期存的是天数)
function numStyles(xml) {
  if (!xml) return [];
  const fmts = {};
  (xml.match(/<numFmt\b[^>]*\/?>/g) || []).forEach(t => { fmts[attr(t, 'numFmtId')] = attr(t, 'formatCode') || ''; });
  const xfs = (xml.match(/<cellXfs\b[\s\S]*?<\/cellXfs>/) || [''])[0];
  return (xfs.match(/<xf\b[^>]*\/?>/g) || []).map(t => {
    const id = Number(attr(t, 'numFmtId') || 0);
    const code = fmts[id] || '';
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || /[ymd]/i.test(code.replace(/\[[^\]]*\]|"[^"]*"/g, ''))) return id === 20 || id === 21 || id === 45 || id === 46 || (/h/i.test(code) && !/[yd]/i.test(code)) ? 'time' : 'date';
    if (id === 9 || id === 10 || /%/.test(code)) return 'pct';
    return '';
  });
}
function fmtNum(v, kind) {
  const n = Number(v);
  if (!isFinite(n)) return v;
  if (kind === 'date' && n > 0 && n < 2958466) {
    const d = new Date(Math.round((n - 25569) * 86400000));
    return d.toISOString().slice(0, 10) + (n % 1 ? ' ' + d.toISOString().slice(11, 16) : '');
  }
  if (kind === 'time') { const s = Math.round((n % 1) * 86400); return String(Math.floor(s / 3600)).padStart(2, '0') + ':' + String(Math.floor(s / 60) % 60).padStart(2, '0'); }
  if (kind === 'pct') return String(Number((n * 100).toPrecision(10))) + '%';
  return String(Number(n.toPrecision(12)));
}

function readXlsx(buf) {
  const get = unzip(buf);
  const wb = get('xl/workbook.xml');
  if (!wb) throw new Error('不是有效的 xlsx 文件(找不到 workbook)');
  const rels = {};
  (String(get('xl/_rels/workbook.xml.rels') || '').match(/<Relationship\b[^>]*>/g) || []).forEach(t => { rels[attr(t, 'Id')] = attr(t, 'Target'); });
  const shared = (String(get('xl/sharedStrings.xml') || '').match(/<si\b[\s\S]*?<\/si>/g) || []).map(texts);
  const styles = numStyles(get('xl/styles.xml'));
  return (wb.match(/<sheet\b[^>]*>/g) || []).map(t => {
    const target = rels[attr(t, 'r:id')] || '';
    const file = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    const xml = get(file) || '';
    const rows = [];
    (xml.match(/<row\b[^>]*\/>|<row\b[^>]*[^/]>[\s\S]*?<\/row>/g) || []).forEach(r => {
      const row = [];
      (r.match(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g) || []).forEach((c, i) => {
        const open = c.match(/^<c\b[^>]*>/)[0];
        const type = attr(open, 't'), ref = attr(open, 'r'), s = Number(attr(open, 's') || 0);
        const v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let val = '';
        if (type === 's') val = shared[Number(v)] || '';
        else if (type === 'inlineStr') val = texts(c);
        else if (type === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
        else if (type === 'str' || type === 'e') val = v != null ? unesc(v) : '';
        else if (v != null) val = fmtNum(unesc(v), styles[s]);
        row[ref ? colIndex(ref) : i] = val;
      });
      const rn = Number(attr(r.match(/^<row\b[^>]*>/)[0], 'r'));
      if (rn > 0) rows[rn - 1] = row; else rows.push(row);
    });
    return { name: attr(t, 'name') || 'Sheet', rows: Array.from(rows, r => Array.from(r || [], x => x == null ? '' : String(x))) };
  });
}

// ---------- csv ----------
function decodeText(buf) {
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString('utf-8');
  if (buf[0] === 0xFF && buf[1] === 0xFE) return buf.slice(2).toString('utf16le');
  if (buf[0] === 0xFE && buf[1] === 0xFF) return Buffer.from(buf.slice(2)).swap16().toString('utf16le');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { /* 不是 UTF-8,下面猜 */ }
  // Excel 存的 csv 常是本地编码:韩文 EUC-KR(CP949)、中文 GBK。两种都解一遍,挑乱码少、成字多的
  // 中文 GBK 的字节按 EUC-KR 也能解出(生僻的)韩文,所以按常用字占比判断,不按能不能解
  const KO = '이다의는에하고가을를기지사로수한인서대리아자도나시전정부그어일상들만구해제회보내라위성주우비원장소면요것게적국년동공방생연용모무경중관신여문물실업유계선화발개입결당간분식미재조교통금액료항목율매출익평균월세점포임건';
  const ZH = '的一是不了人在有中和年月日元数价金额项目收入成本利润平均房租工资比例总计合同市场销售口大小多少上下个这那为以到说时要就出会可也对生能子得于着自之后家里如所去行过方面学然发当没动现分将还经从部度二三四五六七八九十万亿率占增长减店铺餐饮营业税费用';
  const score = s => {
    const all = s.match(/[가-힣一-鿿]/g) || [];
    const bad = (s.match(/�/g) || []).length;
    if (!all.length) return -bad;
    return (all.filter(ch => KO.includes(ch) || ZH.includes(ch)).length - bad) / all.length;
  };
  const cands = ['euc-kr', 'gbk'].map(enc => { try { return new TextDecoder(enc).decode(buf); } catch (e) { return ''; } });
  return score(cands[0]) >= score(cands[1]) ? cands[0] : cands[1];
}
function readCsv(buf, name) {
  const text = decodeText(buf);
  const first = text.split(/\r?\n/, 1)[0] || '';
  const sep = /\.tsv$/i.test(name) || (first.split('\t').length > first.split(',').length) ? '\t' : (first.split(';').length > first.split(',').length + 1 ? ';' : ',');
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return [{ name: '', rows }];
}

// ---------- 转文字 ----------
function parseTable(buf, name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (ext === '.xls') throw new Error('不支持旧版 .xls,请在 Excel 里「另存为」xlsx 或 csv 再上传');
  if (ext === '.xlsx' || ext === '.xlsm' || (buf[0] === 0x50 && buf[1] === 0x4B)) return readXlsx(buf);
  return readCsv(buf, name);
}
const cellText = v => { const s = String(v == null ? '' : v).replace(/\s+/g, ' ').replace(/\|/g, '/').trim(); return s.length > MAX_CELL ? s.slice(0, MAX_CELL) + '…' : s; };

// 返回 { text, sheets:[{name, rows, shown, cols}], truncated }:text 直接拼进参考资料
function tableToText(buf, name) {
  const sheets = parseTable(buf, name);
  const out = [], info = [];
  let chars = 0, truncated = 0;
  sheets.forEach(sh => {
    const rows = sh.rows.map(r => r.map(cellText)).filter(r => r.some(Boolean));
    if (!rows.length) return;
    let cols = 0;
    rows.forEach(r => { for (let i = r.length - 1; i >= 0; i--) if (r[i]) { cols = Math.max(cols, i + 1); break; } });
    const head = '【上传表格:' + name + (sh.name ? ' / 工作表:' + sh.name : '') + '(共 ' + rows.length + ' 行 ' + cols + ' 列';
    const lines = [];
    let shown = 0;
    for (const r of rows) {
      if (shown >= MAX_ROWS) break;
      const l = '| ' + Array.from({ length: cols }, (_, i) => r[i] || '').join(' | ') + ' |';
      if (chars + l.length + 1 > MAX_CHARS) break;
      lines.push(l); chars += l.length + 1; shown++;
    }
    truncated += rows.length - shown;
    info.push({ name: sh.name, rows: rows.length, shown, cols });
    out.push(head + (shown < rows.length ? ',这里只放了前 ' + shown + ' 行' : '') + ';第一行一般是表头)】\n' + lines.join('\n'));
  });
  if (!out.length) throw new Error('表格里没有内容');
  return { text: out.join('\n\n'), sheets: info, truncated };
}

module.exports = { parseTable, tableToText, MAX_ROWS, MAX_CHARS };
