const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { fork } = require('child_process');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const {
  // Репозитории здесь нужны только там, где логика шире одного канала данных:
  // auditLogRepo — уведомления об изменениях. Сами каналы живут в shared/dbChannels.js.
  initDatabase, auditLogRepo, getDbReadonly, markReadonly, releaseDbLock, dbLock,
  getDefaultDbPath, getCurrentDbPath, getLastConnectWarning, setConfiguredDbPath, getConfiguredDbPath,
  getAppMode, getHostPort, getRemoteHost, setHostMode, setClientMode, getDiscoveryPath,
  getServerToken, getSourceKind, getUserDataDir,
  getAllowClientWrites, setAllowClientWrites
} = require('./db');
const { importExcel } = require('./import');
const { parsePcInfoFile, parsePcInfoFolder, applyPcInfoImport } = require('./pcInfoImport');
const { DB_CHANNELS } = require('../shared/dbChannels');
const { registerInvoiceIpc } = require('./invoiceFiles');
const { registerBitrixSetupIpc } = require('./bitrixSetup');
const { startRpcServer } = require('./rpcServer');
const { rpcCall, rpcPing, rpcDiagnose } = require('./rpcClient');
const { publishHostMarker, updateHostMarker, removeHostMarker, readHostMarker, findActiveMarkersInDir, cleanupStaleMarkersInDir } = require('./discovery');
const { initLocalCache, saveToCache, readFromCache, hasAnyCache, forceFlush } = require('./localCache');
const writeLocks = require('./writeLocks');

let mainWindow;
let rpcServerInstance = null; // держим ссылку, чтобы можно было закрыть порт при выходе
let discoveryHeartbeatTimer = null;
let ownMarkerPath = null; // путь к СВОЕМУ файлу-маячку (см. discovery.js) — heartbeat/удаление трогают только его
let connectivityHeartbeatTimer = null; // клиентский режим — периодическая проверка связи с хостом
// Клиентский режим: собственный id этого инстанса (на всю сессию, не хранится между
// перезапусками — при следующем запуске сгенерируется новый) — чтобы хост видел, что
// это тот же самый клиент, а не новый, если несколько раз пинганёт за одну сессию.
const clientInstanceId = crypto.randomUUID();
// Ключ доступа к выделенному серверу — нужен в каждом сетевом вызове. У режима "хост"
// ключа нет (null), и проверка на той стороне тогда просто не выполняется.
const serverToken = getServerToken();
let lastKnownAuditId = null; // с какого id отслеживаем новые записи журнала — сбрасывается при (пере)подключении (клиентский режим)
let hostLastNotifiedAuditId = null; // то же самое, но для СОБСТВЕННОГО окна хоста — отслеживает, что уже показано, когда меняет клиент
// Режим "хост": кто сейчас пингует — clientId -> { hostname, lastSeenAt }. Без этого
// хост формально не видел подключённых клиентов, только раздавал им данные по запросу.
const connectedClients = new Map();
const CLIENT_STALE_AFTER_MS = 25000; // не пинговал дольше — считаем отключившимся (heartbeat клиента — раз в 10с)
let hostReachable = true; // актуально только в режиме "клиент"
// Сообщение о том, что произошло при подключении на старте (например, "хост недоступен,
// показаны сохранённые данные") — раньше показывалось через dialog.showErrorBox() ДО
// создания окна, но это ненадёжно (в некоторых окружениях нативный диалог до появления
// хоть одного BrowserWindow может вообще не вернуть управление, подвешивая весь процесс).
// Теперь копится здесь и показывается тостом уже ПОСЛЕ того, как окно открылось.
let startupNotice = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Первый heartbeat происходит в app.whenReady(), ДО создания окна, поэтому событие
  // locks-state-changed с реальными правами уходило в никуда: рендерер подписывается
  // на него только после загрузки страницы. Из-за этого клиент до 10 секунд (до
  // следующего тика) показывал «только просмотр» и держал кнопку «Рисование»
  // выключенной, даже когда запись была разрешена. Повторяем тик сразу после загрузки.
  mainWindow.webContents.once('did-finish-load', () => {
    if (getAppMode() !== 'client') return;
    const remoteHost = getRemoteHost();
    if (remoteHost) heartbeatTick(remoteHost).catch(() => { /* следующий тик попробует снова */ });
  });
}

/**
 * Карта всех операций с БД — { [ipc-канал]: { write: boolean, fn: (payload) => result } }.
 * write=true — операция меняет данные, недоступна клиенту (см. режим "клиент" ниже).
 * Используется ОДИНАКОВО в трёх местах:
 *   - локальный режим / хост: ipcMain.handle(channel, (_e, payload) => fn(payload))
 *   - хост: та же карта отдаётся RPC-серверу (rpcServer.js) для запросов по сети
 *   - клиент: read-вызовы уходят по сети на хост (rpcClient.js), write — отклоняются
 *     сразу на месте, даже не пытаясь стучаться на хост
 */
/** Обработчик locks:heartbeat — вызывается клиентом на каждом тике (см.
 *  startClientHeartbeat), heldKeys — то, что клиент сейчас реально держит открытым
 *  для редактирования. Если глобальный тумблер выключен — ничего не выдаём и снимаем
 *  всё, что было (на случай если тумблер выключили ПОКА клиент уже что-то держал). */
