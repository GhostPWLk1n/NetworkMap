// server/index.js
//
// Выделенный сервер базы NetworkMap: обычный процесс Node (обычно в докере), без
// Electron и без интерфейса.
//
// Чем отличается от режима "хост" внутри приложения. Хостом может стать любой
// запущенный экземпляр, и это работает, пока у кого-то открыто приложение: закрыл —
// и база недоступна остальным. Выделенный сервер держит базу постоянно, поэтому:
//   - ему нужен ключ доступа (он слушает круглосуточно, а не пока кто-то работает);
//   - запись разрешена сразу (включать тумблер в интерфейсе тут некому);
//   - он сам делает резервные копии и показывает страницу статуса.
//
// Протокол — РОВНО ТОТ ЖЕ, что у режима "хост" (см. src/main/rpcServer.js и
// src/shared/dbChannels.js), поэтому приложение подключается к серверу тем же
// клиентским кодом. Расхождения между сервером и хостом быть не может: карта каналов
// у них буквально одна и та же.

const fs = require('fs');
const path = require('path');

const db = require('../src/main/db');
const writeLocks = require('../src/main/writeLocks');
const { startRpcServer } = require('../src/main/rpcServer');
const { DB_CHANNELS } = require('../src/shared/dbChannels');

// ------------------------------------------------------------
// Настройки — только через переменные окружения: в докере это единственный способ
// настроить контейнер, не пересобирая образ.
// ------------------------------------------------------------

function envFlag(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  return !['0', 'false', 'no', 'off', 'нет'].includes(String(raw).trim().toLowerCase());
}

function envInt(name, defaultValue) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : defaultValue;
}

const CONFIG = {
  dataDir: process.env.NM_DATA_DIR || '/data',
  dbPath: process.env.NM_DB_PATH || null, // по умолчанию — <dataDir>/data.db
  port: envInt('NM_PORT', 47821),
  token: (process.env.NM_TOKEN || '').trim() || null,
  allowAnonymous: envFlag('NM_ALLOW_ANONYMOUS', false),
  allowWrites: envFlag('NM_ALLOW_WRITES', true),
  backupDir: process.env.NM_BACKUP_DIR || null, // по умолчанию — <dataDir>/backups
  backupEveryHours: envInt('NM_BACKUP_EVERY_HOURS', 24),
  backupKeep: envInt('NM_BACKUP_KEEP', 14),
  backupEnabled: envFlag('NM_BACKUP', true)
};

const startedAt = new Date();

