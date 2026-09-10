// rpcServer.js
//
// Поднимает простой HTTP JSON-RPC поверх Node http (без внешних зависимостей) — единая
// точка входа POST /rpc с телом { channel, payload }, диспетчеризация в тот же
// RPC_HANDLERS, что использует и обычный (локальный) IPC-режим — см. main/index.js.
//
// Используется только в режиме "хост": один процесс держит файл БД у себя ЛОКАЛЬНО
// (никогда не открывается по сети — именно в этом весь смысл режима, устраняет саму
// причину зависаний/конфликтов при открытии файла несколькими процессами по сети),
// остальные подключаются к этому серверу как клиенты (см. rpcClient.js).

const http = require('http');
const { URL } = require('url');

/** Запускает RPC-сервер на указанном порту. rpcHandlers — карта { [channel]: { fn, write,
 *  lockEntity } }, та же самая, что main/index.js использует для локальных ipcMain.handle().
 *  Слушает на 0.0.0.0, чтобы быть доступным с других машин в локальной сети, не только с
 *  localhost.
 *  onClientPing(clientId, hostname) — вызывается на каждый /ping с идентификацией клиента —
 *  хост так узнаёт, кто сейчас подключён.
 *  authorizeWrite(channel, payload, clientId, hostname) — вызывается ПЕРЕД любой write-
 *  операцией, пришедшей по сети (локальные вызовы самого хоста её не проходят вообще —
 *  хост всегда полный хозяин своих данных). Должна вернуть { ok: true } или { ok: false,
 *  error }. Без этого колбэка все write-запросы по сети остаются отклонены (прежнее
 *  поведение "клиент — только просмотр", когда разрешение на запись нигде не настроено).
 *  onWriteSuccess(channel, payload) — вызывается ПОСЛЕ успешной write-операции, пришедшей
 *  по сети — хост так узнаёт, что клиент только что реально что-то изменил, и может
 *  обновить своё собственное окно (см. notifyHostOfClientWrite в main/index.js). Без этого
 *  хост "не видит" правки клиентов в своём интерфейсе, пока сам что-то не сделает. */
function startRpcServer(port, rpcHandlers, onClientPing, authorizeWrite, onWriteSuccess) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/ping')) {
      // Лёгкая проверка "жив ли хост" — используется клиентом для индикации соединения,
      // без похода в саму БД. Заодно, если клиент представился (clientId/hostname в
      // query), сообщаем об этом хосту через колбэк — так хост узнаёт о подключённых
      // клиентах, не открывая отдельное состояние соединения (RPC остаётся stateless).
      if (onClientPing) {
        try {
          const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
          const clientId = url.searchParams.get('clientId');
          const hostname = url.searchParams.get('hostname');
          if (clientId) onClientPing(clientId, hostname || clientId);
        } catch { /* некорректный query — не критично, просто не узнаем, кто это был */ }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/rpc') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Неизвестный маршрут' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Некорректный JSON в запросе' }));
        return;
      }

      const entry = rpcHandlers[parsed.channel];
      if (!entry) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `Неизвестный метод: ${parsed.channel}` }));
        return;
      }

      Promise.resolve()
        .then(async () => {
          if (entry.write && authorizeWrite) {
            const auth = await authorizeWrite(parsed.channel, parsed.payload, parsed.clientId, parsed.hostname);
            if (!auth || !auth.ok) {
              const err = new Error((auth && auth.error) || 'Изменение сейчас недоступно.');
              err.statusCode = 403;
              throw err;
            }
          } else if (entry.write) {
            // authorizeWrite не передан вообще — запись по сети запрещена безусловно
            // (прежнее поведение, если разрешение клиентам нигде не включалось)
            const err = new Error('Только просмотр — редактирование по сети сейчас не разрешено хостом.');
            err.statusCode = 403;
            throw err;
          }
          return entry.fn(parsed.payload);
        })
        .then((result) => {
          if (entry.write && onWriteSuccess) {
            try { onWriteSuccess(parsed.channel, parsed.payload); } catch { /* уведомление собственного окна хоста — не должно ронять ответ клиенту */ }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        })
        .catch((err) => {
          res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message || String(err) }));
        });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

module.exports = { startRpcServer };
