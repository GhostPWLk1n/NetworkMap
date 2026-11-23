// invoicePdf.js
//
// Извлечение текста из PDF счёта (задача #8): pdf.js → страницы → строки с координатами.
// Разбор строк в реквизиты и позиции — отдельно, в src/shared/invoiceParser.js.
//
// Где выполняется: в главном процессе того экземпляра, где оператор выбрал файл. Разбор
// не трогает базу и не зависит от режима (локальный, хост, клиент сервера), поэтому
// библиотека PDF нужна только приложению — в образ выделенного сервера она не попадает.
//
// БЕЗОПАСНОСТЬ. PDF приходит от внешнего поставщика, поэтому:
//  - isEvalSupported: false — pdf.js не компилирует код из шрифтов (класс уязвимостей
//    вроде CVE-2024-4367);
//  - шрифты не загружаются и не рендерятся (disableFontFace), скрипты PDF не исполняются
//    (pdf.js их и не исполняет без отдельного sandbox, который мы не подключаем);
//  - ограничены размер файла и число страниц: разбор идёт в главном процессе.

const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');
const { findRecoverableFonts, textStats, readableRatio, mapCidString } = require('./pdfFontRecovery');

// Предел согласован с RPC: файл идёт на сервер в base64 (+33 %) внутри JSON, а сервер
// принимает тело запроса до 8 МБ (rpcServer.js). 5 МБ с запасом укладываются.
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const MAX_PAGES = 50;

/**
 * pdf.js 5.x в Node при загрузке модуля создаёт `new DOMMatrix()` и берёт DOMMatrix из
 * пакета @napi-rs/canvas. Canvas нам не нужен (мы только читаем текст, ничего не
 * рисуем), а тащить нативный модуль в установщик ради одной матрицы не хочется. Поэтому
 * до загрузки pdf.js подставляем небольшую, но честную реализацию 2D-матрицы: если
 * какая-то ветка всё же её вызовет, результат будет верным, а не «заглушечным».
 */
function installDomMatrixPolyfill() {
  if (globalThis.DOMMatrix) return;
  class DOMMatrix2D {
    constructor(init) {
      let m = [1, 0, 0, 1, 0, 0];
      if (Array.isArray(init) || ArrayBuffer.isView(init)) {
        const a = Array.from(init);
        if (a.length === 6) m = a;
        else if (a.length === 16) m = [a[0], a[1], a[4], a[5], a[12], a[13]];
        else throw new TypeError('DOMMatrix: ожидается 6 или 16 чисел');
      } else if (init && typeof init === 'object') {
        m = [init.a ?? 1, init.b ?? 0, init.c ?? 0, init.d ?? 1, init.e ?? 0, init.f ?? 0];
      }
      [this.a, this.b, this.c, this.d, this.e, this.f] = m.map(Number);
    }
    get is2D() { return true; }
    get isIdentity() { return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0; }
    get m11() { return this.a; } get m12() { return this.b; } get m21() { return this.c; }
    get m22() { return this.d; } get m41() { return this.e; } get m42() { return this.f; }
    #set(a, b, c, d, e, f) { this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f; return this; }
    // this = this × o
    multiplySelf(o) {
      const n = o instanceof DOMMatrix2D ? o : new DOMMatrix2D(o);
      return this.#set(
        this.a * n.a + this.c * n.b, this.b * n.a + this.d * n.b,
        this.a * n.c + this.c * n.d, this.b * n.c + this.d * n.d,
        this.a * n.e + this.c * n.f + this.e, this.b * n.e + this.d * n.f + this.f);
    }
    // this = o × this
    preMultiplySelf(o) {
      const n = o instanceof DOMMatrix2D ? o : new DOMMatrix2D(o);
      const t = new DOMMatrix2D([this.a, this.b, this.c, this.d, this.e, this.f]);
      this.#set(n.a, n.b, n.c, n.d, n.e, n.f);
      return this.multiplySelf(t);
    }
    translateSelf(tx = 0, ty = 0) { return this.multiplySelf([1, 0, 0, 1, tx, ty]); }
    scaleSelf(sx = 1, sy = sx) { return this.multiplySelf([sx, 0, 0, sy, 0, 0]); }
    invertSelf() {
      const det = this.a * this.d - this.b * this.c;
      if (!det) return this.#set(NaN, NaN, NaN, NaN, NaN, NaN);
      return this.#set(
        this.d / det, -this.b / det, -this.c / det, this.a / det,
        (this.c * this.f - this.d * this.e) / det, (this.b * this.e - this.a * this.f) / det);
    }
    multiply(o) { return new DOMMatrix2D(this).multiplySelf(o); }
    translate(tx, ty) { return new DOMMatrix2D(this).translateSelf(tx, ty); }
    scale(sx, sy) { return new DOMMatrix2D(this).scaleSelf(sx, sy); }
    inverse() { return new DOMMatrix2D(this).invertSelf(); }
    transformPoint(p = {}) {
      const x = p.x || 0;
      const y = p.y || 0;
      return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f, z: 0, w: 1 };
    }
  }
  globalThis.DOMMatrix = DOMMatrix2D;
}

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    installDomMatrixPolyfill();
    // ESM-сборка; из CommonJS — через import() по file:// (работает и внутри asar)
    const entry = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
    pdfjsPromise = import(pathToFileURL(entry).href).then((mod) => {
      // Воркер pdf.js в Node — «поддельный», в этом же потоке; указываем его явно, чтобы
      // путь не зависел от рабочей папки и упаковки
      mod.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(path.dirname(entry), 'pdf.worker.mjs')).href;
      return mod;
    });
  }
  return pdfjsPromise;
}

