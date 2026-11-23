// invoiceParser.js — разбор текста счёта поставщика в реквизиты, позиции и итоги (#8).
//
// Вход — результат extractPdfText (src/main/invoicePdf.js): страницы → строки → ячейки с
// исходными фрагментами и их координатами. Выход — то, что увидит оператор в форме
// проверки: { fields, items, itemsDeclared, recognized, notes }.
//
// Главный принцип: ничего не угадывать. Поле, которого нет в документе или которое не
// удалось уверенно найти, остаётся пустым — оператор заполнит его сам. Числа берутся
// как в документе (каноническая строка, см. invoiceMath.js), суммы НЕ досчитываются.
//
// Как устроен разбор таблицы позиций:
//  1. Заголовок ищется по ключевым словам колонок (наименование + количество/цена/сумма);
//     многострочный заголовок («Цена без» / «НДС») склеивается по перекрытию по x.
//  2. Границы колонок берутся НЕ из заголовков, а из «просветов» в данных: строки
//     таблицы проецируются на ось x, колонки — это полосы, между которыми во всех строках
//     пусто. Так верно размечаются и числа, выровненные вправо под заголовком, выровненным
//     влево (иначе количество уезжало бы в колонку «Ед.»).
//  3. Строки: начало позиции — есть количество и сумма/цена; строка только с текстом в
//     колонке наименования сразу под позицией — перенос наименования.
//  4. Таблица продолжается на следующих страницах (с повтором заголовка или без) до
//     строки итогов; колонтитулы и подписи позициями не становятся.
//  5. Итоги («Итого», «В том числе НДС», «К оплате», «Всего наименований N») ищутся на
//     любой странице после начала таблицы.
const M = require('./invoiceMath');

// В JavaScript \b понимает только латиницу, поэтому в регулярных выражениях ниже граница
// русского слова — явная проверка соседнего символа: (?![0-9A-Za-zА-Яа-яЁё]).
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------
// Даты
// ------------------------------------------------------------
const MONTHS = [/^январ/, /^феврал/, /^март/, /^апрел/, /^ма[йя]/, /^июн/, /^июл/, /^август/, /^сентябр/, /^октябр/, /^ноябр/, /^декабр/];

