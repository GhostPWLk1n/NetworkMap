const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const Database = require('better-sqlite3');

let db;
let currentDbPath = null;
let lastConnectWarning = null; // строка предупреждения, если пришлось откатиться на локальную БД

const SCHEMA_VERSION = 14;
const FLAG_VALUES = ['problem', 'attention', 'error']; // null = нет пометки, отдельно не входит в список
const FLAG_LABELS_RU = { problem: 'Проблема', attention: 'Внимание', error: 'Ошибка' }; // для текста в журнале изменений
const DEVICE_STATUS_LABELS_RU = { active: 'Активен', repair: 'Ремонт', storage: 'На складе', decommissioned: 'Списан' };
const PLAN_ITEM_TYPE_LABELS_RU = { device: 'Устройство', desk: 'Стол', wall: 'Стена', door: 'Дверь', stairs: 'Лестница' };

/** Человекочитаемое название объекта плана для журнала изменений — для устройства
 *  подставляет его hostname, для остальных типов — просто название типа. */
function planItemLabelForLog(db, item) {
  if (item.item_type === 'device' && item.ref_id) {
    const device = db.prepare('SELECT hostname, device_type FROM devices WHERE id = ?').get(item.ref_id);
    return `Устройство «${device ? (device.hostname || device.device_type) : '?'}»`;
  }
  return PLAN_ITEM_TYPE_LABELS_RU[item.item_type] || item.item_type;
}

function getDefaultDbPath() {
  return path.join(app.getPath('userData'), 'data.db');
}

