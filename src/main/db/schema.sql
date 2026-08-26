-- ============================================================
-- Схема БД для сервиса учёта компьютеров/устройств и планов
-- СУБД: SQLite (встраивается в Electron через better-sqlite3)
-- Шаг сетки на планах фиксирован в floor_plans.grid_step (по умолчанию 900)
-- ============================================================

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------
-- Пользователи
-- ------------------------------------------------------------
CREATE TABLE users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name   TEXT NOT NULL,
    department  TEXT,
    position    TEXT,
    email       TEXT,
    phone       TEXT,
    notes       TEXT,
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dismissed')),
    flag        TEXT CHECK (flag IN ('problem','attention','error')), -- ручная пометка, NULL = нет
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------
-- Устройства: компьютеры, ноутбуки, сервера, роутеры, свитчи, принтеры и т.д.
-- Единая таблица, т.к. любое из них может иметь IP и пинговаться.
-- ------------------------------------------------------------
CREATE TABLE devices (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    device_type       TEXT NOT NULL CHECK (device_type IN
                        ('computer','laptop','server','vm','router','switch','printer','other')),
    inventory_number  TEXT UNIQUE,      -- у VM обычно NULL, инвентарного номера нет
    hostname          TEXT,
    os                TEXT,
    cpu               TEXT,
    ram               TEXT,
    disk              TEXT,
    owner_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    host_device_id    INTEGER REFERENCES devices(id) ON DELETE CASCADE,
                        -- заполнено только для device_type='vm': физический сервер-хост
    status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN
                        ('active','repair','storage','decommissioned')),
    flag              TEXT CHECK (flag IN ('problem','attention','error')), -- ручная пометка, NULL = нет
    purchase_date     TEXT,
    warranty_until    TEXT,
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (
        (device_type = 'vm' AND host_device_id IS NOT NULL)
        OR (device_type <> 'vm' AND host_device_id IS NULL)
    )
);

CREATE INDEX idx_devices_owner ON devices(owner_user_id);
CREATE INDEX idx_devices_type ON devices(device_type);
CREATE INDEX idx_devices_status ON devices(status);
CREATE INDEX idx_devices_host ON devices(host_device_id);

-- ------------------------------------------------------------
-- Сетевые интерфейсы устройства (может быть несколько: LAN + Wi-Fi и т.п.)
-- ------------------------------------------------------------
CREATE TABLE network_interfaces (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id       INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    interface_name  TEXT,               -- eth0, Wi-Fi, LAN1 и т.п.
    ip_address      TEXT,
    mac_address     TEXT,
    is_primary      INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1))
);

CREATE INDEX idx_netif_device ON network_interfaces(device_id);
CREATE INDEX idx_netif_ip ON network_interfaces(ip_address);
CREATE INDEX idx_netif_mac ON network_interfaces(mac_address);

-- Только один primary-интерфейс на устройство
CREATE UNIQUE INDEX idx_netif_one_primary
    ON network_interfaces(device_id)
    WHERE is_primary = 1;

-- ------------------------------------------------------------
-- История пингов
-- ------------------------------------------------------------
CREATE TABLE ping_log (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id         INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    checked_at        TEXT NOT NULL DEFAULT (datetime('now')),
    status            TEXT NOT NULL CHECK (status IN ('online','offline','timeout')),
    response_time_ms  INTEGER
);

CREATE INDEX idx_pinglog_device_time ON ping_log(device_id, checked_at DESC);

-- Последний пинг по каждому устройству — используется для индикаторов online/offline
-- и на карточках устройств, и на иконках плана, без отдельного запроса на каждое устройство.
CREATE VIEW device_latest_ping AS
SELECT device_id, status, checked_at
FROM (
    SELECT device_id, status, checked_at,
           ROW_NUMBER() OVER (PARTITION BY device_id ORDER BY checked_at DESC, id DESC) AS rn
    FROM ping_log
)
WHERE rn = 1;

-- ------------------------------------------------------------
-- Здания / площадки (на будущее, даже если сейчас один офис)
-- ------------------------------------------------------------
CREATE TABLE sites (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT NOT NULL,
    address TEXT
);

