// pdfFontRecovery.js
//
// Восстановление текста для шрифтов, у которых в PDF нет таблицы ToUnicode (задача #8,
// замечание приёмки PR #12).
//
// Типичный случай: составной шрифт (Type0) с кодировкой Identity-H и встроенным TrueType
// (CIDFontType2), но без ToUnicode. Коды символов в таком тексте — номера глифов. pdf.js
// не знает, какие буквы стоят за номерами, и отдаёт сами номера («ζϜϊϗ…» вместо «Счет»),
// а pdfminer и подобные средства читают текст через таблицу cmap встроенного шрифта:
// глиф → Юникод. Здесь делается то же: из файла PDF достаются такие шрифты, по их cmap
// строится обратная таблица «номер глифа → символ», и строки pdf.js переводятся через неё.
//
// Ничего не угадывается: символ берётся только из таблицы самого шрифта. Если таблицы нет
// или результат всё равно нечитаем, текст остаётся как был, а форма предложит заполнить
// счёт вручную.
//
// Для этого нужен маленький разборщик объектов PDF: pdf.js не отдаёт исходные файлы шрифтов.
// Он понимает обычные объекты и потоки объектов (PDF 1.5+), фильтр FlateDecode с
// предиктором PNG. Всё, что не понял, — пропускает.

const zlib = require('zlib');

// ------------------------------------------------------------
// Минимальный разбор объектов PDF
// ------------------------------------------------------------

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

class Lexer {
  constructor(buf, pos = 0) { this.b = buf; this.p = pos; }
  skipWs() {
    const b = this.b;
    for (;;) {
      while (this.p < b.length && WS.has(b[this.p])) this.p++;
      if (b[this.p] === 0x25) { // комментарий
        while (this.p < b.length && b[this.p] !== 0x0a && b[this.p] !== 0x0d) this.p++;
      } else return;
    }
  }
  regular() {
    const start = this.p;
    while (this.p < this.b.length && !WS.has(this.b[this.p]) && !DELIM.has(this.b[this.p])) this.p++;
    return this.b.toString('latin1', start, this.p);
  }
  /** Следующее значение или null. Ссылки «N G R» распознаются здесь же. */
  value(depth = 0) {
    if (depth > 64) throw new Error('слишком глубокая вложенность');
    this.skipWs();
    const b = this.b;
    if (this.p >= b.length) return undefined;
    const c = b[this.p];
    if (c === 0x2f) { this.p++; return { name: this.regular() }; }
    if (c === 0x5b) {
      this.p++;
      const arr = [];
      for (;;) {
        this.skipWs();
        if (this.p >= b.length) return arr;
        if (b[this.p] === 0x5d) { this.p++; return arr; }
        arr.push(this.value(depth + 1));
      }
    }
    if (c === 0x3c && b[this.p + 1] === 0x3c) {
      this.p += 2;
      const dict = new Map();
      for (;;) {
        this.skipWs();
        if (this.p >= b.length) return { dict };
        if (b[this.p] === 0x3e && b[this.p + 1] === 0x3e) { this.p += 2; return { dict }; }
        const key = this.value(depth + 1);
        if (!key || typeof key.name !== 'string') { this.p++; continue; }
        dict.set(key.name, this.value(depth + 1));
      }
    }
    if (c === 0x3c) { // шестнадцатеричная строка
      const end = b.indexOf(0x3e, this.p);
      const hex = b.toString('latin1', this.p + 1, end < 0 ? b.length : end).replace(/[^0-9a-fA-F]/g, '');
      this.p = end < 0 ? b.length : end + 1;
      return { str: Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex') };
    }
    if (c === 0x28) { // литеральная строка — содержимое нам не нужно, только пропустить
      let level = 0;
      for (; this.p < b.length; this.p++) {
        const ch = b[this.p];
        if (ch === 0x5c) { this.p++; continue; }
        if (ch === 0x28) level++;
        else if (ch === 0x29 && --level === 0) { this.p++; break; }
      }
      return { str: Buffer.alloc(0) };
    }
    const tok = this.regular();
    if (!tok) { this.p++; return null; }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
      // «N G R» — ссылка
      if (/^\d+$/.test(tok)) {
        const save = this.p;
        this.skipWs();
        const g = this.regular();
        if (/^\d+$/.test(g)) {
          this.skipWs();
          if (this.b[this.p] === 0x52 && (this.p + 1 >= b.length || WS.has(b[this.p + 1]) || DELIM.has(b[this.p + 1]))) {
            this.p++;
            return { ref: Number(tok) };
          }
        }
        this.p = save;
      }
      return Number(tok);
    }
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    return { op: tok };
  }
}