function getConfigPath() {
  return path.join(app.getPath('userData'), 'db-config.json');
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
 */
function initDatabase(explicitPath) {
  const dbPath = explicitPath || resolveDbPath();
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

function getCurrentDbPath() { return currentDbPath; }
function getLastConnectWarning() { return lastConnectWarning; }

/** Запоминает новый путь в конфиге — вступит в силу после перезапуска приложения
 *  (перезапуск проще и надёжнее, чем на лету переподключать все окна/списки/канву) */
function setConfiguredDbPath(newPath) {
  saveDbConfig({ dbPath: newPath || null });
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
  create({ device_type, hostname = null, inventory_number = null, os = null, cpu = null,
           ram = null, disk = null, owner_user_id = null, host_device_id = null,
           status = 'active', notes = null, ip_address = null, mac_address = null }) {
    const db = getDb();
    const insertDevice = db.prepare(`
      INSERT INTO devices (device_type, hostname, inventory_number, os, cpu, ram, disk,
                            owner_user_id, host_device_id, status, notes)
      VALUES (@device_type, @hostname, @inventory_number, @os, @cpu, @ram, @disk,
              @owner_user_id, @host_device_id, @status, @notes)
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
      owner_user_id, host_device_id, status, notes, ip_address, mac_address
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
                ram = null, disk = null, status = 'active', notes = null,
                ip_address = undefined, mac_address = undefined }) {
    const db = getDb();
    const tx = db.transaction(() => {
      const before = db.prepare('SELECT status FROM devices WHERE id = ?').get(id);
      db.prepare(`
        UPDATE devices SET device_type = ?, hostname = ?, inventory_number = ?, os = ?, cpu = ?,
                            ram = ?, disk = ?, status = ?, notes = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(device_type, hostname, inventory_number, os, cpu, ram, disk, status, notes, id);

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
             d.uplink_device_id AS device_uplink_id
      FROM plan_items pi
      LEFT JOIN devices d ON d.id = pi.ref_id
      LEFT JOIN network_interfaces ni ON ni.device_id = d.id AND ni.is_primary = 1
      LEFT JOIN device_latest_ping dlp ON dlp.device_id = d.id
      LEFT JOIN users u ON u.id = d.owner_user_id
      WHERE pi.floor_plan_id = ?
      ORDER BY pi.z_index, pi.id
    `).all(floorPlanId);
  },
  /** На каких планах (этажах) размещено устройство — для кнопки "Найти на плане" */
  findByDeviceRef(deviceId) {
    return getDb().prepare(`
      SELECT pi.*, fp.name AS floor_plan_name
      FROM plan_items pi
      JOIN floor_plans fp ON fp.id = pi.floor_plan_id
      WHERE pi.ref_id = ? AND pi.item_type = 'device'
    `).all(deviceId);
  },
  /** id устройств, уже размещённых хоть на каком-то этаже — карман "Устройства" на плане
   *  не должен предлагать их повторно (одно физическое устройство — одно место на плане) */
  listPlacedDeviceIds() {
    return getDb().prepare(`
      SELECT DISTINCT ref_id FROM plan_items WHERE item_type = 'device' AND ref_id IS NOT NULL
    `).all().map((r) => r.ref_id);
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
           width_cells = 1, height_cells = 1, label = null, z_index = 0 }) {
    const db = getDb();
    const info = db.prepare(`
      INSERT INTO plan_items (floor_plan_id, item_type, ref_id, x, y, x2, y2, rotation,
                               width_cells, height_cells, label, z_index)
      VALUES (@floor_plan_id, @item_type, @ref_id, @x, @y, @x2, @y2, @rotation,
              @width_cells, @height_cells, @label, @z_index)
    `).run({ floor_plan_id, item_type, ref_id, x, y, x2, y2, rotation, width_cells, height_cells, label, z_index });
    const item = db.prepare('SELECT * FROM plan_items WHERE id = ?').get(info.lastInsertRowid);
    auditLogRepo.log('plan_item', item.id, 'create', `${planItemLabelForLog(db, item)} размещён(а) на плане`);
    return item;
  },
  move(id, x, y) {
    getDb().prepare('UPDATE plan_items SET x = ?, y = ? WHERE id = ?').run(x, y, id);
    return { id, x, y };
  },
  /** Смена rotation без прочих полей — у двери используется для "Развернуть"/"Отразить" */
  setRotation(id, rotation) {
    getDb().prepare('UPDATE plan_items SET rotation = ? WHERE id = ?').run(rotation, id);
    return getDb().prepare('SELECT * FROM plan_items WHERE id = ?').get(id);
  },
  remove(id) {
    const db = getDb();
    const item = db.prepare('SELECT * FROM plan_items WHERE id = ?').get(id);
    db.prepare('DELETE FROM plan_items WHERE id = ?').run(id);
    if (item) auditLogRepo.log('plan_item', id, 'delete', `${planItemLabelForLog(db, item)} убран(а) с плана`);
    return { id };
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
    db.prepare(`UPDATE device_components SET detached_at = datetime('now') WHERE id = ?`).run(id);
    if (comp) auditLogRepo.log('component', id, 'update', `«${deviceLabelForLog(db, comp.device_id)}»: снято «${comp.description}»`);
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
    db.prepare(`UPDATE device_peripherals SET detached_at = datetime('now') WHERE id = ?`).run(id);
    if (periph) auditLogRepo.log('peripheral', id, 'update', `«${deviceLabelForLog(db, periph.device_id)}»: отключена «${periph.description}»`);
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
  update(id, { item_type, description, license_key = null, cost = null, status, note = null }) {
    if (!WAREHOUSE_STATUSES.includes(status)) throw new Error('Недопустимый статус');
    getDb().prepare(`
      UPDATE warehouse_items SET item_type = ?, description = ?, license_key = ?, cost = ?, status = ?, note = ?
      WHERE id = ?
    `).run(item_type, description, license_key, cost, status, note, id);
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
    let logText;
    const tx = db.transaction(() => {
      const item = db.prepare('SELECT * FROM warehouse_items WHERE id = ?').get(itemId);
      if (!item) throw new Error('Позиция склада не найдена');
      if (item.removed_at) throw new Error('Эта позиция уже выдана');

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

      db.prepare(`UPDATE warehouse_items SET removed_at = datetime('now'), target_device_id = ?, status = 'issued' WHERE id = ?`)
        .run(deviceId, itemId);
      logText = `«${item.description}» выдано на «${deviceLabelForLog(db, deviceId)}»`;
    });
    tx();
    auditLogRepo.log('warehouse_item', itemId, 'update', logText);
    return { itemId, deviceId };
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
  }
};

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
  initDatabase, getDb, usersRepo, devicesRepo, pingRepo,
  floorPlansRepo, planItemsRepo, cablesRepo, cableConnectionsRepo,
  ownershipRepo, componentsRepo, peripheralsRepo,
  softwareRepo, warehouseRepo, zonesRepo, networkRepo, auditLogRepo,
  getDefaultDbPath, getCurrentDbPath, getLastConnectWarning, setConfiguredDbPath
};
