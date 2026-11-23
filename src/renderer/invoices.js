// invoices.js — лист «Счета» (задача #8): реестр счетов поставщиков, загрузка PDF,
// проверка распознанного перед записью, просмотр и правка карточки, оригинал.
//
// Подключается после index.js и пользуется его общими помощниками (showToast,
// confirmModal, handleApiErrorLocally, smallListNote). Числа и предупреждения о
// расхождениях — src/shared/invoiceMath.js (глобальный InvoiceMath): тот же код
// проверяет данные и при записи в базу.
//
// Правило: форма ничего не «угадывает». Что не распознано — остаётся пустым и
// подсвечивается, расхождения сумм показываются предупреждением, а исправляет их оператор.

const INVOICE_HEADER_FIELDS = ['number', 'invoice_date', 'currency', 'supplier_name', 'supplier_inn', 'supplier_kpp',
  'buyer_name', 'buyer_inn', 'buyer_kpp', 'total_amount', 'vat_amount', 'amount_due', 'vat_note', 'notes'];
const INVOICE_NUM_FIELDS = ['total_amount', 'vat_amount', 'amount_due'];
const INVOICE_ITEM_COLS = [
  { key: 'code', cls: 'c-code' },
  { key: 'name', cls: 'c-name', multiline: true },
  { key: 'unit', cls: 'c-unit' },
  { key: 'quantity', cls: 'c-num', num: true },
  { key: 'price', cls: 'c-num', num: true },
  { key: 'amount', cls: 'c-num', num: true },
  { key: 'vat_rate', cls: 'c-rate' },
  { key: 'vat_amount', cls: 'c-num', num: true }
];
// Поля, которые разборщик вообще пытается найти: только их отсутствие подсвечиваем как
// «не распознано» (примечание оператор пишет сам)
const INVOICE_PARSED_FIELDS = ['number', 'invoice_date', 'currency', 'supplier_name', 'supplier_inn', 'supplier_kpp',
  'buyer_name', 'buyer_inn', 'buyer_kpp', 'total_amount', 'vat_amount', 'amount_due', 'vat_note'];

let invoicesCache = [];
let invoicesUnsupported = false;
const invoiceUi = {
  mode: null,          // 'new' — распознанный PDF до записи; 'view' — сохранённый; 'edit' — правка сохранённого
  invoice: null,       // сохранённая карточка (view/edit)
  file: null,          // новый файл до записи: { file_name, size_bytes, page_count, sha256, content_base64 }
  parsed: null,        // результат разбора PDF (new)
  initial: '',         // снимок формы для вопроса «закрыть без сохранения?»
  busy: false
};

const $inv = (id) => document.getElementById(id);
const fmtNum = (v) => (v === null || v === undefined || v === '' ? '' : InvoiceMath.formatRu(String(v)));
function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : (iso || '');
}
function fmtSize(bytes) {
  if (!bytes) return '';
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}
function pagesLabel(n) {
  if (!n) return '';
  const m10 = n % 10;
  const m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? 'страница' : (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'страницы' : 'страниц');
  return `${n} ${word}`;
}
function invoiceTitle(inv) {
  return `Счёт № ${inv.number || '—'}${inv.invoice_date ? ` от ${fmtDate(inv.invoice_date)}` : ''}`;
}
function moneyLine(inv) {
  const value = inv.amount_due || inv.total_amount;
  if (!value) return '';
  return `${inv.amount_due ? 'к оплате' : 'итого'} ${fmtNum(value)}${inv.currency ? ` ${inv.currency}` : ''}`;
}
function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'className') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  });
  if (text !== undefined) node.textContent = text;
  return node;
}
/** Сервер старой версии не знает каналов счетов — говорим это прямо. */
function isUnsupportedServerError(err) {
  return /Неизвестный метод: invoices:/.test((err && err.message) || '');
}
const UNSUPPORTED_TEXT = 'Сервер базы не поддерживает реестр счетов — обновите сервер NetworkMap до той же версии, что и приложение.';

// ------------------------------------------------------------
// Реестр
// ------------------------------------------------------------