function pngUnpredict(data, columns, colors = 1, bpc = 8) {
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((columns * colors * bpc) / 8);
  const out = Buffer.alloc(Math.floor(data.length / (rowLen + 1)) * rowLen);
  const prev = Buffer.alloc(rowLen);
  let o = 0;
  for (let i = 0; i + rowLen < data.length + 1 && o < out.length; i += rowLen + 1) {
    const type = data[i];
    const row = data.subarray(i + 1, i + 1 + rowLen);
    for (let x = 0; x < rowLen; x++) {
      const a = x >= bpp ? out[o + x - bpp] : 0;
      const up = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (type === 1) v += a;
      else if (type === 2) v += up;
      else if (type === 3) v += (a + up) >> 1;
      else if (type === 4) { const p = a + up - c; const pa = Math.abs(p - a); const pb = Math.abs(p - up); const pc = Math.abs(p - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? up : c); }
      out[o + x] = v & 0xff;
    }
    out.copy(prev, 0, o, o + rowLen);
    o += rowLen;
  }
  return out.subarray(0, o);
}

class PdfObjects {
  constructor(buf) {
    this.buf = buf;
    this.objs = new Map(); // num -> { value, streamStart? } | { inStream: [stmNum, index] }
    this.cache = new Map();
    this.scan();
  }

  scan() {
    const text = this.buf.toString('latin1');
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = re.exec(text))) {
      // в файле с дописанными обновлениями действует последнее определение
      this.objs.set(Number(m[1]), { pos: m.index + m[0].length });
    }
    // Потоки объектов (PDF 1.5+): объекты внутри — если такого номера нет среди обычных
    for (const [num] of [...this.objs]) {
      let v;
      try { v = this.get(num); } catch { continue; }
      if (!v || !v.dict || !v.stream || nameOf(v.dict.get('Type')) !== 'ObjStm') continue;
      const data = this.streamData(v);
      if (!data) continue;
      const n = this.resolve(v.dict.get('N'));
      const first = this.resolve(v.dict.get('First'));
      if (!Number.isInteger(n) || !Number.isInteger(first)) continue;
      const lex = new Lexer(data, 0);
      for (let i = 0; i < n; i++) {
        const objNum = lex.value();
        const off = lex.value();
        if (!Number.isInteger(objNum) || !Number.isInteger(off)) break;
        if (!this.objs.has(objNum)) this.objs.set(objNum, { objStm: data, pos: first + off });
      }
    }
  }

  /** Значение объекта; у потоков — { dict, stream: { start } }. */
  get(num) {
    if (this.cache.has(num)) return this.cache.get(num);
    const e = this.objs.get(num);
    if (!e) return null;
    let v = null;
    if (e.objStm) {
      v = new Lexer(e.objStm, e.pos).value();
    } else {
      const lex = new Lexer(this.buf, e.pos);
      v = lex.value();
      lex.skipWs();
      if (v && v.dict && this.buf.toString('latin1', lex.p, lex.p + 6) === 'stream') {
        let start = lex.p + 6;
        if (this.buf[start] === 0x0d) start++;
        if (this.buf[start] === 0x0a) start++;
        v.stream = { start };
      }
    }
    this.cache.set(num, v);
    return v;
  }

  resolve(v, depth = 0) {
    let cur = v;
    while (cur && typeof cur === 'object' && 'ref' in cur && depth++ < 16) cur = this.get(cur.ref);
    return cur;
  }

  /** Распакованное содержимое потока или null, если фильтр не поддерживается. */
  streamData(v) {
    if (!v || !v.stream) return null;
    const { dict } = v;
    let len = this.resolve(dict.get('Length'));
    let end;
    if (Number.isInteger(len) && len >= 0 && v.stream.start + len <= this.buf.length) end = v.stream.start + len;
    else {
      end = this.buf.indexOf('endstream', v.stream.start, 'latin1');
      if (end < 0) return null;
      len = end - v.stream.start;
    }
    let data = this.buf.subarray(v.stream.start, end);
    let filters = this.resolve(dict.get('Filter'));
    let parms = this.resolve(dict.get('DecodeParms'));
    if (filters && !Array.isArray(filters)) filters = [filters];
    if (parms && !Array.isArray(parms)) parms = [parms];
    for (let i = 0; i < (filters || []).length; i++) {
      const f = nameOf(this.resolve(filters[i]));
      if (f !== 'FlateDecode' && f !== 'Fl') return null;
      try { data = zlib.inflateSync(data); } catch {
        try { data = zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { return null; }
      }
      const p = parms && this.resolve(parms[i]);
      const predictor = p && p.dict ? this.resolve(p.dict.get('Predictor')) : null;
      if (Number.isInteger(predictor) && predictor >= 10) {
        data = pngUnpredict(data, this.resolve(p.dict.get('Columns')) || 1, this.resolve(p.dict.get('Colors')) || 1, this.resolve(p.dict.get('BitsPerComponent')) || 8);
      } else if (Number.isInteger(predictor) && predictor > 1) return null;
    }
    return data;
  }

  *entries() {
    for (const num of this.objs.keys()) {
      let v;
      try { v = this.get(num); } catch { continue; }
      yield [num, v];
    }
  }
}

