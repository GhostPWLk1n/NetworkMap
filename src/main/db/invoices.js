// invoices.js — реестр счетов поставщиков (задача #8).
//
// Работает в процессе, который владеет базой: локальное приложение, хост или выделенный
// сервер. Каналы — в src/shared/dbChannels.js. PDF разбирает приложение у оператора
// (src/main/invoicePdf.js + src/shared/invoiceParser.js), сюда приходят уже проверенные
// оператором данные и сам файл. Поэтому всё, что пришло, проверяется заново: клиент
// может быть старой версии или просто ошибаться.
//
// Сохранение счёта не создаёт приход на склад и не меняет остатки.

const crypto = require('crypto');
const M = require('../../shared/invoiceMath');

// Тот же предел, что при разборе (invoicePdf.js). Объявлен здесь, а не взят оттуда, —
// чтобы модуль базы не зависел от модуля PDF (на сервере библиотеки PDF нет).
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ITEMS = 2000;

const HEADER_TEXT = {
  number: ['номер счёта', 64],
  supplier_name: ['поставщик', 500],
  buyer_name: ['покупатель', 500],
  currency: ['валюта', 16],
  vat_note: ['отметка об НДС', 200],
  notes: ['примечание', 4000]
};
const AMOUNTS = { total_amount: 'итог', vat_amount: 'сумма НДС', amount_due: 'сумма к оплате' };

class InvoiceInputError extends Error {}
const fail = (msg) => { throw new InvoiceInputError(msg); };

function text(value, label, max) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' && typeof value !== 'number') fail(`Поле «${label}» заполнено некорректно.`);
  const s = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!s) return null;
  if (s.length > max) fail(`Поле «${label}» слишком длинное (больше ${max} символов).`);
  return s;
}

function amount(value, label) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const v = M.parseDecimal(value);
  if (v === null) fail(`«${label}»: «${String(value).slice(0, 40)}» — не число.`);
  return v;
}

function isoDate(value) {
  const s = text(value, 'дата счёта', 10);
  if (!s) fail('Укажите дату счёта.');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!d || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    fail(`Дата счёта «${s}» некорректна.`);
  }
  if (+m[1] < 1990 || +m[1] > 2100) fail(`Дата счёта «${s}» вне разумного диапазона.`);
  return s;
}

function inn(value, who) {
  const s = text(value, `ИНН ${who}`, 20);
  if (!s) return null;
  const digits = s.replace(/\s/g, '');
  // Контрольную сумму не требуем: это предупреждение в форме, решает оператор
  if (!/^(\d{10}|\d{12})$/.test(digits)) fail(`ИНН ${who} должен состоять из 10 или 12 цифр.`);
  return digits;
}

function kpp(value, who) {
  const s = text(value, `КПП ${who}`, 20);
  if (!s) return null;
  const v = s.replace(/\s/g, '').toUpperCase();
  if (!M.kppValid(v)) fail(`КПП ${who} должен состоять из 9 символов (например, 770101001).`);
  return v;
}

/** Шапка и позиции счёта из формы → значения для базы, либо понятная ошибка. */
function normalizeInvoice(invoice, items) {
  if (!invoice || typeof invoice !== 'object') fail('Нет данных счёта.');
  const out = {};
  Object.entries(HEADER_TEXT).forEach(([k, [label, max]]) => { out[k] = text(invoice[k], label, max); });
  if (!out.number) fail('Укажите номер счёта.');
  if (!out.supplier_name) fail('Укажите поставщика.');
  if (out.currency) out.currency = out.currency.toUpperCase();
  out.invoice_date = isoDate(invoice.invoice_date);
  out.supplier_inn = inn(invoice.supplier_inn, 'поставщика');
  out.supplier_kpp = kpp(invoice.supplier_kpp, 'поставщика');
  out.buyer_inn = inn(invoice.buyer_inn, 'покупателя');
  out.buyer_kpp = kpp(invoice.buyer_kpp, 'покупателя');
  Object.entries(AMOUNTS).forEach(([k, label]) => { out[k] = amount(invoice[k], label); });

  if (items !== undefined && !Array.isArray(items)) fail('Позиции счёта переданы некорректно.');
  const list = items || [];
  if (list.length > MAX_ITEMS) fail(`Слишком много позиций (больше ${MAX_ITEMS}).`);
  const normItems = list.map((it, idx) => {
    const n = idx + 1;
    if (!it || typeof it !== 'object') fail(`Позиция ${n} заполнена некорректно.`);
    const name = text(it.name, `наименование, строка ${n}`, 2000);
    if (!name) fail(`Строка ${n}: укажите наименование или удалите строку.`);
    return {
      position: n,
      name,
      code: text(it.code, `код, строка ${n}`, 100),
      unit: text(it.unit, `ед. изм., строка ${n}`, 30),
      quantity: amount(it.quantity, `количество, строка ${n}`),
      price: amount(it.price, `цена, строка ${n}`),
      amount: amount(it.amount, `сумма, строка ${n}`),
      vat_rate: text(it.vat_rate, `ставка НДС, строка ${n}`, 30),
      vat_amount: amount(it.vat_amount, `НДС, строка ${n}`)
    };
  });
  return { header: out, items: normItems };
}

