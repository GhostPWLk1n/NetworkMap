#!/usr/bin/env node
// Битрикс24 (задача #10): поиск по имени с постраничной выдачей, номер ПК из поля
// «Другие сайты», привязка из карточки пользователя. Проверка на уровне каналов
// dbChannels (те же функции вызывают Electron и выделенный сервер) с фиктивным порталом
// на 127.0.0.1 и временной базой. Все данные вымышленные.
//
// Запуск:  npm run test:bitrix   (или node tests/bitrix.test.js — сам перезапустится под
// Electron: better-sqlite3 собран под него)
if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const r = spawnSync(require('electron'), [__filename], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  process.exit(r.status === null ? 1 : r.status);
}
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const REPO = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-bitrix-'));
const TOKEN = 'fake0token0for0tests';

let fails = 0;
let checks = 0;
function check(name, cond, extra = '') {
  checks++;
  if (!cond) fails++;
  console.log(`${cond ? '  OK  ' : '  FAIL'} ${name}${extra !== '' ? ` — ${extra}` : ''}`);
}
async function rejects(name, fn, re) {
  try { await fn(); check(name, false, 'ошибки нет'); } catch (e) { check(name, re.test(e.message), e.message); }
}

// --- Фиктивный портал: user.get по ID и по NAME_SEARCH, по 50 на страницу, как настоящий
const people = {};
const add = (id, last, first, extra = {}) => {
  people[id] = { ID: String(id), ACTIVE: true, LAST_NAME: last, NAME: first, SECOND_NAME: 'Тестович',
    WORK_POSITION: 'Инженер', WORK_DEPARTMENT: 'Отдел ИТ', EMAIL: `u${id}@example.test`, ...extra };
};
add(201, 'Примеров', 'Иван', { UF_WEB_SITES: 'ПК № 0042', WORK_DEPARTMENT: 'Отдел ИТ' });
add(202, 'Примеров', 'Иван', { WORK_POSITION: 'Бухгалтер', WORK_DEPARTMENT: 'Бухгалтерия', UF_WEB_SITES: 'ПК 12, кабинет 305' });
add(203, 'Образцова', 'Анна', { UF_WEB_SITES: 'https://intranet.example.test/profile' });
add(204, 'Образцова', 'Мария', { UF_WEB_SITES: '' });
add(205, 'Связанов', 'Пётр', { UF_WEB_SITES: ['ПК', '0107'] });
for (let i = 0; i < 60; i++) add(300 + i, 'Многов', `Имя${String(i).padStart(2, '0')}`);
const requests = [];
function nameMatches(p, q) {
  const words = q.toLowerCase().split(/\s+/);
  const hay = [p.LAST_NAME, p.NAME, p.SECOND_NAME].join(' ').toLowerCase();
  return words.every((w) => hay.split(' ').some((part) => part.startsWith(w)));
}
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    requests.push({ url: req.url, body: parsed });
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (!req.url.startsWith(`/rest/1/${TOKEN}/user.get`)) return send(401, { error: 'INVALID_CREDENTIALS' });
    const f = parsed.filter || {};
    const pick = (p) => {
      const out = {};
      Object.keys(p).forEach((k) => { if (!parsed.select || parsed.select.includes(k)) out[k] = p[k]; });
      return out;
    };
    if (f.ID) {
      const p = people[Number(f.ID)];
      return send(200, { result: p ? [pick(p)] : [], total: p ? 1 : 0 });
    }
    if (f.NAME_SEARCH === 'ошибка') return send(503, { error: 'QUERY_LIMIT_EXCEEDED' });
    const all = Object.values(people).filter((p) => nameMatches(p, f.NAME_SEARCH || ''));
    const start = Number(parsed.start || 0);
    const page = all.slice(start, start + 50);
    const out = { result: page.map(pick), total: all.length };
    if (start + 50 < all.length) out.next = start + 50;
    return send(200, out);
  });
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/rest/1/${TOKEN}/`;
  fs.writeFileSync(path.join(tmp, 'bitrix.yml'), `webhook_url: "${base}"\n`);

  const dbm = require(path.join(REPO, 'src/main/db'));
  dbm.setUserDataPath(tmp);
  const dbFile = path.join(tmp, 'test.db');
  dbm.initDatabase(dbFile);
  const { DB_CHANNELS } = require(path.join(REPO, 'src/shared/dbChannels'));
  const db = dbm.getDb();
  const out = [];
  const call = async (ch, payload) => { const r = await DB_CHANNELS[ch].fn(payload); out.push(JSON.stringify(r)); return r; };

  console.log('=== Схема');
  check('версия схемы 22', db.pragma('user_version', { simple: true }) === 22);
  check('столбец users.bitrix_pc_number', db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'bitrix_pc_number'));
  check('поиск — чтение без кэша на клиенте', DB_CHANNELS['bitrix:search'].write === false && DB_CHANNELS['bitrix:search'].noCache === true);

  console.log('\n=== Поиск по имени');
  let r = await call('bitrix:search', { query: 'Примеров Иван' });
  check('ФИО: найдены оба тёзки', r.items.length === 2 && r.items.every((i) => i.fullName === 'Примеров Иван Тестович'));
  check('тёзки различимы по ID, должности и подразделению', r.items.map((i) => `${i.bitrixId}:${i.position}:${i.department}`).join('|') === '201:Инженер:Отдел ИТ|202:Бухгалтер:Бухгалтерия',
    r.items.map((i) => `${i.bitrixId}:${i.position}:${i.department}`).join('|'));
  const last = requests[requests.length - 1].body;
  check('запрос — user.get с filter.NAME_SEARCH и только нужными полями', last.filter.NAME_SEARCH === 'Примеров Иван' &&
    !last.select.includes('EMAIL') && !last.select.includes('UF_WEB_SITES'), JSON.stringify(last));
  r = await call('bitrix:search', { query: 'Образц' });
  check('по началу фамилии', r.items.length === 2 && r.items.every((i) => i.fullName.startsWith('Образцова')));
  r = await call('bitrix:search', { query: '  примеров   иван ' });
  check('лишние пробелы и регистр', r.query === 'примеров иван' && r.items.length === 2);
  r = await call('bitrix:search', { query: 'Несуществующий' });
  check('пустой результат', r.items.length === 0 && r.next === null);
  const p1 = await call('bitrix:search', { query: 'Многов' });
  check('первая страница — 50 и ссылка на следующую', p1.items.length === 50 && p1.next === 50 && p1.total === 60);
  const p2 = await call('bitrix:search', { query: 'Многов', start: p1.next });
  check('вторая страница — остальные 10, дальше нет', p2.items.length === 10 && p2.next === null &&
    new Set([...p1.items, ...p2.items].map((i) => i.bitrixId)).size === 60);
  const before = requests.length;
  await rejects('пустой запрос отклонён', () => call('bitrix:search', { query: '   ' }), /Введите ID/);
  await rejects('одна буква отклонена', () => call('bitrix:search', { query: 'П' }), /хотя бы 2/);
  await rejects('цифры — это ID, не поиск по имени', () => call('bitrix:search', { query: '0201' }), /ID/);
  check('…и ни один из них не ушёл в Битрикс24 (весь справочник не загружается)', requests.length === before);
  await rejects('ошибка портала — понятный текст', () => call('bitrix:search', { query: 'ошибка' }), /ограничил число запросов/);
  check('ключ вебхука не попадает в ответы', !out.join('').includes(TOKEN) && !out.join('').includes(base));

  console.log('\n=== Номер ПК');
  let pv = await call('bitrix:preview', { bitrixId: 201, target: { mode: 'create' } });
  check('«ПК № 0042» → «0042» (ведущие нули сохранены)', pv.profile.pcNumber === '0042' &&
    pv.changes.find((c) => c.field === 'bitrix_pc_number').to === '0042');
  const created = await call('bitrix:apply', { bitrixId: 201, target: { mode: 'create' }, fingerprint: pv.fingerprint });
  check('номер сохранён в карточке', created.user.bitrix_pc_number === '0042' && created.user.bitrix_id === 201);
  // Тот же сотрудник, но в Битрикс24 теперь несколько чисел — догадки нет, номер не стирается
  const saved201 = people[201].UF_WEB_SITES;
  people[201].UF_WEB_SITES = 'ПК 0042, старый 0017';
  pv = await call('bitrix:preview', { bitrixId: 201 });
  const pcRow = pv.changes.find((c) => c.field === 'bitrix_pc_number');
  check('несколько разных чисел — номер не определён, сохранённый остаётся', pv.profile.pcNumber === null &&
    pv.warnings.includes('pc_number_ambiguous') && pcRow.action === 'keep' && pcRow.to === '0042');
  people[201].UF_WEB_SITES = '';
  pv = await call('bitrix:preview', { bitrixId: 201 });
  check('пустое поле не стирает номер', pv.changes.find((c) => c.field === 'bitrix_pc_number').action === 'keep');
  people[201].UF_WEB_SITES = saved201;
  pv = await call('bitrix:preview', { bitrixId: 203, target: { mode: 'create' } });
  check('нет цифр (ссылка) — номер не определён, ссылка не открывалась', pv.profile.pcNumber === null &&
    pv.warnings.includes('pc_number_no_digits') && !requests.some((q) => /intranet/.test(q.url)));
  pv = await call('bitrix:preview', { bitrixId: 202, target: { mode: 'create' } });
  check('«ПК 12, кабинет 305» — числа не склеены', pv.profile.pcNumber === null && pv.warnings.includes('pc_number_ambiguous'));
  pv = await call('bitrix:preview', { bitrixId: 205, target: { mode: 'create' } });
  check('поле-список («ПК», «0107») → «0107»', pv.profile.pcNumber === '0107');

  console.log('\n=== Привязка из карточки');
  const local = dbm.usersRepo.create({ full_name: 'Образцова Анна (местная)', department: 'ИТ', notes: 'заметка' });
  const other = dbm.usersRepo.create({ full_name: 'Другая Карточка' });
  dbm.devicesRepo.create({ device_type: 'computer', hostname: 'PC-0042', inventory_number: 'ИНВ-7', owner_user_id: local.id });
  const devBefore = JSON.stringify(dbm.devicesRepo.list().map((d) => [d.hostname, d.inventory_number, d.owner_user_id]));
  const strict = (userId) => ({ mode: 'link', userId, strict: true });
  people[203].UF_WEB_SITES = 'ПК № 0042';
  pv = await call('bitrix:preview', { bitrixId: 203, target: strict(local.id) });
  check('предпросмотр сразу для выбранной карточки', pv.target && pv.target.mode === 'link' && pv.target.userId === local.id && pv.canApply);
  const linked = await call('bitrix:apply', { bitrixId: 203, target: { ...pv.target, strict: true }, fingerprint: pv.fingerprint });
  check('подтверждение связывает профиль именно с этой карточкой', linked.user.id === local.id && linked.user.bitrix_id === 203 &&
    linked.user.bitrix_pc_number === '0042' && !linked.created);
  const after = db.prepare('SELECT * FROM users WHERE id = ?').get(local.id);
  check('заметки и локальные поля не тронуты', after.notes === 'заметка' && after.status === 'active');
  check('устройства, инвентарный номер и владелец не изменились',
    JSON.stringify(dbm.devicesRepo.list().map((d) => [d.hostname, d.inventory_number, d.owner_user_id])) === devBefore);
  check('новых карточек не появилось', dbm.usersRepo.list().length === 3);

  pv = await call('bitrix:preview', { bitrixId: 203, target: strict(other.id) });
  check('профиль уже связан с другой карточкой — отказ', !pv.canApply && pv.needsTarget && /уже связан с карточкой «Образцова Анна/.test(pv.blockReason), pv.blockReason);
  await rejects('…и запись тоже отказывает', () => call('bitrix:apply', { bitrixId: 203, target: strict(other.id), fingerprint: 'x' }), /уже связан/);
  pv = await call('bitrix:preview', { bitrixId: 203, target: { mode: 'create', strict: true } });
  check('из карточки новую запись не создать', !pv.canApply && pv.needsTarget);

  // Связь изменилась после предпросмотра: другой оператор привязал этого сотрудника к другой карточке
  pv = await call('bitrix:preview', { bitrixId: 204, target: strict(other.id) });
  // карточка, созданная из 201, теперь «держит» 204 — как будто связь поменяли с другого места
  db.prepare('UPDATE users SET bitrix_id = 204 WHERE id = ?').run(created.user.id);
  await rejects('связь поменялась после предпросмотра — запись отклонена',
    () => call('bitrix:apply', { bitrixId: 204, target: { ...pv.target, strict: true }, fingerprint: pv.fingerprint }), /уже связан|изменились/);
  check('…карточка назначения осталась без связи', db.prepare('SELECT bitrix_id FROM users WHERE id = ?').get(other.id).bitrix_id === null);
  db.prepare('UPDATE users SET bitrix_id = 201 WHERE id = ?').run(created.user.id);

  // Карточку назначения связали с кем-то, пока оператор смотрел предпросмотр
  pv = await call('bitrix:preview', { bitrixId: 205, target: strict(other.id) });
  db.prepare('UPDATE users SET bitrix_id = 202 WHERE id = ?').run(other.id);
  await rejects('карточку назначения успели связать — запись отклонена',
    () => call('bitrix:apply', { bitrixId: 205, target: { ...pv.target, strict: true }, fingerprint: pv.fingerprint }), /уже связана|изменились/);
  check('…профиль 205 ни к чему не привязан', !db.prepare('SELECT 1 FROM users WHERE bitrix_id = 205').get());

  console.log('\n=== Поиск видит связанные карточки');
  r = await call('bitrix:search', { query: 'Образцова' });
  const anna = r.items.find((i) => i.bitrixId === 203);
  check('найденный сотрудник помечен связанной карточкой', anna.linkedUser && anna.linkedUser.id === local.id);

  console.log('\n=== Миграция v21 → v22');
  dbm.releaseDbLock();
  db.close();
  const oldFile = path.join(tmp, 'v21.db');
  dbm.initDatabase(oldFile);
  let d = dbm.getDb();
  dbm.usersRepo.create({ full_name: 'Старая Карточка' });
  d.prepare("UPDATE users SET bitrix_id = 999, bitrix_synced_at = datetime('now')").run();
  d.exec('ALTER TABLE users DROP COLUMN bitrix_pc_number');
  d.pragma('user_version = 21');
  dbm.releaseDbLock();
  d.close();
  dbm.initDatabase(oldFile);
  d = dbm.getDb();
  check('версия поднялась до 22, столбец добавлен', d.pragma('user_version', { simple: true }) === 22 &&
    d.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'bitrix_pc_number'));
  const old = d.prepare('SELECT * FROM users').get();
  check('связь и данные сохранены, номер пуст', old.full_name === 'Старая Карточка' && old.bitrix_id === 999 && old.bitrix_pc_number === null);
  check('целостность', d.pragma('integrity_check', { simple: true }) === 'ok');
  dbm.releaseDbLock();
  d.close();

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${fails === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `ПРОВАЛОВ: ${fails}`} (${checks - fails}/${checks})`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(2); });
