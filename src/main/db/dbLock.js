// dbLock.js
//
// Файл-замок рядом с файлом БД: «эту базу прямо сейчас держит такой-то экземпляр».
//
// Зачем он нужен, если у SQLite есть собственные блокировки. Собственные работают
// надёжно на ЛОКАЛЬНОМ диске, но не на сетевой шаре (SMB/CIFS): там блокировки
// реализованы через неполноценные файловые локи, и две копии приложения, открывшие
// один data.db по сети, спокойно пишут обе — вплоть до порчи файла. Именно в этой
// схеме (общий файл на шаре) приложение и жило изначально. Отдельный файл-замок —
// это явная, видимая всем участникам договорённость, не зависящая от того, насколько
// честно шара реализует блокировки.
//
// Замок не «запрещает» открыть базу силой (и не должен: упавший экземпляр не должен
// запирать базу навсегда). Он сообщает ФАКТ: кто-то живой уже внутри. Решение, что с
// этим делать, принимает вызывающий код — приложение открывает базу только для чтения.
//
// Живость определяется по метке времени, которую владелец обновляет (heartbeat).
// Протухший замок (владелец упал, не успев убрать файл) просто перехватывается.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Не обновлялся дольше — владелец считается пропавшим, замок можно перехватить.
// Заметно больше интервала heartbeat, чтобы короткая пауза (своп, спящий ноутбук,
// моргнувшая сеть) не приводила к тому, что у живого владельца отбирают базу.
const STALE_AFTER_MS = 45000;
const HEARTBEAT_MS = 15000;

function lockPathFor(dbPath) {
  return `${dbPath}.lock`;
}

function readLock(dbPath) {
  try {
    const raw = fs.readFileSync(lockPathFor(dbPath), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    // Нет файла, нет прав на чтение, или внутри мусор — во всех случаях считаем, что
    // замка нет. Ошибочно решить «занято» хуже: это заперло бы базу на пустом месте.
    return null;
  }
}

/** Живой ли замок: есть файл, метка времени свежая, и владелец — НЕ мы сами. */
function describeLock(dbPath, ownInstanceId) {
  const lock = readLock(dbPath);
  if (!lock || !lock.instanceId) return null;
  if (lock.instanceId === ownInstanceId) return null; // наш же замок с прошлого открытия в этом процессе
  const renewedAt = Number(lock.renewedAt) || 0;
  const ageMs = Date.now() - renewedAt;
  if (ageMs > STALE_AFTER_MS) return null; // владелец пропал — замок протух
  return {
    hostname: lock.hostname || '?',
    user: lock.user || null,
    pid: lock.pid || null,
    instanceId: lock.instanceId,
    acquiredAt: lock.acquiredAt || null,
    ageMs
  };
}

/** Записывает/перезаписывает замок на себя. Бросает, если писать некуда (например,
 *  база лежит на шаре, открытой только для чтения) — вызывающий код трактует это как
 *  «запись всё равно невозможна» и тоже уходит в режим только чтения. */
function writeLock(dbPath, instanceId, acquiredAt) {
  const payload = {
    instanceId,
    hostname: os.hostname(),
    user: (os.userInfo && safeUserName()) || null,
    pid: process.pid,
    acquiredAt: acquiredAt || new Date().toISOString(),
    renewedAt: Date.now()
  };
  // Пишем через временный файл в ТОЙ ЖЕ папке и переименовываем: иначе другой
  // экземпляр может прочитать файл в момент записи и увидеть обрезанный JSON.
  const target = lockPathFor(dbPath);
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
  fs.renameSync(tmp, target);
  return payload;
}

function safeUserName() {
  try { return os.userInfo().username; } catch { return null; }
}

/** Состояние захвата — чтобы heartbeat обновлял и снимал ТОЛЬКО свой замок. */
const state = {
  instanceId: null,
  dbPath: null,
  acquiredAt: null,
  timer: null
};

/**
 * Пытается занять базу под запись.
 *
 * Возвращает:
 *   { acquired: true }                       — заняли, запись разрешена, heartbeat запущен;
 *   { acquired: false, heldBy: {...} }       — база занята живым экземпляром;
 *   { acquired: false, error: 'текст' }      — занять не удалось по другой причине
 *                                              (нет прав на запись в папку и т.п.).
 */
function acquire(dbPath) {
  const instanceId = crypto.randomUUID();
  const holder = describeLock(dbPath, instanceId);
  if (holder) return { acquired: false, heldBy: holder };

  try {
    const payload = writeLock(dbPath, instanceId, null);
    state.instanceId = instanceId;
    state.dbPath = dbPath;
    state.acquiredAt = payload.acquiredAt;
    startHeartbeat();
    return { acquired: true };
  } catch (err) {
    return { acquired: false, error: err.message };
  }
}

function startHeartbeat() {
  stopHeartbeat();
  state.timer = setInterval(() => {
    // Перед продлением убеждаемся, что замок всё ещё НАШ: пока мы работали, кто-то мог
    // решить, что мы протухли (например, машину усыпляли), и перехватить базу. Молча
    // перезаписать его замок своим — худшее, что можно сделать: обе копии окажутся
    // уверены, что пишут монопольно.
    const current = readLock(state.dbPath);
    if (current && current.instanceId && current.instanceId !== state.instanceId) {
      stopHeartbeat();
      if (typeof state.onLost === 'function') state.onLost(current);
      return;
    }
    try { writeLock(state.dbPath, state.instanceId, state.acquiredAt); } catch { /* шара моргнула — попробуем на следующем тике */ }
  }, HEARTBEAT_MS);
  if (state.timer.unref) state.timer.unref(); // не держим процесс живым только из-за heartbeat
}

function stopHeartbeat() {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
}

/** Колбэк «нас вытеснили» — вызывается, если замок перехватил другой экземпляр. */
function onLockLost(callback) {
  state.onLost = callback;
}

/** Снимает СВОЙ замок (штатный выход). Чужой не трогает никогда. */
function release() {
  stopHeartbeat();
  if (!state.dbPath || !state.instanceId) return;
  const current = readLock(state.dbPath);
  if (current && current.instanceId === state.instanceId) {
    try { fs.unlinkSync(lockPathFor(state.dbPath)); } catch { /* файл мог быть уже убран — не критично */ }
  }
  state.instanceId = null;
  state.dbPath = null;
}

/** Держим ли мы сейчас замок (для диагностики и страницы статуса сервера). */
function isHeld() {
  return !!(state.instanceId && state.dbPath);
}

module.exports = {
  acquire, release, describeLock, isHeld, onLockLost, lockPathFor,
  STALE_AFTER_MS, HEARTBEAT_MS
};