/** Небольшая сводка о распознавании — для истории, не для логики. */
function normalizeRecognition(r) {
  if (!r || typeof r !== 'object') return null;
  const keys = (a) => (Array.isArray(a) ? a.filter((k) => typeof k === 'string' && /^[a-z_]{1,32}$/.test(k)).slice(0, 40) : []);
  return JSON.stringify({
    has_text: !!r.has_text,
    recognized_fields: keys(r.recognized_fields),
    edited_fields: keys(r.edited_fields),
    items_recognized: Number.isInteger(r.items_recognized) && r.items_recognized >= 0 ? r.items_recognized : 0
  });
}

function decodeFile(file) {
  if (!file || typeof file !== 'object') fail('Не передан файл счёта.');
  if (typeof file.content_base64 !== 'string' || !file.content_base64) fail('Не передан файл счёта.');
  const b64 = file.content_base64.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) fail('Файл счёта передан повреждённым.');
  if (b64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) fail('Файл больше 5 МБ — такой счёт не сохранить.');
  const content = Buffer.from(b64, 'base64');
  if (!content.length) fail('Файл счёта пустой.');
  if (content.length > MAX_FILE_BYTES) fail('Файл больше 5 МБ — такой счёт не сохранить.');
  if (!content.subarray(0, 1024).includes(Buffer.from('%PDF-'))) fail('Это не PDF-файл.');
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  // Если клиент прислал свою контрольную сумму — она должна совпасть: иначе файл
  // испортился по дороге, и сохранять его нельзя
  if (file.sha256 && file.sha256 !== sha256) fail('Файл повредился при передаче — загрузите его ещё раз.');
  const rawName = typeof file.file_name === 'string' ? file.file_name : '';
  const baseName = rawName.split(/[\\/]/).pop().replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 255);
  const pageCount = Number.isInteger(file.page_count) && file.page_count > 0 && file.page_count <= 10000 ? file.page_count : null;
  return { content, sha256, file_name: baseName || 'счёт.pdf', size_bytes: content.length, page_count: pageCount };
}

/** «Счёт № 123 от 12.11.2026 (ООО «Ромашка»)» — для журнала и сообщений. */
function title(inv) {
  const [y, m, d] = String(inv.invoice_date || '').split('-');
  const date = d ? `${d}.${m}.${y}` : inv.invoice_date;
  return `Счёт № ${inv.number} от ${date} (${inv.supplier_name})`;
}

