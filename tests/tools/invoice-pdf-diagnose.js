#!/usr/bin/env node
// Диагностика PDF счёта, который не распознаётся (задача #8). Печатает СТРУКТУРУ документа
// без его содержимого, чтобы результат можно было приложить к задаче, не раскрывая
// реквизиты: какие шрифты и кодировки в файле, есть ли у шрифтов таблица ToUnicode, какие
// классы символов отдаёт pdf.js, удалось ли восстановить текст и что нашёл разбор
// (только какие поля и сколько позиций, без значений).
//
// Запуск:  node tests/tools/invoice-pdf-diagnose.js путь/к/счёту.pdf [--masked]
//   --masked — дополнительно строки страниц, где каждая кириллическая буква заменена на
//              «я/Я», латинская — на «x/X», цифра — на «9». Видно расположение колонок и
//              заголовков, но не сами данные. Перед публикацией всё же просмотрите вывод.
const fs = require('fs');
const path = require('path');
const { extractPdfText, installDomMatrixPolyfill } = require('../../src/main/invoicePdf');
const { PdfObjects, findRecoverableFonts } = require('../../src/main/pdfFontRecovery');
const { parseInvoice } = require('../../src/shared/invoiceParser');

const file = process.argv[2];
const masked = process.argv.includes('--masked');
if (!file) {
  console.log('Использование: node tests/tools/invoice-pdf-diagnose.js счёт.pdf [--masked]');
  process.exit(2);
}

function classify(s) {
  const c = { cyrillic: 0, latin: 0, digits: 0, latin1Letters: 0, control: 0, pua: 0, otherLetters: 0, spaces: 0, other: 0 };
  const blocks = new Map();
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x400 && cp <= 0x4ff) c.cyrillic++;
    else if (/[A-Za-z]/.test(ch)) c.latin++;
    else if (/[0-9]/.test(ch)) c.digits++;
    else if (/\s/.test(ch)) c.spaces++;
    else if (cp < 0x20) c.control++;
    else if ((cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000) c.pua++;
    else if (cp >= 0xc0 && cp <= 0xff && /\p{L}/u.test(ch)) c.latin1Letters++;
    else if (/\p{L}/u.test(ch)) c.otherLetters++;
    else c.other++;
    if (cp >= 0x80 && !(cp >= 0x400 && cp <= 0x4ff)) {
      const block = `U+${(cp & ~0xff).toString(16).toUpperCase().padStart(4, '0')}`;
      blocks.set(block, (blocks.get(block) || 0) + 1);
    }
  }
  const top = [...blocks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([b, n]) => `${b}…:${n}`).join(' ');
  return { ...c, blocks: top };
}

const mask = (s) => s.replace(/[А-ЯЁ]/g, 'Я').replace(/[а-яё]/g, 'я').replace(/[A-Z]/g, 'X').replace(/[a-z]/g, 'x').replace(/[0-9]/g, '9');

