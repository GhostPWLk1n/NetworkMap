// Проверка загрузки счёта в настоящем приложении Electron (задача #8): тот же путь, что у
// оператора — кнопка «Загрузить PDF» → главный процесс читает файл и разбирает его pdf.js →
// форма проверки. Системный диалог выбора файла подменяется: он по очереди «выбирает»
// вымышленные PDF из tests/fixtures/invoices. Профиль и база — временные, рабочие данные
// не затрагиваются.
//
// Запуск (Windows, macOS):  npx electron tests/electron/invoice-smoke.js
//          Linux без экрана: xvfb-run -a npx electron tests/electron/invoice-smoke.js --no-sandbox
// или npm run test:invoices-electron. Код выхода 0 — всё прошло.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog } = require('electron');

const REPO = path.join(__dirname, '..', '..');
const FIX = path.join(REPO, 'tests', 'fixtures', 'invoices');
const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));
const CASES = ['invoice-3pages.pdf', 'invoice-cid-no-tounicode.pdf', 'invoice-1c-centered.pdf', 'invoice-unreadable.pdf', 'invoice-scan.pdf'];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-invoice-smoke-'));
app.setPath('userData', tmp);
const queue = CASES.map((f) => path.join(FIX, f));
dialog.showOpenDialog = async () => {
  const p = queue.shift();
  return p ? { canceled: false, filePaths: [p] } : { canceled: true, filePaths: [] };
};

require(path.join(REPO, 'src', 'main', 'index.js'));

const RENDERER_TEST = `(async () => {
  const out = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const waitFor = async (pred, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (pred()) return true; } catch {} await sleep(50); } return false; };
  const cases = ${JSON.stringify(CASES.map((f) => ({ f, number: expected[f].number || null, items: (expected[f].items || []).length, unreadable: !!expected[f].unreadable, scan: !!expected[f].no_text_layer })))};
  $('.tab-btn[data-tab="invoices"]').click();
  await sleep(300);
  for (const c of cases) {
    $('#invoices-upload-btn').click();
    await sleep(100);
    await waitFor(() => !$('#invoices-upload-btn').disabled);
    await sleep(200);
    const modal = !$('#invoice-modal').classList.contains('hidden');
    const alert = !$('#alert-modal').classList.contains('hidden') ? $('#alert-modal-title').textContent : '';
    if (alert) $('#alert-modal-ok').click();
    const number = $('#invoice-form [data-field="number"]').value;
    const rows = document.querySelectorAll('#invoice-items-body tr').length;
    const status = $('#invoice-status').textContent;
    let ok;
    if (c.unreadable) ok = modal && rows === 0 && number === '' && /не читается/.test(status);
    else if (c.scan) ok = modal && rows === 0 && number === '' && /текстового слоя/.test(status);
    else ok = modal && number === c.number && rows === c.items;
    out.push({ file: c.f, ok, detail: alert || \`номер «\${number}», строк \${rows}\${c.items ? ' из ' + c.items : ''}\` });
    if (modal) {
      $('#invoice-cancel-btn').click();
      await sleep(150);
      if (!$('#confirm-modal').classList.contains('hidden')) $('#confirm-modal-ok').click();
      await sleep(150);
    }
  }
  return out;
})()`;

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, 2500));
    let code = 1;
    try {
      const res = await win.webContents.executeJavaScript(RENDERER_TEST, true);
      res.forEach((r) => console.log(`${r.ok ? '  OK  ' : '  FAIL'} ${r.file} — ${r.detail}`));
      const fails = res.filter((r) => !r.ok).length;
      console.log(`\n${fails === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `ПРОВАЛОВ: ${fails}`} (${res.length - fails}/${res.length}) — ${process.platform}, Electron ${process.versions.electron}`);
      code = fails === 0 ? 0 : 1;
    } catch (e) {
      console.log('ОШИБКА', e && e.message);
    }
    setTimeout(() => {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* база ещё открыта — уберёт система */ }
      app.exit(code);
    }, 300);
  });
});
