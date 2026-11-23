// bitrixSetup.js — окно «Настроить Битрикс24» (задача #11).
//
// Адрес портала → «Открыть Битрикс24» (раздел «Разработчикам») → пользователь создаёт
// входящий вебхук → вставляет ссылку → «Проверить доступ» → «Сохранить». Всё выполняет
// главный процесс (src/main/bitrixSetup.js); ссылка вебхука из этого окна уходит только
// на проверку и обратно не приходит. «Сохранить» активна лишь после успешной проверки и
// пока поля не менялись с её момента.

const bitrixSetupUi = {
  status: null,   // ответ bitrixSetup:status
  checkId: null,  // идентификатор успешной проверки — его и передаёт «Сохранить»
  checkedKey: '', // поля на момент проверки: правка после проверки требует новой
  seq: 0          // номер последней проверки — запоздалые ответы не учитываются
};

const bsEl = (id) => document.getElementById(id);
const bsKey = () => `${bsEl('bitrix-setup-portal').value.trim()}\n${bsEl('bitrix-setup-webhook').value.trim()}`;

function bsSetStatus(text, kind = '') {
  const el = bsEl('bitrix-setup-status');
  el.className = `bitrix-status${kind ? ` ${kind}` : ''}${text ? '' : ' hidden'}`;
  el.textContent = text || '';
}

function bsInvalidate() {
  bitrixSetupUi.seq++;
  bitrixSetupUi.checkId = null;
  bitrixSetupUi.checkedKey = '';
  bsEl('bitrix-setup-save').disabled = true;
  bsEl('bitrix-setup-check').disabled = false;
  const box = bsEl('bitrix-setup-result');
  box.innerHTML = '';
  box.classList.add('hidden');
}

function bsRenderCurrent(st) {
  const cur = bsEl('bitrix-setup-current');
  if (st.mode === 'client') {
    cur.className = 'bitrix-status';
    cur.textContent = 'Это рабочее место подключено к базе по сети.';
    return;
  }
  if (st.configured) {
    cur.className = 'bitrix-status success';
    cur.textContent = `Сейчас подключено к порталу ${st.domain}. Новая проверенная ссылка заменит текущую, остальные настройки файла сохранятся.`;
  } else if (st.error) {
    cur.className = 'bitrix-status warning';
    cur.textContent = `Файл настройки есть, но не работает: ${st.error}`;
  } else {
    cur.className = 'bitrix-status';
    cur.textContent = 'Битрикс24 ещё не подключён.';
  }
  if (st.targetPath) {
    cur.textContent += ` Файл: ${st.targetPath}${st.envOverride ? ' (задан переменной NM_BITRIX_CONFIG)' : ''}.`;
  }
}

async function openBitrixSetup() {
  bsInvalidate();
  bsSetStatus('');
  bsEl('bitrix-setup-webhook').value = '';
  let st;
  try {
    handleApiErrorLocally('bitrixSetup:status');
    st = await window.api.bitrixSetup.status();
  } catch (err) {
    showToast(`Окно настройки не открылось: ${err.message}`);
    return;
  }
  bitrixSetupUi.status = st;
  bsRenderCurrent(st);
  const client = st.mode === 'client';
  bsEl('bitrix-setup-body').classList.toggle('hidden', client);
  bsEl('bitrix-setup-check').classList.toggle('hidden', client);
  bsEl('bitrix-setup-save').classList.toggle('hidden', client);
  const clientBox = bsEl('bitrix-setup-client');
  clientBox.classList.toggle('hidden', !client);
  if (client) {
    clientBox.textContent = st.sourceKind === 'server'
      ? `База хранится на выделенном сервере (${st.remoteHost}), и подключение к Битрикс24 настраивается на нём: ` +
        'положите файл bitrix.yml с полем webhook_url в папку данных сервера (в Docker — ./data/bitrix.yml рядом с ' +
        'docker-compose.yml, это /data в контейнере) или укажите путь переменной NM_BITRIX_CONFIG. Подробно — в README, ' +
        'раздел «Карточки пользователей из Битрикс24». Перезапуск сервера не нужен.'
      : `База хранится на компьютере-хосте (${st.remoteHost}). Откройте «Настроить Битрикс24» в приложении на хосте — ` +
        'настройка сразу заработает и у клиентов.';
  } else {
    bsEl('bitrix-setup-portal').value = st.domain || '';
  }
  bsEl('bitrix-setup-modal').classList.remove('hidden');
  (client ? bsEl('bitrix-setup-close') : bsEl('bitrix-setup-portal')).focus();
}

function closeBitrixSetup() {
  bitrixSetupUi.seq++;
  bitrixSetupUi.checkId = null;
  bsEl('bitrix-setup-webhook').value = ''; // ключ не держим в поле дольше нужного
  bsEl('bitrix-setup-modal').classList.add('hidden');
}

