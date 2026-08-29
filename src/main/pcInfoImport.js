const fs = require('fs');
const path = require('path');
const { getDb, devicesRepo, softwareRepo } = require('./db');

/**
 * Импорт сведений о ПК из JSON-файлов, собранных scripts/collect-pc-info.ps1.
 * Двухшаговый процесс, а не слепое слияние (в отличие от import.js для Excel):
 *   1) parsePcInfoFile/parsePcInfoFolder — читает файл(ы), СЧИТАЕТ diff с уже
 *      существующим устройством того же hostname, ничего не пишет в БД.
 *   2) applyPcInfoImport — применяет разобранный результат, при расхождении полей
 *      берёт то, что выбрал пользователь (fieldChoices), а не молча одно из двух.
 * Так и было решено: при совпадении hostname — спрашивать пользователя интерактивно,
 * а не затирать и не пропускать автоматически.
 */

const FIELD_DEFS = [
  { key: 'os', label: 'ОС' },
  { key: 'cpu', label: 'CPU' },
  { key: 'ram', label: 'RAM' },
  { key: 'disk', label: 'Диск' },
  { key: 'ip_address', label: 'IP-адрес' },
  { key: 'mac_address', label: 'MAC-адрес' }
];

/** Читает и разбирает один JSON-файл, собранный scripts/collect-pc-info.ps1. Не пишет
 *  в БД. Формат — вложенный: OperatingSystem / Hardware.System / Hardware.Processor /
 *  Hardware.Disks / Network / Software / Metadata.ComputerName. Массивы из одного
 *  элемента ConvertTo-Json в PowerShell иногда схлопывает в голый объект — везде ниже
 *  это учтено (Array.isArray(x) ? x : [x]).
 *  forceDeviceId — если задан (импорт из карточки конкретного устройства), diff
 *  считается против ЭТОГО устройства напрямую, а не по совпадению hostname —
 *  hostname из файла при этом никогда не подменяет hostname карточки. Без
 *  forceDeviceId (пакетный импорт папки) — обычный поиск по hostname. */
