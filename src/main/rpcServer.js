// rpcServer.js
//
// Поднимает простой HTTP JSON-RPC поверх Node http (без внешних зависимостей) — единая
// точка входа POST /rpc с телом { channel, payload }, диспетчеризация в тот же
// RPC_HANDLERS, что использует и обычный (локальный) IPC-режим — см. main/index.js.
//
// Используется ДВУМЯ точками входа:
//   - режим "хост": один экземпляр приложения держит файл БД у себя ЛОКАЛЬНО (никогда
//     не открывается по сети — в этом весь смысл режима, устраняет саму причину
//     зависаний/конфликтов при открытии файла несколькими процессами), остальные
//     подключаются к нему как клиенты (см. rpcClient.js);
//   - выделенный сервер (server/index.js, обычно в докере): то же самое, но без
//     Electron и без интерфейса — база доступна постоянно, а не пока у кого-то открыто
//     приложение.
// Поэтому здесь не должно быть ничего, что требует Electron.

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

/** Сравнение секретов за постоянное время. Обычное === выходит на первом несовпавшем
 *  символе, и по времени ответа ключ можно подбирать посимвольно. timingSafeEqual
 *  требует равной длины буферов — поэтому сравниваем не сами строки, а их SHA-256:
 *  хэши всегда по 32 байта, и длина настоящего ключа тоже ничего не выдаёт. */
function secretsEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a == null ? '' : a)).digest();
  const hb = crypto.createHash('sha256').update(String(b == null ? '' : b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
  res.end(html);
}

/**
 * Запускает RPC-сервер на указанном порту. Слушает на 0.0.0.0, чтобы быть доступным с
 * других машин, не только с localhost.
 *
 * rpcHandlers — карта { [channel]: { fn, write, lockEntity } }, та же самая, что
 * main/index.js использует для локальных ipcMain.handle() (см. shared/dbChannels.js).
 *
 * options:
 *   token            — общий секрет. Если задан, КАЖДЫЙ запрос обязан принести его в
 *                      заголовке X-NM-Token (страница статуса — ещё и как ?token=, из
 *                      адресной строки браузера заголовок не отправить). Если не задан,
 *                      проверки нет вообще — прежнее поведение режима "хост".
 *   onClientPing(clientId, hostname)
 *                    — на каждый /ping с идентификацией клиента; так сервер узнаёт, кто
 *                      сейчас подключён, не храня состояние соединения (RPC остаётся
 *                      stateless).
 *   authorizeWrite(channel, payload, clientId, hostname)
 *                    — ПЕРЕД любой write-операцией, пришедшей по сети (локальные вызовы
 *                      самого хоста её не проходят вообще — хост хозяин своих данных).
 *                      Должна вернуть { ok: true } либо { ok: false, error }. БЕЗ этого
 *                      колбэка все write-запросы по сети отклоняются — то самое прежнее
 *                      поведение "клиент только смотрит", когда запись нигде не разрешена.
 *   onWriteSuccess(channel, payload)
 *                    — ПОСЛЕ успешной write-операции по сети: хост так узнаёт, что клиент
 *                      только что что-то изменил, и обновляет своё окно (см.
 *                      notifyHostOfClientWrite в main/index.js).
 *   statusPage()     — вернуть { title, rows: [[label, value], ...] } для страницы статуса
 *                      по GET /. Без него GET / отвечает кратким JSON.
 *   healthCheck()    — вернуть { ok: boolean, ...поля } для GET /health (docker healthcheck).
 *   onLog(level, msg)— куда писать события сервера; без него молчит.
 */
function startRpcServer(port, rpcHandlers, options = {}) {
  const {
    token = null, onClientPing = null, authorizeWrite = null, onWriteSuccess = null,
    statusPage = null, healthCheck = null, onLog = null
  } = options;

  const log = (level, msg) => { if (onLog) { try { onLog(level, msg); } catch { /* логирование не должно ронять ответ */ } } };

  /** Токен из заголовка, либо (только для страницы статуса) из query. */
  function tokenAccepted(req, parsedUrl, allowQuery) {
    if (!token) return true; // проверка не настроена — пускаем всех, как было у хоста
    const header = req.headers['x-nm-token'];
    if (header && secretsEqual(header, token)) return true;
    if (allowQuery && parsedUrl) {
      const q = parsedUrl.searchParams.get('token');
      if (q && secretsEqual(q, token)) return true;
    }
    return false;
  }

  const server = http.createServer((req, res) => {
    let parsedUrl = null;
    try {
      parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      sendJson(res, 400, { ok: false, error: 'Некорректный адрес запроса' });
      return;
    }
    const route = parsedUrl.pathname;

    // --- /health: нужен docker healthcheck, поэтому БЕЗ токена. Ничего о данных не
    // сообщает, только жив ли процесс и открыта ли база.
    if (req.method === 'GET' && route === '/health') {
      let body = { ok: true };
      if (healthCheck) {
        try { body = healthCheck(); } catch (err) { body = { ok: false, error: err.message }; }
      }
      sendJson(res, body && body.ok ? 200 : 503, body);
      return;
    }

    // --- /ping: лёгкая проверка "жив ли сервер" для индикатора связи в приложении,
    // без похода в саму БД. Токен спрашиваем: иначе по /ping можно безошибочно найти
    // сервер в сети и заодно отметиться в списке подключённых.
    if (req.method === 'GET' && route === '/ping') {
      if (!tokenAccepted(req, parsedUrl, false)) {
        sendJson(res, 401, { ok: false, error: 'Неверный ключ доступа к серверу' });
        return;
      }
      if (onClientPing) {
        try {
          const clientId = parsedUrl.searchParams.get('clientId');
          const hostname = parsedUrl.searchParams.get('hostname');
          if (clientId) onClientPing(clientId, hostname || clientId);
        } catch { /* некорректный query — не критично, просто не узнаем, кто это был */ }
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    // --- GET /: страница статуса в браузере (есть только у выделенного сервера)
    if (req.method === 'GET' && (route === '/' || route === '/status')) {
      if (!tokenAccepted(req, parsedUrl, true)) {
        sendHtml(res, 401, renderStatusHtml('Доступ закрыт', [
          ['Ключ доступа', 'не указан или неверный'],
          ['Как смотреть статус', 'откройте адрес с ?token=КЛЮЧ в конце']
        ]));
        return;
      }
      if (!statusPage) {
        sendJson(res, 200, { ok: true, service: 'NetworkMap RPC' });
        return;
      }
      try {
        const page = statusPage();
        sendHtml(res, 200, renderStatusHtml(page.title || 'Сервер NetworkMap', page.rows || []));
      } catch (err) {
        sendHtml(res, 500, renderStatusHtml('Ошибка', [['Не удалось собрать статус', err.message]]));
      }
      return;
    }

    if (req.method !== 'POST' || route !== '/rpc') {
      sendJson(res, 404, { ok: false, error: 'Неизвестный маршрут' });
      return;
    }

    if (!tokenAccepted(req, parsedUrl, false)) {
      log('warn', `Отклонён запрос без корректного ключа доступа с ${req.socket.remoteAddress}`);
      sendJson(res, 401, {
        ok: false,
        error: 'Неверный ключ доступа к серверу — проверьте его в ⚙️ Настройки БД → Подключиться к серверу.'
      });
      return;
    }

    let body = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      body += chunk;
      // Защита от запроса, который выест память: осмысленный payload (путь кабеля,
      // клетки зоны) — это килобайты, никак не десятки мегабайт
      if (body.length > 8 * 1024 * 1024) { tooLarge = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooLarge) return;
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, 400, { ok: false, error: 'Некорректный JSON в запросе' });
        return;
      }

      const entry = rpcHandlers[parsed.channel];
      if (!entry) {
        sendJson(res, 404, { ok: false, error: `Неизвестный метод: ${parsed.channel}` });
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
            const err = new Error('Только просмотр — редактирование по сети сейчас не разрешено.');
            err.statusCode = 403;
            throw err;
          }
          return entry.fn(parsed.payload);
        })
        .then((result) => {
          if (entry.write && onWriteSuccess) {
            try { onWriteSuccess(parsed.channel, parsed.payload); } catch { /* уведомление своего окна — не должно ронять ответ клиенту */ }
          }
          sendJson(res, 200, { ok: true, result });
        })
        .catch((err) => {
          if (entry.write) log('warn', `Отказ по ${parsed.channel} (${parsed.hostname || '?'}): ${err.message}`);
          sendJson(res, err.statusCode || 500, { ok: false, error: err.message || String(err) });
        });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Страница статуса — осознанно одна строка без внешних файлов: сервер раздаёт только
 *  протокол, тащить ради неё статику в образ незачем. */
function renderStatusHtml(title, rows) {
  const body = rows.map(([label, value]) => `
      <tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join('');
  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 24px 16px;
         background: #f6f7f9; color: #222; }
  main { max-width: 680px; margin: 0 auto; background: #fff; border: 1px solid #e2e5e9;
         border-radius: 10px; padding: 20px 22px; }
  h1 { font-size: 18px; margin: 0 0 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 7px 0; border-bottom: 1px solid #eef0f2; vertical-align: top; }
  th { width: 44%; font-weight: 600; color: #555; padding-right: 12px; }
  td { word-break: break-word; }
  tr:last-child th, tr:last-child td { border-bottom: none; }
  footer { max-width: 680px; margin: 10px auto 0; font-size: 12px; color: #888; }
  @media (prefers-color-scheme: dark) {
    body { background: #16181c; color: #e6e8ea; }
    main { background: #1f2227; border-color: #30343a; }
    th { color: #a9b0b8; } th, td { border-bottom-color: #2a2e34; }
    footer { color: #777; }
  }
</style></head>
<body><main><h1>${escapeHtml(title)}</h1><table>${body}</table></main>
<footer>Страница обновляется по перезагрузке.</footer></body></html>`;
}

module.exports = { startRpcServer, renderStatusHtml };
