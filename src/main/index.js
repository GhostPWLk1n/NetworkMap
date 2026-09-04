const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { fork } = require('child_process');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const {
  initDatabase, usersRepo, devicesRepo, pingRepo, floorPlansRepo, planItemsRepo, cablesRepo, cableConnectionsRepo,
  ownershipRepo, componentsRepo, peripheralsRepo, softwareRepo, warehouseRepo, zonesRepo, networkRepo, auditLogRepo,
  getDefaultDbPath, getCurrentDbPath, getLastConnectWarning, setConfiguredDbPath, getConfiguredDbPath,
  getAppMode, getHostPort, getRemoteHost, setHostMode, setClientMode, getDiscoveryPath
} = require('./db');
const { pingHost } = require('./ping');
const { importExcel } = require('./import');
const { parsePcInfoFile, parsePcInfoFolder, applyPcInfoImport } = require('./pcInfoImport');
const { startRpcServer } = require('./rpcServer');
const { rpcCall, rpcPing } = require('./rpcClient');
const { publishHostMarker, updateHostMarker, removeHostMarker, readHostMarker, findActiveMarkersInDir, cleanupStaleMarkersInDir } = require('./discovery');
const { initLocalCache, saveToCache, readFromCache, hasAnyCache, forceFlush } = require('./localCache');