function isoDate(y, m, d) {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (y < 1990 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** «12 ноября 2026 г.», «05.11.2026», «5.11.26», «2026-11-05» → ISO, иначе null. */
function parseDate(text) {
  const s = norm(text);
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return isoDate(+m[1], +m[2], +m[3]);
  m = /(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?!\d)/.exec(s);
  if (m) return isoDate(+m[3], +m[2], +m[1]);
  m = /(\d{1,2})\s+([а-я]+)\s+(\d{4})/.exec(s);
  if (m) {
    const month = MONTHS.findIndex((re) => re.test(m[2]));
    if (month >= 0) return isoDate(+m[3], month + 1, +m[1]);
  }
  return null;
}

// ------------------------------------------------------------
// Числа внутри строки
// ------------------------------------------------------------
const NUM_TOKEN = /-?\d{1,3}(?:[   ]\d{3})+(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?/g;

/** Последнее число строки (проценты вида «(20%)» и «20 %» в расчёт не берутся). */
function lastNumber(text) {
  const cleaned = String(text).replace(/\(?\s*\d+(?:[.,]\d+)?\s*%\s*\)?/g, ' ');
  const tokens = cleaned.match(NUM_TOKEN) || [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    const v = M.parseDecimal(tokens[i]);
    if (v !== null) return v;
  }
  return null;
}

// ------------------------------------------------------------
// Шапка: номер, дата, стороны, валюта
// ------------------------------------------------------------
// «Сч. №» в банковских реквизитах сюда не попадает: нужно полное слово «счёт/счет»
const TITLE_RE = /(?:^|[\s"«(])(сч[её]т(?:[\s-]+(?:на\s+оплату|оферта|фактура))?|инвойс|invoice|proforma)(?![0-9A-Za-zА-Яа-яЁё])[^№#]{0,30}[№#]\s*([0-9A-Za-zА-Яа-яЁё][0-9A-Za-zА-Яа-яЁё\-/._]*)(?:\s+от\s+(.{6,40}))?/i;
const SUPPLIER_LABEL = /^(поставщик|исполнитель|продавец)(\s*\([^)]*\))?\s*[:\-–]?\s*/i;
const BUYER_LABEL = /^(покупатель|заказчик|плательщик)(\s*\([^)]*\))?\s*[:\-–]?\s*/i;
const ANY_LABEL = /^(поставщик|исполнитель|продавец|покупатель|заказчик|плательщик|грузоотправитель|грузополучатель|основание|банк|получатель)(?![0-9A-Za-zА-Яа-яЁё])/i;

function parseParty(rest) {
  const out = { name: null, inn: null, kpp: null };
  let m = /ИНН\s*\/\s*КПП\s*:?\s*(\d{12}|\d{10})\s*\/\s*(\d{9})(?!\d)/i.exec(rest);
  if (m) { out.inn = m[1]; out.kpp = m[2]; }
  if (!out.inn) { m = /ИНН\s*:?\s*(\d{12}|\d{10})(?!\d)/i.exec(rest); if (m) out.inn = m[1]; }
  if (!out.kpp) { m = /КПП\s*:?\s*(\d{9})(?!\d)/i.exec(rest); if (m) out.kpp = m[1]; }
  let name = rest.split(/,?\s*(?:ИНН|КПП|ОГРНИП|ОГРН|р\/сч?|БИК|юр\.?\s*адрес|адрес|тел\.?|e-?mail)(?![0-9A-Za-zА-Яа-яЁё])/i)[0];
  name = name.split(/,\s*(?:г\.|город|ул\.|улица|пр\.|просп|д\.|\d{6})/i)[0];
  name = name.replace(/[\s,;:]+$/, '').trim();
  out.name = name || null;
  return out;
}

function findParty(lines, labelRe) {
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].text.trim();
    const m = labelRe.exec(text);
    if (!m) continue;
    let rest = text.slice(m[0].length);
    // Реквизиты стороны иногда переносятся на следующую строку — берём её, если в ней
    // нет собственной метки (не «Покупатель», не начало таблицы)
    for (let k = 1; k <= 2 && !/ИНН/i.test(rest) && lines[i + k]; k++) {
      const next = lines[i + k].text.trim();
      if (!next || ANY_LABEL.test(next) || headerScore(lines[i + k]) > 0) break;
      rest += `, ${next}`;
    }
    const party = parseParty(rest);
    if (party.name || party.inn) return party;
  }
  return { name: null, inn: null, kpp: null };
}

const CURRENCIES = [
  [/^(rub|rur|руб|₽|рубл)/i, 'RUB'], [/^(usd|\$|долл)/i, 'USD'], [/^(eur|€|евро)/i, 'EUR'],
  [/^(cny|юан)/i, 'CNY'], [/^(kzt|тенге)/i, 'KZT'], [/^(byn)/i, 'BYN']
];
function currencyCode(token) {
  const t = String(token || '').trim();
  const hit = CURRENCIES.find(([re]) => re.test(t));
  if (hit) return hit[1];
  return /^[A-Z]{3}$/.test(t) ? t : null;
}

/** Валюта — только если она явно названа: строка «Валюта: USD» или обозначение
 *  у сумм («руб.», «₽», «USD»). Догадок «по умолчанию рубли» нет. */
function findCurrency(lines) {
  for (const l of lines) {
    const m = /валют[аы](?:\s+(?:сч[её]та|платежа|расч[её]тов))?\s*:?\s*([A-Za-zА-Яа-я$€₽]+)/i.exec(l.text);
    if (m) {
      const c = currencyCode(m[1]);
      if (c) return c;
    }
  }
  for (const l of lines) {
    const t = l.text;
    if (/\d[\d\s .,]*\s*(руб\.?|рублей|₽)(?![а-я])/i.test(t) || /\bRUB\b/.test(t)) return 'RUB';
    if (/\bUSD\b|\$\s*\d|\d\s*\$|долл/i.test(t)) return 'USD';
    if (/\bEUR\b|€|евро/i.test(t)) return 'EUR';
  }
  return null;
}

// ------------------------------------------------------------
// Таблица позиций
// ------------------------------------------------------------
function classifyHeader(title) {
  const t = norm(title);
  if (!t) return null;
  if (/^(№|n|no\.?|#)(\s*п\/п)?$|^п\/п$/.test(t)) return 'index';
  if (/ставк|^ндс\s*,?\s*%$|%\s*ндс/.test(t)) return 'vat_rate';
  if (/сумма\s+ндс|^ндс$|ндс\s*,\s*(руб|сумма)|в т\.?\s*ч\.?\s*ндс|сумма налога/.test(t)) return 'vat_amount';
  if (/артикул|^код|код товара|каталож|парт.?номер|p\/n/.test(t)) return 'code';
  if (/кол-?\s*во|количеств|^кол\.?$/.test(t)) return 'quantity';
  if (/^ед(?![а-я])|единиц/.test(t)) return 'unit';
  if (/цена|стоимость ед/.test(t)) return 'price';
  if (/сумма|стоимость|^всего/.test(t)) return 'amount';
  if (/наименован|товар|работ|услуг|описани|номенклатур|предмет/.test(t)) return 'name';
  return null;
}

/** Фрагменты строки (ячейки уже склеены в invoicePdf.groupLines, parts — исходные). */
function lineParts(line) {
  const parts = [];
  line.cells.forEach((c) => (c.parts || [{ str: c.text, x: c.x, x2: c.x2 }]).forEach((p) => {
    if (p.str) parts.push({ str: p.str, x: p.x, x2: p.x2 });
  }));
  return parts.sort((a, b) => a.x - b.x);
}

/** Фрагменты заголовка → слова одной колонки вместе, разные колонки раздельно. Зазор
 *  между словами одного заголовка ~ ширина пробела, между колонками — заметно больше. */
function headerChunks(line) {
  const parts = lineParts(line);
  const chunks = [];
  const gapLimit = Math.max(2.2, (line.h || 8) * 0.4);
  parts.forEach((p) => {
    const last = chunks[chunks.length - 1];
    if (last && p.x - last.x2 < gapLimit) {
      last.str += ` ${p.str}`;
      last.x2 = Math.max(last.x2, p.x2);
    } else {
      chunks.push({ ...p });
    }
  });
  return chunks;
}

/** Похожа ли строка на заголовок таблицы: есть «наименование» и хотя бы одно из
 *  «количество/цена/сумма». Возвращает число распознанных колонок (0 — не заголовок). */
function headerScore(line) {
  if (!line || !line.cells) return 0;
  const kinds = new Set(headerChunks(line).map((c) => classifyHeader(c.str)).filter(Boolean));
  if (!kinds.has('name')) return 0;
  const money = ['quantity', 'price', 'amount'].filter((k) => kinds.has(k)).length;
  return money >= 1 ? kinds.size : 0;
}

const HAS_NUMBER = /\d+[.,]\d+|\d{2,}/;

/** Заголовок начиная со строки idx: склеивает продолжение заголовка на следующих
 *  строках («Цена без» + «НДС»). Возвращает { columns, endIdx } или null. */
function readHeader(lines, idx) {
  const first = lines[idx];
  const columns = headerChunks(first).map((c) => ({ x: c.x, x2: c.x2, texts: [c.str] }));
  let end = idx;
  for (let k = idx + 1; k < Math.min(lines.length, idx + 4); k++) {
    const l = lines[k];
    const dy = lines[k - 1].y - l.y;
    if (dy > Math.max(l.h, first.h) * 1.8) break;
    const chunks = headerChunks(l);
    // строка с суммами — это уже данные, а не продолжение заголовка
    if (chunks.some((c) => HAS_NUMBER.test(c.str) && M.parseDecimal(c.str) !== null)) break;
    if (!chunks.every((c) => c.str.length <= 30)) break;
    chunks.forEach((c) => {
      const col = columns.find((cl) => c.x < cl.x2 + 2 && c.x2 > cl.x - 2);
      if (col) { col.texts.push(c.str); col.x = Math.min(col.x, c.x); col.x2 = Math.max(col.x2, c.x2); }
      else columns.push({ x: c.x, x2: c.x2, texts: [c.str] });
    });
    end = k;
  }
  columns.forEach((c) => { c.title = c.texts.join(' '); c.kind = classifyHeader(c.title); });
  columns.sort((a, b) => a.x - b.x);
  const kinds = columns.map((c) => c.kind);
  if (!kinds.includes('name')) return null;

  // Несколько колонок «сумма» (без НДС / с НДС): сумма строки — «с НДС»/«всего»,
  // иначе самая правая; остальные не используем
  const amountCols = columns.filter((c) => c.kind === 'amount');
  if (amountCols.length > 1) {
    const main = amountCols.find((c) => /с\s*ндс|всего|итого/i.test(norm(c.title))) || amountCols[amountCols.length - 1];
    amountCols.forEach((c) => { if (c !== main) c.kind = null; });
  }
  ['price', 'quantity', 'code', 'unit', 'index', 'name', 'vat_rate', 'vat_amount'].forEach((kind) => {
    const same = columns.filter((c) => c.kind === kind);
    same.slice(1).forEach((c) => { c.kind = null; });
  });
  return { columns, endIdx: end };
}

const STOP_RE = /^(итого|всего|в том числе|в т\.\s*ч|без налога|без ндс|ндс\s|ндс:|сумма ндс|к оплате|сумма прописью|total)/;
const FOOTER_RE = /страница\s+\d+\s+из\s+\d+|^стр\.?\s*\d+|^\d+\s*\/\s*\d+$|^-\s*\d+\s*-$/;
function isStopLine(line) {
  const t = norm(line.text);
  return STOP_RE.test(t) || /всего наименований/.test(t);
}

/** Полосы колонок по данным: где по оси x во всех «табличных» строках есть текст.
 *  Строки из одного фрагмента (переносы, колонтитулы) в разметке не участвуют. */
function dataBands(dataLines) {
  const tabular = dataLines.filter((l) => lineParts(l).length >= 3);
  if (!tabular.length) return [];
  const intervals = [];
  tabular.forEach((l) => lineParts(l).forEach((p) => intervals.push([p.x, Math.max(p.x2, p.x + 1)])));
  intervals.sort((a, b) => a[0] - b[0]);
  const bands = [];
  intervals.forEach(([a, b]) => {
    const last = bands[bands.length - 1];
    if (last && a <= last.x2 + 0.5) last.x2 = Math.max(last.x2, b);
    else bands.push({ x: a, x2: b });
  });
  return bands;
}

/** Сопоставляет полосы данных колонкам заголовка. Возвращает функцию «фрагмент → вид
 *  колонки». Если в одну полосу попали две колонки заголовка (данные слиплись), полоса
 *  делится по серединам между заголовками. */
function makeAssigner(columns, bands) {
  const kinds = columns.filter((c) => c.kind);
  const bandKinds = bands.map(() => []);
  kinds.forEach((col) => {
    let best = -1;
    let bestScore = 0;
    bands.forEach((b, i) => {
      const overlap = Math.min(col.x2, b.x2) - Math.max(col.x, b.x);
      const score = overlap > 0 ? overlap : -Math.abs((col.x + col.x2) / 2 - (b.x + b.x2) / 2);
      if (best < 0 || score > bestScore) { best = i; bestScore = score; }
    });
    if (best >= 0 && bestScore > -40) bandKinds[best].push(col);
  });
  const center = (o) => (o.x + o.x2) / 2;
  return (part) => {
    const c = center(part);
    let idx = bands.findIndex((b) => c >= b.x - 0.5 && c <= b.x2 + 0.5);
    if (idx < 0) {
      // фрагмент вне полос (например, перенос наименования длиннее строк данных) —
      // ближайшая полоса, если она рядом
      let bestD = Infinity;
      bands.forEach((b, i) => {
        const d = c < b.x ? b.x - c : c - b.x2;
        if (d < bestD) { bestD = d; idx = i; }
      });
      if (bestD > 12) return null;
    }
    const cols = bandKinds[idx];
    if (!cols || !cols.length) return null;
    if (cols.length === 1) return cols[0].kind;
    return cols.reduce((a, b) => (Math.abs(center(a) - c) <= Math.abs(center(b) - c) ? a : b)).kind;
  };
}

function rowCells(line, assign) {
  const cells = {};
  lineParts(line).forEach((p) => {
    const kind = assign(p);
    if (!kind) return;
    cells[kind] = cells[kind] ? `${cells[kind]} ${p.str}` : p.str;
  });
  return cells;
}

function isItemStart(cells, columns) {
  const has = (k) => columns.some((c) => c.kind === k);
  const qty = M.parseDecimal(cells.quantity);
  const amount = M.parseDecimal(cells.amount);
  const price = M.parseDecimal(cells.price);
  if (has('index') && cells.index !== undefined && !/^\d+\.?$/.test(cells.index.trim())) return false;
  if (!(cells.name || cells.code)) return false;
  if (has('quantity')) return qty !== null && (amount !== null || price !== null);
  return amount !== null;
}

function toItem(cells) {
  const pick = (k) => (cells[k] ? cells[k].replace(/\s+/g, ' ').trim() : null);
  return {
    code: pick('code'),
    name: pick('name') || '',
    unit: pick('unit'),
    quantity: M.parseDecimal(cells.quantity),
    price: M.parseDecimal(cells.price),
    amount: M.parseDecimal(cells.amount),
    vat_rate: pick('vat_rate'),
    vat_amount: M.parseDecimal(cells.vat_amount)
  };
}

/** Позиции по всем страницам. Возвращает { items, found, tableEnd: {page, lineIdx} }. */
function parseTable(pages) {
  const items = [];
  let header = null;          // заголовок действующей таблицы
  let started = false;
  let stopped = false;
  let tableEnd = null;

  for (let p = 0; p < pages.length && !stopped; p++) {
    const lines = pages[p].lines;
    let i = 0;
    if (!started) {
      // таблица начинается с заголовка; всё до него (реквизиты, условия) — не позиции
      while (i < lines.length && headerScore(lines[i]) === 0) i++;
      if (i >= lines.length) continue;
    }
    // повтор заголовка на новой странице
    if (started) {
      const rep = lines.findIndex((l, k) => k < 6 && headerScore(l) > 0);
      if (rep >= 0) i = rep;
    }
    if (i < lines.length && headerScore(lines[i]) > 0) {
      const h = readHeader(lines, i);
      if (h) { header = h; i = h.endIdx + 1; started = true; }
    }
    if (!started) continue;

    // строки этой страницы до итогов
    let end = lines.length;
    for (let k = i; k < lines.length; k++) {
      if (isStopLine(lines[k])) { end = k; stopped = true; tableEnd = { page: p, lineIdx: k }; break; }
    }
    const segment = lines.slice(i, end).filter((l) => !FOOTER_RE.test(norm(l.text)));
    const assign = makeAssigner(header.columns, dataBands(segment));

    let prevLine = null;
    segment.forEach((line) => {
      const cells = rowCells(line, assign);
      if (isItemStart(cells, header.columns)) {
        items.push(toItem(cells));
        prevLine = line;
        return;
      }
      // перенос наименования: только текст наименования, сразу под предыдущей строкой
      const keys = Object.keys(cells);
      const onlyName = keys.length > 0 && keys.every((k) => k === 'name' || k === 'code');
      const close = prevLine && (prevLine.y - line.y) <= Math.max(line.h, prevLine.h) * 1.6;
      if (onlyName && close && items.length && cells.name) {
        const last = items[items.length - 1];
        last.name = `${last.name} ${cells.name}`.replace(/\s+/g, ' ').trim();
        prevLine = line;
        return;
      }
      prevLine = null; // посторонняя строка разрывает цепочку переносов
    });
  }
  return { items, found: started, tableEnd };
}

// ------------------------------------------------------------
// Итоги
// ------------------------------------------------------------
function parseTotals(pages, tableEnd) {
  const out = { total_amount: null, vat_amount: null, amount_due: null, vat_note: null, itemsDeclared: null, declaredSum: null };
  const lines = [];
  pages.forEach((pg, p) => pg.lines.forEach((l, k) => {
    if (!tableEnd || p > tableEnd.page || (p === tableEnd.page && k >= tableEnd.lineIdx)) lines.push(l);
  }));
  lines.forEach((l) => {
    const t = norm(l.text);
    let m = /всего наименований\s*:?\s*(\d+)(?:.*?на сумму\s*([\d\s .,]+))?/.exec(t);
    if (m) {
      if (out.itemsDeclared === null) out.itemsDeclared = Number(m[1]);
      if (m[2] && out.declaredSum === null) out.declaredSum = M.parseDecimal(m[2].trim());
      return;
    }
    // Порядок важен: «Итого без НДС: 2 898,00» — это итог, а не пометка «без НДС»;
    // «Итого НДС» — это НДС; «Без налога (НДС)» — пометка, что НДС нет.
    if (/к оплате/.test(t)) {
      if (out.amount_due === null) out.amount_due = lastNumber(l.text);
      return;
    }
    const noVat = /^(без налога|без ндс)|ндс не облагается/.test(t);
    if (noVat) {
      if (out.vat_note === null) {
        const raw = l.text.match(/без налога(?:\s*\(НДС\))?|без НДС|НДС не облагается/i);
        out.vat_note = raw ? raw[0] : 'без НДС';
      }
      return;
    }
    if (/^(итого|всего)\s+ндс|(в том числе|в т\.?\s*ч\.?)\s*ндс|^сумма ндс|^ндс(?![а-я])/.test(t)) {
      if (/без ндс|не облагается/.test(t)) {
        if (out.vat_note === null) out.vat_note = 'без НДС';
      } else if (out.vat_amount === null) {
        out.vat_amount = lastNumber(l.text);
      }
      return;
    }
    if (/^(итого|всего)(?![а-я])/.test(t)) {
      if (out.total_amount === null) out.total_amount = lastNumber(l.text);
    }
  });
  if (out.total_amount === null && out.declaredSum !== null) out.total_amount = out.declaredSum;
  return out;
}

// ------------------------------------------------------------
// Всё вместе
// ------------------------------------------------------------
const FIELD_KEYS = ['number', 'invoice_date', 'supplier_name', 'supplier_inn', 'supplier_kpp',
  'buyer_name', 'buyer_inn', 'buyer_kpp', 'currency', 'total_amount', 'vat_amount', 'amount_due', 'vat_note'];

/**
 * extracted — результат extractPdfText. Возвращает:
 *  { fields: {...FIELD_KEYS}, items: [...], itemsDeclared, recognized: {field: true},
 *    hasText, notes: [строки для оператора] }
 */
function parseInvoice(extracted) {
  const pages = extracted.pages || [];
  const notes = [];
  const fields = Object.fromEntries(FIELD_KEYS.map((k) => [k, null]));
  if (!extracted.hasText) {
    notes.push('В PDF нет текстового слоя (похоже на скан) — распознать нечего. Заполните поля вручную, исходный файл сохранится вместе с карточкой.');
    return { fields, items: [], itemsDeclared: null, recognized: {}, hasText: false, notes };
  }
  const all = pages.flatMap((p) => p.lines);

  for (const l of all) {
    const m = TITLE_RE.exec(l.text);
    if (!m) continue;
    fields.number = m[2].replace(/[.,;:]+$/, '');
    if (m[3]) fields.invoice_date = parseDate(m[3]);
    break;
  }
  const supplier = findParty(all, SUPPLIER_LABEL);
  const buyer = findParty(all, BUYER_LABEL);
  Object.assign(fields, {
    supplier_name: supplier.name, supplier_inn: supplier.inn, supplier_kpp: supplier.kpp,
    buyer_name: buyer.name, buyer_inn: buyer.inn, buyer_kpp: buyer.kpp
  });
  fields.currency = findCurrency(all);

  const table = parseTable(pages);
  if (!table.found) notes.push('Таблица позиций не найдена — добавьте позиции вручную.');
  else if (!table.items.length) notes.push('Таблица найдена, но позиции в ней не распознаны — добавьте их вручную.');

  const totals = parseTotals(pages, table.found ? table.tableEnd : null);
  fields.total_amount = totals.total_amount;
  fields.vat_amount = totals.vat_amount;
  fields.amount_due = totals.amount_due;
  fields.vat_note = totals.vat_note;

  const recognized = {};
  FIELD_KEYS.forEach((k) => { if (fields[k] !== null) recognized[k] = true; });
  const missing = [['number', 'номер'], ['invoice_date', 'дату'], ['supplier_name', 'поставщика']]
    .filter(([k]) => fields[k] === null).map(([, ru]) => ru);
  if (missing.length) notes.push(`Не удалось распознать: ${missing.join(', ')} — заполните вручную.`);

  return { fields, items: table.items, itemsDeclared: totals.itemsDeclared, recognized, hasText: true, notes };
}

module.exports = { parseInvoice, parseDate, classifyHeader, lastNumber, FIELD_KEYS };