(async () => {
  const buf = fs.readFileSync(file);
  console.log(`Файл: ${path.basename(file).replace(/[^\w.-]/g, '_')} (${buf.length} байт)`);

  console.log('\n— Шрифты в файле');
  const pdf = new PdfObjects(buf);
  const name = (v) => (v && v.name) || (v && v.dict ? 'словарь' : (v === undefined ? '—' : String(v)));
  let fonts = 0;
  for (const [num, v] of pdf.entries()) {
    if (!v || !v.dict || name(pdf.resolve(v.dict.get('Type'))) !== 'Font') continue;
    const d = v.dict;
    const subtype = name(pdf.resolve(d.get('Subtype')));
    if (subtype === 'CIDFontType0' || subtype === 'CIDFontType2') continue; // покажем в составе Type0
    fonts++;
    const enc = pdf.resolve(d.get('Encoding'));
    let encText = name(enc);
    if (enc && enc.dict) {
      const diff = pdf.resolve(enc.dict.get('Differences'));
      encText = `словарь (база ${name(pdf.resolve(enc.dict.get('BaseEncoding')))}, Differences: ${Array.isArray(diff) ? diff.filter((x) => x && x.name).length : 0} имён)`;
    }
    let embedded = '—';
    let desc = '';
    const fdOf = (dict) => pdf.resolve(dict.get('FontDescriptor'));
    let fd = fdOf(d);
    if (subtype === 'Type0') {
      const df = pdf.resolve((pdf.resolve(d.get('DescendantFonts')) || [])[0]);
      if (df && df.dict) {
        const c2g = pdf.resolve(df.dict.get('CIDToGIDMap'));
        desc = `, потомок ${name(pdf.resolve(df.dict.get('Subtype')))}, CIDToGIDMap ${c2g && c2g.stream ? 'поток' : name(c2g)}`;
        fd = fdOf(df.dict);
      }
    }
    if (fd && fd.dict) embedded = ['FontFile', 'FontFile2', 'FontFile3'].filter((k) => fd.dict.has(k)).join(',') || 'не встроен';
    console.log(`  #${num}: ${subtype} ${name(pdf.resolve(d.get('BaseFont')))}; кодировка ${encText}; ToUnicode: ${d.has('ToUnicode') ? 'есть' : 'НЕТ'}; встроен: ${embedded}${desc}`);
  }
  if (!fonts) console.log('  не найдено (объекты не разобраны или шрифтов нет)');
  const rec = findRecoverableFonts(buf);
  console.log(`  восстановимых по cmap встроенного шрифта: ${rec.length ? rec.map((r) => `${r.baseFont} (${r.cidToUnicode.size} глифов)`).join(', ') : 'нет'}`);

  console.log('\n— Что отдаёт pdf.js (по шрифтам, до восстановления)');
  installDomMatrixPolyfill();
  const { pathToFileURL } = require('url');
  const entry = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjs = await import(pathToFileURL(entry).href);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(path.dirname(entry), 'pdf.worker.mjs')).href;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent({ disableNormalization: true });
    await page.getOperatorList();
    const byFont = new Map();
    tc.items.forEach((it) => { if (typeof it.str === 'string') byFont.set(it.fontName, (byFont.get(it.fontName) || '') + it.str); });
    console.log(`  стр. ${n}: элементов ${tc.items.length}`);
    byFont.forEach((s, f) => {
      let base = '?';
      try { base = page.commonObjs.get(f).name; } catch { /* нет имени */ }
      const c = classify(s);
      console.log(`    ${base}: ${JSON.stringify(c)}`);
    });
  }
  await doc.destroy();

  console.log('\n— Как приложение читает файл');
  const ex = await extractPdfText(buf);
  console.log(`  страниц ${ex.pageCount}; текст: ${ex.hasText ? 'есть' : 'нет'}; нечитаем: ${ex.unreadable ? 'да' : 'нет'}; восстановлены шрифты: ${ex.recoveredFonts.join(', ') || 'нет'}`);
  const parsed = parseInvoice(ex);
  const found = Object.entries(parsed.fields).filter(([, v]) => v !== null).map(([k]) => k);
  console.log(`  распознаны поля: ${found.join(', ') || 'нет'}`);
  console.log(`  позиций: ${parsed.items.length}${parsed.itemsDeclared !== null ? `, «всего наименований»: ${parsed.itemsDeclared}` : ''}`);
  parsed.notes.forEach((t) => console.log(`  примечание: ${t}`));
  if (masked) {
    ex.pages.forEach((p) => {
      console.log(`\n— Стр. ${p.number}, строки (буквы и цифры скрыты)`);
      p.lines.forEach((l) => console.log(`  y=${Math.round(l.y)} | ${l.cells.map((c) => `[x=${Math.round(c.x)}] ${mask(c.text)}`).join('  ')}`));
    });
  }
})().catch((e) => { console.error('Ошибка диагностики:', e && e.message); process.exit(1); });