function parsePcInfoFile(filePath, forceDeviceId = null) {
  // Windows PowerShell 5.1 пишет UTF-8 файлы с BOM по умолчанию (Out-File -Encoding utf8) —
  // JSON.parse в Node.js падает, если строка начинается с этого символа, поэтому снимаем его
  const raw = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${path.basename(filePath)}: файл повреждён или не в формате JSON`);
  }

  const hostname = data.Metadata && data.Metadata.ComputerName;
  if (!hostname) throw new Error(`${path.basename(filePath)}: нет поля Metadata.ComputerName`);

  const db = getDb();
  const existingRow = forceDeviceId
    ? db.prepare(`
        SELECT d.*, ni.ip_address AS ip_address, ni.mac_address AS mac_address
        FROM devices d LEFT JOIN network_interfaces ni ON ni.device_id = d.id AND ni.is_primary = 1
        WHERE d.id = ?
      `).get(forceDeviceId)
    : db.prepare(`
    SELECT d.*, ni.ip_address AS ip_address, ni.mac_address AS mac_address
    FROM devices d LEFT JOIN network_interfaces ni ON ni.device_id = d.id AND ni.is_primary = 1
    WHERE d.hostname = ? COLLATE NOCASE
  `).get(hostname);

  const asArray = (x) => (Array.isArray(x) ? x : (x ? [x] : []));

  const os = data.OperatingSystem || {};
  const hw = data.Hardware || {};
  const sys = hw.System || {};
  const processors = asArray(hw.Processor);
  const disks = asArray(hw.Disks);
  const networkAdapters = asArray(data.Network);
  const softwareList = asArray(data.Software);

  // Основной адаптер — тот, у которого есть шлюз по умолчанию (интернет-facing),
  // иначе первый попавшийся с известным IP
  const primaryAdapter = networkAdapters.find((a) => a.HasGateway) || networkAdapters[0] || null;

  const newValues = {
    os: [os.Name, os.Version].filter(Boolean).join(' ') || null,
    cpu: processors.length ? processors.map((p) => p.Name).filter(Boolean).join(', ') : null,
    ram: sys.RAM_GB ? `${Math.round(sys.RAM_GB)} GB` : null,
    disk: disks.length ? disks.map((d) => `${d.Model}${d.Size_GB ? ` (${Math.round(d.Size_GB)} GB)` : ''}`).filter(Boolean).join(', ') : null,
    ip_address: primaryAdapter ? primaryAdapter.IPAddress : null,
    mac_address: primaryAdapter ? primaryAdapter.MACAddress : null
  };

  const fields = FIELD_DEFS
    .map(({ key, label }) => ({
      key,
      label,
      oldValue: existingRow ? (existingRow[key] || null) : null,
      newValue: newValues[key],
      conflict: !!(existingRow && existingRow[key] && newValues[key] && existingRow[key] !== newValues[key])
    }))
    .filter((f) => f.newValue !== null); // показываем только то, что скрипт реально собрал

  return {
    filePath,
    fileName: path.basename(filePath),
    hostname,
    isNew: !existingRow,
    existingDeviceId: existingRow ? existingRow.id : null,
    hostnameMismatch: !!(forceDeviceId && existingRow && existingRow.hostname && existingRow.hostname.toLowerCase() !== hostname.toLowerCase()),
    manufacturer: sys.Manufacturer || null,
    model: sys.Model || null,
    serialNumber: sys.SerialNumber || null,
    software: softwareList.filter((s) => s && s.Name).map((s) => ({ name: s.Name, version: s.Version || null, publisher: s.Publisher || null })),
    fields,
    hasConflicts: fields.some((f) => f.conflict)
  };
}

/** Разбирает все .json-файлы в папке — для пакетного импорта. Файлы, которые не
 *  удалось разобрать (битый JSON, нет hostname), не прерывают весь импорт —
 *  попадают в errors отдельным списком. */
function parsePcInfoFolder(folderPath) {
  const files = fs.readdirSync(folderPath).filter((f) => f.toLowerCase().endsWith('.json'));
  const results = [];
  const errors = [];
  files.forEach((f) => {
    try {
      results.push(parsePcInfoFile(path.join(folderPath, f)));
    } catch (e) {
      errors.push(e.message);
    }
  });
  return { results, errors };
}

/** Эвристическая классификация строки ПО в допустимый software_type — дефолт 'other',
 *  пользователь при желании поправит категорию вручную позже через обычный UI. */
function classifySoftwareType(name) {
  const n = (name || '').toLowerCase();
  if (/office|excel|word|outlook|powerpoint|libreoffice|openoffice/.test(n)) return 'office';
  if (/antivirus|антивирус|kaspersky|defender|eset|avast|avg|dr\.?web|nod32|norton|mcafee/.test(n)) return 'antivirus';
  if (/windows \d|microsoft windows/.test(n)) return 'os';
  return 'other';
}

/** Применяет один разобранный файл. fieldChoices — { [fieldKey]: 'new' | 'old' },
 *  по умолчанию (поле не указано) берётся новое значение из файла. Софт добавляется
 *  новыми записями; повторный импорт того же файла не плодит дубликаты — пропускает
 *  позиции, чьё имя уже есть среди активного ПО этого устройства. */
function applyPcInfoImport(parsed, fieldChoices = {}) {
  const db = getDb();
  const resolvedValues = {};
  parsed.fields.forEach((f) => {
    const choice = fieldChoices[f.key] || 'new';
    resolvedValues[f.key] = choice === 'old' ? f.oldValue : f.newValue;
  });

  let device;
  if (parsed.isNew) {
    const notesParts = [];
    if (parsed.manufacturer || parsed.model) notesParts.push(`Модель: ${[parsed.manufacturer, parsed.model].filter(Boolean).join(' ')}`);
    if (parsed.serialNumber) notesParts.push(`Серийный номер: ${parsed.serialNumber}`);
    device = devicesRepo.create({
      device_type: 'computer',
      hostname: parsed.hostname,
      os: resolvedValues.os || null,
      cpu: resolvedValues.cpu || null,
      ram: resolvedValues.ram || null,
      disk: resolvedValues.disk || null,
      ip_address: resolvedValues.ip_address || null,
      mac_address: resolvedValues.mac_address || null,
      notes: notesParts.join('\n') || null
    });
  } else {
    const existing = db.prepare('SELECT * FROM devices WHERE id = ?').get(parsed.existingDeviceId);
    device = devicesRepo.update(parsed.existingDeviceId, {
      device_type: existing.device_type,
      hostname: existing.hostname,
      inventory_number: existing.inventory_number,
      os: resolvedValues.os !== undefined ? resolvedValues.os : existing.os,
      cpu: resolvedValues.cpu !== undefined ? resolvedValues.cpu : existing.cpu,
      ram: resolvedValues.ram !== undefined ? resolvedValues.ram : existing.ram,
      disk: resolvedValues.disk !== undefined ? resolvedValues.disk : existing.disk,
      status: existing.status,
      notes: existing.notes,
      ip_address: resolvedValues.ip_address,
      mac_address: resolvedValues.mac_address
    });
  }

  const existingSoftwareNames = new Set(
    db.prepare('SELECT name FROM device_software WHERE device_id = ? AND removed_at IS NULL')
      .all(device.id).map((r) => r.name.toLowerCase())
  );
  let softwareAdded = 0;
  (parsed.software || []).forEach((sw) => {
    if (!sw.name) return;
    const displayName = sw.version ? `${sw.name} ${sw.version}` : sw.name;
    if (existingSoftwareNames.has(displayName.toLowerCase())) return; // то же имя+версия — уже импортировано
    softwareRepo.add({
      device_id: device.id,
      software_type: classifySoftwareType(sw.name),
      name: displayName,
      note: sw.publisher || null
    });
    existingSoftwareNames.add(displayName.toLowerCase());
    softwareAdded++;
  });

  return { device, isNew: parsed.isNew, softwareAdded };
}

module.exports = { parsePcInfoFile, parsePcInfoFolder, applyPcInfoImport, classifySoftwareType };