// Сравнение реквизитов — в JS, а не в SQL: lower() в SQLite понимает только латиницу
const normKey = (s) => String(s || '').toLocaleLowerCase('ru').replace(/[«»"'`]/g, '').replace(/\s+/g, ' ').trim();
const normNumber = (s) => normKey(s).replace(/^№\s*/, '').replace(/\s/g, '');

function createInvoicesRepo({ getDb, auditLogRepo }) {
  const SUMMARY_SQL = `
    SELECT i.id, i.number, i.invoice_date, i.supplier_name, i.supplier_inn, i.buyer_name,
           i.currency, i.total_amount, i.vat_amount, i.amount_due, i.revision, i.created_at, i.updated_at,
           f.file_name, f.size_bytes, f.page_count,
           (SELECT COUNT(*) FROM invoice_items it WHERE it.invoice_id = i.id) AS items_count
    FROM invoices i JOIN document_files f ON f.id = i.file_id`;

  function summary(id) {
    return getDb().prepare(`${SUMMARY_SQL} WHERE i.id = ?`).get(id) || null;
  }

  function get(id) {
    const db = getDb();
    const inv = db.prepare(`
      SELECT i.*, f.file_name, f.size_bytes, f.page_count, f.sha256, f.mime_type
      FROM invoices i JOIN document_files f ON f.id = i.file_id WHERE i.id = ?`).get(id);
    if (!inv) return null;
    inv.items = db.prepare(`
      SELECT position, name, code, unit, quantity, price, amount, vat_rate, vat_amount
      FROM invoice_items WHERE invoice_id = ? ORDER BY position`).all(id);
    try { inv.recognition = inv.recognition ? JSON.parse(inv.recognition) : null; } catch { inv.recognition = null; }
    return inv;
  }

  /** Тот же файл (по SHA-256) и счета с теми же поставщиком, номером и датой. */
  function findDuplicates({ sha256 = null, supplier_inn = null, supplier_name = null, number = null, invoice_date = null, excludeId = null } = {}) {
    const db = getDb();
    let sameFile = null;
    if (typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256)) {
      const row = db.prepare('SELECT i.id FROM invoices i JOIN document_files f ON f.id = i.file_id WHERE f.sha256 = ?').get(sha256);
      if (row && row.id !== excludeId) sameFile = summary(row.id);
    }
    let sameRequisites = [];
    if (number && invoice_date && (supplier_inn || supplier_name)) {
      const innDigits = supplier_inn ? String(supplier_inn).replace(/\s/g, '') : null;
      sameRequisites = db.prepare('SELECT id, number, supplier_inn, supplier_name FROM invoices WHERE invoice_date = ?')
        .all(String(invoice_date))
        .filter((r) => r.id !== excludeId && normNumber(r.number) === normNumber(number))
        .filter((r) => (innDigits && r.supplier_inn
          ? r.supplier_inn === innDigits
          : normKey(r.supplier_name) === normKey(supplier_name)))
        .map((r) => summary(r.id));
      if (sameFile) sameRequisites = sameRequisites.filter((r) => r.id !== sameFile.id);
    }
    return { sameFile, sameRequisites };
  }

  function insertItems(invoiceId, items) {
    const stmt = getDb().prepare(`
      INSERT INTO invoice_items (invoice_id, position, name, code, unit, quantity, price, amount, vat_rate, vat_amount)
      VALUES (@invoice_id, @position, @name, @code, @unit, @quantity, @price, @amount, @vat_rate, @vat_amount)`);
    items.forEach((it) => stmt.run({ ...it, invoice_id: invoiceId }));
  }

  /**
   * Сохраняет новый счёт вместе с оригиналом — одной транзакцией: либо всё, либо ничего.
   * Ожидаемые конфликты — не исключения, а результат, чтобы интерфейс предложил выбор:
   *   { status: 'created', invoice }
   *   { status: 'duplicate_file', invoice }            — этот PDF уже сохранён
   *   { status: 'duplicate_requisites', invoices }     — тот же поставщик, номер и дата,
   *                                                       но другой файл; сохранить можно
   *                                                       повторным вызовом с confirmSameRequisites
   */
  function create({ invoice, items, file, recognition = null, confirmSameRequisites = false } = {}) {
    const { header, items: normItems } = normalizeInvoice(invoice, items);
    const f = decodeFile(file);
    const db = getDb();
    const tx = db.transaction(() => {
      const dup = findDuplicates({ ...header, sha256: f.sha256 });
      if (dup.sameFile) return { status: 'duplicate_file', invoice: dup.sameFile };
      if (dup.sameRequisites.length && !confirmSameRequisites) {
        return { status: 'duplicate_requisites', invoices: dup.sameRequisites };
      }
      const fileId = db.prepare(`
        INSERT INTO document_files (sha256, file_name, mime_type, size_bytes, page_count, content)
        VALUES (?, ?, 'application/pdf', ?, ?, ?)`).run(f.sha256, f.file_name, f.size_bytes, f.page_count, f.content).lastInsertRowid;
      const id = db.prepare(`
        INSERT INTO invoices (file_id, number, invoice_date, supplier_name, supplier_inn, supplier_kpp,
                              buyer_name, buyer_inn, buyer_kpp, currency, total_amount, vat_amount, amount_due,
                              vat_note, notes, recognition)
        VALUES (@file_id, @number, @invoice_date, @supplier_name, @supplier_inn, @supplier_kpp,
                @buyer_name, @buyer_inn, @buyer_kpp, @currency, @total_amount, @vat_amount, @amount_due,
                @vat_note, @notes, @recognition)`).run({ ...header, file_id: fileId, recognition: normalizeRecognition(recognition) }).lastInsertRowid;
      insertItems(id, normItems);
      auditLogRepo.log('invoice', id, 'create', `${title(header)} добавлен в реестр счетов`);
      return { status: 'created', invoice: get(id) };
    });
    try {
      // immediate — блокировка записи берётся сразу, до проверки дублей: проверка и
      // вставка не разойдутся, даже если базу пишет ещё кто-то
      return tx.immediate();
    } catch (err) {
      // Одновременная загрузка того же файла: второй запрос упрётся в UNIQUE(sha256)
      if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE' && /document_files\.sha256/.test(err.message)) {
        const dup = findDuplicates({ sha256: f.sha256 });
        if (dup.sameFile) return { status: 'duplicate_file', invoice: dup.sameFile };
      }
      throw err;
    }
  }

  /**
   * Правка карточки: шапка и позиции целиком. revision — версия, которую видел оператор;
   * если счёт успели изменить, правка не записывается ({ status: 'conflict' }).
   */
  function update(id, { invoice, items, revision, confirmSameRequisites = false } = {}) {
    const { header, items: normItems } = normalizeInvoice(invoice, items);
    const db = getDb();
    const tx = db.transaction(() => {
      const current = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
      if (!current) fail('Счёт не найден — возможно, его уже удалили.');
      if (Number.isInteger(revision) && revision !== current.revision) {
        return { status: 'conflict', invoice: get(id) };
      }
      // Спрашиваем, только если реквизиты меняются: счёт, который оператор уже
      // сознательно сохранил «отдельно», не должен вызывать вопрос при каждой правке
      const requisitesChanged = normNumber(current.number) !== normNumber(header.number) ||
        current.invoice_date !== header.invoice_date ||
        (current.supplier_inn || null) !== header.supplier_inn ||
        normKey(current.supplier_name) !== normKey(header.supplier_name);
      const dup = requisitesChanged ? findDuplicates({ ...header, excludeId: id }) : { sameRequisites: [] };
      if (dup.sameRequisites.length && !confirmSameRequisites) {
        return { status: 'duplicate_requisites', invoices: dup.sameRequisites };
      }
      db.prepare(`
        UPDATE invoices SET number = @number, invoice_date = @invoice_date, supplier_name = @supplier_name,
          supplier_inn = @supplier_inn, supplier_kpp = @supplier_kpp, buyer_name = @buyer_name,
          buyer_inn = @buyer_inn, buyer_kpp = @buyer_kpp, currency = @currency, total_amount = @total_amount,
          vat_amount = @vat_amount, amount_due = @amount_due, vat_note = @vat_note, notes = @notes,
          revision = revision + 1, updated_at = datetime('now')
        WHERE id = @id`).run({ ...header, id });
      db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(id);
      insertItems(id, normItems);
      auditLogRepo.log('invoice', id, 'update', `${title(header)}: карточка изменена`);
      return { status: 'updated', invoice: get(id) };
    });
    return tx.immediate();
  }

  /** Удаляет счёт, его позиции и оригинал. */
  function remove(id) {
    const db = getDb();
    const tx = db.transaction(() => {
      const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
      if (!inv) return { id, removed: false };
      db.prepare('DELETE FROM invoices WHERE id = ?').run(id); // позиции — каскадом
      db.prepare('DELETE FROM document_files WHERE id = ?').run(inv.file_id);
      auditLogRepo.log('invoice', id, 'delete', `${title(inv)} удалён из реестра вместе с оригиналом`);
      return { id, removed: true };
    });
    return tx.immediate();
  }

  return {
    list() {
      return getDb().prepare(`${SUMMARY_SQL} ORDER BY i.invoice_date DESC, i.id DESC`).all();
    },
    get,
    /** Оригинал PDF: { file_name, mime_type, sha256, size_bytes, content_base64 } */
    getFile(id) {
      const row = getDb().prepare(`
        SELECT f.file_name, f.mime_type, f.sha256, f.size_bytes, f.content
        FROM invoices i JOIN document_files f ON f.id = i.file_id WHERE i.id = ?`).get(id);
      if (!row) fail('Счёт не найден — возможно, его уже удалили.');
      const { content, ...meta } = row;
      return { ...meta, content_base64: Buffer.from(content).toString('base64') };
    },
    findDuplicates,
    create,
    update,
    remove
  };
}

module.exports = { createInvoicesRepo, normalizeInvoice, InvoiceInputError, MAX_FILE_BYTES };