function handleLocksHeartbeat({ clientId, hostname, heldKeys }) {
  let result;
  if (!getAllowClientWrites()) {
    writeLocks.releaseAllForClient(clientId);
    result = { allowWrites: false, acquired: [], rejected: (heldKeys || []).map((k) => ({ ...k, heldBy: null, reason: 'writes-disabled' })), allLocks: [] };
  } else {
    result = { allowWrites: true, ...writeLocks.syncClientLocks(clientId, hostname, heldKeys || []) };
  }
  pushLocksStateToHost(); // хост видит занятость объектов точно так же, как её видит клиент — не только по факту отказа при попытке записи
  return result;
}

/** Отправляет собственному окну хоста живой снимок всех активных блокировок — хост
 *  раньше "не видел" резервирования клиентов вообще, узнавая о занятости только по
 *  факту отказа при попытке что-то отредактировать. Переиспользует тот же канал
 *  'locks-state-changed', что уже умеет обрабатывать интерфейс клиента (isMine здесь
 *  всегда false — у хоста нет "своих" блокировок в этом смысле, он либо владелец БД
 *  без всяких резервирований, либо уважает чужие). */
function pushLocksStateToHost() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const allLocks = writeLocks.listAll().map((l) => ({ type: l.type, id: l.id, hostname: l.hostname, isMine: false }));
    mainWindow.webContents.send('locks-state-changed', { allowWrites: true, allLocks, acquired: [], rejected: [] });
  }
}

/** Проверка прав ПЕРЕД любой write-операцией, пришедшей по сети (см. authorizeWrite в
 *  startRpcServer) — локальные вызовы самого хоста сюда вообще не попадают, хост всегда
 *  полный хозяин своих данных. Два уровня: сначала общий тумблер (без него — отказ
 *  сразу, точечные разрешения на будущее сюда же и добавятся), затем — если у канала
 *  задан lockEntity — владение конкретным объектом (модель "взялся — ходи"). */
function authorizeWrite(channel, payload, clientId, hostname) {
  if (!getAllowClientWrites()) {
    return { ok: false, error: 'Изменения от клиентов сейчас не разрешены хостом.' };
  }
  const entry = RPC_HANDLERS[channel];
  if (entry && entry.lockEntity) {
    const entity = entry.lockEntity(payload);
    if (entity && entity.id != null && !writeLocks.canWrite(clientId, entity.type, entity.id)) {
      const holder = writeLocks.whoHolds(entity.type, entity.id);
      return { ok: false, error: `Сейчас редактируется другим клиентом (${holder ? holder.hostname : '?'}) — подождите, пока он закончит.` };
    }
  }
  return { ok: true };
}

/** Вызывается ПОСЛЕ каждой успешной write-операции, пришедшей по сети от клиента (см.
 *  onWriteSuccess в startRpcServer) — раньше хост о таких изменениях вообще не узнавал:
 *  клиент их видел (сам инициировал), а собственное окно хоста просто не было ни на что
 *  подписано. Переиспользует ТОТ ЖЕ журнал и ТОТ ЖЕ канал 'data-changed', что клиент уже
 *  использует для отслеживания изменений хоста — рендерер хоста обрабатывает событие
 *  совершенно одинаково, независимо от того, кто был инициатором. */
function notifyHostOfClientWrite() {
  if (hostLastNotifiedAuditId === null) {
    hostLastNotifiedAuditId = auditLogRepo.latestId(); // первый вызов — точка отсчёта, не заваливаем всей историей
    return;
  }
  const changes = auditLogRepo.listSince(hostLastNotifiedAuditId);
  if (changes.length === 0) return;
  hostLastNotifiedAuditId = changes[changes.length - 1].id;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('data-changed', changes);
  }
}

// Каналы работы с данными вынесены в src/shared/dbChannels.js — их же использует
// выделенный сервер (server/index.js), который работает без Electron. Здесь к ним
// добавляется только то, что осмысленно исключительно в приложении: heartbeat
// блокировок (у него своя проверка прав, см. handleLocksHeartbeat).
const RPC_HANDLERS = {
  ...DB_CHANNELS,
  // Не бизнес-данные (не БД) — сама проверка прав живёт внутри функции, не через общий
  // authorizeWrite; см. handleLocksHeartbeat ниже. write:false — вызов разрешён всегда,
  // а вот РЕЗУЛЬТАТ (что реально выдано) зависит от тумблера и занятости объектов.
  'locks:heartbeat': { write: false, fn: (p) => handleLocksHeartbeat(p) }
};

const CLIENT_MODE_IMPORT_ERROR = 'Импорт недоступен в режиме клиента — выполните его на компьютере-хосте, у которого есть прямой доступ к базе.';

