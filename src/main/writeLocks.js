// writeLocks.js
//
// Временные блокировки на редактирование — живут только в памяти хоста, не в БД
// (переживать перезапуск хоста им не нужно: после перезапуска все блокировки и так
// должны быть сброшены). Модель "взялся — ходи": первый клиент, чей запрос захватил
// объект, держит все права на запись по нему, пока явно не отпустит (закрыл карточку/
// панель) или не станет неактивен (пропустил heartbeat дольше STALE_AFTER_MS).
//
// Два уровня объектов — не честное дерево "родитель -> все потомки", а два независимых
// вида ключей:
//   'device'    — данные самого устройства (hostname/IP/владелец и т.п.)
//   'plan_item' — структура на плане (позиция, состав группы, удаление с плана)
// Блокировка на group (тоже plan_item) естественно защищает её состав — но НЕ данные
// устройств уже внутри нее, у тех своя, отдельная блокировка на 'device'.

const STALE_AFTER_MS = 60000; // не подтверждал (heartbeat) дольше — считаем клиента пропавшим

// key = `${type}:${id}` -> { clientId, hostname, acquiredAt, lastRenewedAt }
const locks = new Map();

function lockKey(type, id) {
  return `${type}:${id}`;
}

/** Кто сейчас держит объект — null, если свободен или блокировка протухла (в этом
 *  случае она же тут и вычищается — ленивая уборка при первом же обращении). */
function whoHolds(type, id) {
  const key = lockKey(type, id);
  const entry = locks.get(key);
  if (!entry) return null;
  if (Date.now() - entry.lastRenewedAt > STALE_AFTER_MS) { locks.delete(key); return null; }
  return entry;
}

/** Может ли именно этот клиент сейчас писать в этот объект — свободен ИЛИ уже его же. */
function canWrite(clientId, type, id) {
  const holder = whoHolds(type, id);
  return !holder || holder.clientId === clientId;
}

/** Захват/продление блокировки. Отказ, если объект уже занят ДРУГИМ клиентом —
 *  { ok: false, heldBy: hostname }. Используется и явным "открыл для редактирования",
 *  и неявно на каждом heartbeat-тике (см. syncClientLocks). */
function acquire(clientId, hostname, type, id) {
  const key = lockKey(type, id);
  const holder = whoHolds(type, id);
  if (holder && holder.clientId !== clientId) {
    return { ok: false, heldBy: holder.hostname };
  }
  locks.set(key, {
    clientId, hostname,
    acquiredAt: holder ? holder.acquiredAt : Date.now(),
    lastRenewedAt: Date.now()
  });
  return { ok: true };
}

/** Явное освобождение конкретного объекта этим клиентом (не чужого). */
function release(clientId, type, id) {
  const key = lockKey(type, id);
  const holder = locks.get(key);
  if (holder && holder.clientId === clientId) locks.delete(key);
}

/** Вызывается на каждом heartbeat-тике клиента — heldKeys ([{type,id}, ...]) это то,
 *  что клиент СЕЙЧАС реально держит открытым (например, открытые карточки устройств
 *  и панель группы). Продлевает их и снимает всё, что раньше принадлежало этому
 *  clientId, но пропало из списка — "отпускание" происходит само, просто закрытием
 *  окна/карточки, без отдельного явного действия. Заодно чистит чужие протухшие
 *  блокировки (клиент вообще пропал, heartbeat не доходит). Возвращает { acquired,
 *  rejected, allLocks } — allLocks нужен клиенту, чтобы показать в UI, что занято
 *  другими прямо сейчас. */
function syncClientLocks(clientId, hostname, heldKeys) {
  const wantedSet = new Set(heldKeys.map((k) => lockKey(k.type, k.id)));
  for (const [key, entry] of locks) {
    if (entry.clientId === clientId && !wantedSet.has(key)) locks.delete(key);
  }

  const acquired = [];
  const rejected = [];
  heldKeys.forEach(({ type, id }) => {
    const result = acquire(clientId, hostname, type, id);
    if (result.ok) acquired.push({ type, id });
    else rejected.push({ type, id, heldBy: result.heldBy });
  });

  const now = Date.now();
  for (const [key, entry] of locks) {
    if (now - entry.lastRenewedAt > STALE_AFTER_MS) locks.delete(key);
  }

  const allLocks = [...locks.entries()].map(([key, entry]) => {
    const [type, idStr] = key.split(':');
    return { type, id: Number(idStr), hostname: entry.hostname, isMine: entry.clientId === clientId };
  });

  return { acquired, rejected, allLocks };
}

/** Снимает вообще все блокировки конкретного клиента разом. */
function releaseAllForClient(clientId) {
  for (const [key, entry] of locks) {
    if (entry.clientId === clientId) locks.delete(key);
  }
}

module.exports = { canWrite, whoHolds, acquire, release, syncClientLocks, releaseAllForClient, STALE_AFTER_MS };