function bsRenderResult(r) {
  const box = bsEl('bitrix-setup-result');
  box.innerHTML = '';
  const title = document.createElement('div');
  title.textContent = `Портал ${r.domain}: чтение пользователей — ${r.readUsers ? 'доступно' : 'нет'}.`;
  box.appendChild(title);
  const ul = document.createElement('ul');
  const LABELS = { EMAIL: 'Email (EMAIL)', WORK_PHONE: 'Рабочий телефон (WORK_PHONE)', UF_WEB_SITES: 'Другие сайты — номер ПК (UF_WEB_SITES)' };
  Object.entries(r.fields).forEach(([k, v]) => {
    const li = document.createElement('li');
    li.className = v === true ? 'ok' : (v === false ? 'bad' : 'unknown');
    li.textContent = `${v === true ? '✓' : (v === false ? '✗' : '?')} ${LABELS[k] || k} — ${v === true ? 'поле доступно' : (v === false ? 'недоступно' : 'не проверено')}`;
    ul.appendChild(li);
  });
  box.appendChild(ul);
  const note = document.createElement('div');
  note.className = 'bitrix-setup-hint';
  note.textContent = 'Доступность поля не значит, что оно заполнено у каждого сотрудника: это видно в предпросмотре конкретной карточки.';
  box.appendChild(note);
  if (r.scopes && r.scopes.length) {
    const sc = document.createElement('div');
    sc.className = 'bitrix-setup-hint';
    sc.textContent = `Права вебхука: ${r.scopes.join(', ')}.`;
    box.appendChild(sc);
  }
  box.classList.remove('hidden');
}

async function bitrixSetupCheck() {
  const seq = ++bitrixSetupUi.seq;
  bitrixSetupUi.checkId = null;
  bsEl('bitrix-setup-save').disabled = true;
  bsEl('bitrix-setup-check').disabled = true;
  bsEl('bitrix-setup-result').classList.add('hidden');
  const key = bsKey();
  bsSetStatus('Проверяю доступ…');
  try {
    handleApiErrorLocally('bitrixSetup:check');
    const r = await window.api.bitrixSetup.check(bsEl('bitrix-setup-portal').value, bsEl('bitrix-setup-webhook').value);
    if (seq !== bitrixSetupUi.seq) return;
    bsRenderResult(r);
    if (r.canSave && bsKey() === key) {
      bitrixSetupUi.checkId = r.checkId;
      bitrixSetupUi.checkedKey = key;
      bsEl('bitrix-setup-save').disabled = false;
      bsSetStatus(['Доступ есть. Нажмите «Сохранить», чтобы применить.', ...r.warnings].join(' '), r.warnings.length ? 'warning' : 'success');
    } else {
      bsSetStatus([...r.problems, ...r.warnings].join(' ') || 'Сохранить нельзя.', 'error');
    }
  } catch (err) {
    if (seq !== bitrixSetupUi.seq) return;
    bsSetStatus(`${err.message} Действующая настройка не изменена.`, 'error');
  } finally {
    if (seq === bitrixSetupUi.seq) bsEl('bitrix-setup-check').disabled = false;
  }
}

async function bitrixSetupSave() {
  const checkId = bitrixSetupUi.checkId;
  if (!checkId || bsKey() !== bitrixSetupUi.checkedKey) {
    bsInvalidate();
    bsSetStatus('Поля изменились после проверки — нажмите «Проверить доступ» ещё раз.', 'error');
    return;
  }
  bsEl('bitrix-setup-save').disabled = true;
  bsEl('bitrix-setup-check').disabled = true;
  try {
    handleApiErrorLocally('bitrixSetup:save');
    const r = await window.api.bitrixSetup.save(checkId);
    bitrixSetupUi.checkId = null;
    bsEl('bitrix-setup-webhook').value = '';
    bsSetStatus(r.applied
      ? `Сохранено в ${r.path}. Подключение к порталу ${r.domain} работает сразу, перезапуск не нужен.`
      : `Записано в ${r.path}, но приложение читает настройку из другого места — проверьте NM_BITRIX_CONFIG.`, r.applied ? 'success' : 'warning');
    const st = await window.api.bitrixSetup.status();
    bitrixSetupUi.status = st;
    bsRenderCurrent(st);
  } catch (err) {
    bsSetStatus(err.message, 'error');
  } finally {
    bsEl('bitrix-setup-check').disabled = false;
  }
}

async function bitrixSetupOpenPortal() {
  try {
    handleApiErrorLocally('bitrixSetup:openPortal');
    const r = await window.api.bitrixSetup.openPortal(bsEl('bitrix-setup-portal').value);
    bsEl('bitrix-setup-portal').value = r.host;
    bsSetStatus(`Открыт раздел «Разработчикам» портала ${r.host} в браузере.`);
  } catch (err) {
    bsSetStatus(err.message, 'error');
  }
}

(function initBitrixSetup() {
  bsEl('bitrix-setup-open-btn').addEventListener('click', openBitrixSetup);
  bsEl('bitrix-setup-from-sync-btn').addEventListener('click', openBitrixSetup);
  bsEl('bitrix-setup-open-portal').addEventListener('click', bitrixSetupOpenPortal);
  bsEl('bitrix-setup-check').addEventListener('click', bitrixSetupCheck);
  bsEl('bitrix-setup-save').addEventListener('click', bitrixSetupSave);
  bsEl('bitrix-setup-close').addEventListener('click', closeBitrixSetup);
  ['bitrix-setup-portal', 'bitrix-setup-webhook'].forEach((id) => {
    bsEl(id).addEventListener('input', () => {
      if (bitrixSetupUi.checkId || !bsEl('bitrix-setup-result').classList.contains('hidden')) {
        bsInvalidate();
        bsSetStatus('Поля изменились — проверьте доступ заново.');
      }
    });
  });
  bsEl('bitrix-setup-modal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeBitrixSetup(); }
  });
}());
