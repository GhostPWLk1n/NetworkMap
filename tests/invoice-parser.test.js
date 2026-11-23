#!/usr/bin/env node
// Проверка разбора счетов поставщиков (задача #8) на вымышленных PDF из
// tests/fixtures/invoices: каждое поле шапки, каждая позиция и итоги сравниваются с
// expected.json, плюс ожидаемые предупреждения о расхождениях сумм.
//
// Запуск:  npm run test:invoices        (или: node tests/invoice-parser.test.js)
// Нужен установленный pdfjs-dist (npm install). Node ≥ 20.16.
const fs = require('fs');
const path = require('path');
const { extractPdfText } = require('../src/main/invoicePdf');
const { parseInvoice } = require('../src/shared/invoiceParser');
const M = require('../src/shared/invoiceMath');

const DIR = path.join(__dirname, 'fixtures', 'invoices');
const expected = JSON.parse(fs.readFileSync(path.join(DIR, 'expected.json'), 'utf8'));

let fails = 0;
let checks = 0;
function check(name, cond, extra = '') {
  checks++;
  if (!cond) fails++;
  console.log(`${cond ? '  OK  ' : '  FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
}

const HEADER_FIELDS = ['number', 'invoice_date', 'supplier_name', 'supplier_inn', 'supplier_kpp',
  'buyer_name', 'buyer_inn', 'buyer_kpp', 'currency', 'total_amount', 'vat_amount', 'amount_due', 'vat_note'];
const ITEM_FIELDS = ['code', 'name', 'quantity', 'unit', 'price', 'amount', 'vat_rate', 'vat_amount'];

(async () => {
  // Сначала — что pdf.js вообще загружается без нативного canvas (подмена DOMMatrix)
  const silence = console.warn;
  console.warn = () => {};
  for (const file of Object.keys(expected)) {
    const exp = expected[file];
    console.log(`\n=== ${file}`);
    const buf = fs.readFileSync(path.join(DIR, file));
    const extracted = await extractPdfText(buf);
    const parsed = parseInvoice(extracted);
    check('число страниц', extracted.pageCount === exp.pages, String(extracted.pageCount));

    if (exp.unreadable) {
      check('текст есть, но нечитаем — ничего не выдумано', extracted.unreadable === true && parsed.items.length === 0 &&
        Object.values(parsed.fields).every((v) => v === null));
      check('оператору сказано заполнить вручную', parsed.notes.some((n) => /не читается/.test(n)));
      continue;
    }
    if (/cid-no-tounicode/.test(file)) {
      check('шрифты без ToUnicode восстановлены по cmap встроенного шрифта', extracted.recoveredFonts.length === 2 && !extracted.unreadable,
        extracted.recoveredFonts.join(', '));
    } else {
      check('восстановление не понадобилось', extracted.recoveredFonts.length === 0 && !extracted.unreadable);
    }
    if (exp.no_text_layer) {
      check('текстового слоя нет — ничего не выдумано', !parsed.hasText && parsed.items.length === 0 &&
        Object.values(parsed.fields).every((v) => v === null));
      check('оператору сказано заполнить вручную', parsed.notes.some((n) => /текстового слоя/.test(n)));
      continue;
    }

    HEADER_FIELDS.forEach((f) => {
      const want = exp[f] === undefined ? null : exp[f];
      check(`поле ${f}`, parsed.fields[f] === want, parsed.fields[f] === want ? '' : `получено ${JSON.stringify(parsed.fields[f])}, ожидалось ${JSON.stringify(want)}`);
    });

    const want = exp.items;
    check('число позиций', parsed.items.length === want.length, `${parsed.items.length} из ${want.length}`);
    want.forEach((w, i) => {
      const got = parsed.items[i] || {};
      const diffs = ITEM_FIELDS.filter((f) => (w[f] === undefined ? null : w[f]) !== (got[f] === undefined ? null : got[f]))
        .map((f) => `${f}: ${JSON.stringify(got[f])} ≠ ${JSON.stringify(w[f] === undefined ? null : w[f])}`);
      check(`позиция ${i + 1}`, diffs.length === 0, diffs.join('; '));
    });
    // Ничего лишнего: реквизиты, заголовки, итоги и колонтитулы не стали позициями
    const junk = parsed.items.filter((it) => /итого|всего|ндс|инн|бик|банк|страница|получатель|руководитель|наименован/i.test(it.name));
    check('в позициях нет реквизитов, заголовков и итогов', junk.length === 0, junk.map((j) => j.name).join(' | '));

    if (exp.items_declared !== null && exp.items_declared !== undefined) {
      check('«Всего наименований N» прочитано', parsed.itemsDeclared === exp.items_declared, String(parsed.itemsDeclared));
    }
    const warnings = M.validateInvoice({ ...parsed.fields, items: parsed.items, items_declared: parsed.itemsDeclared });
    const codes = [...new Set(warnings.map((w) => w.code))].sort();
    const wantCodes = [...exp.expected_warnings].sort();
    check('предупреждения о расхождениях', JSON.stringify(codes) === JSON.stringify(wantCodes),
      `${codes.join(',') || 'нет'}${JSON.stringify(codes) === JSON.stringify(wantCodes) ? '' : ` (ожидалось ${wantCodes.join(',') || 'нет'})`}`);
  }

  console.log('\n=== Пути к данным pdf.js');
  const { toPdfjsDir, pdfjsAssetDir } = require('../src/main/invoicePdf');
  check('путь Windows → прямые слеши и «/» в конце',
    toPdfjsDir('C:\\Program Files\\NetworkMap\\resources\\app.asar\\node_modules\\pdfjs-dist\\cmaps') ===
    'C:/Program Files/NetworkMap/resources/app.asar/node_modules/pdfjs-dist/cmaps/');
  check('путь к cmaps кончается на «/» и без «\\»', /\/cmaps\/$/.test(pdfjsAssetDir('cmaps')) && !pdfjsAssetDir('cmaps').includes('\\'));
  check('файлы pdf.js находятся по этому пути', fs.existsSync(`${pdfjsAssetDir("cmaps")}78-H.bcmap`) &&
    fs.readdirSync(pdfjsAssetDir('standard_fonts')).length > 0);

  console.log('\n=== Неправильные файлы');
  for (const [name, data, code] of [
    ['пустой', Buffer.alloc(0), 'empty'],
    ['не PDF', Buffer.from('PK\u0003\u0004 это zip, а не pdf'), 'not_pdf'],
    ['обрезанный PDF', fs.readFileSync(path.join(DIR, 'invoice-3pages.pdf')).subarray(0, 900), 'broken'],
    ['слишком большой', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5 * 1024 * 1024 + 10)]), 'too_large']
  ]) {
    try {
      await extractPdfText(data);
      check(name, false, 'ошибки нет');
    } catch (e) {
      check(`${name} → понятная ошибка`, e.code === code, `${e.code}: ${e.message}`);
    }
  }
  console.warn = silence;

  console.log(`\n${fails === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `ПРОВАЛОВ: ${fails}`} (${checks - fails}/${checks})`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(2); });
