const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const dbLock = require('./dbLock');

// Папка для служебных файлов (data.db по умолчанию, db-config.json, кэш). В Electron
// это app.getPath('userData'), но этот же модуль целиком переиспользует выделенный
// сервер (см. server/index.js), который работает на ОБЫЧНОМ Node, без Electron —
// поэтому electron не требуется на верхнем уровне, а путь можно задать извне.
let userDataPathOverride = null;

/** Задать папку служебных файлов вручную — вызывается сервером до любых обращений к БД.
 *  В Electron не вызывается вообще: там путь берётся у самого Electron (см. userDataPath). */
function setUserDataPath(dir) {
  userDataPathOverride = dir;
}

function userDataPath() {
  if (userDataPathOverride) return userDataPathOverride;
  // require внутри функции, а не на верхнем уровне: в обычном Node пакет 'electron'
  // либо не установлен вовсе (образ сервера его не тянет), либо отдаёт путь к бинарнику
  // вместо API — и в обоих случаях этот код просто не должен выполняться
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch { /* не Electron — падаем в ошибку ниже, она понятнее любой случайной */ }
  throw new Error('Папка данных не задана: вызовите setUserDataPath() до работы с БД (вне Electron это обязательно).');
}

/** То же, но без исключения — для мест, где папка данных лишь один из вариантов поиска
 *  (например, где искать bitrix.yml). */
function getUserDataDir() {
  try { return userDataPath(); } catch { return null; }
}

let db;
let currentDbPath = null;
let lastConnectWarning = null; // строка предупреждения, если пришлось откатиться на локальную БД
// Открыта ли база только для чтения (её уже держит другой экземпляр, см. dbLock.js) —
// { readonly, heldBy, reason, schemaMismatch?, openError? }
let readonlyState = { readonly: false, heldBy: null, reason: null };

const SCHEMA_VERSION = 21;
const FLAG_VALUES = ['problem', 'attention', 'error']; // null = нет пометки, отдельно не входит в список
const FLAG_LABELS_RU = { problem: 'Проблема', attention: 'Внимание', error: 'Ошибка' }; // для текста в журнале изменений
const DEVICE_STATUS_LABELS_RU = { active: 'Активен', repair: 'Ремонт', storage: 'На складе', decommissioned: 'Списан' };
const PLAN_ITEM_TYPE_LABELS_RU = {
  device: 'Устройство', desk: 'Стол', wall: 'Стена', door: 'Дверь',
  stairs: 'Лестница', border: 'Граница', group: 'Группа устройств'
};
// Клетка плана — условный метр, поэтому ширина двери в клетках равна ширине в метрах
const DEFAULT_DOOR_WIDTH = 0.9;
// Условный радиус охвата Wi-Fi по умолчанию, в метрах. Берётся, когда у устройства
// своё значение не задано (wifi_radius_m IS NULL)
const DEFAULT_WIFI_RADIUS_M = 15;
// Типы устройств, у которых охват вообще имеет смысл показывать
const WIFI_DEVICE_TYPES = ['router'];
// Должно совпадать с CHECK(software_type) в device_software (см. schema.sql)
const SOFTWARE_TYPES = ['os', 'office', 'antivirus', 'other'];

/** Человекочитаемое название объекта плана для журнала изменений — для устройства
 *  подставляет его hostname, для остальных типов — просто название типа. */
function planItemLabelForLog(db, item) {
  if (item.item_type === 'device' && item.ref_id) {
    const device = db.prepare('SELECT hostname, device_type FROM devices WHERE id = ?').get(item.ref_id);
    return `Устройство «${device ? (device.hostname || device.device_type) : '?'}»`;
  }
  return PLAN_ITEM_TYPE_LABELS_RU[item.item_type] || item.item_type;
}

/** Приводит угол к 0..359 — на входе может быть и отрицательный (поворот против часовой),
 *  и больше оборота; CHECK в схеме принимает только нормализованный. */
function normalizeRotation(rotation) {
  const n = Math.round(Number(rotation) || 0);
  return ((n % 360) + 360) % 360;
}

/** Смещение внутри клетки хранится в долях клетки и не должно выводить объект за её
 *  пределы — ограничиваем -0.5..+0.5 (это же проверяет CHECK в схеме). */
/** Округление смещения до 0.001 клетки (при 40px/клетку это 0.04px — незаметно даже
 *  при зуме). Без него после перетаскивания в поля инспектора попадало что-то вроде
 *  0.34999999999999964. */
function roundCellOffset(value) {
  const n = Number(value) || 0;
  return Math.round(n * 1000) / 1000;
}

/** Последняя линия обороны под CHECK в схеме. Нормальный путь — normalizeCellAndOffset,
 *  который за пределами половины клетки переносит объект к соседней, а не упирает его
 *  в границу собственной. */
function clampCellOffset(value) {
  return Math.max(-0.5, Math.min(0.5, roundCellOffset(value)));
}

/**
 * Приводит пару «клетка + смещение» к единственному каноничному виду: клетка-владелец
 * всегда та, к ЦЕНТРУ которой объект ближе всего, а смещение от её центра не больше
 * половины клетки.
 *
 * Иначе говоря: ушёл от центра своей клетки больше чем на половину — перепривязался к
 * соседней. Смещение 0.8 не зажимается до 0.5 (объект застрял бы на границе, визуально
 * находясь в чужой клетке, но принадлежа своей), а превращается в «следующая клетка,
 * смещение -0.2». Ровно то же самое делает округление при перетаскивании мышью, поэтому
 * мышь и числовые поля дают одинаковый результат.
 *
 * limit (необязательно) — число клеток по этой оси: за край плана объект уносить нельзя,
 * там остаток остаётся смещением (упирается в границу осознанно, это единственный случай,
 * когда |offset| может дойти до 0.5).
 */
function normalizeCellAndOffset(cell, offset, min = null, max = null) {
  const own = Number(cell) || 0;
  const delta = cellsToCarry(roundCellOffset(offset));
  let targetCell = own + delta;
  // Зажимаем ГРАНИЦАМИ ПЛАНА, а не нулём: начало координат может быть отрицательным,
  // и объект, начерченный выше/левее нуля, иначе утаскивало бы в клетку 0 при первой же
  // правке смещения.
  if (min !== null && Number.isFinite(min)) targetCell = Math.max(Math.floor(min), targetCell);
  if (max !== null && Number.isFinite(max)) targetCell = Math.min(Math.floor(max) - 1, targetCell);
  return { cell: targetCell, offset: clampCellOffset(own + roundCellOffset(offset) - targetCell) };
}

/** Сколько целых клеток «съедает» смещение. Округление к НУЛЮ при ровной половине:
 *  правило — «ушёл больше чем на половину», значит ровно половина остаётся за своей
 *  клеткой. Math.round здесь не годится, он несимметричен: Math.round(0.5) = 1, но
 *  Math.round(-0.5) = 0, и объект перепривязывался вправо, но не влево. */
function cellsToCarry(offset) {
  if (!offset) return 0;
  const magnitude = Math.ceil(Math.abs(offset) - 0.5);
  return magnitude <= 0 ? 0 : Math.sign(offset) * magnitude;
}

// Точечные объекты занимают ОДНУ клетку и рисуются как иконка в её центре — только у них
// есть смысл у смещения внутри клетки. У стены/двери/лестницы x,y,x2,y2 — это УЗЛЫ сетки
// (координата может равняться ширине плана, т.е. правому краю), смещения у них нет, и
// нормализовать их координаты как клетки нельзя — это сдвинуло бы концы линий.
const POINT_ITEM_TYPES = ['desk', 'device', 'group', 'other'];
function isPointItemType(itemType) {
  return POINT_ITEM_TYPES.includes(itemType);
}

/** Ширина проёма в допустимых пределах. strict=true — ругаться на мусор вместо тихой
 *  подстановки умолчания: при явной правке поля человек должен увидеть, что ввёл не то. */
function clampDoorWidth(width, strict = false) {
  const n = Number(width);
  if (!Number.isFinite(n) || n <= 0) {
    if (strict) throw new Error('Ширина двери должна быть положительным числом (в метрах, например 0.9).');
    return DEFAULT_DOOR_WIDTH;
  }
  const rounded = Math.round(n * 100) / 100; // сантиметры — достаточная точность для плана
  if (rounded > 20) {
    if (strict) throw new Error('Ширина двери не может быть больше 20 м.');
    return 20;
  }
  return rounded;
}

/** Радиус охвата: null (пусто/0) значит «брать значение по умолчанию», поэтому пустое
 *  поле — это не ошибка, а осмысленный сброс. strict=true ругается на мусор. */
function normalizeWifiRadius(value, strict = false) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    if (strict) throw new Error('Радиус охвата — положительное число в метрах (оставьте пустым, чтобы взять значение по умолчанию).');
    return null;
  }
  const rounded = Math.round(n * 10) / 10;
  if (rounded > 500) {
    if (strict) throw new Error('Радиус охвата не может быть больше 500 м.');
    return 500;
  }
  return rounded;
}

/** «0.9 м» — короткая подпись для журнала и инспектора, без лишних нулей */
function formatMeters(value) {
  const n = Number(value) || 0;
  return `${Number(n.toFixed(2))} м`;
}

// Предел автоматического роста плана. Без него одна опечатка («перенести на 99999
// клеток вправо») раздувала бы сетку до неотрисовываемых размеров.
const MAX_PLAN_CELLS = 2000;
// Запас по краям при росте: объект у самой границы должен иметь вокруг себя сетку,
// иначе он выглядит обрезанным и к нему нечего привязывать
const PLAN_GROW_MARGIN = 4;

/**
 * Расширяет границы плана так, чтобы перечисленные клетки оказались внутри.
 *
 * Зачем: границы плана — это не только рамка на экране. По ним ограничены заливка зоны
 * (floodFillZone) и перепривязка смещения (normalizeCellAndOffset), поэтому объект,
 * оказавшийся за границей, попадает в область, где зоны и привязка не работают, да ещё и
 * без сетки под собой. Раньше create/move координаты не проверяли вовсе, так что уехать
 * за край было легко.
 *
 * Возвращает true, если план действительно вырос.
 */
function growPlanToFit(db, floorPlanId, cells) {
  const plan = db.prepare(
    'SELECT grid_width_cells, grid_height_cells, grid_min_x, grid_min_y FROM floor_plans WHERE id = ?'
  ).get(floorPlanId);
  if (!plan) return false;

  // Работаем границами [min; max), а не парой «ширина/высота»: расти надо во все четыре
  // стороны. Раньше росли только вправо и вниз, и всё, начерченное выше или левее начала
  // координат, навсегда оставалось за пределами плана — там не работали ни заливка зон,
  // ни привязка смещения.
  let minX = plan.grid_min_x;
  let minY = plan.grid_min_y;
  let maxX = plan.grid_min_x + plan.grid_width_cells;   // граница исключающая
  let maxY = plan.grid_min_y + plan.grid_height_cells;

  for (const [cx, cy] of cells) {
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
    const gx = Math.round(cx);
    const gy = Math.round(cy);
    // Запас добавляем ТОЛЬКО тому, кто реально вышел за границу. Объекту внутри плана —
    // ничего: иначе любой объект у последней клетки толкал бы границу ещё на несколько
    // клеток наружу, и размер плана полз бы сам, без всякой просьбы.
    if (gx < minX) minX = gx - PLAN_GROW_MARGIN;
    if (gx + 1 > maxX) maxX = gx + 1 + PLAN_GROW_MARGIN;
    if (gy < minY) minY = gy - PLAN_GROW_MARGIN;
    if (gy + 1 > maxY) maxY = gy + 1 + PLAN_GROW_MARGIN;
  }

  // Предел на ОБЩИЙ размер, а не на координату: план может целиком лежать в минусе
  let width = Math.min(maxX - minX, MAX_PLAN_CELLS);
  let height = Math.min(maxY - minY, MAX_PLAN_CELLS);

  if (minX === plan.grid_min_x && minY === plan.grid_min_y &&
      width === plan.grid_width_cells && height === plan.grid_height_cells) return false;

  db.prepare(`
    UPDATE floor_plans SET grid_min_x = ?, grid_min_y = ?, grid_width_cells = ?, grid_height_cells = ?,
                            updated_at = datetime('now')
    WHERE id = ?
  `).run(minX, minY, width, height, floorPlanId);
  return true;
}

/** Границы плана в клетках: [minX; maxX) x [minY; maxY). Нужны, чтобы перепривязка не
 *  вынесла объект за край. Начало координат может быть отрицательным (см. grid_min_x). */
function planBounds(db, floorPlanId) {
  const plan = db.prepare(
    'SELECT grid_width_cells, grid_height_cells, grid_min_x, grid_min_y FROM floor_plans WHERE id = ?'
  ).get(floorPlanId);
  if (!plan) return { minX: null, maxX: null, minY: null, maxY: null };
  return {
    minX: plan.grid_min_x,
    maxX: plan.grid_min_x + plan.grid_width_cells,
    minY: plan.grid_min_y,
    maxY: plan.grid_min_y + plan.grid_height_cells
  };
}

function getDefaultDbPath() {
  return path.join(userDataPath(), 'data.db');
}

function getConfigPath() {
  return path.join(userDataPath(), 'db-config.json');
}

/** Конфиг подключения — отдельный маленький JSON-файл рядом с БД, не в самой БД
 *  (иначе негде было бы хранить путь до её открытия). */
function loadDbConfig() {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
  } catch {
    return {};
  }
}

function saveDbConfig(cfg) {
  fs.writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2), 'utf-8');
}

/** Путь, который реально будем открывать — из конфига, если он задан и его папка доступна
 *  (сеть/шара может быть отключена на момент запуска), иначе локальный файл по умолчанию. */
function resolveDbPath() {
  const cfg = loadDbConfig();
  lastConnectWarning = null;
  if (cfg.dbPath) {
    const dir = path.dirname(cfg.dbPath);
    if (fs.existsSync(dir)) return cfg.dbPath;
    lastConnectWarning = `Сетевой путь к БД недоступен (${cfg.dbPath}) — открыта локальная копия по умолчанию.`;
  }
  return getDefaultDbPath();
}

/**
 * Открывает БД (создаёт файл при первом запуске) и применяет schema.sql,
 * если основные таблицы ещё не созданы. Для уже существующей БД прогоняет
 * миграции по PRAGMA user_version, не трогая имеющиеся данные.
 * Без явного пути — берёт путь из конфига подключения (см. resolveDbPath),
 * по умолчанию это файл в userData, т.е. не теряется при переустановке.
 *
 * Перед открытием пытается занять базу под запись (см. dbLock.js). Если её уже
 * держит другой живой экземпляр — база открывается ТОЛЬКО ДЛЯ ЧТЕНИЯ, а не
 * параллельно на запись: на сетевой шаре собственные блокировки SQLite не спасают,
 * и две пишущие копии портят файл. Приложение в этом случае всё равно запускается
 * (данные видны), но все изменения отклоняются — см. getDbReadonly().
 *
 * options.skipLock — не занимать замок вообще (служебные открытия: пробник, бэкап).
 */