function registerIpcHandlers() {
  const mode = getAppMode();

  ipcMain.handle('app:version', () => app.getVersion());

  // Счета поставщиков (задача #8): выбор и разбор PDF, открытие и сохранение оригинала —
  // локально, в любом режиме. Сама запись в базу — каналы invoices:* из dbChannels.
  registerInvoiceIpc({ ipcMain, dialog, shell, getWindow: () => mainWindow });

  // Мастер «Настроить Битрикс24» (задача #11): пишет bitrix.yml у процесса, владеющего
  // базой (локально и у хоста). Только локальный IPC — ссылка вебхука в сеть не уходит.
  registerBitrixSetupIpc({
    ipcMain, shell,
    getContext: () => ({
      mode, dbPath: mode === 'client' ? null : getCurrentDbPath(), dataDir: getUserDataDir(),
      sourceKind: mode === 'client' ? getSourceKind() : null, remoteHost: mode === 'client' ? getRemoteHost() : null
    })
  });

  if (mode === 'client') {
    const remoteHost = getRemoteHost();
    Object.entries(RPC_HANDLERS).forEach(([channel, { write, fn, noCache, timeoutMs }]) => {
      // timeoutMs — для каналов, которые везут файлы (оригинал счёта до 5 МБ): по
      // медленному VPN 10 секунд на них может не хватить
      const rpcTimeout = timeoutMs || 10000;
      ipcMain.handle(channel, async (_event, payload) => {
        const clientInfo = { clientId: clientInstanceId, hostname: os.hostname() };
        if (write || noCache) {
          // noCache — данные, которые обязаны быть свежими (предпросмотр из Битрикс24):
          // подставить при обрыве связи старый ответ значило бы показать оператору то,
          // чего уже нет, а сохранять их на диск клиента незачем.
          // Решение "можно/нельзя" теперь принимает ИСКЛЮЧИТЕЛЬНО хост (тумблер +
          // блокировки, см. authorizeWrite) — раньше клиент отказывал сам себе по
          // жёсткому правилу "запись = нет", без всякой возможности это разрешить.
          // Кэшировать write-результаты не нужно (не идемпотентные операции) и
          // повторять из кэша при сбое сети тоже нельзя — просто пробрасываем ошибку.
          return rpcCall(remoteHost, channel, payload, rpcTimeout, clientInfo, serverToken);
        }
        try {
          const result = await rpcCall(remoteHost, channel, payload, rpcTimeout, clientInfo, serverToken);
          saveToCache(channel, payload, result); // свежий успешный ответ — обновляем локальный кэш
          return result;
        } catch (err) {
          // Сети сейчас нет (или хост недоступен) — если для ЭТОГО конкретного запроса
          // (с теми же параметрами) уже был успешный ответ раньше, отдаём его вместо
          // ошибки, помечая интерфейс отдельным событием, что данные могут быть устаревшими
          const cached = readFromCache(channel, payload);
          if (cached) {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('using-stale-cache', { channel, cachedAt: cached.cachedAt });
            }
            return cached.result;
          }
          throw err; // для этого конкретного запроса кэша ещё никогда не было — обычная ошибка
        }
      });
    });

    // Импорт требует одновременно локального файла (диалог выбора) и записи в БД —
    // в клиентском режиме второе невозможно, отключаем явным понятным сообщением,
    // а не даём наткнуться на путаную ошибку "нет подключения к БД"
    ['import:excelDevices', 'import:pcInfoPickFile', 'import:pcInfoPickFolder', 'import:pcInfoApply'].forEach((channel) => {
      ipcMain.handle(channel, () => { throw new Error(CLIENT_MODE_IMPORT_ERROR); });
    });

    // Запрос/освобождение права на редактирование конкретного объекта — модель
    // "взялся — ходи" (см. writeLocks.js). Только клиентский режим: у хоста нет
    // смысла "запрашивать" разрешение у самого себя, он всегда полный хозяин.
    ipcMain.handle('locks:requestLock', (_event, { type, id }) => requestLock(type, id));
    ipcMain.handle('locks:releaseLock', (_event, { type, id }) => releaseLock(type, id));
  } else {
    // local ИЛИ host — как раньше, прямые вызовы репозиториев, но теперь хост тоже
    // уважает блокировки, которые держат подключённые клиенты (раньше хост мог
    // перехватить зарезервированный клиентом объект без единого предупреждения —
    // локальные вызовы вообще не проходили через writeLocks). В режиме 'local'
    // клиентов не бывает в принципе, эта проверка там просто ничего не найдёт.
    Object.entries(RPC_HANDLERS).forEach(([channel, { write, fn, lockEntity }]) => {
      ipcMain.handle(channel, async (_event, payload) => {
        if (write && mode === 'host' && lockEntity) {
          const entity = lockEntity(payload);
          if (entity && entity.id != null) {
            const holder = writeLocks.whoHolds(entity.type, entity.id);
            if (holder) {
              throw new Error(
                `Сейчас редактируется клиентом «${holder.hostname}» — подождите, пока он закончит, ` +
                'либо отключите его принудительно (⚙️ Настройки БД → список подключённых клиентов).'
              );
            }
          }
        }
        const result = await fn(payload);
        if (write && mode === 'host' && hostLastNotifiedAuditId !== null) {
          // Собственное локальное действие хоста тоже сдвигает точку отсчёта — иначе
          // при следующей записи от клиента notifyHostOfClientWrite() заново покажет
          // хосту его же локальные изменения, сделанные между стартом сервера и этим
          // моментом (хост их и так уже видит напрямую — обновление UI после ЛОКАЛЬНОГО
          // действия делает сам вызывающий код, а не data-changed)
          hostLastNotifiedAuditId = auditLogRepo.latestId();
        }
        return result;
      });
    });

    // Настройка "разрешить клиентам менять" — только для собственного UI хоста
    // (не через сеть; сами клиенты меняют её тем, что запрашивают/используют право
    // записи, но включает/выключает тумблер только сам хост локально)
    ipcMain.handle('settings:getAllowClientWrites', () => getAllowClientWrites());
    ipcMain.handle('settings:setAllowClientWrites', (_event, allow) => { setAllowClientWrites(allow); return getAllowClientWrites(); });

    ipcMain.handle('import:excelDevices', async () => {
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: 'Выберите файл со списком ПК',
        filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }],
        properties: ['openFile']
      });
      if (picked.canceled || picked.filePaths.length === 0) return null;
      return importExcel(picked.filePaths[0]);
    });

    ipcMain.handle('import:pcInfoPickFile', async (_event, forceDeviceId) => {
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: 'Выберите файл со сведениями о ПК (.json)',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile']
      });
      if (picked.canceled || picked.filePaths.length === 0) return null;
      return parsePcInfoFile(picked.filePaths[0], forceDeviceId || null);
    });
    ipcMain.handle('import:pcInfoPickFolder', async () => {
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: 'Выберите папку с файлами сведений о ПК (.json)',
        properties: ['openDirectory']
      });
      if (picked.canceled || picked.filePaths.length === 0) return null;
      return parsePcInfoFolder(picked.filePaths[0]);
    });
    ipcMain.handle('import:pcInfoApply', (_event, { parsed, fieldChoices }) => applyPcInfoImport(parsed, fieldChoices));
  }

  // --- подключение к базе данных: локальный файл / сетевой путь / режим хоста / режим клиента ---
  ipcMain.handle('settings:getDbInfo', () => {
    const notice = startupNotice;
    startupNotice = null; // одноразовое сообщение — не должно всплывать повторно
    return {
      path: mode === 'client' ? null : getCurrentDbPath(),
      isDefault: mode !== 'client' && getCurrentDbPath() === getDefaultDbPath(),
      warning: getLastConnectWarning(),
      mode,
      hostPort: mode === 'host' ? getHostPort() : null,
      remoteHost: mode === 'client' ? getRemoteHost() : null,
      // 'host' (другой экземпляр приложения) или 'server' (выделенный сервер) — протокол
      // один, но подписи и доступные действия в интерфейсе разные
      sourceKind: mode === 'client' ? getSourceKind() : null,
      hostReachable: mode === 'client' ? hostReachable : null,
      startupNotice: notice,
      // Режим только чтения: базу уже держит другой живой экземпляр (см. db/dbLock.js).
      // Интерфейс по этому признаку показывает плашку и уходит в режим просмотра.
      readonly: getDbReadonly(),
      // electron-builder выставляет эту переменную окружения ТОЛЬКО для portable-сборки
      // (не для обычного установленного приложения) — надёжный способ отличить одно от другого
      isPortable: !!process.env.PORTABLE_EXECUTABLE_DIR
    };
  });

  ipcMain.handle('settings:pickExistingDbFile', async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Выберите файл базы данных (data.db)',
      filters: [{ name: 'SQLite DB', extensions: ['db', 'sqlite', 'sqlite3'] }],
      properties: ['openFile']
    });
    if (picked.canceled || picked.filePaths.length === 0) return null;
    return picked.filePaths[0];
  });

  ipcMain.handle('settings:pickDiscoveryFolder', async () => {
    // Отдельный диалог именно на папку — Electron на Windows ненадёжно обрабатывает
    // properties: ['openFile', 'openDirectory'] в одном диалоге (в отличие от macOS),
    // отсюда и была жалоба "можно выбрать папку, но нельзя выбрать сам файл БД"
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Выберите папку с маячками хостов',
      properties: ['openDirectory']
    });
    if (picked.canceled || picked.filePaths.length === 0) return null;
    return picked.filePaths[0];
  });

  ipcMain.handle('settings:pickNewDbLocation', async () => {
    const picked = await dialog.showSaveDialog(mainWindow, {
      title: 'Где создать новую базу данных',
      defaultPath: 'data.db',
      filters: [{ name: 'SQLite DB', extensions: ['db'] }]
    });
    if (picked.canceled || !picked.filePath) return null;
    return picked.filePath;
  });

  // Проверяем, что путь реально открывается, ДО того как сохранить его в конфиг и перезапустить —
  // иначе неверный сетевой путь может увести пользователя в цикл "приложение не открывается"
  ipcMain.handle('settings:connectDb', (_event, dbPath) => {
    // Если это ПАПКА — ищем маячки хостов внутри (см. discovery.js: каждый хост пишет
    // свой уникальный файл, поэтому в папке может обнаружиться сразу несколько — живых
    // и/или протухших от давно упавших хостов), а не пытаемся открыть саму папку как БД.
    try {
      if (fs.statSync(dbPath).isDirectory()) {
        const markers = findActiveMarkersInDir(dbPath);
        if (markers.length > 0) {
          return { success: false, isHostMarker: true, markers };
        }
        return { success: false, error: 'В этой папке не нашлось ни файла БД, ни маячков хостов.' };
      }
    } catch { /* не папка (или её нет) — пробуем как обычный файл БД ниже */ }

    try {
      const testDb = new (require('better-sqlite3'))(dbPath);
      // new Database() сама по себе НЕ бросает исключение на файле, который не является
      // SQLite-базой (открытие ленивое) — только настоящий запрос выявляет подмену,
      // например маячок хоста (JSON) или вообще произвольный файл
      testDb.prepare('SELECT 1').get();
      testDb.close();
    } catch (err) {
      // Прежде чем считать это просто ошибкой — может, это маячок хоста в старом формате
      // (единственный файл по фиксированному пути, до v1.32) — тогда подскажем адрес
      // вместо невнятной ошибки SQLite
      const marker = readHostMarker(dbPath);
      if (marker) {
        return { success: false, isHostMarker: true, markers: [marker] };
      }
      return { success: false, error: err.message };
    }
    setConfiguredDbPath(dbPath);
    app.relaunch();
    app.exit(0);
    return { success: true };
  });

  ipcMain.handle('settings:resetDb', () => {
    setConfiguredDbPath(null);
    app.relaunch();
    app.exit(0);
    return { success: true };
  });

  // --- совместный доступ: режим "хост" (держит БД локально, раздаёт по сети) / "клиент" ---
  ipcMain.handle('settings:setHostMode', (_event, { dbPath, hostPort, discoveryPath }) => {
    setHostMode(dbPath || null, hostPort, discoveryPath || null);
    app.relaunch();
    app.exit(0);
    return { success: true };
  });

  ipcMain.handle('settings:setClientMode', async (_event, remoteHost) => {
    if (!remoteHost || !remoteHost.includes(':')) {
      return { success: false, error: 'Укажите адрес в формате ip:порт' };
    }
    const alive = await rpcPing(remoteHost, 6000, null, serverToken);
    if (!alive) {
      return { success: false, error: `Хост ${remoteHost} не отвечает. Проверьте адрес, порт и что на хосте запущен режим "хост".` };
    }
    setClientMode(remoteHost, null, 'host');
    app.relaunch();
    app.exit(0);
    return { success: true };
  });

  /** Подключение к ВЫДЕЛЕННОМУ серверу (см. server/index.js). Протокол тот же, что у
   *  режима "хост", но нужен ключ доступа, поэтому и отдельный канал: ошибку «ключ не
   *  принят» важно отличать от «адрес не отвечает», иначе человек будет искать проблему
   *  в сети, хотя дело в ключе. */
  ipcMain.handle('settings:setServerMode', async (_event, { remoteHost, token }) => {
    if (!remoteHost || !remoteHost.includes(':')) {
      return { success: false, error: 'Укажите адрес сервера в формате ip:порт' };
    }
    const check = await rpcDiagnose(remoteHost, 6000, token || null);
    if (!check.ok) return { success: false, error: check.error, reason: check.reason };
    setClientMode(remoteHost, token || null, 'server');
    app.relaunch();
    app.exit(0);
    return { success: true };
  });

  /** Кнопка «Проверить» — та же диагностика, но без переключения режима и перезапуска. */
  ipcMain.handle('settings:diagnoseServer', (_event, { remoteHost, token }) => {
    if (!remoteHost || !remoteHost.includes(':')) {
      return { ok: false, error: 'Укажите адрес сервера в формате ip:порт' };
    }
    return rpcDiagnose(remoteHost, 6000, token || null);
  });

  ipcMain.handle('settings:pingRemoteHost', (_event, remoteHost) => rpcPing(remoteHost, 5000, null, serverToken));

  // Список подключённых клиентов — только для собственного UI хоста (не для сети,
  // поэтому не в RPC_HANDLERS). Раньше хост формально не видел, кто к нему подключён,
  // только раздавал данные по запросу; теперь каждый пинг клиента (см. rpcClient.js/
  // rpcServer.js) обновляет connectedClients, а протухшие (давно не пинговали — скорее
  // всего, клиент закрыт) записи чистятся тут же, при каждом запросе списка.
  ipcMain.handle('settings:getConnectedClients', () => {
    const now = Date.now();
    for (const [id, info] of connectedClients) {
      if (now - info.lastSeenAt > CLIENT_STALE_AFTER_MS) connectedClients.delete(id);
    }
    return [...connectedClients.entries()]
      .map(([clientId, info]) => ({ clientId, hostname: info.hostname, secondsAgo: Math.round((now - info.lastSeenAt) / 1000) }))
      .sort((a, b) => a.hostname.localeCompare(b.hostname));
  });

  // Экстренное отключение клиента — снимает все его блокировки немедленно и не даёт
  // захватить их снова на следующем же heartbeat (см. writeLocks.forceDisconnect).
  // Клиент физически не "разрывается" (это stateless HTTP, разрывать нечего) — просто
  // теряет все свои резервирования и получает об этом честное уведомление в интерфейсе.
  ipcMain.handle('settings:forceDisconnectClient', (_event, clientId) => {
    writeLocks.forceDisconnect(clientId);
    connectedClients.delete(clientId);
    pushLocksStateToHost();
    return { ok: true };
  });
}

