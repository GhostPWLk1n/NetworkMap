const path = require('path');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const {
  initDatabase, usersRepo, devicesRepo, pingRepo, floorPlansRepo, planItemsRepo, cablesRepo, cableConnectionsRepo,
  ownershipRepo, componentsRepo, peripheralsRepo, softwareRepo, warehouseRepo, zonesRepo, networkRepo, auditLogRepo,
  getDefaultDbPath, getCurrentDbPath, getLastConnectWarning, setConfiguredDbPath
} = require('./db');
const { pingHost } = require('./ping');
const { importExcel } = require('./import');
const { parsePcInfoFile, parsePcInfoFolder, applyPcInfoImport } = require('./pcInfoImport');

let mainWindow;

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

function registerIpcHandlers() {
  // --- приложение ---
  ipcMain.handle('app:version', () => app.getVersion());

  // --- users ---
  ipcMain.handle('users:list', () => usersRepo.list());
  ipcMain.handle('users:create', (_event, payload) => usersRepo.create(payload));
  ipcMain.handle('users:update', (_event, { id, payload }) => usersRepo.update(id, payload));
  ipcMain.handle('users:setStatus', (_event, { id, status }) => usersRepo.setStatus(id, status));
  ipcMain.handle('users:setFlag', (_event, { id, flag }) => usersRepo.setFlag(id, flag));
  ipcMain.handle('users:remove', (_event, id) => usersRepo.remove(id));

  // --- devices ---
  ipcMain.handle('devices:list', () => devicesRepo.list());
  ipcMain.handle('devices:create', (_event, payload) => devicesRepo.create(payload));
  ipcMain.handle('devices:update', (_event, { id, payload }) => devicesRepo.update(id, payload));
  ipcMain.handle('devices:setStatus', (_event, { id, status, note }) => devicesRepo.setStatus(id, status, note));
  ipcMain.handle('devices:setFlag', (_event, { id, flag }) => devicesRepo.setFlag(id, flag));
  ipcMain.handle('devices:setUplink', (_event, { id, uplinkDeviceId }) => devicesRepo.setUplink(id, uplinkDeviceId));
  ipcMain.handle('devices:statusHistory', (_event, id) => devicesRepo.statusHistory(id));
  ipcMain.handle('devices:remove', (_event, id) => devicesRepo.remove(id));
  ipcMain.handle('devices:search', (_event, query) => devicesRepo.search(query));

  // --- ping ---
  ipcMain.handle('ping:run', async (_event, { deviceId, ip }) => {
    const result = await pingHost(ip);
    pingRepo.record(deviceId, result.status, result.responseTimeMs);
    return result;
  });
  ipcMain.handle('ping:history', (_event, deviceId) => pingRepo.history(deviceId));

  // --- floor plans ---
  ipcMain.handle('floorPlans:list', () => floorPlansRepo.list());
  ipcMain.handle('floorPlans:ensureDefault', () => floorPlansRepo.ensureDefault());
  ipcMain.handle('floorPlans:create', (_event, payload) => floorPlansRepo.create(payload));
  ipcMain.handle('floorPlans:remove', (_event, id) => floorPlansRepo.remove(id));
  ipcMain.handle('floorPlans:rename', (_event, { id, name }) => floorPlansRepo.rename(id, name));

  // --- plan items ---
  ipcMain.handle('planItems:list', (_event, floorPlanId) => planItemsRepo.listByPlan(floorPlanId));
  ipcMain.handle('planItems:create', (_event, payload) => planItemsRepo.create(payload));
  ipcMain.handle('planItems:move', (_event, { id, x, y }) => planItemsRepo.move(id, x, y));
  ipcMain.handle('planItems:setRotation', (_event, { id, rotation }) => planItemsRepo.setRotation(id, rotation));
  ipcMain.handle('planItems:remove', (_event, id) => planItemsRepo.remove(id));
  ipcMain.handle('planItems:findByDeviceRef', (_event, deviceId) => planItemsRepo.findByDeviceRef(deviceId));
  ipcMain.handle('planItems:listPlacedDeviceIds', () => planItemsRepo.listPlacedDeviceIds());
  ipcMain.handle('planItems:setReviewNote', (_event, { id, note }) => planItemsRepo.setReviewNote(id, note));
  ipcMain.handle('planItems:setNetworkRole', (_event, { id, role }) => planItemsRepo.setNetworkRole(id, role));

  // --- cables ---
  ipcMain.handle('cables:list', (_event, floorPlanId) => cablesRepo.listByPlan(floorPlanId));
  ipcMain.handle('cables:get', (_event, id) => cablesRepo.get(id));
  ipcMain.handle('cables:create', (_event, payload) => cablesRepo.create(payload));
  ipcMain.handle('cables:updatePath', (_event, { id, path }) => cablesRepo.updatePath(id, path));
  ipcMain.handle('cables:setLabel', (_event, { id, label }) => cablesRepo.setLabel(id, label));
  ipcMain.handle('cables:remove', (_event, id) => cablesRepo.remove(id));

  // --- подключения устройств к кабелям (многие-ко-многим; правило "один/несколько" внутри репозитория) ---
  ipcMain.handle('cableConnections:listByPlan', (_event, floorPlanId) => cableConnectionsRepo.listByPlan(floorPlanId));
  ipcMain.handle('cableConnections:listByPlanItem', (_event, planItemId) => cableConnectionsRepo.listByPlanItem(planItemId));
  ipcMain.handle('cableConnections:connect', (_event, { planItemId, cableId }) => cableConnectionsRepo.connect(planItemId, cableId));
  ipcMain.handle('cableConnections:disconnect', (_event, { planItemId, cableId }) => cableConnectionsRepo.disconnect(planItemId, cableId));

  // --- владение устройством (закрепление пользователя + история) ---
  ipcMain.handle('ownership:history', (_event, deviceId) => ownershipRepo.history(deviceId));
  ipcMain.handle('ownership:historyForUser', (_event, userId) => ownershipRepo.historyForUser(userId));
  ipcMain.handle('ownership:assign', (_event, { deviceId, userId }) => ownershipRepo.assign(deviceId, userId));
  ipcMain.handle('ownership:unassign', (_event, deviceId) => ownershipRepo.unassign(deviceId));

  // --- комплектующие ---
  ipcMain.handle('components:list', (_event, deviceId) => componentsRepo.listByDevice(deviceId));
  ipcMain.handle('components:listAllActive', () => componentsRepo.listAllActive());
  ipcMain.handle('components:add', (_event, payload) => componentsRepo.add(payload));
  ipcMain.handle('components:detach', (_event, id) => componentsRepo.detach(id));
  ipcMain.handle('components:remove', (_event, id) => componentsRepo.remove(id));

  // --- периферия ---
  ipcMain.handle('peripherals:list', (_event, deviceId) => peripheralsRepo.listByDevice(deviceId));
  ipcMain.handle('peripherals:listAllActive', () => peripheralsRepo.listAllActive());
  ipcMain.handle('peripherals:add', (_event, payload) => peripheralsRepo.add(payload));
  ipcMain.handle('peripherals:detach', (_event, id) => peripheralsRepo.detach(id));
  ipcMain.handle('peripherals:remove', (_event, id) => peripheralsRepo.remove(id));

  // --- ПО на устройствах ---
  ipcMain.handle('software:list', (_event, deviceId) => softwareRepo.listByDevice(deviceId));
  ipcMain.handle('software:listActive', () => softwareRepo.listActive());
  ipcMain.handle('software:add', (_event, payload) => softwareRepo.add(payload));
  ipcMain.handle('software:remove', (_event, id) => softwareRepo.remove(id));
  ipcMain.handle('software:setFlag', (_event, { id, flag }) => softwareRepo.setFlag(id, flag));

  // --- склад ---
  ipcMain.handle('warehouse:list', (_event, category) => warehouseRepo.list(category));
  ipcMain.handle('warehouse:add', (_event, payload) => warehouseRepo.add(payload));
  ipcMain.handle('warehouse:update', (_event, { id, payload }) => warehouseRepo.update(id, payload));
  ipcMain.handle('warehouse:setStatus', (_event, { id, status }) => warehouseRepo.setStatus(id, status));
  ipcMain.handle('warehouse:setFlag', (_event, { id, flag }) => warehouseRepo.setFlag(id, flag));
  ipcMain.handle('warehouse:receiveComponent', (_event, { componentId, note }) => warehouseRepo.receiveComponent(componentId, note));
  ipcMain.handle('warehouse:receiveSoftware', (_event, { softwareId, note }) => warehouseRepo.receiveSoftware(softwareId, note));
  ipcMain.handle('warehouse:issueToDevice', (_event, { itemId, deviceId }) => warehouseRepo.issueToDevice(itemId, deviceId));
  ipcMain.handle('warehouse:remove', (_event, id) => warehouseRepo.remove(id));

  // --- зоны на плане ---
  ipcMain.handle('zones:list', (_event, floorPlanId) => zonesRepo.listByPlan(floorPlanId));
  ipcMain.handle('zones:create', (_event, payload) => zonesRepo.create(payload));
  ipcMain.handle('zones:updateLabel', (_event, { id, payload }) => zonesRepo.updateLabel(id, payload));
  ipcMain.handle('zones:remove', (_event, id) => zonesRepo.remove(id));

  ipcMain.handle('network:listRoots', () => networkRepo.listRoots());
  ipcMain.handle('network:buildTree', (_event, rootDeviceId) => networkRepo.buildTree(rootDeviceId));

  ipcMain.handle('auditLog:list', (_event, filters) => auditLogRepo.list(filters));

  // --- импорт из Excel ---
  ipcMain.handle('import:excelDevices', async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Выберите файл со списком ПК',
      filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }],
      properties: ['openFile']
    });
    if (picked.canceled || picked.filePaths.length === 0) return null;
    return importExcel(picked.filePaths[0]);
  });

  // --- импорт сведений о ПК из JSON-файлов, собранных scripts/collect-pc-info.ps1 ---
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

  // --- подключение к базе данных (локальный файл или сетевой путь, напр. шара из Docker) ---
  ipcMain.handle('settings:getDbInfo', () => ({
    path: getCurrentDbPath(),
    isDefault: getCurrentDbPath() === getDefaultDbPath(),
    warning: getLastConnectWarning()
  }));

  ipcMain.handle('settings:pickExistingDbFile', async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Выберите файл базы данных (data.db)',
      filters: [{ name: 'SQLite DB', extensions: ['db', 'sqlite', 'sqlite3'] }],
      properties: ['openFile']
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
    try {
      const testDb = new (require('better-sqlite3'))(dbPath);
      testDb.close();
    } catch (err) {
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
}

app.whenReady().then(() => {
  initDatabase();
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
