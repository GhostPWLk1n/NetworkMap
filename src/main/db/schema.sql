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
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    -- Связь с сотрудником Битрикс24 (см. src/main/bitrix.js). NULL — карточка ведётся
    -- только локально. Уникальность — индексом ниже, а не проверкой в коде: только так
    -- два одновременных сохранения не создадут две карточки одного сотрудника.
    bitrix_id        INTEGER CHECK (bitrix_id IS NULL OR bitrix_id > 0),
    bitrix_synced_at TEXT
);
-- NULL в уникальном индексе SQLite не конфликтуют друг с другом, поэтому несвязанных
-- карточек может быть сколько угодно, а связанная с одним ID — только одна.
CREATE UNIQUE INDEX idx_users_bitrix_id ON users(bitrix_id);

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
    uplink_device_id  INTEGER REFERENCES devices(id) ON DELETE SET NULL,
                        -- ручная связь для сетевой иерархии (вкладка "Сеть") — куда подключён
                        -- этот роутер/свитч, если кабель провести нельзя (например, через этажи)
    status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN
                        ('active','repair','storage','decommissioned')),
    flag              TEXT CHECK (flag IN ('problem','attention','error')), -- ручная пометка, NULL = нет
    purchase_date     TEXT,
    warranty_until    TEXT,
    notes             TEXT,
    wifi_radius_m     REAL CHECK (wifi_radius_m IS NULL OR (wifi_radius_m > 0 AND wifi_radius_m <= 500)),
                        -- условный радиус охвата Wi-Fi в метрах (клетка плана = 1 м).
                        -- NULL = брать значение по умолчанию (см. DEFAULT_WIFI_RADIUS_M).
                        -- Именно условный: реальный охват зависит от стен и помех, план
                        -- этого не моделирует и не претендует на расчёт
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (device_type = 'vm' OR host_device_id IS NULL)
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
    grid_min_x        INTEGER NOT NULL DEFAULT 0,
    grid_min_y        INTEGER NOT NULL DEFAULT 0,
                        -- Начало координат плана. Прямоугольник плана — это
                        -- [grid_min_x; grid_min_x + grid_width_cells) по X и так же по Y,
                        -- то есть он может начинаться и с ОТРИЦАТЕЛЬНОЙ клетки. Нужно
                        -- потому, что чертят не от угла: здание легко оказывается выше и
                        -- левее исходной точки, а от границ плана зависят заливка зон и
                        -- привязка смещения — за границей они просто не работают.
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
    item_type      TEXT NOT NULL CHECK (item_type IN ('desk','device','wall','door','stairs','border','other','group')),
                    -- 'border' — условная перегородка: рисуется как стена и так же держит
                    -- заливку зоны, но отображается тонкой линией. Нужна, чтобы разделить
                    -- одно помещение на несколько зон, не изображая капитальную стену
                    -- (двери в неё не вставляются, см. renderer)
    ref_id         INTEGER REFERENCES devices(id) ON DELETE SET NULL,
                    -- заполнено, если item_type = 'device'; на план кладутся только
                    -- физические устройства (device_type <> 'vm') — проверяется в приложении,
                    -- т.к. SQLite CHECK не может обращаться к другой таблице
    x              INTEGER NOT NULL,   -- точечные элементы: координата в шагах сетки;
                                        -- линейные (wall/door/stairs): начало отрезка
    y              INTEGER NOT NULL,
    x2             INTEGER,            -- линейные элементы: конец отрезка; NULL для desk/device
    y2             INTEGER,
    rotation       INTEGER NOT NULL DEFAULT 0 CHECK (rotation >= 0 AND rotation < 360),
                    -- произвольный угол 0..359: у двери кодирует hinge/swing (кратные 90),
                    -- у лестницы — направление подъёма, у устройства — свободный поворот
                    -- иконки (например, вдоль скошенной стены)
    offset_x       REAL NOT NULL DEFAULT 0 CHECK (offset_x >= -0.5 AND offset_x <= 0.5),
    offset_y       REAL NOT NULL DEFAULT 0 CHECK (offset_y >= -0.5 AND offset_y <= 0.5),
                    -- положение внутри СВОЕЙ клетки в долях клетки (0,0 — центр):
                    -- не зависит от размера клетки в пикселях, поэтому переживает
                    -- смену масштаба сетки; нужно для привязки к косым стенам
    width_cells    INTEGER NOT NULL DEFAULT 1,
    height_cells   INTEGER NOT NULL DEFAULT 1,
    label          TEXT,
    z_index        INTEGER NOT NULL DEFAULT 0,
    review_note    TEXT,   -- ручной комментарий "на проверку" — независим от пометок сущностей
    network_role   TEXT CHECK (network_role IN ('primary','backup','satellite')),
                    -- роль устройства (обычно роутера) в сетевом сегменте кабеля, если на
                    -- сегменте несколько роутеров — выбирается вручную. Подключение к
                    -- кабелю само по себе — в отдельной таблице cable_connections
                    -- (многие-ко-многим: многопортовый роутер может быть на нескольких)
    group_label    TEXT,   -- название группы (только для item_type='group'), например "Шкаф А1"
    door_width     REAL NOT NULL DEFAULT 0.9 CHECK (door_width > 0 AND door_width <= 20)
                    -- ширина проёма для item_type='door', в клетках. Клетка — условный
                    -- метр, поэтому 0.9 это и 0.9 клетки, и 0.9 м. Хранится у каждой
                    -- двери: ширины в одном помещении обычно разные, а общая настройка
                    -- "ширина по умолчанию" ломалась бы при изменении задним числом
);