function log(level, message) {
  // Пишем в stdout построчно с временем и уровнем: в докере это и есть журнал
  // (docker logs), ничего настраивать не нужно
  const stamp = new Date().toISOString();
  const line = `${stamp} [${level}] ${message}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

// ------------------------------------------------------------
// Блокировки «взялся — ходи» — ровно те же, что у хоста (см. writeLocks.js).
// Это и есть поведение «как в Google Таблицах»: все могут писать одновременно, но
// объект, который кто-то уже открыл, у остальных подсвечен и недоступен, а не
// перезаписывается молча последним успевшим.
// ------------------------------------------------------------

// clientId -> { hostname, lastSeenAt }
const connectedClients = new Map();
const CLIENT_STALE_AFTER_MS = 25000; // не пинговал дольше — считаем отключившимся (heartbeat клиента — раз в 10с)

function activeClients() {
  const now = Date.now();
  for (const [id, info] of connectedClients) {
    if (now - info.lastSeenAt > CLIENT_STALE_AFTER_MS) connectedClients.delete(id);
  }
  return [...connectedClients.entries()].map(([clientId, info]) => ({ clientId, ...info }));
}

/** Сервер обязан принимать решение о записи сам: передать запрос дальше без проверки
 *  нельзя (rpcServer тогда отклонит всё), а разрешить всё без блокировок — значит
 *  потерять защиту от одновременной правки одного объекта двумя людьми. */
function authorizeWrite(channel, payload, clientId, hostname) {
  if (!CONFIG.allowWrites) {
    return { ok: false, error: 'Сервер открыт только для чтения (NM_ALLOW_WRITES=0) — изменения отключены администратором.' };
  }
  if (db.getDbReadonly().readonly) {
    // База занята кем-то ещё (другой контейнер на том же томе, или кто-то открыл этот
    // же файл приложением напрямую) — писать нельзя, и честнее сказать это сразу
    return { ok: false, error: 'База на сервере сейчас открыта только для чтения — она занята другим процессом.' };
  }
  if (!clientId) {
    return { ok: false, error: 'Клиент не представился — обновите приложение до версии с поддержкой сервера.' };
  }

  const entry = DB_CHANNELS[channel];
  const lockEntity = entry && entry.lockEntity ? entry.lockEntity(payload) : null;
  if (lockEntity && lockEntity.id != null) {
    if (!writeLocks.canWrite(clientId, lockEntity.type, lockEntity.id)) {
      const holder = writeLocks.whoHolds(lockEntity.type, lockEntity.id);
      return { ok: false, error: `Сейчас редактируется на «${holder ? holder.hostname : '?'}» — подождите, пока он закончит.` };
    }
    // Запись по объекту = он точно "в работе" у этого клиента: продлеваем блокировку,
    // чтобы она не протухла посреди серии правок
    writeLocks.acquire(clientId, hostname || clientId, lockEntity.type, lockEntity.id);
  }
  return { ok: true };
}

/** Heartbeat блокировок — тот же протокол, что у хоста (см. handleLocksHeartbeat в
 *  main/index.js): клиент присылает, что держит открытым, и получает обратно и свои
 *  права, и полный снимок занятости для подсветки чужих объектов. */
function handleLocksHeartbeat({ clientId, hostname, heldKeys }) {
  if (!clientId) return { allowWrites: false, acquired: [], rejected: [], allLocks: [] };
  connectedClients.set(clientId, { hostname: hostname || clientId, lastSeenAt: Date.now() });

  const allowWrites = CONFIG.allowWrites && !db.getDbReadonly().readonly;
  if (!allowWrites) {
    return {
      allowWrites: false, acquired: [],
      rejected: (heldKeys || []).map((k) => ({ ...k, heldBy: null })),
      allLocks: writeLocks.listAll().map((l) => ({ ...l, isMine: l.clientId === clientId }))
    };
  }
  const result = writeLocks.syncClientLocks(clientId, hostname || clientId, heldKeys || []);
  return { allowWrites: true, ...result };
}

const RPC_HANDLERS = {
  ...DB_CHANNELS,
  'locks:heartbeat': { write: false, fn: (p) => handleLocksHeartbeat(p) }
};

// ------------------------------------------------------------
// Резервные копии
// ------------------------------------------------------------

/** Копируем ОНЛАЙН-бэкапом better-sqlite3, а не копированием файла: при включённом WAL
 *  часть данных живёт в -wal, и простой cp даёт заведомо рваную копию. */
async function makeBackup(reason) {
  const dir = CONFIG.backupDir || path.join(CONFIG.dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dir, `data-${stamp}.db`);
  try {
    await db.getDb().backup(target);
    const size = fs.statSync(target).size;
    log('info', `Резервная копия (${reason}): ${target}, ${(size / 1048576).toFixed(1)} МБ`);
    rotateBackups(dir);
  } catch (err) {
    log('error', `Не удалось сделать резервную копию: ${err.message}`);
  }
}

function rotateBackups(dir) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => /^data-.*\.db$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    files.slice(CONFIG.backupKeep).forEach(({ f }) => {
      try { fs.unlinkSync(path.join(dir, f)); log('info', `Удалена старая копия: ${f}`); }
      catch (err) { log('error', `Не удалось удалить старую копию ${f}: ${err.message}`); }
    });
  } catch (err) {
    log('error', `Не удалось разобрать папку копий: ${err.message}`);
  }
}

function lastBackupInfo() {
  const dir = CONFIG.backupDir || path.join(CONFIG.dataDir, 'backups');
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => /^data-.*\.db$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (files.length === 0) return { count: 0, last: null };
    return { count: files.length, last: new Date(files[0].t).toISOString(), name: files[0].f };
  } catch {
    return { count: 0, last: null };
  }
}

// ------------------------------------------------------------
// Страница статуса и healthcheck
// ------------------------------------------------------------

function humanDuration(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} сут ${h} ч`;
  if (h > 0) return `${h} ч ${m} мин`;
  return `${m} мин`;
}

