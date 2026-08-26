const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const Database = require('better-sqlite3');

let db;
let currentDbPath = null;
let lastConnectWarning = null; // строка предупреждения, если пришлось откатиться на локальную БД

const SCHEMA_VERSION = 10;
const FLAG_VALUES = ['problem', 'attention', 'error']; // null = нет пометки, отдельно не входит в список

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
    return getDb().prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  },
  remove(id) {
    getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
    return { id };
  },
  update(id, { full_name, department = null, position = null, email = null, phone = null, notes = null }) {
    getDb().prepare(`
      UPDATE users SET full_name = ?, department = ?, position = ?, email = ?, phone = ?, notes = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(full_name, department, position, email, phone, notes, id);
    return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
  },
  /** Быстрое увольнение/восстановление — отдельно от общей формы редактирования, как и у устройств */
  setStatus(id, status) {
    if (status !== 'active' && status !== 'dismissed') throw new Error('Недопустимый статус');
    getDb().prepare(`UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
    return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
  },
  /** Ручная пометка Проблема/Внимание/Ошибка — null снимает пометку */
  setFlag(id, flag) {
    if (flag !== null && !FLAG_VALUES.includes(flag)) throw new Error('Недопустимая пометка');
    getDb().prepare(`UPDATE users SET flag = ? WHERE id = ?`).run(flag, id);
    return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
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
    return db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
  },
  remove(id) {
    getDb().prepare('DELETE FROM devices WHERE id = ?').run(id);
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
    return db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  },
  /** Быстрая смена статуса (кнопка "Сервис" и т.п.) — не трогает остальные поля устройства */
  setStatus(id, status, note = null) {
    const db = getDb();
    const tx = db.transaction(() => {
      db.prepare(`UPDATE devices SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
      db.prepare('INSERT INTO device_status_history (device_id, status, note) VALUES (?, ?, ?)').run(id, status, note);
    });
    tx();
    return db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  },
  statusHistory(id) {
    return getDb().prepare('SELECT * FROM device_status_history WHERE device_id = ? ORDER BY id DESC').all(id);
  },
  /** Ручная пометка Проблема/Внимание/Ошибка — null снимает пометку */
  setFlag(id, flag) {
    if (flag !== null && !FLAG_VALUES.includes(flag)) throw new Error('Недопустимая пометка');
    getDb().prepare(`UPDATE devices SET flag = ? WHERE id = ?`).run(flag, id);
    return getDb().prepare('SELECT * FROM devices WHERE id = ?').get(id);
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

    return db.prepare('SELECT * FROM floor_plans WHERE id = ?').get(info.lastInsertRowid);
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
    db.prepare('DELETE FROM floor_plans WHERE id = ?').run(id);
    return { id };
  },
  rename(id, name) {
    getDb().prepare('UPDATE floor_plans SET name = ? WHERE id = ?').run(name, id);
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
             d.status AS device_status, d.flag AS device_flag, u.status AS owner_status
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
  create({ floor_plan_id, item_type, ref_id = null, x, y, x2 = null, y2 = null, rotation = 0,
           width_cells = 1, height_cells = 1, label = null, z_index = 0 }) {
    const info = getDb().prepare(`
      INSERT INTO plan_items (floor_plan_id, item_type, ref_id, x, y, x2, y2, rotation,
                               width_cells, height_cells, label, z_index)
      VALUES (@floor_plan_id, @item_type, @ref_id, @x, @y, @x2, @y2, @rotation,
              @width_cells, @height_cells, @label, @z_index)
    `).run({ floor_plan_id, item_type, ref_id, x, y, x2, y2, rotation, width_cells, height_cells, label, z_index });
    return getDb().prepare('SELECT * FROM plan_items WHERE id = ?').get(info.lastInsertRowid);
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
    getDb().prepare('DELETE FROM plan_items WHERE id = ?').run(id);
    return { id };
  }
};

const cablesRepo = {
  listByPlan(floorPlanId) {
    return getDb().prepare('SELECT * FROM cables WHERE floor_plan_id = ?').all(floorPlanId);
  },
  create({ floor_plan_id, from_item_id, to_item_id, cable_type = 'network', label = null, waypoints = [] }) {
    const info = getDb().prepare(`
      INSERT INTO cables (floor_plan_id, from_item_id, to_item_id, cable_type, label, waypoints)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(floor_plan_id, from_item_id, to_item_id, cable_type, label, JSON.stringify(waypoints));
    return getDb().prepare('SELECT * FROM cables WHERE id = ?').get(info.lastInsertRowid);
  },
  remove(id) {
    getDb().prepare('DELETE FROM cables WHERE id = ?').run(id);
    return { id };
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
    return { deviceId, userId };
  },
  /** Открепляет текущего владельца (если есть) — закрывает активную запись истории */
  unassign(deviceId) {
    const db = getDb();
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE device_user_history SET unassigned_at = datetime('now')
        WHERE device_id = ? AND unassigned_at IS NULL
      `).run(deviceId);
      db.prepare('UPDATE devices SET owner_user_id = NULL WHERE id = ?').run(deviceId);
    });
    tx();
    return { deviceId };
  }
};

// ------------------------------------------------------------
// Комплектующие устройства (с историей замен)
// ------------------------------------------------------------

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
    const info = getDb().prepare(`
      INSERT INTO device_components (device_id, component_type, description, cost, attached_at, note)
      VALUES (?, ?, ?, ?, datetime('now'), ?)
    `).run(device_id, component_type, description, cost, note);
    return getDb().prepare('SELECT * FROM device_components WHERE id = ?').get(info.lastInsertRowid);
  },
  detach(id) {
    getDb().prepare(`UPDATE device_components SET detached_at = datetime('now') WHERE id = ?`).run(id);
    return { id };
  },
  remove(id) {
    getDb().prepare('DELETE FROM device_components WHERE id = ?').run(id);
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
    const info = getDb().prepare(`
      INSERT INTO device_peripherals (device_id, peripheral_type, description, attached_at, note)
      VALUES (?, ?, ?, datetime('now'), ?)
    `).run(device_id, peripheral_type, description, note);
    return getDb().prepare('SELECT * FROM device_peripherals WHERE id = ?').get(info.lastInsertRowid);
  },
  detach(id) {
    getDb().prepare(`UPDATE device_peripherals SET detached_at = datetime('now') WHERE id = ?`).run(id);
    return { id };
  },
  remove(id) {
    getDb().prepare('DELETE FROM device_peripherals WHERE id = ?').run(id);
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
    const info = getDb().prepare(`
      INSERT INTO device_software (device_id, software_type, name, license_key, cost, installed_at, note)
      VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
    `).run(device_id, software_type, name, license_key, cost, note);
    return getDb().prepare('SELECT * FROM device_software WHERE id = ?').get(info.lastInsertRowid);
  },
  remove(id) {
    getDb().prepare('DELETE FROM device_software WHERE id = ?').run(id);
    return { id };
  },
  /** Ручная пометка Проблема/Внимание/Ошибка — null снимает пометку */
  setFlag(id, flag) {
    if (flag !== null && !FLAG_VALUES.includes(flag)) throw new Error('Недопустимая пометка');
    getDb().prepare(`UPDATE device_software SET flag = ? WHERE id = ?`).run(flag, id);
    return getDb().prepare('SELECT * FROM device_software WHERE id = ?').get(id);
  }
};

// ------------------------------------------------------------
// Склад: комплектующие/ПО, снятые с устройств, до выдачи на другое устройство
// ------------------------------------------------------------

const WAREHOUSE_STATUSES = ['ordered', 'in_stock', 'issued', 'written_off'];

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
    return getDb().prepare('SELECT * FROM warehouse_items WHERE id = ?').get(info.lastInsertRowid);
  },
  /** Редактирование складской карточки — не трогает source/target (это история, а не поле формы) */
  update(id, { item_type, description, license_key = null, cost = null, status, note = null }) {
    if (!WAREHOUSE_STATUSES.includes(status)) throw new Error('Недопустимый статус');
    getDb().prepare(`
      UPDATE warehouse_items SET item_type = ?, description = ?, license_key = ?, cost = ?, status = ?, note = ?
      WHERE id = ?
    `).run(item_type, description, license_key, cost, status, note, id);
    return getDb().prepare('SELECT * FROM warehouse_items WHERE id = ?').get(id);
  },
  /** Снимает комплектующую с устройства (закрывает device_components) и кладёт на склад, сохраняя стоимость */
  receiveComponent(componentId, note = null) {
    const db = getDb();
    const tx = db.transaction(() => {
      const comp = db.prepare('SELECT * FROM device_components WHERE id = ?').get(componentId);
      if (!comp) throw new Error('Комплектующая не найдена');
      db.prepare(`UPDATE device_components SET detached_at = datetime('now') WHERE id = ?`).run(componentId);
      db.prepare(`
        INSERT INTO warehouse_items (category, item_type, description, cost, status, source_device_id, note)
        VALUES ('component', ?, ?, ?, 'in_stock', ?, ?)
      `).run(comp.component_type, comp.description, comp.cost, comp.device_id, note);
    });
    tx();
    return { componentId };
  },
  /** Снимает ПО с устройства (закрывает device_software) и кладёт на склад — ключ и стоимость сохраняются */
  receiveSoftware(softwareId, note = null) {
    const db = getDb();
    const tx = db.transaction(() => {
      const sw = db.prepare('SELECT * FROM device_software WHERE id = ?').get(softwareId);
      if (!sw) throw new Error('ПО не найдено');
      db.prepare(`UPDATE device_software SET removed_at = datetime('now') WHERE id = ?`).run(softwareId);
      db.prepare(`
        INSERT INTO warehouse_items (category, item_type, description, license_key, cost, status, source_device_id, note)
        VALUES ('software', ?, ?, ?, ?, 'in_stock', ?, ?)
      `).run(sw.software_type, sw.name, sw.license_key, sw.cost, sw.device_id, note);
    });
    tx();
    return { softwareId };
  },
  /** Выдаёт складскую единицу на устройство: создаёт новую запись в components/software (со стоимостью)
   *  и закрывает складскую (status='issued'). */
  issueToDevice(itemId, deviceId) {
    const db = getDb();
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
    });
    tx();
    return { itemId, deviceId };
  },
  /** Быстрая смена статуса без правки остальных полей (например, "получено" или "списано") */
  setStatus(id, status) {
    if (!WAREHOUSE_STATUSES.includes(status)) throw new Error('Недопустимый статус');
    getDb().prepare('UPDATE warehouse_items SET status = ? WHERE id = ?').run(status, id);
    return getDb().prepare('SELECT * FROM warehouse_items WHERE id = ?').get(id);
  },
  remove(id) {
    getDb().prepare('DELETE FROM warehouse_items WHERE id = ?').run(id);
    return { id };
  },
  /** Ручная пометка Проблема/Внимание/Ошибка — null снимает пометку */
  setFlag(id, flag) {
    if (flag !== null && !FLAG_VALUES.includes(flag)) throw new Error('Недопустимая пометка');
    getDb().prepare(`UPDATE warehouse_items SET flag = ? WHERE id = ?`).run(flag, id);
    return getDb().prepare('SELECT * FROM warehouse_items WHERE id = ?').get(id);
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
    return getDb().prepare('SELECT * FROM plan_zones WHERE id = ?').get(info.lastInsertRowid);
  },
  /** Правит название/позицию и поворот подписи/видимость — форма геометрии (cells) не меняется */
  updateLabel(id, { name, label_x = null, label_y = null, label_rotation = 0, label_visible = 1 }) {
    getDb().prepare(`
      UPDATE plan_zones SET name = ?, label_x = ?, label_y = ?, label_rotation = ?, label_visible = ?
      WHERE id = ?
    `).run(name, label_x, label_y, label_rotation, label_visible ? 1 : 0, id);
    return getDb().prepare('SELECT * FROM plan_zones WHERE id = ?').get(id);
  },
  remove(id) {
    getDb().prepare('DELETE FROM plan_zones WHERE id = ?').run(id);
    return { id };
  }
};

module.exports = {
  initDatabase, getDb, usersRepo, devicesRepo, pingRepo,
  floorPlansRepo, planItemsRepo, cablesRepo,
  ownershipRepo, componentsRepo, peripheralsRepo,
  softwareRepo, warehouseRepo, zonesRepo,
  getDefaultDbPath, getCurrentDbPath, getLastConnectWarning, setConfiguredDbPath
};