CREATE INDEX idx_planitems_plan ON plan_items(floor_plan_id);
CREATE INDEX idx_planitems_plan_xy ON plan_items(floor_plan_id, x, y);
CREATE INDEX idx_planitems_ref ON plan_items(ref_id);

-- Устройства, сгруппированные в одной клетке (например, несколько юнитов в одном
-- шкафу) — по аналогии с папками на Android: второе устройство на уже занятой клетке
-- образует группу вместо перекрытия. Сама группа — обычный plan_item (item_type='group'),
-- эта таблица — её содержимое (многие устройства на одну группу).
CREATE TABLE plan_item_group_members (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    group_item_id   INTEGER NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
    device_id       INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    added_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(group_item_id, device_id)
);
CREATE INDEX idx_group_members_group ON plan_item_group_members(group_item_id);
CREATE INDEX idx_group_members_device ON plan_item_group_members(device_id);

-- ------------------------------------------------------------
-- Кабели — условные связи между элементами плана.
-- waypoints хранит промежуточные точки маршрута в виде JSON-массива [{"x":.., "y":..}, ...]
-- ------------------------------------------------------------
CREATE TABLE cables (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    floor_plan_id  INTEGER NOT NULL REFERENCES floor_plans(id) ON DELETE CASCADE,
    from_item_id   INTEGER REFERENCES plan_items(id) ON DELETE SET NULL,
    to_item_id     INTEGER REFERENCES plan_items(id) ON DELETE SET NULL,
                    -- необязательны: кабель можно провести и без устройств на концах —
                    -- устройства подключаются через сокеты (см. cable_sockets), а не напрямую
    cable_type     TEXT NOT NULL DEFAULT 'network' CHECK (cable_type IN ('network','power','other')),
    label          TEXT,
    waypoints      TEXT NOT NULL DEFAULT '[]',  -- JSON: [{"x":3,"y":5}, ...] — устаревшее, для обратной совместимости
    path           TEXT NOT NULL DEFAULT '[]',  -- JSON: [{"x":..,"y":..}, ...] — полный путь линии, точки редактирования
    color          TEXT NOT NULL DEFAULT '#4a90d9',  -- разные кабели рядом — разным цветом
    CHECK (from_item_id IS NULL OR to_item_id IS NULL OR from_item_id <> to_item_id)
);

CREATE INDEX idx_cables_plan ON cables(floor_plan_id);
CREATE INDEX idx_cables_from ON cables(from_item_id);
CREATE INDEX idx_cables_to ON cables(to_item_id);

-- ------------------------------------------------------------
-- Сокеты на кабеле — точки, где устройство "подключается" к линии.
-- Все устройства на сокетах одного кабеля образуют один сетевой сегмент.
-- ------------------------------------------------------------
-- ------------------------------------------------------------
-- Подключения устройств к кабелям — устройство подключается напрямую к кабелю
-- (условному сетевому пучку), без промежуточного сокета. Многие-ко-многим:
-- роутер/свитч может быть подключён к нескольким кабелям сразу (многопортовый),
-- конечное устройство (ПК и т.п.) — только к одному (обеспечивается в коде,
-- а не ограничением схемы, т.к. правило зависит от device_type).
-- ------------------------------------------------------------
CREATE TABLE cable_connections (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_item_id  INTEGER NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
    cable_id      INTEGER NOT NULL REFERENCES cables(id) ON DELETE CASCADE,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(plan_item_id, cable_id)
);

