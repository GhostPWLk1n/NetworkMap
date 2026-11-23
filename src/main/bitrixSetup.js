// bitrixSetup.js — мастер «Настроить Битрикс24» (задача #11), только приложение Electron.
//
// Мастер записывает bitrix.yml там, где его читает процесс, владеющий базой: у локального
// приложения и у хоста. Клиент сети базу не держит — ему мастер лишь объясняет, где
// настраивается подключение. Выделенный сервер настраивается файлом (README).
//
// СЕКРЕТЫ. Ссылка вебхука содержит ключ. Поэтому:
//  - каналы мастера — только локальный IPC, в карту RPC (dbChannels) они не входят;
//  - в окно ссылка не возвращается никогда: после проверки она хранится здесь, в памяти,
//    под случайным идентификатором, и «Сохранить» передаёт только этот идентификатор;
//  - тексты ошибок составлены заранее и прогоняются через redactSecrets; в журнал не пишем.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  BitrixError, normalizePortalHost, normalizeWebhookInput, checkWebhookAccess, upsertWebhookInYaml,
  resolveConfigTarget, describeBitrixConfig, loadBitrixConfig, redactSecrets
} = require('./bitrix');

const PENDING_TTL_MS = 10 * 60 * 1000;
const pending = new Map(); // checkId -> { webhookUrl, host, at }

function prunePending() {
  const now = Date.now();
  [...pending.entries()].forEach(([id, p]) => { if (now - p.at > PENDING_TTL_MS) pending.delete(id); });
}

/** Сообщения ошибок проверки — в терминах мастера, а не bitrix.yml. */
function wizardErrorText(err, webhookUrl) {
  const code = err && err.code;
  const known = {
    auth: 'Битрикс24 отклонил ссылку: ключ неверный, вебхук удалён или принадлежит отключённому пользователю.',
    forbidden: 'У вебхука нет права читать пользователей. Создайте входящий вебхук с правом «Пользователи (базовое)» — user_basic (вебхук, например, для календаря не подойдёт).',
    not_found_endpoint: 'Адрес вебхука на портале не найден (HTTP 404) — скопируйте ссылку заново со страницы вебхука.',
    redirect: 'Портал перенаправил запрос на другой адрес — укажите итоговый адрес портала.',
    https_required: 'Битрикс24 принимает вебхуки только по HTTPS.',
    bad_response: 'Ответ не похож на Битрикс24 — проверьте адрес портала.'
  };
  const text = known[code] || String((err && err.message) || 'Проверка не выполнена.')
    .replace(/ ?в webhook_url( в bitrix\.yml)?/g, '')
    .replace(/ Проверьте webhook_url в bitrix\.yml\./g, '');
  return redactSecrets(text, webhookUrl);
}

/**
 * getContext() → { mode, dbPath, dataDir, sourceKind, remoteHost } — читается при каждом
 * вызове: режим и путь к базе могут смениться без перезапуска окна.
 */
function registerBitrixSetupIpc({ ipcMain, shell, getContext }) {
  const ensureOwner = () => {
    const ctx = getContext();
    if (ctx.mode === 'client') {
      throw new Error('Подключение к Битрикс24 настраивается на компьютере, где хранится база (хост или сервер), а не на клиенте.');
    }
    return ctx;
  };

  ipcMain.handle('bitrixSetup:status', () => {
    const ctx = getContext();
    if (ctx.mode === 'client') {
      return { mode: 'client', canConfigure: false, sourceKind: ctx.sourceKind || 'host', remoteHost: ctx.remoteHost || null };
    }
    const d = describeBitrixConfig({ dbPath: ctx.dbPath, dataDir: ctx.dataDir });
    return {
      mode: ctx.mode,
      canConfigure: true,
      configured: d.configured,
      domain: d.domain,
      configPath: d.source,
      targetPath: d.target,
      envOverride: !!process.env.NM_BITRIX_CONFIG,
      error: d.error
    };
  });

  // «Открыть Битрикс24» — раздел «Разработчикам» в системном браузере. Только https и
  // только адрес портала из поля: никакой другой ссылки отсюда не открыть.
  ipcMain.handle('bitrixSetup:openPortal', async (_event, portal) => {
    const host = normalizePortalHost(portal);
    await shell.openExternal(`https://${host}/devops/`);
    return { opened: true, host };
  });

  ipcMain.handle('bitrixSetup:check', async (_event, { portal, webhook } = {}) => {
    ensureOwner();
    prunePending();
    const host = normalizePortalHost(portal);
    const webhookUrl = normalizeWebhookInput(webhook, host);
    let result;
    try {
      result = await checkWebhookAccess(webhookUrl);
    } catch (err) {
      throw new Error(wizardErrorText(err, webhookUrl));
    }
    let checkId = null;
    if (result.canSave) {
      checkId = crypto.randomBytes(16).toString('hex');
      pending.set(checkId, { webhookUrl, host, at: Date.now() });
    }
    return { ...result, domain: host, checkId };
  });

  ipcMain.handle('bitrixSetup:save', (_event, { checkId } = {}) => {
    const ctx = ensureOwner();
    prunePending();
    const p = typeof checkId === 'string' ? pending.get(checkId) : null;
    if (!p) throw new Error('Проверка устарела — нажмите «Проверить доступ» ещё раз.');
    const cfgCtx = { dbPath: ctx.dbPath, dataDir: ctx.dataDir };
    const target = resolveConfigTarget(cfgCtx);
    if (!target) throw new Error('Не удалось определить, куда записать bitrix.yml.');
    let current = '';
    try { current = fs.readFileSync(target, 'utf8'); } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`Не удалось прочитать ${target} (${err.code}). Настройка не изменена.`);
    }
    const next = upsertWebhookInYaml(current, p.webhookUrl);
    // Через временный файл: прерванная запись не оставит полупустой bitrix.yml
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(tmp, next, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, target);
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* нечего убирать */ }
      throw new Error(`Не удалось записать ${target}${err && err.code ? ` (${err.code})` : ''}. Действующая настройка не изменена.`);
    }
    pending.delete(checkId);
    // Сразу проверяем, что приложение читает именно записанное: настройка применяется без перезапуска
    let applied = false;
    try { applied = loadBitrixConfig(cfgCtx).webhookUrl === p.webhookUrl; } catch { applied = false; }
    return { path: target, domain: p.host, applied };
  });
}

module.exports = { registerBitrixSetupIpc, wizardErrorText, BitrixError };