/** Пробует открыть БД по сконфигурированному пути в ОТДЕЛЬНОМ процессе с жёстким
 *  таймаутом. Смысл: попытка открыть файл БД по сетевому пути в редких случаях
 *  зависает на уровне ОС (блокирующий syscall, например "наполовину отвалившаяся"
 *  сетевая шара) — обычный JS-таймаут (Promise.race + setTimeout) тут не спасает,
 *  поток всё равно остаётся забит этим вызовом. Спасает только настоящий kill()
 *  процесса — поэтому рискованная часть подключения выполняется в одноразовом,
 *  убиваемом снаружи дочернем процессе (см. db-probe.js), а не в основном процессе
 *  Electron, который иначе завис бы насмерть вместе со всем интерфейсом. */
/** Периодическая проверка связи с хостом (раз в 10 секунд) — единая функция вместо
 *  двух ранее дублировавшихся мест (offline-with-cache и обычное подключение). Помимо
 *  самой связи (см. host-connectivity-changed, было и раньше) теперь ещё:
 *  1) пингует с идентификацией клиента (clientId/hostname) — хост так узнаёт, кто
 *     подключён, см. connectedClients и onClientPing в startRpcServer;
 *  2) пока хост доступен, на каждом тике проверяет журнал (audit_log) на новые записи
 *     с последнего раза и рассылает их в интерфейс событием 'data-changed' — переиспользует
 *     уже существующий журнал изменений вместо отдельного механизма уведомлений. */
