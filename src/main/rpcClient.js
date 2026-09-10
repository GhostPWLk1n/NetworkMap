// rpcClient.js
//
// Вызывает методы на удалённом хосте по HTTP JSON-RPC (см. rpcServer.js). Используется
// только в режиме "клиент" — своя БД в этом режиме не открывается вообще, весь main/index.js
// проксирует ipcMain.handle() сюда вместо прямых вызовов репозиториев.

const http = require('http');

/** remoteHost — строка вида "192.168.1.42:47821" (без протокола). При сетевом сбое
 *  (таймаут/обрыв соединения — не путать с ответом хоста {ok:false}, там повтор
 *  бессмысленен) делает один повтор через секунду — переживает короткие сетевые
 *  заминки без участия пользователя. clientInfo ({ clientId, hostname }) передаётся в
 *  теле запроса — хосту нужно знать, ЧЕЙ это запрос, чтобы для write-операций сверить
 *  с блокировками на редактирование (см. writeLocks.js/authorizeWrite в main/index.js);
 *  для read-запросов хост его просто не использует, но передаём всегда единообразно. */
function rpcCall(remoteHost, channel, payload, timeoutMs = 10000, clientInfo = null) {
  return attemptRpcCall(remoteHost, channel, payload, timeoutMs, false, clientInfo);
}

function attemptRpcCall(remoteHost, channel, payload, timeoutMs, isRetry, clientInfo) {
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
        attemptRpcCall(remoteHost, channel, payload, timeoutMs, true, clientInfo).then(resolve, reject);
      }, 1000);
    };

    const req = http.request({
      hostname, port, path: '/rpc', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          reject(new Error('Хост ответил не в формате JSON'));
          return;
        }
        // Ответ ПРИШЁЛ — сеть работает, дело не в связи, а в самом запросе (например,
        // отклонённая запись) — повтор тут не поможет, отклоняем сразу без retry
        if (parsed.ok) resolve(parsed.result);
        else reject(new Error(parsed.error || 'Хост вернул ошибку'));
      });
    });

    req.on('timeout', () => {
      req.destroy();
      retryOrReject(new Error(`Хост не ответил за ${Math.round(timeoutMs / 1000)} сек — проверьте адрес и подключение к сети`));
    });
    req.on('error', (err) => retryOrReject(new Error(`Не удалось связаться с хостом ${remoteHost}: ${err.message}`)));

    req.write(body);
    req.end();
  });
}

/** Быстрая проверка "жив ли хост" — используется при подключении и периодически для
 *  индикатора соединения в интерфейсе, без похода в саму БД. clientInfo (необязательно)
 *  — { clientId, hostname }: если передан, хост узнаёт о факте подключения этого клиента
 *  (см. onClientPing в rpcServer.js) — без этого хост "не видит" клиентов формально. */
function rpcPing(remoteHost, timeoutMs = 5000, clientInfo = null) {
  return new Promise((resolve) => {
    const [hostname, portStr] = remoteHost.split(':');
    const port = Number(portStr) || 80;
    let path = '/ping';
    if (clientInfo && clientInfo.clientId) {
      const params = new URLSearchParams({ clientId: clientInfo.clientId, hostname: clientInfo.hostname || clientInfo.clientId });
      path = `/ping?${params.toString()}`;
    }

    const req = http.request({ hostname, port, path, method: 'GET', timeout: timeoutMs }, (res) => {
      resolve(res.statusCode === 200);
      res.resume(); // сливаем тело ответа, чтобы не держать сокет
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

module.exports = { rpcCall, rpcPing };
