#!/usr/bin/env node
// Реестр счетов (задача #8) на уровне каналов dbChannels — тех же функций, что вызывают
// Electron (ipcMain) и выделенный сервер (RPC). База — временная, документы — вымышленные
// (tests/fixtures/invoices).
//
// better-sqlite3 собран под Electron, поэтому тест выполняется Electron в режиме Node.
// Запуск:  npm run test:invoices (вместе с разбором PDF) или node tests/invoices-db.test.js — сам
// перезапустится под Electron.
if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const r = spawnSync(require('electron'), [__filename], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  process.exit(r.status === null ? 1 : r.status);
}
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REPO = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'invoices');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-invoices-'));
const dataDir = path.join(tmp, 'userdata');
fs.mkdirSync(dataDir);

let fails = 0;
let checks = 0;
function check(name, cond, extra = '') {
  checks++;
  if (!cond) fails++;
  console.log(`${cond ? '  OK  ' : '  FAIL'} ${name}${extra !== '' ? ` — ${extra}` : ''}`);
}
async function rejects(name, promiseFn, re) {
  try {
    await promiseFn();
    check(name, false, 'ошибки нет');
  } catch (e) {
    check(name, re.test(e.message), e.message);
  }
}

const pdf = (name) => fs.readFileSync(path.join(FIX, name));
const fileOf = (name, extra = {}) => {
  const buf = pdf(name);
  return { file_name: name, content_base64: buf.toString('base64'),
    sha256: crypto.createHash('sha256').update(buf).digest('hex'), page_count: 3, ...extra };
};
const HEADER = {
  number: '1287', invoice_date: '2026-11-12', supplier_name: 'ООО «Вымышленная Техника»',
  supplier_inn: '7707083893', supplier_kpp: '770701001', buyer_name: 'ООО «Тестовый Заказчик»',
  currency: 'RUB', total_amount: '1 234,50', vat_amount: '205.75', amount_due: '1234.5'
};
const ITEMS = [
  { name: 'Ноутбук учебный 15"', code: 'NB-15', unit: 'шт', quantity: '1', price: '1000', amount: '1000' },
  { name: 'Мышь беспроводная', unit: 'шт', quantity: '3', price: '78,166667', amount: '234,50', vat_rate: '20%' }
];