let clientHeldKeys = []; // [{type, id}, ...] — то, что клиент СЕЙЧАС держит открытым для редактирования

/** Немедленный запрос на захват конкретного объекта — не дожидаясь фонового
 *  heartbeat-тика (иначе пользователь ждал бы до 10 секунд, чтобы узнать, получил ли
 *  он право редактировать). Переиспользует ту же locks:heartbeat операцию на хосте —
 *  просто вызывает её сразу, с обновлённым списком held keys, вместо ожидания тика. */
async function requestLock(type, id) {
  const remoteHost = getRemoteHost();
  if (!remoteHost) return { ok: false, error: 'Не подключены к хосту' };
  const alreadyHeld = clientHeldKeys.some((k) => k.type === type && k.id === id);
  const nextKeys = alreadyHeld ? clientHeldKeys : [...clientHeldKeys, { type, id }];
  const clientInfo = { clientId: clientInstanceId, hostname: os.hostname() };
  let result;
  try {
    result = await rpcCall(remoteHost, 'locks:heartbeat', { clientId: clientInfo.clientId, hostname: clientInfo.hostname, heldKeys: nextKeys }, 8000, clientInfo, serverToken);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  // Немедленно рассылаем актуальное состояние — иначе визуальный контур занятости
  // (см. isNodeLocked/applyLayerStates в рендерере) появился бы только на следующем
  // фоновом heartbeat-тике (раз в 10 секунд), а не сразу при реальном захвате
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('locks-state-changed', { allowWrites: result.allowWrites, allLocks: result.allLocks || [], acquired: result.acquired || [], rejected: [] });
  }
  if (!result.allowWrites) return { ok: false, error: 'Изменения от клиентов сейчас не разрешены хостом.' };
  const rejected = result.rejected.find((r) => r.type === type && r.id === id);
  if (rejected) {
    return { ok: false, error: `Сейчас редактируется другим клиентом (${rejected.heldBy || '?'})`, heldBy: rejected.heldBy };
  }
  clientHeldKeys = nextKeys; // успешно — запоминаем, чтобы фоновые тики продлевали сами
  return { ok: true, allLocks: result.allLocks };
}