function dbFileSize() {
  try {
    let total = fs.statSync(resolvedDbPath).size;
    for (const suffix of ['-wal', '-shm']) {
      try { total += fs.statSync(resolvedDbPath + suffix).size; } catch { /* файла может не быть */ }
    }
    return `${(total / 1048576).toFixed(1)} МБ`;
  } catch {
    return 'неизвестно';
  }
}

function buildStatusPage() {
  const ro = db.getDbReadonly();
  const clients = activeClients();
  const locks = writeLocks.listAll();
  const backup = lastBackupInfo();
  const counts = countRows();

  return {
    title: 'Сервер NetworkMap',
    rows: [
      ['Состояние', ro.readonly ? `только чтение — ${ro.reason || 'база занята'}` : 'работает, запись разрешена'],
      ['Запись разрешена', CONFIG.allowWrites ? 'да' : 'нет (NM_ALLOW_WRITES=0)'],
      ['Ключ доступа', CONFIG.token ? 'задан' : 'НЕ ЗАДАН — подключиться может любой'],
      ['Файл базы', resolvedDbPath],
      ['Размер базы', dbFileSize()],
      ['Версия схемы', String(schemaVersion)],
      ['Порт', String(CONFIG.port)],
      ['Запущен', `${startedAt.toISOString()} (${humanDuration(Date.now() - startedAt.getTime())} назад)`],
      ['Подключено сейчас', clients.length === 0 ? 'никого' : clients.map((c) => c.hostname).join(', ')],
      ['Объектов занято', locks.length === 0 ? 'нет' : locks.map((l) => `${l.type}#${l.id} (${l.hostname})`).join(', ')],
      ['Устройств / пользователей / планов', `${counts.devices} / ${counts.users} / ${counts.plans}`],
      ['Записей в журнале', String(counts.audit)],
      ['Резервные копии', CONFIG.backupEnabled
        ? `каждые ${CONFIG.backupEveryHours} ч, храним ${CONFIG.backupKeep}; сейчас ${backup.count}${backup.last ? `, последняя ${backup.last}` : ''}`
        : 'отключены (NM_BACKUP=0)']
    ]
  };
}

function countRows() {
  const safe = (sql) => {
    try { return db.getDb().prepare(sql).get().c; } catch { return '?'; }
  };
  return {
    devices: safe('SELECT COUNT(*) c FROM devices'),
    users: safe('SELECT COUNT(*) c FROM users'),
    plans: safe('SELECT COUNT(*) c FROM floor_plans'),
    audit: safe('SELECT COUNT(*) c FROM audit_log')
  };
}

