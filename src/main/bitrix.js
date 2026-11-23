// bitrix.js
//
// Чтение профиля сотрудника из Битрикс24 — первый этап односторонней синхронизации
// Битрикс24 → NetworkMap (задача #3). Только ЧТЕНИЕ: единственный вызываемый метод —
// user.get. Ничего в Битрикс24 отсюда не создаётся и не меняется.
//
// Где это выполняется. Только в процессе, который ВЛАДЕЕТ базой: локальный Electron,
// Electron-хост или выделенный сервер. Клиент сюда не попадает никогда — его запросы
// уходят по RPC на сервер (см. src/shared/dbChannels.js), поэтому адрес вебхука и ключ
// в нём лежат только на стороне сервера и до клиента не доходят.
//
// Модуль не требует Electron: его подключает и выделенный сервер на обычном Node.
//
// СЕКРЕТЫ. webhook_url содержит ключ доступа (https://портал/rest/<ID>/<КЛЮЧ>/), поэтому
// его нет ни в одном сообщении, исключении или ответе: ошибки сети и Битрикс24 переводятся
// в заранее известные тексты, а любой текст, пришедший снаружи (сообщение исключения), на
// выходе дополнительно прогоняется через redactSecrets() — на случай, если где-то в
// цепочке вызовов адрес всё-таки окажется в тексте ошибки.

const fs = require('fs');
const path = require('path');

const CONFIG_FILE_NAME = 'bitrix.yml';

// Клиент ждёт ответа по RPC 10 секунд (см. main/index.js), и за это время сервер должен
// успеть и сходить в Битрикс24, и ответить сам. Если ждать Битрикс24 дольше, клиент
// получит невнятный обрыв по тайм-ауту RPC вместо понятного «Битрикс24 не ответил».
const DEFAULT_TIMEOUT_MS = 7000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 9000;

// Явный список полей для select: запрашиваем только то, что показываем и сохраняем.
// Лишние персональные данные (дата рождения, адрес, фото) до нас просто не доходят.
const USER_FIELDS = [
  'ID', 'ACTIVE', 'NAME', 'LAST_NAME', 'SECOND_NAME', 'EMAIL',
  'WORK_POSITION', 'WORK_PHONE', 'PERSONAL_MOBILE', 'WORK_DEPARTMENT', 'UF_DEPARTMENT'
];

/** Ошибка с заранее известным, безопасным текстом. code — для тестов и для интерфейса
 *  (например, чтобы отличить «не настроено» от «нет сети»).
 *  name намеренно остаётся 'Error': Electron передаёт ошибку в окно строкой «имя: текст»,
 *  и preload срезает только привычное «Error:» — иначе пользователь увидел бы в сообщении
 *  служебное «BitrixError:». */
class BitrixError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ------------------------------------------------------------
// Конфигурация
// ------------------------------------------------------------

/**
 * Разбор bitrix.yml. Полноценный YAML не нужен: в файле одно-два плоских поля
 * «ключ: значение», а тащить ради них зависимость в образ сервера (у него сейчас
 * ровно одна — better-sqlite3) не хочется. Поддерживаются комментарии (#),
 * кавычки и BOM, которым любит начинать файлы Блокнот. Вложенные структуры
 * игнорируются — они нам не нужны.
 */
function parseSimpleYaml(text) {
  const result = {};
  String(text || '').replace(/^﻿/, '').split(/\r?\n/).forEach((line) => {
    if (/^\s/.test(line)) return;               // вложенные строки нам не нужны
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!m) return;
    let value = m[2];
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      // комментарий — это « #», а не любой #: в адресе он может встретиться как часть
      value = value.replace(/\s+#.*$/, '').trim();
    }
    result[m[1]] = value;
  });
  return result;
}

/** Где искать bitrix.yml. Правило одно для всех режимов: файл лежит у того процесса,
 *  который владеет базой, — по умолчанию рядом с самим файлом базы.
 *
 *  ctx.dbPath  — путь к открытой базе;
 *  ctx.dataDir — папка служебных файлов (userData у Electron, NM_DATA_DIR у сервера).
 *  NM_BITRIX_CONFIG, если задан, — единственный вариант: явное указание не должно
 *  молча подменяться найденным где-то ещё файлом. */
function configCandidates(ctx = {}) {
  if (process.env.NM_BITRIX_CONFIG) return [path.resolve(process.env.NM_BITRIX_CONFIG)];
  const list = [];
  if (ctx.dbPath) list.push(path.join(path.dirname(ctx.dbPath), CONFIG_FILE_NAME));
  if (ctx.dataDir) list.push(path.join(ctx.dataDir, CONFIG_FILE_NAME));
  // Запуск из исходников (`npm start` в папке репозитория): файл удобно держать в корне
  // проекта, для этого он и указан в .gitignore. В собранном приложении рабочая папка
  // произвольная, поэтому там этот вариант не проверяется вовсе.
  if (process.versions && process.versions.electron && process.defaultApp) {
    list.push(path.join(process.cwd(), CONFIG_FILE_NAME));
  }
  return [...new Set(list.map((p) => path.resolve(p)))];
}