CREATE INDEX idx_cable_connections_item ON cable_connections(plan_item_id);
CREATE INDEX idx_cable_connections_cable ON cable_connections(cable_id);

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

-- ------------------------------------------------------------
-- Журнал изменений — лог всех значимых действий пользователя в приложении.
-- Без внешних ключей на сущности намеренно: запись должна остаться в истории,
-- даже если сама сущность потом будет удалена (иначе "удалил устройство" сотрёт
-- сам факт своего удаления при каскаде). Лимит 10 000 записей — старые обрезаются
-- в auditLogRepo.log() при вставке новой.
-- ------------------------------------------------------------
CREATE TABLE audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    entity_type  TEXT NOT NULL,   -- 'user' | 'device' | 'plan_item' | 'cable' | 'zone' | 'warehouse_item' |
                                   -- 'software' | 'component' | 'peripheral' | 'floor_plan' | 'ownership' | 'invoice'
    entity_id    INTEGER,         -- id сущности на момент действия (может уже не существовать)
    action       TEXT NOT NULL,   -- 'create' | 'update' | 'delete' | 'status_change' | другое короткое слово
    summary      TEXT NOT NULL    -- человекочитаемое описание, готовое для показа в списке
);
CREATE INDEX idx_audit_log_created ON audit_log(created_at);
CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id);

-- ============================================================
-- Документы поставщиков (задача #8: счета; та же таблица файлов пригодится для
-- коммерческих предложений, #5)
-- ============================================================

-- Оригиналы загруженных документов. Файл хранится прямо в базе (BLOB), а не рядом с
-- ней: карточка и оригинал пишутся одной транзакцией (не бывает карточки без файла и
-- «осиротевших» файлов), резервная копия базы (db.backup на сервере) уносит оригиналы
-- вместе с данными, а клиент получает файл по тому же RPC, что и всё остальное.
-- sha256 уникален — один и тот же PDF второй раз не сохраняется.
CREATE TABLE document_files (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    sha256       TEXT NOT NULL UNIQUE CHECK (length(sha256) = 64),
    file_name    TEXT NOT NULL,
    mime_type    TEXT NOT NULL DEFAULT 'application/pdf',
    size_bytes   INTEGER NOT NULL CHECK (size_bytes > 0),
    page_count   INTEGER,
    content      BLOB NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Счета поставщиков. Суммы — канонические десятичные строки ("1234.50"), как в
-- документе, без округления через float (см. src/shared/invoiceMath.js).
-- Сохранение счёта НЕ создаёт приход на склад и не меняет остатки.
CREATE TABLE invoices (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id        INTEGER NOT NULL UNIQUE REFERENCES document_files(id),
    number         TEXT NOT NULL,
    invoice_date   TEXT NOT NULL,          -- YYYY-MM-DD
    supplier_name  TEXT NOT NULL,
    supplier_inn   TEXT,
    supplier_kpp   TEXT,
    buyer_name     TEXT,
    buyer_inn      TEXT,
    buyer_kpp      TEXT,
    currency       TEXT,                   -- RUB / USD / EUR …; NULL — в документе не указана
    total_amount   TEXT,
    vat_amount     TEXT,
    amount_due     TEXT,
    vat_note       TEXT,                   -- «Без налога (НДС)» и т. п., как в документе
    notes          TEXT,
    recognition    TEXT,                   -- JSON: что распознано автоматически (для истории)
    revision       INTEGER NOT NULL DEFAULT 1,   -- растёт при каждой правке: защита от затирания чужих правок
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_invoices_requisites ON invoices(supplier_inn, number, invoice_date);
CREATE INDEX idx_invoices_date ON invoices(invoice_date);

-- Позиции счёта в порядке документа. Наименование — как в счёте, без «нормализации».
CREATE TABLE invoice_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id   INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    position     INTEGER NOT NULL CHECK (position > 0),
    name         TEXT NOT NULL,
    code         TEXT,                     -- код / артикул
    unit         TEXT,
    quantity     TEXT,
    price        TEXT,
    amount       TEXT,
    vat_rate     TEXT,                     -- как в документе: «20%», «Без НДС»
    vat_amount   TEXT,
    UNIQUE (invoice_id, position)
);

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