function initDatabase(explicitPath, options = {}) {
  const dbPath = explicitPath || resolveDbPath();

  readonlyState = { readonly: false, heldBy: null, reason: null };
  if (!options.skipLock) {
    const lock = dbLock.acquire(dbPath);
    if (!lock.acquired) {
      readonlyState = {
        readonly: true,
        heldBy: lock.heldBy || null,
        reason: lock.heldBy
          ? `База уже открыта на «${lock.heldBy.hostname}»${lock.heldBy.user ? ` (${lock.heldBy.user})` : ''}`
          : `Не удалось занять базу под запись: ${lock.error || 'причина неизвестна'}`
      };
    }
  }

  if (readonlyState.readonly) {
    try {
      // journal_mode здесь НЕ трогаем: смена режима журнала — это запись в файл,
      // на readonly-соединении она сорвётся. Режим и так уже выставлен владельцем.
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try { db.pragma('foreign_keys = ON'); } catch { /* на readonly-соединении не обязателен */ }
      currentDbPath = dbPath;
      const version = db.pragma('user_version', { simple: true });
      if (version !== SCHEMA_VERSION) {
        // Миграции — это запись, выполнить их сейчас нельзя. Честно говорим об этом,
        // вместо того чтобы падать на первом же запросе к изменившейся таблице.
        readonlyState.schemaMismatch = { found: version, expected: SCHEMA_VERSION };
      }
      console.log('[db] база занята другим экземпляром, открыта ТОЛЬКО ДЛЯ ЧТЕНИЯ:', dbPath);
      return db;
    } catch (err) {
      // Даже на чтение не открылась — дальше нас подхватит обычный путь отката на
      // локальную копию (см. app.whenReady в main/index.js)
      readonlyState.openError = err.message;
      throw new Error(`База занята другим экземпляром и не открывается даже для чтения: ${err.message}`);
    }
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  currentDbPath = dbPath;

  const hasTables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='devices'")
    .get();

  if (!hasTables) {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    db.exec(schema);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    console.log('[db] схема применена с нуля, файл:', dbPath);
  } else {
    runMigrations();
    console.log('[db] используется существующая БД:', dbPath);
  }

  return db;
}

/** Открыта ли база только для чтения, и почему. Используется и диспетчером каналов
 *  (отклонить запись), и интерфейсом (плашка в шапке). */
function getDbReadonly() {
  return readonlyState;
}

/** Переводит уже открытую базу в режим только чтения на ходу — вызывается, если замок
 *  у нас отобрали посреди работы (машину усыпляли, шара моргнула дольше таймаута).
 *  Соединение не переоткрываем: наша цель — перестать ПИСАТЬ, а читать уже открытым
 *  соединением безопасно. */
function markReadonly(heldBy, reason) {
  readonlyState = { readonly: true, heldBy: heldBy || null, reason: reason || 'База занята другим экземпляром' };
}

/** Снимает наш замок — штатное завершение процесса. */
function releaseDbLock() {
  dbLock.release();
}

function getCurrentDbPath() { return currentDbPath; }
function getLastConnectWarning() { return lastConnectWarning; }

/** Настроенный (не обязательно доступный сейчас) путь к БД из конфига, если задан —
 *  дешёвое локальное чтение JSON, без попытки реально открыть файл БД. Используется
 *  main/index.js перед запуском процесса-пробника (db-probe.js): если сетевой путь
 *  вообще не настроен, пробник не нужен — открываем локальный файл напрямую. */
function getConfiguredDbPath() {
  const cfg = loadDbConfig();
  if (cfg.mode === 'client') return null; // клиент свою БД не открывает вообще, пробовать нечего
  return cfg.dbPath || null;
}

/** Запоминает новый путь в конфиге — вступит в силу после перезапуска приложения
 *  (перезапуск проще и надёжнее, чем на лету переподключать все окна/списки/канву) */
const DEFAULT_HOST_PORT = 47821;

/** Переключение обратно на обычный режим (свой файл — локальный или сетевой путь,
 *  как было раньше) — сбрасывает host/client настройки. */
function setConfiguredDbPath(newPath) {
  saveDbConfig({ mode: 'local', dbPath: newPath || null, hostPort: null, remoteHost: null });
}

/** Режим работы: 'local' (обычный файл — свой процесс открывает БД напрямую, как и
 *  было изначально), 'host' (держит файл БД у СЕБЯ локально и раздаёт доступ по сети
 *  остальным через RPC-сервер, см. rpcServer.js), 'client' (свою БД не открывает
 *  вообще — все запросы уходят по сети на чужой host, см. rpcClient.js). */
function getAppMode() {
  return loadDbConfig().mode || 'local';
}

function getHostPort() {
  return loadDbConfig().hostPort || DEFAULT_HOST_PORT;
}

function getDiscoveryPath() {
  return loadDbConfig().discoveryPath || null;
}

function getRemoteHost() {
  return loadDbConfig().remoteHost || null;
}

/** Глобальный тумблер «разрешить клиентам вносить изменения» — по умолчанию выключен
 *  (клиенты только просмотр, как и было изначально). Персистентен — переживает
 *  перезапуск хоста, в отличие от самих блокировок (см. writeLocks.js), которым это
 *  не нужно: после перезапуска все активные блокировки и так должны сброситься. */
function getAllowClientWrites() {
  return !!loadDbConfig().allowClientWrites;
}
function setAllowClientWrites(allow) {
  const cfg = loadDbConfig();
  cfg.allowClientWrites = !!allow;
  saveDbConfig(cfg);
}

/** dbPath здесь всегда ЛОКАЛЬНЫЙ файл (или null = дефолтный локальный путь) —
 *  UI обязан предупредить пользователя не указывать сюда сетевой путь, в этом весь
 *  смысл режима "хост": файл открывает только один процесс, остальные — по сети.
 *  discoveryPath — необязательный СЕТЕВОЙ путь, куда публикуется маячок с адресом
 *  хоста (см. discovery.js) — обычно тот самый путь, куда раньше все указывали как
 *  на общий файл БД в старой схеме прямого доступа по сети, для плавной миграции. */
function setHostMode(dbPath, hostPort = DEFAULT_HOST_PORT, discoveryPath = null) {
  saveDbConfig({ mode: 'host', dbPath: dbPath || null, hostPort, remoteHost: null, discoveryPath: discoveryPath || null });
}

/** remoteHost — строка вида "192.168.1.42:47821". Собственную БД клиент не открывает
 *  вообще — resolveDbPath()/initDatabase() в этом режиме не вызываются.
 *
 *  sourceKind различает, к ЧЕМУ мы подключены, хотя протокол один и тот же:
 *    'host'   — другой экземпляр приложения, поднявший общий доступ (ключа нет,
 *               адрес ищется маячком, хост может экстренно отключить клиента);
 *    'server' — выделенный сервер (см. server/index.js): нужен ключ доступа, адрес
 *               постоянный, маячков нет.
 *  Нужен только для подписей в интерфейсе и для того, чтобы не предлагать клиенту
 *  сервера то, что осмысленно лишь с хостом. */
function setClientMode(remoteHost, serverToken = null, sourceKind = 'host') {
  saveDbConfig({
    mode: 'client', remoteHost, dbPath: null, hostPort: null,
    serverToken: serverToken || null,
    sourceKind: sourceKind === 'server' ? 'server' : 'host'
  });
}

/** Ключ доступа к выделенному серверу. Лежит в том же db-config.json, что и остальные
 *  настройки подключения: иначе его негде держать до открытия базы, а база в этом
 *  режиме вообще не открывается. */
function getServerToken() {
  return loadDbConfig().serverToken || null;
}

/** 'host' | 'server' — к чему подключён клиент (см. setClientMode). */
function getSourceKind() {
  return loadDbConfig().sourceKind === 'server' ? 'server' : 'host';
}

function runMigrations() {
  const currentVersion = db.pragma('user_version', { simple: true });
  if (currentVersion < 2) migrateToV2();
  if (db.pragma('user_version', { simple: true }) < 3) migrateToV3();
  if (db.pragma('user_version', { simple: true }) < 4) migrateToV4();
  if (db.pragma('user_version', { simple: true }) < 5) migrateToV5();
  if (db.pragma('user_version', { simple: true }) < 6) migrateToV6();
  if (db.pragma('user_version', { simple: true }) < 7) migrateToV7();
  if (db.pragma('user_version', { simple: true }) < 8) migrateToV8();
  if (db.pragma('user_version', { simple: true }) < 9) migrateToV9();
  if (db.pragma('user_version', { simple: true }) < 10) migrateToV10();
  if (db.pragma('user_version', { simple: true }) < 11) migrateToV11();
  if (db.pragma('user_version', { simple: true }) < 12) migrateToV12();
  if (db.pragma('user_version', { simple: true }) < 13) migrateToV13();
  if (db.pragma('user_version', { simple: true }) < 14) migrateToV14();
  if (db.pragma('user_version', { simple: true }) < 15) migrateToV15();
  if (db.pragma('user_version', { simple: true }) < 16) migrateToV16();
  if (db.pragma('user_version', { simple: true }) < 17) migrateToV17();
  if (db.pragma('user_version', { simple: true }) < 18) migrateToV18();
  if (db.pragma('user_version', { simple: true }) < 19) migrateToV19();
  if (db.pragma('user_version', { simple: true }) < 20) migrateToV20();
  if (db.pragma('user_version', { simple: true }) < 21) migrateToV21();
}

/**
 * v1 -> v2: стены/двери/лестницы (x2,y2 в plan_items, расширенный item_type)
 * и статус последнего пинга (view device_latest_ping).
 * cables на v1 ещё не использовался ни в одном UI, поэтому просто пересоздаётся
 * пустым с FK на новую plan_items — исторических данных в нём нет и терять нечего.
 */
function migrateToV2() {
  console.log('[db] миграция схемы v1 -> v2 (стены/двери/лестницы, статус пинга)');
  db.pragma('foreign_keys = OFF');
  const tx = db.transaction(() => {
    db.exec(`
      DROP TABLE IF EXISTS cables;

      ALTER TABLE plan_items RENAME TO plan_items_old;

      CREATE TABLE plan_items (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          floor_plan_id  INTEGER NOT NULL REFERENCES floor_plans(id) ON DELETE CASCADE,
          item_type      TEXT NOT NULL CHECK (item_type IN ('desk','device','wall','door','stairs','other')),
          ref_id         INTEGER REFERENCES devices(id) ON DELETE SET NULL,
          x              INTEGER NOT NULL,
          y              INTEGER NOT NULL,
          x2             INTEGER,
          y2             INTEGER,
          rotation       INTEGER NOT NULL DEFAULT 0 CHECK (rotation IN (0,90,180,270)),
          width_cells    INTEGER NOT NULL DEFAULT 1,
          height_cells   INTEGER NOT NULL DEFAULT 1,
          label          TEXT,
          z_index        INTEGER NOT NULL DEFAULT 0
      );

      INSERT INTO plan_items (id, floor_plan_id, item_type, ref_id, x, y, rotation,
                               width_cells, height_cells, label, z_index)
      SELECT id, floor_plan_id, item_type, ref_id, x, y, rotation,
             width_cells, height_cells, label, z_index
      FROM plan_items_old;

      DROP TABLE plan_items_old;

      CREATE INDEX idx_planitems_plan ON plan_items(floor_plan_id);
      CREATE INDEX idx_planitems_plan_xy ON plan_items(floor_plan_id, x, y);
      CREATE INDEX idx_planitems_ref ON plan_items(ref_id);

      CREATE TABLE cables (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          floor_plan_id  INTEGER NOT NULL REFERENCES floor_plans(id) ON DELETE CASCADE,
          from_item_id   INTEGER NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
          to_item_id     INTEGER NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
          cable_type     TEXT NOT NULL DEFAULT 'network' CHECK (cable_type IN ('network','power','other')),
          label          TEXT,
          waypoints      TEXT NOT NULL DEFAULT '[]',
          CHECK (from_item_id <> to_item_id)
      );
      CREATE INDEX idx_cables_plan ON cables(floor_plan_id);
      CREATE INDEX idx_cables_from ON cables(from_item_id);
      CREATE INDEX idx_cables_to ON cables(to_item_id);

      DROP VIEW IF EXISTS device_latest_ping;
      CREATE VIEW device_latest_ping AS
      SELECT device_id, status, checked_at
      FROM (
          SELECT device_id, status, checked_at,
                 ROW_NUMBER() OVER (PARTITION BY device_id ORDER BY checked_at DESC, id DESC) AS rn
          FROM ping_log
      )
      WHERE rn = 1;
    `);
    db.pragma('user_version = 2');
  });
  tx();
  db.pragma('foreign_keys = ON');
}

/**
 * v2 -> v3: история владельцев устройства + комплектующие/периферия с историей.
 * Только новые таблицы — существующие данные не трогаются, пересоздавать нечего.
 */
function migrateToV3() {
  console.log('[db] миграция схемы v2 -> v3 (история владельцев, комплектующие, периферия)');
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS device_user_history (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          device_id     INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
          user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          assigned_at   TEXT,
          unassigned_at TEXT,
          note          TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_history_device ON device_user_history(device_id);
      CREATE INDEX IF NOT EXISTS idx_history_user ON device_user_history(user_id);

      CREATE TABLE IF NOT EXISTS device_components (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          device_id      INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
          component_type TEXT NOT NULL CHECK (component_type IN
                           ('motherboard','cpu','ram','disk','gpu','psu','other')),
          description    TEXT NOT NULL,
          attached_at    TEXT,
          detached_at    TEXT,
          note           TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_components_device ON device_components(device_id);

      CREATE TABLE IF NOT EXISTS device_peripherals (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          device_id       INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
          peripheral_type TEXT NOT NULL CHECK (peripheral_type IN
                            ('monitor','ups','keyboard','mouse','other')),
          description     TEXT NOT NULL,
          attached_at     TEXT,
          detached_at     TEXT,
          note            TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_peripherals_device ON device_peripherals(device_id);
    `);
    db.pragma('user_version = 3');
  });
  tx();
}

/**
 * v3 -> v4: ПО на устройствах, склад (комплектующие+ПО, снятые с устройств),
 * история статусов устройства. Только новые таблицы — существующие не трогаются.
 */
function migrateToV4() {
  console.log('[db] миграция схемы v3 -> v4 (ПО, склад, история статусов)');
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS device_software (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          device_id     INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
          software_type TEXT NOT NULL CHECK (software_type IN ('os','office','antivirus','other')),
          name          TEXT NOT NULL,
          license_key   TEXT,
          installed_at  TEXT,
          removed_at    TEXT,
          note          TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_software_device ON device_software(device_id);

      CREATE TABLE IF NOT EXISTS warehouse_items (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          category          TEXT NOT NULL CHECK (category IN ('component','software')),
          item_type         TEXT NOT NULL,
          description       TEXT NOT NULL,
          license_key       TEXT,
          source_device_id  INTEGER REFERENCES devices(id) ON DELETE SET NULL,
          added_at          TEXT NOT NULL DEFAULT (datetime('now')),
          removed_at        TEXT,
          target_device_id  INTEGER REFERENCES devices(id) ON DELETE SET NULL,
          note              TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_warehouse_status ON warehouse_items(category, removed_at);

      CREATE TABLE IF NOT EXISTS device_status_history (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
          status      TEXT NOT NULL,
          changed_at  TEXT NOT NULL DEFAULT (datetime('now')),
          note        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_status_history_device ON device_status_history(device_id);
    `);
    db.pragma('user_version = 4');
  });
  tx();
}

/**
 * v4 -> v5: статус и стоимость на складе, стоимость у комплектующих/ПО на устройствах.
 * Простые ALTER TABLE ADD COLUMN — без пересборки таблиц, данные не трогаются.
 * Примечание: CHECK на status здесь не добавляем (SQLite ALTER TABLE не годится для этого
 * так же чисто, как CREATE TABLE) — допустимые значения проверяются в JS-слое; на свежих
 * установках (см. schema.sql) колонка создаётся сразу с CHECK.
 */
function migrateToV5() {
  console.log('[db] миграция схемы v4 -> v5 (статус и стоимость склада, стоимость комплектующих/ПО)');
  const tx = db.transaction(() => {
    db.exec(`
      ALTER TABLE warehouse_items ADD COLUMN status TEXT NOT NULL DEFAULT 'in_stock';
      ALTER TABLE warehouse_items ADD COLUMN cost REAL;
      ALTER TABLE device_components ADD COLUMN cost REAL;
      ALTER TABLE device_software ADD COLUMN cost REAL;
      UPDATE warehouse_items SET status = 'issued' WHERE removed_at IS NOT NULL;
    `);
    db.pragma('user_version = 5');
  });
  tx();
}

/** v5 -> v6: зоны на плане (заливка + подпись). Только новая таблица, ничего не пересоздаётся. */
function migrateToV6() {
  console.log('[db] миграция схемы v5 -> v6 (зоны на плане)');
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS plan_zones (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          floor_plan_id  INTEGER NOT NULL REFERENCES floor_plans(id) ON DELETE CASCADE,
          name           TEXT NOT NULL,
          cells          TEXT NOT NULL,
          label_x        REAL,
          label_y        REAL,
          label_rotation REAL NOT NULL DEFAULT 0,
          label_visible  INTEGER NOT NULL DEFAULT 1,
          created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_zones_plan ON plan_zones(floor_plan_id);
    `);
    db.pragma('user_version = 6');
  });
  tx();
}

/**
 * v6 -> v7: увеличиваем сетку существующих планов минимум до "4K"-размера
 * (96×54 клеток по 40px = 3840×2160) — раньше по умолчанию было 20×20, тесно.
 * Только расширяем (MAX), никогда не сжимаем — существующие объекты остаются
 * на своих местах, просто вокруг них становится больше свободного поля.
 */
function migrateToV7() {
  console.log('[db] миграция схемы v6 -> v7 (увеличение сетки планов до 96×54)');
  const tx = db.transaction(() => {
    db.exec(`
      UPDATE floor_plans
      SET grid_width_cells = MAX(grid_width_cells, 96),
          grid_height_cells = MAX(grid_height_cells, 54);
    `);
    db.pragma('user_version = 7');
  });
  tx();
}

/**
 * v7 -> v8: статус пользователя (active/dismissed) — для фильтра "уволенные".
 * ALTER TABLE ADD COLUMN без CHECK (как и у warehouse_items.status в своё время) —
 * допустимые значения проверяются в JS-слое; на свежих установках CHECK есть сразу.
 */
function migrateToV8() {
  console.log('[db] миграция схемы v7 -> v8 (статус пользователя: active/dismissed)');
  const tx = db.transaction(() => {
    db.exec(`ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';`);
    db.pragma('user_version = 8');
  });
  tx();
}

/**
 * v8 -> v9: ручная пометка (flag: problem/attention/error) у пользователей, устройств,
 * складских позиций и ПО. ALTER TABLE ADD COLUMN без CHECK (валидация в JS, как и у
 * прежних добавленных таким же образом полей) — на свежих установках CHECK есть сразу.
 */
function migrateToV9() {
  console.log('[db] миграция схемы v8 -> v9 (ручные пометки Проблема/Внимание/Ошибка)');
  const tx = db.transaction(() => {
    db.exec(`
      ALTER TABLE users ADD COLUMN flag TEXT;
      ALTER TABLE devices ADD COLUMN flag TEXT;
      ALTER TABLE warehouse_items ADD COLUMN flag TEXT;
      ALTER TABLE device_software ADD COLUMN flag TEXT;
    `);
    db.pragma('user_version = 9');
  });
  tx();
}

/**
 * v9 -> v10: комментарий "на проверку" (review_note) прямо на объекте плана —
 * инструмент ручного комментирования, независимый от пометок Проблема/Внимание/Ошибка
 * у самих сущностей (устройство/пользователь/склад/ПО). NULL/пусто = нет пометки.
 */
function migrateToV10() {
  console.log('[db] миграция схемы v9 -> v10 (комментарий "на проверку" на объектах плана)');
  const tx = db.transaction(() => {
    db.exec(`ALTER TABLE plan_items ADD COLUMN review_note TEXT;`);
    db.pragma('user_version = 10');
  });
  tx();
}

/**
 * v10 -> v11: ручная связь uplink_device_id — куда подключён роутер/свитч, если кабель
 * провести нельзя (например, через этажи). Используется вкладкой "Сеть" в дополнение
 * к автоматически определяемым связям по уже нарисованным кабелям.
 */
function migrateToV11() {
  console.log('[db] миграция схемы v10 -> v11 (ручной аплинк для сетевой иерархии)');
  const tx = db.transaction(() => {
    db.exec(`ALTER TABLE devices ADD COLUMN uplink_device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL;`);
    db.pragma('user_version = 11');
  });
  tx();
}

/**
 * v11 -> v12: кабель становится самостоятельным объектом (полный путь + цвет), можно
 * провести без устройств на концах. Новая таблица cable_sockets — точки подключения на
 * кабеле; все устройства на сокетах одного кабеля образуют один сетевой сегмент.
 * plan_items получает socket_id (к какому сокету подключено) и network_role (роль
 * устройства, обычно роутера, в сети сегмента — если их несколько).
 *
 * Таблица cables пересоздаётся целиком: SQLite не даёт сменить NOT NULL -> NULL через
 * ALTER TABLE, а from_item_id/to_item_id были NOT NULL. Существующие кабели переносятся
 * с сохранением формы (path строится из старых from/to центров + waypoints), и на обоих
 * концах, если там реально устройство, создаётся сокет — старые связи продолжают
 * представлять валидный сетевой сегмент и после миграции.
 */