function nameOf(v) { return v && typeof v.name === 'string' ? v.name : null; }

// ------------------------------------------------------------
// TrueType: таблица cmap → «номер глифа → символ»
// ------------------------------------------------------------

const isPua = (cp) => (cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000;

/** Обратная таблица глиф → кодовая точка из всех юникодных подтаблиц cmap. */
function ttfGlyphToUnicode(ttf) {
  const map = new Map();
  if (!ttf || ttf.length < 12) return map;
  const numTables = ttf.readUInt16BE(4);
  let cmapOff = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > ttf.length) break;
    if (ttf.toString('latin1', rec, rec + 4) === 'cmap') cmapOff = ttf.readUInt32BE(rec + 8);
  }
  if (cmapOff < 0 || cmapOff + 4 > ttf.length) return map;
  const put = (gid, cp) => {
    if (!gid || cp < 0x20 || cp === 0xfffe || cp === 0xffff) return;
    const old = map.get(gid);
    if (old === undefined || (isPua(old) && !isPua(cp))) map.set(gid, cp);
  };
  const n = ttf.readUInt16BE(cmapOff + 2);
  for (let i = 0; i < n; i++) {
    const rec = cmapOff + 4 + i * 8;
    if (rec + 8 > ttf.length) break;
    const platform = ttf.readUInt16BE(rec);
    const encoding = ttf.readUInt16BE(rec + 2);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue; // (3,0) — символьные шрифты: коды F0xx, не Юникод
    const off = cmapOff + ttf.readUInt32BE(rec + 4);
    if (off + 4 > ttf.length) continue;
    const format = ttf.readUInt16BE(off);
    try {
      if (format === 4) {
        const segX2 = ttf.readUInt16BE(off + 6);
        const ends = off + 14;
        const starts = ends + segX2 + 2;
        const deltas = starts + segX2;
        const ranges = deltas + segX2;
        for (let s = 0; s < segX2 / 2; s++) {
          const end = ttf.readUInt16BE(ends + s * 2);
          const start = ttf.readUInt16BE(starts + s * 2);
          const delta = ttf.readInt16BE(deltas + s * 2);
          const ro = ttf.readUInt16BE(ranges + s * 2);
          for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
            let gid;
            if (ro === 0) gid = (cp + delta) & 0xffff;
            else {
              const gi = ranges + s * 2 + ro + (cp - start) * 2;
              if (gi + 2 > ttf.length) continue;
              gid = ttf.readUInt16BE(gi);
              if (gid) gid = (gid + delta) & 0xffff;
            }
            put(gid, cp);
          }
        }
      } else if (format === 12) {
        const groups = ttf.readUInt32BE(off + 12);
        for (let g = 0; g < groups && off + 16 + g * 12 + 12 <= ttf.length; g++) {
          const base = off + 16 + g * 12;
          const sc = ttf.readUInt32BE(base);
          const ec = ttf.readUInt32BE(base + 4);
          const sg = ttf.readUInt32BE(base + 8);
          for (let cp = sc; cp <= ec && cp - sc < 0x10000; cp++) put(sg + (cp - sc), cp);
        }
      } else if (format === 6) {
        const first = ttf.readUInt16BE(off + 6);
        const count = ttf.readUInt16BE(off + 8);
        for (let k = 0; k < count; k++) put(ttf.readUInt16BE(off + 10 + k * 2), first + k);
      }
    } catch { /* повреждённая подтаблица — берём то, что успели */ }
  }
  return map;
}