/** Адрес этой же машины. Только для него допустим обычный HTTP: запрос не выходит в
 *  сеть (так устроены проверки с фиктивным порталом). */
function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function normalizeWebhookUrl(raw) {
  if (!raw) {
    throw new BitrixError('config_invalid', 'В bitrix.yml не заполнено поле webhook_url.');
  }
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    url = null;
  }
  // Значение в тексте ошибки НЕ повторяем: в нём ключ доступа
  const shapeHint = 'webhook_url в bitrix.yml должен иметь вид https://<портал>/rest/<ID пользователя>/<ключ>/';
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new BitrixError('config_invalid', `${shapeHint}.`);
  }
  // Ключ вебхука — часть адреса, поэтому по обычному HTTP он уходил бы в сеть открытым
  // текстом. Исключение — только адрес этой же машины.
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new BitrixError('config_insecure',
      'webhook_url в bitrix.yml должен начинаться с https:// — ключ вебхука передаётся в самом адресе, ' +
      'и по обычному HTTP его видно в сети.');
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new BitrixError('config_invalid', `${shapeHint} — без параметров после «?» и «#».`);
  }
  const pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  if (!/\/rest\/\d+\/[^/]+\/$/.test(pathname)) {
    throw new BitrixError('config_invalid', `${shapeHint} — имя метода (например, user.get) в конце не нужно.`);
  }
  return `${url.origin}${pathname}`;
}

function normalizeTimeout(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new BitrixError('config_invalid', `timeout_ms в bitrix.yml должен быть числом (миллисекунды, от ${MIN_TIMEOUT_MS} до ${MAX_TIMEOUT_MS}).`);
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(n)));
}

/** Читает конфигурацию заново при КАЖДОМ запросе: файл маленький, а правка ключа на
 *  сервере вступает в силу сразу, без перезапуска контейнера. */
function loadBitrixConfig(ctx = {}) {
  const candidates = configCandidates(ctx);
  const found = candidates.find((p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  });
  if (!found) {
    const where = candidates.length
      ? candidates.map((p) => path.dirname(p)).join(', ')
      : 'рядом с файлом базы';
    throw new BitrixError(
      'not_configured',
      `Интеграция с Битрикс24 не настроена: не найден файл ${CONFIG_FILE_NAME}. ` +
      `Его нужно положить на стороне, которая хранит базу (искали в: ${where}), ` +
      'с полем webhook_url — образец в bitrix.example.yml.'
    );
  }
  let text;
  try {
    text = fs.readFileSync(found, 'utf8');
  } catch (err) {
    throw new BitrixError('config_unreadable', `Не удалось прочитать ${found}${err && err.code ? ` (${err.code})` : ''}.`);
  }
  const parsed = parseSimpleYaml(text);
  return {
    webhookUrl: normalizeWebhookUrl(parsed.webhook_url),
    timeoutMs: normalizeTimeout(parsed.timeout_ms),
    source: found
  };
}

// ------------------------------------------------------------
// Защита секретов
// ------------------------------------------------------------

/** Вычищает из текста адрес вебхука, ключ и адрес портала. Это страховка, а не основная
 *  защита: основные тексты ошибок здесь составлены заранее и секретов не содержат. */
function redactSecrets(text, webhookUrl) {
  let out = String(text == null ? '' : text);
  if (!webhookUrl) return out;
  const variants = new Set([webhookUrl, webhookUrl.replace(/\/$/, '')]);
  let host = null;
  let token = null;
  try {
    const u = new URL(webhookUrl);
    host = u.host;
    const parts = u.pathname.split('/').filter(Boolean); // ['rest', '<id>', '<token>']
    token = parts[2] || null;
  } catch { /* адрес уже проверен в loadBitrixConfig — сюда не попадаем */ }
  // Сначала длинные варианты, потом короткие: иначе замена ключа испортит поиск адреса
  [...variants].sort((a, b) => b.length - a.length).forEach((v) => {
    out = out.split(v).join('[адрес вебхука скрыт]');
  });
  if (token && token.length >= 4) out = out.split(token).join('[ключ скрыт]');
  if (host) out = out.split(host).join('[портал]');
  return out;
}

// ------------------------------------------------------------
// Запрос к Битрикс24
// ------------------------------------------------------------

