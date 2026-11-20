// dbChannels.js
//
// Единая карта каналов работы с данными — { [канал]: { write, lockEntity, fn } }.
//
// Зачем отдельный модуль: ровно эту карту используют ТРИ разные точки входа, и расходиться
// им нельзя, иначе клиент и сервер начнут говорить на разных протоколах:
//   1. Electron, обычный/хост-режим — ipcMain.handle() на каждый канал (main/index.js);
//   2. Electron в режиме хоста — та же карта отдаётся RPC-серверу для запросов по сети;
//   3. выделенный сервер в докере — тот же RPC-сервер, но на обычном Node, без Electron
//      (см. server/index.js).
// Поэтому здесь НЕ должно появляться ничего, что требует Electron: диалоги выбора файла,
// импорт с диска, настройки подключения и блокировки живут в своих точках входа.
//
// write: true  — операция меняет данные (решение «можно ли» принимает вызывающая сторона:
//                тумблер разрешения + блокировки, см. writeLocks.js);
// lockEntity   — какой объект операция затрагивает, чтобы сверить с блокировкой
//                «взялся — ходи»; без него операция блокировками не защищена.

const {
  usersRepo, devicesRepo, pingRepo, floorPlansRepo, planItemsRepo, cablesRepo, cableConnectionsRepo,
  ownershipRepo, componentsRepo, peripheralsRepo, softwareRepo, warehouseRepo, zonesRepo, networkRepo, auditLogRepo,
  getDbReadonly
} = require('../main/db');
const { pingHost } = require('../main/ping');