/** Путь к папке для pdf.js: прямые слеши и «/» в конце. pdf.js дописывает к нему имя
 *  файла и при открытии документа требует, чтобы путь кончался именно на «/» — с «\\»
 *  Windows getDocument отказывает, и не открывается ни один PDF. Node на Windows читает
 *  пути с прямыми слешами (и внутри asar тоже). */
function toPdfjsDir(p) {
  return String(p).replace(/\\/g, '/').replace(/\/*$/, '/');
}

/** Папка с данными pdf.js (cmaps, standard_fonts). */
function pdfjsAssetDir(name) {
  return toPdfjsDir(path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), name));
}

class InvoicePdfError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Похоже ли содержимое на PDF вообще (а не переименованный .docx). */
function looksLikePdf(buffer) {
  return buffer.length > 5 && buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'));
}

/**
 * Элементы текста страницы → строки. pdf.js отдаёт фрагменты с координатами (y растёт
 * вверх). Фрагменты с почти одинаковым y — одна строка; внутри строки — по x.
 * Соседние фрагменты, между которыми нет заметного зазора, склеиваются в одну «ячейку»:
 * так «Цена» и «без НДС», нарисованные разными командами, остаются вместе, а колонки
 * таблицы — раздельными.
 */
function groupLines(items) {
  const frags = items
    .filter((it) => typeof it.str === 'string' && it.str.trim() !== '')
    .map((it) => {
      const x = it.transform[4];
      const y = it.transform[5];
      const h = Math.abs(it.height || it.transform[3] || 8);
      return { str: it.str, x, y, x2: x + (it.width || 0), h };
    })
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const lines = [];
  frags.forEach((f) => {
    const tol = Math.max(1.5, f.h * 0.35);
    const line = lines.find((l) => Math.abs(l.y - f.y) <= tol);
    if (line) line.frags.push(f);
    else lines.push({ y: f.y, h: f.h, frags: [f] });
  });

  return lines
    .sort((a, b) => b.y - a.y)
    .map((l) => {
      const sorted = l.frags.sort((a, b) => a.x - b.x);
      const cells = [];
      sorted.forEach((f) => {
        const last = cells[cells.length - 1];
        const gap = last ? f.x - last.x2 : Infinity;
        // зазор меньше ширины ~1,2 символа — тот же текст (слова одной фразы)
        // Исходные фрагменты остаются в ячейке (parts): при тесных колонках таблицы две
        // соседние колонки («Ставка» и «Сумма») могут склеиться в одну ячейку, и разбор
        // таблицы раскладывает по колонкам именно фрагменты, а не ячейки
        const part = { str: f.str.replace(/\s+/g, ' ').trim(), x: f.x, x2: f.x2 };
        if (last && gap < f.h * 0.6) {
          last.text += (gap > f.h * 0.12 ? ' ' : '') + f.str;
          last.x2 = Math.max(last.x2, f.x2);
          last.parts.push(part);
        } else {
          cells.push({ text: f.str, x: f.x, x2: f.x2, parts: [part] });
        }
      });
      cells.forEach((c) => { c.text = c.text.replace(/\s+/g, ' ').trim(); });
      return {
        y: l.y,
        h: l.h,
        cells: cells.filter((c) => c.text),
        text: cells.map((c) => c.text).filter(Boolean).join(' ')
      };
    });
}