/** Немедленное освобождение — тоже не дожидается фонового тика, чтобы объект стал
 *  доступен другим клиентам сразу после закрытия карточки, а не через 10 секунд.
 *  Best-effort — не блокируем UI на ответ хоста, локальный список уже обновлён. */
function releaseLock(type, id) {
  clientHeldKeys = clientHeldKeys.filter((k) => !(k.type === type && k.id === id));
  const remoteHost = getRemoteHost();
  if (!remoteHost) return;
  const clientInfo = { clientId: clientInstanceId, hostname: os.hostname() };
  rpcCall(remoteHost, 'locks:heartbeat', { clientId: clientInfo.clientId, hostname: clientInfo.hostname, heldKeys: clientHeldKeys }, 5000, clientInfo, serverToken)
    .then((result) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('locks-state-changed', { allowWrites: result.allowWrites, allLocks: result.allLocks || [], acquired: [], rejected: [] });
      }
    })
    .catch(() => {});
}

async function heartbeatTick(remoteHost) {
  const clientInfo = { clientId: clientInstanceId, hostname: os.hostname() };
  const stillAlive = await rpcPing(remoteHost, 5000, clientInfo, serverToken);

  if (stillAlive !== hostReachable) {
    hostReachable = stillAlive;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('host-connectivity-changed', { reachable: hostReachable, remoteHost });
    }
    if (stillAlive) {
      // Только что переподключились — начинаем отслеживать изменения ЗАНОВО с этой
      // точки, а не заваливаем клиента всей историей за время отключения
      try { lastKnownAuditId = await rpcCall(remoteHost, 'auditLog:latestId', null, 5000, clientInfo, serverToken); } catch { /* попробуем на следующем тике */ }
    }
  }

  if (stillAlive && lastKnownAuditId !== null) {
    try {
      const changes = await rpcCall(remoteHost, 'auditLog:listSince', lastKnownAuditId, 5000, clientInfo, serverToken);
      if (changes.length > 0) {
        lastKnownAuditId = changes[changes.length - 1].id;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('data-changed', changes);
        }
      }
    } catch { /* сеть могла на миг подвести именно на этом запросе — попробуем на следующем тике */ }
  }

  if (stillAlive) {
    // Продлеваем то, что реально держим открытым (см. clientHeldKeys/requestLock) —
    // без этого блокировка протухла бы через минуту бездействия, даже если карточка
    // всё ещё открыта. Заодно узнаём актуальный тумблер хоста и список ВСЕХ занятых
    // объектов (не только своих) — интерфейсу нужно показывать, что занято чужим.
    try {
      const locksResult = await rpcCall(remoteHost, 'locks:heartbeat',
        { clientId: clientInfo.clientId, hostname: clientInfo.hostname, heldKeys: clientHeldKeys }, 5000, clientInfo, serverToken);
      if (locksResult.rejected && locksResult.rejected.length > 0) {
        // Что-то из ранее удерживаемого вдруг отклонено (например, хост выключил
        // тумблер посреди сессии) — синхронизируем локальный список под реальность
        const rejectedKeys = new Set(locksResult.rejected.map((r) => `${r.type}:${r.id}`));
        clientHeldKeys = clientHeldKeys.filter((k) => !rejectedKeys.has(`${k.type}:${k.id}`));
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('locks-state-changed', locksResult);
      }
    } catch { /* сеть могла на миг подвести именно на этом запросе — попробуем на следующем тике */ }
  }
}