// ------------------------------------------------------------
// Шрифты без ToUnicode, которые можно восстановить
// ------------------------------------------------------------

/**
 * → [{ baseFont, encoding, cidToUnicode: Map }] — составные шрифты Identity-H/V со
 * встроенным TrueType и без ToUnicode, для которых cmap шрифта даёт символы.
 */
function findRecoverableFonts(buffer) {
  let pdf;
  try { pdf = new PdfObjects(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)); } catch { return []; }
  const out = [];
  for (const [, v] of pdf.entries()) {
    if (!v || !v.dict) continue;
    const d = v.dict;
    if (nameOf(pdf.resolve(d.get('Type'))) !== 'Font' || nameOf(pdf.resolve(d.get('Subtype'))) !== 'Type0') continue;
    if (d.has('ToUnicode')) continue; // pdf.js читает ToUnicode сам
    const encoding = nameOf(pdf.resolve(d.get('Encoding')));
    if (encoding !== 'Identity-H' && encoding !== 'Identity-V') continue;
    const desc = pdf.resolve((pdf.resolve(d.get('DescendantFonts')) || [])[0]);
    if (!desc || !desc.dict || nameOf(pdf.resolve(desc.dict.get('Subtype'))) !== 'CIDFontType2') continue;
    const fd = pdf.resolve(desc.dict.get('FontDescriptor'));
    const ff = fd && fd.dict ? pdf.resolve(fd.dict.get('FontFile2')) : null;
    const ttf = pdf.streamData(ff);
    if (!ttf) continue;
    const g2u = ttfGlyphToUnicode(ttf);
    if (g2u.size === 0) continue;
    // CID → GID: Identity (по умолчанию) или поток из двухбайтовых номеров
    const c2g = pdf.resolve(desc.dict.get('CIDToGIDMap'));
    let cidToGid = null;
    if (c2g && c2g.stream) {
      const data = pdf.streamData(c2g);
      if (!data) continue;
      cidToGid = (cid) => (cid * 2 + 1 < data.length ? data.readUInt16BE(cid * 2) : 0);
    }
    const cidToUnicode = new Map();
    if (cidToGid) {
      const maxCid = Math.floor(pdf.streamData(c2g).length / 2);
      for (let cid = 0; cid < maxCid; cid++) {
        const cp = g2u.get(cidToGid(cid));
        if (cp !== undefined) cidToUnicode.set(cid, cp);
      }
    } else {
      g2u.forEach((cp, gid) => cidToUnicode.set(gid, cp));
    }
    const baseFont = nameOf(pdf.resolve(d.get('BaseFont'))) || nameOf(pdf.resolve(desc.dict.get('BaseFont'))) || '';
    out.push({ baseFont, encoding, cidToUnicode });
  }
  return out;
}

// ------------------------------------------------------------
// Читаемость текста
// ------------------------------------------------------------

/** Сколько «читаемых» букв (кириллица и латиница) и «нечитаемых» знаков (прочие буквы,
 *  управляющие символы, частная область Юникода) в строке. Цифры и пунктуация не в счёт. */
function textStats(s) {
  let readable = 0;
  let unreadable = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x0410 && cp <= 0x044f) || cp === 0x0401 || cp === 0x0451 || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) readable++;
    else if ((cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || isPua(cp) || /\p{L}/u.test(ch)) unreadable++;
  }
  return { readable, unreadable };
}

const readableRatio = ({ readable, unreadable }) => (readable + unreadable === 0 ? 1 : readable / (readable + unreadable));

/** Перевод строки pdf.js (символы = CID) через таблицу шрифта. Пробел U+0020 оставляем
 *  пробелом: его pdf.js вставляет сам между словами. */
function mapCidString(str, cidToUnicode) {
  let out = '';
  for (const ch of str) {
    const cid = ch.codePointAt(0);
    if (cid === 0x20) { out += ' '; continue; }
    const cp = cidToUnicode.get(cid);
    out += cp === undefined ? '�' : String.fromCodePoint(cp);
  }
  return out;
}

module.exports = { PdfObjects, ttfGlyphToUnicode, findRecoverableFonts, textStats, readableRatio, mapCidString, Lexer };