function migrateToV12() {
  console.log('[db] миграция схемы v11 -> v12 (кабель как путь + сокеты + роли в сети)');
  const tx = db.transaction(() => {
    db.exec(`ALTER TABLE plan_items ADD COLUMN network_role TEXT CHECK (network_role IN ('primary','backup','satellite'));`);

    db.exec(`
      CREATE TABLE cables_new (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          floor_plan_id  INTEGER NOT NULL REFERENCES floor_plans(id) ON DELETE CASCADE,
          from_item_id   INTEGER REFERENCES plan_items(id) ON DELETE SET NULL,
          to_item_id     INTEGER REFERENCES plan_items(id) ON DELETE SET NULL,
          cable_type     TEXT NOT NULL DEFAULT 'network' CHECK (cable_type IN ('network','power','other')),
          label          TEXT,
          waypoints      TEXT NOT NULL DEFAULT '[]',
          path           TEXT NOT NULL DEFAULT '[]',
          color          TEXT NOT NULL DEFAULT '#4a90d9',
          CHECK (from_item_id IS NULL OR to_item_id IS NULL OR from_item_id <> to_item_id)
      );
      INSERT INTO cables_new (id, floor_plan_id, from_item_id, to_item_id, cable_type, label, waypoints, path, color)
      SELECT id, floor_plan_id, from_item_id, to_item_id, cable_type, label, waypoints, '[]', '#4a90d9' FROM cables;
      DROP TABLE cables;
      ALTER TABLE cables_new RENAME TO cables;
      CREATE INDEX idx_cables_plan ON cables(floor_plan_id);
      CREATE INDEX idx_cables_from ON cables(from_item_id);
      CREATE INDEX idx_cables_to ON cables(to_item_id);
    `);

    db.exec(`
      CREATE TABLE cable_sockets (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          cable_id    INTEGER NOT NULL REFERENCES cables(id) ON DELETE CASCADE,
          x           REAL NOT NULL,
          y           REAL NOT NULL,
          label       TEXT,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_sockets_cable ON cable_sockets(cable_id);
    `);

    db.exec(`ALTER TABLE plan_items ADD COLUMN socket_id INTEGER REFERENCES cable_sockets(id) ON DELETE SET NULL;`);

    const cables = db.prepare('SELECT * FROM cables').all();
    const getItem = db.prepare('SELECT x, y, item_type FROM plan_items WHERE id = ?');
    const insertSocket = db.prepare('INSERT INTO cable_sockets (cable_id, x, y, label) VALUES (?, ?, ?, ?)');
    const updateItemSocket = db.prepare('UPDATE plan_items SET socket_id = ? WHERE id = ?');
    const updateCablePath = db.prepare('UPDATE cables SET path = ? WHERE id = ?');

    cables.forEach((cable) => {
      const from = cable.from_item_id ? getItem.get(cable.from_item_id) : null;
      const to = cable.to_item_id ? getItem.get(cable.to_item_id) : null;
      const waypoints = JSON.parse(cable.waypoints || '[]');
      const path = [];
      if (from) path.push({ x: from.x + 0.5, y: from.y + 0.5 });
      waypoints.forEach((w) => path.push({ x: w.x, y: w.y }));
      if (to) path.push({ x: to.x + 0.5, y: to.y + 0.5 });
      updateCablePath.run(JSON.stringify(path), cable.id);

      if (from && from.item_type === 'device') {
        const socket = insertSocket.run(cable.id, from.x + 0.5, from.y + 0.5, null);
        updateItemSocket.run(socket.lastInsertRowid, cable.from_item_id);
      }
      if (to && to.item_type === 'device') {
        const socket = insertSocket.run(cable.id, to.x + 0.5, to.y + 0.5, null);
        updateItemSocket.run(socket.lastInsertRowid, cable.to_item_id);
      }
    });

    db.pragma('user_version = 12');
  });
  tx();
}

/**
 * v12 -> v13: отказ от сокетов как отдельной сущности — устройство подключается
 * напрямую к кабелю (условному сетевому пучку). Многие-ко-многим: многопортовый
 * роутер/свитч может быть подключён к нескольким кабелям сразу, конечное устройство —
 * только к одному (обеспечивается в коде репозитория, не ограничением схемы).
 * Старые сокетные подключения НЕ переносятся — по явной договорённости, сеть на момент
 * миграции ещё не была спроектирована всерьёз.
 */
function migrateToV13() {
  console.log('[db] миграция схемы v12 -> v13 (кабель без сокетов — прямое подключение устройства к кабелю)');
  const tx = db.transaction(() => {
    db.exec(`DROP TABLE IF EXISTS cable_sockets;`);
    db.exec(`ALTER TABLE plan_items DROP COLUMN socket_id;`);
    db.exec(`
      CREATE TABLE cable_connections (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          plan_item_id  INTEGER NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
          cable_id      INTEGER NOT NULL REFERENCES cables(id) ON DELETE CASCADE,
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(plan_item_id, cable_id)
      );
      CREATE INDEX idx_cable_connections_item ON cable_connections(plan_item_id);
      CREATE INDEX idx_cable_connections_cable ON cable_connections(cable_id);
    `);
    db.pragma('user_version = 13');
  });
  tx();
}

/** v13 -> v14: журнал изменений — лог всех значимых действий пользователя. */
function migrateToV14() {
  console.log('[db] миграция схемы v13 -> v14 (журнал изменений)');
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE audit_log (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          entity_type  TEXT NOT NULL,
          entity_id    INTEGER,
          action       TEXT NOT NULL,
          summary      TEXT NOT NULL
      );
      CREATE INDEX idx_audit_log_created ON audit_log(created_at);
      CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id);
    `);
    db.pragma('user_version = 14');
  });
  tx();
}

/**
 * v14 -> v15: смягчаем ограничение на host_device_id у VM. Раньше СХЕМА требовала,
 * чтобы у любой VM обязательно был указан физический хост (host_device_id NOT NULL),
 * но ни быстрая форма создания устройства, ни форма редактирования никогда не давали
 * способа этот хост выбрать — из-за этого создание VM было в принципе невозможно через
 * обычный интерфейс (падало на CHECK constraint). Хост по-прежнему МОЖНО указать (в
 * форме теперь есть поле выбора — см. renderer/index.js), но он больше не обязателен.
 * Направление ограничения "у НЕ-VM хоста быть не может" сохранено — это по-прежнему
 * осмысленно (только VM разумно привязывать к физическому серверу).
 */
function migrateToV15() {
  console.log('[db] миграция схемы v14 -> v15 (host_device_id у VM больше не обязателен)');
  db.pragma('foreign_keys = OFF'); // PRAGMA foreign_keys нельзя менять внутри активной транзакции
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE devices_new (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          device_type       TEXT NOT NULL CHECK (device_type IN
                              ('computer','laptop','server','vm','router','switch','printer','other')),
          inventory_number  TEXT UNIQUE,
          hostname          TEXT,
          os                TEXT,
          cpu               TEXT,
          ram               TEXT,
          disk              TEXT,
          owner_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
          host_device_id    INTEGER REFERENCES devices(id) ON DELETE CASCADE,
          uplink_device_id  INTEGER REFERENCES devices(id) ON DELETE SET NULL,
          status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN
                              ('active','repair','storage','decommissioned')),
          flag              TEXT CHECK (flag IN ('problem','attention','error')),
          purchase_date     TEXT,
          warranty_until    TEXT,
          notes             TEXT,
          created_at        TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
          CHECK (device_type = 'vm' OR host_device_id IS NULL)
      );
      INSERT INTO devices_new (id, device_type, inventory_number, hostname, os, cpu, ram, disk,
                                owner_user_id, host_device_id, uplink_device_id, status, flag,
                                purchase_date, warranty_until, notes, created_at, updated_at)
      SELECT id, device_type, inventory_number, hostname, os, cpu, ram, disk,
             owner_user_id, host_device_id, uplink_device_id, status, flag,
             purchase_date, warranty_until, notes, created_at, updated_at
      FROM devices;
      DROP TABLE devices;
      ALTER TABLE devices_new RENAME TO devices;
      CREATE INDEX idx_devices_owner ON devices(owner_user_id);
      CREATE INDEX idx_devices_type ON devices(device_type);
      CREATE INDEX idx_devices_status ON devices(status);
      CREATE INDEX idx_devices_host ON devices(host_device_id);
    `);
    db.pragma('user_version = 15');
  });
  tx();
  db.pragma('foreign_keys = ON');
}

/**
 * v15 -> v16: группировка устройств в одной клетке (например, шкаф с несколькими
 * юнитами) — по аналогии с папками на Android: второе устройство, попавшее на уже
 * занятую клетку, образует группу вместо перекрытия/конфликта. item_type='group' —
 * такой же точечный plan_item, как device/desk, только вместо ref_id на одно
 * устройство ссылается таблица plan_item_group_members (многие устройства на одну
 * группу). group_label — необязательное название группы (например "Шкаф А1").
 */
function migrateToV16() {
  console.log('[db] миграция схемы v15 -> v16 (группировка устройств в клетке)');
  db.pragma('foreign_keys = OFF');
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE plan_items_new (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          floor_plan_id  INTEGER NOT NULL REFERENCES floor_plans(id) ON DELETE CASCADE,
          item_type      TEXT NOT NULL CHECK (item_type IN ('desk','device','wall','door','stairs','other','group')),
          ref_id         INTEGER REFERENCES devices(id) ON DELETE SET NULL,
          x              INTEGER NOT NULL,
          y              INTEGER NOT NULL,
          x2             INTEGER,
          y2             INTEGER,
          rotation       INTEGER NOT NULL DEFAULT 0 CHECK (rotation IN (0,90,180,270)),
          width_cells    INTEGER NOT NULL DEFAULT 1,
          height_cells   INTEGER NOT NULL DEFAULT 1,
          label          TEXT,
          z_index        INTEGER NOT NULL DEFAULT 0,
          review_note    TEXT,
          network_role   TEXT CHECK (network_role IN ('primary','backup','satellite')),
          group_label    TEXT  -- название группы (только для item_type='group'), например "Шкаф А1"
      );
      INSERT INTO plan_items_new (id, floor_plan_id, item_type, ref_id, x, y, x2, y2, rotation,
                                   width_cells, height_cells, label, z_index, review_note, network_role)
      SELECT id, floor_plan_id, item_type, ref_id, x, y, x2, y2, rotation,
             width_cells, height_cells, label, z_index, review_note, network_role
      FROM plan_items;
      DROP TABLE plan_items;
      ALTER TABLE plan_items_new RENAME TO plan_items;
      CREATE INDEX idx_planitems_plan ON plan_items(floor_plan_id);
      CREATE INDEX idx_planitems_plan_xy ON plan_items(floor_plan_id, x, y);
      CREATE INDEX idx_planitems_ref ON plan_items(ref_id);

      CREATE TABLE plan_item_group_members (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          group_item_id   INTEGER NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
          device_id       INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
          added_at        TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(group_item_id, device_id)
      );
      CREATE INDEX idx_group_members_group ON plan_item_group_members(group_item_id);
      CREATE INDEX idx_group_members_device ON plan_item_group_members(device_id);
    `);
    db.pragma('user_version = 16');
  });
  tx();
  db.pragma('foreign_keys = ON');
}

/**
 * v16 -> v17: произвольный угол поворота и смещение внутри клетки.
 *
 * rotation раньше был ограничен CHECK (0,90,180,270) — этого хватало, пока поворот
 * кодировал только направление лестницы и hinge/swing двери. Для размещения устройств
 * вдоль скошенных стен нужен любой угол, поэтому CHECK снимается (таблица пересоздаётся —
 * SQLite не умеет ALTER ... DROP CONSTRAINT), а значения нормализуются в 0..359.
 *
 * offset_x/offset_y — положение внутри собственной клетки в ДОЛЯХ клетки (-0.5..+0.5),
 * а не в пикселях: при смене размера клетки (CELL_PX) или масштаба сетки смещение
 * сохраняет смысл, пиксельное бы "поехало". 0,0 — центр клетки, как и было раньше.
 */
function migrateToV17() {
  console.log('[db] миграция схемы v16 -> v17 (произвольный поворот, смещение внутри клетки)');
  db.pragma('foreign_keys = OFF');
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE plan_items_new (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          floor_plan_id  INTEGER NOT NULL REFERENCES floor_plans(id) ON DELETE CASCADE,
          item_type      TEXT NOT NULL CHECK (item_type IN ('desk','device','wall','door','stairs','other','group')),
          ref_id         INTEGER REFERENCES devices(id) ON DELETE SET NULL,
          x              INTEGER NOT NULL,
          y              INTEGER NOT NULL,
          x2             INTEGER,
          y2             INTEGER,
          rotation       INTEGER NOT NULL DEFAULT 0 CHECK (rotation >= 0 AND rotation < 360),
          offset_x       REAL NOT NULL DEFAULT 0 CHECK (offset_x >= -0.5 AND offset_x <= 0.5),
          offset_y       REAL NOT NULL DEFAULT 0 CHECK (offset_y >= -0.5 AND offset_y <= 0.5),
          width_cells    INTEGER NOT NULL DEFAULT 1,
          height_cells   INTEGER NOT NULL DEFAULT 1,
          label          TEXT,
          z_index        INTEGER NOT NULL DEFAULT 0,
          review_note    TEXT,
          network_role   TEXT CHECK (network_role IN ('primary','backup','satellite')),
          group_label    TEXT
      );
      INSERT INTO plan_items_new (id, floor_plan_id, item_type, ref_id, x, y, x2, y2, rotation,
                                   width_cells, height_cells, label, z_index, review_note, network_role, group_label)
      SELECT id, floor_plan_id, item_type, ref_id, x, y, x2, y2,
             ((rotation % 360) + 360) % 360,
             width_cells, height_cells, label, z_index, review_note, network_role, group_label
      FROM plan_items;
      DROP TABLE plan_items;
      ALTER TABLE plan_items_new RENAME TO plan_items;
      CREATE INDEX idx_planitems_plan ON plan_items(floor_plan_id);
      CREATE INDEX idx_planitems_plan_xy ON plan_items(floor_plan_id, x, y);
      CREATE INDEX idx_planitems_ref ON plan_items(ref_id);
    `);
    db.pragma('user_version = 17');
  });
  tx();
  db.pragma('foreign_keys = ON');
}

/**
 * v17 -> v18: условная перегородка ('border' в item_type), ручная ширина двери и
 * условный радиус охвата Wi-Fi.
 *
 * plan_items снова пересоздаётся: SQLite не умеет менять CHECK у существующего
 * столбца, а в item_type надо добавить 'border'. Заодно появляется door_width.
 * devices обходятся обычным ALTER TABLE ADD COLUMN — там CHECK только на новом
 * столбце, пересоздавать таблицу не нужно.
 */
function migrateToV18() {
  console.log('[db] миграция схемы v17 -> v18 (перегородка, ширина двери, охват Wi-Fi)');
  db.pragma('foreign_keys = OFF');
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE plan_items_new (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          floor_plan_id  INTEGER NOT NULL REFERENCES floor_plans(id) ON DELETE CASCADE,
          item_type      TEXT NOT NULL CHECK (item_type IN ('desk','device','wall','door','stairs','border','other','group')),
          ref_id         INTEGER REFERENCES devices(id) ON DELETE SET NULL,
          x              INTEGER NOT NULL,
          y              INTEGER NOT NULL,
          x2             INTEGER,
          y2             INTEGER,
          rotation       INTEGER NOT NULL DEFAULT 0 CHECK (rotation >= 0 AND rotation < 360),
          offset_x       REAL NOT NULL DEFAULT 0 CHECK (offset_x >= -0.5 AND offset_x <= 0.5),
          offset_y       REAL NOT NULL DEFAULT 0 CHECK (offset_y >= -0.5 AND offset_y <= 0.5),
          width_cells    INTEGER NOT NULL DEFAULT 1,
          height_cells   INTEGER NOT NULL DEFAULT 1,
          label          TEXT,
          z_index        INTEGER NOT NULL DEFAULT 0,
          review_note    TEXT,
          network_role   TEXT CHECK (network_role IN ('primary','backup','satellite')),
          group_label    TEXT,
          door_width     REAL NOT NULL DEFAULT 0.9 CHECK (door_width > 0 AND door_width <= 20)
      );
      INSERT INTO plan_items_new (id, floor_plan_id, item_type, ref_id, x, y, x2, y2, rotation,
                                   offset_x, offset_y, width_cells, height_cells, label, z_index,
                                   review_note, network_role, group_label, door_width)
      SELECT id, floor_plan_id, item_type, ref_id, x, y, x2, y2, rotation,
             offset_x, offset_y, width_cells, height_cells, label, z_index,
             review_note, network_role, group_label,
             0.9  -- уже расставленные двери получают стандартные 0.9 м; у остальных типов поле не используется
      FROM plan_items;
      DROP TABLE plan_items;
      ALTER TABLE plan_items_new RENAME TO plan_items;
      CREATE INDEX idx_planitems_plan ON plan_items(floor_plan_id);
      CREATE INDEX idx_planitems_plan_xy ON plan_items(floor_plan_id, x, y);
      CREATE INDEX idx_planitems_ref ON plan_items(ref_id);
    `);
    // Радиус охвата: NULL значит "брать значение по умолчанию", поэтому заполнять
    // существующие строки не нужно — они и так получат умолчание при отрисовке.
    // Проверяем наличие столбца: ADD COLUMN на уже существующем столбце — жёсткая
    // ошибка, которая оборвала бы миграцию и не дала открыть приложение вообще. Такое
    // возможно, если базу один раз открыли новой версией, а потом откатились на старую.
    const deviceColumns = db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name);
    if (!deviceColumns.includes('wifi_radius_m')) {
      db.exec(`
        ALTER TABLE devices ADD COLUMN wifi_radius_m REAL
          CHECK (wifi_radius_m IS NULL OR (wifi_radius_m > 0 AND wifi_radius_m <= 500));
      `);
    }
    db.pragma('user_version = 18');
  });
  tx();
  db.pragma('foreign_keys = ON');
}

/**
 * v18 -> v19: у плана появляется начало координат (grid_min_x / grid_min_y).
 *
 * До этого прямоугольник плана всегда начинался в (0,0), и всё, что чертили выше или
 * левее этой точки, оказывалось за его пределами — а по границам плана ограничены
 * заливка зон и привязка смещения. Выглядело это так: объекты в отрицательной области
 * видны и двигаются, а зону там создать нельзя.
 *
 * Таблицу пересоздавать не нужно: только добавляем столбцы со значением по умолчанию 0,
 * то есть у всех существующих планов начало координат остаётся прежним. Подтянуть
 * границы под реально начерченное — задача fitToContent при открытии этажа.
 */
function migrateToV19() {
  console.log('[db] миграция схемы v18 -> v19 (начало координат плана)');
  const tx = db.transaction(() => {
    const columns = db.prepare('PRAGMA table_info(floor_plans)').all().map((c) => c.name);
    // ADD COLUMN на существующем столбце — жёсткая ошибка, которая оборвала бы миграцию
    if (!columns.includes('grid_min_x')) {
      db.exec('ALTER TABLE floor_plans ADD COLUMN grid_min_x INTEGER NOT NULL DEFAULT 0;');
    }
    if (!columns.includes('grid_min_y')) {
      db.exec('ALTER TABLE floor_plans ADD COLUMN grid_min_y INTEGER NOT NULL DEFAULT 0;');
    }
    db.pragma('user_version = 19');
  });
  tx();
}

/**
 * v19 -> v20: связь карточки пользователя с сотрудником Битрикс24 (задача #3).
 *
 * Только новые столбцы со значением NULL — существующие карточки остаются несвязанными
 * и ведутся локально, как раньше. Уникальность внешнего ID обеспечивает индекс, а не
 * проверка в коде: проверка «а нет ли уже такой карточки» с последующей вставкой — это
 * два шага, между которыми успеет вклиниться второе сохранение.
 */
function migrateToV20() {
  console.log('[db] миграция схемы v19 -> v20 (связь пользователей с Битрикс24)');
  const tx = db.transaction(() => {
    const columns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    // ADD COLUMN на существующем столбце — жёсткая ошибка, которая оборвала бы миграцию
    if (!columns.includes('bitrix_id')) {
      db.exec('ALTER TABLE users ADD COLUMN bitrix_id INTEGER CHECK (bitrix_id IS NULL OR bitrix_id > 0);');
    }
    if (!columns.includes('bitrix_synced_at')) {
      db.exec('ALTER TABLE users ADD COLUMN bitrix_synced_at TEXT;');
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_bitrix_id ON users(bitrix_id);');
    db.pragma('user_version = 20');
  });
  tx();
}

/**
 * v20 -> v21: счета поставщиков (задача #8) — оригиналы документов, карточки счетов и
 * позиции. Только новые таблицы, существующие данные не трогаются. IF NOT EXISTS —
 * чтобы прерванную на середине миграцию можно было безопасно повторить.
 */
function migrateToV21() {
  console.log('[db] миграция схемы v20 -> v21 (счета поставщиков из PDF)');
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS document_files (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          sha256       TEXT NOT NULL UNIQUE CHECK (length(sha256) = 64),
          file_name    TEXT NOT NULL,
          mime_type    TEXT NOT NULL DEFAULT 'application/pdf',
          size_bytes   INTEGER NOT NULL CHECK (size_bytes > 0),
          page_count   INTEGER,
          content      BLOB NOT NULL,
          created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS invoices (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          file_id        INTEGER NOT NULL UNIQUE REFERENCES document_files(id),
          number         TEXT NOT NULL,
          invoice_date   TEXT NOT NULL,
          supplier_name  TEXT NOT NULL,
          supplier_inn   TEXT,
          supplier_kpp   TEXT,
          buyer_name     TEXT,
          buyer_inn      TEXT,
          buyer_kpp      TEXT,
          currency       TEXT,
          total_amount   TEXT,
          vat_amount     TEXT,
          amount_due     TEXT,
          vat_note       TEXT,
          notes          TEXT,
          recognition    TEXT,
          revision       INTEGER NOT NULL DEFAULT 1,
          created_at     TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_invoices_requisites ON invoices(supplier_inn, number, invoice_date);
      CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(invoice_date);
      CREATE TABLE IF NOT EXISTS invoice_items (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          invoice_id   INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
          position     INTEGER NOT NULL CHECK (position > 0),
          name         TEXT NOT NULL,
          code         TEXT,
          unit         TEXT,
          quantity     TEXT,
          price        TEXT,
          amount       TEXT,
          vat_rate     TEXT,
          vat_amount   TEXT,
          UNIQUE (invoice_id, position)
      );
    `);
    db.pragma('user_version = 21');
  });
  tx();
}

