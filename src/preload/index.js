const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  app: {
    version: () => ipcRenderer.invoke('app:version')
  },
  settings: {
    getDbInfo: () => ipcRenderer.invoke('settings:getDbInfo'),
    pickExistingDbFile: () => ipcRenderer.invoke('settings:pickExistingDbFile'),
    pickNewDbLocation: () => ipcRenderer.invoke('settings:pickNewDbLocation'),
    connectDb: (dbPath) => ipcRenderer.invoke('settings:connectDb', dbPath),
    resetDb: () => ipcRenderer.invoke('settings:resetDb')
  },
  users: {
    list: () => ipcRenderer.invoke('users:list'),
    create: (payload) => ipcRenderer.invoke('users:create', payload),
    update: (id, payload) => ipcRenderer.invoke('users:update', { id, payload }),
    setStatus: (id, status) => ipcRenderer.invoke('users:setStatus', { id, status }),
    setFlag: (id, flag) => ipcRenderer.invoke('users:setFlag', { id, flag }),
    remove: (id) => ipcRenderer.invoke('users:remove', id)
  },
  devices: {
    list: () => ipcRenderer.invoke('devices:list'),
    create: (payload) => ipcRenderer.invoke('devices:create', payload),
    update: (id, payload) => ipcRenderer.invoke('devices:update', { id, payload }),
    setStatus: (id, status, note) => ipcRenderer.invoke('devices:setStatus', { id, status, note }),
    setFlag: (id, flag) => ipcRenderer.invoke('devices:setFlag', { id, flag }),
    statusHistory: (id) => ipcRenderer.invoke('devices:statusHistory', id),
    remove: (id) => ipcRenderer.invoke('devices:remove', id),
    search: (query) => ipcRenderer.invoke('devices:search', query)
  },
  ping: {
    run: (deviceId, ip) => ipcRenderer.invoke('ping:run', { deviceId, ip }),
    history: (deviceId) => ipcRenderer.invoke('ping:history', deviceId)
  },
  floorPlans: {
    list: () => ipcRenderer.invoke('floorPlans:list'),
    ensureDefault: () => ipcRenderer.invoke('floorPlans:ensureDefault'),
    create: (payload) => ipcRenderer.invoke('floorPlans:create', payload),
    remove: (id) => ipcRenderer.invoke('floorPlans:remove', id),
    rename: (id, name) => ipcRenderer.invoke('floorPlans:rename', { id, name })
  },
  planItems: {
    list: (floorPlanId) => ipcRenderer.invoke('planItems:list', floorPlanId),
    create: (payload) => ipcRenderer.invoke('planItems:create', payload),
    move: (id, x, y) => ipcRenderer.invoke('planItems:move', { id, x, y }),
    setRotation: (id, rotation) => ipcRenderer.invoke('planItems:setRotation', { id, rotation }),
    remove: (id) => ipcRenderer.invoke('planItems:remove', id),
    findByDeviceRef: (deviceId) => ipcRenderer.invoke('planItems:findByDeviceRef', deviceId),
    listPlacedDeviceIds: () => ipcRenderer.invoke('planItems:listPlacedDeviceIds'),
    setReviewNote: (id, note) => ipcRenderer.invoke('planItems:setReviewNote', { id, note })
  },
  cables: {
    list: (floorPlanId) => ipcRenderer.invoke('cables:list', floorPlanId),
    create: (payload) => ipcRenderer.invoke('cables:create', payload),
    remove: (id) => ipcRenderer.invoke('cables:remove', id)
  },
  ownership: {
    history: (deviceId) => ipcRenderer.invoke('ownership:history', deviceId),
    assign: (deviceId, userId) => ipcRenderer.invoke('ownership:assign', { deviceId, userId }),
    unassign: (deviceId) => ipcRenderer.invoke('ownership:unassign', deviceId)
  },
  components: {
    list: (deviceId) => ipcRenderer.invoke('components:list', deviceId),
    listAllActive: () => ipcRenderer.invoke('components:listAllActive'),
    add: (payload) => ipcRenderer.invoke('components:add', payload),
    detach: (id) => ipcRenderer.invoke('components:detach', id),
    remove: (id) => ipcRenderer.invoke('components:remove', id)
  },
  peripherals: {
    list: (deviceId) => ipcRenderer.invoke('peripherals:list', deviceId),
    listAllActive: () => ipcRenderer.invoke('peripherals:listAllActive'),
    add: (payload) => ipcRenderer.invoke('peripherals:add', payload),
    detach: (id) => ipcRenderer.invoke('peripherals:detach', id),
    remove: (id) => ipcRenderer.invoke('peripherals:remove', id)
  },
  software: {
    list: (deviceId) => ipcRenderer.invoke('software:list', deviceId),
    listActive: () => ipcRenderer.invoke('software:listActive'),
    add: (payload) => ipcRenderer.invoke('software:add', payload),
    remove: (id) => ipcRenderer.invoke('software:remove', id),
    setFlag: (id, flag) => ipcRenderer.invoke('software:setFlag', { id, flag })
  },
  warehouse: {
    list: (category) => ipcRenderer.invoke('warehouse:list', category),
    add: (payload) => ipcRenderer.invoke('warehouse:add', payload),
    update: (id, payload) => ipcRenderer.invoke('warehouse:update', { id, payload }),
    setStatus: (id, status) => ipcRenderer.invoke('warehouse:setStatus', { id, status }),
    setFlag: (id, flag) => ipcRenderer.invoke('warehouse:setFlag', { id, flag }),
    receiveComponent: (componentId, note) => ipcRenderer.invoke('warehouse:receiveComponent', { componentId, note }),
    receiveSoftware: (softwareId, note) => ipcRenderer.invoke('warehouse:receiveSoftware', { softwareId, note }),
    issueToDevice: (itemId, deviceId) => ipcRenderer.invoke('warehouse:issueToDevice', { itemId, deviceId }),
    remove: (id) => ipcRenderer.invoke('warehouse:remove', id)
  },
  zones: {
    list: (floorPlanId) => ipcRenderer.invoke('zones:list', floorPlanId),
    create: (payload) => ipcRenderer.invoke('zones:create', payload),
    updateLabel: (id, payload) => ipcRenderer.invoke('zones:updateLabel', { id, payload }),
    remove: (id) => ipcRenderer.invoke('zones:remove', id)
  },
  importExcel: {
    devices: () => ipcRenderer.invoke('import:excelDevices')
  }
});
