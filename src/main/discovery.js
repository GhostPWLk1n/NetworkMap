// discovery.js
//
// "Маячок" хоста — маленький JSON-файл, который режим "хост" может опционально
// публиковать в СЕТЕВУЮ ПАПКУ (например, ту самую, куда раньше все указывали как на
// общий файл БД в старой схеме прямого доступа по сети). Смысл: если кто-то по
// привычке (или незнанию про новый режим "клиент") попробует "Подключиться к
// существующему файлу" именно туда — вместо невнятной ошибки открытия SQLite он
// увидит "здесь сейчас раздаёт данные хост X:Y — подключиться как клиент?".
//
// ВАЖНО про права доступа: каждый хост пишет СВОЙ СОБСТВЕННЫЙ, уникально названный
// файл в этой папке (networkmap-host-<hostname>-<id>.json), а не переписывает один
// общий файл. Причина — на реальных сетевых шарах (SMB/NTFS) политика доступа нередко
// разрешает ИЗМЕНЯТЬ и УДАЛЯТЬ файл только тому пользователю, который его создал (или
// администратору). Если хост А (пользователь "Иван") упал без штатного завершения
// (не успел вызвать removeHostMarker) и оставил маячок, а хостом хочет стать хост Б
// (пользователь "Пётр") — Пётр может просто не иметь прав ПЕРЕЗАПИСАТЬ файл Ивана.
// Создание НОВОГО файла в общей папке такому ограничению обычно не подчиняется — вот
// почему каждый инстанс хоста получает собственное уникальное имя, а не делит одно.
//
// Сам файл БД в новой схеме (см. db/index.js, main/index.js) хост держит ТОЛЬКО
// локально — маячок никогда не содержит и не подменяет реальные данные, это просто
// указатель "спроси вот этот адрес".

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MARKER_SIGNATURE = 'networkMapHostMarker'; // отличает маячок от случайного JSON-файла
const MARKER_PREFIX = 'networkmap-host-';

/** Все "внешние" (не loopback, не внутренние виртуальные) IPv4-адреса этой машины —
 *  на практике обычно один, но на машине с несколькими сетевыми картами их может
 *  быть несколько — тогда предлагаем клиенту выбрать нужный. */
function getLanIPv4Addresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  Object.values(interfaces).forEach((ifaceList) => {
    (ifaceList || []).forEach((iface) => {
      if (iface.family === 'IPv4' && !iface.internal) addresses.push(iface.address);
    });
  });
  return addresses;
}

function sanitizeForFilename(str) {
  return String(str).replace(/[^a-zA-Zа-яА-Я0-9_-]/g, '_').slice(0, 40);
}

/** Публикует НОВЫЙ, уникально названный маячок в указанной папке — вызывается один раз
 *  при старте режима "хост". Возвращает полный путь к своему файлу (сохранить для
 *  updateHostMarker/removeHostMarker — heartbeat и очистка должны трогать ТОЛЬКО этот
 *  конкретный файл, никогда чужие). Папка создаётся, если её ещё нет. */
function publishHostMarker(discoveryDir, port) {
  if (!fs.existsSync(discoveryDir)) fs.mkdirSync(discoveryDir, { recursive: true });
  const uniqueId = crypto.randomBytes(4).toString('hex');
  const fileName = `${MARKER_PREFIX}${sanitizeForFilename(os.hostname())}-${uniqueId}.json`;
  const markerPath = path.join(discoveryDir, fileName);
  writeMarkerFile(markerPath, port);
  return markerPath;
}

function writeMarkerFile(markerPath, port) {
  const marker = {
    signature: MARKER_SIGNATURE,
    addresses: getLanIPv4Addresses(),
    port,
    hostname: os.hostname(),
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf-8');
}

/** Heartbeat — обновляет метку времени в СВОЁМ (уже созданном) файле, не создаёт новый.
 *  markerPath — то, что вернул publishHostMarker. */
function updateHostMarker(markerPath, port) {
  writeMarkerFile(markerPath, port);
}

/** Убирает СВОЙ маячок при штатном выходе из режима хоста — чтобы не вводить в
 *  заблуждение следующего, кто попробует подключиться по этому пути. Никогда не
 *  трогает чужие файлы — только тот конкретный путь, что был создан этим инстансом. */
function removeHostMarker(markerPath) {
  try { fs.unlinkSync(markerPath); } catch { /* уже могло не быть — не страшно */ }
}

/** Пытается прочитать путь как маячок хоста. Возвращает null, если это не маячок
 *  (не JSON, нет нужной сигнатуры) — тогда вызывающий код обрабатывает путь как
 *  обычную попытку открыть файл БД. staleAfterMs — маячок старше этого считается
 *  протухшим (хост, скорее всего, уже не работает, например упал без штатного
 *  завершения) — на практике heartbeat должен обновлять его чаще, чем этот порог. */
function readHostMarker(filePath, staleAfterMs = 60000) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // не JSON вообще — это, вероятно, настоящий файл БД (SQLite — бинарный формат)
  }
  if (!parsed || parsed.signature !== MARKER_SIGNATURE) return null;

  const ageMs = Date.now() - new Date(parsed.updatedAt).getTime();
  return { ...parsed, path: filePath, stale: !(ageMs >= 0 && ageMs < staleAfterMs) };
}

/** Сканирует папку на предмет ВСЕХ маячков (разных хостов, в т.ч. давно умерших) —
 *  используется при "Подключиться к существующему файлу", если пользователь указал
 *  ПАПКУ вместо конкретного файла БД. Возвращает список { ..., stale }, живые сначала,
 *  внутри каждой группы — сначала недавно обновлённые. */
function findActiveMarkersInDir(discoveryDir, staleAfterMs = 60000) {
  let files;
  try {
    files = fs.readdirSync(discoveryDir);
  } catch {
    return [];
  }
  const markers = files
    .filter((f) => f.startsWith(MARKER_PREFIX) && f.endsWith('.json'))
    .map((f) => readHostMarker(path.join(discoveryDir, f), staleAfterMs))
    .filter(Boolean);

  markers.sort((a, b) => {
    if (a.stale !== b.stale) return a.stale ? 1 : -1; // живые сначала
    return new Date(b.updatedAt) - new Date(a.updatedAt); // внутри группы — свежие сначала
  });
  return markers;
}

/** Best-effort уборка протухших ЧУЖИХ маячков в папке — вызывается новым хостом перед
 *  публикацией своего, чтобы папка не копила мусор от давно умерших хостов. Намеренно
 *  НЕ считается ошибкой, если удалить чужой файл не получилось (та самая ситуация с
 *  правами доступа "изменять может только создатель") — тогда файл просто останется,
 *  ничего не ломая: он банально проигнорируется как протухший при следующем поиске.
 *  Никогда не трогает exceptPath (свой собственный, только что созданный маячок). */
function cleanupStaleMarkersInDir(discoveryDir, exceptPath, staleAfterMs = 60000) {
  const markers = findActiveMarkersInDir(discoveryDir, staleAfterMs);
  markers.forEach((m) => {
    if (m.stale && m.path !== exceptPath) {
      try { fs.unlinkSync(m.path); } catch { /* нет прав на чужой файл — это ожидаемо и не проблема */ }
    }
  });
}

module.exports = {
  getLanIPv4Addresses, publishHostMarker, updateHostMarker, removeHostMarker,
  readHostMarker, findActiveMarkersInDir, cleanupStaleMarkersInDir
};