function startClientHeartbeat(remoteHost) {
  if (connectivityHeartbeatTimer) clearInterval(connectivityHeartbeatTimer);
  heartbeatTick(remoteHost); // немедленно — иначе тумблер/блокировки узнали бы только через 10 секунд
  connectivityHeartbeatTimer = setInterval(() => heartbeatTick(remoteHost), 10000);
}

function probeDbConnection(userDataPath, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const child = fork(path.join(__dirname, 'db-probe.js'), [userDataPath], { stdio: 'ignore' });
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      try { child.kill(); } catch { /* уже мог завершиться сам */ }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: 'Не удалось подключиться за отведённое время (' + Math.round(timeoutMs / 1000) +
          ' сек) — сетевой путь недоступен или завис на уровне системы.'
      });
    }, timeoutMs);

    child.on('message', (msg) => finish(msg));
    child.on('error', (err) => finish({ ok: false, error: err.message }));
    child.on('exit', (code) => {
      if (!settled) finish({ ok: false, error: `Процесс проверки подключения неожиданно завершился (код ${code}).` });
    });
  });
}

app.whenReady().then(async () => {
  const mode = getAppMode();

  if (mode === 'client') {
    // Клиент свою БД не открывает вообще — только проверяем, что хост сейчас отвечает
    // (это обычный сетевой сокет с таймаутом, а не блокирующий файловый syscall — здесь
    // штатный JS-таймаут внутри rpcPing вполне безопасен, child-процесс не нужен)
    initLocalCache(app.getPath('userData'));
    const remoteHost = getRemoteHost();
    const clientInfo = { clientId: clientInstanceId, hostname: os.hostname() };
    const alive = remoteHost ? await rpcPing(remoteHost, 6000, clientInfo, serverToken) : false;
    if (!alive && hasAnyCache()) {
      // Хост недоступен ПРЯМО СЕЙЧАС, но раньше уже был доступен — есть что показать.
      // Раньше в этой ситуации откатывались на заведомо ПУСТУЮ локальную БД, будто
      // никаких данных никогда не было. Теперь остаёмся в клиентском режиме "оффлайн":
      // все read-запросы отдадут последний закэшированный ответ (см. registerIpcHandlers),
      // а heartbeat продолжает пытаться переподключиться в фоне.
      startupNotice = `Не удалось связаться с хостом ${remoteHost} прямо сейчас. Показаны последние ` +
        'сохранённые данные (могут быть устаревшими) — приложение продолжит пытаться подключиться в фоне.';
      hostReachable = false;
      startClientHeartbeat(remoteHost);
    } else if (!alive) {
      // Хост недоступен, и показать нечего (кэша ещё никогда не было — самый первый
      // запуск в режиме клиента застал хост уже недоступным) — только тогда откатываемся
      // на обычный локальный режим, как и раньше.
      startupNotice = (remoteHost ? `Не удалось связаться с хостом ${remoteHost}.` : 'Адрес хоста не настроен.') +
        ' Локальных сохранённых данных тоже нет (первое подключение). Открыта локальная копия базы данных.';
      setConfiguredDbPath(null); // откат на обычный локальный режим
      initDatabase();
    } else {
      // Хост жив — initDatabase() НЕ вызывается вообще, все запросы уйдут по сети.
      hostReachable = true;
      try { lastKnownAuditId = await rpcCall(remoteHost, 'auditLog:latestId', null, 6000, clientInfo, serverToken); } catch { /* не критично — просто начнём отслеживать со следующего тика */ }
      startClientHeartbeat(remoteHost);
    }
  } else {
    const configuredPath = getConfiguredDbPath();
    if (configuredPath) {
      // Сетевой путь настроен (или режим "хост" со своим путём) — сначала проверяем
      // в одноразовом убиваемом процессе, а не открываем напрямую в основном процессе
      const probe = await probeDbConnection(app.getPath('userData'));
      if (!probe.ok) {
        startupNotice = `Не удалось подключиться к базе данных по пути ${configuredPath}: ${probe.error} ` +
          'Открыта локальная копия по умолчанию.';
        initDatabase(getDefaultDbPath());
      } else {
        initDatabase();
      }
    } else {
      initDatabase();
    }

    // Замок на базу могли отобрать уже ПОСЛЕ открытия: машину усыпляли, шара пропадала
    // дольше таймаута — и другой экземпляр решил, что мы пропали, и занял базу. Писать
    // с этого момента нельзя (иначе две пишущие копии), но читать уже открытым
    // соединением безопасно, поэтому просто переходим в режим только чтения на ходу.
    dbLock.onLockLost((holder) => {
      const where = holder && holder.hostname ? `«${holder.hostname}»` : 'другим экземпляром';
      markReadonly(holder, `База перехвачена ${where}, пока это приложение было неактивно`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('db-readonly-changed', getDbReadonly());
      }
    });

    if (mode === 'host') {
      try {
        hostLastNotifiedAuditId = auditLogRepo.latestId(); // точка отсчёта сразу — далее синхронизируется на лету после каждого локального действия хоста (см. ветку local/host ниже), поэтому первая же запись клиента покажет только её саму, а не накопленную локальную историю
        rpcServerInstance = await startRpcServer(getHostPort(), RPC_HANDLERS, {
          // У режима "хост" ключа доступа нет: хост поднимается на время работы
          // приложения и ищется маячком в своей же сети. Ключ — свойство выделенного
          // сервера, который доступен постоянно (см. server/index.js).
          onClientPing: (clientId, hostname) => {
            connectedClients.set(clientId, { hostname, lastSeenAt: Date.now() });
          },
          authorizeWrite,
          onWriteSuccess: notifyHostOfClientWrite
        });

        const discoveryPath = getDiscoveryPath();
        if (discoveryPath) {
          try {
            // Best-effort уборка протухших ЧУЖИХ маячков (от давно упавших хостов) —
            // если удалить какой-то не получится (см. discovery.js — типичная ситуация
            // на сетевых шарах с ACL "менять/удалять может только создатель файла"),
            // это не страшно и не мешает публикации СВОЕГО маячка ниже — просто останется
            // висеть как явно "протухший" при следующем сканировании папки.
            cleanupStaleMarkersInDir(discoveryPath, null);
            ownMarkerPath = publishHostMarker(discoveryPath, getHostPort());
            // Heartbeat — обновляем метку времени в СВОЁМ файле (не создаём новый каждый
            // раз), чтобы клиенты могли отличить "хост сейчас реально работает" от
            // "маячок остался от давно закрытого хоста"
            discoveryHeartbeatTimer = setInterval(() => {
              try { updateHostMarker(ownMarkerPath, getHostPort()); } catch { /* сеть могла на миг пропасть — не критично, попробуем на следующем тике */ }
            }, 20000);
          } catch (err) {
            startupNotice = `Не удалось опубликовать адрес хоста (папка ${discoveryPath}): ${err.message} ` +
              'Общий доступ по прямому адресу продолжает работать, просто автоматическая подсказка адреса не опубликована.';
          }
        }
      } catch (err) {
        startupNotice = `Не удалось запустить общий доступ — порт ${getHostPort()} занят или недоступен: ${err.message} ` +
          'Приложение продолжит работать локально, но другие компьютеры не смогут подключиться.';
      }
    }
  }

  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Выход может произойти и без закрытия окон (app.quit() из меню, выключение системы) —
// замок надо снять в обоих случаях, иначе база останется "занятой" до истечения таймаута
app.on('will-quit', () => { releaseDbLock(); });

app.on('window-all-closed', () => {
  if (rpcServerInstance) { try { rpcServerInstance.close(); } catch { /* уже могло закрыться */ } }
  if (discoveryHeartbeatTimer) clearInterval(discoveryHeartbeatTimer);
  if (connectivityHeartbeatTimer) clearInterval(connectivityHeartbeatTimer);
  forceFlush(); // последние секунды кэша могли ещё не долететь до диска по дебаунсу
  releaseDbLock(); // снимаем свой файл-замок, чтобы база сразу освободилась для коллег
  if (ownMarkerPath) removeHostMarker(ownMarkerPath); // штатный выход — убираем ТОЛЬКО свой маячок, не чужие
  if (getAppMode() === 'client' && clientHeldKeys.length > 0) {
    // Best-effort — не ждём ответа и не блокируем выход; если не успеет долететь,
    // блокировки всё равно сами протухнут на хосте через минуту бездействия
    const remoteHost = getRemoteHost();
    if (remoteHost) {
      const clientInfo = { clientId: clientInstanceId, hostname: os.hostname() };
      rpcCall(remoteHost, 'locks:heartbeat', { clientId: clientInfo.clientId, hostname: clientInfo.hostname, heldKeys: [] }, 2000, clientInfo, serverToken).catch(() => {});
    }
  }
  if (process.platform !== 'darwin') app.quit();
});