let mainWindow;
let rpcServerInstance = null; // держим ссылку, чтобы можно было закрыть порт при выходе
let discoveryHeartbeatTimer = null;
let ownMarkerPath = null; // путь к СВОЕМУ файлу-маячку (см. discovery.js) — heartbeat/удаление трогают только его
let connectivityHeartbeatTimer = null; // клиентский режим — периодическая проверка связи с хостом
// Клиентский режим: собственный id этого инстанса (на всю сессию, не хранится между
// перезапусками — при следующем запуске сгенерируется новый) — чтобы хост видел, что
// это тот же самый клиент, а не новый, если несколько раз пинганёт за одну сессию.
const clientInstanceId = crypto.randomUUID();
let lastKnownAuditId = null; // с какого id отслеживаем новые записи журнала — сбрасывается при (пере)подключении
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
const RPC_HANDLERS = {
  'users:list': { write: false, fn: () => usersRepo.list() },
  'users:create': { write: true, fn: (payload) => usersRepo.create(payload) },
  'users:update': { write: true, fn: ({ id, payload }) => usersRepo.update(id, payload) },
  'users:setStatus': { write: true, fn: ({ id, status }) => usersRepo.setStatus(id, status) },
  'users:setFlag': { write: true, fn: ({ id, flag }) => usersRepo.setFlag(id, flag) },
  'users:remove': { write: true, fn: (id) => usersRepo.remove(id) },

  'devices:list': { write: false, fn: () => devicesRepo.list() },
  'devices:create': { write: true, fn: (payload) => devicesRepo.create(payload) },
  'devices:update': { write: true, fn: ({ id, payload }) => devicesRepo.update(id, payload) },
  'devices:setStatus': { write: true, fn: ({ id, status, note }) => devicesRepo.setStatus(id, status, note) },
  'devices:setFlag': { write: true, fn: ({ id, flag }) => devicesRepo.setFlag(id, flag) },
  'devices:setUplink': { write: true, fn: ({ id, uplinkDeviceId }) => devicesRepo.setUplink(id, uplinkDeviceId) },
  'devices:statusHistory': { write: false, fn: (id) => devicesRepo.statusHistory(id) },
  'devices:listVMsByHost': { write: false, fn: (hostDeviceId) => devicesRepo.listVMsByHost(hostDeviceId) },
  'devices:remove': { write: true, fn: (id) => devicesRepo.remove(id) },
  'devices:search': { write: false, fn: (query) => devicesRepo.search(query) },

  'ping:run': {
    write: true,
    fn: async ({ deviceId, ip }) => {
      const result = await pingHost(ip);
      pingRepo.record(deviceId, result.status, result.responseTimeMs);
      return result;
    }
  },
  'ping:history': { write: false, fn: (deviceId) => pingRepo.history(deviceId) },

  'floorPlans:list': { write: false, fn: () => floorPlansRepo.list() },
  'floorPlans:ensureDefault': { write: true, fn: () => floorPlansRepo.ensureDefault() },
  'floorPlans:create': { write: true, fn: (payload) => floorPlansRepo.create(payload) },
  'floorPlans:remove': { write: true, fn: (id) => floorPlansRepo.remove(id) },
  'floorPlans:rename': { write: true, fn: ({ id, name }) => floorPlansRepo.rename(id, name) },

  'planItems:list': { write: false, fn: (floorPlanId) => planItemsRepo.listByPlan(floorPlanId) },
  'planItems:create': { write: true, fn: (payload) => planItemsRepo.create(payload) },
  'planItems:move': { write: true, fn: ({ id, x, y }) => planItemsRepo.move(id, x, y) },
  'planItems:setRotation': { write: true, fn: ({ id, rotation }) => planItemsRepo.setRotation(id, rotation) },
  'planItems:remove': { write: true, fn: (id) => planItemsRepo.remove(id) },
  'planItems:findByDeviceRef': { write: false, fn: (deviceId) => planItemsRepo.findByDeviceRef(deviceId) },
  'planItems:listPlacedDeviceIds': { write: false, fn: () => planItemsRepo.listPlacedDeviceIds() },
  'planItems:listAllDevicePlacements': { write: false, fn: () => planItemsRepo.listAllDevicePlacements() },
  'planItems:setReviewNote': { write: true, fn: ({ id, note }) => planItemsRepo.setReviewNote(id, note) },
  'planItems:setNetworkRole': { write: true, fn: ({ id, role }) => planItemsRepo.setNetworkRole(id, role) },
  'planItems:placeDeviceWithGrouping': { write: true, fn: ({ floorPlanId, deviceId, x, y }) => planItemsRepo.placeDeviceWithGrouping(floorPlanId, deviceId, x, y) },
  'planItems:moveDeviceItemWithGrouping': { write: true, fn: ({ oldItemId, floorPlanId, deviceId, x, y }) => planItemsRepo.moveDeviceItemWithGrouping(oldItemId, floorPlanId, deviceId, x, y) },
  'planItems:groupMembers': { write: false, fn: (groupItemId) => planItemsRepo.groupMembers(groupItemId) },
  'planItems:removeFromGroup': { write: true, fn: ({ groupItemId, deviceId }) => planItemsRepo.removeFromGroup(groupItemId, deviceId) },
  'planItems:renameGroup': { write: true, fn: ({ groupItemId, label }) => planItemsRepo.renameGroup(groupItemId, label) },

  'cables:list': { write: false, fn: (floorPlanId) => cablesRepo.listByPlan(floorPlanId) },
  'cables:get': { write: false, fn: (id) => cablesRepo.get(id) },
  'cables:create': { write: true, fn: (payload) => cablesRepo.create(payload) },
  'cables:updatePath': { write: true, fn: ({ id, path: p }) => cablesRepo.updatePath(id, p) },
  'cables:setLabel': { write: true, fn: ({ id, label }) => cablesRepo.setLabel(id, label) },
  'cables:remove': { write: true, fn: (id) => cablesRepo.remove(id) },

  'cableConnections:listByPlan': { write: false, fn: (floorPlanId) => cableConnectionsRepo.listByPlan(floorPlanId) },
  'cableConnections:listByPlanItem': { write: false, fn: (planItemId) => cableConnectionsRepo.listByPlanItem(planItemId) },
  'cableConnections:connect': { write: true, fn: ({ planItemId, cableId }) => cableConnectionsRepo.connect(planItemId, cableId) },
  'cableConnections:disconnect': { write: true, fn: ({ planItemId, cableId }) => cableConnectionsRepo.disconnect(planItemId, cableId) },

  'ownership:history': { write: false, fn: (deviceId) => ownershipRepo.history(deviceId) },
  'ownership:historyForUser': { write: false, fn: (userId) => ownershipRepo.historyForUser(userId) },
  'ownership:assign': { write: true, fn: ({ deviceId, userId }) => ownershipRepo.assign(deviceId, userId) },
  'ownership:unassign': { write: true, fn: (deviceId) => ownershipRepo.unassign(deviceId) },

  'components:list': { write: false, fn: (deviceId) => componentsRepo.listByDevice(deviceId) },
  'components:listAllActive': { write: false, fn: () => componentsRepo.listAllActive() },
  'components:add': { write: true, fn: (payload) => componentsRepo.add(payload) },
  'components:detach': { write: true, fn: (id) => componentsRepo.detach(id) },
  'components:remove': { write: true, fn: (id) => componentsRepo.remove(id) },

  'peripherals:list': { write: false, fn: (deviceId) => peripheralsRepo.listByDevice(deviceId) },
  'peripherals:listAllActive': { write: false, fn: () => peripheralsRepo.listAllActive() },
  'peripherals:add': { write: true, fn: (payload) => peripheralsRepo.add(payload) },
  'peripherals:detach': { write: true, fn: (id) => peripheralsRepo.detach(id) },
  'peripherals:remove': { write: true, fn: (id) => peripheralsRepo.remove(id) },

  'software:list': { write: false, fn: (deviceId) => softwareRepo.listByDevice(deviceId) },
  'software:listActive': { write: false, fn: () => softwareRepo.listActive() },
  'software:add': { write: true, fn: (payload) => softwareRepo.add(payload) },
  'software:remove': { write: true, fn: (id) => softwareRepo.remove(id) },
  'software:setFlag': { write: true, fn: ({ id, flag }) => softwareRepo.setFlag(id, flag) },

  'warehouse:list': { write: false, fn: (category) => warehouseRepo.list(category) },
  'warehouse:add': { write: true, fn: (payload) => warehouseRepo.add(payload) },
  'warehouse:update': { write: true, fn: ({ id, payload }) => warehouseRepo.update(id, payload) },
  'warehouse:setStatus': { write: true, fn: ({ id, status }) => warehouseRepo.setStatus(id, status) },
  'warehouse:setFlag': { write: true, fn: ({ id, flag }) => warehouseRepo.setFlag(id, flag) },
  'warehouse:receiveComponent': { write: true, fn: ({ componentId, note }) => warehouseRepo.receiveComponent(componentId, note) },
  'warehouse:receiveSoftware': { write: true, fn: ({ softwareId, note }) => warehouseRepo.receiveSoftware(softwareId, note) },
  'warehouse:issueToDevice': { write: true, fn: ({ itemId, deviceId }) => warehouseRepo.issueToDevice(itemId, deviceId) },
  'warehouse:remove': { write: true, fn: (id) => warehouseRepo.remove(id) },

  'zones:list': { write: false, fn: (floorPlanId) => zonesRepo.listByPlan(floorPlanId) },
  'zones:create': { write: true, fn: (payload) => zonesRepo.create(payload) },
  'zones:updateLabel': { write: true, fn: ({ id, payload }) => zonesRepo.updateLabel(id, payload) },
  'zones:remove': { write: true, fn: (id) => zonesRepo.remove(id) },

  'network:listRoots': { write: false, fn: () => networkRepo.listRoots() },
  'network:buildTree': { write: false, fn: (rootDeviceId) => networkRepo.buildTree(rootDeviceId) },

  'auditLog:list': { write: false, fn: (filters) => auditLogRepo.list(filters) },
  'auditLog:listSince': { write: false, fn: (sinceId) => auditLogRepo.listSince(sinceId) },
  'auditLog:latestId': { write: false, fn: () => auditLogRepo.latestId() }
};

