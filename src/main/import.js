const XLSX = require('xlsx');
const { getDb, usersRepo, devicesRepo, ownershipRepo, componentsRepo, peripheralsRepo } = require('./db');

/**
 * Разбор Excel-списка ПК с комплектующими вида "ижов | Пользователь | Модель платы | ...".
 * Формат — реальная годами наполнявшаяся таблица: встречаются одиночные строки со сдвигом
 * колонок (опечатка при вводе), поэтому импорт работает по позиции столбца и молча не
 * пытается угадывать/чинить сдвиги — вместо этого копит эвристические предупреждения
 * и возвращает их в отчёте, чтобы человек проверил конкретные инв. номера вручную.
 */

const COL = {
  inventory: 0, user: 1, motherboard: 2, buildYear: 3, cpu: 4, os: 5, licenseKey: 6,
  ramVolume: 7, ramType: 8, ramSlotsUsed: 9, ramSlotsInfo: 10, ramModel: 11,
  disks: 12, diskSizes: 13, gpu: 14, gpuType: 15, monitorModel: 16, monitorResolution: 17,
  department: 18, phone: 19, monitorInterfaces: 20, monitorCount: 21, ups: 22,
  previousOwners: 23, tag: 24
};

function cleanStr(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === 'nan') return null;
  return s;
}

function phoneToString(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return String(Math.round(v));
  return cleanStr(v);
}

function splitMulti(s) {
  if (!s) return [];
  return s.split(/\n|;/).map((x) => x.trim()).filter(Boolean);
}

function deviceTypeFor(motherboard, userName, os) {
  const mb = (motherboard || '').toLowerCase();
  const usr = (userName || '').toLowerCase();
  const osLower = (os || '').toLowerCase();
  if (/ноутбук|notebook|macbook|matebook|modern\s*\d/.test(mb)) return 'laptop';
  if (osLower.includes('server')) return 'server';
  if (/^(srv|nas|принтсервер|bimcloud)/i.test(usr)) return 'server';
  return 'computer';
}

function findOrCreateUser(fullName) {
  const db = getDb();
  const trimmed = fullName.trim();
  let user = db.prepare('SELECT * FROM users WHERE full_name = ? COLLATE NOCASE').get(trimmed);
  if (!user) user = usersRepo.create({ full_name: trimmed });
  return user;
}

