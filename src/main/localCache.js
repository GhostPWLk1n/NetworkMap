// localCache.js
//
// Локальный кэш последних успешных ОТВЕТОВ ХОСТА (только для режима "клиент") —
// переживает и временный разрыв связи посреди сессии, и перезапуск приложения, когда
// хост недоступен уже на старте. Раньше в обоих случаях клиент просто оставался без
// каких-либо данных (при разрыве — ошибка на каждый вызов; на старте — откат на
// заведомо ПУСТУЮ локальную БД, будто ничего никогда не было).
//
// Формат хранения — один JSON-файл { [ключ]: { result, cachedAt } }, ключ — это
// "канал::JSON(параметры)", т.е. каждый отдельный запрос (по каждому floor_plan_id,
// deviceId и т.п.) кэшируется отдельно. Запись на диск дебаунсится, чтобы не долбить
// диск на каждый отдельный успешный вызов при обычной работе (их может быть много
// почти одновременно, например при загрузке вкладки).

const fs = require('fs');
const path = require('path');

let cachePath = null;
let cache = {}; // in-memory, синхронизируется с диском
let writeTimer = null;
const WRITE_DEBOUNCE_MS = 500;

function cacheKeyFor(channel, payload) {
  return `${channel}::${JSON.stringify(payload === undefined ? null : payload)}`;
}

/** Вызывается один раз при старте в режиме "клиент" — путь обычно userData/rpc-cache.json */
function initLocalCache(userDataPath) {
  cachePath = path.join(userDataPath, 'rpc-cache.json');
  try {
    cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  } catch {
    cache = {}; // файла ещё нет (первый запуск в режиме клиента) или он повреждён — не критично
  }
}

function flushToDisk() {
  if (!cachePath) return;
  try {
    fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf-8');
  } catch { /* диск мог быть недоступен на миг — не критично, попробуем при следующей записи */ }
}

function scheduleFlush() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flushToDisk, WRITE_DEBOUNCE_MS);
}

/** Сохраняет успешный результат — вызывается после КАЖДОГО удачного чтения с хоста */
function saveToCache(channel, payload, result) {
  if (!cachePath) return;
  cache[cacheKeyFor(channel, payload)] = { result, cachedAt: new Date().toISOString() };
  scheduleFlush();
}

/** null, если для этого запроса ещё никогда не было успешного ответа */
function readFromCache(channel, payload) {
  if (!cachePath) return null;
  return cache[cacheKeyFor(channel, payload)] || null;
}

/** Есть ли вообще хоть что-то в кэше — используется на старте, чтобы решить, остаться
 *  ли в режиме клиента "оффлайн" (показать последние данные) или откатиться на пустую
 *  локальную БД (если кэша нет вообще — первый запуск, хост никогда не отвечал). */
function hasAnyCache() {
  return Object.keys(cache).length > 0;
}

/** Принудительный сброс на диск — вызывается при штатном выходе, чтобры не потерять
 *  последние секунды кэша, которые ещё не успели дойти до диска по debounce-таймеру. */
function forceFlush() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  flushToDisk();
}

module.exports = { initLocalCache, saveToCache, readFromCache, hasAnyCache, forceFlush };