(async () => {
  const dbm = require(path.join(REPO, 'src/main/db'));
  dbm.setUserDataPath(dataDir);
  const dbFile = path.join(tmp, 'test.db');
  dbm.initDatabase(dbFile);
  const { DB_CHANNELS } = require(path.join(REPO, 'src/shared/dbChannels'));
  const call = async (ch, payload) => DB_CHANNELS[ch].fn(payload);
  const db = dbm.getDb();

  console.log('=== Новая база');
  check('версия схемы 21', db.pragma('user_version', { simple: true }) === 21);
  ['document_files', 'invoices', 'invoice_items'].forEach((t) =>
    check(`таблица ${t}`, !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)));
  check('каналы: чтение без записи, создание/правка/удаление — запись',
    !DB_CHANNELS['invoices:list'].write && !DB_CHANNELS['invoices:getFile'].write &&
    DB_CHANNELS['invoices:create'].write && DB_CHANNELS['invoices:update'].write && DB_CHANNELS['invoices:remove'].write);
  check('оригинал и проверка дублей не кэшируются на клиенте',
    DB_CHANNELS['invoices:getFile'].noCache && DB_CHANNELS['invoices:findDuplicates'].noCache);

  // Склад для проверки «остатки не меняются»
  dbm.warehouseRepo.add({ category: 'component', item_type: 'ram', description: 'Модуль памяти 8 ГБ (тест)' });
  const stock = () => JSON.stringify(db.prepare('SELECT * FROM warehouse_items ORDER BY id').all());
  const stockBefore = stock();

  console.log('\n=== Создание');
  const r1 = await call('invoices:create', { invoice: HEADER, items: ITEMS, file: fileOf('invoice-3pages.pdf'),
    recognition: { has_text: true, recognized_fields: ['number', 'invoice_date'], edited_fields: ['total_amount'], items_recognized: 2, junk: 'x' } });
  check('счёт создан', r1.status === 'created', r1.status);
  const inv = r1.invoice;
  check('суммы приведены к каноническому виду', inv.total_amount === '1234.50' && inv.amount_due === '1234.5' && inv.vat_amount === '205.75');
  check('позиции по порядку, как введены', inv.items.length === 2 && inv.items[0].position === 1 &&
    inv.items[1].name === 'Мышь беспроводная' && inv.items[1].price === '78.166667' && inv.items[1].amount === '234.50');
  check('пустые поля — NULL, а не пустые строки', inv.items[1].code === null && inv.buyer_inn === null);
  check('сведения о распознавании сохранены без лишнего', inv.recognition && inv.recognition.items_recognized === 2 && !('junk' in inv.recognition));
  check('метаданные файла', inv.file_name === 'invoice-3pages.pdf' && inv.size_bytes === pdf('invoice-3pages.pdf').length && inv.page_count === 3);
  check('ревизия 1', inv.revision === 1);
  const list = await call('invoices:list');
  check('в реестре одна запись со сводкой', list.length === 1 && list[0].items_count === 2 && list[0].file_name === 'invoice-3pages.pdf' && !('content' in list[0]));
  const audit = db.prepare("SELECT * FROM audit_log WHERE entity_type = 'invoice'").all();
  check('запись в журнале изменений', audit.length === 1 && /Счёт № 1287 от 12\.11\.2026/.test(audit[0].summary), audit[0] && audit[0].summary);

  const file = await call('invoices:getFile', inv.id);
  check('оригинал отдаётся байт в байт', Buffer.from(file.content_base64, 'base64').equals(pdf('invoice-3pages.pdf')) &&
    file.sha256 === crypto.createHash('sha256').update(pdf('invoice-3pages.pdf')).digest('hex'));

  console.log('\n=== Дубли');
  const same = await call('invoices:create', { invoice: { ...HEADER, number: 'другой' }, items: [], file: fileOf('invoice-3pages.pdf') });
  check('тот же PDF второй раз не сохраняется', same.status === 'duplicate_file' && same.invoice.id === inv.id, same.status);
  check('…даже с подтверждением «сохранить отдельно»',
    (await call('invoices:create', { invoice: HEADER, items: [], file: fileOf('invoice-3pages.pdf'), confirmSameRequisites: true })).status === 'duplicate_file');
  const dupHeader = { ...HEADER, number: ' № 1287 ', supplier_name: 'ооо "вымышленная техника"' };
  const req = await call('invoices:create', { invoice: dupHeader, items: ITEMS, file: fileOf('invoice-long-table.pdf') });
  check('тот же поставщик+номер+дата с другим файлом — показан найденный счёт', req.status === 'duplicate_requisites' &&
    req.invoices.length === 1 && req.invoices[0].id === inv.id, req.status);
  const noInn = await call('invoices:findDuplicates', { supplier_name: 'ООО «ВЫМЫШЛЕННАЯ ТЕХНИКА»', number: '1287', invoice_date: '2026-11-12' });
  check('без ИНН сравнивается название (без учёта регистра кириллицы и кавычек)', noInn.sameRequisites.length === 1);
  const otherInn = await call('invoices:findDuplicates', { supplier_inn: '500100732259', supplier_name: HEADER.supplier_name, number: '1287', invoice_date: '2026-11-12' });
  check('другой ИНН — не дубль, даже при том же названии', otherInn.sameRequisites.length === 0);
  check('проверка по SHA-256 до загрузки', (await call('invoices:findDuplicates', { sha256: file.sha256 })).sameFile.id === inv.id);
  check('ничего не записано до выбора оператора', (await call('invoices:list')).length === 1);
  const sep = await call('invoices:create', { invoice: dupHeader, items: ITEMS, file: fileOf('invoice-long-table.pdf'), confirmSameRequisites: true });
  check('оператор выбрал «сохранить отдельно» — сохранено', sep.status === 'created' && sep.invoice.id !== inv.id, sep.status);

  // Повтор запроса после обрыва связи (RPC-клиент повторяет запрос сам) — тоже дубль, не вторая запись
  const retry = await call('invoices:create', { invoice: dupHeader, items: ITEMS, file: fileOf('invoice-long-table.pdf'), confirmSameRequisites: true });
  check('повтор того же запроса не создаёт вторую запись', retry.status === 'duplicate_file');

  console.log('\n=== Проверка входных данных');
  const base = { invoice: { ...HEADER, number: 'X-1' }, items: [], file: fileOf('invoice-vat-columns.pdf') };
  await rejects('без номера', () => call('invoices:create', { ...base, invoice: { ...base.invoice, number: '  ' } }), /номер счёта/);
  await rejects('без поставщика', () => call('invoices:create', { ...base, invoice: { ...base.invoice, supplier_name: '' } }), /поставщика/);
  await rejects('несуществующая дата', () => call('invoices:create', { ...base, invoice: { ...base.invoice, invoice_date: '2026-02-30' } }), /некорректна/);
  await rejects('сумма не число', () => call('invoices:create', { ...base, invoice: { ...base.invoice, total_amount: '12 мес' } }), /итог.*не число/);
  await rejects('ИНН не из 10/12 цифр', () => call('invoices:create', { ...base, invoice: { ...base.invoice, supplier_inn: '12345' } }), /10 или 12 цифр/);
  await rejects('КПП неверной длины', () => call('invoices:create', { ...base, invoice: { ...base.invoice, buyer_kpp: '12' } }), /9 символов/);
  await rejects('строка без наименования', () => call('invoices:create', { ...base, items: [{ quantity: '1' }] }), /Строка 1: укажите наименование/);
  await rejects('количество не число', () => call('invoices:create', { ...base, items: [{ name: 'a', quantity: 'много' }] }), /количество, строка 1/);
  await rejects('не PDF', () => call('invoices:create', { ...base, file: { file_name: 'a.pdf', content_base64: Buffer.from('PK\u0003\u0004zip').toString('base64') } }), /не PDF/);
  await rejects('нет файла', () => call('invoices:create', { ...base, file: null }), /Не передан файл/);
  await rejects('битый base64', () => call('invoices:create', { ...base, file: { file_name: 'a.pdf', content_base64: '%%%' } }), /повреждённым/);
  await rejects('контрольная сумма не сошлась', () => call('invoices:create', { ...base, file: fileOf('invoice-vat-columns.pdf', { sha256: 'a'.repeat(64) }) }), /повредился/);
  await rejects('файл больше 5 МБ', () => call('invoices:create', { ...base, file: { file_name: 'big.pdf',
    content_base64: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5 * 1024 * 1024)]).toString('base64') } }), /5 МБ/);
  const traversal = await call('invoices:create', { ...base, file: fileOf('invoice-vat-columns.pdf', { file_name: '..\\..\\Windows\\счёт.pdf' }) });
  check('имя файла — только имя, без пути', traversal.status === 'created' && traversal.invoice.file_name === 'счёт.pdf', traversal.invoice && traversal.invoice.file_name);
  check('после отказов не осталось частичных записей',
    db.prepare('SELECT COUNT(*) c FROM invoices').get().c === 3 && db.prepare('SELECT COUNT(*) c FROM document_files').get().c === 3);

  console.log('\n=== Ошибка посреди записи — ни карточки, ни файла');
  const counts = () => ['invoices', 'invoice_items', 'document_files'].map((t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c).join('/');
  const before = counts();
  const origLog = dbm.auditLogRepo.log;
  dbm.auditLogRepo.log = () => { throw new Error('сбой диска (имитация)'); };
  await rejects('сбой после вставки позиций пробрасывается', () => call('invoices:create',
    { invoice: { ...HEADER, number: 'ROLLBACK-1' }, items: ITEMS, file: fileOf('invoice-mismatch.pdf') }), /имитация/);
  dbm.auditLogRepo.log = origLog;
  check('транзакция откатилась целиком', counts() === before, `${before} → ${counts()}`);
  const after = await call('invoices:create', { invoice: { ...HEADER, number: 'ROLLBACK-1' }, items: ITEMS, file: fileOf('invoice-mismatch.pdf') });
  check('тот же файл после сбоя сохраняется нормально (не «уже загружен»)', after.status === 'created', after.status);

  console.log('\n=== Правка');
  const edited = await call('invoices:update', { id: inv.id, revision: 1,
    invoice: { ...HEADER, total_amount: '1234.50', notes: 'Сверено с бумажным' },
    items: [...ITEMS, { name: 'Доставка', quantity: '1', price: '0', amount: '0' }] });
  check('правка сохранена, ревизия выросла', edited.status === 'updated' && edited.invoice.revision === 2 && edited.invoice.items.length === 3 &&
    edited.invoice.notes === 'Сверено с бумажным', edited.status);
  const reopened = await call('invoices:get', inv.id);
  check('повторное открытие показывает исправленное', reopened.items[2].name === 'Доставка' && reopened.notes === 'Сверено с бумажным');
  const stale = await call('invoices:update', { id: inv.id, revision: 1, invoice: HEADER, items: [] });
  check('правка по устаревшей версии не затирает чужую', stale.status === 'conflict' && (await call('invoices:get', inv.id)).items.length === 3, stale.status);
  const clash = await call('invoices:update', { id: traversal.invoice.id, revision: 1, invoice: { ...HEADER }, items: [] });
  check('правка реквизитов в чужие — сначала вопрос', clash.status === 'duplicate_requisites', clash.status);
  await rejects('правка с ошибкой не применяется', () => call('invoices:update', { id: inv.id, revision: 2, invoice: { ...HEADER, invoice_date: 'вчера' }, items: [] }), /некорректна/);
  check('…и позиции не потеряны', (await call('invoices:get', inv.id)).items.length === 3);
  await rejects('правка несуществующего', () => call('invoices:update', { id: 99999, invoice: HEADER, items: [] }), /не найден/);

  check('склад не изменился', stock() === stockBefore);
  check('приход на склад не создан', db.prepare('SELECT COUNT(*) c FROM warehouse_items').get().c === 1);

  console.log('\n=== Резервная копия и восстановление');
  const backupFile = path.join(tmp, 'backup.db');
  await db.backup(backupFile); // как делает выделенный сервер (server/index.js)
  const removed = await call('invoices:remove', inv.id);
  check('удаление убирает карточку, позиции и оригинал', removed.removed &&
    !db.prepare('SELECT 1 FROM invoice_items WHERE invoice_id = ?').get(inv.id) &&
    db.prepare('SELECT COUNT(*) c FROM document_files').get().c === db.prepare('SELECT COUNT(*) c FROM invoices').get().c);
  await rejects('оригинал удалённого счёта недоступен', () => call('invoices:getFile', inv.id), /не найден/);
  dbm.releaseDbLock && dbm.releaseDbLock();
  db.close();
  const restored = path.join(tmp, 'restored.db');
  fs.copyFileSync(backupFile, restored);
  dbm.initDatabase(restored);
  const back = await call('invoices:get', inv.id);
  check('после восстановления счёт на месте с правками', back && back.items.length === 3 && back.notes === 'Сверено с бумажным');
  const backFile = await call('invoices:getFile', inv.id);
  check('…и оригинал байт в байт', Buffer.from(backFile.content_base64, 'base64').equals(pdf('invoice-3pages.pdf')));
  dbm.releaseDbLock && dbm.releaseDbLock();
  dbm.getDb().close();

  console.log('\n=== Миграция существующей базы v20 → v21');
  const oldFile = path.join(tmp, 'v20.db');
  dbm.initDatabase(oldFile);
  let d = dbm.getDb();
  dbm.usersRepo.create({ full_name: 'Тестов Тест Тестович', department: 'ИТ' });
  dbm.devicesRepo.create({ hostname: 'PC-TEST-01', device_type: 'computer' });
  // v21 только добавляет таблицы, поэтому v20 — это v21 без них
  d.exec('DROP TABLE invoice_items; DROP TABLE invoices; DROP TABLE document_files;');
  d.pragma('user_version = 20');
  dbm.releaseDbLock && dbm.releaseDbLock();
  d.close();
  dbm.initDatabase(oldFile);
  d = dbm.getDb();
  check('версия поднялась до 21', d.pragma('user_version', { simple: true }) === 21);
  check('прежние данные на месте', dbm.usersRepo.list().length === 1 && dbm.devicesRepo.list().some((x) => x.hostname === 'PC-TEST-01'));
  const mig = await call('invoices:create', { invoice: HEADER, items: ITEMS, file: fileOf('invoice-3pages.pdf') });
  check('в обновлённой базе счета работают', mig.status === 'created');
  check('целостность базы', d.pragma('integrity_check', { simple: true }) === 'ok' && d.pragma('foreign_key_check').length === 0);
  // Структура таблиц после миграции должна совпадать с новой базой
  const cols = (t) => dbm.getDb().prepare(`PRAGMA table_info(${t})`).all().map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value}`).join(',');
  const TABLES = ['document_files', 'invoices', 'invoice_items'];
  const migratedCols = TABLES.map(cols);
  dbm.releaseDbLock && dbm.releaseDbLock();
  d.close();
  dbm.initDatabase(path.join(tmp, 'fresh.db'));
  const freshCols = TABLES.map(cols);
  check('структура таблиц после миграции совпадает с новой базой', JSON.stringify(freshCols) === JSON.stringify(migratedCols));
  dbm.releaseDbLock && dbm.releaseDbLock();
  dbm.getDb().close();

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${fails === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `ПРОВАЛОВ: ${fails}`} (${checks - fails}/${checks})`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(2); });