/** Шрифты страницы, текст которых не читается (номера глифов вместо букв и т. п.). */
function unreadableFonts(items) {
  const byFont = new Map();
  items.forEach((it) => {
    if (typeof it.str !== 'string' || !it.fontName) return;
    const acc = byFont.get(it.fontName) || { readable: 0, unreadable: 0 };
    const t = textStats(it.str);
    acc.readable += t.readable;
    acc.unreadable += t.unreadable;
    byFont.set(it.fontName, acc);
  });
  const bad = new Set();
  byFont.forEach((acc, font) => { if (acc.unreadable >= 3 && readableRatio(acc) < 0.6) bad.add(font); });
  return bad;
}

/**
 * Перечитывает текст страницы и переводит строки нечитаемых шрифтов через cmap их
 * встроенного TrueType (см. pdfFontRecovery.js). Шрифт сопоставляется по имени BaseFont;
 * перевод принимается, только если текст стал читаемым. → { items, fonts } или null.
 */
async function recoverPageItems(page, badFonts, recoverable) {
  try {
    await page.getOperatorList(); // после этого pdf.js знает имена шрифтов страницы
  } catch { return null; }
  const plan = new Map(); // fontName pdf.js -> cidToUnicode
  badFonts.forEach((fontName) => {
    let info = null;
    try { info = page.commonObjs.get(fontName); } catch { info = null; }
    const name = info && info.name;
    if (!name) return;
    const candidates = recoverable.filter((r) => r.baseFont === name);
    if (candidates.length === 1) plan.set(fontName, candidates[0].cidToUnicode);
  });
  if (!plan.size) return null;
  // Без нормализации Юникода: иначе pdf.js «исправит» часть номеров глифов (лигатуры и
  // т. п.) раньше, чем мы их переведём
  const raw = (await page.getTextContent({ disableNormalization: true })).items;
  const fonts = new Set();
  const mapped = raw.map((it) => {
    const table = plan.get(it.fontName);
    if (!table || typeof it.str !== 'string') return it;
    return { ...it, str: mapCidString(it.str, table) };
  });
  plan.forEach((_t, fontName) => {
    const acc = { readable: 0, unreadable: 0 };
    mapped.forEach((it) => {
      if (it.fontName !== fontName) return;
      const t = textStats(it.str);
      acc.readable += t.readable;
      acc.unreadable += t.unreadable;
    });
    if (readableRatio(acc) >= 0.8) fonts.add(fontName);
  });
  if (!fonts.size) return null;
  // Переводим только те шрифты, у которых перевод действительно дал читаемый текст
  const items = raw.map((it) => (fonts.has(it.fontName) && typeof it.str === 'string'
    ? { ...it, str: mapCidString(it.str, plan.get(it.fontName)) }
    : it));
  return { items, fonts: [...fonts].map((f) => { try { return page.commonObjs.get(f).name; } catch { return f; } }) };
}