function getDb() {
  if (!db) throw new Error('DB ещё не инициализирована — вызови initDatabase() при старте приложения');
  return db;
}

// ------------------------------------------------------------
// Репозитории — вся "сырая" работа с SQL живёт только здесь
// ------------------------------------------------------------

const usersRepo = {
  list() {
    return getDb().prepare('SELECT * FROM users ORDER BY full_name').all();
  },
  create({ full_name, department = null, position = null, email = null, phone = null, notes = null }) {
    const stmt = getDb().prepare(`
      INSERT INTO users (full_name, department, position, email, phone, notes)
      VALUES (@full_name, @department, @position, @email, @phone, @notes)
    `);
    const info = stmt.run({ full_name, department, position, email, phone, notes });
    const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    auditLogRepo.log('user', user.id, 'create', `Пользователь «${user.full_name}» создан`);
    return user;
  },
  remove(id) {
    const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
    getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
    if (user) auditLogRepo.log('user', id, 'delete', `Пользователь «${user.full_name}» удалён безвозвратно`);
    return { id };
  },
  update(id, { full_name, department = null, position = null, email = null, phone = null, notes = null }) {
    getDb().prepare(`
      UPDATE users SET full_name = ?, department = ?, position = ?, email = ?, phone = ?, notes = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(full_name, department, position, email, phone, notes, id);
    const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
    auditLogRepo.log('user', id, 'update', `Пользователь «${user.full_name}» отредактирован`);
    return user;
  },
  /** Быстрое увольнение/восстановление — отдельно от общей формы редактирования, как и у устройств */
  setStatus(id, status) {
    if (status !== 'active' && status !== 'dismissed') throw new Error('Недопустимый статус');
    getDb().prepare(`UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
    const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
    auditLogRepo.log('user', id, 'status_change',
      status === 'dismissed' ? `Пользователь «${user.full_name}» уволен` : `Пользователь «${user.full_name}» восстановлен в правах`);
    return user;
  },
  /** Ручная пометка Проблема/Внимание/Ошибка — null снимает пометку */
  setFlag(id, flag) {
    if (flag !== null && !FLAG_VALUES.includes(flag)) throw new Error('Недопустимая пометка');
    getDb().prepare(`UPDATE users SET flag = ? WHERE id = ?`).run(flag, id);
    const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
    auditLogRepo.log('user', id, 'update',
      flag ? `Пользователю «${user.full_name}» поставлена пометка «${FLAG_LABELS_RU[flag] || flag}»` : `С пользователя «${user.full_name}» снята пометка`);
    return user;
  }
};

// ------------------------------------------------------------
// Синхронизация карточек пользователей из Битрикс24 (задача #3)
// ------------------------------------------------------------
//
// Профиль приходит из src/main/bitrix.js уже в терминах NetworkMap. Здесь — только
// сопоставление с карточкой и запись. Правила:
//   - пишем только в NetworkMap и только после подтверждения оператора;
//   - если карточка уже связана с этим ID — обновляется она же; при первой синхронизации
//     оператор явно выбирает: создать новую или связать с существующей;
//   - пустое поле в Битрикс24 не стирает заполненное локальное значение;
//   - заметки, статус, пометка, устройства и их история не трогаются вовсе;
//   - статус «уволен» по неактивному профилю НЕ ставится — только предупреждение.
//
// preview и apply строят один и тот же план (buildBitrixPlan). apply делает это
// повторно внутри транзакции и сверяет отпечаток с тем, что видел оператор: если с
// момента предпросмотра изменились данные в Битрикс24, локальная карточка или связь,
// запись отклоняется с просьбой проверить предпросмотр заново. Так оператор сохраняет
// ровно то, что ему показали, а не то, что успело прийти позже.

/** Поля карточки, которые заполняются из Битрикс24, — в порядке показа. */
const BITRIX_SYNC_FIELDS = [
  { field: 'full_name', label: 'ФИО', profileKey: 'fullName' },
  { field: 'position', label: 'Должность', profileKey: 'position' },
  { field: 'department', label: 'Подразделение', profileKey: 'department' },
  { field: 'email', label: 'Email', profileKey: 'email' },
  { field: 'phone', label: 'Телефон', profileKey: 'phone' }
];

function localText(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s || null;
}

/** action: 'set' — поле было пустым и заполнится; 'change' — значение заменится;
 *  'same' — уже совпадает; 'keep' — в Битрикс24 пусто, локальное значение остаётся;
 *  'empty' — пусто и там, и там. */
function diffBitrixFields(localUser, profile) {
  return BITRIX_SYNC_FIELDS.map(({ field, label, profileKey }) => {
    const from = localUser ? localText(localUser[field]) : null;
    const incoming = localText(profile[profileKey]);
    let action;
    if (incoming === null) action = from === null ? 'empty' : 'keep';
    else if (incoming === from) action = 'same';
    else action = from === null ? 'set' : 'change';
    const to = (action === 'set' || action === 'change') ? incoming : from;
    return { field, label, from, to, action };
  });
}

/** Отпечаток всего, что оператор видел перед сохранением. Кроме изменений полей сюда
 *  входит то, что показывается, но в карточку не пишется: активность (иначе профиль,
 *  ставший неактивным после предпросмотра, сохранился бы без предупреждения), остальные
 *  предупреждения, ID подразделений и источник телефона. */
function bitrixFingerprint(bitrixId, target, changes, profile, warnings) {
  const canonical = JSON.stringify({
    v: 2,
    bitrixId,
    target: { mode: target.mode, userId: target.userId || null },
    changes: changes.map((c) => [c.field, c.from, c.to, c.action]),
    active: profile.active === undefined ? null : profile.active,
    warnings: [...warnings].sort(),
    departmentIds: [...(profile.departmentIds || [])],
    phoneSource: profile.phoneSource || null
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function publicUserRow(u) {
  return u ? {
    id: u.id, full_name: u.full_name, department: u.department, position: u.position,
    email: u.email, phone: u.phone, status: u.status, bitrix_id: u.bitrix_id ?? null
  } : null;
}

/**
 * Общее ядро preview/apply. requestedTarget — выбор оператора при первой синхронизации:
 * { mode: 'create' } или { mode: 'link', userId }. Если связь уже есть, выбор не нужен и
 * игнорируется — цель всегда связанная карточка.
 */
function buildBitrixPlan(profile, requestedTarget) {
  const db = getDb();
  const bitrixId = profile.bitrixId;
  const linked = db.prepare('SELECT * FROM users WHERE bitrix_id = ?').get(bitrixId) || null;

  const warnings = [];
  if (profile.active === false) warnings.push('inactive');
  if (!profile.department && profile.departmentIds && profile.departmentIds.length) warnings.push('department_ids_only');

  const plan = {
    bitrixId,
    linkedUser: publicUserRow(linked),
    target: null,
    needsTarget: false,
    candidates: [],
    changes: [],
    hasChanges: false,
    warnings,
    canApply: false,
    blockReason: null,
    fingerprint: null,
    targetUser: null
  };

  let targetUser = null;
  if (linked) {
    plan.target = { mode: 'linked', userId: linked.id };
    targetUser = linked;
  } else {
    // Кандидаты для ручной привязки: все ещё не связанные карточки. Совпадения по email и
    // ФИО — первыми и с подписью, но НЕ выбираются автоматически: решает оператор.
    const email = localText(profile.email);
    const name = localText(profile.fullName);
    const unlinked = db.prepare('SELECT * FROM users WHERE bitrix_id IS NULL ORDER BY full_name').all();
    plan.candidates = unlinked.map((u) => {
      const match = [];
      if (email && localText(u.email) && localText(u.email).toLowerCase() === email.toLowerCase()) match.push('email');
      if (name && localText(u.full_name) && localText(u.full_name).toLowerCase() === name.toLowerCase()) match.push('name');
      return { ...publicUserRow(u), match };
    }).sort((a, b) => (b.match.length - a.match.length) || 0);

    const mode = requestedTarget && requestedTarget.mode;
    if (mode === 'create') {
      plan.target = { mode: 'create' };
    } else if (mode === 'link') {
      const userId = Number(requestedTarget.userId);
      targetUser = Number.isInteger(userId) ? db.prepare('SELECT * FROM users WHERE id = ?').get(userId) : null;
      if (!targetUser) {
        plan.needsTarget = true;
        plan.blockReason = 'Выбранная карточка не найдена — возможно, её уже удалили. Выберите другую.';
        return plan;
      }
      if (targetUser.bitrix_id !== null && targetUser.bitrix_id !== undefined) {
        plan.needsTarget = true;
        plan.blockReason = `Карточка «${targetUser.full_name}» уже связана с другим сотрудником Битрикс24 (ID ${targetUser.bitrix_id}).`;
        return plan;
      }
      plan.target = { mode: 'link', userId: targetUser.id };
    } else {
      plan.needsTarget = true;
      plan.blockReason = 'Сотрудник ещё не связан с карточкой NetworkMap — выберите: создать новую карточку или связать с существующей.';
      return plan;
    }
  }

  plan.targetUser = publicUserRow(targetUser);
  plan.changes = diffBitrixFields(targetUser, profile);
  plan.hasChanges = plan.changes.some((c) => c.action === 'set' || c.action === 'change');

  if (plan.target.mode === 'create' && !localText(profile.fullName)) {
    plan.blockReason = 'У сотрудника в Битрикс24 не заполнено ФИО — новую карточку создать нельзя. Свяжите его с существующей.';
  } else if (plan.target.mode === 'linked' && !plan.hasChanges) {
    plan.blockReason = 'Данные в карточке уже совпадают с Битрикс24 — сохранять нечего.';
  } else {
    plan.canApply = true;
  }
  plan.fingerprint = bitrixFingerprint(bitrixId, plan.target, plan.changes, profile, warnings);
  return plan;
}

function staleBitrixPreview() {
  return new Error('Данные изменились после предпросмотра (в Битрикс24 — включая активность сотрудника, в карточке или в связи с ней). ' +
    'Нажмите «Найти» ещё раз и проверьте изменения перед сохранением.');
}

const bitrixSyncRepo = {
  FIELDS: BITRIX_SYNC_FIELDS,

  /** Предпросмотр: ничего не пишет. Возвращает план и отпечаток для apply. */
  preview(profile, requestedTarget = null) {
    const plan = buildBitrixPlan(profile, requestedTarget);
    return { ...plan, profile };
  },

  /**
   * Сохранение по подтверждённому предпросмотру. requestedTarget и fingerprint — ровно то,
   * что вернул preview. Транзакция IMMEDIATE: блокировку на запись берём сразу, до чтения,
   * чтобы между сверкой и записью никто не вклинился. Уникальный индекс по bitrix_id —
   * последний рубеж на случай, если вклиниться всё же попробует другой процесс.
   */
  apply(profile, requestedTarget, fingerprint) {
    const db = getDb();
    const run = db.transaction(() => {
      const plan = buildBitrixPlan(profile, requestedTarget);
      if (plan.needsTarget) throw new Error(plan.blockReason);
      const requestedMode = requestedTarget && requestedTarget.mode;
      // Связь появилась или пропала после предпросмотра — оператор видел другой сценарий
      if (plan.target.mode === 'linked' ? requestedMode !== 'linked' : requestedMode === 'linked') throw staleBitrixPreview();
      if (plan.target.mode === 'linked' && Number(requestedTarget.userId) !== plan.target.userId) throw staleBitrixPreview();
      if (!fingerprint || plan.fingerprint !== fingerprint) throw staleBitrixPreview();
      if (!plan.canApply) throw new Error(plan.blockReason);

      const changed = plan.changes.filter((c) => c.action === 'set' || c.action === 'change');
      const changedLabels = changed.map((c) => c.label.toLowerCase());
      let userId;

      if (plan.target.mode === 'create') {
        const values = {};
        plan.changes.forEach((c) => { values[c.field] = c.to; });
        const info = db.prepare(`
          INSERT INTO users (full_name, department, position, email, phone, bitrix_id, bitrix_synced_at)
          VALUES (@full_name, @department, @position, @email, @phone, @bitrix_id, datetime('now'))
        `).run({ ...values, bitrix_id: plan.bitrixId });
        userId = Number(info.lastInsertRowid);
        auditLogRepo.log('user', userId, 'create',
          `Пользователь «${values.full_name}» создан по данным Битрикс24 (ID ${plan.bitrixId})`);
      } else {
        userId = plan.target.userId;
        const sets = changed.map((c) => `${c.field} = @${c.field}`);
        const params = { id: userId, bitrix_id: plan.bitrixId };
        changed.forEach((c) => { params[c.field] = c.to; });
        // Имена столбцов — только из BITRIX_SYNC_FIELDS, не из запроса: подстановка безопасна
        const info = db.prepare(`
          UPDATE users SET ${sets.length ? `${sets.join(', ')}, ` : ''}
                 bitrix_id = @bitrix_id, bitrix_synced_at = datetime('now'), updated_at = datetime('now')
          WHERE id = @id AND (bitrix_id IS NULL OR bitrix_id = @bitrix_id)
        `).run(params);
        if (info.changes !== 1) throw staleBitrixPreview();
        const name = db.prepare('SELECT full_name FROM users WHERE id = ?').get(userId).full_name;
        if (plan.target.mode === 'link') {
          auditLogRepo.log('user', userId, 'update',
            `Пользователь «${name}» связан с сотрудником Битрикс24 (ID ${plan.bitrixId})` +
            (changedLabels.length ? `; обновлено: ${changedLabels.join(', ')}` : ''));
        } else {
          auditLogRepo.log('user', userId, 'update',
            `Пользователь «${name}» обновлён по данным Битрикс24 (ID ${plan.bitrixId}): ${changedLabels.join(', ')}`);
        }
      }

      return {
        user: db.prepare('SELECT * FROM users WHERE id = ?').get(userId),
        created: plan.target.mode === 'create',
        newlyLinked: plan.target.mode !== 'linked', // связь появилась этим сохранением
        changedFields: changed.map((c) => c.field)
      };
    });

    try {
      return run.immediate();
    } catch (err) {
      if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new Error(`Сотрудник Битрикс24 с ID ${profile.bitrixId} уже связан с другой карточкой — ` +
          'вероятно, её только что сохранили с другого рабочего места. Нажмите «Найти» ещё раз.');
      }
      throw err;
    }
  }
};

const devicesRepo = {
  list() {
    // primary-интерфейс, статус пинга и имя+статус текущего владельца — чтобы UI не делал N+1 запросов
    return getDb().prepare(`
      SELECT d.*,
             ni.ip_address    AS primary_ip,
             ni.mac_address   AS primary_mac,
             dlp.status       AS last_ping_status,
             dlp.checked_at   AS last_ping_at,
             u.full_name      AS owner_name,
             u.status         AS owner_status
      FROM devices d
      LEFT JOIN network_interfaces ni ON ni.device_id = d.id AND ni.is_primary = 1
      LEFT JOIN device_latest_ping dlp ON dlp.device_id = d.id
      LEFT JOIN users u ON u.id = d.owner_user_id
      ORDER BY d.hostname
    `).all();
  },
  /** VM, у которых host_device_id указывает на это устройство — обратная сторона связи
   *  "у VM есть физический хост" (см. host_device_id в схеме): раньше это было видно
   *  только В КАРТОЧКЕ VM (какой у неё хост), а сам физический сервер никак не показывал,
   *  какие VM на нём работают. Те же поля, что и в list(), для единообразия отрисовки. */
  listVMsByHost(hostDeviceId) {
    return getDb().prepare(`
      SELECT d.*,
             ni.ip_address    AS primary_ip,
             ni.mac_address   AS primary_mac,
             dlp.status       AS last_ping_status,
             dlp.checked_at   AS last_ping_at,
             u.full_name      AS owner_name,
             u.status         AS owner_status
      FROM devices d
      LEFT JOIN network_interfaces ni ON ni.device_id = d.id AND ni.is_primary = 1
      LEFT JOIN device_latest_ping dlp ON dlp.device_id = d.id
      LEFT JOIN users u ON u.id = d.owner_user_id
      WHERE d.host_device_id = ?
      ORDER BY d.hostname
    `).all(hostDeviceId);
  },
  create({ device_type, hostname = null, inventory_number = null, os = null, cpu = null,
           ram = null, disk = null, owner_user_id = null, host_device_id = null,
           status = 'active', notes = null, ip_address = null, mac_address = null,
           wifi_radius_m = null }) {
    const db = getDb();
    const insertDevice = db.prepare(`
      INSERT INTO devices (device_type, hostname, inventory_number, os, cpu, ram, disk,
                            owner_user_id, host_device_id, status, notes, wifi_radius_m)
      VALUES (@device_type, @hostname, @inventory_number, @os, @cpu, @ram, @disk,
              @owner_user_id, @host_device_id, @status, @notes, @wifi_radius_m)
    `);
    const insertInterface = db.prepare(`
      INSERT INTO network_interfaces (device_id, ip_address, mac_address, is_primary)
      VALUES (?, ?, ?, 1)
    `);

    const createTx = db.transaction((data) => {
      const info = insertDevice.run(data);
      const deviceId = info.lastInsertRowid;
      if (data.ip_address || data.mac_address) {
        insertInterface.run(deviceId, data.ip_address, data.mac_address);
      }
      return deviceId;
    });

    const deviceId = createTx({
      device_type, hostname, inventory_number, os, cpu, ram, disk,
      owner_user_id, host_device_id, status, notes, ip_address, mac_address,
      wifi_radius_m: normalizeWifiRadius(wifi_radius_m)
    });
    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
    auditLogRepo.log('device', deviceId, 'create', `Устройство «${device.hostname || device.device_type}» создано`);
    return device;
  },
  remove(id) {
    const device = getDb().prepare('SELECT * FROM devices WHERE id = ?').get(id);
    getDb().prepare('DELETE FROM devices WHERE id = ?').run(id);
    if (device) auditLogRepo.log('device', id, 'delete', `Устройство «${device.hostname || device.device_type}» удалено безвозвратно`);
    return { id };
  },
  update(id, { device_type, hostname = null, inventory_number = null, os = null, cpu = null,
                ram = null, disk = null, status = 'active', notes = null, host_device_id = null,
                ip_address = undefined, mac_address = undefined, wifi_radius_m = undefined }) {
    const db = getDb();
    const tx = db.transaction(() => {
      const before = db.prepare('SELECT status FROM devices WHERE id = ?').get(id);
      db.prepare(`
        UPDATE devices SET device_type = ?, hostname = ?, inventory_number = ?, os = ?, cpu = ?,
                            ram = ?, disk = ?, status = ?, notes = ?, host_device_id = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(device_type, hostname, inventory_number, os, cpu, ram, disk, status, notes, host_device_id, id);

      // undefined — поля в форме не было, значение не трогаем (карточка устройства и
      // инспектор правят разные наборы полей)
      if (wifi_radius_m !== undefined) {
        db.prepare('UPDATE devices SET wifi_radius_m = ? WHERE id = ?').run(normalizeWifiRadius(wifi_radius_m), id);
      }

      if (before && before.status !== status) {
        db.prepare('INSERT INTO device_status_history (device_id, status) VALUES (?, ?)').run(id, status);
      }

      if (ip_address !== undefined || mac_address !== undefined) {
        const existing = db.prepare('SELECT * FROM network_interfaces WHERE device_id = ? AND is_primary = 1').get(id);
        if (existing) {
          db.prepare('UPDATE network_interfaces SET ip_address = ?, mac_address = ? WHERE id = ?').run(
            ip_address !== undefined ? ip_address : existing.ip_address,
            mac_address !== undefined ? mac_address : existing.mac_address,
            existing.id
          );
        } else if (ip_address || mac_address) {
          db.prepare('INSERT INTO network_interfaces (device_id, ip_address, mac_address, is_primary) VALUES (?, ?, ?, 1)')
            .run(id, ip_address || null, mac_address || null);
        }
      }
    });
    tx();
    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    auditLogRepo.log('device', id, 'update', `Устройство «${device.hostname || device.device_type}» отредактировано`);
    return device;
  },
  /** Быстрая смена статуса (кнопка "Сервис" и т.п.) — не трогает остальные поля устройства */
  setStatus(id, status, note = null) {
    const db = getDb();
    const tx = db.transaction(() => {
      db.prepare(`UPDATE devices SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
      db.prepare('INSERT INTO device_status_history (device_id, status, note) VALUES (?, ?, ?)').run(id, status, note);
    });
    tx();
    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    auditLogRepo.log('device', id, 'status_change', `Устройство «${device.hostname || device.device_type}»: статус → ${DEVICE_STATUS_LABELS_RU[status] || status}${note ? ` (${note})` : ''}`);
    return device;
  },
  statusHistory(id) {
    return getDb().prepare('SELECT * FROM device_status_history WHERE device_id = ? ORDER BY id DESC').all(id);
  },
  /** Ручная пометка Проблема/Внимание/Ошибка — null снимает пометку */
  setFlag(id, flag) {
    if (flag !== null && !FLAG_VALUES.includes(flag)) throw new Error('Недопустимая пометка');
    getDb().prepare(`UPDATE devices SET flag = ? WHERE id = ?`).run(flag, id);
    const device = getDb().prepare('SELECT * FROM devices WHERE id = ?').get(id);
    auditLogRepo.log('device', id, 'update',
      flag ? `Устройству «${device.hostname || device.device_type}» поставлена пометка «${FLAG_LABELS_RU[flag] || flag}»` : `С устройства «${device.hostname || device.device_type}» снята пометка`);
    return device;
  },
  /** Ручная связь для вкладки "Сеть" — куда подключён этот роутер/свитч, если кабель
   *  провести нельзя (например, через этажи). null снимает связь. */
  /** Условный радиус охвата Wi-Fi в метрах. null — вернуться к значению по умолчанию. */
  setWifiRadius(id, radiusM) {
    const db = getDb();
    const device = db.prepare('SELECT hostname, device_type, wifi_radius_m FROM devices WHERE id = ?').get(id);
    if (!device) throw new Error('Устройство не найдено');
    const value = normalizeWifiRadius(radiusM, true);
    db.prepare("UPDATE devices SET wifi_radius_m = ?, updated_at = datetime('now') WHERE id = ?").run(value, id);
    if (device.wifi_radius_m !== value) {
      const name = device.hostname || device.device_type;
      auditLogRepo.log('device', id, 'update', value === null
        ? `«${name}»: радиус охвата Wi-Fi сброшен на значение по умолчанию (${DEFAULT_WIFI_RADIUS_M} м)`
        : `«${name}»: радиус охвата Wi-Fi — ${formatMeters(value)}`);
    }
    return db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  },
  setUplink(id, uplinkDeviceId) {
    if (uplinkDeviceId === id) throw new Error('Устройство не может быть подключено само на себя');
    getDb().prepare(`UPDATE devices SET uplink_device_id = ? WHERE id = ?`).run(uplinkDeviceId, id);
    const device = getDb().prepare('SELECT * FROM devices WHERE id = ?').get(id);
    const uplinkTarget = uplinkDeviceId ? getDb().prepare('SELECT hostname FROM devices WHERE id = ?').get(uplinkDeviceId) : null;
    auditLogRepo.log('device', id, 'update',
      uplinkTarget ? `Устройство «${device.hostname}»: аплинк → «${uplinkTarget.hostname}»` : `Устройство «${device.hostname}»: аплинк снят`);
    return device;
  },
  search(query) {
    const db = getDb();
    const trimmed = (query || '').trim();
    if (!trimmed) return [];

    let ftsResults = [];
    try {
      // FTS5 special chars (", *, -) в бареворде ломают синтаксис запроса — вырезаем их перед MATCH
      const safe = trimmed.replace(/["*]/g, '').trim();
      if (safe) {
        ftsResults = db.prepare(`
          SELECT d.* FROM devices_fts f JOIN devices d ON d.id = f.rowid
          WHERE devices_fts MATCH ? ORDER BY rank
        `).all(safe + '*');
      }
    } catch { /* пользователь мог ввести то, что FTS не разберёт (например, голый IP) — ниже есть LIKE-фолбэк */ }

    const ipResults = db.prepare(`
      SELECT DISTINCT d.* FROM devices d
      JOIN network_interfaces ni ON ni.device_id = d.id
      WHERE ni.ip_address LIKE ?
    `).all(`%${trimmed}%`);

    const merged = new Map();
    [...ftsResults, ...ipResults].forEach((d) => merged.set(d.id, d));
    return Array.from(merged.values());
  }
};

const pingRepo = {
  record(deviceId, status, responseTimeMs) {
    getDb().prepare(`
      INSERT INTO ping_log (device_id, status, response_time_ms)
      VALUES (?, ?, ?)
    `).run(deviceId, status, responseTimeMs);
  },
  history(deviceId, limit = 20) {
    return getDb().prepare(`
      SELECT * FROM ping_log WHERE device_id = ? ORDER BY checked_at DESC LIMIT ?
    `).all(deviceId, limit);
  }
};

// ------------------------------------------------------------
// Планы и элементы на плане
// ------------------------------------------------------------

const floorPlansRepo = {
  list() {
    return getDb().prepare('SELECT * FROM floor_plans ORDER BY id').all();
  },
  create({ name, grid_step = 900, grid_width_cells = 96, grid_height_cells = 54 }) {
    const db = getDb();
    let site = db.prepare('SELECT * FROM sites LIMIT 1').get();
    if (!site) {
      const info = db.prepare("INSERT INTO sites (name) VALUES ('Основной офис')").run();
      site = { id: info.lastInsertRowid };
    }
    let floor = db.prepare('SELECT * FROM floors WHERE site_id = ? LIMIT 1').get(site.id);
    if (!floor) {
      const info = db.prepare("INSERT INTO floors (site_id, name, order_index) VALUES (?, 'Этаж 1', 0)").run(site.id);
      floor = { id: info.lastInsertRowid };
    }

    const info = db.prepare(`
      INSERT INTO floor_plans (floor_id, name, grid_step, grid_width_cells, grid_height_cells)
      VALUES (?, ?, ?, ?, ?)
    `).run(floor.id, name, grid_step, grid_width_cells, grid_height_cells);

    const plan = db.prepare('SELECT * FROM floor_plans WHERE id = ?').get(info.lastInsertRowid);
    auditLogRepo.log('floor_plan', plan.id, 'create', `План «${plan.name}» создан`);
    return plan;
  },
  /** Подтягивает границы плана под то, что на нём уже лежит. Нужно для баз, созданных
   *  до появления автоматического роста: там объекты могли уехать за край, и под ними
   *  нет ни сетки, ни работающей заливки зон. Вызывается при открытии этажа. */
  fitToContent(floorPlanId) {
    const db = getDb();
    // Минимумы нужны наравне с максимумами: чертят не от угла, и содержимое запросто
    // оказывается выше и левее начала координат — именно там зоны и не создавались
    const bounds = db.prepare(`
      SELECT MIN(MIN(x, COALESCE(x2, x))) AS minX, MIN(MIN(y, COALESCE(y2, y))) AS minY,
             MAX(MAX(x, COALESCE(x2, x))) AS maxX, MAX(MAX(y, COALESCE(y2, y))) AS maxY
      FROM plan_items WHERE floor_plan_id = ?
    `).get(floorPlanId);
    const cells = [];
    if (bounds && bounds.maxX !== null) {
      cells.push([bounds.maxX, bounds.maxY]);
      cells.push([bounds.minX, bounds.minY]);
    }
    // Зоны хранят список клеток в JSON — разбираем, иначе зона у края «подрежется»
    const zones = db.prepare('SELECT cells FROM plan_zones WHERE floor_plan_id = ?').all(floorPlanId);
    zones.forEach((z) => {
      try {
        JSON.parse(z.cells).forEach(([zx, zy]) => cells.push([zx, zy]));
      } catch { /* битый JSON не должен мешать открытию плана */ }
    });
    if (cells.length === 0) return db.prepare('SELECT * FROM floor_plans WHERE id = ?').get(floorPlanId);
    const grew = growPlanToFit(db, floorPlanId, cells);
    const plan = db.prepare('SELECT * FROM floor_plans WHERE id = ?').get(floorPlanId);
    if (grew) {
      auditLogRepo.log('floor_plan', floorPlanId, 'update',
        `Границы плана «${plan.name}» расширены под содержимое: ${plan.grid_width_cells}×${plan.grid_height_cells} клеток ` +
        `от (${plan.grid_min_x},${plan.grid_min_y})`);
    }
    return plan;
  },
  ensureDefault() {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM floor_plans ORDER BY id LIMIT 1').get();
    if (existing) return existing;
    return floorPlansRepo.create({ name: 'План 1' });
  },
  /** Удаляет план вместе с его объектами/кабелями (ON DELETE CASCADE) — но не даёт удалить последний */
  remove(id) {
    const db = getDb();
    const count = db.prepare('SELECT COUNT(*) c FROM floor_plans').get().c;
    if (count <= 1) throw new Error('Нельзя удалить последний план — должен остаться хотя бы один');
    const plan = db.prepare('SELECT * FROM floor_plans WHERE id = ?').get(id);
    db.prepare('DELETE FROM floor_plans WHERE id = ?').run(id);
    if (plan) auditLogRepo.log('floor_plan', id, 'delete', `План «${plan.name}» удалён вместе со всеми объектами на нём`);
    return { id };
  },
  rename(id, name) {
    const before = getDb().prepare('SELECT name FROM floor_plans WHERE id = ?').get(id);
    getDb().prepare('UPDATE floor_plans SET name = ? WHERE id = ?').run(name, id);
    if (before && before.name !== name) auditLogRepo.log('floor_plan', id, 'update', `План «${before.name}» переименован в «${name}»`);
    return getDb().prepare('SELECT * FROM floor_plans WHERE id = ?').get(id);
  }
};

/** Снимает устройство со всех прежних мест на плане, кроме exceptItemId — и как
 *  одиночный элемент, и как участника группы (с тем же авто-разворачиванием группы,
 *  что в removeFromGroup: остался один участник — группа снова становится одиночным
 *  элементом, не осталось никого — группа удаляется).
 *  Вызывается ВНУТРИ уже открытой транзакции, поэтому своей не создаёт. */
function detachDeviceFromPlan(db, deviceId, exceptItemId = null) {
  const singles = db.prepare(
    "SELECT id FROM plan_items WHERE item_type = 'device' AND ref_id = ?"
  ).all(deviceId);
  for (const row of singles) {
    if (exceptItemId !== null && row.id === exceptItemId) continue;
    const item = db.prepare('SELECT * FROM plan_items WHERE id = ?').get(row.id);
    db.prepare('DELETE FROM plan_items WHERE id = ?').run(row.id);
    auditLogRepo.log('plan_item', row.id, 'delete',
      `${planItemLabelForLog(db, item)} снят(а) с прежнего места на плане (переносится)`);
  }

  const memberships = db.prepare(
    'SELECT group_item_id FROM plan_item_group_members WHERE device_id = ?'
  ).all(deviceId);
  for (const row of memberships) {
    const groupId = row.group_item_id;
    if (exceptItemId !== null && groupId === exceptItemId) continue;
    db.prepare('DELETE FROM plan_item_group_members WHERE group_item_id = ? AND device_id = ?')
      .run(groupId, deviceId);
    const remaining = db.prepare('SELECT device_id FROM plan_item_group_members WHERE group_item_id = ?').all(groupId);
    if (remaining.length === 0) {
      db.prepare('DELETE FROM plan_items WHERE id = ?').run(groupId);
      auditLogRepo.log('plan_item', groupId, 'delete', 'Группа устройств на плане удалена (опустела)');
    } else if (remaining.length === 1) {
      db.prepare("UPDATE plan_items SET item_type = 'device', ref_id = ?, group_label = NULL WHERE id = ?")
        .run(remaining[0].device_id, groupId);
      auditLogRepo.log('plan_item', groupId, 'update', 'Группа устройств на плане разгруппирована (осталось одно устройство)');
    } else {
      auditLogRepo.log('plan_item', groupId, 'update', 'Устройство убрано из группы на плане (переносится)');
    }
  }
}

const planItemsRepo = {
  listByPlan(floorPlanId) {
    // hostname/тип/IP/статус пинга/владелец устройства сразу — канва и инспектор
    // не делают отдельный запрос на каждую иконку
    return getDb().prepare(`
      SELECT pi.*, d.device_type AS device_type, d.hostname AS device_hostname,
             d.inventory_number AS device_inventory_number,
             ni.ip_address AS device_ip, dlp.status AS last_ping_status,
             d.owner_user_id AS owner_user_id, u.full_name AS owner_name,
             d.status AS device_status, d.flag AS device_flag, u.status AS owner_status,
             d.uplink_device_id AS device_uplink_id,
             d.wifi_radius_m AS device_wifi_radius_m
      FROM plan_items pi
      LEFT JOIN devices d ON d.id = pi.ref_id
      LEFT JOIN network_interfaces ni ON ni.device_id = d.id AND ni.is_primary = 1
      LEFT JOIN device_latest_ping dlp ON dlp.device_id = d.id
      LEFT JOIN users u ON u.id = d.owner_user_id
      WHERE pi.floor_plan_id = ?
      ORDER BY pi.z_index, pi.id
    `).all(floorPlanId);
  },
  /** На каких планах (этажах) размещено устройство — для кнопки "Найти на плане" и
   *  для поиска. Находит и как одиночный элемент, и как участника ГРУППЫ (устройство
   *  внутри "шкафа" не имеет своего plan_item, только членство в plan_item_group_members) —
   *  via_group=1 в результате отличает второй случай, чтобы UI знал открыть модалку группы. */
  findByDeviceRef(deviceId) {
    return getDb().prepare(`
      SELECT pi.*, fp.name AS floor_plan_name, 0 AS via_group
      FROM plan_items pi
      JOIN floor_plans fp ON fp.id = pi.floor_plan_id
      WHERE pi.ref_id = ? AND pi.item_type = 'device'
      UNION ALL
      SELECT pi.*, fp.name AS floor_plan_name, 1 AS via_group
      FROM plan_item_group_members gm
      JOIN plan_items pi ON pi.id = gm.group_item_id
      JOIN floor_plans fp ON fp.id = pi.floor_plan_id
      WHERE gm.device_id = ?
    `).all(deviceId, deviceId);
  },
  /** id устройств, уже размещённых хоть на каком-то этаже — карман "Устройства" на плане
   *  не должен предлагать их повторно (одно физическое устройство — одно место на плане) */
  listPlacedDeviceIds() {
    return getDb().prepare(`
      SELECT ref_id FROM plan_items WHERE item_type = 'device' AND ref_id IS NOT NULL
      UNION
      SELECT device_id AS ref_id FROM plan_item_group_members
    `).all().map((r) => r.ref_id);
  },
  /** Размещения ВСЕХ устройств сразу (device_id, куда переходить, на каком этаже,
   *  напрямую или через группу) — для поиска "где это устройство", без отдельного
   *  запроса на каждое совпадение. Тот же UNION-приём, что и в findByDeviceRef. */
  listAllDevicePlacements() {
    return getDb().prepare(`
      SELECT pi.ref_id AS device_id, pi.id AS item_id, pi.floor_plan_id, fp.name AS floor_plan_name, 0 AS via_group
      FROM plan_items pi
      JOIN floor_plans fp ON fp.id = pi.floor_plan_id
      WHERE pi.item_type = 'device' AND pi.ref_id IS NOT NULL
      UNION ALL
      SELECT gm.device_id AS device_id, pi.id AS item_id, pi.floor_plan_id, fp.name AS floor_plan_name, 1 AS via_group
      FROM plan_item_group_members gm
      JOIN plan_items pi ON pi.id = gm.group_item_id
      JOIN floor_plans fp ON fp.id = pi.floor_plan_id
    `).all();
  },
  /** Ручной комментарий "на проверку" — независимо от пометок Проблема/Внимание/Ошибка
   *  у самого устройства/пользователя. note=null (или пустая строка) снимает пометку. */
  setReviewNote(id, note) {
    const clean = note && note.trim() ? note.trim() : null;
    getDb().prepare('UPDATE plan_items SET review_note = ? WHERE id = ?').run(clean, id);
    return getDb().prepare('SELECT * FROM plan_items WHERE id = ?').get(id);
  },
  /** Роль устройства (обычно роутера) в сети сегмента — если их несколько на одном
   *  кабеле, разграничивает Главный/Резервный/Сателлит. role=null снимает роль. */
  setNetworkRole(id, role) {
    if (role !== null && !['primary', 'backup', 'satellite'].includes(role)) throw new Error('Недопустимая роль');
    getDb().prepare('UPDATE plan_items SET network_role = ? WHERE id = ?').run(role, id);
    return getDb().prepare('SELECT * FROM plan_items WHERE id = ?').get(id);
  },
  create({ floor_plan_id, item_type, ref_id = null, x, y, x2 = null, y2 = null, rotation = 0,
           offset_x = 0, offset_y = 0, width_cells = 1, height_cells = 1, label = null, z_index = 0,
           door_width = DEFAULT_DOOR_WIDTH }) {
    const db = getDb();
    rotation = normalizeRotation(rotation);
    // План растёт под новый объект ПЕРВЫМ делом. Порядок принципиален: нормализация
    // ниже зажимает клетку по текущим границам плана, и если сначала нормализовать, то
    // объект, созданный на 106-й клетке плана шириной 96, молча переехал бы на 95-ю.
    // «Положили за границей» — это повод расширить план, а не сдвинуть объект.
    growPlanToFit(db, floor_plan_id, [[x, y], [x2 === null ? x : x2, y2 === null ? y : y2]]);

    if (isPointItemType(item_type)) {
      // Тот же инвариант, что и в setCellOffset: владелец — ближайшая клетка. Если при
      // создании передали смещение больше половины, объект сразу привязывается к
      // соседней, а не рождается на границе своей. Границы читаем ПОСЛЕ роста.
      const bounds = planBounds(db, floor_plan_id);
      const nx = normalizeCellAndOffset(x, offset_x, bounds.minX, bounds.maxX);
      const ny = normalizeCellAndOffset(y, offset_y, bounds.minY, bounds.maxY);
      x = nx.cell; y = ny.cell;
      offset_x = nx.offset; offset_y = ny.offset;
    } else {
      // Линейные объекты: координаты — узлы сетки, трогать их нельзя; смещения нет
      offset_x = 0; offset_y = 0;
    }
    door_width = clampDoorWidth(door_width);
    const info = db.prepare(`
      INSERT INTO plan_items (floor_plan_id, item_type, ref_id, x, y, x2, y2, rotation, offset_x, offset_y,
                               width_cells, height_cells, label, z_index, door_width)
      VALUES (@floor_plan_id, @item_type, @ref_id, @x, @y, @x2, @y2, @rotation, @offset_x, @offset_y,
              @width_cells, @height_cells, @label, @z_index, @door_width)
    `).run({ floor_plan_id, item_type, ref_id, x, y, x2, y2, rotation, offset_x, offset_y, width_cells, height_cells, label, z_index, door_width });
    const item = db.prepare('SELECT * FROM plan_items WHERE id = ?').get(info.lastInsertRowid);
    auditLogRepo.log('plan_item', item.id, 'create', `${planItemLabelForLog(db, item)} размещён(а) на плане`);
    return item;
  },
  move(id, x, y) {
    const db = getDb();
    const item = db.prepare('SELECT * FROM plan_items WHERE id = ?').get(id);
    if (item) growPlanToFit(db, item.floor_plan_id, [[x, y]]);
    db.prepare('UPDATE plan_items SET x = ?, y = ? WHERE id = ?').run(x, y, id);
    if (item && (item.x !== x || item.y !== y)) {
      auditLogRepo.log('plan_item', id, 'update',
        `${planItemLabelForLog(db, item)} перемещён(а) на плане: (${item.x},${item.y}) → (${x},${y})`);
    }
    return { id, x, y };
  },
  /** Ширина проёма двери, в клетках = в условных метрах. Вне диапазона CHECK в схеме
   *  (0..20) не пропускаем здесь, чтобы отдать понятную ошибку вместо SQLITE_CONSTRAINT. */
  setDoorWidth(id, width) {
    const db = getDb();
    const item = db.prepare('SELECT * FROM plan_items WHERE id = ?').get(id);
    if (!item) throw new Error('Объект плана не найден');
    if (item.item_type !== 'door') throw new Error('Ширина проёма есть только у двери.');
    const value = clampDoorWidth(width, true);
    db.prepare('UPDATE plan_items SET door_width = ? WHERE id = ?').run(value, id);
    if (item.door_width !== value) {
      auditLogRepo.log('plan_item', id, 'update',
        `Ширина двери изменена: ${formatMeters(item.door_width)} → ${formatMeters(value)}`);
    }
    return db.prepare('SELECT * FROM plan_items WHERE id = ?').get(id);
  },
  /** Смена rotation без прочих полей — у двери используется для "Развернуть"/"Отразить" */
  setRotation(id, rotation) {
    const db = getDb();
    rotation = normalizeRotation(rotation);
    const item = db.prepare('SELECT * FROM plan_items WHERE id = ?').get(id);
    db.prepare('UPDATE plan_items SET rotation = ? WHERE id = ?').run(rotation, id);
    if (item && item.rotation !== rotation) {
      auditLogRepo.log('plan_item', id, 'update',
        `${planItemLabelForLog(db, item)} повёрнут(а) на плане: ${item.rotation}° → ${rotation}°`);
    }
    return db.prepare('SELECT * FROM plan_items WHERE id = ?').get(id);
  },
  /** Смещение внутри собственной клетки (доли клетки, -0.5..+0.5) — привязка к косым
   *  стенам, когда центр клетки не подходит. Отдельно от move(): клетка та же, меняется
   *  только положение внутри неё, и в журнал это пишется как другое по смыслу действие. */
  setCellOffset(id, offset_x, offset_y) {
    const db = getDb();
    const item = db.prepare('SELECT * FROM plan_items WHERE id = ?').get(id);
    if (!item) throw new Error('Объект плана не найден');
    if (!isPointItemType(item.item_type)) {
      // У стены/двери/лестницы координаты — узлы сетки, а не клетка: смещение внутри
      // клетки для них не определено, и применять его значило бы сдвинуть конец линии
      throw new Error('Смещение внутри клетки есть только у точечных объектов (стол, устройство, группа).');
    }

    // Смещение задаётся ОТ ЦЕНТРА ТЕКУЩЕЙ клетки, но владельцем должна остаться
    // ближайшая: вышел больше чем на половину — перепривязываем к соседней, а остаток
    // становится смещением уже от неё. Так числовые поля ведут себя ровно как мышь.
    const bounds = planBounds(db, item.floor_plan_id);
    const nx = normalizeCellAndOffset(item.x, offset_x, bounds.minX, bounds.maxX);
    const ny = normalizeCellAndOffset(item.y, offset_y, bounds.minY, bounds.maxY);
    const movedToAnotherCell = nx.cell !== item.x || ny.cell !== item.y;

    if (movedToAnotherCell && (item.item_type === 'device' || item.item_type === 'group')) {
      // Перепривязка может привести на клетку, где уже кто-то стоит. Объединять в группу
      // по правке числового поля — слишком неожиданно (для этого есть перетаскивание,
      // где слияние видно и ожидаемо), поэтому честно отказываемся.
      const occupied = db.prepare(`
        SELECT id FROM plan_items
        WHERE floor_plan_id = ? AND x = ? AND y = ? AND id <> ? AND item_type IN ('device','group')
      `).get(item.floor_plan_id, nx.cell, ny.cell, id);
      if (occupied) {
        throw new Error(
          `Такое смещение переносит объект в клетку (${nx.cell},${ny.cell}), а она уже занята. ` +
          'Чтобы объединить объекты в группу, перетащите один на другой мышью.'
        );
      }
    }

    db.prepare('UPDATE plan_items SET x = ?, y = ?, offset_x = ?, offset_y = ? WHERE id = ?')
      .run(nx.cell, ny.cell, nx.offset, ny.offset, id);

    const label = planItemLabelForLog(db, item);
    if (movedToAnotherCell) {
      auditLogRepo.log('plan_item', id, 'update',
        `${label} перепривязан(а) к клетке (${nx.cell},${ny.cell}) со смещением ` +
        `(${nx.offset.toFixed(2)}, ${ny.offset.toFixed(2)}) — было (${item.x},${item.y})`);
    } else if (item.offset_x !== nx.offset || item.offset_y !== ny.offset) {
      auditLogRepo.log('plan_item', id, 'update',
        `${label} смещён(а) внутри клетки: (${nx.offset.toFixed(2)}, ${ny.offset.toFixed(2)})`);
    }
    return db.prepare('SELECT * FROM plan_items WHERE id = ?').get(id);
  },
  remove(id) {
    const db = getDb();
    const item = db.prepare('SELECT * FROM plan_items WHERE id = ?').get(id);
    db.prepare('DELETE FROM plan_items WHERE id = ?').run(id);
    if (item) auditLogRepo.log('plan_item', id, 'delete', `${planItemLabelForLog(db, item)} убран(а) с плана`);
    return { id };
  },
  /** Размещает устройство на клетке — если клетка занята одиночным устройством или уже
   *  существующей группой, вместо перекрытия образует/пополняет группу (по аналогии с
   *  папками на Android: второй ярлык на ту же клетку создаёт контейнер вместо
   *  перекрытия первого). Возвращает { item, wasGrouped }. */
  placeDeviceWithGrouping(floor_plan_id, deviceId, x, y) {
    const db = getDb();
    const tx = db.transaction(() => {
      growPlanToFit(db, floor_plan_id, [[x, y]]);
      const existing = db.prepare(`
        SELECT * FROM plan_items WHERE floor_plan_id = ? AND x = ? AND y = ? AND item_type IN ('device', 'group')
      `).get(floor_plan_id, x, y);

      // Одно физическое устройство — одно место на плане (см. listPlacedDeviceIds).
      // Карман "Устройства" уже размещённое не предлагает, но на стороне клиента список
      // мог быть устаревшим (или drop сработал дважды) — и тогда у устройства
      // появлялось ВТОРОЕ размещение-дубликат. Снимаем прежнее место, т.е. трактуем
      // такой повторный drop как перенос, а не как второй экземпляр.
      detachDeviceFromPlan(db, deviceId, existing ? existing.id : null);

      if (!existing) {
        const info = db.prepare(`
          INSERT INTO plan_items (floor_plan_id, item_type, ref_id, x, y, rotation, width_cells, height_cells, z_index)
          VALUES (?, 'device', ?, ?, ?, 0, 1, 1, 0)
        `).run(floor_plan_id, deviceId, x, y);
        const item = db.prepare('SELECT * FROM plan_items WHERE id = ?').get(info.lastInsertRowid);
        auditLogRepo.log('plan_item', item.id, 'create', `${planItemLabelForLog(db, item)} размещён(а) на плане`);
        return { item, wasGrouped: false };
      }

      if (existing.item_type === 'group') {
        db.prepare('INSERT OR IGNORE INTO plan_item_group_members (group_item_id, device_id) VALUES (?, ?)').run(existing.id, deviceId);
        const device = db.prepare('SELECT hostname FROM devices WHERE id = ?').get(deviceId);
        auditLogRepo.log('plan_item', existing.id, 'update',
          `Устройство «${(device && device.hostname) || deviceId}» добавлено в группу «${existing.group_label || 'без названия'}»`);
        return { item: db.prepare('SELECT * FROM plan_items WHERE id = ?').get(existing.id), wasGrouped: true };
      }

      // Клетка занята одиночным устройством — превращаем в группу из двух
      const otherDeviceId = existing.ref_id;
      const info = db.prepare(`
        INSERT INTO plan_items (floor_plan_id, item_type, x, y, rotation, width_cells, height_cells, z_index)
        VALUES (?, 'group', ?, ?, 0, 1, 1, ?)
      `).run(floor_plan_id, x, y, existing.z_index);
      const groupId = info.lastInsertRowid;
      db.prepare('INSERT INTO plan_item_group_members (group_item_id, device_id) VALUES (?, ?)').run(groupId, otherDeviceId);
      db.prepare('INSERT INTO plan_item_group_members (group_item_id, device_id) VALUES (?, ?)').run(groupId, deviceId);
      db.prepare('DELETE FROM plan_items WHERE id = ?').run(existing.id);
      const groupItem = db.prepare('SELECT * FROM plan_items WHERE id = ?').get(groupId);
      auditLogRepo.log('plan_item', groupId, 'create', 'Создана группа устройств на плане (объединены 2)');
      return { item: groupItem, wasGrouped: true };
    });
    return tx();
  },
  /** То же самое, что placeDeviceWithGrouping, но для УЖЕ размещённого устройства,
   *  которое перетаскивают мышью в новую клетку (см. dragend в renderer/index.js).
   *  Если целевая клетка занята — устройство "переезжает" туда (создаёт/пополняет
   *  группу), а его СТАРЫЙ plan_item (oldItemId) удаляется, у него больше нет
   *  отдельного места на плане. Если клетка пуста (в т.ч. если это та же клетка,
   *  откуда тащили) — обычное перемещение, как раньше. */
  moveDeviceItemWithGrouping(oldItemId, floor_plan_id, deviceId, x, y) {
    const db = getDb();
    const tx = db.transaction(() => {
      growPlanToFit(db, floor_plan_id, [[x, y]]);
      const existing = db.prepare(`
        SELECT * FROM plan_items WHERE floor_plan_id = ? AND x = ? AND y = ? AND item_type IN ('device', 'group') AND id <> ?
      `).get(floor_plan_id, x, y, oldItemId);

      if (!existing) {
        const before = db.prepare('SELECT * FROM plan_items WHERE id = ?').get(oldItemId);
        db.prepare('UPDATE plan_items SET x = ?, y = ? WHERE id = ?').run(x, y, oldItemId);
        if (before && (before.x !== x || before.y !== y)) {
          auditLogRepo.log('plan_item', oldItemId, 'update',
            `${planItemLabelForLog(db, before)} перемещён(а) на плане: (${before.x},${before.y}) → (${x},${y})`);
        }
        return { item: db.prepare('SELECT * FROM plan_items WHERE id = ?').get(oldItemId), wasGrouped: false };
      }

      if (existing.item_type === 'group') {
        db.prepare('INSERT OR IGNORE INTO plan_item_group_members (group_item_id, device_id) VALUES (?, ?)').run(existing.id, deviceId);
        db.prepare('DELETE FROM plan_items WHERE id = ?').run(oldItemId);
        const device = db.prepare('SELECT hostname FROM devices WHERE id = ?').get(deviceId);
        auditLogRepo.log('plan_item', existing.id, 'update',
          `Устройство «${(device && device.hostname) || deviceId}» перетащено в группу «${existing.group_label || 'без названия'}»`);
        return { item: db.prepare('SELECT * FROM plan_items WHERE id = ?').get(existing.id), wasGrouped: true, removedOldItemId: oldItemId };
      }

      // Целевая клетка занята одиночным устройством — превращаем в группу из двух,
      // убираем ОБА старых одиночных plan_item (и перетаскиваемого, и целевого)
      const otherDeviceId = existing.ref_id;
      const info = db.prepare(`
        INSERT INTO plan_items (floor_plan_id, item_type, x, y, rotation, width_cells, height_cells, z_index)
        VALUES (?, 'group', ?, ?, 0, 1, 1, ?)
      `).run(floor_plan_id, x, y, existing.z_index);
      const groupId = info.lastInsertRowid;
      db.prepare('INSERT INTO plan_item_group_members (group_item_id, device_id) VALUES (?, ?)').run(groupId, otherDeviceId);
      db.prepare('INSERT INTO plan_item_group_members (group_item_id, device_id) VALUES (?, ?)').run(groupId, deviceId);
      db.prepare('DELETE FROM plan_items WHERE id = ?').run(existing.id);
      db.prepare('DELETE FROM plan_items WHERE id = ?').run(oldItemId);
      const groupItem = db.prepare('SELECT * FROM plan_items WHERE id = ?').get(groupId);
      auditLogRepo.log('plan_item', groupId, 'create', 'Создана группа устройств на плане (объединены перетаскиванием)');
      return { item: groupItem, wasGrouped: true, removedOldItemId: oldItemId };
    });
    return tx();
  },
  /** Состав группы — устройства внутри, с теми же полями, что и обычный список устройств */
  groupMembers(groupItemId) {
    // Тот же набор JOIN'ов, что и в devicesRepo.list() — раньше owner_name/owner_status
    // не подтягивались вовсе (SELECT d.* без JOIN на users), из-за чего владелец,
    // назначенный ДО открытия панели группы, не показывался в инспекторе устройства
    // внутри неё (выглядело так, будто владельца нет вообще, хотя он был назначен).
    return getDb().prepare(`
      SELECT d.*,
             ni.ip_address    AS primary_ip,
             ni.mac_address   AS primary_mac,
             dlp.status       AS last_ping_status,
             dlp.checked_at   AS last_ping_at,
             u.full_name      AS owner_name,
             u.status         AS owner_status
      FROM plan_item_group_members gm
      JOIN devices d ON d.id = gm.device_id
      LEFT JOIN network_interfaces ni ON ni.device_id = d.id AND ni.is_primary = 1
      LEFT JOIN device_latest_ping dlp ON dlp.device_id = d.id
      LEFT JOIN users u ON u.id = d.owner_user_id
      WHERE gm.group_item_id = ?
      ORDER BY d.hostname
    `).all(groupItemId);
  },
  /** Убирает устройство из группы. Если останется РОВНО одно — группа автоматически
   *  "разворачивается" обратно в одиночный device-item (как в Android — папка с одним
   *  ярлыком снова становится просто ярлыком). Если ноль — группа удаляется вовсе. */
  removeFromGroup(groupItemId, deviceId) {
    const db = getDb();
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM plan_item_group_members WHERE group_item_id = ? AND device_id = ?').run(groupItemId, deviceId);
      const remaining = db.prepare('SELECT device_id FROM plan_item_group_members WHERE group_item_id = ?').all(groupItemId);

      if (remaining.length === 0) {
        db.prepare('DELETE FROM plan_items WHERE id = ?').run(groupItemId);
        auditLogRepo.log('plan_item', groupItemId, 'delete', 'Группа устройств на плане удалена (опустела)');
        return { deleted: true };
      }
      if (remaining.length === 1) {
        db.prepare("UPDATE plan_items SET item_type = 'device', ref_id = ?, group_label = NULL WHERE id = ?")
          .run(remaining[0].device_id, groupItemId);
        auditLogRepo.log('plan_item', groupItemId, 'update', 'Группа устройств на плане разгруппирована (осталось одно устройство)');
        return { ungroupedToSingle: true, item: db.prepare('SELECT * FROM plan_items WHERE id = ?').get(groupItemId) };
      }
      auditLogRepo.log('plan_item', groupItemId, 'update', 'Устройство убрано из группы на плане');
      return { removed: true };
    });
    return tx();
  },
  /** Название группы — необязательное, например "Шкаф А1". null/пусто снимает название. */
  renameGroup(groupItemId, label) {
    const clean = label && label.trim() ? label.trim() : null;
    getDb().prepare('UPDATE plan_items SET group_label = ? WHERE id = ?').run(clean, groupItemId);
    auditLogRepo.log('plan_item', groupItemId, 'update', clean ? `Группе на плане присвоено название «${clean}»` : 'С группы на плане снято название');
    return getDb().prepare('SELECT * FROM plan_items WHERE id = ?').get(groupItemId);
  }
};

// Палитра для автоматического различения кабелей, идущих рядом — цикличная,
// назначается по количеству уже существующих кабелей на этаже
const CABLE_COLOR_PALETTE = ['#4a90d9', '#e74c3c', '#27ae60', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e'];

const cablesRepo = {
  listByPlan(floorPlanId) {
    return getDb().prepare('SELECT * FROM cables WHERE floor_plan_id = ?').all(floorPlanId);
  },
  /** Один кабель по id, с floor_plan_id — нужен для перехода "найти на плане" из
   *  вкладки "Сеть", где неизвестно заранее, на каком этаже находится кабель. */
  get(id) {
    return getDb().prepare('SELECT * FROM cables WHERE id = ?').get(id);
  },
  /** from_item_id/to_item_id необязательны — кабель можно провести и без устройств на
   *  концах (устройства подключаются напрямую к кабелю, см. cableConnectionsRepo). path — полный путь
   *  линии в клетках (точки редактирования); color назначается автоматически из палитры,
   *  если не передан явно. */
  create({ floor_plan_id, from_item_id = null, to_item_id = null, cable_type = 'network',
           label = null, waypoints = [], path = [], color = null }) {
    const db = getDb();
    if (!color) {
      const count = db.prepare('SELECT COUNT(*) AS c FROM cables WHERE floor_plan_id = ?').get(floor_plan_id).c;
      color = CABLE_COLOR_PALETTE[count % CABLE_COLOR_PALETTE.length];
    }
    const info = db.prepare(`
      INSERT INTO cables (floor_plan_id, from_item_id, to_item_id, cable_type, label, waypoints, path, color)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(floor_plan_id, from_item_id, to_item_id, cable_type, label, JSON.stringify(waypoints), JSON.stringify(path), color);
    const cable = db.prepare('SELECT * FROM cables WHERE id = ?').get(info.lastInsertRowid);
    auditLogRepo.log('cable', cable.id, 'create', `Кабель №${cable.id} проложен на плане`);
    return cable;
  },
  /** Точки редактирования линии — перетащить существующую, добавить новую, удалить. */
  updatePath(id, path) {
    getDb().prepare('UPDATE cables SET path = ? WHERE id = ?').run(JSON.stringify(path), id);
    return getDb().prepare('SELECT * FROM cables WHERE id = ?').get(id);
  },
  /** Пользовательское имя кабеля — номер (#id) всегда автоматический, имя необязательно.
   *  Отображение: "Кабель №42 (Магистраль А)". null/пусто снимает имя. */
  setLabel(id, label) {
    const clean = label && label.trim() ? label.trim() : null;
    getDb().prepare('UPDATE cables SET label = ? WHERE id = ?').run(clean, id);
    auditLogRepo.log('cable', id, 'update', clean ? `Кабелю №${id} присвоено имя «${clean}»` : `С кабеля №${id} снято имя`);
    return getDb().prepare('SELECT * FROM cables WHERE id = ?').get(id);
  },
  remove(id) {
    const cable = getDb().prepare('SELECT * FROM cables WHERE id = ?').get(id);
    getDb().prepare('DELETE FROM cables WHERE id = ?').run(id);
    if (cable) auditLogRepo.log('cable', id, 'delete', `Кабель №${id}${cable.label ? ` (${cable.label})` : ''} удалён`);
    return { id };
  }
};

// ------------------------------------------------------------
// Сокеты на кабеле — точки подключения устройств к линии. Все устройства на сокетах
// одного кабеля образуют один сетевой сегмент (см. networkRepo.buildTree).
// ------------------------------------------------------------

const cableConnectionsRepo = {
  /** Все подключения на всех кабелях этажа одним запросом */
  listByPlan(floorPlanId) {
    return getDb().prepare(`
      SELECT cc.* FROM cable_connections cc JOIN cables c ON c.id = cc.cable_id WHERE c.floor_plan_id = ?
    `).all(floorPlanId);
  },
  listByPlanItem(planItemId) {
    return getDb().prepare('SELECT * FROM cable_connections WHERE plan_item_id = ?').all(planItemId);
  },
  listByCable(cableId) {
    return getDb().prepare('SELECT * FROM cable_connections WHERE cable_id = ?').all(cableId);
  },
  /** Подключает устройство к кабелю. Роутер/свитч — многопортовые: подключение
   *  добавляется, не трогая уже существующие. Любое другое устройство — только один
   *  кабель разом: предыдущее подключение автоматически снимается. */
  connect(planItemId, cableId) {
    const db = getDb();
    const item = db.prepare(`
      SELECT pi.id, d.device_type, d.hostname FROM plan_items pi JOIN devices d ON d.id = pi.ref_id WHERE pi.id = ?
    `).get(planItemId);
    const isMultiPort = item && (item.device_type === 'router' || item.device_type === 'switch');
    if (!isMultiPort) {
      db.prepare('DELETE FROM cable_connections WHERE plan_item_id = ?').run(planItemId);
    }
    db.prepare('INSERT OR IGNORE INTO cable_connections (plan_item_id, cable_id) VALUES (?, ?)').run(planItemId, cableId);
    if (item) {
      const cable = db.prepare('SELECT * FROM cables WHERE id = ?').get(cableId);
      const cableLabel = cable ? `кабелю №${cable.id}${cable.label ? ` (${cable.label})` : ''}` : `кабелю №${cableId}`;
      auditLogRepo.log('cable_connection', planItemId, 'create', `«${item.hostname || item.device_type}» подключён к ${cableLabel}`);
    }
    return cableConnectionsRepo.listByPlanItem(planItemId);
  },
  disconnect(planItemId, cableId) {
    const db = getDb();
    const item = db.prepare(`
      SELECT pi.ref_id, d.device_type, d.hostname FROM plan_items pi LEFT JOIN devices d ON d.id = pi.ref_id WHERE pi.id = ?
    `).get(planItemId);
    db.prepare('DELETE FROM cable_connections WHERE plan_item_id = ? AND cable_id = ?').run(planItemId, cableId);
    if (item) {
      const cable = db.prepare('SELECT * FROM cables WHERE id = ?').get(cableId);
      const cableLabel = cable ? `кабеля №${cable.id}${cable.label ? ` (${cable.label})` : ''}` : `кабеля №${cableId}`;
      auditLogRepo.log('cable_connection', planItemId, 'delete', `«${item.hostname || item.device_type}» отключён от ${cableLabel}`);
    }
    return { planItemId, cableId };
  },
  disconnectAll(planItemId) {
    getDb().prepare('DELETE FROM cable_connections WHERE plan_item_id = ?').run(planItemId);
    return { planItemId };
  }
};

// ------------------------------------------------------------
// Владение устройством: назначение/снятие через drag&drop + история
// ------------------------------------------------------------

const ownershipRepo = {
  history(deviceId) {
    return getDb().prepare(`
      SELECT h.*, u.full_name AS user_name
      FROM device_user_history h
      JOIN users u ON u.id = h.user_id
      WHERE h.device_id = ?
      ORDER BY h.id DESC
    `).all(deviceId);
  },
  /** Обратная сторона history() — какими устройствами пользователь владеет сейчас
   *  и владел раньше. Используется карточкой пользователя. */
  historyForUser(userId) {
    return getDb().prepare(`
      SELECT h.*, d.hostname AS device_hostname, d.device_type AS device_type, d.status AS device_status
      FROM device_user_history h
      JOIN devices d ON d.id = h.device_id
      WHERE h.user_id = ?
      ORDER BY h.id DESC
    `).all(userId);
  },
  /** Закрепляет пользователя за устройством: закрывает предыдущую активную запись (если была) и открывает новую */
  assign(deviceId, userId) {
    const db = getDb();
    // Повторное закрепление за ТЕМ ЖЕ пользователем закрывало активную запись истории
    // и открывало новую — в истории владения появлялась пара дублей с нулевым сроком
    // (и лишняя строка в журнале). Если ничего не меняется, просто выходим.
    const current = db.prepare(`
      SELECT user_id FROM device_user_history WHERE device_id = ? AND unassigned_at IS NULL
      ORDER BY id DESC LIMIT 1
    `).get(deviceId);
    const ownerNow = db.prepare('SELECT owner_user_id FROM devices WHERE id = ?').get(deviceId);
    if (current && current.user_id === userId && ownerNow && ownerNow.owner_user_id === userId) {
      return { deviceId, userId, unchanged: true };
    }
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE device_user_history SET unassigned_at = datetime('now')
        WHERE device_id = ? AND unassigned_at IS NULL
      `).run(deviceId);
      db.prepare(`
        INSERT INTO device_user_history (device_id, user_id, assigned_at) VALUES (?, ?, datetime('now'))
      `).run(deviceId, userId);
      db.prepare('UPDATE devices SET owner_user_id = ? WHERE id = ?').run(userId, deviceId);
    });
    tx();
    const device = db.prepare('SELECT hostname, device_type FROM devices WHERE id = ?').get(deviceId);
    const user = db.prepare('SELECT full_name FROM users WHERE id = ?').get(userId);
    auditLogRepo.log('ownership', deviceId, 'update',
      `«${device ? (device.hostname || device.device_type) : deviceId}» закреплено за «${user ? user.full_name : userId}»`);
    return { deviceId, userId };
  },
  /** Открепляет текущего владельца (если есть) — закрывает активную запись истории */
  unassign(deviceId) {
    const db = getDb();
    const device = db.prepare('SELECT hostname, device_type, owner_user_id FROM devices WHERE id = ?').get(deviceId);
    const prevOwner = device && device.owner_user_id ? db.prepare('SELECT full_name FROM users WHERE id = ?').get(device.owner_user_id) : null;
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE device_user_history SET unassigned_at = datetime('now')
        WHERE device_id = ? AND unassigned_at IS NULL
      `).run(deviceId);
      db.prepare('UPDATE devices SET owner_user_id = NULL WHERE id = ?').run(deviceId);
    });
    tx();
    if (device) {
      auditLogRepo.log('ownership', deviceId, 'update',
        `«${device.hostname || device.device_type}» откреплено${prevOwner ? ` от «${prevOwner.full_name}»` : ''}`);
    }
    return { deviceId };
  }
};

// ------------------------------------------------------------
// Комплектующие устройства (с историей замен)
// ------------------------------------------------------------

/** Человекочитаемое название устройства по id для журнала изменений — hostname,
 *  либо тип устройства, если hostname не задан, либо просто #id, если устройства уже нет. */
function deviceLabelForLog(db, deviceId) {
  const device = db.prepare('SELECT hostname, device_type FROM devices WHERE id = ?').get(deviceId);
  return device ? (device.hostname || device.device_type) : `#${deviceId}`;
}

const componentsRepo = {
  listByDevice(deviceId) {
    return getDb().prepare(`
      SELECT * FROM device_components WHERE device_id = ? ORDER BY (detached_at IS NOT NULL), id DESC
    `).all(deviceId);
  },
  /** Все действующие (не снятые) комплектующие по всем устройствам сразу — для поиска
   *  на вкладке "Устройства", чтобы не делать отдельный запрос на каждую карточку */
  listAllActive() {
    return getDb().prepare(`
      SELECT device_id, component_type, description FROM device_components WHERE detached_at IS NULL
    `).all();
  },
  add({ device_id, component_type, description, cost = null, note = null }) {
    const db = getDb();
    const info = db.prepare(`
      INSERT INTO device_components (device_id, component_type, description, cost, attached_at, note)
      VALUES (?, ?, ?, ?, datetime('now'), ?)
    `).run(device_id, component_type, description, cost, note);
    auditLogRepo.log('component', info.lastInsertRowid, 'create', `«${deviceLabelForLog(db, device_id)}»: установлено «${description}»`);
    return db.prepare('SELECT * FROM device_components WHERE id = ?').get(info.lastInsertRowid);
  },
  detach(id) {
    const db = getDb();
    const comp = db.prepare('SELECT * FROM device_components WHERE id = ?').get(id);
    // Повторное снятие раньше перезаписывало исходную дату снятия и давало ещё одну
    // запись в журнале — история искажалась. Теперь второй вызов ничего не делает.
    if (!comp || comp.detached_at) return { id, alreadyDetached: true };
    db.prepare(`UPDATE device_components SET detached_at = datetime('now') WHERE id = ?`).run(id);
    auditLogRepo.log('component', id, 'update', `«${deviceLabelForLog(db, comp.device_id)}»: снято «${comp.description}»`);
    return { id };
  },
  remove(id) {
    const db = getDb();
    const comp = db.prepare('SELECT * FROM device_components WHERE id = ?').get(id);
    db.prepare('DELETE FROM device_components WHERE id = ?').run(id);
    if (comp) auditLogRepo.log('component', id, 'delete', `Запись о «${comp.description}» удалена безвозвратно`);
    return { id };
  }
};

// ------------------------------------------------------------
// Периферия устройства (с историей)
// ------------------------------------------------------------

const peripheralsRepo = {
  listByDevice(deviceId) {
    return getDb().prepare(`
      SELECT * FROM device_peripherals WHERE device_id = ? ORDER BY (detached_at IS NOT NULL), id DESC
    `).all(deviceId);
  },
  /** Все действующие (не снятые) периферийные устройства по всем устройствам сразу —
   *  для поиска на вкладке "Устройства" */
  listAllActive() {
    return getDb().prepare(`
      SELECT device_id, peripheral_type, description FROM device_peripherals WHERE detached_at IS NULL
    `).all();
  },
  add({ device_id, peripheral_type, description, note = null }) {
    const db = getDb();
    const info = db.prepare(`
      INSERT INTO device_peripherals (device_id, peripheral_type, description, attached_at, note)
      VALUES (?, ?, ?, datetime('now'), ?)
    `).run(device_id, peripheral_type, description, note);
    auditLogRepo.log('peripheral', info.lastInsertRowid, 'create', `«${deviceLabelForLog(db, device_id)}»: подключена периферия «${description}»`);
    return db.prepare('SELECT * FROM device_peripherals WHERE id = ?').get(info.lastInsertRowid);
  },
  detach(id) {
    const db = getDb();
    const periph = db.prepare('SELECT * FROM device_peripherals WHERE id = ?').get(id);
    // См. componentsRepo.detach — повторный вызов не должен переписывать дату и журнал
    if (!periph || periph.detached_at) return { id, alreadyDetached: true };
    db.prepare(`UPDATE device_peripherals SET detached_at = datetime('now') WHERE id = ?`).run(id);
    auditLogRepo.log('peripheral', id, 'update', `«${deviceLabelForLog(db, periph.device_id)}»: отключена «${periph.description}»`);
    return { id };
  },
  remove(id) {
    const db = getDb();
    const periph = db.prepare('SELECT * FROM device_peripherals WHERE id = ?').get(id);
    db.prepare('DELETE FROM device_peripherals WHERE id = ?').run(id);
    if (periph) auditLogRepo.log('peripheral', id, 'delete', `Запись о «${periph.description}» удалена безвозвратно`);
    return { id };
  }
};

// ------------------------------------------------------------
// ПО на устройствах (с историей установки/снятия, лицензионный ключ)
// ------------------------------------------------------------

const softwareRepo = {
  listByDevice(deviceId) {
    return getDb().prepare(`
      SELECT * FROM device_software WHERE device_id = ? ORDER BY (removed_at IS NOT NULL), id DESC
    `).all(deviceId);
  },
  /** Реестр ПО для листа "ПО" — все действующие установки по всем устройствам сразу */
  listActive() {
    return getDb().prepare(`
      SELECT s.*, d.hostname AS device_hostname, d.id AS device_id
      FROM device_software s
      JOIN devices d ON d.id = s.device_id
      WHERE s.removed_at IS NULL
      ORDER BY s.id DESC
    `).all();
  },
  add({ device_id, software_type, name, license_key = null, cost = null, note = null }) {
    const db = getDb();
    const info = db.prepare(`
      INSERT INTO device_software (device_id, software_type, name, license_key, cost, installed_at, note)
      VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
    `).run(device_id, software_type, name, license_key, cost, note);
    auditLogRepo.log('software', info.lastInsertRowid, 'create', `«${deviceLabelForLog(db, device_id)}»: установлено ПО «${name}»`);
    return db.prepare('SELECT * FROM device_software WHERE id = ?').get(info.lastInsertRowid);
  },
  /** Редактирование записи об установленном ПО прямо с листа "ПО" — устройство
   *  (device_id) и даты установки/снятия не меняем: перенос ПО на другое устройство —
   *  это "снять на склад" + "выдать", а не правка карточки. */
  update(id, { software_type, name, license_key = null, cost = null, note = null }) {
    const db = getDb();
    const before = db.prepare('SELECT * FROM device_software WHERE id = ?').get(id);
    if (!before) throw new Error('Запись о ПО не найдена');
    if (!SOFTWARE_TYPES.includes(software_type)) throw new Error('Недопустимый тип ПО');
    const cleanName = (name || '').trim();
    if (!cleanName) throw new Error('Название ПО не может быть пустым');
    db.prepare(`
      UPDATE device_software SET software_type = ?, name = ?, license_key = ?, cost = ?, note = ?
      WHERE id = ?
    `).run(software_type, cleanName, license_key, cost, note, id);
    auditLogRepo.log('software', id, 'update',
      before.name === cleanName
        ? `Запись о ПО «${cleanName}» отредактирована`
        : `Запись о ПО «${before.name}» отредактирована (переименована в «${cleanName}»)`);
    return db.prepare('SELECT * FROM device_software WHERE id = ?').get(id);
  },
  remove(id) {
    const db = getDb();
    const sw = db.prepare('SELECT * FROM device_software WHERE id = ?').get(id);
    db.prepare('DELETE FROM device_software WHERE id = ?').run(id);
    if (sw) auditLogRepo.log('software', id, 'delete', `Запись о ПО «${sw.name}» удалена безвозвратно`);
    return { id };
  },
  /** Ручная пометка Проблема/Внимание/Ошибка — null снимает пометку */
  setFlag(id, flag) {
    if (flag !== null && !FLAG_VALUES.includes(flag)) throw new Error('Недопустимая пометка');
    getDb().prepare(`UPDATE device_software SET flag = ? WHERE id = ?`).run(flag, id);
    const sw = getDb().prepare('SELECT * FROM device_software WHERE id = ?').get(id);
    auditLogRepo.log('software', id, 'update',
      flag ? `ПО «${sw.name}» помечено «${FLAG_LABELS_RU[flag] || flag}»` : `С ПО «${sw.name}» снята пометка`);
    return sw;
  }
};

// ------------------------------------------------------------
// Склад: комплектующие/ПО, снятые с устройств, до выдачи на другое устройство
// ------------------------------------------------------------

const WAREHOUSE_STATUSES = ['ordered', 'in_stock', 'issued', 'written_off'];
const WAREHOUSE_STATUS_LABELS_RU = { ordered: 'Заказано', in_stock: 'На складе', issued: 'Выдано', written_off: 'Списано' };

const warehouseRepo = {
  list(category = null) {
    const db = getDb();
    if (category) {
      return db.prepare(`
        SELECT w.*, sd.hostname AS source_device_hostname, td.hostname AS target_device_hostname
        FROM warehouse_items w
        LEFT JOIN devices sd ON sd.id = w.source_device_id
        LEFT JOIN devices td ON td.id = w.target_device_id
        WHERE w.category = ?
        ORDER BY (w.removed_at IS NOT NULL), w.id DESC
      `).all(category);
    }
    return db.prepare(`
      SELECT w.*, sd.hostname AS source_device_hostname, td.hostname AS target_device_hostname
      FROM warehouse_items w
      LEFT JOIN devices sd ON sd.id = w.source_device_id
      LEFT JOIN devices td ON td.id = w.target_device_id
      ORDER BY (w.removed_at IS NOT NULL), w.id DESC
    `).all();
  },
  /** Прямое добавление на склад — без привязки к какому-либо устройству
   *  (новая закупленная деталь/лицензия, а не снятая с ПК). */
  add({ category, item_type, description, license_key = null, cost = null, status = 'in_stock', note = null }) {
    if (!WAREHOUSE_STATUSES.includes(status)) throw new Error('Недопустимый статус');
    const info = getDb().prepare(`
      INSERT INTO warehouse_items (category, item_type, description, license_key, cost, status, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(category, item_type, description, license_key, cost, status, note);
    auditLogRepo.log('warehouse_item', info.lastInsertRowid, 'create', `На склад добавлено «${description}»`);
    return getDb().prepare('SELECT * FROM warehouse_items WHERE id = ?').get(info.lastInsertRowid);
  },
  /** Редактирование складской карточки — не трогает source/target (это история, а не поле формы) */
  update(id, { item_type, description, license_key = null, cost = null, status, preserveStatus = false, note = null }) {
    if (!preserveStatus && !WAREHOUSE_STATUSES.includes(status)) throw new Error('Недопустимый статус');
    getDb().prepare(`
      UPDATE warehouse_items SET item_type = ?, description = ?, license_key = ?, cost = ?, status = COALESCE(?, status), note = ?
      WHERE id = ?
    `).run(item_type, description, license_key, cost, preserveStatus ? null : status, note, id);
    auditLogRepo.log('warehouse_item', id, 'update', `Складская запись «${description}» отредактирована`);
    return getDb().prepare('SELECT * FROM warehouse_items WHERE id = ?').get(id);
  },
  /** Снимает комплектующую с устройства (закрывает device_components) и кладёт на склад, сохраняя стоимость */
  receiveComponent(componentId, note = null) {
    const db = getDb();
    let logText;
    const tx = db.transaction(() => {
      const comp = db.prepare('SELECT * FROM device_components WHERE id = ?').get(componentId);
      if (!comp) throw new Error('Комплектующая не найдена');
      // Без этой проверки повторный вызов (двойной клик, либо две клиентские сессии
      // подряд) создавал ВТОРУЮ складскую позицию из той же комплектующей — на складе
      // появлялся дубликат. Та же защита, что и в issueToDevice.
      if (comp.detached_at) throw new Error('Эта комплектующая уже снята с устройства');
      db.prepare(`UPDATE device_components SET detached_at = datetime('now') WHERE id = ?`).run(componentId);
      db.prepare(`
        INSERT INTO warehouse_items (category, item_type, description, cost, status, source_device_id, note)
        VALUES ('component', ?, ?, ?, 'in_stock', ?, ?)
      `).run(comp.component_type, comp.description, comp.cost, comp.device_id, note);
      logText = `«${comp.description}» снято с «${deviceLabelForLog(db, comp.device_id)}» и отправлено на склад`;
    });
    tx();
    auditLogRepo.log('warehouse_item', componentId, 'update', logText);
    return { componentId };
  },
  /** Снимает ПО с устройства (закрывает device_software) и кладёт на склад — ключ и стоимость сохраняются */
  receiveSoftware(softwareId, note = null) {
    const db = getDb();
    let logText;
    const tx = db.transaction(() => {
      const sw = db.prepare('SELECT * FROM device_software WHERE id = ?').get(softwareId);
      if (!sw) throw new Error('ПО не найдено');
      // Главная причина дублей снятого ПО на складе: повторный вызов вставлял ещё одну
      // складскую позицию, а removed_at просто перезаписывался — одна лицензия
      // превращалась на складе в две (и больше)
      if (sw.removed_at) throw new Error('Это ПО уже снято с устройства');
      db.prepare(`UPDATE device_software SET removed_at = datetime('now') WHERE id = ?`).run(softwareId);
      db.prepare(`
        INSERT INTO warehouse_items (category, item_type, description, license_key, cost, status, source_device_id, note)
        VALUES ('software', ?, ?, ?, ?, 'in_stock', ?, ?)
      `).run(sw.software_type, sw.name, sw.license_key, sw.cost, sw.device_id, note);
      logText = `«${sw.name}» снято с «${deviceLabelForLog(db, sw.device_id)}» и отправлено на склад`;
    });
    tx();
    auditLogRepo.log('warehouse_item', softwareId, 'update', logText);
    return { softwareId };
  },
  /** Выдаёт складскую единицу на устройство: создаёт новую запись в components/software (со стоимостью)
   *  и закрывает складскую (status='issued'). */
  issueToDevice(itemId, deviceId) {
    const db = getDb();
    const tx = db.transaction(() => {
      const item = db.prepare('SELECT * FROM warehouse_items WHERE id = ?').get(itemId);
      if (!item) throw new Error('Позиция склада не найдена');
      if (item.removed_at || item.status === 'issued') throw new Error('Эта позиция уже выдана');
      if (item.status === 'written_off') throw new Error('Эта позиция списана');

      if (item.category === 'component') {
        db.prepare(`
          INSERT INTO device_components (device_id, component_type, description, cost, attached_at, note)
          VALUES (?, ?, ?, ?, datetime('now'), ?)
        `).run(deviceId, item.item_type, item.description, item.cost, 'выдано со склада');
      } else {
        db.prepare(`
          INSERT INTO device_software (device_id, software_type, name, license_key, cost, installed_at, note)
          VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
        `).run(deviceId, item.item_type, item.description, item.license_key, item.cost, 'выдано со склада');
      }

      const { removed_at } = db.prepare(`
        UPDATE warehouse_items SET removed_at = datetime('now'), target_device_id = ?, status = 'issued' WHERE id = ?
        RETURNING removed_at
      `).get(deviceId, itemId);
      auditLogRepo.log('warehouse_item', itemId, 'update',
        `«${item.description}» выдано на «${deviceLabelForLog(db, deviceId)}»`);
      return removed_at;
    });
    const removedAt = tx();
    return { itemId, deviceId, removedAt };
  },
  /** Быстрая смена статуса без правки остальных полей (например, "получено" или "списано") */
  setStatus(id, status) {
    if (!WAREHOUSE_STATUSES.includes(status)) throw new Error('Недопустимый статус');
    getDb().prepare('UPDATE warehouse_items SET status = ? WHERE id = ?').run(status, id);
    const item = getDb().prepare('SELECT * FROM warehouse_items WHERE id = ?').get(id);
    auditLogRepo.log('warehouse_item', id, 'status_change', `«${item.description}»: статус → ${WAREHOUSE_STATUS_LABELS_RU[status] || status}`);
    return item;
  },
  remove(id) {
    const item = getDb().prepare('SELECT * FROM warehouse_items WHERE id = ?').get(id);
    getDb().prepare('DELETE FROM warehouse_items WHERE id = ?').run(id);
    if (item) auditLogRepo.log('warehouse_item', id, 'delete', `Складская запись «${item.description}» удалена безвозвратно`);
    return { id };
  },
  /** Ручная пометка Проблема/Внимание/Ошибка — null снимает пометку */
  setFlag(id, flag) {
    if (flag !== null && !FLAG_VALUES.includes(flag)) throw new Error('Недопустимая пометка');
    getDb().prepare(`UPDATE warehouse_items SET flag = ? WHERE id = ?`).run(flag, id);
    const item = getDb().prepare('SELECT * FROM warehouse_items WHERE id = ?').get(id);
    auditLogRepo.log('warehouse_item', id, 'update',
      flag ? `«${item.description}» помечено «${FLAG_LABELS_RU[flag] || flag}»` : `С «${item.description}» снята пометка`);
    return item;
  }
};

// ------------------------------------------------------------
// Зоны на плане (заливка внутри стен + перемещаемая/поворачиваемая подпись)
// ------------------------------------------------------------

const zonesRepo = {
  listByPlan(floorPlanId) {
    return getDb().prepare('SELECT * FROM plan_zones WHERE floor_plan_id = ?').all(floorPlanId);
  },
  create({ floor_plan_id, name, cells, label_x = null, label_y = null, label_rotation = 0, label_visible = 1 }) {
    const info = getDb().prepare(`
      -- клетки зоны тоже должны оставаться внутри границ плана
      INSERT INTO plan_zones (floor_plan_id, name, cells, label_x, label_y, label_rotation, label_visible)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(floor_plan_id, name, JSON.stringify(cells), label_x, label_y, label_rotation, label_visible ? 1 : 0);
    const zone = getDb().prepare('SELECT * FROM plan_zones WHERE id = ?').get(info.lastInsertRowid);
    auditLogRepo.log('zone', zone.id, 'create', `Зона «${zone.name}» создана на плане`);
    return zone;
  },
  /** Правит название/позицию и поворот подписи/видимость — форма геометрии (cells) не меняется */
  updateLabel(id, { name, label_x = null, label_y = null, label_rotation = 0, label_visible = 1 }) {
    const before = getDb().prepare('SELECT name FROM plan_zones WHERE id = ?').get(id);
    getDb().prepare(`
      UPDATE plan_zones SET name = ?, label_x = ?, label_y = ?, label_rotation = ?, label_visible = ?
      WHERE id = ?
    `).run(name, label_x, label_y, label_rotation, label_visible ? 1 : 0, id);
    if (before && before.name !== name) {
      auditLogRepo.log('zone', id, 'update', `Зона «${before.name}» переименована в «${name}»`);
    }
    return getDb().prepare('SELECT * FROM plan_zones WHERE id = ?').get(id);
  },
  remove(id) {
    const zone = getDb().prepare('SELECT * FROM plan_zones WHERE id = ?').get(id);
    getDb().prepare('DELETE FROM plan_zones WHERE id = ?').run(id);
    if (zone) auditLogRepo.log('zone', id, 'delete', `Зона «${zone.name}» удалена с плана`);
    return { id };
  }
};

/** Вкладка "Сеть": иерархия строится из двух источников связей —
 *  1) уже нарисованные кабели (в пределах одного этажа, откуда обе стороны кабеля),
 *  2) ручной аплинк devices.uplink_device_id (может связывать устройства с разных этажей,
 *     когда кабель физически провести нельзя). Оба источника объединяются в одно дерево. */
const AUDIT_LOG_LIMIT = 10000;

const auditLogRepo = {
  /** Пишет одну запись в журнал и обрезает старые сверх лимита. Вызывается из других
   *  репозиториев при значимых действиях — сама по себе не публичный IPC-метод записи
   *  (запись происходит как побочный эффект самого действия, не отдельным вызовом). */
  log(entityType, entityId, action, summary) {
    const db = getDb();
    db.prepare(`
      INSERT INTO audit_log (entity_type, entity_id, action, summary) VALUES (?, ?, ?, ?)
    `).run(entityType, entityId, action, summary);
    const count = db.prepare('SELECT COUNT(*) AS c FROM audit_log').get().c;
    if (count > AUDIT_LOG_LIMIT) {
      db.prepare(`
        DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log ORDER BY id ASC LIMIT ?)
      `).run(count - AUDIT_LOG_LIMIT);
    }
  },
  /** Список записей, новые сверху. from/to — границы created_at (включительно, формат
   *  'YYYY-MM-DD' или полный datetime), entityType — необязательный фильтр по типу сущности. */
  list({ from = null, to = null, entityType = null, limit = 500 } = {}) {
    const db = getDb();
    const conditions = [];
    const params = [];
    if (from) { conditions.push('created_at >= ?'); params.push(from); }
    if (to) { conditions.push('created_at <= ?'); params.push(to); }
    if (entityType) { conditions.push('entity_type = ?'); params.push(entityType); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    return db.prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ?`).all(...params);
  },
  count() {
    return getDb().prepare('SELECT COUNT(*) AS c FROM audit_log').get().c;
  },
  /** Записи с id > sinceId, старые сверху (хронологический порядок — клиент применяет
   *  по порядку) — используется клиентским heartbeat для "что изменилось с прошлой
   *  проверки", без сравнения меток времени (автоинкрементный id проще и надёжнее). */
  listSince(sinceId = 0, limit = 200) {
    return getDb().prepare(`
      SELECT * FROM audit_log WHERE id > ? ORDER BY id ASC LIMIT ?
    `).all(sinceId, limit);
  },
  /** Самый свежий id на момент вызова — чтобы клиент знал, с чего начинать отслеживание
   *  (при первом подключении не нужно засыпать пользователя всей историей изменений). */
  latestId() {
    return getDb().prepare('SELECT COALESCE(MAX(id), 0) AS id FROM audit_log').get().id;
  }
};

// Реестр счетов поставщиков (задача #8) — в отдельном модуле, чтобы не раздувать этот файл
const invoicesRepo = require('./invoices').createInvoicesRepo({ getDb, auditLogRepo });

const networkRepo = {
  /** Кандидаты в корень дерева — роутеры и свитчи */
  listRoots() {
    return getDb().prepare(`
      SELECT id, hostname, device_type, status FROM devices
      WHERE device_type IN ('router','switch') AND status != 'decommissioned'
      ORDER BY hostname
    `).all();
  },
  /** Строит дерево от заданного устройства. */
  buildTree(rootDeviceId) {
    return networkRepo._buildNode(rootDeviceId, new Set([rootDeviceId]));
  },
  /** Внутренний рекурсивный помощник. Важен ДВУХФАЗНЫЙ порядок обработки прямых пиров
   *  (все на одном сегменте — общая шина, "линия" в терминах ТЗ): сначала ВСЕ прямые
   *  пиры пемечаются visited и запоминаются, и только ПОТОМ для каждого достраивается
   *  поддерево. Если делать это одним проходом (пометить и сразу рекурсировать), первый
   *  пир успевает утащить второго себе в children раньше, чем внешний цикл до него
   *  дойдёт — вместо трёх устройств рядом под общим свитчом получается цепочка
   *  ПК1 -> ПК2 -> ПК3, как будто каждый подключён к предыдущему. */
  _buildNode(deviceId, visited) {
    const db = getDb();
    const device = db.prepare(`
      SELECT d.*, dlp.status AS last_ping_status
      FROM devices d LEFT JOIN device_latest_ping dlp ON dlp.device_id = d.id
      WHERE d.id = ?
    `).get(deviceId);
    if (!device) return null;

    // Кабели, к которым подключено это устройство (обычно один; у многопортовых
    // роутеров/свитчей — может быть несколько сразу)
    const myConnections = db.prepare(`
      SELECT cc.cable_id, pi.network_role FROM cable_connections cc
      JOIN plan_items pi ON pi.id = cc.plan_item_id
      WHERE pi.ref_id = ? AND pi.item_type = 'device'
    `).all(deviceId);

    // Все уникальные пиры по ВСЕМ этим кабелям сразу — с указанием, через какой именно
    // кабель нашлась связь (для подписи в дереве и перехода по клику на кабель)
    const peerMap = new Map(); // device_id -> { cableId, cableLabel }
    myConnections.forEach(({ cable_id }) => {
      const cable = db.prepare('SELECT id, label FROM cables WHERE id = ?').get(cable_id);
      if (!cable) return;
      const peers = db.prepare(`
        SELECT DISTINCT pi.ref_id AS device_id FROM cable_connections cc
        JOIN plan_items pi ON pi.id = cc.plan_item_id
        WHERE cc.cable_id = ? AND pi.item_type = 'device' AND pi.ref_id != ?
      `).all(cable_id, deviceId);
      peers.forEach((p) => {
        if (!peerMap.has(p.device_id)) peerMap.set(p.device_id, { cableId: cable.id, cableLabel: cable.label });
      });
    });

    // ФАЗА 1: сразу помечаем visited и запоминаем ВСЕХ прямых пиров — до рекурсии в любого
    const freshPeers = [];
    peerMap.forEach((info, peerId) => {
      if (!visited.has(peerId)) { visited.add(peerId); freshPeers.push({ peerId, ...info }); }
    });

    const children = [];
    // ФАЗА 2: теперь достраиваем поддерево каждого пира — они уже не смогут утащить
    // друг друга (все прямые пиры этого сегмента уже отмечены visited)
    freshPeers.forEach(({ peerId, cableId, cableLabel }) => {
      const childNode = networkRepo._buildNode(peerId, visited);
      if (childNode) {
        childNode.via = 'cable';
        childNode.via_cable_id = cableId;
        childNode.via_cable_label = cableLabel;
        children.push(childNode);
      }
    });

    // Ручные аплинки — отдельный механизм (явная иерархия, не общий сегмент)
    const uplinkChildren = db.prepare('SELECT id FROM devices WHERE uplink_device_id = ?').all(deviceId);
    uplinkChildren.forEach((row) => {
      if (!visited.has(row.id)) {
        const childNode = networkRepo._buildNode(row.id, visited);
        if (childNode) { childNode.via = 'uplink'; children.push(childNode); }
      }
    });

    return {
      id: device.id, hostname: device.hostname, device_type: device.device_type,
      status: device.status, flag: device.flag, last_ping_status: device.last_ping_status,
      network_role: (myConnections[0] && myConnections[0].network_role) || null,
      via: null, via_cable_id: null, via_cable_label: null, children
    };
  }
};

module.exports = {
  setUserDataPath, getUserDataDir,
  initDatabase, getDb, getDbReadonly, markReadonly, releaseDbLock, dbLock, usersRepo, bitrixSyncRepo, devicesRepo, pingRepo,
  floorPlansRepo, planItemsRepo, cablesRepo, cableConnectionsRepo,
  ownershipRepo, componentsRepo, peripheralsRepo,
  softwareRepo, warehouseRepo, zonesRepo, networkRepo, auditLogRepo, invoicesRepo,
  getDefaultDbPath, getCurrentDbPath, getLastConnectWarning, setConfiguredDbPath, getConfiguredDbPath,
  getAppMode, getHostPort, getRemoteHost, setHostMode, setClientMode, getDiscoveryPath,
  getServerToken, getSourceKind,
  DEFAULT_DOOR_WIDTH, DEFAULT_WIFI_RADIUS_M, WIFI_DEVICE_TYPES,
  getAllowClientWrites, setAllowClientWrites
};