-- ------------------------------------------------------------
-- Этажи / помещения
-- ------------------------------------------------------------
CREATE TABLE floors (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id     INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    order_index INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_floors_site ON floors(site_id);

-- ------------------------------------------------------------
-- Планы («планчики») — сеточные схемы помещений
-- ------------------------------------------------------------
CREATE TABLE floor_plans (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    floor_id          INTEGER NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    grid_step         INTEGER NOT NULL DEFAULT 900,
    grid_width_cells  INTEGER NOT NULL DEFAULT 96,
    grid_height_cells INTEGER NOT NULL DEFAULT 54,
    background_image  TEXT,   -- путь/base64 подложки, опционально
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_floorplans_floor ON floor_plans(floor_id);

-- ------------------------------------------------------------
-- Элементы на плане: столы, устройства, прочее
-- Несколько элементов в одной ячейке допустимы — z_index решает порядок отрисовки.
-- ------------------------------------------------------------
CREATE TABLE plan_items (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    floor_plan_id  INTEGER NOT NULL REFERENCES floor_plans(id) ON DELETE CASCADE,
    item_type      TEXT NOT NULL CHECK (item_type IN ('desk','device','wall','door','stairs','other')),
    ref_id         INTEGER REFERENCES devices(id) ON DELETE SET NULL,
                    -- заполнено, если item_type = 'device'; на план кладутся только
                    -- физические устройства (device_type <> 'vm') — проверяется в приложении,
                    -- т.к. SQLite CHECK не может обращаться к другой таблице
    x              INTEGER NOT NULL,   -- точечные элементы: координата в шагах сетки;
                                        -- линейные (wall/door/stairs): начало отрезка
    y              INTEGER NOT NULL,
    x2             INTEGER,            -- линейные элементы: конец отрезка; NULL для desk/device
    y2             INTEGER,
    rotation       INTEGER NOT NULL DEFAULT 0 CHECK (rotation IN (0,90,180,270)),
    width_cells    INTEGER NOT NULL DEFAULT 1,
    height_cells   INTEGER NOT NULL DEFAULT 1,
    label          TEXT,
    z_index        INTEGER NOT NULL DEFAULT 0,
    review_note    TEXT    -- ручной комментарий "на проверку" — независим от пометок сущностей
);

CREATE INDEX idx_planitems_plan ON plan_items(floor_plan_id);
CREATE INDEX idx_planitems_plan_xy ON plan_items(floor_plan_id, x, y);
CREATE INDEX idx_planitems_ref ON plan_items(ref_id);

-- ------------------------------------------------------------
-- Кабели — условные связи между элементами плана.
-- waypoints хранит промежуточные точки маршрута в виде JSON-массива [{"x":.., "y":..}, ...]
-- ------------------------------------------------------------
CREATE TABLE cables (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    floor_plan_id  INTEGER NOT NULL REFERENCES floor_plans(id) ON DELETE CASCADE,
    from_item_id   INTEGER NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
    to_item_id     INTEGER NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
    cable_type     TEXT NOT NULL DEFAULT 'network' CHECK (cable_type IN ('network','power','other')),
    label          TEXT,
    waypoints      TEXT NOT NULL DEFAULT '[]',  -- JSON: [{"x":3,"y":5}, ...]
    CHECK (from_item_id <> to_item_id)
);

CREATE INDEX idx_cables_plan ON cables(floor_plan_id);
CREATE INDEX idx_cables_from ON cables(from_item_id);
CREATE INDEX idx_cables_to ON cables(to_item_id);

-- ------------------------------------------------------------
-- История владельцев устройства (кто и когда был закреплён/откреплён)
-- ------------------------------------------------------------
CREATE TABLE device_user_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id     INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_at   TEXT,     -- NULL = точная дата неизвестна (например, импорт из старого списка)
    unassigned_at TEXT,     -- NULL = закреплён по сей день (актуальный владелец)
    note          TEXT
);
CREATE INDEX idx_history_device ON device_user_history(device_id);
CREATE INDEX idx_history_user ON device_user_history(user_id);

-- ------------------------------------------------------------
-- Комплектующие устройства с историей замен (мат.плата/CPU/RAM/диски/видеокарта и т.п.)
-- ------------------------------------------------------------
CREATE TABLE device_components (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id     INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    component_type TEXT NOT NULL CHECK (component_type IN
                    ('motherboard','cpu','ram','disk','gpu','psu','other')),
    description   TEXT NOT NULL,
    cost          REAL,    -- необязательная стоимость
    attached_at   TEXT,     -- NULL = дата неизвестна
    detached_at   TEXT,     -- NULL = стоит в устройстве по сей день
    note          TEXT
);
CREATE INDEX idx_components_device ON device_components(device_id);

-- ------------------------------------------------------------
-- Периферия устройства с историей (монитор/ИБП/клавиатура/мышь и т.п.)
-- ------------------------------------------------------------
CREATE TABLE device_peripherals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id       INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    peripheral_type TEXT NOT NULL CHECK (peripheral_type IN
                      ('monitor','ups','keyboard','mouse','other')),
    description     TEXT NOT NULL,
    attached_at     TEXT,   -- NULL = дата неизвестна
    detached_at     TEXT,   -- NULL = используется по сей день
    note            TEXT
);
CREATE INDEX idx_peripherals_device ON device_peripherals(device_id);

-- ------------------------------------------------------------
-- Программное обеспечение на устройстве (с историей установки/снятия, лицензионный ключ)
-- ------------------------------------------------------------
CREATE TABLE device_software (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id     INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    software_type TEXT NOT NULL CHECK (software_type IN ('os','office','antivirus','other')),
    name          TEXT NOT NULL,
    license_key   TEXT,
    cost          REAL,    -- необязательная стоимость
    installed_at  TEXT,
    removed_at    TEXT,
    flag          TEXT CHECK (flag IN ('problem','attention','error')), -- ручная пометка, NULL = нет
    note          TEXT
);
CREATE INDEX idx_software_device ON device_software(device_id);