/** ID сотрудника — целое положительное число; строку из поля ввода тоже принимаем. */
function normalizeBitrixId(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!/^\d{1,10}$/.test(text) || Number(text) <= 0) {
    throw new BitrixError('bad_id', 'ID сотрудника Битрикс24 — целое положительное число.');
  }
  return Number(text);
}

/** Код ошибки Битрикс24 показываем, только если он похож на код — короткое слово из
 *  латиницы, цифр и подчёркиваний. Произвольный текст с портала не повторяем. */
function safeErrorCode(code) {
  const s = String(code == null ? '' : code);
  return /^[A-Za-z0-9_]{1,64}$/.test(s) ? s : null;
}

const AUTH_ERRORS = new Set(['invalid_credentials', 'no_auth_found', 'expired_token', 'invalid_token', 'wrong_auth_type', 'user_access_error', 'authorization_error']);
const SCOPE_ERRORS = new Set(['insufficient_scope', 'error_method_not_found', 'access_denied']);
const LIMIT_ERRORS = new Set(['query_limit_exceeded', 'operation_time_limit']);

function apiError(code, httpStatus) {
  const lower = String(code || '').toLowerCase();
  if (AUTH_ERRORS.has(lower)) {
    return new BitrixError('auth',
      'Битрикс24 отклонил вебхук: ключ неверный, отозван или принадлежит отключённому пользователю. ' +
      'Проверьте webhook_url в bitrix.yml.');
  }
  if (SCOPE_ERRORS.has(lower)) {
    return new BitrixError('forbidden',
      'У вебхука нет права на чтение пользователей. В настройках входящего вебхука в Битрикс24 ' +
      'нужно право «Пользователи (базовое)» — user_basic.');
  }
  if (LIMIT_ERRORS.has(lower)) {
    return new BitrixError('rate_limited', 'Битрикс24 временно ограничил число запросов. Повторите через минуту.');
  }
  if (lower === 'portal_deleted') {
    return new BitrixError('portal', 'Портал Битрикс24 из webhook_url удалён или заблокирован.');
  }
  if (lower === 'invalid_request') {
    return new BitrixError('https_required', 'Битрикс24 принимает вебхуки только по HTTPS — исправьте webhook_url в bitrix.yml.');
  }
  const shown = safeErrorCode(code);
  return new BitrixError('api',
    `Битрикс24 вернул ошибку${shown ? ` ${shown}` : ''}${httpStatus ? ` (HTTP ${httpStatus})` : ''}.`);
}

function httpError(status) {
  if (status === 401) return apiError('INVALID_CREDENTIALS', status);
  if (status === 403) return apiError('ACCESS_DENIED', status);
  if (status === 404) {
    return new BitrixError('not_found_endpoint',
      'Адрес вебхука не найден (HTTP 404) — проверьте портал и ключ в webhook_url.');
  }
  if (status === 429 || status === 503) return apiError('QUERY_LIMIT_EXCEEDED', status);
  if (status >= 500) return new BitrixError('server_error', `Битрикс24 вернул ошибку сервера (HTTP ${status}). Повторите позже.`);
  return new BitrixError('api', `Битрикс24 ответил неожиданно (HTTP ${status}).`);
}

const TLS_CODES = /^(CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_TLS|ERR_SSL)/;

/** Сетевая ошибка fetch → понятный текст. Сообщение самого исключения не используем:
 *  в нём бывает адрес. Код вида ENOTFOUND безопасен и полезен для диагностики. */
function networkError(err, timeoutMs) {
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return new BitrixError('timeout', `Битрикс24 не ответил за ${Math.round(timeoutMs / 1000)} с. Повторите позже.`);
  }
  const cause = err && err.cause;
  const code = safeErrorCode(cause && cause.code) || safeErrorCode(err && err.code);
  const causeText = String((cause && cause.message) || '');
  if (/redirect/i.test(causeText)) {
    return new BitrixError('redirect',
      'Битрикс24 перенаправил запрос на другой адрес — укажите в webhook_url итоговый адрес портала с https://.');
  }
  if (code && TLS_CODES.test(code)) {
    return new BitrixError('tls', `Не удалось проверить сертификат портала Битрикс24 (${code}).`);
  }
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') {
    return new BitrixError('timeout', `Битрикс24 не ответил за ${Math.round(timeoutMs / 1000)} с. Повторите позже.`);
  }
  return new BitrixError('network',
    `Не удалось связаться с Битрикс24${code ? ` (${code})` : ''}: нет сети или неверный адрес портала в webhook_url.`);
}