async function renderInvoices() {
  handleApiErrorLocally('invoices:list');
  try {
    invoicesCache = await window.api.invoices.list();
    invoicesUnsupported = false;
  } catch (err) {
    invoicesUnsupported = isUnsupportedServerError(err);
    const container = $inv('invoices-list');
    container.innerHTML = '';
    container.appendChild(smallListNote(invoicesUnsupported ? UNSUPPORTED_TEXT : `Реестр счетов не загрузился: ${err.message}`));
    return;
  }
  applyInvoicesFilter();
}

function applyInvoicesFilter() {
  const query = ($inv('invoices-search-input').value || '').trim().toLocaleLowerCase('ru');
  const container = $inv('invoices-list');
  container.innerHTML = '';
  const rows = invoicesCache.filter((inv) => {
    if (!query) return true;
    const hay = [inv.number, inv.supplier_name, inv.supplier_inn, inv.buyer_name, inv.file_name, fmtDate(inv.invoice_date)]
      .filter(Boolean).join(' ').toLocaleLowerCase('ru');
    return query.split(/\s+/).every((w) => hay.includes(w));
  });
  if (invoicesCache.length === 0) {
    container.appendChild(smallListNote('Счетов пока нет — нажмите «Загрузить PDF».'));
    return;
  }
  if (rows.length === 0) { container.appendChild(smallListNote('Ничего не найдено')); return; }
  rows.forEach((inv) => container.appendChild(buildInvoiceCard(inv)));
}

function buildInvoiceCard(inv) {
  const row = el('div', { className: 'card-row invoice-card', dataset: { invoiceId: String(inv.id) }, tabindex: '0', role: 'button' });
  const header = el('div', { className: 'card-row-header' });
  const titleBox = el('div', { className: 'invoice-card-main' });
  titleBox.appendChild(el('div', { className: 'card-title' }, `${invoiceTitle(inv)} · ${inv.supplier_name}`));
  const sub = [moneyLine(inv), `${inv.items_count} поз.`, inv.supplier_inn ? `ИНН ${inv.supplier_inn}` : '', `📎 ${inv.file_name}`]
    .filter(Boolean).join(' · ');
  titleBox.appendChild(el('div', { className: 'card-subtitle' }, sub));
  header.appendChild(titleBox);
  row.appendChild(header);
  const open = () => openInvoice(inv.id);
  row.addEventListener('click', open);
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  return row;
}

// ------------------------------------------------------------
// Загрузка PDF
// ------------------------------------------------------------

