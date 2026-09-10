const { contextBridge, ipcRenderer } = require('electron');

/** Обёртка над ipcRenderer.invoke — при ЛЮБОЙ ошибке (в т.ч. сетевой, когда хост
 *  недоступен в режиме клиента) дополнительно рассылает событие 'api-error' в основной
 *  мир страницы, чтобы можно было показать понятное уведомление, не переписывая все
 *  ~90 мест вызова по отдельности — единая точка перехвата. Исходное исключение
 *  пробрасывается дальше как обычно: вызывающий код, у которого уже есть собственная
 *  обработка (например, в потоках импорта), продолжает работать точно так же, как раньше. */
async function invoke(channel, ...args) {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (err) {
    window.dispatchEvent(new CustomEvent('api-error', { detail: { channel, message: err.message || String(err) } }));
    throw err;
  }
}

contextBridge.exposeInMainWorld('api', {
  app: {
    version: () => invoke('app:version')
  },
  settings: {
    getDbInfo: () => invoke('settings:getDbInfo'),
    pickExistingDbFile: () => invoke('settings:pickExistingDbFile'),
    pickDiscoveryFolder: () => invoke('settings:pickDiscoveryFolder'),
    pickNewDbLocation: () => invoke('settings:pickNewDbLocation'),
    connectDb: (dbPath) => invoke('settings:connectDb', dbPath),
    resetDb: () => invoke('settings:resetDb'),
    setHostMode: (dbPath, hostPort, discoveryPath) => invoke('settings:setHostMode', { dbPath, hostPort, discoveryPath }),
    setClientMode: (remoteHost) => invoke('settings:setClientMode', remoteHost),
    pingRemoteHost: (remoteHost) => invoke('settings:pingRemoteHost', remoteHost),
    getConnectedClients: () => invoke('settings:getConnectedClients'),
    getAllowClientWrites: () => invoke('settings:getAllowClientWrites'),
    setAllowClientWrites: (allow) => invoke('settings:setAllowClientWrites', allow)
  },
  locks: {
    /** Запрос права редактировать конкретный объект — модель "взялся — ходи".
     *  type: 'device' | 'plan_item'. Возвращает { ok, error?, heldBy?, allLocks? }. */
    request: (type, id) => invoke('locks:requestLock', { type, id }),
    release: (type, id) => invoke('locks:releaseLock', { type, id })
  },
  users: {
    list: () => invoke('users:list'),
    create: (payload) => invoke('users:create', payload),
    update: (id, payload) => invoke('users:update', { id, payload }),
    setStatus: (id, status) => invoke('users:setStatus', { id, status }),
    setFlag: (id, flag) => invoke('users:setFlag', { id, flag }),
    remove: (id) => invoke('users:remove', id)
  },
  devices: {
    list: () => invoke('devices:list'),
    create: (payload) => invoke('devices:create', payload),
    update: (id, payload) => invoke('devices:update', { id, payload }),
    setStatus: (id, status, note) => invoke('devices:setStatus', { id, status, note }),
    setFlag: (id, flag) => invoke('devices:setFlag', { id, flag }),
    setUplink: (id, uplinkDeviceId) => invoke('devices:setUplink', { id, uplinkDeviceId }),
    statusHistory: (id) => invoke('devices:statusHistory', id),
    listVMsByHost: (hostDeviceId) => invoke('devices:listVMsByHost', hostDeviceId),
    remove: (id) => invoke('devices:remove', id),
    search: (query) => invoke('devices:search', query)
  },
  ping: {
    run: (deviceId, ip) => invoke('ping:run', { deviceId, ip }),
    history: (deviceId) => invoke('ping:history', deviceId)
  },
  floorPlans: {
    list: () => invoke('floorPlans:list'),
    ensureDefault: () => invoke('floorPlans:ensureDefault'),
    create: (payload) => invoke('floorPlans:create', payload),
    remove: (id) => invoke('floorPlans:remove', id),
    rename: (id, name) => invoke('floorPlans:rename', { id, name })
  },
  planItems: {
    list: (floorPlanId) => invoke('planItems:list', floorPlanId),
    create: (payload) => invoke('planItems:create', payload),
    move: (id, x, y) => invoke('planItems:move', { id, x, y }),
    setRotation: (id, rotation) => invoke('planItems:setRotation', { id, rotation }),
    remove: (id) => invoke('planItems:remove', id),
    findByDeviceRef: (deviceId) => invoke('planItems:findByDeviceRef', deviceId),
    listPlacedDeviceIds: () => invoke('planItems:listPlacedDeviceIds'),
    listAllDevicePlacements: () => invoke('planItems:listAllDevicePlacements'),
    setReviewNote: (id, note) => invoke('planItems:setReviewNote', { id, note }),
    setNetworkRole: (id, role) => invoke('planItems:setNetworkRole', { id, role }),
    placeDeviceWithGrouping: (floorPlanId, deviceId, x, y) => invoke('planItems:placeDeviceWithGrouping', { floorPlanId, deviceId, x, y }),
    moveDeviceItemWithGrouping: (oldItemId, floorPlanId, deviceId, x, y) => invoke('planItems:moveDeviceItemWithGrouping', { oldItemId, floorPlanId, deviceId, x, y }),
    groupMembers: (groupItemId) => invoke('planItems:groupMembers', groupItemId),
    removeFromGroup: (groupItemId, deviceId) => invoke('planItems:removeFromGroup', { groupItemId, deviceId }),
    renameGroup: (groupItemId, label) => invoke('planItems:renameGroup', { groupItemId, label })
  },
  cables: {
    list: (floorPlanId) => invoke('cables:list', floorPlanId),
    get: (id) => invoke('cables:get', id),
    create: (payload) => invoke('cables:create', payload),
    updatePath: (id, path) => invoke('cables:updatePath', { id, path }),
    setLabel: (id, label) => invoke('cables:setLabel', { id, label }),
    remove: (id) => invoke('cables:remove', id)
  },
  cableConnections: {
    listByPlan: (floorPlanId) => invoke('cableConnections:listByPlan', floorPlanId),
    listByPlanItem: (planItemId) => invoke('cableConnections:listByPlanItem', planItemId),
    connect: (planItemId, cableId) => invoke('cableConnections:connect', { planItemId, cableId }),
    disconnect: (planItemId, cableId) => invoke('cableConnections:disconnect', { planItemId, cableId })
  },
  ownership: {
    history: (deviceId) => invoke('ownership:history', deviceId),
    historyForUser: (userId) => invoke('ownership:historyForUser', userId),
    assign: (deviceId, userId) => invoke('ownership:assign', { deviceId, userId }),
    unassign: (deviceId) => invoke('ownership:unassign', deviceId)
  },
  components: {
    list: (deviceId) => invoke('components:list', deviceId),
    listAllActive: () => invoke('components:listAllActive'),
    add: (payload) => invoke('components:add', payload),
    detach: (id) => invoke('components:detach', id),
    remove: (id) => invoke('components:remove', id)
  },
  peripherals: {
    list: (deviceId) => invoke('peripherals:list', deviceId),
    listAllActive: () => invoke('peripherals:listAllActive'),
    add: (payload) => invoke('peripherals:add', payload),
    detach: (id) => invoke('peripherals:detach', id),
    remove: (id) => invoke('peripherals:remove', id)
  },
  software: {
    list: (deviceId) => invoke('software:list', deviceId),
    listActive: () => invoke('software:listActive'),
    add: (payload) => invoke('software:add', payload),
    remove: (id) => invoke('software:remove', id),
    setFlag: (id, flag) => invoke('software:setFlag', { id, flag })
  },
  warehouse: {
    list: (category) => invoke('warehouse:list', category),
    add: (payload) => invoke('warehouse:add', payload),
    update: (id, payload) => invoke('warehouse:update', { id, payload }),
    setStatus: (id, status) => invoke('warehouse:setStatus', { id, status }),
    setFlag: (id, flag) => invoke('warehouse:setFlag', { id, flag }),
    receiveComponent: (componentId, note) => invoke('warehouse:receiveComponent', { componentId, note }),
    receiveSoftware: (softwareId, note) => invoke('warehouse:receiveSoftware', { softwareId, note }),
    issueToDevice: (itemId, deviceId) => invoke('warehouse:issueToDevice', { itemId, deviceId }),
    remove: (id) => invoke('warehouse:remove', id)
  },
  zones: {
    list: (floorPlanId) => invoke('zones:list', floorPlanId),
    create: (payload) => invoke('zones:create', payload),
    updateLabel: (id, payload) => invoke('zones:updateLabel', { id, payload }),
    remove: (id) => invoke('zones:remove', id)
  },
  network: {
    listRoots: () => invoke('network:listRoots'),
    buildTree: (rootDeviceId) => invoke('network:buildTree', rootDeviceId)
  },
  auditLog: {
    list: (filters) => invoke('auditLog:list', filters)
  },
  importExcel: {
    devices: () => invoke('import:excelDevices')
  },
  importPcInfo: {
    pickFile: (forceDeviceId) => invoke('import:pcInfoPickFile', forceDeviceId),
    pickFolder: () => invoke('import:pcInfoPickFolder'),
    apply: (parsed, fieldChoices) => invoke('import:pcInfoApply', { parsed, fieldChoices })
  },
  events: {
    /** callback({ reachable, remoteHost }) — вызывается при КАЖДОЙ смене статуса связи
     *  с хостом (см. heartbeat в main/index.js), не только при разрыве. Только для
     *  режима "клиент" — в остальных режимах событие просто не рассылается. */
    onHostConnectivityChanged: (callback) => {
      ipcRenderer.on('host-connectivity-changed', (_event, data) => callback(data));
    },
    /** callback({ channel, cachedAt }) — вызывается, когда конкретный read-запрос был
     *  отдан из локального кэша вместо живого ответа хоста (сети сейчас нет, но раньше
     *  был успешный ответ на этот же запрос) — см. localCache.js. */
    onUsingStaleCache: (callback) => {
      ipcRenderer.on('using-stale-cache', (_event, data) => callback(data));
    },
    /** callback(changes) — массив новых записей audit_log с хоста (см. startClientHeartbeat
     *  в main/index.js) — приходит, когда кто-то ДРУГОЙ (сам хост) что-то изменил, пока
     *  этот клиент был подключён. Только для режима "клиент". */
    onDataChanged: (callback) => {
      ipcRenderer.on('data-changed', (_event, changes) => callback(changes));
    },
    /** callback({ allowWrites, allLocks, acquired, rejected }) — на каждом heartbeat-тике
     *  (см. startClientHeartbeat) — allLocks: [{type, id, hostname, isMine}, ...] — что
     *  сейчас занято, включая чужое; rejected — то из СВОИХ held keys, что вдруг
     *  отклонено (например, хост выключил тумблер посреди сессии). */
    onLocksStateChanged: (callback) => {
      ipcRenderer.on('locks-state-changed', (_event, data) => callback(data));
    }
  }
});
