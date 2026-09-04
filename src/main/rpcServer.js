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

/** Запускает RPC-сервер на указанном порту. rpcHandlers — карта { [channel]: { fn, write } },
 *  та же самая, что main/index.js использует для локальных ipcMain.handle(). Слушает на
 *  0.0.0.0, чтобы быть доступным с других машин в локальной сети, не только с localhost. */
function startRpcServer(port, rpcHandlers) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/ping') {
      // Лёгкая проверка "жив ли хост" — используется клиентом для индикации соединения,
      // без похода в саму БД
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
        .then(() => entry.fn(parsed.payload))
        .then((result) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        })
        .catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
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