/**
 * Текст PDF по страницам. buffer — содержимое файла.
 * Возвращает { pageCount, hasText, pages: [{ number, width, height, lines }] }.
 */
async function extractPdfText(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length === 0) throw new InvoicePdfError('empty', 'Файл пустой.');
  if (buffer.length > MAX_PDF_BYTES) {
    throw new InvoicePdfError('too_large',
      `Файл больше ${Math.round(MAX_PDF_BYTES / 1024 / 1024)} МБ — такой счёт не загрузить. Сожмите PDF или сохраните его без лишних изображений.`);
  }
  if (!looksLikePdf(buffer)) throw new InvoicePdfError('not_pdf', 'Это не PDF-файл.');

  const pdfjs = await loadPdfjs();
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer), // копия: pdf.js может «забрать» переданный буфер
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      disableAutoFetch: true,
      // Таблицы кодировок CID-шрифтов и метрики стандартных шрифтов — из пакета, с
      // диска (в Node pdf.js читает их через fs, в т. ч. из asar). Без них текст
      // документов с нестандартной кодировкой шрифта не извлекается
      cMapUrl: pdfjsAssetDir('cmaps'),
      cMapPacked: true,
      standardFontDataUrl: pdfjsAssetDir('standard_fonts'),
      verbosity: 0
    }).promise;
  } catch (err) {
    if (err && err.name === 'PasswordException') {
      throw new InvoicePdfError('encrypted', 'PDF защищён паролем — откройте его и сохраните без пароля.');
    }
    throw new InvoicePdfError('broken', 'Не удалось прочитать PDF: файл повреждён или имеет неподдерживаемый формат.');
  }

  try {
    if (doc.numPages > MAX_PAGES) {
      throw new InvoicePdfError('too_many_pages', `В PDF ${doc.numPages} страниц — для счёта это слишком много (предел ${MAX_PAGES}).`);
    }
    const pages = [];
    let recoverable = null; // шрифты без ToUnicode — ищутся в файле, только если понадобились
    const recoveredFonts = new Set();
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      let items = (await page.getTextContent()).items;
      const bad = unreadableFonts(items);
      if (bad.size) {
        if (recoverable === null) recoverable = findRecoverableFonts(buffer);
        if (recoverable.length) {
          const fixed = await recoverPageItems(page, bad, recoverable);
          if (fixed) {
            items = fixed.items;
            fixed.fonts.forEach((f) => recoveredFonts.add(f));
          }
        }
      }
      pages.push({ number: n, width: viewport.width, height: viewport.height, lines: groupLines(items) });
      page.cleanup();
    }
    const textChars = pages.reduce((s, p) => s + p.lines.reduce((t, l) => t + l.text.replace(/\s/g, '').length, 0), 0);
    // Текст есть, но он не читается (шрифты без таблицы символов, которую не удалось
    // восстановить): распознавать нечего — форма предложит заполнить счёт вручную
    const stats = pages.reduce((acc, p) => {
      p.lines.forEach((l) => { const t = textStats(l.text); acc.readable += t.readable; acc.unreadable += t.unreadable; });
      return acc;
    }, { readable: 0, unreadable: 0 });
    const unreadable = textChars >= 20 && readableRatio(stats) < 0.6;
    return {
      pageCount: doc.numPages,
      hasText: textChars >= 20,
      unreadable,
      recoveredFonts: [...recoveredFonts],
      pages
    };
  } finally {
    await doc.destroy();
  }
}

module.exports = { MAX_PDF_BYTES, MAX_PAGES, InvoicePdfError, extractPdfText, groupLines, sha256, looksLikePdf, installDomMatrixPolyfill, toPdfjsDir, pdfjsAssetDir };