/** Сырые поля сотрудника из user.get — только из USER_FIELDS, остальное отбрасываем. */
async function fetchBitrixUser(config, bitrixIdRaw) {
  const bitrixId = normalizeBitrixId(bitrixIdRaw);
  let res;
  try {
    res = await fetch(`${config.webhookUrl}user.get.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ filter: { ID: bitrixId }, select: USER_FIELDS }),
      signal: AbortSignal.timeout(config.timeoutMs),
      // Переадресацию не выполняем: POST с ключом не должен уходить по адресу, которого
      // нет в конфигурации, а сам факт переадресации обычно значит «http вместо https»
      redirect: 'error'
    });
  } catch (err) {
    throw networkError(err, config.timeoutMs);
  }

  let text;
  try {
    text = await res.text();
  } catch (err) {
    throw networkError(err, config.timeoutMs);
  }
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }

  if (body && body.error) throw apiError(body.error, res.status);
  if (!res.ok) throw httpError(res.status);
  if (!body || !Array.isArray(body.result)) {
    throw new BitrixError('bad_response', 'Ответ Битрикс24 не распознан — проверьте, что webhook_url указывает на портал Битрикс24.');
  }
  const raw = body.result.find((u) => u && Number(u.ID) === bitrixId);
  if (!raw) {
    throw new BitrixError('user_not_found',
      `Сотрудник с ID ${bitrixId} в Битрикс24 не найден (или скрыт от пользователя, чей это вебхук).`);
  }
  const picked = {};
  USER_FIELDS.forEach((f) => { if (raw[f] !== undefined) picked[f] = raw[f]; });
  return picked;
}

// ------------------------------------------------------------
// Профиль в терминах NetworkMap
// ------------------------------------------------------------

function cleanText(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s || null;
}

/** ACTIVE в user.get — булево; на старых порталах встречается 'Y'/'N'. */
function parseActive(v) {
  if (v === true || v === 'Y' || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'N' || v === 'false' || v === 0 || v === '0') return false;
  return null;
}

/**
 * Сырые поля Битрикс24 → то, что сопоставляется с карточкой пользователя:
 *  - ФИО в привычном порядке «Фамилия Имя Отчество»;
 *  - телефон — рабочий, а если его нет, мобильный (источник запоминаем для подписи);
 *  - подразделение — название из WORK_DEPARTMENT. Если портал отдаёт только ID
 *    подразделений (UF_DEPARTMENT), названия у нас нет: ID показываем в предпросмотре,
 *    а в карточке остаётся то подразделение, что уже записано.
 */
function mapBitrixProfile(raw) {
  const workPhone = cleanText(raw.WORK_PHONE);
  const mobile = cleanText(raw.PERSONAL_MOBILE);
  let departmentIds = [];
  if (Array.isArray(raw.UF_DEPARTMENT)) {
    departmentIds = raw.UF_DEPARTMENT.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } else if (raw.UF_DEPARTMENT !== undefined && raw.UF_DEPARTMENT !== null && raw.UF_DEPARTMENT !== '') {
    const n = Number(raw.UF_DEPARTMENT);
    if (Number.isInteger(n) && n > 0) departmentIds = [n];
  }
  const fullName = [raw.LAST_NAME, raw.NAME, raw.SECOND_NAME].map(cleanText).filter(Boolean).join(' ');
  return {
    bitrixId: Number(raw.ID),
    active: parseActive(raw.ACTIVE),
    fullName: fullName || null,
    position: cleanText(raw.WORK_POSITION),
    department: cleanText(raw.WORK_DEPARTMENT),
    departmentIds,
    email: cleanText(raw.EMAIL),
    phone: workPhone || mobile || null,
    phoneSource: workPhone ? 'WORK_PHONE' : (mobile ? 'PERSONAL_MOBILE' : null)
  };
}

/**
 * Профиль сотрудника по ID: конфигурация → user.get → профиль NetworkMap.
 * Все ошибки на выходе — BitrixError с безопасным текстом.
 */
async function lookupBitrixUser(bitrixId, ctx = {}) {
  // ID проверяем до чтения конфигурации: «введите число» полезнее, чем «нет bitrix.yml»
  normalizeBitrixId(bitrixId);
  const config = loadBitrixConfig(ctx);
  try {
    const raw = await fetchBitrixUser(config, bitrixId);
    return mapBitrixProfile(raw);
  } catch (err) {
    if (err instanceof BitrixError) {
      err.message = redactSecrets(err.message, config.webhookUrl);
      throw err;
    }
    throw new BitrixError('internal',
      `Не удалось получить профиль из Битрикс24: ${redactSecrets(err && err.message, config.webhookUrl)}`);
  }
}

module.exports = {
  CONFIG_FILE_NAME,
  DEFAULT_TIMEOUT_MS,
  USER_FIELDS,
  BitrixError,
  parseSimpleYaml,
  configCandidates,
  loadBitrixConfig,
  redactSecrets,
  normalizeBitrixId,
  fetchBitrixUser,
  mapBitrixProfile,
  lookupBitrixUser
};