function importExcel(filePath) {
  const db = getDb();
  const wb = XLSX.readFile(filePath, { cellText: false, cellDates: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
  const dataRows = rows.slice(1); // первая строка — заголовки

  const result = { imported: 0, updated: 0, skipped: 0, warnings: [] };

  const runRow = db.transaction((row) => {
    const inventoryNumber = cleanStr(row[COL.inventory]);
    if (!inventoryNumber || !/^\d+$/.test(inventoryNumber)) return 'skip';

    const userName = cleanStr(row[COL.user]);
    const motherboard = cleanStr(row[COL.motherboard]);
    const buildYear = cleanStr(row[COL.buildYear]);
    const cpu = cleanStr(row[COL.cpu]);
    const os = cleanStr(row[COL.os]);
    const licenseKey = cleanStr(row[COL.licenseKey]);
    const ramVolume = cleanStr(row[COL.ramVolume]);
    const ramType = cleanStr(row[COL.ramType]);
    const ramModel = cleanStr(row[COL.ramModel]);
    const disks = cleanStr(row[COL.disks]);
    const diskSizes = cleanStr(row[COL.diskSizes]);
    const gpu = cleanStr(row[COL.gpu]);
    const gpuType = cleanStr(row[COL.gpuType]);
    const monitorModel = cleanStr(row[COL.monitorModel]);
    const monitorResolution = cleanStr(row[COL.monitorResolution]);
    const department = cleanStr(row[COL.department]);
    const phone = phoneToString(row[COL.phone]);
    const monitorInterfaces = cleanStr(row[COL.monitorInterfaces]);
    const ups = cleanStr(row[COL.ups]);
    const previousOwners = cleanStr(row[COL.previousOwners]);
    const tag = cleanStr(row[COL.tag]);

    let device = db.prepare('SELECT * FROM devices WHERE inventory_number = ?').get(inventoryNumber);
    const isNew = !device;

    if (isNew) {
      const noteParts = [];
      if (department) noteParts.push(`Отдел: ${department}`);
      if (phone) noteParts.push(`Телефон: ${phone}`);
      if (tag) noteParts.push(`Метка: ${tag}`);
      if (buildYear) noteParts.push(`Год сборки: ${buildYear}`);
      if (licenseKey) noteParts.push(`Ключ ОС: ${licenseKey}`);

      device = devicesRepo.create({
        device_type: deviceTypeFor(motherboard, userName, os),
        hostname: `PC-${inventoryNumber}`,
        inventory_number: inventoryNumber,
        os, cpu,
        ram: [ramVolume, ramType].filter(Boolean).join(' '),
        disk: [disks, diskSizes].filter(Boolean).join(' / '),
        notes: noteParts.join('\n') || null
      });
    }

    // Текущий владелец
    if (userName) {
      const user = findOrCreateUser(userName);
      ownershipRepo.assign(device.id, user.id);
    }

    // Предыдущие владельцы — в историю, даты неизвестны (источник их не хранит)
    splitMulti((previousOwners || '').replace(/,/g, '\n')).forEach((name) => {
      const user = findOrCreateUser(name);
      db.prepare(`
        INSERT INTO device_user_history (device_id, user_id, assigned_at, unassigned_at, note)
        VALUES (?, ?, NULL, datetime('now'), 'импортировано из старого списка, даты неизвестны')
      `).run(device.id, user.id);
    });

    // Комплектующие — только для новых устройств (повторный импорт не плодит дубликаты записей)
    if (isNew) {
      if (motherboard) componentsRepo.add({ device_id: device.id, component_type: 'motherboard', description: motherboard });
      if (cpu) componentsRepo.add({ device_id: device.id, component_type: 'cpu', description: cpu });
      if (ramModel) {
        componentsRepo.add({
          device_id: device.id, component_type: 'ram',
          description: ramVolume ? `${ramModel} (${ramVolume})` : ramModel
        });
      }
      const diskList = splitMulti(disks);
      const sizeList = splitMulti(diskSizes);
      diskList.forEach((d, i) => {
        componentsRepo.add({
          device_id: device.id, component_type: 'disk',
          description: sizeList[i] ? `${d} (${sizeList[i]})` : d
        });
      });
      if (gpu) componentsRepo.add({ device_id: device.id, component_type: 'gpu', description: gpuType ? `${gpu} — ${gpuType}` : gpu });

      const monList = splitMulti(monitorModel);
      const resList = splitMulti(monitorResolution);
      monList.forEach((m, i) => {
        peripheralsRepo.add({
          device_id: device.id, peripheral_type: 'monitor',
          description: resList[i] ? `${m} (${resList[i]})` : m,
          note: monitorInterfaces || null
        });
      });
      if (ups) peripheralsRepo.add({ device_id: device.id, peripheral_type: 'ups', description: ups });
    }

    // Эвристика на сдвиг колонок: тип памяти должен быть из известного списка
    if (ramType && !/DDR|LPDDR/i.test(ramType)) {
      result.warnings.push(`Инв. №${inventoryNumber}: похоже на сдвиг колонок ("Тип памяти" = "${ramType}") — проверьте строку вручную`);
    }

    return isNew ? 'imported' : 'updated';
  });

  for (const row of dataRows) {
    const outcome = runRow(row);
    if (outcome === 'imported') result.imported++;
    else if (outcome === 'updated') result.updated++;
    else result.skipped++;
  }

  return result;
}

module.exports = { importExcel };
