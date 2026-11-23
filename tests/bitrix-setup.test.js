#!/usr/bin/env node
// Мастер «Настроить Битрикс24» (задача #11): разбор адреса портала и ссылки вебхука,
// проверка доступа, запись bitrix.yml. Каналы мастера проверяются через тот же
// registerBitrixSetupIpc, что регистрирует приложение (ipcMain и shell подменены).
// Портал — фиктивный, на 127.0.0.1; ключи вымышленные.
//
// Запуск:  npm run test:bitrix   (или node tests/bitrix-setup.test.js)
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const B = require('../src/main/bitrix');
const { registerBitrixSetupIpc } = require('../src/main/bitrixSetup');

let fails = 0;
let checks = 0;
function check(name, cond, extra = '') {
  checks++;
  if (!cond) fails++;
  console.log(`${cond ? '  OK  ' : '  FAIL'} ${name}${extra !== '' ? ` — ${extra}` : ''}`);
}
async function rejects(name, fn, re) {
  try { await fn(); check(name, false, 'ошибки нет'); } catch (e) { check(name, re.test(e.message), e.message); return e; }
  return null;
}

// --- Фиктивный портал. Ключ выбирает поведение:
//   good0key — user_basic, все поля; brief0key — user_brief, без EMAIL/WORK_PHONE;
//   cal00key — вебхук календаря (user.get → insufficient_scope); nouf0key — нет UF_WEB_SITES;
//   bad00key — неверный ключ; slow0key — не отвечает дольше тайм-аута
const ALL_FIELDS = { ID: 'ID', EMAIL: 'E-mail', WORK_PHONE: 'Телефон', UF_WEB_SITES: 'Другие сайты', NAME: 'Имя' };
const requests = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    requests.push(req.url);
    const send = (st, o) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const m = /^\/rest\/1\/([a-z0-9]+)\/([a-z.]+)\.json$/.exec(req.url);
    if (!m) return send(404, { error: 'NOT_FOUND' });
    const [, key, method] = m;
    if (!['user.get', 'user.fields', 'scope'].includes(method)) return send(400, { error: 'UNEXPECTED_METHOD' });
    if (key === 'bad00key') return send(401, { error: 'INVALID_CREDENTIALS' });
    if (key === 'slow0key') return setTimeout(() => send(200, { result: [] }), 9500);
    // user.get и scope отвечают, а user.fields зависает / падает; scope зависает; scope нет
    if (key === 'fslow0key' && method === 'user.fields') return setTimeout(() => send(200, { result: ALL_FIELDS }), 9500);
    if (key === 'f500key' && method === 'user.fields') return send(500, {});
    if (key === 'flist0key' && method === 'user.fields') return send(200, { result: [] });
    if (key === 'sslow0key' && method === 'scope') return setTimeout(() => send(200, { result: ['user_basic'] }), 9500);
    if (key === 'scopenf0key' && method === 'scope') return send(400, { error: 'ERROR_METHOD_NOT_FOUND' });
    if (key === 'cal00key') {
      if (method === 'scope') return send(200, { result: ['calendar'] });
      return send(401, { error: 'insufficient_scope' });
    }
    if (method === 'user.get') return send(200, { result: [{ ID: '1' }], total: 1 });
    if (method === 'scope') return send(200, { result: key === 'brief0key' ? ['user_brief'] : ['user_basic'] });
    const fields = { ...ALL_FIELDS };
    if (key === 'brief0key') { delete fields.EMAIL; delete fields.WORK_PHONE; }
    if (key === 'nouf0key') delete fields.UF_WEB_SITES;
    return send(200, { result: fields });
  });
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const HOST = `127.0.0.1:${server.address().port}`;
  const url = (key, tail = '') => `http://${HOST}/rest/1/${key}/${tail}`;

  console.log('=== Адрес портала и ссылка');
  check('домен портала из адреса с путём', B.normalizePortalHost('https://Company.Bitrix24.ru/devops/') === 'company.bitrix24.ru');
  await rejects('пустой адрес портала', () => B.normalizePortalHost('  '), /Укажите адрес портала/);
  await rejects('не домен', () => B.normalizePortalHost('портал'), /указан неверно/);
  const P = 'company.bitrix24.ru';
  const base = 'https://company.bitrix24.ru/rest/1/abcd1234efgh/';
  check('базовая ссылка', B.normalizeWebhookInput(base, P) === base);
  check('ссылка генератора с методом и параметрами → тот же базовый адрес',
    B.normalizeWebhookInput('https://company.bitrix24.ru/rest/1/abcd1234efgh/user.get.json?FILTER[ID]=1#x', P) === base);
  check('без слеша в конце', B.normalizeWebhookInput('https://company.bitrix24.ru/rest/1/abcd1234efgh', P) === base);
  const e1 = await rejects('другой домен', () => B.normalizeWebhookInput('https://other.bitrix24.ru/rest/1/abcd1234efgh/', P), /другой домен/);
  check('…и ключ не повторяется в тексте ошибки', e1 && !e1.message.includes('abcd1234efgh'));
  await rejects('http для внешнего адреса', () => B.normalizeWebhookInput('http://company.bitrix24.ru/rest/1/abcd1234efgh/', P), /https/);
  const e2 = await rejects('не ссылка вебхука', () => B.normalizeWebhookInput('https://company.bitrix24.ru/marketplace/abcd1234efgh/', P), /Это не ссылка вебхука/);
  check('…без ключа в тексте', e2 && !e2.message.includes('abcd1234efgh'));
  await rejects('пустое поле', () => B.normalizeWebhookInput('', P), /Вставьте ссылку/);

  console.log('\n=== Запись bitrix.yml');
  check('timeout_ms и комментарии сохраняются', B.upsertWebhookInYaml('# мой файл\r\ntimeout_ms: 5000\r\nwebhook_url: "https://old/rest/1/zzzz/"\r\n', base) ===
    `# мой файл\r\ntimeout_ms: 5000\r\nwebhook_url: "${base}"\r\n`);
  check('нет webhook_url — дописывается', B.upsertWebhookInYaml('timeout_ms: 5000\n', base) === `timeout_ms: 5000\nwebhook_url: "${base}"\n`);
  check('BOM сохраняется', B.upsertWebhookInYaml('﻿timeout_ms: 5000\n', base).startsWith('﻿timeout_ms: 5000\n'));
  check('новый файл читается как настройка', B.parseSimpleYaml(B.upsertWebhookInYaml('', base)).webhook_url === base);

  console.log('\n=== Мастер через каналы приложения');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-bxsetup-'));
  const dbPath = path.join(tmp, 'data.db');
  fs.writeFileSync(dbPath, '');
  const handlers = {};
  const opened = [];
  let mode = 'local';
  registerBitrixSetupIpc({
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    shell: { openExternal: async (u) => { opened.push(u); } },
    getContext: () => ({ mode, dbPath: mode === 'client' ? null : dbPath, dataDir: tmp, sourceKind: 'server', remoteHost: '10.0.0.5:47821' })
  });
  const call = (ch, arg) => Promise.resolve(handlers[ch](null, arg));
  const answers = [];
  const spy = async (ch, arg) => { const r = await call(ch, arg); answers.push(JSON.stringify(r)); return r; };

  let st = await spy('bitrixSetup:status');
  check('не настроено, файл будет рядом с базой', !st.configured && st.targetPath === path.join(tmp, 'bitrix.yml') && st.canConfigure);
  await spy('bitrixSetup:openPortal', 'Company.Bitrix24.ru');
  check('«Открыть Битрикс24» — раздел «Разработчикам» по https', opened[0] === 'https://company.bitrix24.ru/devops/');
  await rejects('открыть можно только адрес портала', () => call('bitrixSetup:openPortal', 'javascript:alert(1)'), /указан неверно/);

  const good = await spy('bitrixSetup:check', { portal: HOST, webhook: url('good0key', 'user.get.json?ID=1') });
  check('доступ есть: пользователи читаются, все три поля доступны', good.readUsers && good.canSave && good.fields.EMAIL && good.fields.WORK_PHONE && good.fields.UF_WEB_SITES && !!good.checkId);
  check('вызваны только фиксированные методы чтения', requests.every((u) => /\/(user\.get|user\.fields|scope)\.json$/.test(u)), requests.join(' '));
  check('ссылка не возвращается в окно', !answers.join('').includes('good0key'));

  // Действующий файл с другими настройками
  fs.writeFileSync(path.join(tmp, 'bitrix.yml'), `# рабочая настройка\ntimeout_ms: 4000\nwebhook_url: "${url('old00key')}"\n`);
  const before = fs.readFileSync(path.join(tmp, 'bitrix.yml'), 'utf8');
  const brief = await spy('bitrixSetup:check', { portal: HOST, webhook: url('brief0key') });
  check('user_brief — понятно и сохранить нельзя', !brief.canSave && !brief.checkId && /user_brief/.test(brief.problems.join(' ')) && brief.fields.EMAIL === false, brief.problems.join(' '));
  await rejects('вебхук календаря — нет права читать пользователей', () => call('bitrixSetup:check', { portal: HOST, webhook: url('cal00key') }), /user_basic/);
  await rejects('неверный ключ', () => call('bitrixSetup:check', { portal: HOST, webhook: url('bad00key') }), /отклонил ссылку/);
  await rejects('ссылка на другой домен', () => call('bitrixSetup:check', { portal: 'company.bitrix24.ru', webhook: url('good0key') }), /другой домен/);
  await rejects('недоступный портал', () => call('bitrixSetup:check', { portal: '127.0.0.1:1', webhook: 'http://127.0.0.1:1/rest/1/good0key/' }), /Не удалось связаться/);
  const t0 = Date.now();
  await rejects('тайм-аут', () => call('bitrixSetup:check', { portal: HOST, webhook: url('slow0key') }), /не ответил/);
  check('…в пределах тайм-аута', Date.now() - t0 < 9000, `${Date.now() - t0} мс`);
  console.log('  — незавершённые проверки (замечание приёмки PR #14)');
  const fslow = await spy('bitrixSetup:check', { portal: HOST, webhook: url('fslow0key') });
  check('user.fields не ответил — сохранить нельзя', !fslow.canSave && !fslow.checkId && /Проверка полей \(user\.fields\) не завершена/.test(fslow.problems.join(' ')) &&
    fslow.fields.EMAIL === null, fslow.problems.join(' '));
  check('…рабочая настройка не тронута', fs.readFileSync(path.join(tmp, 'bitrix.yml'), 'utf8') === before);
  const quick = (k) => B.checkWebhookAccess(url(k), 1500);
  const f500 = await quick('f500key');
  check('user.fields вернул ошибку сервера — сохранить нельзя', !f500.canSave && /не завершена/.test(f500.problems.join(' ')), f500.problems.join(' '));
  const flist = await quick('flist0key');
  check('user.fields вернул не список полей — сохранить нельзя', !flist.canSave && /не вернул список полей/.test(flist.problems.join(' ')));
  const sslow = await quick('sslow0key');
  check('scope не ответил — сохранить нельзя', !sslow.canSave && /scope\) не завершена/.test(sslow.problems.join(' ')), sslow.problems.join(' '));
  const scopenf = await quick('scopenf0key');
  check('метода scope на портале нет — это не мешает, поля проверены', scopenf.canSave && scopenf.scopes === null && scopenf.fields.EMAIL === true);
  check('ключ не попадает в тексты проблем', ![fslow, f500, flist, sslow].some((r) => /0key|f500key/.test(r.problems.join(' '))));
  const nouf = await spy('bitrixSetup:check', { portal: HOST, webhook: url('nouf0key') });
  check('нет UF_WEB_SITES — предупреждение, сохранить можно', nouf.canSave && nouf.fields.UF_WEB_SITES === false && /номер ПК/.test(nouf.warnings.join(' ')));
  check('после отказов действующая настройка не изменилась', fs.readFileSync(path.join(tmp, 'bitrix.yml'), 'utf8') === before);
  check('…и по-прежнему читается', B.loadBitrixConfig({ dbPath, dataDir: tmp }).webhookUrl === url('old00key'));
  await rejects('сохранить по неуспешной проверке нельзя', () => call('bitrixSetup:save', { checkId: brief.checkId }), /устарела/);
  await rejects('сохранить по выдуманному идентификатору нельзя', () => call('bitrixSetup:save', { checkId: 'f'.repeat(32) }), /устарела/);

  const saved = await spy('bitrixSetup:save', { checkId: good.checkId });
  const text = fs.readFileSync(path.join(tmp, 'bitrix.yml'), 'utf8');
  check('сохранено в действующий файл, применяется сразу', saved.path === path.join(tmp, 'bitrix.yml') && saved.applied);
  check('webhook_url заменён на базовый адрес, timeout_ms и комментарий остались',
    text === `# рабочая настройка\ntimeout_ms: 4000\nwebhook_url: "${url('good0key')}"\n`, JSON.stringify(text));
  check('настройка читается без перезапуска', B.loadBitrixConfig({ dbPath, dataDir: tmp }).webhookUrl === url('good0key'));
  if (process.platform !== 'win32') check('права файла 600', (fs.statSync(path.join(tmp, 'bitrix.yml')).mode & 0o777) === 0o600);
  await rejects('повторное сохранение по той же проверке нельзя', () => call('bitrixSetup:save', { checkId: good.checkId }), /устарела/);
  st = await spy('bitrixSetup:status');
  check('состояние: подключено, видно домен, но не ссылку', st.configured && st.domain === HOST && !JSON.stringify(st).includes('good0key'));
  check('ни один ответ мастера не содержит ключ', !answers.join('').includes('good0key') && !answers.join('').includes('old00key'));

  console.log('\n=== NM_BITRIX_CONFIG');
  const envFile = path.join(tmp, 'elsewhere', 'nm-bitrix.yml');
  process.env.NM_BITRIX_CONFIG = envFile;
  st = await spy('bitrixSetup:status');
  check('цель — путь из NM_BITRIX_CONFIG', st.targetPath === envFile && st.envOverride && !st.configured);
  const g2 = await call('bitrixSetup:check', { portal: HOST, webhook: url('nouf0key') });
  const s2 = await call('bitrixSetup:save', { checkId: g2.checkId });
  check('записано туда и применяется', s2.path === envFile && s2.applied && B.loadBitrixConfig({ dbPath, dataDir: tmp }).webhookUrl === url('nouf0key'));
  check('файл рядом с базой не тронут', fs.readFileSync(path.join(tmp, 'bitrix.yml'), 'utf8') === text);
  delete process.env.NM_BITRIX_CONFIG;

  console.log('\n=== Клиент сети');
  mode = 'client';
  st = await call('bitrixSetup:status');
  check('клиенту — где настраивается, без пути и домена', st.mode === 'client' && !st.canConfigure && st.sourceKind === 'server' && !('configPath' in st) && !('domain' in st));
  await rejects('клиент не проверяет и не сохраняет', () => call('bitrixSetup:check', { portal: HOST, webhook: url('good0key') }), /на компьютере, где хранится база/);

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${fails === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `ПРОВАЛОВ: ${fails}`} (${checks - fails}/${checks})`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(2); });