function healthCheck() {
  try {
    db.getDb().prepare('SELECT 1').get();
    return {
      ok: true,
      readonly: db.getDbReadonly().readonly,
      clients: activeClients().length,
      uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000)
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ------------------------------------------------------------
// Запуск
// ------------------------------------------------------------

let resolvedDbPath = null;
let schemaVersion = '?';
let serverInstance = null;
let backupTimer = null;

async function main() {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  // Служебные файлы (db-config.json и прочее) — в том же томе, чтобы ничего не оседало
  // в слоях контейнера и не терялось при пересоздании
  db.setUserDataPath(CONFIG.dataDir);
  resolvedDbPath = CONFIG.dbPath || path.join(CONFIG.dataDir, 'data.db');

  if (!CONFIG.token && !CONFIG.allowAnonymous) {
    log('error', 'Не задан ключ доступа. Укажите NM_TOKEN=<секрет> — его же надо будет ввести в приложении ' +
      '(⚙️ Настройки БД → Подключиться к серверу). Если сервер стоит в заведомо закрытой сети и ключ не нужен, ' +
      'запустите с NM_ALLOW_ANONYMOUS=1 — тогда подключиться сможет любой, кто знает адрес и порт.');
    process.exit(2);
  }
  if (!CONFIG.token) {
    log('warn', 'Сервер работает БЕЗ ключа доступа (NM_ALLOW_ANONYMOUS=1): подключиться может любой, кто видит порт.');
  }

  log('info', `Открываю базу: ${resolvedDbPath}`);
  try {
    db.initDatabase(resolvedDbPath);
  } catch (err) {
    log('error', `Не удалось открыть базу: ${err.message}`);
    process.exit(1);
  }

  const ro = db.getDbReadonly();
  if (ro.readonly) {
    // Самый вероятный случай — второй контейнер на том же томе либо кто-то открыл этот
    // файл приложением напрямую. Поднимаемся всё равно: раздавать данные на чтение
    // полезнее, чем не запуститься совсем.
    log('warn', `База открыта ТОЛЬКО ДЛЯ ЧТЕНИЯ: ${ro.reason}. Изменения будут отклоняться.`);
    if (ro.schemaMismatch) {
      log('warn', `Версия схемы ${ro.schemaMismatch.found}, ожидается ${ro.schemaMismatch.expected} — ` +
        'обновить её нельзя, пока база занята.');
    }
  }
  schemaVersion = (() => {
    try { return db.getDb().pragma('user_version', { simple: true }); } catch { return '?'; }
  })();
  log('info', `База открыта, версия схемы ${schemaVersion}${ro.readonly ? ' (только чтение)' : ''}`);

  // Нас могли вытеснить уже на ходу (том подмонтировали ещё куда-то, запустился второй
  // контейнер) — тогда перестаём писать, но продолжаем отдавать данные на чтение
  db.dbLock.onLockLost((holder) => {
    db.markReadonly(holder, `База перехвачена «${holder && holder.hostname ? holder.hostname : 'другим процессом'}»`);
    log('warn', 'Замок на базу перехвачен другим процессом — сервер перешёл в режим только чтения.');
  });

  try {
    serverInstance = await startRpcServer(CONFIG.port, RPC_HANDLERS, {
      token: CONFIG.token,
      onClientPing: (clientId, hostname) => {
        const known = connectedClients.has(clientId);
        connectedClients.set(clientId, { hostname, lastSeenAt: Date.now() });
        if (!known) log('info', `Подключился клиент: ${hostname}`);
      },
      authorizeWrite,
      statusPage: buildStatusPage,
      healthCheck,
      onLog: log
    });
  } catch (err) {
    log('error', `Не удалось занять порт ${CONFIG.port}: ${err.message}`);
    process.exit(1);
  }

  log('info', `Сервер слушает 0.0.0.0:${CONFIG.port}` +
    (CONFIG.allowWrites ? '' : ' (только чтение, NM_ALLOW_WRITES=0)'));
  log('info', `Страница статуса: http://<адрес>:${CONFIG.port}/${CONFIG.token ? '?token=<ключ>' : ''}`);

  if (CONFIG.backupEnabled && !ro.readonly) {
    await makeBackup('при запуске');
    backupTimer = setInterval(() => makeBackup('по расписанию'), CONFIG.backupEveryHours * 3600 * 1000);
  } else if (CONFIG.backupEnabled) {
    log('warn', 'Резервные копии пропущены: база открыта только для чтения, копию делает тот, кто ею владеет.');
  }

  // Докер останавливает контейнер сигналом — без этого обработчика процесс убьют
  // жёстко, и файл-замок останется лежать до истечения таймаута, из-за чего
  // перезапущенный контейнер поднялся бы в режиме только чтения
  const shutdown = (signal) => {
    log('info', `Получен ${signal} — останавливаюсь`);
    if (backupTimer) clearInterval(backupTimer);
    if (serverInstance) { try { serverInstance.close(); } catch { /* уже могло закрыться */ } }
    db.releaseDbLock();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log('error', `Сервер не запустился: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