const CLIENT_MODE_IMPORT_ERROR = 'Импорт недоступен в режиме клиента — выполните его на компьютере-хосте, у которого есть прямой доступ к базе.';

function registerIpcHandlers() {
  const mode = getAppMode();

  ipcMain.handle('app:version', () => app.getVersion());

  if (mode === 'client') {
    const remoteHost = getRemoteHost();
    Object.entries(RPC_HANDLERS).forEach(([channel, { write, fn }]) => {
      ipcMain.handle(channel, async (_event, payload) => {
        if (write) {
          throw new Error('Только просмотр — вы подключены как клиент к общему хосту, редактирование недоступно в этом режиме.');
        }
        try {
          const result = await rpcCall(remoteHost, channel, payload);
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
  } else {
    // local ИЛИ host — как раньше, прямые вызовы репозиториев
    Object.entries(RPC_HANDLERS).forEach(([channel, { fn }]) => {
      ipcMain.handle(channel, (_event, payload) => fn(payload));
    });

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
      hostReachable: mode === 'client' ? hostReachable : null,
      startupNotice: notice,
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
    const alive = await rpcPing(remoteHost, 6000);
    if (!alive) {
      return { success: false, error: `Хост ${remoteHost} не отвечает. Проверьте адрес, порт и что на хосте запущен режим "хост".` };
    }
    setClientMode(remoteHost);
    app.relaunch();
    app.exit(0);
    return { success: true };
  });

  ipcMain.handle('settings:pingRemoteHost', (_event, remoteHost) => rpcPing(remoteHost, 5000));

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
    return [...connectedClients.values()]
      .map((info) => ({ hostname: info.hostname, secondsAgo: Math.round((now - info.lastSeenAt) / 1000) }))
      .sort((a, b) => a.hostname.localeCompare(b.hostname));
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
function startClientHeartbeat(remoteHost) {
  if (connectivityHeartbeatTimer) clearInterval(connectivityHeartbeatTimer);
  connectivityHeartbeatTimer = setInterval(async () => {
    const clientInfo = { clientId: clientInstanceId, hostname: os.hostname() };
    const stillAlive = await rpcPing(remoteHost, 5000, clientInfo);

    if (stillAlive !== hostReachable) {
      hostReachable = stillAlive;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('host-connectivity-changed', { reachable: hostReachable, remoteHost });
      }
      if (stillAlive) {
        // Только что переподключились — начинаем отслеживать изменения ЗАНОВО с этой
        // точки, а не заваливаем клиента всей историей за время отключения
        try { lastKnownAuditId = await rpcCall(remoteHost, 'auditLog:latestId', null, 5000); } catch { /* попробуем на следующем тике */ }
      }
    }

    if (stillAlive && lastKnownAuditId !== null) {
      try {
        const changes = await rpcCall(remoteHost, 'auditLog:listSince', lastKnownAuditId, 5000);
        if (changes.length > 0) {
          lastKnownAuditId = changes[changes.length - 1].id;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('data-changed', changes);
          }
        }
      } catch { /* сеть могла на миг подвести именно на этом запросе — попробуем на следующем тике */ }
    }
  }, 10000);
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
    const alive = remoteHost ? await rpcPing(remoteHost, 6000, clientInfo) : false;
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
      try { lastKnownAuditId = await rpcCall(remoteHost, 'auditLog:latestId', null, 6000); } catch { /* не критично — просто начнём отслеживать со следующего тика */ }
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

    if (mode === 'host') {
      try {
        rpcServerInstance = await startRpcServer(getHostPort(), RPC_HANDLERS, (clientId, hostname) => {
          connectedClients.set(clientId, { hostname, lastSeenAt: Date.now() });
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

app.on('window-all-closed', () => {
  if (rpcServerInstance) { try { rpcServerInstance.close(); } catch { /* уже могло закрыться */ } }
  if (discoveryHeartbeatTimer) clearInterval(discoveryHeartbeatTimer);
  if (connectivityHeartbeatTimer) clearInterval(connectivityHeartbeatTimer);
  forceFlush(); // последние секунды кэша могли ещё не долететь до диска по дебаунсу
  if (ownMarkerPath) removeHostMarker(ownMarkerPath); // штатный выход — убираем ТОЛЬКО свой маячок, не чужие
  if (process.platform !== 'darwin') app.quit();
});
