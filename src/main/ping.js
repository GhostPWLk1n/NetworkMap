const { exec } = require('child_process');

/**
 * Пингует один IP системной утилитой ping (без сторонних npm-пакетов).
 * Возвращает { status: 'online'|'offline'|'timeout', responseTimeMs: number|null }
 */
function pingHost(ip) {
  return new Promise((resolve) => {
    if (!ip) {
      resolve({ status: 'offline', responseTimeMs: null });
      return;
    }

    const isWindows = process.platform === 'win32';
    const cmd = isWindows
      ? `ping -n 1 -w 1500 ${ip}`
      : `ping -c 1 -W 2 ${ip}`;

    exec(cmd, { timeout: 3000 }, (error, stdout) => {
      if (error) {
        resolve({ status: 'timeout', responseTimeMs: null });
        return;
      }

      // Пытаемся вытащить время отклика из вывода ping (кроссплатформенно, эвристикой)
      const match = stdout.match(/time[=<]([\d.]+)\s*ms/i);
      const responseTimeMs = match ? Math.round(parseFloat(match[1])) : null;
      resolve({ status: 'online', responseTimeMs });
    });
  });
}

module.exports = { pingHost };
