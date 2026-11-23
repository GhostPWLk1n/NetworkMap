// invoiceFiles.js — то, что в работе со счетами (задача #8) делает только приложение
// оператора и чего не может сервер: выбрать PDF на диске, разобрать его, открыть
// сохранённый оригинал во внешней программе или сохранить копию.
//
// Каналы работают одинаково в любом режиме (локальный, хост, клиент сервера): они не
// трогают базу. Сохранение счёта и получение оригинала — каналы invoices:* из
// src/shared/dbChannels.js, их выполняет процесс, владеющий базой.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractPdfText, InvoicePdfError, MAX_PDF_BYTES, sha256 } = require('./invoicePdf');
const { parseInvoice } = require('../shared/invoiceParser');

const TEMP_DIR = path.join(os.tmpdir(), 'networkmap-invoices');
const TEMP_TTL_MS = 24 * 3600 * 1000;

/**
 * Имя файла для диска. Имя приходит из базы и могло быть записано кем угодно, поэтому:
 * только имя (без пути), без символов, запрещённых в Windows, и ВСЕГДА с расширением
 * .pdf — иначе «счёт.exe» с содержимым PDF система открыла бы как программу.
 */
function safePdfName(name) {
  let base = String(name || '').split(/[\\/]/).pop()
    .replace(/[<>:"|?*\u0000-\u001F\u007F]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 150);
  if (!base) base = 'счёт';
  if (!/\.pdf$/i.test(base)) base += '.pdf';
  return base;
}

/** Содержимое из канала invoices:getFile → проверенный буфер PDF. */
function pdfBufferFrom(file) {
  if (!file || typeof file.content_base64 !== 'string') throw new Error('Оригинал счёта не получен.');
  const buf = Buffer.from(file.content_base64, 'base64');
  if (!buf.length || !buf.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
    throw new Error('Сохранённый оригинал не похож на PDF — открывать его не будем.');
  }
  return buf;
}

/** Старые временные копии оригиналов — убираем, чтобы они не копились в TEMP. */
function cleanupTemp() {
  try {
    const now = Date.now();
    fs.readdirSync(TEMP_DIR).forEach((f) => {
      const full = path.join(TEMP_DIR, f);
      try {
        if (now - fs.statSync(full).mtimeMs > TEMP_TTL_MS) fs.rmSync(full, { force: true });
      } catch { /* файл открыт в просмотрщике — уберём в следующий раз */ }
    });
  } catch { /* папки ещё нет */ }
}

/** Выбранный PDF → файл для сохранения + распознанные поля для формы проверки. */
async function readAndParse(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_PDF_BYTES) {
    throw new InvoicePdfError('too_large',
      `Файл больше ${Math.round(MAX_PDF_BYTES / 1024 / 1024)} МБ — такой счёт не загрузить. Сожмите PDF или сохраните его без лишних изображений.`);
  }
  const buffer = fs.readFileSync(filePath);
  const extracted = await extractPdfText(buffer);
  const parsed = parseInvoice(extracted);
  return {
    file: {
      file_name: path.basename(filePath),
      size_bytes: buffer.length,
      page_count: extracted.pageCount,
      sha256: sha256(buffer),
      content_base64: buffer.toString('base64')
    },
    parsed
  };
}

function registerInvoiceIpc({ ipcMain, dialog, shell, getWindow }) {
  ipcMain.handle('invoices:pickPdf', async () => {
    const picked = await dialog.showOpenDialog(getWindow(), {
      title: 'Выберите PDF счёта поставщика',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile']
    });
    if (picked.canceled || picked.filePaths.length === 0) return null;
    return readAndParse(picked.filePaths[0]);
  });

  // Открыть оригинал во внешней программе просмотра PDF: временная копия + shell
  ipcMain.handle('invoices:openFile', async (_event, file) => {
    const buf = pdfBufferFrom(file);
    cleanupTemp();
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    const prefix = (typeof file.sha256 === 'string' && /^[0-9a-f]{64}$/.test(file.sha256)) ? file.sha256.slice(0, 8) : Date.now().toString(36);
    const target = path.join(TEMP_DIR, `${prefix}-${safePdfName(file.file_name)}`);
    fs.writeFileSync(target, buf);
    const err = await shell.openPath(target);
    if (err) throw new Error(`Не удалось открыть PDF: ${err}. Сохраните копию и откройте её вручную.`);
    return { opened: true };
  });

  ipcMain.handle('invoices:saveFileAs', async (_event, file) => {
    const buf = pdfBufferFrom(file);
    const picked = await dialog.showSaveDialog(getWindow(), {
      title: 'Сохранить оригинал счёта',
      defaultPath: safePdfName(file.file_name),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (picked.canceled || !picked.filePath) return null;
    const target = /\.pdf$/i.test(picked.filePath) ? picked.filePath : `${picked.filePath}.pdf`;
    fs.writeFileSync(target, buf);
    return { path: target };
  });
}

module.exports = { registerInvoiceIpc, readAndParse, safePdfName };
