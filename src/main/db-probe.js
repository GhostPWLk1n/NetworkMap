// db-probe.js
//
// Пробует открыть БД по конфигу подключения — запускается ОТДЕЛЬНЫМ процессом
// (child_process.fork) из main/index.js, с жёстким таймаутом на уровне родителя.
//
// Смысл существования этого файла: попытка открыть файл БД (особенно по сетевому
// пути \\server\share\...) в редких случаях зависает на уровне ОС — блокирующий
// syscall внутри fs.existsSync()/new Database(), например, если сетевая шара
// "наполовину отвалилась" (не даёт быстрый ответ "недоступно", а просто висит).
// Обычный JS-таймаут (Promise.race + setTimeout) в этом случае НЕ спасает — поток
// всё равно остаётся забит этим вызовом, и весь процесс Electron виснет насмерть.
// Единственный надёжный способ прервать такое зависание — убить ПРОЦЕСС целиком
// (child.kill() в родителе), а не пытаться прервать вызов изнутри того же потока.
//
// Поэтому вся рискованная часть подключения продублирована здесь и выполняется в
// одноразовом, убиваемом снаружи процессе, а не в основном процессе Electron.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

function getConfigPath() {
  // process.argv[2] — путь до userData, передаётся явно, т.к. модуль electron
  // (app.getPath) в дочернем процессе без полной инициализации Electron недоступен
  const userDataPath = process.argv[2];
  return path.join(userDataPath, 'db-config.json');
}

function loadDbConfig() {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
  } catch {
    return {};
  }
}

function main() {
  const cfg = loadDbConfig();

  if (!cfg.dbPath) {
    // Родитель не должен был запускать пробник в этом случае вовсе (см. main/index.js) —
    // но на всякий случай не падаем молча, а честно репортим.
    process.send({ ok: true, usedDefault: true });
    return;
  }

  const dir = path.dirname(cfg.dbPath);
  if (!fs.existsSync(dir)) {
    process.send({ ok: false, error: `Папка с базой недоступна: ${dir}` });
    return;
  }

  try {
    const db = new Database(cfg.dbPath);
    db.pragma('journal_mode = WAL');
    db.prepare('SELECT 1').get();
    db.close();
    process.send({ ok: true, usedDefault: false, dbPath: cfg.dbPath });
  } catch (err) {
    process.send({ ok: false, error: err.message });
  }
}

main();