-- ------------------------------------------------------------
-- Склад: комплектующие и лицензии ПО, снятые с устройств (или заведённые напрямую),
-- пока не установлены на другое устройство.
-- ------------------------------------------------------------
CREATE TABLE warehouse_items (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    category          TEXT NOT NULL CHECK (category IN ('component','software')),
    item_type         TEXT NOT NULL,  -- component_type или software_type в зависимости от category
    description       TEXT NOT NULL,
    license_key       TEXT,           -- актуально только для category='software'
    cost              REAL,           -- необязательная стоимость
    status            TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN ('ordered','in_stock','issued','written_off')),
    flag              TEXT CHECK (flag IN ('problem','attention','error')), -- ручная пометка, NULL = нет
    source_device_id  INTEGER REFERENCES devices(id) ON DELETE SET NULL,
    added_at          TEXT NOT NULL DEFAULT (datetime('now')),
    removed_at        TEXT,           -- NULL = лежит на складе; иначе выдано на устройство
    target_device_id  INTEGER REFERENCES devices(id) ON DELETE SET NULL,
    note              TEXT
);
CREATE INDEX idx_warehouse_status ON warehouse_items(category, removed_at);

-- ------------------------------------------------------------
-- История статусов устройства (в т.ч. отправка на сервисное обслуживание)
-- ------------------------------------------------------------
CREATE TABLE device_status_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    status      TEXT NOT NULL,
    changed_at  TEXT NOT NULL DEFAULT (datetime('now')),
    note        TEXT
);
CREATE INDEX idx_status_history_device ON device_status_history(device_id);

-- ------------------------------------------------------------
-- Зоны на плане — заливка замкнутой стенами области + подпись (перемещаемая,
-- поворачиваемая на произвольный угол, может быть скрыта)
-- ------------------------------------------------------------
CREATE TABLE plan_zones (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    floor_plan_id  INTEGER NOT NULL REFERENCES floor_plans(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    cells          TEXT NOT NULL,              -- JSON: [[x,y], [x,y], ...] — клетки, входящие в зону
    label_x        REAL,                       -- позиция подписи в пикселях канвы; NULL = центроид зоны
    label_y        REAL,
    label_rotation REAL NOT NULL DEFAULT 0,     -- произвольный угол поворота подписи, в градусах
    label_visible  INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_zones_plan ON plan_zones(floor_plan_id);

-- ============================================================
-- Полнотекстовый поиск (FTS5) по устройствам и пользователям
-- ============================================================

CREATE VIRTUAL TABLE devices_fts USING fts5(
    hostname, inventory_number, os, notes,
    content='devices', content_rowid='id'
);

CREATE VIRTUAL TABLE users_fts USING fts5(
    full_name, department, position, email, phone,
    content='users', content_rowid='id'
);

-- Триггеры синхронизации FTS с основными таблицами
CREATE TRIGGER devices_ai AFTER INSERT ON devices BEGIN
    INSERT INTO devices_fts(rowid, hostname, inventory_number, os, notes)
    VALUES (new.id, new.hostname, new.inventory_number, new.os, new.notes);
END;
CREATE TRIGGER devices_ad AFTER DELETE ON devices BEGIN
    INSERT INTO devices_fts(devices_fts, rowid, hostname, inventory_number, os, notes)
    VALUES ('delete', old.id, old.hostname, old.inventory_number, old.os, old.notes);
END;
CREATE TRIGGER devices_au AFTER UPDATE ON devices BEGIN
    INSERT INTO devices_fts(devices_fts, rowid, hostname, inventory_number, os, notes)
    VALUES ('delete', old.id, old.hostname, old.inventory_number, old.os, old.notes);
    INSERT INTO devices_fts(rowid, hostname, inventory_number, os, notes)
    VALUES (new.id, new.hostname, new.inventory_number, new.os, new.notes);
END;

CREATE TRIGGER users_ai AFTER INSERT ON users BEGIN
    INSERT INTO users_fts(rowid, full_name, department, position, email, phone)
    VALUES (new.id, new.full_name, new.department, new.position, new.email, new.phone);
END;
CREATE TRIGGER users_ad AFTER DELETE ON users BEGIN
    INSERT INTO users_fts(users_fts, rowid, full_name, department, position, email, phone)
    VALUES ('delete', old.id, old.full_name, old.department, old.position, old.email, old.phone);
END;
CREATE TRIGGER users_au AFTER UPDATE ON users BEGIN
    INSERT INTO users_fts(users_fts, rowid, full_name, department, position, email, phone)
    VALUES ('delete', old.id, old.full_name, old.department, old.position, old.email, old.phone);
    INSERT INTO users_fts(rowid, full_name, department, position, email, phone)
    VALUES (new.id, new.full_name, new.department, new.position, new.email, new.phone);
END;