async function startInvoiceUpload() {
  if (invoiceUi.busy) return;
  const btn = $inv('invoices-upload-btn');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = '⏳ Распознаём PDF…';
  try {
    handleApiErrorLocally('invoices:pickPdf');
    let picked;
    try {
      picked = await window.api.invoices.pickPdf();
    } catch (err) {
      await alertModal(`PDF не загружен. ${err.message}`);
      return;
    }
    if (!picked) return; // оператор закрыл диалог выбора
    // Тот же файл уже в реестре — второй документ не создаём, показываем сохранённый
    handleApiErrorLocally('invoices:findDuplicates');
    let dup;
    try {
      dup = await window.api.invoices.findDuplicates({ sha256: picked.file.sha256 });
    } catch (err) {
      await alertModal(isUnsupportedServerError(err) ? UNSUPPORTED_TEXT : `Не удалось проверить, загружался ли этот PDF: ${err.message}`);
      return;
    }
    if (dup.sameFile) {
      await openInvoice(dup.sameFile.id, { notice: 'Этот PDF уже загружен — открыт сохранённый счёт. Второй документ не создан.' });
      return;
    }
    openNewInvoice(picked);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function openNewInvoice({ file, parsed }) {
  invoiceUi.mode = 'new';
  invoiceUi.invoice = null;
  invoiceUi.file = file;
  invoiceUi.parsed = parsed;
  fillInvoiceForm(parsed.fields, parsed.items);
  markUnrecognized(parsed);
  const notes = [...(parsed.notes || [])];
  if (parsed.hasText) {
    notes.unshift('Проверьте распознанное по документу. Пустые поля, подсвеченные жёлтым, не распознаны — заполните их сами.');
  }
  setInvoiceStatus(notes.join(' '), parsed.hasText ? 'info' : 'warning');
  showInvoiceModal();
}

// ------------------------------------------------------------
// Карточка сохранённого счёта
// ------------------------------------------------------------

async function openInvoice(id, { notice = null } = {}) {
  handleApiErrorLocally('invoices:get');
  let inv;
  try {
    inv = await window.api.invoices.get(id);
  } catch (err) {
    showToast(isUnsupportedServerError(err) ? UNSUPPORTED_TEXT : `Счёт не открылся: ${err.message}`);
    return;
  }
  if (!inv) {
    showToast('Счёт не найден — возможно, его уже удалили.');
    renderInvoices();
    return;
  }
  invoiceUi.mode = 'view';
  invoiceUi.invoice = inv;
  invoiceUi.file = null;
  invoiceUi.parsed = null;
  fillInvoiceForm(inv, inv.items);
  markUnrecognized(null);
  setInvoiceStatus(notice, notice ? 'warning' : 'info');
  showInvoiceModal();
}

// ------------------------------------------------------------
// Форма
// ------------------------------------------------------------

function headerInput(key) {
  return $inv('invoice-form').querySelector(`[data-field="${key}"]`);
}

function fillInvoiceForm(fields, items) {
  INVOICE_HEADER_FIELDS.forEach((k) => {
    const input = headerInput(k);
    const v = fields[k];
    input.value = v === null || v === undefined ? '' : (INVOICE_NUM_FIELDS.includes(k) ? fmtNum(v) : String(v));
  });
  const body = $inv('invoice-items-body');
  body.innerHTML = '';
  (items || []).forEach((it) => addInvoiceItemRow(it));
  $inv('invoice-duplicates').classList.add('hidden');
  $inv('invoice-duplicates').innerHTML = '';
}

function autosize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight + 2, 160)}px`;
}

function addInvoiceItemRow(item = {}, { focus = false } = {}) {
  const body = $inv('invoice-items-body');
  const tr = el('tr', { className: 'invoice-item' });
  tr.appendChild(el('td', { className: 'c-pos' }));
  INVOICE_ITEM_COLS.forEach((col) => {
    const td = el('td', { className: col.cls });
    const input = col.multiline ? el('textarea', { rows: '1' }) : el('input', col.num ? { inputmode: 'decimal' } : {});
    input.dataset.col = col.key;
    if (col.num) input.dataset.num = '1';
    const v = item[col.key];
    input.value = v === null || v === undefined ? '' : (col.num ? fmtNum(v) : String(v));
    td.appendChild(input);
    tr.appendChild(td);
  });
  const del = el('button', { type: 'button', className: 'invoice-del-item', title: 'Удалить строку', 'aria-label': 'Удалить строку' }, '×');
  del.addEventListener('click', () => { tr.remove(); renumberInvoiceRows(); updateInvoiceWarnings(); });
  const tdDel = el('td', { className: 'c-del' });
  tdDel.appendChild(del);
  tr.appendChild(tdDel);
  body.appendChild(tr);
  renumberInvoiceRows();
  tr.querySelectorAll('textarea').forEach(autosize);
  if (focus) tr.querySelector('[data-col="name"]').focus();
  return tr;
}

function renumberInvoiceRows() {
  $inv('invoice-items-body').querySelectorAll('tr').forEach((tr, i) => { tr.querySelector('.c-pos').textContent = String(i + 1); });
}

/** Подсветка того, чего разбор не нашёл (только для нового счёта из PDF). */
function markUnrecognized(parsed) {
  INVOICE_HEADER_FIELDS.forEach((k) => {
    const input = headerInput(k);
    const missed = !!parsed && INVOICE_PARSED_FIELDS.includes(k) && (parsed.fields[k] === null || parsed.fields[k] === undefined);
    input.classList.toggle('unrecognized', missed);
    input.title = missed ? 'Не распознано — заполните по документу, если поле в нём есть' : '';
  });
}

/** Текущие значения формы: как введены (raw) и приведённые к виду для базы (values). */
function readInvoiceForm() {
  const raw = {};
  const values = {};
  const errors = [];
  INVOICE_HEADER_FIELDS.forEach((k) => {
    const input = headerInput(k);
    const s = input.value.trim();
    raw[k] = s;
    if (INVOICE_NUM_FIELDS.includes(k)) {
      const v = s ? InvoiceMath.parseDecimal(s) : null;
      if (s && v === null) errors.push({ input, message: `«${input.parentElement.firstChild.textContent.trim()}»: «${s}» — не число.` });
      values[k] = v;
    } else {
      values[k] = s || null;
    }
  });
  const items = [];
  const rawItems = [];
  $inv('invoice-items-body').querySelectorAll('tr').forEach((tr, idx) => {
    const it = {};
    const r = {};
    tr.querySelectorAll('[data-col]').forEach((input) => {
      const s = input.value.trim();
      r[input.dataset.col] = s;
      if (input.dataset.num) {
        const v = s ? InvoiceMath.parseDecimal(s) : null;
        if (s && v === null) errors.push({ input, message: `Строка ${idx + 1}: «${s}» — не число.` });
        it[input.dataset.col] = v;
      } else {
        it[input.dataset.col] = s || null;
      }
    });
    rawItems.push(r);
    items.push(it);
  });
  return { raw: JSON.stringify({ raw, rawItems }), values, items, errors };
}

function updateInvoiceWarnings() {
  const form = readInvoiceForm();
  const box = $inv('invoice-warnings');
  $inv('invoice-form').querySelectorAll('.invalid').forEach((n) => n.classList.remove('invalid'));
  $inv('invoice-items-body').querySelectorAll('tr.has-warning').forEach((n) => n.classList.remove('has-warning'));
  form.errors.forEach((e) => e.input.classList.add('invalid'));
  const warnings = InvoiceMath.validateInvoice({
    ...form.values,
    items: form.items,
    items_declared: invoiceUi.mode === 'new' && invoiceUi.parsed ? invoiceUi.parsed.itemsDeclared : null
  });
  const rows = $inv('invoice-items-body').querySelectorAll('tr');
  warnings.forEach((w) => { if (Number.isInteger(w.index) && rows[w.index]) rows[w.index].classList.add('has-warning'); });
  if (invoiceUi.mode !== 'view' && form.items.length === 0) {
    warnings.push({ message: 'В счёте нет позиций. Если в документе они есть, добавьте их строками.' });
  }
  const messages = [...form.errors.map((e) => e.message), ...warnings.map((w) => w.message)];
  box.innerHTML = '';
  box.classList.toggle('hidden', messages.length === 0);
  if (messages.length) {
    box.appendChild(el('div', { className: 'invoice-warnings-title' },
      invoiceUi.mode === 'view' ? 'Расхождения в счёте:' : 'Проверьте — суммы или данные не сходятся:'));
    const ul = el('ul');
    messages.forEach((m) => ul.appendChild(el('li', {}, m)));
    box.appendChild(ul);
  }
  return form;
}

function setInvoiceStatus(text, kind = 'info') {
  const box = $inv('invoice-status');
  box.textContent = text || '';
  box.className = `invoice-status ${kind}`;
  box.classList.toggle('hidden', !text);
}

function renderInvoiceFile() {
  const box = $inv('invoice-file');
  box.innerHTML = '';
  const meta = invoiceUi.mode === 'new' ? invoiceUi.file : invoiceUi.invoice;
  if (!meta) return;
  box.appendChild(el('span', { className: 'invoice-file-name', title: meta.file_name }, `📎 ${meta.file_name}`));
  box.appendChild(el('span', { className: 'invoice-file-meta' }, [pagesLabel(meta.page_count), fmtSize(meta.size_bytes)].filter(Boolean).join(', ')));
  const openBtn = el('button', { type: 'button', id: 'invoice-open-file' }, 'Открыть оригинал');
  openBtn.addEventListener('click', () => withInvoiceFile((f) => window.api.invoices.openFile(f), 'invoices:openFile'));
  const saveBtn = el('button', { type: 'button', id: 'invoice-save-file' }, 'Сохранить копию');
  saveBtn.addEventListener('click', () => withInvoiceFile(async (f) => {
    const r = await window.api.invoices.saveFileAs(f);
    if (r) showToast(`Копия сохранена: ${r.path}`, 'success', 5000);
  }, 'invoices:saveFileAs'));
  box.appendChild(openBtn);
  box.appendChild(saveBtn);
}

/** Оригинал: у нового счёта — ещё в памяти, у сохранённого — с сервера/из базы. */
async function withInvoiceFile(action, channel) {
  try {
    let file = invoiceUi.file;
    if (invoiceUi.mode !== 'new') {
      handleApiErrorLocally('invoices:getFile');
      file = await window.api.invoices.getFile(invoiceUi.invoice.id);
    }
    handleApiErrorLocally(channel);
    await action(file);
  } catch (err) {
    showToast(`Оригинал недоступен: ${err.message}`);
  }
}

function applyInvoiceMode() {
  const mode = invoiceUi.mode;
  const editable = mode === 'new' || mode === 'edit';
  const form = $inv('invoice-form');
  form.classList.toggle('readonly', !editable);
  form.querySelectorAll('input, textarea').forEach((n) => { n.readOnly = !editable; });
  $inv('invoice-add-item').classList.toggle('hidden', !editable);
  $inv('invoice-save-btn').classList.toggle('hidden', !editable);
  $inv('invoice-edit-btn').classList.toggle('hidden', mode !== 'view');
  $inv('invoice-delete-btn').classList.toggle('hidden', mode !== 'view');
  $inv('invoice-cancel-btn').textContent = editable ? 'Отмена' : 'Закрыть';
  $inv('invoice-save-btn').textContent = mode === 'new' ? 'Сохранить в реестр' : 'Сохранить изменения';
  const title = mode === 'new'
    ? 'Новый счёт — проверьте распознанное'
    : `${invoiceTitle(invoiceUi.invoice)}${mode === 'edit' ? ' — правка' : ''}`;
  $inv('invoice-modal-title').textContent = title;
  renderInvoiceFile();
}

function showInvoiceModal() {
  applyInvoiceMode();
  updateInvoiceWarnings();
  invoiceUi.initial = readInvoiceForm().raw;
  $inv('invoice-modal').classList.remove('hidden');
  const first = invoiceUi.mode === 'view' ? $inv('invoice-cancel-btn') : headerInput('number');
  first.focus();
}

const invoiceDirty = () => invoiceUi.mode !== 'view' && readInvoiceForm().raw !== invoiceUi.initial;

async function closeInvoiceModal({ force = false } = {}) {
  if (invoiceUi.busy) return false;
  if (!force && invoiceDirty()) {
    const what = invoiceUi.mode === 'new' ? 'Счёт не будет сохранён.' : 'Изменения не будут сохранены.';
    if (!await confirmModal(`Закрыть без сохранения? ${what}`)) return false;
  }
  if (invoiceUi.mode === 'edit' && !force) {
    // Отмена правки — возвращаемся к просмотру сохранённого
    invoiceUi.mode = 'view';
    fillInvoiceForm(invoiceUi.invoice, invoiceUi.invoice.items);
    setInvoiceStatus(null);
    showInvoiceModal();
    return true;
  }
  $inv('invoice-modal').classList.add('hidden');
  invoiceUi.mode = null;
  invoiceUi.file = null; // оригинал нового счёта не держим в памяти дольше нужного
  invoiceUi.parsed = null;
  return true;
}

// ------------------------------------------------------------
// Запись
// ------------------------------------------------------------

function recognitionSummary(values) {
  const p = invoiceUi.parsed;
  if (!p) return null;
  const recognized = INVOICE_PARSED_FIELDS.filter((k) => p.fields[k] !== null && p.fields[k] !== undefined);
  const edited = INVOICE_PARSED_FIELDS.filter((k) => (p.fields[k] ?? null) !== (values[k] ?? null));
  return { has_text: !!p.hasText, recognized_fields: recognized, edited_fields: edited, items_recognized: (p.items || []).length };
}

function setInvoiceBusy(busy, label) {
  invoiceUi.busy = busy;
  const save = $inv('invoice-save-btn');
  save.disabled = busy;
  $inv('invoice-cancel-btn').disabled = busy;
  if (label) save.textContent = label;
  else applyInvoiceMode();
}

async function saveInvoice({ confirmSameRequisites = false } = {}) {
  if (invoiceUi.busy || (invoiceUi.mode !== 'new' && invoiceUi.mode !== 'edit')) return;
  const form = updateInvoiceWarnings();
  if (form.errors.length) {
    setInvoiceStatus('Исправьте поля, подсвеченные красным: в них не число.', 'error');
    form.errors[0].input.focus();
    return;
  }
  const missing = [['number', 'номер счёта'], ['invoice_date', 'дату'], ['supplier_name', 'поставщика']]
    .filter(([k]) => !form.values[k]);
  if (missing.length) {
    setInvoiceStatus(`Укажите ${missing.map(([, l]) => l).join(', ')}.`, 'error');
    headerInput(missing[0][0]).focus();
    return;
  }
  const emptyName = form.items.findIndex((it) => !it.name);
  if (emptyName >= 0) {
    setInvoiceStatus(`Строка ${emptyName + 1}: укажите наименование или удалите строку.`, 'error');
    $inv('invoice-items-body').querySelectorAll('tr')[emptyName].querySelector('[data-col="name"]').focus();
    return;
  }

  const isNew = invoiceUi.mode === 'new';
  const channel = isNew ? 'invoices:create' : 'invoices:update';
  setInvoiceBusy(true, 'Сохранение…');
  let result;
  try {
    handleApiErrorLocally(channel);
    result = isNew
      ? await window.api.invoices.create({
        invoice: form.values, items: form.items, file: invoiceUi.file,
        recognition: recognitionSummary(form.values), confirmSameRequisites
      })
      : await window.api.invoices.update(invoiceUi.invoice.id, {
        invoice: form.values, items: form.items, revision: invoiceUi.invoice.revision, confirmSameRequisites
      });
  } catch (err) {
    setInvoiceBusy(false);
    setInvoiceStatus(isUnsupportedServerError(err) ? UNSUPPORTED_TEXT : `Не сохранено: ${err.message}`, 'error');
    return;
  }
  setInvoiceBusy(false);

  if (result.status === 'created' || result.status === 'updated') {
    invoiceUi.mode = 'view';
    invoiceUi.invoice = result.invoice;
    invoiceUi.file = null;
    invoiceUi.parsed = null;
    fillInvoiceForm(result.invoice, result.invoice.items);
    markUnrecognized(null);
    setInvoiceStatus(isNew ? 'Счёт сохранён в реестре вместе с оригиналом.' : 'Изменения сохранены.', 'success');
    showInvoiceModal();
    renderInvoices();
    return;
  }
  if (result.status === 'duplicate_file') {
    // Этот же PDF уже сохранён (например, коллегой минутой раньше)
    showInvoiceDuplicates([result.invoice], {
      text: 'Этот PDF уже есть в реестре — второй документ не создаём.',
      allowSeparate: false
    });
    return;
  }
  if (result.status === 'duplicate_requisites') {
    showInvoiceDuplicates(result.invoices, {
      text: 'В реестре уже есть счёт с тем же поставщиком, номером и датой, но из другого файла. Это тот же счёт?',
      allowSeparate: true
    });
    return;
  }
  if (result.status === 'conflict') {
    setInvoiceStatus('Пока вы правили, счёт изменили на другом компьютере. Ваши правки не записаны.', 'error');
    showInvoiceConflict(result.invoice);
  }
}

function showInvoiceDuplicates(list, { text, allowSeparate }) {
  const box = $inv('invoice-duplicates');
  box.innerHTML = '';
  box.appendChild(el('div', { className: 'invoice-dup-text' }, text));
  const ul = el('ul');
  list.forEach((inv) => {
    const li = el('li');
    li.appendChild(el('span', {}, `${invoiceTitle(inv)} · ${inv.supplier_name}${moneyLine(inv) ? ` · ${moneyLine(inv)}` : ''} · 📎 ${inv.file_name}`));
    const open = el('button', { type: 'button', className: 'invoice-dup-open' }, 'Открыть найденный');
    open.addEventListener('click', async () => {
      if (!await closeInvoiceModal()) return;
      await openInvoice(inv.id);
    });
    li.appendChild(open);
    ul.appendChild(li);
  });
  box.appendChild(ul);
  const actions = el('div', { className: 'invoice-dup-actions' });
  if (allowSeparate) {
    const sep = el('button', { type: 'button', id: 'invoice-dup-separate' }, 'Сохранить как отдельный счёт');
    sep.addEventListener('click', () => saveInvoice({ confirmSameRequisites: true }));
    actions.appendChild(sep);
  }
  const back = el('button', { type: 'button', id: 'invoice-dup-back' }, allowSeparate ? 'Вернуться к правке' : 'Понятно');
  back.addEventListener('click', () => { box.classList.add('hidden'); box.innerHTML = ''; });
  actions.appendChild(back);
  box.appendChild(actions);
  box.classList.remove('hidden');
  box.scrollIntoView({ block: 'nearest' });
}

function showInvoiceConflict(fresh) {
  const box = $inv('invoice-duplicates');
  box.innerHTML = '';
  box.appendChild(el('div', { className: 'invoice-dup-text' },
    'Можно открыть актуальную версию (ваши правки пропадут) или скопировать нужное вручную и повторить.'));
  const actions = el('div', { className: 'invoice-dup-actions' });
  const reload = el('button', { type: 'button', id: 'invoice-conflict-reload' }, 'Открыть актуальную версию');
  reload.addEventListener('click', async () => {
    if (!await closeInvoiceModal({ force: true })) return;
    await openInvoice(fresh ? fresh.id : invoiceUi.invoice.id);
  });
  actions.appendChild(reload);
  box.appendChild(actions);
  box.classList.remove('hidden');
}

async function deleteInvoice() {
  const inv = invoiceUi.invoice;
  if (!inv || invoiceUi.busy) return;
  if (!await confirmModal(`Удалить «${invoiceTitle(inv)}» от ${inv.supplier_name} вместе с оригиналом PDF? Отменить это нельзя.`)) return;
  try {
    handleApiErrorLocally('invoices:remove');
    await window.api.invoices.remove(inv.id);
  } catch (err) {
    setInvoiceStatus(`Не удалено: ${err.message}`, 'error');
    return;
  }
  await closeInvoiceModal({ force: true });
  showToast('Счёт удалён', 'success', 4000);
  renderInvoices();
}

// ------------------------------------------------------------
// Привязка событий
// ------------------------------------------------------------

(function initInvoices() {
  $inv('invoices-upload-btn').addEventListener('click', startInvoiceUpload);
  $inv('invoices-search-input').addEventListener('input', applyInvoicesFilter);
  $inv('invoices-search-clear').addEventListener('click', () => { $inv('invoices-search-input').value = ''; applyInvoicesFilter(); });
  $inv('invoice-add-item').addEventListener('click', () => { addInvoiceItemRow({}, { focus: true }); updateInvoiceWarnings(); });
  $inv('invoice-form').addEventListener('input', (e) => {
    if (e.target.tagName === 'TEXTAREA' && e.target.dataset.col) autosize(e.target);
    if (e.target.classList.contains('unrecognized') && e.target.value.trim()) e.target.classList.remove('unrecognized');
    updateInvoiceWarnings();
  });
  // Число после правки — сразу в привычном виде («1234.5» → «1 234,5»)
  $inv('invoice-form').addEventListener('change', (e) => {
    if (!e.target.dataset.num) return;
    const v = InvoiceMath.parseDecimal(e.target.value);
    if (v !== null) e.target.value = fmtNum(v);
  });
  $inv('invoice-form').addEventListener('submit', (e) => e.preventDefault());
  $inv('invoice-save-btn').addEventListener('click', () => saveInvoice());
  $inv('invoice-cancel-btn').addEventListener('click', () => closeInvoiceModal());
  $inv('invoice-edit-btn').addEventListener('click', () => {
    invoiceUi.mode = 'edit';
    setInvoiceStatus(null);
    showInvoiceModal();
  });
  $inv('invoice-delete-btn').addEventListener('click', deleteInvoice);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || $inv('invoice-modal').classList.contains('hidden')) return;
    // Служебные диалоги поверх карточки обрабатывают Escape сами
    if (['confirm-modal', 'alert-modal', 'prompt-modal'].some((id) => !$inv(id).classList.contains('hidden'))) return;
    closeInvoiceModal();
  });
  renderInvoices();
}());