const DB_CHANNELS = {
  'users:list': { write: false, fn: () => usersRepo.list() },
  'users:create': { write: true, fn: (payload) => usersRepo.create(payload) },
  'users:update': { write: true, fn: ({ id, payload }) => usersRepo.update(id, payload) },
  'users:setStatus': { write: true, fn: ({ id, status }) => usersRepo.setStatus(id, status) },
  'users:setFlag': { write: true, fn: ({ id, flag }) => usersRepo.setFlag(id, flag) },
  'users:remove': { write: true, fn: (id) => usersRepo.remove(id) },

  'devices:list': { write: false, fn: () => devicesRepo.list() },
  'devices:create': { write: true, fn: (payload) => devicesRepo.create(payload) },
  'devices:update': { write: true, lockEntity: (p) => ({ type: 'device', id: p.id }), fn: ({ id, payload }) => devicesRepo.update(id, payload) },
  'devices:setStatus': { write: true, fn: ({ id, status, note }) => devicesRepo.setStatus(id, status, note) },
  'devices:setFlag': { write: true, fn: ({ id, flag }) => devicesRepo.setFlag(id, flag) },
  'devices:setWifiRadius': { write: true, lockEntity: (p) => ({ type: 'device', id: p.id }), fn: ({ id, radiusM }) => devicesRepo.setWifiRadius(id, radiusM) },
  'devices:setUplink': { write: true, lockEntity: (p) => ({ type: 'device', id: p.id }), fn: ({ id, uplinkDeviceId }) => devicesRepo.setUplink(id, uplinkDeviceId) },
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
  'floorPlans:fitToContent': { write: true, fn: (floorPlanId) => floorPlansRepo.fitToContent(floorPlanId) },
  'floorPlans:ensureDefault': { write: true, fn: () => floorPlansRepo.ensureDefault() },
  'floorPlans:create': { write: true, fn: (payload) => floorPlansRepo.create(payload) },
  'floorPlans:remove': { write: true, fn: (id) => floorPlansRepo.remove(id) },
  'floorPlans:rename': { write: true, fn: ({ id, name }) => floorPlansRepo.rename(id, name) },

  'planItems:list': { write: false, fn: (floorPlanId) => planItemsRepo.listByPlan(floorPlanId) },
  'planItems:create': { write: true, fn: (payload) => planItemsRepo.create(payload) },
  'planItems:move': { write: true, lockEntity: (p) => ({ type: 'plan_item', id: p.id }), fn: ({ id, x, y }) => planItemsRepo.move(id, x, y) },
  'planItems:setDoorWidth': { write: true, lockEntity: (p) => ({ type: 'plan_item', id: p.id }), fn: ({ id, width }) => planItemsRepo.setDoorWidth(id, width) },
  'planItems:setRotation': { write: true, lockEntity: (p) => ({ type: 'plan_item', id: p.id }), fn: ({ id, rotation }) => planItemsRepo.setRotation(id, rotation) },
  'planItems:setCellOffset': { write: true, lockEntity: (p) => ({ type: 'plan_item', id: p.id }), fn: ({ id, offset_x, offset_y }) => planItemsRepo.setCellOffset(id, offset_x, offset_y) },
  'planItems:remove': { write: true, lockEntity: (id) => ({ type: 'plan_item', id }), fn: (id) => planItemsRepo.remove(id) },
  'planItems:findByDeviceRef': { write: false, fn: (deviceId) => planItemsRepo.findByDeviceRef(deviceId) },
  'planItems:listPlacedDeviceIds': { write: false, fn: () => planItemsRepo.listPlacedDeviceIds() },
  'planItems:listAllDevicePlacements': { write: false, fn: () => planItemsRepo.listAllDevicePlacements() },
  'planItems:setReviewNote': { write: true, lockEntity: (p) => ({ type: 'plan_item', id: p.id }), fn: ({ id, note }) => planItemsRepo.setReviewNote(id, note) },
  'planItems:setNetworkRole': { write: true, lockEntity: (p) => ({ type: 'plan_item', id: p.id }), fn: ({ id, role }) => planItemsRepo.setNetworkRole(id, role) },
  'planItems:placeDeviceWithGrouping': { write: true, fn: ({ floorPlanId, deviceId, x, y }) => planItemsRepo.placeDeviceWithGrouping(floorPlanId, deviceId, x, y) },
  'planItems:moveDeviceItemWithGrouping': { write: true, fn: ({ oldItemId, floorPlanId, deviceId, x, y }) => planItemsRepo.moveDeviceItemWithGrouping(oldItemId, floorPlanId, deviceId, x, y) },
  'planItems:groupMembers': { write: false, fn: (groupItemId) => planItemsRepo.groupMembers(groupItemId) },
  'planItems:removeFromGroup': { write: true, lockEntity: (p) => ({ type: 'plan_item', id: p.groupItemId }), fn: ({ groupItemId, deviceId }) => planItemsRepo.removeFromGroup(groupItemId, deviceId) },
  'planItems:renameGroup': { write: true, lockEntity: (p) => ({ type: 'plan_item', id: p.groupItemId }), fn: ({ groupItemId, label }) => planItemsRepo.renameGroup(groupItemId, label) },

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
  'ownership:assign': { write: true, lockEntity: (p) => ({ type: 'device', id: p.deviceId }), fn: ({ deviceId, userId }) => ownershipRepo.assign(deviceId, userId) },
  'ownership:unassign': { write: true, lockEntity: (id) => ({ type: 'device', id }), fn: (deviceId) => ownershipRepo.unassign(deviceId) },

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
  'software:update': { write: true, fn: ({ id, ...payload }) => softwareRepo.update(id, payload) },
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

/** Текст отказа, когда база открыта только для чтения. Без него пользователь видел бы
 *  сырое сообщение SQLite «attempt to write a readonly database», из которого непонятно
 *  ни что произошло, ни что с этим делать. */
function readonlyRefusalMessage() {
  const ro = getDbReadonly();
  const where = ro.reason ? `${ro.reason}. ` : '';
  return `База открыта только для чтения. ${where}` +
    'Чтобы вносить изменения, закройте приложение там, где база уже открыта, ' +
    'либо работайте через сервер (⚙️ Настройки БД → Подключиться к серверу).';
}

// Единая защита readonly для ВСЕХ точек входа сразу. Делаем это здесь, а не в каждом
// диспетчере (Electron локально, Electron-хост по сети, выделенный сервер): иначе
// достаточно забыть проверку в одном из трёх — и запись уйдёт в SQLite, где отвалится
// уже непереводимой технической ошибкой.
Object.values(DB_CHANNELS).forEach((entry) => {
  if (!entry.write) return;
  const original = entry.fn;
  entry.fn = (payload) => {
    if (getDbReadonly().readonly) throw new Error(readonlyRefusalMessage());
    return original(payload);
  };
});

module.exports = { DB_CHANNELS, readonlyRefusalMessage };
