// rpcClient.js
//
// Вызывает методы на удалённом хосте по HTTP JSON-RPC (см. rpcServer.js). Используется
// только в режиме "клиент" — своя БД в этом режиме не открывается вообще, весь main/index.js
// проксирует ipcMain.handle() сюда вместо прямых вызовов репозиториев.

const http = require('http');

const TOKEN_FORMAT_ERROR = 'Ключ доступа может содержать только латинские буквы, цифры и знаки пунктуации ' +
  '(в заголовок HTTP нельзя положить русские буквы). Сгенерируйте ключ командой «openssl rand -hex 24».';

/** Ключ уходит HTTP-заголовком, а заголовки допускают только однобайтовые символы:
 *  русские буквы в ключе валили запрос с невнятной ERR_INVALID_CHAR прямо внутри Node.
 *  Проверяем заранее и объясняем по-человечески. Возвращает null, если ключа нет. */
function normalizeToken(token) {
  if (!token) return null;
  const text = String(token);
  // Печатаемый ASCII без управляющих символов — ровно то, что разрешено в значении заголовка
  if (!/^[\x20-\x7E]+$/.test(text)) {
    const err = new Error(TOKEN_FORMAT_ERROR);
    err.reason = 'token-format';
    throw err;
  }
  return text;
}

/** remoteHost — строка вида "192.168.1.42:47821" (без протокола). При сетевом сбое
 *  (таймаут/обрыв соединения — не путать с ответом хоста {ok:false}, там повтор
 *  бессмысленен) делает один повтор через секунду — переживает короткие сетевые
 *  заминки без участия пользователя. clientInfo ({ clientId, hostname }) передаётся в
 *  теле запроса — хосту нужно знать, ЧЕЙ это запрос, чтобы для write-операций сверить
 *  с блокировками на редактирование (см. writeLocks.js/authorizeWrite в main/index.js);
 *  для read-запросов хост его просто не использует, но передаём всегда единообразно. */
function rpcCall(remoteHost, channel, payload, timeoutMs = 10000, clientInfo = null, token = null) {
  return attemptRpcCall(remoteHost, channel, payload, timeoutMs, false, clientInfo, token);
}

function attemptRpcCall(remoteHost, channel, payload, timeoutMs, isRetry, clientInfo, token) {
  return new Promise((resolve, reject) => {
    const [hostname, portStr] = remoteHost.split(':');
    const port = Number(portStr) || 80;
    const body = JSON.stringify({
      channel, payload,
      clientId: clientInfo ? clientInfo.clientId : null,
      hostname: clientInfo ? clientInfo.hostname : null
    });

    const retryOrReject = (err) => {
      if (isRetry) { reject(err); return; }
      setTimeout(() => {
        attemptRpcCall(remoteHost, channel, payload, timeoutMs, true, clientInfo, token).then(resolve, reject);
      }, 1000);
    };

    // Ключ доступа — заголовком, а не в теле и не в query: так он не попадает ни в
    // логи обращений, ни в историю браузера, если адрес когда-то откроют руками
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    try {
      const safeToken = normalizeToken(token);
      if (safeToken) headers['X-NM-Token'] = safeToken;
    } catch (err) { reject(err); return; }

    const req = http.request({
      hostname, port, path: '/rpc', method: 'POST', headers,
      timeout: timeoutMs
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          reject(new Error('Ответ пришёл не в формате JSON — по этому адресу, похоже, другая служба'));
          return;
        }
        // Ответ ПРИШЁЛ — сеть работает, дело не в связи, а в самом запросе (например,
        // отклонённая запись) — повтор тут не поможет, отклоняем сразу без retry
        if (parsed.ok) resolve(parsed.result);
        else reject(new Error(parsed.error || 'Сервер вернул ошибку без описания'));
      });
    });

    req.on('timeout', () => {
      req.destroy();
      retryOrReject(new Error(`Сервер не ответил за ${Math.round(timeoutMs / 1000)} сек — проверьте адрес и подключение к сети`));
    });
    req.on('error', (err) => retryOrReject(new Error(`Не удалось связаться с ${remoteHost}: ${err.message}`)));

    req.write(body);
    req.end();
  });
}

/** Быстрая проверка "жив ли хост" — используется при подключении и периодически для
 *  индикатора соединения в интерфейсе, без похода в саму БД. clientInfo (необязательно)
 *  — { clientId, hostname }: если передан, хост узнаёт о факте подключения этого клиента
 *  (см. onClientPing в rpcServer.js) — без этого хост "не видит" клиентов формально. */
function rpcPing(remoteHost, timeoutMs = 5000, clientInfo = null, token = null) {
  return new Promise((resolve) => {
    const [hostname, portStr] = remoteHost.split(':');
    const port = Number(portStr) || 80;
    let path = '/ping';
    if (clientInfo && clientInfo.clientId) {
      const params = new URLSearchParams({ clientId: clientInfo.clientId, hostname: clientInfo.hostname || clientInfo.clientId });
      path = `/ping?${params.toString()}`;
    }
    let headers;
    try {
      const safeToken = normalizeToken(token);
      headers = safeToken ? { 'X-NM-Token': safeToken } : {};
    } catch { resolve(false); return; } // ping отвечает только "да/нет"; причину объяснит rpcDiagnose

    const req = http.request({ hostname, port, path, method: 'GET', headers, timeout: timeoutMs }, (res) => {
      resolve(res.statusCode === 200);
      res.resume(); // сливаем тело ответа, чтобы не держать сокет
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/** Отдельная диагностика подключения — в отличие от rpcPing отвечает НЕ "да/нет", а
 *  чем именно всё кончилось: адрес не отвечает / ключ не принят / всё хорошо. Нужна
 *  кнопке "Проверить" в настройках, где "не получилось" без причины бесполезно. */
function rpcDiagnose(remoteHost, timeoutMs = 6000, token = null) {
  return new Promise((resolve) => {
    const [hostname, portStr] = remoteHost.split(':');
    const port = Number(portStr) || 80;
    let headers;
    try {
      const safeToken = normalizeToken(token);
      headers = safeToken ? { 'X-NM-Token': safeToken } : {};
    } catch (err) {
      // Это не сетевая проблема, а неверно введённый ключ — так и говорим
      resolve({ ok: false, reason: 'token-format', error: err.message });
      return;
    }
    const req = http.request({ hostname, port, path: '/ping', method: 'GET', headers, timeout: timeoutMs }, (res) => {
      res.resume();
      if (res.statusCode === 200) resolve({ ok: true });
      else if (res.statusCode === 401) resolve({ ok: false, reason: 'token', error: 'Сервер доступен, но ключ доступа не принят.' });
      else resolve({ ok: false, reason: 'http', error: `Сервер ответил кодом ${res.statusCode}.` });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout', error: `Сервер ${remoteHost} не ответил за ${Math.round(timeoutMs / 1000)} сек.` }); });
    req.on('error', (err) => resolve({ ok: false, reason: 'network', error: `Не удалось связаться с ${remoteHost}: ${err.message}` }));
    req.end();
  });
}

module.exports = { rpcCall, rpcPing, rpcDiagnose, normalizeToken };
