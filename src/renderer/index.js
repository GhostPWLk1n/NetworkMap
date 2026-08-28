// ============================================================
// Табы
// ============================================================

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });
}

// ============================================================
// Общие хелперы статуса пинга (используются и на листе БД, и на плане)
// ============================================================

function pingColor(status) {
  if (status === 'online') return '#4caf50';
  if (status === 'offline') return '#e53935';
  if (status === 'timeout') return '#ff9800';
  return '#bbb'; // ещё не пинговали
}

function pingStatusLabel(status) {
  if (status === 'online') return '🟢 online';
  if (status === 'offline') return '🔴 offline';
  if (status === 'timeout') return '🟠 timeout';
  return '⚪ ещё не пинговали';
}

// Словари подписей типов — используются и в инспекторе плана, и на листах Склад/ПО,
// и в формах добавления, поэтому объявлены здесь, до первого использования (TDZ!).
const COMPONENT_TYPE_LABELS = { motherboard: 'плата', cpu: 'CPU', ram: 'RAM', disk: 'диск', gpu: 'видео', psu: 'БП', other: 'др.' };
const PERIPHERAL_TYPE_LABELS = { monitor: 'монитор', ups: 'ИБП', keyboard: 'клавиатура', mouse: 'мышь', other: 'др.' };
const SOFTWARE_TYPE_LABELS = { os: 'ОС', office: 'офис', antivirus: 'антивирус', other: 'др.' };

// Статусы — везде на русском в интерфейсе; в БД и в value <select> остаются английские
// ключи (менять хранимые данные ради перевода не нужно, меняется только подпись).
const DEVICE_STATUS_LABELS = { active: 'Активный', repair: 'Ремонт', storage: 'На складе', decommissioned: 'Списано' };
const USER_STATUS_LABELS = { active: 'Активен', dismissed: 'Уволен(а)' };

// Ручные пометки — доступны у пользователей, устройств, складских позиций и ПО.
// null/undefined = нет пометки. Автоматически определяемые конфликты (напр. устройство
// закреплено за уволенным сотрудником) используют тот же словарь для отображения.
const FLAG_LABELS = { problem: '🟠 Проблема', attention: '🟡 Внимание', error: '🔴 Ошибка' };
const FLAG_ORDER = ['problem', 'attention', 'error'];

function flagBadge(flag, autoReason) {
  if (!flag) return null;
  const span = document.createElement('span');
  span.className = `flag-badge flag-${flag}`;
  span.textContent = FLAG_LABELS[flag] || flag;
  if (autoReason) { span.title = autoReason; span.classList.add('flag-auto'); }
  return span;
}

/** Пункты контекстного меню для смены пометки — переиспользуется карточками
 *  пользователей/устройств/склада/ПО, чтобы не дублировать одно и то же четыре раза. */
function flagMenuItems(currentFlag, onSetFlag) {
  const items = FLAG_ORDER.filter((f) => f !== currentFlag).map((f) => ({
    label: `Пометить: ${FLAG_LABELS[f]}`,
    onClick: () => onSetFlag(f)
  }));
  if (currentFlag) items.push({ label: 'Убрать пометку', onClick: () => onSetFlag(null) });
  return items;
}

/** Автоматически обнаруживаемые конфликты данных — не хранятся в БД, вычисляются при
 *  отрисовке. Пока один пример: устройство закреплено за уволенным сотрудником
 *  (обычно следствие ошибки импорта или ручной правки БД в обход приложения). */
function detectDeviceConflict(d) {
  if (d.owner_user_id && d.owner_status === 'dismissed') {
    return 'Владелец уволен, но всё ещё закреплён за устройством';
  }
  return null;
}

// ============================================================
// Контекстное меню (общий helper для карточек пользователей/устройств)
// ============================================================

function showContextMenu(x, y, items) {
  const menu = document.getElementById('context-menu');
  menu.innerHTML = '';
  items.forEach((item) => {
    const li = document.createElement('li');
    li.textContent = item.label;
    if (item.danger) li.classList.add('danger');
    li.addEventListener('click', () => { hideContextMenu(); item.onClick(); });
    menu.appendChild(li);
  });
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.classList.remove('hidden');
}

function hideContextMenu() {
  document.getElementById('context-menu').classList.add('hidden');
}

document.addEventListener('click', hideContextMenu);

/** Активна ли сейчас вкладка "Планы" — используется, чтобы горячие клавиши плана
 *  (Delete/Escape) не срабатывали, когда пользователь на другом листе. */
function isPlanTabActive() {
  const btn = document.querySelector('.tab-btn.active');
  return !!btn && btn.dataset.tab === 'plan';
}

/** Печатает ли пользователь сейчас в поле ввода — чтобы Delete не удалял выделенный
 *  на плане элемент, пока человек редактирует текст в карточке (символ, а не объект). */
function isTypingInField() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** Модальный ввод текста — замена window.prompt(), который в Electron не гарантированно
 *  показывает нативный диалог (в отличие от alert/confirm) и может тихо вернуть null. */
function promptModal(title, defaultValue = '') {
  return new Promise((resolve) => {
    const overlay = document.getElementById('prompt-modal');
    const input = document.getElementById('prompt-modal-input');
    const okBtn = document.getElementById('prompt-modal-ok');
    const cancelBtn = document.getElementById('prompt-modal-cancel');

    document.getElementById('prompt-modal-title').textContent = title;
    input.value = defaultValue;
    overlay.classList.remove('hidden');
    input.focus();
    input.select();

    const cleanup = (result) => {
      overlay.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKeydown);
      resolve(result);
    };
    const onOk = () => cleanup(input.value.trim() || null);
    const onCancel = () => cleanup(null);
    const onKeydown = (e) => {
      if (e.key === 'Enter') onOk();
      if (e.key === 'Escape') onCancel();
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKeydown);
  });
}

// ============================================================
// Каркас поиска с расширенными фильтрами (общий для листов Пользователи/Устройства)
// ============================================================

/** Навешивает обработчики на строку поиска с тумблерами (Аа/*) и кнопку расширенных фильтров.
 *  onChange(state) вызывается при любом изменении текста/тумблеров — расширенные фильтры
 *  вызывают onChange самостоятельно (их поля специфичны для каждого листа). */
function bindSearchBar(prefix, onChange) {
  const input = document.getElementById(`${prefix}-search-input`);
  const clearBtn = document.getElementById(`${prefix}-search-clear`);
  const caseBtn = document.getElementById(`${prefix}-search-case`);
  const wildcardBtn = document.getElementById(`${prefix}-search-wildcard`);
  const advToggle = document.getElementById(`${prefix}-search-advanced-toggle`);
  const advPanel = document.getElementById(`${prefix}-search-advanced`);

  const state = { query: '', caseSensitive: false, wildcard: false };

  input.addEventListener('input', () => { state.query = input.value; onChange(state); });
  clearBtn.addEventListener('click', () => { input.value = ''; state.query = ''; onChange(state); });
  caseBtn.addEventListener('click', () => {
    state.caseSensitive = !state.caseSensitive;
    caseBtn.classList.toggle('active', state.caseSensitive);
    onChange(state);
  });
  wildcardBtn.addEventListener('click', () => {
    state.wildcard = !state.wildcard;
    wildcardBtn.classList.toggle('active', state.wildcard);
    onChange(state);
  });
  advToggle.addEventListener('click', () => {
    const willShow = advPanel.classList.contains('hidden');
    advPanel.classList.toggle('hidden', !willShow);
    advToggle.classList.toggle('active', willShow);
  });

  return state;
}

function smallListNote(text) {
  const d = document.createElement('div');
  d.className = 'inspector-empty-note';
  d.textContent = text;
  return d;
}

// ============================================================
// Лист «Пользователи»
// ============================================================

let usersCache = [];
let usersSearchState;

async function renderUsers() {
  usersCache = await window.api.users.list();
  applyUsersFilter();
}

function applyUsersFilter() {
  const state = usersSearchState || { query: '', caseSensitive: false, wildcard: false };
  const deptFilterEl = document.getElementById('users-filter-department');
  const deptFilter = deptFilterEl ? deptFilterEl.value.trim().toLowerCase() : '';
  const showDismissedEl = document.getElementById('users-filter-show-dismissed');
  const showDismissed = showDismissedEl ? showDismissedEl.checked : false;
  const query = (state.query || '').trim();

  const filtered = usersCache.filter((u) => {
    const haystack = [u.full_name, u.department, u.position, u.email, u.phone, u.notes].filter(Boolean).join(' ');
    const matchesText = !query || matchesQuery(haystack, query, state);
    const matchesDept = !deptFilter || (u.department || '').toLowerCase().includes(deptFilter);
    const isHiddenByDefault = u.status === 'dismissed' && !showDismissed;
    return matchesText && matchesDept && !isHiddenByDefault;
  });

  const container = document.getElementById('user-cards');
  container.innerHTML = '';
  if (filtered.length === 0) { container.appendChild(smallListNote('Ничего не найдено')); return; }
  filtered.forEach((u) => container.appendChild(buildUserCard(u)));
}

function buildUserCard(u) {
  const row = document.createElement('div');
  row.className = 'card-row';
  row.dataset.userId = u.id;
  if (u.status === 'dismissed') row.classList.add('status-removed');

  const header = document.createElement('div');
  header.className = 'card-row-header';
  const title = document.createElement('span');
  title.className = 'card-title';
  title.textContent = u.full_name;
  const subtitle = document.createElement('span');
  subtitle.className = 'card-subtitle';
  subtitle.textContent = [u.department, u.status === 'dismissed' ? USER_STATUS_LABELS.dismissed : null].filter(Boolean).join(' · ');
  const badge = flagBadge(u.flag);
  const chevron = document.createElement('span');
  chevron.className = 'card-chevron';
  chevron.textContent = '▸';
  header.append(title, subtitle);
  if (badge) header.appendChild(badge);
  header.appendChild(chevron);
  header.addEventListener('click', () => row.classList.toggle('expanded'));
  header.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Редактировать', onClick: () => row.classList.add('expanded') },
      ...flagMenuItems(u.flag, async (flag) => {
        const updated = await window.api.users.setFlag(u.id, flag);
        u.flag = updated.flag;
        renderUsers();
      }),
      {
        label: 'Удалить', danger: true, onClick: async () => {
          if (!confirm(`Удалить пользователя «${u.full_name}»?`)) return;
          await window.api.users.remove(u.id);
          renderUsers();
          fillUserDragList();
        }
      }
    ]);
  });

  const body = document.createElement('div');
  body.className = 'card-body';
  const form = document.createElement('form');
  form.innerHTML = `
    <label>ФИО <input name="full_name" required /></label>
    <label>Отдел <input name="department" /></label>
    <label>Должность <input name="position" /></label>
    <label>Email <input name="email" type="email" /></label>
    <label>Телефон <input name="phone" /></label>
    <label class="span-2">Заметки <input name="notes" /></label>
  `;
  form.full_name.value = u.full_name || '';
  form.department.value = u.department || '';
  form.position.value = u.position || '';
  form.email.value = u.email || '';
  form.phone.value = u.phone || '';
  form.notes.value = u.notes || '';

  const actions = document.createElement('div');
  actions.className = 'card-body-actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.textContent = 'Сохранить';
  const statusToggleBtn = document.createElement('button');
  statusToggleBtn.type = 'button';
  statusToggleBtn.textContent = u.status === 'dismissed' ? '♻️ Восстановить в правах' : '🚪 Уволить';
  statusToggleBtn.onclick = async () => {
    const newStatus = u.status === 'dismissed' ? 'active' : 'dismissed';
    if (newStatus === 'dismissed' && !confirm(`Отметить «${u.full_name}» как уволенного? Карточка скроется из общего списка (её можно будет включить обратно через «показать уволенных»).`)) return;
    const updated = await window.api.users.setStatus(u.id, newStatus);
    Object.assign(u, updated);
    fillUserDragList();
    applyUsersFilter(); // карточка либо перекрасится, либо пропадёт из выдачи — проще перерисовать список
    syncPlanOwnerStatus(u.id, u.status);
  };
  const statusNote = document.createElement('span');
  statusNote.className = 'status-note';
  actions.append(saveBtn, statusToggleBtn, statusNote);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const updated = await window.api.users.update(u.id, {
      full_name: fd.get('full_name'),
      department: fd.get('department') || null,
      position: fd.get('position') || null,
      email: fd.get('email') || null,
      phone: fd.get('phone') || null,
      notes: fd.get('notes') || null
    });
    Object.assign(u, updated);
    title.textContent = u.full_name;
    subtitle.textContent = [u.department, u.status === 'dismissed' ? USER_STATUS_LABELS.dismissed : null].filter(Boolean).join(' · ');
    statusNote.textContent = 'Сохранено ✓';
    setTimeout(() => { statusNote.textContent = ''; }, 2000);
    fillUserDragList(); // карман на плане должен увидеть переименование
    syncPlanOwnerName(u.id, u.full_name); // и подпись владельца на иконках устройств на плане
  });

  form.appendChild(actions);
  body.appendChild(form);
  row.append(header, body);
  return row;
}

document.getElementById('user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  await window.api.users.create({
    full_name: form.get('full_name'),
    department: form.get('department') || null
  });
  e.target.reset();
  document.getElementById('user-add-form-wrap').removeAttribute('open');
  renderUsers();
  fillUserDragList();
});

usersSearchState = bindSearchBar('users', applyUsersFilter);
document.getElementById('users-filter-department').addEventListener('input', applyUsersFilter);
document.getElementById('users-filter-show-dismissed').addEventListener('change', applyUsersFilter);

// ============================================================
// Лист «Устройства»
// ============================================================

let devicesCache = [];
let devicesSearchState;

let deviceEquipmentIndex = new Map(); // device.id -> "GPU RTX 4090 монитор Dell..." — для поиска по установленному оборудованию

async function renderDevices() {
  const [list, components, peripherals, software] = await Promise.all([
    window.api.devices.list(),
    window.api.components.listAllActive(),
    window.api.peripherals.listAllActive(),
    window.api.software.listActive()
  ]);
  devicesCache = list;

  deviceEquipmentIndex = new Map();
  const suggestions = new Set();
  const addToIndex = (deviceId, text) => {
    if (!text) return;
    const prev = deviceEquipmentIndex.get(deviceId);
    deviceEquipmentIndex.set(deviceId, prev ? `${prev} ${text}` : text);
  };
  devicesCache.forEach((d) => {
    if (d.hostname) suggestions.add(d.hostname);
    if (d.owner_name) suggestions.add(d.owner_name);
    if (d.inventory_number) suggestions.add(d.inventory_number);
  });
  components.forEach((c) => {
    addToIndex(c.device_id, `${COMPONENT_TYPE_LABELS[c.component_type] || c.component_type} ${c.description}`);
    if (c.description) suggestions.add(c.description);
  });
  peripherals.forEach((p) => {
    addToIndex(p.device_id, `${PERIPHERAL_TYPE_LABELS[p.peripheral_type] || p.peripheral_type} ${p.description}`);
    if (p.description) suggestions.add(p.description);
  });
  software.forEach((s) => {
    addToIndex(s.device_id, `${SOFTWARE_TYPE_LABELS[s.software_type] || s.software_type} ${s.name} ${s.license_key || ''}`);
    if (s.name) suggestions.add(s.name);
    if (s.license_key) suggestions.add(s.license_key);
  });

  // Автодополнение — реальные значения из данных (hostname, владельцы, комплектующие,
  // периферия, ПО, лицензионные ключи), не история запросов
  const datalist = document.getElementById('devices-search-datalist');
  datalist.innerHTML = '';
  [...suggestions].sort((a, b) => a.localeCompare(b, 'ru')).forEach((value) => {
    const opt = document.createElement('option');
    opt.value = value;
    datalist.appendChild(opt);
  });

  applyDevicesFilter();
}

function applyDevicesFilter() {
  const state = devicesSearchState || { query: '', caseSensitive: false, wildcard: false };
  const typeFilterEl = document.getElementById('devices-filter-type');
  const statusFilterEl = document.getElementById('devices-filter-status');
  const showDecommissionedEl = document.getElementById('devices-filter-show-decommissioned');
  const noOwnerEl = document.getElementById('devices-filter-no-owner');
  const typeFilter = typeFilterEl ? typeFilterEl.value : '';
  const statusFilter = statusFilterEl ? statusFilterEl.value : '';
  const showDecommissioned = showDecommissionedEl ? showDecommissionedEl.checked : false;
  const noOwnerOnly = noOwnerEl ? noOwnerEl.checked : false;
  const query = (state.query || '').trim();

  // Знаменатель счётчика — сколько устройств вообще доступно при текущих
  // фильтрах типа/статуса (без учёта текстового запроса); числитель — после него
  const eligible = devicesCache.filter((d) => {
    const matchesType = !typeFilter || d.device_type === typeFilter;
    const matchesStatus = !statusFilter || d.status === statusFilter;
    const matchesOwner = !noOwnerOnly || !d.owner_user_id;
    const isHiddenByDefault = d.status === 'decommissioned' && !showDecommissioned && statusFilter !== 'decommissioned';
    return matchesType && matchesStatus && matchesOwner && !isHiddenByDefault;
  });
  const filtered = eligible.filter((d) => {
    const haystack = [d.hostname, d.primary_ip, d.inventory_number, d.device_type, d.owner_name, d.notes, deviceEquipmentIndex.get(d.id)]
      .filter(Boolean).join(' ');
    return !query || matchesQuery(haystack, query, state);
  });

  const countEl = document.getElementById('devices-search-count');
  if (countEl) countEl.textContent = `${filtered.length} из ${eligible.length}`;

  const container = document.getElementById('device-cards');
  container.innerHTML = '';
  if (filtered.length === 0) { container.appendChild(smallListNote('Ничего не найдено')); return; }
  filtered.forEach((d) => container.appendChild(buildDeviceCard(d)));
}

const DEVICE_TYPE_OPTIONS = ['computer', 'laptop', 'server', 'vm', 'router', 'switch', 'printer', 'other'];
const DEVICE_STATUS_OPTIONS = ['active', 'repair', 'storage', 'decommissioned'];

function buildDeviceCard(d) {
  const row = document.createElement('div');
  row.className = 'card-row';
  row.dataset.deviceId = d.id;
  if (d.status === 'decommissioned') row.classList.add('status-removed');
  else if (d.status === 'repair') row.classList.add('status-repair');
  else if (d.status === 'storage') row.classList.add('status-storage');

  const conflictReason = detectDeviceConflict(d);
  const effectiveFlag = conflictReason ? 'attention' : d.flag;

  const header = document.createElement('div');
  header.className = 'card-row-header';
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  dot.style.background = pingColor(d.last_ping_status);
  const title = document.createElement('span');
  title.className = 'card-title';
  title.textContent = d.hostname || '(без имени)';
  const subtitle = document.createElement('span');
  subtitle.className = 'card-subtitle';
  subtitle.textContent = [d.device_type, d.primary_ip, d.owner_name, DEVICE_STATUS_LABELS[d.status] && d.status !== 'active' ? DEVICE_STATUS_LABELS[d.status] : null]
    .filter(Boolean).join(' · ');
  const badge = flagBadge(effectiveFlag, conflictReason);
  const chevron = document.createElement('span');
  chevron.className = 'card-chevron';
  chevron.textContent = '▸';
  header.append(dot, title, subtitle);
  if (badge) header.appendChild(badge);
  header.appendChild(chevron);
  header.addEventListener('click', () => {
    row.classList.toggle('expanded');
    if (row.classList.contains('expanded') && !extrasLoaded) {
      extrasLoaded = true;
      refreshExtras();
    }
  });
  header.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Редактировать', onClick: () => row.classList.add('expanded') },
      { label: '📍 Найти на плане', onClick: () => findDeviceOnPlan(d.id) },
      ...flagMenuItems(d.flag, async (flag) => {
        const updated = await window.api.devices.setFlag(d.id, flag);
        d.flag = updated.flag;
        renderDevices();
        syncPlanDeviceIcon(d.id, { device_flag: updated.flag });
      }),
      {
        label: 'Удалить', danger: true, onClick: async () => {
          if (!confirm(`Удалить устройство «${d.hostname}»?`)) return;
          await window.api.devices.remove(d.id);
          renderDevices();
          fillDevicePicker();
        }
      }
    ]);
  });

  const body = document.createElement('div');
  body.className = 'card-body';
  const form = document.createElement('form');
  form.innerHTML = `
    <label>Тип <select name="device_type">${DEVICE_TYPE_OPTIONS.map((t) => `<option value="${t}">${t}</option>`).join('')}</select></label>
    <label>Статус <select name="status">${DEVICE_STATUS_OPTIONS.map((s) => `<option value="${s}">${DEVICE_STATUS_LABELS[s]}</option>`).join('')}</select></label>
    <label>Hostname <input name="hostname" required /></label>
    <label>Инв. номер <input name="inventory_number" /></label>
    <label>IP-адрес <input name="ip_address" /></label>
    <label>MAC-адрес <input name="mac_address" /></label>
    <label class="span-2">Заметки <input name="notes" /></label>
  `;
  form.device_type.value = d.device_type;
  form.status.value = d.status || 'active';
  form.hostname.value = d.hostname || '';
  form.inventory_number.value = d.inventory_number || '';
  form.ip_address.value = d.primary_ip || '';
  form.mac_address.value = d.primary_mac || '';
  form.notes.value = d.notes || '';

  const actions = document.createElement('div');
  actions.className = 'card-body-actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.textContent = 'Сохранить';
  const findBtn = document.createElement('button');
  findBtn.type = 'button';
  findBtn.textContent = '📍 Найти на плане';
  findBtn.onclick = () => findDeviceOnPlan(d.id);
  const pingBtn = document.createElement('button');
  pingBtn.type = 'button';
  pingBtn.textContent = 'Пинговать';
  const serviceBtn = document.createElement('button');
  serviceBtn.type = 'button';
  serviceBtn.textContent = '🔧 Сервис';
  serviceBtn.title = 'Отправить на сервисное обслуживание';
  const lifecycleBtn = document.createElement('button');
  lifecycleBtn.type = 'button';
  lifecycleBtn.textContent = d.status === 'decommissioned' ? '♻️ Восстановить в правах' : '🗑 Списать';
  const statusNote = document.createElement('span');
  statusNote.className = 'status-note';

  serviceBtn.onclick = async () => {
    const note = await promptModal('Комментарий к отправке в сервис (необязательно)', '');
    const updated = await window.api.devices.setStatus(d.id, 'repair', note);
    Object.assign(d, updated);
    statusNote.textContent = 'Отправлено в сервис ✓';
    applyDevicesFilter(); // перерисовываем список целиком — подсветка "ремонт" должна появиться сразу
    syncPlanDeviceIcon(d.id, { device_status: 'repair' });
  };

  lifecycleBtn.onclick = async () => {
    const newStatus = d.status === 'decommissioned' ? 'active' : 'decommissioned';
    if (newStatus === 'decommissioned') {
      if (!confirm(`Списать «${d.hostname}»? Карточка скроется из общего списка (её можно будет включить обратно через «показать списанные»).`)) return;
      const note = await promptModal('Комментарий к списанию (необязательно)', '');
      const updated = await window.api.devices.setStatus(d.id, 'decommissioned', note);
      Object.assign(d, updated);
    } else {
      const updated = await window.api.devices.setStatus(d.id, 'active');
      Object.assign(d, updated);
    }
    fillDevicePicker();
    applyDevicesFilter(); // карточка либо перекрасится, либо пропадёт из выдачи — проще перерисовать список
    syncPlanDeviceIcon(d.id, { device_status: d.status });
  };

  pingBtn.onclick = async () => {
    if (!d.primary_ip) { statusNote.textContent = 'Нет IP'; return; }
    statusNote.textContent = '...';
    const result = await window.api.ping.run(d.id, d.primary_ip);
    statusNote.textContent = `${result.status}${result.responseTimeMs ? ' (' + result.responseTimeMs + ' ms)' : ''}`;
    dot.style.background = pingColor(result.status);
    updatePingBadgeByDeviceId(d.id, result.status);
  };

  actions.append(saveBtn, findBtn, pingBtn, serviceBtn, lifecycleBtn, statusNote);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const payload = {
      device_type: fd.get('device_type'),
      hostname: fd.get('hostname'),
      inventory_number: fd.get('inventory_number') || null,
      status: fd.get('status'),
      notes: fd.get('notes') || null,
      ip_address: fd.get('ip_address') || null,
      mac_address: fd.get('mac_address') || null
    };
    const updated = await window.api.devices.update(d.id, payload);
    Object.assign(d, updated);
    d.primary_ip = payload.ip_address;
    d.primary_mac = payload.mac_address;
    title.textContent = d.hostname || '(без имени)';
    subtitle.textContent = [d.device_type, d.primary_ip, d.owner_name, d.status !== 'active' ? DEVICE_STATUS_LABELS[d.status] : null]
      .filter(Boolean).join(' · ');
    row.classList.remove('status-removed', 'status-repair', 'status-storage');
    if (d.status === 'decommissioned') row.classList.add('status-removed');
    else if (d.status === 'repair') row.classList.add('status-repair');
    else if (d.status === 'storage') row.classList.add('status-storage');
    statusNote.textContent = 'Сохранено ✓';
    setTimeout(() => { statusNote.textContent = ''; }, 2000);
    fillDevicePicker(); // список устройств для плана должен увидеть переименование
    syncPlanDeviceIcon(d.id, {
      device_type: updated.device_type,
      device_hostname: updated.hostname,
      device_ip: payload.ip_address,
      device_status: updated.status
    });
  });

  form.appendChild(actions);
  body.appendChild(form);

  const extras = document.createElement('div');
  extras.className = 'device-card-extras';
  extras.textContent = 'Загрузка…';
  body.appendChild(extras);
  let extrasLoaded = false;
  let refreshExtras;
  refreshExtras = () => renderDeviceExtras(extras, d.id, refreshExtras);

  row.append(header, body);
  return row;
}

document.getElementById('device-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  await window.api.devices.create({
    device_type: form.get('device_type'),
    hostname: form.get('hostname'),
    ip_address: form.get('ip_address') || null
  });
  e.target.reset();
  document.getElementById('device-add-form-wrap').removeAttribute('open');
  renderDevices();
  fillDevicePicker();
});

devicesSearchState = bindSearchBar('devices', applyDevicesFilter);
document.getElementById('devices-filter-type').addEventListener('change', applyDevicesFilter);
document.getElementById('devices-filter-status').addEventListener('change', applyDevicesFilter);
document.getElementById('devices-filter-show-decommissioned').addEventListener('change', applyDevicesFilter);
document.getElementById('devices-filter-no-owner').addEventListener('change', applyDevicesFilter);

/** Переключает на лист "Планы", открывает нужный этаж и выделяет иконку устройства */
async function findDeviceOnPlan(deviceId) {
  const placements = await window.api.planItems.findByDeviceRef(deviceId);
  if (placements.length === 0) {
    alert('Это устройство пока не размещено ни на одном плане.');
    return;
  }
  const target = placements[0]; // на нескольких этажах сразу — берём первый найденный
  document.querySelector('.tab-btn[data-tab="plan"]').click();
  await switchFloorPlan(target.floor_plan_id);
  const node = planState.itemsById.get(target.id);
  if (node) { selectNode(node); focusOnNode(node); }
}

/** Переключает на лист "Устройства", сбрасывает фильтры (чтобы карточка точно попала в выдачу),
 *  разворачивает нужную карточку и прокручивает к ней. Используется из инспектора плана и из зон. */
function openDeviceCard(deviceId) {
  document.querySelector('.tab-btn[data-tab="devices"]').click();
  const input = document.getElementById('devices-search-input');
  input.value = '';
  if (devicesSearchState) devicesSearchState.query = '';
  document.getElementById('devices-filter-type').value = '';
  document.getElementById('devices-filter-status').value = '';
  applyDevicesFilter();
  requestAnimationFrame(() => {
    const card = document.querySelector(`#device-cards .card-row[data-device-id="${deviceId}"]`);
    if (card) { card.classList.add('expanded'); card.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  });
}

/** То же самое, но для листа "Пользователи" — используется из карточки владельца устройства */
function openUserCard(userId) {
  document.querySelector('.tab-btn[data-tab="users"]').click();
  const input = document.getElementById('users-search-input');
  input.value = '';
  if (usersSearchState) usersSearchState.query = '';
  document.getElementById('users-filter-department').value = '';
  applyUsersFilter();
  requestAnimationFrame(() => {
    const card = document.querySelector(`#user-cards .card-row[data-user-id="${userId}"]`);
    if (card) { card.classList.add('expanded'); card.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  });
}

document.getElementById('import-excel-btn').addEventListener('click', async () => {
  const btn = document.getElementById('import-excel-btn');
  const status = document.getElementById('import-status');
  const report = document.getElementById('import-report');

  btn.disabled = true;
  status.textContent = 'Импорт…';
  report.classList.add('hidden');
  report.innerHTML = '';

  try {
    const result = await window.api.importExcel.devices();
    if (!result) { status.textContent = ''; return; } // диалог отменён
    status.textContent = `Готово: добавлено ${result.imported}, уже было ${result.updated}, пропущено строк ${result.skipped}.`;

    if (result.warnings.length > 0) {
      report.classList.remove('hidden');
      const title = document.createElement('div');
      title.textContent = `Предупреждения (${result.warnings.length}) — проверьте вручную:`;
      report.appendChild(title);
      const ul = document.createElement('ul');
      result.warnings.forEach((w) => {
        const li = document.createElement('li');
        li.textContent = w;
        ul.appendChild(li);
      });
      report.appendChild(ul);
    }

    // Импорт мог добавить и устройства, и пользователей — обновляем все зависимые списки
    await Promise.all([renderUsers(), renderDevices(), fillDevicePicker(), fillUserDragList()]);
  } catch (err) {
    status.textContent = `Ошибка импорта: ${err.message || err}`;
  } finally {
    btn.disabled = false;
  }
});

// ============================================================
// Лист «Склад»
// ============================================================

let warehouseCache = [];
let warehouseSearchState;
const WAREHOUSE_STATUS_LABELS = { ordered: 'в заказе', in_stock: 'в наличии', issued: 'выдано', written_off: 'списано' };

async function renderWarehouse() {
  warehouseCache = await window.api.warehouse.list();
  applyWarehouseFilter();
}

function applyWarehouseFilter() {
  const state = warehouseSearchState || { query: '', caseSensitive: false, wildcard: false };
  const categoryFilterEl = document.getElementById('warehouse-filter-category');
  const inStockEl = document.getElementById('warehouse-filter-in-stock');
  const categoryFilter = categoryFilterEl ? categoryFilterEl.value : '';
  const inStockOnly = inStockEl ? inStockEl.checked : false;
  const query = (state.query || '').trim();

  const filtered = warehouseCache.filter((w) => {
    const haystack = [w.description, w.item_type, w.license_key, w.source_device_hostname, w.target_device_hostname, w.note]
      .filter(Boolean).join(' ');
    const matchesText = !query || matchesQuery(haystack, query, state);
    const matchesCategory = !categoryFilter || w.category === categoryFilter;
    const matchesStock = !inStockOnly || !w.removed_at;
    return matchesText && matchesCategory && matchesStock;
  });

  const container = document.getElementById('warehouse-cards');
  container.innerHTML = '';
  if (filtered.length === 0) { container.appendChild(smallListNote('Ничего не найдено')); return; }
  filtered.forEach((w) => container.appendChild(buildWarehouseCard(w)));
}

function buildWarehouseCard(w) {
  const row = document.createElement('div');
  row.className = 'card-row';
  if (w.status === 'ordered') row.classList.add('wh-status-ordered');
  else if (w.status === 'issued') row.classList.add('wh-status-issued');
  else if (w.status === 'written_off') row.classList.add('wh-status-written_off');
  const typeLabels = w.category === 'software' ? SOFTWARE_TYPE_LABELS : COMPONENT_TYPE_LABELS;

  const header = document.createElement('div');
  header.className = 'card-row-header';
  const badge = document.createElement('span');
  badge.className = 'wh-badge';
  badge.textContent = w.category === 'software' ? 'ПО' : 'деталь';
  const title = document.createElement('span');
  title.className = 'card-title';
  title.textContent = w.description;
  const subtitle = document.createElement('span');
  subtitle.className = 'card-subtitle';
  subtitle.textContent = [
    typeLabels[w.item_type] || w.item_type,
    WAREHOUSE_STATUS_LABELS[w.status] || w.status,
    w.status === 'issued' && w.target_device_hostname ? `→ «${w.target_device_hostname}»` : null
  ].filter(Boolean).join(' · ');
  const flagBadgeEl = flagBadge(w.flag);
  const chevron = document.createElement('span');
  chevron.className = 'card-chevron';
  chevron.textContent = '▸';
  header.append(badge, title, subtitle);
  if (flagBadgeEl) header.appendChild(flagBadgeEl);
  header.appendChild(chevron);
  header.addEventListener('click', () => row.classList.toggle('expanded'));
  header.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const items = [{ label: 'Редактировать', onClick: () => row.classList.add('expanded') }];
    items.push(...flagMenuItems(w.flag, async (flag) => {
      const updated = await window.api.warehouse.setFlag(w.id, flag);
      w.flag = updated.flag;
      renderWarehouse();
    }));
    if (w.status !== 'written_off') {
      items.push({
        label: 'Списать', danger: true, onClick: async () => {
          await window.api.warehouse.setStatus(w.id, 'written_off');
          renderWarehouse();
          fillWarehouseDragList();
        }
      });
    }
    items.push({
      label: 'Удалить запись безвозвратно', danger: true, onClick: async () => {
        if (!confirm(`Удалить запись «${w.description}» насовсем? Действие необратимо.`)) return;
        await window.api.warehouse.remove(w.id);
        renderWarehouse();
        fillWarehouseDragList();
      }
    });
    showContextMenu(e.clientX, e.clientY, items);
  });

  const body = document.createElement('div');
  body.className = 'card-body';
  body.appendChild(field('Категория', w.category === 'software' ? 'ПО' : 'Комплектующая'));
  body.appendChild(smallNote(
    [
      w.source_device_hostname ? `снято с «${w.source_device_hostname}»` : 'добавлено напрямую',
      w.added_at,
      w.target_device_hostname ? `→ выдано на «${w.target_device_hostname}» ${w.removed_at}` : null
    ].filter(Boolean).join(' · ')
  ));

  const form = document.createElement('form');
  const typeOptions = Object.keys(typeLabels).map((t) => `<option value="${t}">${typeLabels[t]}</option>`).join('');
  form.innerHTML = `
    <label>Тип <select name="item_type">${typeOptions}</select></label>
    <label>Статус
      <select name="status">
        <option value="ordered">в заказе</option>
        <option value="in_stock">в наличии</option>
        <option value="issued">выдано</option>
        <option value="written_off">списано</option>
      </select>
    </label>
    <label class="span-2">Описание <input name="description" required /></label>
    ${w.category === 'software' ? '<label>Лицензионный ключ <input name="license_key" /></label>' : ''}
    <label>Стоимость <input name="cost" type="number" step="0.01" min="0" /></label>
    <label class="span-2">Заметка <input name="note" /></label>
  `;
  form.item_type.value = w.item_type;
  form.status.value = w.status;
  form.description.value = w.description;
  if (form.license_key) form.license_key.value = w.license_key || '';
  form.cost.value = w.cost ?? '';
  form.note.value = w.note || '';

  const actions = document.createElement('div');
  actions.className = 'card-body-actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.textContent = 'Сохранить';
  const statusNote = document.createElement('span');
  statusNote.className = 'status-note';
  actions.append(saveBtn, statusNote);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const payload = {
      item_type: fd.get('item_type'),
      description: fd.get('description'),
      license_key: w.category === 'software' ? (fd.get('license_key') || null) : null,
      cost: fd.get('cost') ? Number(fd.get('cost')) : null,
      status: fd.get('status'),
      note: fd.get('note') || null
    };
    const updated = await window.api.warehouse.update(w.id, payload);
    Object.assign(w, updated);
    title.textContent = w.description;
    subtitle.textContent = [typeLabels[w.item_type] || w.item_type, WAREHOUSE_STATUS_LABELS[w.status] || w.status]
      .filter(Boolean).join(' · ');
    statusNote.textContent = 'Сохранено ✓';
    setTimeout(() => { statusNote.textContent = ''; }, 2000);
    fillWarehouseDragList();
    if (w.category === 'software') renderSoftwareRegistry();
  });

  form.appendChild(actions);
  body.appendChild(form);

  if (!w.removed_at && w.status !== 'written_off') {
    const issueWrap = document.createElement('div');
    issueWrap.className = 'inspector-add-form';
    const deviceSelect = document.createElement('select');
    devicesCache.filter((d) => d.status !== 'decommissioned').forEach((d) => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `[${d.device_type}] ${d.hostname}`;
      deviceSelect.appendChild(opt);
    });
    const issueBtn = document.createElement('button');
    issueBtn.type = 'button';
    issueBtn.textContent = 'Выдать на устройство';
    issueBtn.onclick = async () => {
      if (!deviceSelect.value) return;
      await window.api.warehouse.issueToDevice(w.id, Number(deviceSelect.value));
      renderWarehouse();
      fillWarehouseDragList();
      renderSoftwareRegistry();
    };
    issueWrap.append(deviceSelect, issueBtn);
    body.appendChild(issueWrap);
  }

  row.append(header, body);
  return row;
}

warehouseSearchState = bindSearchBar('warehouse', applyWarehouseFilter);
document.getElementById('warehouse-filter-category').addEventListener('change', applyWarehouseFilter);
document.getElementById('warehouse-filter-in-stock').addEventListener('change', applyWarehouseFilter);

function fillWarehouseFormItemTypes() {
  const category = document.getElementById('warehouse-form-category').value;
  const typeLabels = category === 'software' ? SOFTWARE_TYPE_LABELS : COMPONENT_TYPE_LABELS;
  const select = document.getElementById('warehouse-form-item-type');
  select.innerHTML = '';
  Object.keys(typeLabels).forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = typeLabels[t];
    select.appendChild(opt);
  });
  document.getElementById('warehouse-form-license').style.display = category === 'software' ? '' : 'none';
}

document.getElementById('warehouse-form-category').addEventListener('change', fillWarehouseFormItemTypes);
fillWarehouseFormItemTypes();

document.getElementById('warehouse-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  await window.api.warehouse.add({
    category: form.get('category'),
    item_type: form.get('item_type'),
    description: form.get('description'),
    license_key: form.get('category') === 'software' ? (form.get('license_key') || null) : null,
    cost: form.get('cost') ? Number(form.get('cost')) : null,
    status: form.get('status')
  });
  e.target.reset();
  fillWarehouseFormItemTypes();
  document.getElementById('warehouse-add-form-wrap').removeAttribute('open');
  renderWarehouse();
  fillWarehouseDragList();
  renderSoftwareRegistry();
});

// ============================================================
// Лист «ПО» — реестр действующих установок по всем устройствам
// ============================================================

let softwareCache = [];
let softwareSearchState;

async function renderSoftwareRegistry() {
  const [installed, stockSoftware] = await Promise.all([
    window.api.software.listActive(),
    window.api.warehouse.list('software')
  ]);
  softwareCache = [
    ...installed.map((s) => normalizeSoftwareEntry(s, 'device')),
    ...stockSoftware.map((w) => normalizeSoftwareEntry(w, 'warehouse'))
  ];
  applySoftwareFilter();
}

/** Приводит device_software и warehouse_items(category=software) к общей форме для одной карточки */
function normalizeSoftwareEntry(raw, source) {
  if (source === 'device') {
    return {
      source, raw, id: raw.id, type: raw.software_type, name: raw.name,
      license_key: raw.license_key, cost: raw.cost, note: raw.note, flag: raw.flag,
      device_hostname: raw.device_hostname, device_id: raw.device_id,
      statusLabel: `установлено на «${raw.device_hostname}»`
    };
  }
  return {
    source, raw, id: raw.id, type: raw.item_type, name: raw.description,
    license_key: raw.license_key, cost: raw.cost, note: raw.note, flag: raw.flag,
    device_hostname: null, device_id: null, warehouseStatus: raw.status,
    statusLabel: WAREHOUSE_STATUS_LABELS[raw.status] || raw.status
  };
}

function applySoftwareFilter() {
  const state = softwareSearchState || { query: '', caseSensitive: false, wildcard: false };
  const typeFilterEl = document.getElementById('software-filter-type');
  const typeFilter = typeFilterEl ? typeFilterEl.value : '';
  const query = (state.query || '').trim();

  const filtered = softwareCache.filter((s) => {
    const haystack = [s.name, s.license_key, s.device_hostname, s.note, s.statusLabel].filter(Boolean).join(' ');
    const matchesText = !query || matchesQuery(haystack, query, state);
    const matchesType = !typeFilter || s.type === typeFilter;
    return matchesText && matchesType;
  });

  const container = document.getElementById('software-cards');
  container.innerHTML = '';
  if (filtered.length === 0) { container.appendChild(smallListNote('Ничего не найдено')); return; }
  filtered.forEach((s) => container.appendChild(buildSoftwareCard(s)));
}

function buildSoftwareCard(s) {
  const row = document.createElement('div');
  row.className = 'card-row';
  if (s.warehouseStatus === 'ordered') row.classList.add('wh-status-ordered');
  else if (s.warehouseStatus === 'written_off') row.classList.add('wh-status-written_off');

  const header = document.createElement('div');
  header.className = 'card-row-header';
  const title = document.createElement('span');
  title.className = 'card-title';
  title.textContent = s.name;
  const subtitle = document.createElement('span');
  subtitle.className = 'card-subtitle';
  subtitle.textContent = [SOFTWARE_TYPE_LABELS[s.type] || s.type, s.statusLabel].filter(Boolean).join(' · ');
  const flagBadgeEl = flagBadge(s.flag);
  const chevron = document.createElement('span');
  chevron.className = 'card-chevron';
  chevron.textContent = '▸';
  header.append(title, subtitle);
  if (flagBadgeEl) header.appendChild(flagBadgeEl);
  header.appendChild(chevron);
  header.addEventListener('click', () => row.classList.toggle('expanded'));
  header.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const items = [{ label: 'Подробнее', onClick: () => row.classList.add('expanded') }];
    items.push(...flagMenuItems(s.flag, async (flag) => {
      const api = s.source === 'device' ? window.api.software : window.api.warehouse;
      const updated = await api.setFlag(s.id, flag);
      s.flag = updated.flag;
      renderSoftwareRegistry();
    }));
    if (s.source === 'device') {
      items.push({ label: '📍 Найти на плане', onClick: () => findDeviceOnPlan(s.device_id) });
      items.push({
        label: 'Снять и на склад', danger: true, onClick: async () => {
          if (!confirm(`Снять «${s.name}» с «${s.device_hostname}» и отправить на склад?`)) return;
          await window.api.warehouse.receiveSoftware(s.id);
          renderSoftwareRegistry();
          renderWarehouse();
          fillWarehouseDragList();
        }
      });
    } else {
      items.push({
        label: 'Удалить запись', danger: true, onClick: async () => {
          if (!confirm(`Удалить «${s.name}» со склада насовсем?`)) return;
          await window.api.warehouse.remove(s.id);
          renderSoftwareRegistry();
          renderWarehouse();
          fillWarehouseDragList();
        }
      });
    }
    showContextMenu(e.clientX, e.clientY, items);
  });

  const body = document.createElement('div');
  body.className = 'card-body';
  if (s.device_hostname) body.appendChild(field('Устройство', s.device_hostname));
  body.appendChild(field('Тип', SOFTWARE_TYPE_LABELS[s.type] || s.type));
  body.appendChild(field('Название', s.name));
  body.appendChild(field('Лицензионный ключ', s.license_key || '—'));
  body.appendChild(field('Стоимость', s.cost != null ? String(s.cost) : '—'));
  body.appendChild(field('Статус', s.statusLabel));
  if (s.note) body.appendChild(field('Заметка', s.note));

  const actions = document.createElement('div');
  actions.className = 'card-body-actions';
  if (s.source === 'device') {
    const findBtn = document.createElement('button');
    findBtn.type = 'button';
    findBtn.textContent = '📍 Найти на плане';
    findBtn.onclick = () => findDeviceOnPlan(s.device_id);
    const detachBtn = document.createElement('button');
    detachBtn.type = 'button';
    detachBtn.textContent = 'Снять и на склад';
    detachBtn.onclick = async () => {
      await window.api.warehouse.receiveSoftware(s.id);
      renderSoftwareRegistry();
      renderWarehouse();
      fillWarehouseDragList();
    };
    actions.append(findBtn, detachBtn);
  } else {
    const openWarehouseBtn = document.createElement('button');
    openWarehouseBtn.type = 'button';
    openWarehouseBtn.textContent = '📦 Открыть на складе';
    openWarehouseBtn.onclick = () => document.querySelector('.tab-btn[data-tab="warehouse"]').click();
    actions.append(openWarehouseBtn);
  }
  body.appendChild(actions);

  row.append(header, body);
  return row;
}

softwareSearchState = bindSearchBar('software', applySoftwareFilter);
document.getElementById('software-filter-type').addEventListener('change', applySoftwareFilter);

document.getElementById('software-warehouse-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  await window.api.warehouse.add({
    category: 'software',
    item_type: form.get('item_type'),
    description: form.get('description'),
    license_key: form.get('license_key') || null,
    cost: form.get('cost') ? Number(form.get('cost')) : null,
    status: form.get('status')
  });
  e.target.reset();
  document.getElementById('software-add-form-wrap').removeAttribute('open');
  renderSoftwareRegistry();
  renderWarehouse();
  fillWarehouseDragList();
});

// ============================================================
// Лист 1: План (канва Konva)
// ============================================================

const CELL_PX = 40; // визуальный размер ячейки на экране (grid_step=900 в реальных единицах)
const INITIAL_ZOOM = 1; // всё умещается в одну клетку — отдалять план по умолчанию больше не нужно
const CABLE_COLOR = '#2ca02c';
const LINE_RENDER_TYPES = ['wall', 'door', 'stairs']; // хранятся и рисуются через x,y -> x2,y2
const TWO_CLICK_TOOLS = ['wall', 'stairs'];   // инструменты с рисованием "точка -> точка"
const DOOR_SNAP_THRESHOLD = 0.6;              // макс. расстояние (в клетках) от клика до стены, чтобы врезать дверь

const DEVICE_COLORS = {
  computer: '#4a90d9',
  laptop: '#5fb0d9',
  server: '#d9534f',
  vm: '#f0ad4e',
  router: '#5cb85c',
  switch: '#8e6cc9',
  printer: '#999999',
  other: '#777777'
};

let planState = {
  floorPlan: null,
  stage: null,
  layer: null,
  mode: null, // null | 'desk' | 'device' | 'wall' | 'door' | 'stairs' | 'cable' | 'delete'
  selectedNode: null,
  itemsById: new Map(),   // plan_item.id -> Konva.Group (desk/device/wall/door/stairs)
  cablesById: new Map(),  // cable.id -> Konva.Line
  cablesByItem: new Map(),// plan_item.id -> [cable.id, ...] — для обновления при перетаскивании
  zonesById: new Map(),   // zone.id -> Konva.Group (заливка + подпись)
  pendingLine: null,      // { x, y, type } — первая точка стены/двери/лестницы
  previewLine: null,      // Konva.Line — превью линии при рисовании
  cableDraft: null,       // { fromItemId, waypoints: [{x,y}] }
  cablePreviewLine: null,
  doorPreviewLine: null,  // Konva.Line — превью двери при наведении на стену
  deskPreviewRect: null,  // Konva.Rect — превью размещения стола под курсором
  panFrom: null,          // { x, y, stageX, stageY } — активна панорама зажатой средней кнопкой мыши
  viewMode: false,        // true = "Просмотр": элементы закреплены, нельзя двигать/удалять/рисовать
  layerVisibility: { 0: true, 1: true, 2: true, 3: true } // 0=зоны, 1=стены/мебель, 2=кабели, 3=оборудование; глобально, не по этажам
};

/** К какому логическому слою относится тип объекта плана — используется и при отрисовке
 *  (сразу выставить видимость), и переключателями слоёв (скрыть/показать все разом).
 *  Зоны — слой 0, самый нижний (под стенами); кабели (отдельная сущность, не plan_item) — слой 2. */
function planLayerFor(itemType) {
  if (itemType === 'device') return 3;
  if (itemType === 'wall' || itemType === 'door' || itemType === 'stairs' || itemType === 'desk') return 1;
  return null;
}

async function initPlan() {
  const floors = await window.api.floorPlans.list();
  planState.floorPlan = floors.length > 0 ? floors[0] : await window.api.floorPlans.ensureDefault();

  // Разовые привязки — не зависят от того, какой именно этаж сейчас открыт
  bindPlanToolbar();
  bindPlanSearch();
  bindZoomButtons();
  bindLayerToggles();
  bindUserDragDrop();

  document.getElementById('floor-add-btn').addEventListener('click', async () => {
    const floorsNow = await window.api.floorPlans.list();
    const name = await promptModal('Название нового плана/этажа', `Этаж ${floorsNow.length + 1}`);
    if (!name) return;
    const plan = await window.api.floorPlans.create({ name });
    await switchFloorPlan(plan.id);
  });

  document.addEventListener('keydown', async (e) => {
    // Раньше Delete срабатывал где угодно в приложении — если на плане было что-то
    // выделено, а пользователь редактировал текстовое поле карточки на другой вкладке
    // и нажимал Delete, удалялся элемент плана. Теперь — только на листе "Планы",
    // вне текстовых полей, и не в режиме просмотра (там любое удаление заблокировано).
    if (!isPlanTabActive() || isTypingInField()) return;

    if (e.key === 'Delete' && planState.selectedNode && !planState.viewMode) {
      await deleteSelected();
    }
    if (e.key === 'Escape') {
      clearPendingLine();
      cancelCableDraft();
      clearDoorPreview();
    }
  });

  bindModeSwitch();
  document.getElementById('plan-tools-search').addEventListener('input', applyPlanToolsSearch);

  await renderFloorTabs();
  await buildStageForCurrentFloor();
  await fillDevicePicker();
  await fillUserDragList();
  await fillWarehouseDragList();
}

async function renderFloorTabs() {
  const floors = await window.api.floorPlans.list();
  const container = document.getElementById('floor-tabs-list');
  container.innerHTML = '';
  floors.forEach((f) => {
    const btn = document.createElement('button');
    btn.className = 'floor-tab-btn';
    if (f.id === planState.floorPlan.id) btn.classList.add('active');
    btn.textContent = f.name;
    btn.addEventListener('click', () => switchFloorPlan(f.id));
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        {
          label: 'Переименовать', onClick: async () => {
            const newName = await promptModal('Новое название плана/этажа', f.name);
            if (!newName || newName === f.name) return;
            await window.api.floorPlans.rename(f.id, newName);
            if (planState.floorPlan.id === f.id) planState.floorPlan.name = newName;
            await renderFloorTabs();
          }
        },
        {
          label: 'Удалить этаж', danger: true, onClick: async () => {
            const current = await window.api.floorPlans.list();
            if (current.length <= 1) {
              alert('Нельзя удалить последний план — должен остаться хотя бы один.');
              return;
            }
            if (!confirm(`Удалить план «${f.name}» вместе со всеми объектами на нём? Действие необратимо.`)) return;

            const wasActive = planState.floorPlan.id === f.id;
            await window.api.floorPlans.remove(f.id);

            if (wasActive) {
              const remaining = await window.api.floorPlans.list();
              planState.floorPlan = remaining[0];
              await buildStageForCurrentFloor();
            }
            await renderFloorTabs();
          }
        }
      ]);
    });
    container.appendChild(btn);
  });
}

/** Переключение на другой этаж/план: полностью пересобирает канву под его сетку и объекты */
async function switchFloorPlan(id) {
  if (planState.floorPlan && planState.floorPlan.id === id) return;
  const floors = await window.api.floorPlans.list();
  const target = floors.find((f) => f.id === id);
  if (!target) return;

  planState.floorPlan = target;
  await renderFloorTabs();
  await buildStageForCurrentFloor();
}

/** Создаёт Konva-стейдж заново под текущий planState.floorPlan (размеры сетки могут отличаться
 *  на разных этажах) и грузит его объекты. Вызывается при первом запуске и при каждом переключении этажа. */
async function buildStageForCurrentFloor() {
  if (planState.stage) planState.stage.destroy();

  planState.itemsById = new Map();
  planState.cablesById = new Map();
  planState.cablesByItem = new Map();
  planState.zonesById = new Map();
  planState.selectedNode = null;
  planState.mode = null;
  planState.pendingLine = null;
  planState.previewLine = null;
  planState.cableDraft = null;
  planState.cablePreviewLine = null;
  planState.doorPreviewLine = null;
  planState.deskPreviewRect = null;
  planState.panFrom = null;

  const width = planState.floorPlan.grid_width_cells * CELL_PX;
  const height = planState.floorPlan.grid_height_cells * CELL_PX;

  planState.stage = new Konva.Stage({ container: 'plan-stage', width, height });
  planState.layer = new Konva.Layer();
  planState.stage.add(planState.layer);

  drawGrid();
  await loadPlanItems();
  bindZoomWheel();
  bindMiddleClickPan();

  planState.stage.on('click', (e) => handleStageClick(e));
  planState.stage.on('mousemove', () => handleStageMouseMove());

  // Расширенные карточки устройств (иконка + hostname/владелец/IP) шире одной клетки —
  // на 100% тесно с первого взгляда, поэтому по умолчанию открываем чуть отдалённо
  setZoom(INITIAL_ZOOM);

  renderInspector(null);
}

function drawGrid() {
  const cols = planState.floorPlan.grid_width_cells;
  const rows = planState.floorPlan.grid_height_cells;
  for (let i = 0; i <= cols; i++) {
    planState.layer.add(new Konva.Line({
      points: [i * CELL_PX, 0, i * CELL_PX, rows * CELL_PX],
      stroke: '#ddd', strokeWidth: 1
    }));
  }
  for (let j = 0; j <= rows; j++) {
    planState.layer.add(new Konva.Line({
      points: [0, j * CELL_PX, cols * CELL_PX, j * CELL_PX],
      stroke: '#ddd', strokeWidth: 1
    }));
  }
  planState.layer.draw();
}

async function loadPlanItems() {
  const zones = await window.api.zones.list(planState.floorPlan.id);
  zones.forEach(renderZone);

  const items = await window.api.planItems.list(planState.floorPlan.id);
  // Порядок отрисовки: зоны в самом низу, конструктив выше них, точечные объекты сверху
  // (нужны их центры для кабелей)
  items.filter((i) => LINE_RENDER_TYPES.includes(i.item_type)).forEach(renderLineItem);
  items.filter((i) => !LINE_RENDER_TYPES.includes(i.item_type)).forEach(renderPointItem);

  const cables = await window.api.cables.list(planState.floorPlan.id);
  cables.forEach(renderCable);
}

// ------------------------------------------------------------
// Точечные объекты: стол / устройство
// ------------------------------------------------------------

function renderPointItem(item) {
  const group = new Konva.Group({
    x: item.x * CELL_PX,
    y: item.y * CELL_PX,
    draggable: !planState.viewMode
  });
  group.setAttr('kind', 'point');
  group.setAttr('recordId', item.id);
  group.setAttr('itemData', item);
  const planLayer = planLayerFor(item.item_type);
  group.setAttr('planLayer', planLayer);
  if (planLayer !== null) group.visible(planState.layerVisibility[planLayer]);

  const isDesk = item.item_type === 'desk';
  const size = CELL_PX - 4;
  const color = isDesk ? '#c8a876' : (DEVICE_COLORS[item.device_type] || '#777');

  // Рамка иконки подсвечивается по статусу устройства — тот же смысл, что и подсветка
  // строки в карточке на вкладке "Устройства"
  const STATUS_BORDER_COLORS = { repair: '#ecc94b', storage: '#7ea6d6', decommissioned: '#999' };
  const borderColor = !isDesk && STATUS_BORDER_COLORS[item.device_status] ? STATUS_BORDER_COLORS[item.device_status] : '#333';
  const borderWidth = !isDesk && STATUS_BORDER_COLORS[item.device_status] ? 2.5 : 1;

  const rect = new Konva.Rect({
    width: size, height: size, x: 2, y: 2,
    fill: color, stroke: borderColor, strokeWidth: borderWidth, cornerRadius: 4
  });
  group.add(rect);

  if (isDesk) {
    group.add(new Konva.Text({
      text: 'Стол', fontSize: 10, fill: '#fff',
      width: size, y: size / 2 - 6, align: 'center'
    }));
    if (item.review_note) {
      const triCx = size - 6;
      group.add(new Konva.RegularPolygon({
        x: triCx, y: 6, sides: 3, radius: 5,
        fill: '#f5a623', stroke: '#8a5a00', strokeWidth: 0.7, name: 'reviewFlag'
      }));
      group.add(new Konva.Text({
        text: '!', x: triCx - 3, y: 3, width: 6, fontSize: 6.5, fontStyle: 'bold',
        fill: '#5c3d00', align: 'center', listening: false
      }));
    }
  } else {
    // Та же иконка, что и раньше, просто уменьшенная — освобождает место под ней в той же
    // клетке для hostname и владельца мелким шрифтом. Никакой отдельной "второй карточки".
    const glyphSize = Math.round(size * 0.5);
    const glyphGroup = new Konva.Group({ x: 2, y: 2 });
    addDeviceGlyph(glyphGroup, item.device_type, glyphSize, glyphSize);
    group.add(glyphGroup);

    const hostnameY = 2 + glyphSize + 1;
    group.add(new Konva.Text({
      text: item.device_hostname || '?', x: 1, y: hostnameY, width: size - 2,
      fontSize: 6.5, fontStyle: 'bold', fill: '#fff', align: 'center',
      ellipsis: true, wrap: 'none', lineHeight: 1
    }));

    const ownerY = hostnameY + 8;
    group.add(new Konva.Text({
      text: item.owner_name || '', x: 1, y: ownerY, width: size - 2,
      fontSize: 6, fill: 'rgba(255,255,255,0.85)', align: 'center',
      ellipsis: true, wrap: 'none', lineHeight: 1
    }));

    const badge = new Konva.Circle({
      x: size - 2, y: 6, radius: 4,
      fill: pingColor(item.last_ping_status), stroke: '#fff', strokeWidth: 1,
      name: 'pingBadge'
    });
    group.add(badge);

    // Треугольник с восклицательным знаком — ручной комментарий "на проверку"
    // (не путать с пометками Проблема/Внимание/Ошибка — это отдельный инструмент,
    // ставится/снимается через контекстное меню прямо на плане). Стоит перед
    // маркером online, слева от него.
    if (item.review_note) {
      const triCx = size - 12;
      const tri = new Konva.RegularPolygon({
        x: triCx, y: 6, sides: 3, radius: 5,
        fill: '#f5a623', stroke: '#8a5a00', strokeWidth: 0.7,
        name: 'reviewFlag'
      });
      group.add(tri);
      group.add(new Konva.Text({
        text: '!', x: triCx - 3, y: 3, width: 6, fontSize: 6.5, fontStyle: 'bold',
        fill: '#5c3d00', align: 'center', listening: false
      }));
    }

    // Точка-флаг внизу слева — ручная пометка или авто-обнаруженный конфликт
    // (владелец уволен, но всё ещё закреплён за устройством)
    const autoConflict = item.owner_status === 'dismissed' ? 'Владелец уволен, но всё ещё закреплён за устройством' : null;
    const effectiveFlag = autoConflict ? 'attention' : item.device_flag;
    if (effectiveFlag) {
      const flagColors = { problem: '#e8730a', attention: '#c9a400', error: '#c53030' };
      const flagDot = new Konva.Circle({
        x: 6, y: size - 4, radius: 4,
        fill: flagColors[effectiveFlag] || '#888', stroke: '#fff', strokeWidth: 1,
        name: 'flagBadge'
      });
      group.add(flagDot);
    }
  }

  group.on('click', async (e) => {
    if (e.evt && e.evt.button !== undefined && e.evt.button !== 0) return; // только левая — средняя занята панорамой
    e.cancelBubble = true;
    if (planState.mode === 'delete') { await removePlanItem(item.id); return; }
    if (planState.mode === 'cable' && (item.item_type === 'device' || item.item_type === 'desk')) {
      if (!planState.cableDraft) startCableDraft(item.id);
      else if (planState.cableDraft.fromItemId !== item.id) await finishCableDraft(item.id);
      return;
    }
    selectNode(group);
  });

  group.on('contextmenu', (e) => {
    e.evt.preventDefault();
    e.cancelBubble = true;
    if (planState.viewMode) return; // в просмотре ничего менять нельзя, в т.ч. и комментарии

    const applyNote = async (text) => {
      const updated = await window.api.planItems.setReviewNote(item.id, text);
      const data = group.getAttr('itemData');
      data.review_note = updated.review_note;
      group.setAttr('itemData', data);
      refreshPointItemVisual(data);
    };

    const currentNote = group.getAttr('itemData').review_note;
    const items = [];
    if (currentNote) {
      items.push({
        label: '✏️ Изменить комментарий "на проверку"', onClick: async () => {
          const text = await promptModal('Комментарий "на проверку"', currentNote);
          if (text === null) return; // отмена — оставляем как было
          if (text) await applyNote(text);
        }
      });
      items.push({ label: '✅ Снять пометку "на проверку"', onClick: () => applyNote(null) });
    } else {
      items.push({
        label: '⚠️ Пометить "на проверку"…', onClick: async () => {
          const text = await promptModal('Комментарий "на проверку"', '');
          if (text) await applyNote(text);
        }
      });
    }
    showContextMenu(e.evt.clientX, e.evt.clientY, items);
  });

  group.on('dragstart', () => {
    if (planState.panFrom) group.stopDrag(); // средняя кнопка уже занята панорамой — эта иконка не должна тащиться
  });

  group.on('dragend', async () => {
    const cellX = Math.round(group.x() / CELL_PX);
    const cellY = Math.round(group.y() / CELL_PX);
    group.position({ x: cellX * CELL_PX, y: cellY * CELL_PX });
    const data = group.getAttr('itemData');
    data.x = cellX; data.y = cellY;
    group.setAttr('itemData', data);
    await window.api.planItems.move(item.id, cellX, cellY);
    updateConnectedCables(item.id);
    if (planState.selectedNode === group) renderInspector(group);
    planState.layer.draw();
  });

  planState.layer.add(group);
  planState.layer.draw();
  planState.itemsById.set(item.id, group);
  return group;
}

/** Простые векторные глиптики, чтобы тип устройства читался с первого взгляда */
function addDeviceGlyph(group, deviceType, w, h) {
  const stroke = '#fff';
  switch (deviceType) {
    case 'computer':
      group.add(new Konva.Rect({ x: w * 0.16, y: h * 0.14, width: w * 0.68, height: h * 0.46, stroke, strokeWidth: 1.4, cornerRadius: 1 }));
      group.add(new Konva.Rect({ x: w * 0.42, y: h * 0.62, width: w * 0.16, height: h * 0.1, fill: stroke }));
      group.add(new Konva.Line({ points: [w * 0.26, h * 0.78, w * 0.74, h * 0.78], stroke, strokeWidth: 1.4 }));
      break;
    case 'laptop':
      group.add(new Konva.Rect({ x: w * 0.24, y: h * 0.14, width: w * 0.52, height: h * 0.42, stroke, strokeWidth: 1.4 }));
      group.add(new Konva.Line({
        points: [w * 0.12, h * 0.62, w * 0.88, h * 0.62, w * 0.94, h * 0.78, w * 0.06, h * 0.78],
        closed: true, fill: stroke, opacity: 0.85
      }));
      break;
    case 'server':
    case 'vm':
      for (let i = 0; i < 3; i++) {
        const ry = h * 0.12 + i * h * 0.24;
        group.add(new Konva.Rect({
          x: w * 0.15, y: ry, width: w * 0.7, height: h * 0.17,
          stroke, strokeWidth: 1.2, dash: deviceType === 'vm' ? [3, 2] : undefined
        }));
        group.add(new Konva.Circle({ x: w * 0.74, y: ry + h * 0.085, radius: 1.6, fill: stroke }));
      }
      break;
    case 'router':
      group.add(new Konva.Rect({ x: w * 0.15, y: h * 0.46, width: w * 0.7, height: h * 0.28, stroke, strokeWidth: 1.4, cornerRadius: 2 }));
      group.add(new Konva.Line({ points: [w * 0.35, h * 0.46, w * 0.24, h * 0.16], stroke, strokeWidth: 1.3 }));
      group.add(new Konva.Line({ points: [w * 0.65, h * 0.46, w * 0.76, h * 0.16], stroke, strokeWidth: 1.3 }));
      [0.3, 0.5, 0.7].forEach((fx) => group.add(new Konva.Circle({ x: w * fx, y: h * 0.68, radius: 1.4, fill: stroke })));
      break;
    case 'switch':
      group.add(new Konva.Rect({ x: w * 0.12, y: h * 0.36, width: w * 0.76, height: h * 0.28, stroke, strokeWidth: 1.4, cornerRadius: 2 }));
      for (let i = 0; i < 5; i++) {
        group.add(new Konva.Rect({ x: w * 0.18 + i * w * 0.13, y: h * 0.43, width: w * 0.07, height: h * 0.14, fill: stroke }));
      }
      break;
    case 'printer':
      group.add(new Konva.Line({ points: [w * 0.3, h * 0.3, w * 0.3, h * 0.16, w * 0.7, h * 0.16, w * 0.7, h * 0.3], stroke, strokeWidth: 1.2 }));
      group.add(new Konva.Rect({ x: w * 0.18, y: h * 0.3, width: w * 0.64, height: h * 0.26, stroke, strokeWidth: 1.4 }));
      group.add(new Konva.Rect({ x: w * 0.28, y: h * 0.56, width: w * 0.44, height: h * 0.16, fill: stroke }));
      break;
    default:
      group.add(new Konva.Circle({ x: w / 2, y: h / 2, radius: w * 0.28, stroke, strokeWidth: 1.4 }));
      group.add(new Konva.Text({ text: '?', width: w, y: h * 0.32, align: 'center', fontSize: 14, fill: stroke }));
  }
}

/**
 * Направление подъёма лестницы храним в plan_items.rotation (то же поле, что и у
 * будущего поворота мебели) — 0=вправо, 90=вниз, 180=влево, 270=вверх.
 * dx/dy — вектор от точки начала подъёма ко второй точке клика, задающей направление.
 */
function directionToRotation(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 0 : 180;
  return dy >= 0 ? 90 : 270;
}

function rotationLabel(rotation) {
  return { 0: 'вправо →', 90: 'вниз ↓', 180: 'влево ←', 270: 'вверх ↑' }[rotation] || '—';
}

/** Лестница как прямоугольная область (x1,y1)-(x1+w,y1+h): ступени-риски и стрелка
 *  направления подъёма идут от края до края области, а не в её условном центре. */
function addStairsRectGlyph(group, rotation, x1, y1, w, h) {
  const horizontal = rotation === 0 || rotation === 180;
  const reversed = rotation === 180 || rotation === 270;

  if (horizontal) {
    const cy = y1 + h / 2;
    const startX = reversed ? x1 + w : x1;
    const endX = reversed ? x1 : x1 + w;
    const steps = Math.max(2, Math.round(w / 14));
    for (let i = 1; i < steps; i++) {
      const sx = x1 + (w * i) / steps;
      group.add(new Konva.Line({ points: [sx, y1, sx, y1 + h], stroke: '#999', strokeWidth: 1 }));
    }
    group.add(new Konva.Arrow({
      points: [startX, cy, endX, cy],
      stroke: '#444', fill: '#444', strokeWidth: 2, pointerLength: 8, pointerWidth: 7
    }));
  } else {
    const cx = x1 + w / 2;
    const startY = reversed ? y1 + h : y1;
    const endY = reversed ? y1 : y1 + h;
    const steps = Math.max(2, Math.round(h / 14));
    for (let i = 1; i < steps; i++) {
      const sy = y1 + (h * i) / steps;
      group.add(new Konva.Line({ points: [x1, sy, x1 + w, sy], stroke: '#999', strokeWidth: 1 }));
    }
    group.add(new Konva.Arrow({
      points: [cx, startY, cx, endY],
      stroke: '#444', fill: '#444', strokeWidth: 2, pointerLength: 8, pointerWidth: 7
    }));
  }
}

function updatePingBadge(itemId, status) {
  const group = planState.itemsById.get(itemId);
  if (!group) return;
  const badge = group.findOne('.pingBadge');
  if (badge) { badge.fill(pingColor(status)); planState.layer.draw(); }
  const data = group.getAttr('itemData');
  if (data) { data.last_ping_status = status; group.setAttr('itemData', data); }
}

/** BFS по уже нарисованным кабелям от корневого plan_item (например, роутера) —
 *  возвращает id всех point-item'ов типа "устройство", достижимых цепочкой кабелей
 *  (включая сам корень, если он тоже устройство). Переиспользуется массовым пингом
 *  "все на роутере" и позже вкладкой "Сеть" для построения иерархии подсети. */
function getConnectedDeviceIds(rootPlanItemId) {
  const visited = new Set([rootPlanItemId]);
  const queue = [rootPlanItemId];
  const deviceIds = [];
  while (queue.length) {
    const currentId = queue.shift();
    const node = planState.itemsById.get(currentId);
    if (node && node.getAttr('itemData')?.item_type === 'device') deviceIds.push(currentId);
    planState.cablesById.forEach((line) => {
      const cable = line.getAttr('cableData');
      let neighborId = null;
      if (cable.from_item_id === currentId) neighborId = cable.to_item_id;
      else if (cable.to_item_id === currentId) neighborId = cable.from_item_id;
      if (neighborId != null && !visited.has(neighborId)) {
        visited.add(neighborId);
        queue.push(neighborId);
      }
    });
  }
  return deviceIds;
}

/** Массово пингует набор устройств (по id plan_item), обновляя бейджи по мере ответов.
 *  Используется кнопками "обновить пинг всех на плане/в зоне/на роутере". */
async function pingManyDevices(planItemIds, label) {
  const targets = planItemIds
    .map((id) => planState.itemsById.get(id))
    .filter((node) => node && node.getAttr('itemData')?.item_type === 'device' && node.getAttr('itemData')?.device_ip);
  if (targets.length === 0) { flashModeWarning('Нет устройств с IP для пинга'); return; }

  const labelEl = document.getElementById('plan-mode-label');
  const original = labelEl.textContent;
  const originalColor = labelEl.style.color;
  labelEl.textContent = `Пингуем ${targets.length}${label ? ' (' + label + ')' : ''}…`;
  labelEl.style.color = '';

  await Promise.all(targets.map(async (node) => {
    const data = node.getAttr('itemData');
    try {
      const result = await window.api.ping.run(data.ref_id, data.device_ip);
      updatePingBadge(data.id, result.status);
    } catch { /* одно неудавшееся устройство не должно рвать остальные */ }
  }));

  labelEl.textContent = `Готово: ${targets.length} устройств`;
  setTimeout(() => {
    labelEl.textContent = original;
    labelEl.style.color = originalColor;
  }, 1600);
}

function updatePingBadgeByDeviceId(deviceId, status) {
  planState.itemsById.forEach((group, id) => {
    const data = group.getAttr('itemData');
    if (data && data.ref_id === deviceId) updatePingBadge(id, status);
  });
}

// ------------------------------------------------------------
// Линейные объекты: стена / дверь / лестница
// ------------------------------------------------------------

function lineColor(type) {
  if (type === 'wall') return '#3a3a3a';
  if (type === 'door') return '#a0724a';
  return '#666'; // stairs
}

function renderLineItem(item) {
  const group = new Konva.Group();
  group.setAttr('kind', 'line');
  group.setAttr('recordId', item.id);
  group.setAttr('itemData', item);
  const planLayer = planLayerFor(item.item_type);
  group.setAttr('planLayer', planLayer);
  if (planLayer !== null) group.visible(planState.layerVisibility[planLayer]);

  const p1 = { x: item.x * CELL_PX, y: item.y * CELL_PX };
  const p2 = { x: item.x2 * CELL_PX, y: item.y2 * CELL_PX };

  if (item.item_type === 'wall') {
    group.add(new Konva.Line({
      points: [p1.x, p1.y, p2.x, p2.y],
      stroke: lineColor('wall'), strokeWidth: 6, lineCap: 'square', hitStrokeWidth: 14
    }));
  } else if (item.item_type === 'door') {
    group.add(new Konva.Line({
      points: [p1.x, p1.y, p2.x, p2.y],
      stroke: lineColor('door'), strokeWidth: 4, dash: [6, 3], hitStrokeWidth: 14
    }));
    // rotation (0/90/180/270, поле общее для всех plan_items) кодирует 2 независимых
    // тумблера двери: бит0 — с какого конца петля (хинж), бит1 — в какую сторону стены открывается
    const variant = Math.round((item.rotation || 0) / 90) % 4;
    const hinge = variant & 1;
    const swingFlip = (variant >> 1) & 1;
    const pivot = hinge ? p2 : p1;
    const other = hinge ? p1 : p2;
    const len = Math.hypot(other.x - pivot.x, other.y - pivot.y);
    const lineAngleDeg = Math.atan2(other.y - pivot.y, other.x - pivot.x) * (180 / Math.PI);
    const arcRotation = swingFlip ? lineAngleDeg - 90 : lineAngleDeg;
    group.add(new Konva.Arc({
      x: pivot.x, y: pivot.y, innerRadius: 0, outerRadius: Math.max(len, 4),
      angle: 90, rotation: arcRotation, stroke: lineColor('door'), strokeWidth: 1, dash: [2, 2]
    }));
  } else if (item.item_type === 'stairs') {
    const x1 = Math.min(item.x, item.x2) * CELL_PX;
    const y1 = Math.min(item.y, item.y2) * CELL_PX;
    const x2px = Math.max(item.x, item.x2) * CELL_PX;
    const y2px = Math.max(item.y, item.y2) * CELL_PX;
    const w = x2px - x1;
    const h = y2px - y1;

    group.add(new Konva.Rect({
      x: x1, y: y1, width: w, height: h,
      fill: '#e8e2d5', stroke: lineColor('stairs'), strokeWidth: 1.5 // без cornerRadius — острые углы
    }));
    addStairsRectGlyph(group, item.rotation || 0, x1, y1, w, h);
  }

  group.on('click', async (e) => {
    if (e.evt && e.evt.button !== undefined && e.evt.button !== 0) return; // только левая — средняя занята панорамой
    e.cancelBubble = true;
    if (planState.mode === 'delete') { await removePlanItem(item.id); return; }
    // Клик по стене в режиме "Дверь" — врезаем дверь прямо в эту стену вместо выделения
    if (planState.mode === 'door' && item.item_type === 'wall') {
      const pointer = planState.stage.getRelativePointerPosition();
      handleDoorToolClick(pointer.x / CELL_PX, pointer.y / CELL_PX);
      return;
    }
    // Клик по любому конструктиву во время рисования стены — заканчиваем стену прямо в этой точке,
    // а не выделяем то, на что кликнули (иначе стену никогда не получится довести до другой стены)
    if (planState.mode === 'wall' && planState.pendingLine) {
      const pointer = planState.stage.getRelativePointerPosition();
      const cellX = Math.round(pointer.x / CELL_PX);
      const cellY = Math.round(pointer.y / CELL_PX);
      const start = planState.pendingLine;
      await finalizeWall(start.x, start.y, cellX, cellY);
      clearPendingLine();
      return;
    }
    selectNode(group);
  });

  planState.layer.add(group);
  planState.layer.draw();
  planState.itemsById.set(item.id, group);
  return group;
}

function handleLineToolClick(x, y) {
  if (planState.viewMode) return;
  if (!planState.pendingLine) {
    planState.pendingLine = { x, y, type: planState.mode };
  } else {
    const start = planState.pendingLine;
    if (start.type === 'wall') finalizeWall(start.x, start.y, x, y);
    else if (start.type === 'stairs') finalizeStairs(start.x, start.y, x, y);
    clearPendingLine();
  }
}

async function finalizeWall(x, y, x2, y2) {
  if (x === x2 && y === y2) return; // нулевая длина — игнорируем
  const item = await window.api.planItems.create({
    floor_plan_id: planState.floorPlan.id,
    item_type: 'wall', x, y, x2, y2
  });
  renderLineItem(item);
}

/** Лестница — прямоугольная область от (x,y) до (x2,y2), растягивается на столько клеток,
 *  на сколько провели; направление подъёма (в rotation) — по вектору первого клика ко второму.
 *  Если протянули строго по одной оси, добавляем минимум 1 клетку в поперечном направлении —
 *  лестница не может быть нулевой толщины. */
async function finalizeStairs(x, y, x2, y2) {
  const dx = x2 - x, dy = y2 - y;
  if (dx === 0 && dy === 0) return; // нужно указать направление вторым кликом
  const rotation = directionToRotation(dx, dy);
  if (x2 === x) x2 = x + 1;
  if (y2 === y) y2 = y + 1;
  const item = await window.api.planItems.create({
    floor_plan_id: planState.floorPlan.id,
    item_type: 'stairs', x, y, x2, y2, rotation
  });
  renderLineItem(item);
}

function clearPendingLine() {
  planState.pendingLine = null;
  if (planState.previewLine) { planState.previewLine.destroy(); planState.previewLine = null; }
  planState.layer.draw();
}

function updateLinePreview(pointer) {
  const start = planState.pendingLine;
  const cellX = Math.round(pointer.x / CELL_PX);
  const cellY = Math.round(pointer.y / CELL_PX);
  const pts = [start.x * CELL_PX, start.y * CELL_PX, cellX * CELL_PX, cellY * CELL_PX];
  if (!planState.previewLine) {
    planState.previewLine = new Konva.Line({ points: pts, stroke: '#999', strokeWidth: 2, dash: [4, 4] });
    planState.layer.add(planState.previewLine);
  } else {
    planState.previewLine.points(pts);
  }
  planState.layer.draw();
}

// ------------------------------------------------------------
// Дверь: врезка в ближайшую стену (не рисуется свободно, только на существующей стене)
// ------------------------------------------------------------

function distancePointToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return { dist: Math.hypot(px - cx, py - cy), t };
}

function findNearestWall(cellX, cellY) {
  let best = null;
  planState.itemsById.forEach((node) => {
    const data = node.getAttr('itemData');
    if (!data || data.item_type !== 'wall') return;
    const { dist, t } = distancePointToSegment(cellX, cellY, data.x, data.y, data.x2, data.y2);
    if (!best || dist < best.dist) best = { data, dist, t };
  });
  return best;
}

/** Из точки на стене (параметр t, 0..1) считаем целую клетку под дверь длиной ровно 1 клетка вдоль стены */
function doorSegmentFromWall(data, t) {
  const dx = data.x2 - data.x, dy = data.y2 - data.y;
  const len = Math.max(Math.abs(dx), Math.abs(dy));
  if (len === 0) return null;
  const stepX = Math.sign(dx), stepY = Math.sign(dy);
  let ti = Math.round(t * len);
  ti = Math.max(0, Math.min(len - 1, ti)); // оставляем место для двери длиной 1 клетка внутри стены
  const sx = data.x + stepX * ti, sy = data.y + stepY * ti;
  return { x: sx, y: sy, x2: sx + stepX, y2: sy + stepY };
}

function handleDoorToolClick(cellXFloat, cellYFloat) {
  if (planState.viewMode) return;
  const nearest = findNearestWall(cellXFloat, cellYFloat);
  if (!nearest || nearest.dist > DOOR_SNAP_THRESHOLD) {
    flashModeWarning('Кликните ближе к стене — дверь встраивается только в неё');
    return;
  }
  const seg = doorSegmentFromWall(nearest.data, nearest.t);
  if (!seg) return;
  finalizeDoor(seg.x, seg.y, seg.x2, seg.y2);
}

async function finalizeDoor(x, y, x2, y2) {
  const item = await window.api.planItems.create({
    floor_plan_id: planState.floorPlan.id,
    item_type: 'door', x, y, x2, y2
  });
  renderLineItem(item);
  clearDoorPreview();
}

function updateDoorPreview(pointer) {
  const nearest = findNearestWall(pointer.x / CELL_PX, pointer.y / CELL_PX);
  if (!nearest || nearest.dist > DOOR_SNAP_THRESHOLD) { clearDoorPreview(); return; }
  const seg = doorSegmentFromWall(nearest.data, nearest.t);
  if (!seg) { clearDoorPreview(); return; }
  const pts = [seg.x * CELL_PX, seg.y * CELL_PX, seg.x2 * CELL_PX, seg.y2 * CELL_PX];
  if (!planState.doorPreviewLine) {
    planState.doorPreviewLine = new Konva.Line({ points: pts, stroke: '#a0724a', strokeWidth: 6, opacity: 0.5 });
    planState.layer.add(planState.doorPreviewLine);
  } else {
    planState.doorPreviewLine.points(pts);
  }
  planState.layer.draw();
}

function clearDoorPreview() {
  if (planState.doorPreviewLine) { planState.doorPreviewLine.destroy(); planState.doorPreviewLine = null; planState.layer.draw(); }
}

/** Полупрозрачный контур будущего стола под курсором — снаппится к той же клетке, что и клик */
function updateDeskPreview(pointer) {
  const cellX = Math.round(pointer.x / CELL_PX);
  const cellY = Math.round(pointer.y / CELL_PX);
  const x = cellX * CELL_PX + 2;
  const y = cellY * CELL_PX + 2;
  if (!planState.deskPreviewRect) {
    planState.deskPreviewRect = new Konva.Rect({
      x, y, width: CELL_PX - 4, height: CELL_PX - 4,
      fill: '#c8a876', opacity: 0.4, stroke: '#c8a876', strokeWidth: 1.5,
      cornerRadius: 4, listening: false
    });
    planState.layer.add(planState.deskPreviewRect);
  } else {
    planState.deskPreviewRect.position({ x, y });
  }
  planState.layer.draw();
}

function clearDeskPreview() {
  if (planState.deskPreviewRect) { planState.deskPreviewRect.destroy(); planState.deskPreviewRect = null; planState.layer.draw(); }
}

function flashModeWarning(msg) {
  const label = document.getElementById('plan-mode-label');
  const original = label.textContent;
  label.textContent = msg;
  label.style.color = '#c0392b';
  setTimeout(() => {
    label.textContent = original;
    label.style.color = '';
  }, 1600);
}

// ------------------------------------------------------------
// Сетевой кабель (связь между двумя точечными объектами, с опциональными waypoints)
// ------------------------------------------------------------

function itemCenterPx(itemId) {
  const node = planState.itemsById.get(itemId);
  if (!node) return null;
  return { x: node.x() + CELL_PX / 2, y: node.y() + CELL_PX / 2 };
}

function renderCable(cable) {
  const from = itemCenterPx(cable.from_item_id);
  const to = itemCenterPx(cable.to_item_id);
  if (!from || !to) return null;

  const waypoints = JSON.parse(cable.waypoints || '[]').map((w) => ({ x: w.x * CELL_PX, y: w.y * CELL_PX }));
  const points = [from.x, from.y, ...waypoints.flatMap((w) => [w.x, w.y]), to.x, to.y];

  const line = new Konva.Line({ points, stroke: CABLE_COLOR, strokeWidth: 2, dash: [6, 4], hitStrokeWidth: 10 });
  line.setAttr('kind', 'cable');
  line.setAttr('recordId', cable.id);
  line.setAttr('cableData', cable);
  line.setAttr('planLayer', 2);
  line.visible(planState.layerVisibility[2]);

  line.on('click', async (e) => {
    if (e.evt && e.evt.button !== undefined && e.evt.button !== 0) return; // только левая — средняя занята панорамой
    e.cancelBubble = true;
    if (planState.mode === 'delete') { await removeCable(cable.id); return; }
    selectNode(line);
  });

  planState.layer.add(line);
  planState.layer.draw();
  planState.cablesById.set(cable.id, line);
  [cable.from_item_id, cable.to_item_id].forEach((iid) => {
    if (!planState.cablesByItem.has(iid)) planState.cablesByItem.set(iid, []);
    planState.cablesByItem.get(iid).push(cable.id);
  });
  return line;
}

function startCableDraft(fromItemId) {
  if (planState.viewMode) return;
  planState.cableDraft = { fromItemId, waypoints: [] };
}

function updateCablePreview(pointer) {
  const draft = planState.cableDraft;
  if (!draft) return;
  const cellX = Math.round(pointer.x / CELL_PX);
  const cellY = Math.round(pointer.y / CELL_PX);
  const from = itemCenterPx(draft.fromItemId);
  const waypointsPx = draft.waypoints.flatMap((w) => [w.x * CELL_PX, w.y * CELL_PX]);
  const pts = [from.x, from.y, ...waypointsPx, cellX * CELL_PX, cellY * CELL_PX];
  if (!planState.cablePreviewLine) {
    planState.cablePreviewLine = new Konva.Line({ points: pts, stroke: CABLE_COLOR, strokeWidth: 2, dash: [6, 4], opacity: 0.6 });
    planState.layer.add(planState.cablePreviewLine);
  } else {
    planState.cablePreviewLine.points(pts);
  }
  planState.layer.draw();
}

async function finishCableDraft(toItemId) {
  if (planState.viewMode) return;
  const draft = planState.cableDraft;
  const cable = await window.api.cables.create({
    floor_plan_id: planState.floorPlan.id,
    from_item_id: draft.fromItemId,
    to_item_id: toItemId,
    cable_type: 'network',
    waypoints: draft.waypoints
  });
  renderCable(cable);
  cancelCableDraft();
}

function cancelCableDraft() {
  planState.cableDraft = null;
  if (planState.cablePreviewLine) { planState.cablePreviewLine.destroy(); planState.cablePreviewLine = null; }
  planState.layer.draw();
}

async function removeCable(id) {
  if (planState.viewMode) return;
  await window.api.cables.remove(id);
  const line = planState.cablesById.get(id);
  if (line) { line.destroy(); planState.cablesById.delete(id); }
  planState.cablesByItem.forEach((ids, itemId) => {
    planState.cablesByItem.set(itemId, ids.filter((cid) => cid !== id));
  });
  if (planState.selectedNode === line) { planState.selectedNode = null; renderInspector(null); }
  planState.layer.draw();
}

function updateConnectedCables(itemId) {
  const cableIds = planState.cablesByItem.get(itemId) || [];
  cableIds.forEach((cid) => {
    const line = planState.cablesById.get(cid);
    if (!line) return;
    const cable = line.getAttr('cableData');
    const from = itemCenterPx(cable.from_item_id);
    const to = itemCenterPx(cable.to_item_id);
    const waypoints = JSON.parse(cable.waypoints || '[]').map((w) => ({ x: w.x * CELL_PX, y: w.y * CELL_PX }));
    line.points([from.x, from.y, ...waypoints.flatMap((w) => [w.x, w.y]), to.x, to.y]);
  });
  planState.layer.draw();
}

// ------------------------------------------------------------
// Зоны: заливка контура, замкнутого стенами, + перемещаемая/поворачиваемая подпись
// ------------------------------------------------------------

const ZONE_FILL_COLOR = '#4a90d9';
const ZONE_FLOOD_TOOLTIP = 'Не удалось определить замкнутую область — начните с клетки внутри контура из стен';

/** Разбирает все стены на единичные рёбра сетки, которые блокируют переход между соседними клетками.
 *  Диагональные стены (нетипичный случай — двухклик не ограничен осями) в этой модели не учитываются. */
function collectWallEdgeSet() {
  const edges = new Set();
  planState.itemsById.forEach((node) => {
    const data = node.getAttr('itemData');
    if (!data || data.item_type !== 'wall') return;
    const { x, y, x2, y2 } = data;
    if (y === y2) {
      const xs = Math.min(x, x2), xe = Math.max(x, x2);
      for (let gx = xs; gx < xe; gx++) edges.add(`h:${gx}:${y}`);
    } else if (x === x2) {
      const ys = Math.min(y, y2), ye = Math.max(y, y2);
      for (let gy = ys; gy < ye; gy++) edges.add(`v:${x}:${gy}`);
    }
  });
  return edges;
}

/** BFS от стартовой клетки по соседним, пока не упрёмся в стену или край сетки.
 *  Возвращает массив [x,y] клеток зоны, либо null, если что-то пошло не так (защитный предел). */
function floodFillZone(startX, startY) {
  const cols = planState.floorPlan.grid_width_cells;
  const rows = planState.floorPlan.grid_height_cells;
  if (startX < 0 || startY < 0 || startX >= cols || startY >= rows) return null;

  const edges = collectWallEdgeSet();
  const visited = new Set([`${startX},${startY}`]);
  const queue = [[startX, startY]];
  const cells = [[startX, startY]];
  const limit = cols * rows;

  while (queue.length) {
    const [cx, cy] = queue.shift();
    const moves = [
      { nx: cx + 1, ny: cy, blocked: edges.has(`v:${cx + 1}:${cy}`) },
      { nx: cx - 1, ny: cy, blocked: edges.has(`v:${cx}:${cy}`) },
      { nx: cx, ny: cy + 1, blocked: edges.has(`h:${cx}:${cy + 1}`) },
      { nx: cx, ny: cy - 1, blocked: edges.has(`h:${cx}:${cy}`) }
    ];
    for (const { nx, ny, blocked } of moves) {
      if (blocked) continue;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const key = `${nx},${ny}`;
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push([nx, ny]);
      cells.push([nx, ny]);
      if (cells.length > limit) return null; // защитный предел — по конечной сетке случиться не должно
    }
  }
  return cells;
}

function computeZoneCentroidPx(cells) {
  const sx = cells.reduce((s, [x]) => s + x, 0) / cells.length;
  const sy = cells.reduce((s, [, y]) => s + y, 0) / cells.length;
  return { x: (sx + 0.5) * CELL_PX, y: (sy + 0.5) * CELL_PX };
}

function renderZone(zone) {
  const cells = JSON.parse(zone.cells);
  const group = new Konva.Group();
  group.setAttr('kind', 'zone');
  group.setAttr('recordId', zone.id);
  group.setAttr('zoneData', zone);
  group.setAttr('planLayer', 0);
  group.visible(planState.layerVisibility[0]);

  const shape = new Konva.Shape({
    sceneFunc: (ctx, shapeNode) => {
      ctx.beginPath();
      cells.forEach(([cx, cy]) => ctx.rect(cx * CELL_PX, cy * CELL_PX, CELL_PX, CELL_PX));
      ctx.closePath();
      ctx.fillStrokeShape(shapeNode);
    },
    fill: ZONE_FILL_COLOR,
    opacity: 0.28,
    perfectDrawEnabled: false
  });
  shape.on('click', async (e) => {
    if (e.evt && e.evt.button !== undefined && e.evt.button !== 0) return; // только левая — средняя занята панорамой
    e.cancelBubble = true;
    if (planState.mode === 'delete') { await removeZone(zone.id); return; }
    selectNode(group);
  });
  group.add(shape);
  group.setAttr('shapeNode', shape);

  if (zone.label_visible) {
    const centroid = computeZoneCentroidPx(cells);
    const lx = zone.label_x != null ? zone.label_x : centroid.x;
    const ly = zone.label_y != null ? zone.label_y : centroid.y;
    const labelNode = new Konva.Text({
      x: lx, y: ly, text: zone.name, fontSize: 13, fill: '#2c3e50',
      rotation: zone.label_rotation || 0, draggable: !planState.viewMode, listening: true
    });
    labelNode.offsetX(labelNode.width() / 2);
    labelNode.offsetY(labelNode.height() / 2);
    labelNode.on('click', (e) => {
      if (e.evt && e.evt.button !== undefined && e.evt.button !== 0) return;
      e.cancelBubble = true;
      selectNode(group);
    });
    labelNode.on('dragstart', () => {
      if (planState.panFrom) labelNode.stopDrag();
    });
    labelNode.on('dragend', async () => {
      const updated = await window.api.zones.updateLabel(zone.id, {
        name: zone.name, label_x: labelNode.x(), label_y: labelNode.y(),
        label_rotation: zone.label_rotation || 0, label_visible: 1
      });
      Object.assign(zone, updated);
      group.setAttr('zoneData', zone);
    });
    group.add(labelNode);
    group.setAttr('labelNode', labelNode);
  }

  planState.layer.add(group);
  group.moveToBottom(); // зоны всегда самый нижний слой, даже если добавлены позже стен
  planState.layer.draw();
  planState.zonesById.set(zone.id, group);
  return group;
}

/** Перерисовывает зону после смены имени/поворота/видимости подписи (проще, чем точечно
 *  чинить Text-ноду — тех же принципов придерживаемся в refreshLineItemVisual для двери) */
function refreshZoneVisual(zone) {
  const old = planState.zonesById.get(zone.id);
  const wasSelected = planState.selectedNode === old;
  if (old) old.destroy();
  const fresh = renderZone(zone);
  if (wasSelected) { planState.selectedNode = fresh; highlight(fresh); }
  planState.layer.draw();
  renderInspector(planState.selectedNode);
}

async function removeZone(id) {
  if (planState.viewMode) return;
  await window.api.zones.remove(id);
  const node = planState.zonesById.get(id);
  if (node) { node.destroy(); planState.zonesById.delete(id); }
  if (planState.selectedNode === node) { planState.selectedNode = null; renderInspector(null); }
  planState.layer.draw();
}

/** Зона, в клетке (x,y) которой находится точечный объект — для карточки устройства и для поиска */
function findZoneForCell(x, y) {
  let found = null;
  planState.zonesById.forEach((node) => {
    const zone = node.getAttr('zoneData');
    const cells = JSON.parse(zone.cells);
    if (cells.some(([cx, cy]) => cx === x && cy === y)) found = zone;
  });
  return found;
}

/** Все столы/устройства, чья клетка входит в зону — для инспектора зоны ("что внутри") */
function findItemsInZone(zone) {
  const cells = JSON.parse(zone.cells);
  const cellSet = new Set(cells.map(([x, y]) => `${x},${y}`));
  const result = [];
  planState.itemsById.forEach((node) => {
    const data = node.getAttr('itemData');
    if (!data || (data.item_type !== 'device' && data.item_type !== 'desk')) return;
    if (cellSet.has(`${data.x},${data.y}`)) result.push(data);
  });
  return result;
}

function renderZoneInspector(el, node) {
  const zone = node.getAttr('zoneData');
  el.appendChild(field('Тип', 'Зона'));
  el.appendChild(field('Площадь', `${JSON.parse(zone.cells).length} клеток`));

  const form = document.createElement('form');
  form.innerHTML = `
    <label class="span-2">Название <input name="name" required /></label>
    <label>Поворот названия, ° <input name="label_rotation" type="number" step="1" /></label>
    <label style="flex-direction:row; align-items:center; gap:6px;">
      <input type="checkbox" name="label_visible" style="width:auto" /> Показывать название
    </label>
  `;
  form.name.value = zone.name;
  form.label_rotation.value = zone.label_rotation || 0;
  form.label_visible.checked = !!zone.label_visible;

  const actions = document.createElement('div');
  actions.className = 'card-body-actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.textContent = 'Сохранить';
  const statusNote = document.createElement('span');
  statusNote.className = 'status-note';
  actions.append(saveBtn, statusNote);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const labelNode = node.getAttr('labelNode');
    const updated = await window.api.zones.updateLabel(zone.id, {
      name: fd.get('name'),
      label_x: labelNode ? labelNode.x() : zone.label_x,
      label_y: labelNode ? labelNode.y() : zone.label_y,
      label_rotation: Number(fd.get('label_rotation')) || 0,
      label_visible: form.label_visible.checked ? 1 : 0
    });
    Object.assign(zone, updated);
    statusNote.textContent = 'Сохранено ✓';
    refreshZoneVisual(zone);
  });

  form.appendChild(actions);
  el.appendChild(form);

  el.appendChild(sectionTitle('Объекты в зоне'));
  const itemsInZone = findItemsInZone(zone);
  const pingZoneBtn = document.createElement('button');
  pingZoneBtn.type = 'button';
  pingZoneBtn.textContent = '🔄📶 Обновить пинг в зоне';
  pingZoneBtn.onclick = () => pingManyDevices(itemsInZone.map((it) => it.id), `зона «${zone.name}»`);
  el.appendChild(pingZoneBtn);
  if (itemsInZone.length === 0) {
    el.appendChild(smallNote('Пусто'));
  } else {
    const ul = document.createElement('ul');
    ul.className = 'mini-list';
    itemsInZone.forEach((it) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = it.item_type === 'desk' ? 'Стол' : (it.device_hostname || it.device_type || '?');
      li.appendChild(label);
      if (it.item_type === 'device') {
        const openBtn = document.createElement('button');
        openBtn.textContent = '📇';
        openBtn.title = 'Открыть карточку устройства';
        openBtn.onclick = () => openDeviceCard(it.ref_id);
        li.appendChild(openBtn);
      }
      ul.appendChild(li);
    });
    el.appendChild(ul);
  }

  appendDeleteButton(el, () => removeZone(zone.id));
}

// ------------------------------------------------------------
// Общий обработчик кликов/движения по канве
// ------------------------------------------------------------

function handleStageClick(e) {
  if (e.evt && e.evt.button !== undefined && e.evt.button !== 0) return; // только левая кнопка — средняя занята панорамой

  const pointer = planState.stage.getRelativePointerPosition();
  const cellX = Math.round(pointer.x / CELL_PX);
  const cellY = Math.round(pointer.y / CELL_PX);

  if (planState.viewMode) {
    if (e.target === planState.stage) selectNode(null); // в просмотре доступно только снятие выделения
    return;
  }

  if (planState.mode === 'door') {
    // Не привязываемся к e.target: дверь ищет ближайшую стену по расстоянию,
    // а не по тому, что именно приняло клик (клик рядом со стеной обычно попадает в саму стену).
    handleDoorToolClick(pointer.x / CELL_PX, pointer.y / CELL_PX);
    return;
  }

  if (TWO_CLICK_TOOLS.includes(planState.mode)) {
    if (e.target !== planState.stage) return; // клик по существующему объекту в этом режиме игнорируем
    handleLineToolClick(cellX, cellY);
    return;
  }

  if (planState.mode === 'cable') {
    if (e.target === planState.stage && planState.cableDraft) {
      planState.cableDraft.waypoints.push({ x: cellX, y: cellY });
    }
    return;
  }

  if (e.target === planState.stage && planState.mode === 'desk') {
    placeNewItem(cellX, cellY);
  } else if (e.target === planState.stage) {
    selectNode(null);
  }
}

function handleStageMouseMove() {
  const pointer = planState.stage.getRelativePointerPosition();
  if (!pointer) return;

  if (planState.pendingLine) updateLinePreview(pointer);
  else if (planState.cableDraft) updateCablePreview(pointer);
  else if (planState.mode === 'door') updateDoorPreview(pointer);
  else if (planState.mode === 'desk') updateDeskPreview(pointer);
  else clearDeskPreview();
}

async function deleteSelected() {
  const node = planState.selectedNode;
  const kind = node.getAttr('kind');
  const id = node.getAttr('recordId');
  if (kind === 'cable') await removeCable(id);
  else if (kind === 'zone') await removeZone(id);
  else await removePlanItem(id);
}

// ------------------------------------------------------------
// Общие операции с точечными/линейными plan_items
// ------------------------------------------------------------

async function removePlanItem(id) {
  if (planState.viewMode) return;
  const node = planState.itemsById.get(id);
  const wasDevice = node && node.getAttr('itemData')?.item_type === 'device';
  await window.api.planItems.remove(id);
  if (node) { node.destroy(); planState.itemsById.delete(id); }
  // кабели, у которых этот item был концом, тоже осиротели в БД (ON DELETE CASCADE) — уберём их и с канвы
  const orphanCableIds = planState.cablesByItem.get(id) || [];
  orphanCableIds.forEach((cid) => {
    const line = planState.cablesById.get(cid);
    if (line) { line.destroy(); planState.cablesById.delete(cid); }
  });
  planState.cablesByItem.delete(id);
  if (planState.selectedNode === node) { planState.selectedNode = null; renderInspector(null); }
  planState.layer.draw();
  if (wasDevice) fillDevicePicker(); // освободившееся устройство должно снова появиться в кармане
}

async function placeNewItem(x, y) {
  if (planState.viewMode) return;
  if (planState.mode === 'desk') {
    const item = await window.api.planItems.create({ floor_plan_id: planState.floorPlan.id, item_type: 'desk', x, y });
    renderPointItem(item);
  }
}

/** Размещает устройство на плане в указанной клетке — вызывается из drop-обработчика кармана "Устройства" */
async function placeDeviceItem(deviceId, x, y) {
  if (planState.viewMode) return;
  const item = await window.api.planItems.create({
    floor_plan_id: planState.floorPlan.id, item_type: 'device', ref_id: deviceId, x, y
  });
  const device = devicesCache.find((d) => d.id === deviceId);
  item.device_type = device?.device_type;
  item.device_hostname = device?.hostname;
  item.device_ip = device?.primary_ip;
  item.last_ping_status = device?.last_ping_status;
  item.owner_user_id = device?.owner_user_id;
  item.owner_name = device?.owner_name;
  item.device_status = device?.status;
  item.device_flag = device?.flag;
  item.owner_status = device?.owner_status;
  renderPointItem(item);
  fillDevicePicker(); // размещённое устройство больше не должно предлагаться повторно
}

// ------------------------------------------------------------
// Тулбар
// ------------------------------------------------------------

function bindPlanToolbar() {
  const buttons = {
    desk: document.getElementById('mode-desk'),
    wall: document.getElementById('mode-wall'),
    door: document.getElementById('mode-door'),
    stairs: document.getElementById('mode-stairs'),
    cable: document.getElementById('mode-cable'),
    delete: document.getElementById('mode-delete')
  };
  const cancelBtn = document.getElementById('mode-cancel');
  const label = document.getElementById('plan-mode-label');

  const MODE_LABELS = {
    desk: 'клик по сетке добавит стол',
    wall: 'клик — начало стены, ещё клик — конец',
    door: 'клик рядом со стеной — дверь встроится в неё',
    stairs: 'клик — точка начала подъёма, ещё клик — направление (стрелка)',
    cable: 'клик по устройству/столу — начало кабеля; клики по пустому месту — точки маршрута; клик по второму устройству — завершение',
    delete: 'клик по элементу на плане удалит его'
  };

  function setMode(mode) {
    planState.mode = mode;
    Object.entries(buttons).forEach(([key, btn]) => btn.classList.toggle('active', key === mode));
    label.textContent = mode ? `Режим: ${MODE_LABELS[mode]}` : 'Режим: просмотр';
    label.style.color = '';
    clearPendingLine();
    cancelCableDraft();
    clearDoorPreview();
    clearDeskPreview();
  }

  Object.entries(buttons).forEach(([key, btn]) => {
    btn.addEventListener('click', () => setMode(planState.mode === key ? null : key));
  });
  cancelBtn.addEventListener('click', () => setMode(null));

  planState.setToolMode = setMode; // нужен переключателю режима просмотра — сбросить активный инструмент
}

let devicePickerCache = [];

async function fillDevicePicker() {
  const [all, placedIds] = await Promise.all([
    window.api.devices.list(),
    window.api.planItems.listPlacedDeviceIds()
  ]);
  const placedSet = new Set(placedIds);
  devicePickerCache = all.filter((d) => d.status !== 'decommissioned' && !placedSet.has(d.id));
  renderDeviceDragList(devicePickerCache);
}

function renderDeviceDragList(list) {
  const container = document.getElementById('device-drag-list');
  container.innerHTML = '';
  if (list.length === 0) { container.appendChild(smallListNote('Нет устройств')); return; }
  list.forEach((d) => {
    const div = document.createElement('div');
    div.className = 'device-drag-item';
    div.draggable = true;
    const badge = document.createElement('span');
    badge.className = 'wh-badge';
    badge.textContent = d.device_type;
    div.appendChild(badge);
    div.appendChild(document.createTextNode(d.hostname || '(без имени)'));
    div.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/json', JSON.stringify({ type: 'device', id: d.id }));
      e.dataTransfer.effectAllowed = 'copy';
    });
    container.appendChild(div);
  });
}

// ------------------------------------------------------------
// Перетаскивание пользователя/складской позиции на иконку ПК
// ------------------------------------------------------------

let userDragCache = [];

async function fillUserDragList() {
  const all = await window.api.users.list();
  userDragCache = all.filter((u) => u.status !== 'dismissed');
  renderUserDragList(userDragCache);
}

function renderUserDragList(users) {
  const container = document.getElementById('user-drag-list');
  container.innerHTML = '';
  if (users.length === 0) { container.appendChild(smallListNote('Нет пользователей')); return; }
  users.forEach((u) => {
    const div = document.createElement('div');
    div.className = 'user-drag-item';
    div.draggable = true;
    div.textContent = u.full_name;
    div.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/json', JSON.stringify({ type: 'user', id: u.id }));
      e.dataTransfer.effectAllowed = 'copy';
    });
    container.appendChild(div);
  });
}

let warehouseDragCache = [];

async function fillWarehouseDragList() {
  const all = await window.api.warehouse.list();
  warehouseDragCache = all.filter((w) => !w.removed_at); // только то, что реально лежит на складе
  renderWarehouseDragList(warehouseDragCache);
}

function renderWarehouseDragList(items) {
  const container = document.getElementById('warehouse-drag-list');
  container.innerHTML = '';
  if (items.length === 0) { container.appendChild(smallListNote('Склад пуст')); return; }
  items.forEach((w) => {
    const div = document.createElement('div');
    div.className = 'warehouse-drag-item';
    div.draggable = true;
    const badge = document.createElement('span');
    badge.className = 'wh-badge';
    badge.textContent = w.category === 'software' ? 'ПО' : COMPONENT_TYPE_LABELS[w.item_type] || w.item_type;
    div.appendChild(badge);
    div.appendChild(document.createTextNode(w.description));
    div.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/json', JSON.stringify({ type: 'warehouse', id: w.id }));
      e.dataTransfer.effectAllowed = 'copy';
    });
    container.appendChild(div);
  });
}

/** Единый поиск по всем карманам инструментов плана — вместо отдельного окошка на каждый список */
function applyPlanToolsSearch() {
  const q = document.getElementById('plan-tools-search').value.trim().toLowerCase();

  // Устройство подходит под запрос по своим полям — или по имени владельца
  const deviceMatchesQuery = (d) =>
    `${d.device_type} ${d.hostname || ''} ${d.primary_ip || ''} ${d.owner_name || ''}`.toLowerCase().includes(q);

  const matchedDevices = !q ? devicePickerCache : devicePickerCache.filter(deviceMatchesQuery);
  renderDeviceDragList(matchedDevices);

  // Пользователь подходит под запрос по своему имени — или если за ним закреплено
  // устройство, которое само подходит под запрос (тот же принцип, что и в обратную сторону)
  const matchedUsers = !q ? userDragCache : userDragCache.filter((u) => {
    if (u.full_name.toLowerCase().includes(q)) return true;
    return devicePickerCache.some((d) => d.owner_user_id === u.id && deviceMatchesQuery(d));
  });
  renderUserDragList(matchedUsers);

  renderWarehouseDragList(!q ? warehouseDragCache : warehouseDragCache.filter((w) =>
    `${w.description} ${w.item_type}`.toLowerCase().includes(q)));
}

/** Переводит координаты нативного drag-события (clientX/Y) в локальные координаты канвы,
 *  учитывая текущий зум/панораму стейджа. */
function clientToStagePoint(clientX, clientY) {
  const stage = planState.stage;
  const rect = stage.container().getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  return { x: (x - stage.x()) / stage.scaleX(), y: (y - stage.y()) / stage.scaleY() };
}

/** Находит устройство (не стол/стену), под точкой в локальных координатах канвы */
function findDeviceItemAtStagePoint(point) {
  let found = null;
  planState.itemsById.forEach((node, id) => {
    const data = node.getAttr('itemData');
    if (!data || data.item_type !== 'device') return;
    const x0 = node.x(), y0 = node.y();
    if (point.x >= x0 && point.x <= x0 + CELL_PX && point.y >= y0 && point.y <= y0 + CELL_PX) {
      found = { id, node, data };
    }
  });
  return found;
}

function bindUserDragDrop() {
  const container = document.getElementById('plan-stage'); // тот же элемент, что Konva берёт как container,
                                                             // но сам div не пересоздаётся при смене этажа —
                                                             // поэтому эту привязку достаточно сделать один раз
  document.getElementById('zone-drag-item').addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/json', JSON.stringify({ type: 'zone' }));
    e.dataTransfer.effectAllowed = 'copy';
  });

  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (planState.viewMode) { flashModeWarning('Режим просмотра — переключитесь на «✏️ Рисование», чтобы вносить изменения'); return; }
    let payload;
    try { payload = JSON.parse(e.dataTransfer.getData('application/json')); } catch { return; }
    if (!payload || !payload.type) return;

    const point = clientToStagePoint(e.clientX, e.clientY);

    if (payload.type === 'device') {
      if (!payload.id) return;
      const cellX = Math.round(point.x / CELL_PX);
      const cellY = Math.round(point.y / CELL_PX);
      await placeDeviceItem(payload.id, cellX, cellY);
      return;
    }

    if (payload.type === 'zone') {
      const cellX = Math.round(point.x / CELL_PX);
      const cellY = Math.round(point.y / CELL_PX);
      const cells = floodFillZone(cellX, cellY);
      if (!cells || cells.length === 0) { flashModeWarning(ZONE_FLOOD_TOOLTIP); return; }
      const name = await promptModal('Название зоны', 'Новая зона');
      if (!name) return;
      const zone = await window.api.zones.create({ floor_plan_id: planState.floorPlan.id, name, cells });
      renderZone(zone);
      return;
    }

    if (!payload.id) return;
    const target = findDeviceItemAtStagePoint(point);
    if (!target) { flashModeWarning('Отпустите точно на иконке устройства'); return; }

    if (payload.type === 'user') {
      await window.api.ownership.assign(target.data.ref_id, payload.id);
      const user = userDragCache.find((u) => u.id === payload.id);
      target.data.owner_user_id = payload.id;
      target.data.owner_name = user ? user.full_name : null;
      target.node.setAttr('itemData', target.data);
      refreshPointItemVisual(target.data);
      return; // refreshPointItemVisual уже перерисовал инспектор, если было выделено
    } else if (payload.type === 'warehouse') {
      await window.api.warehouse.issueToDevice(payload.id, target.data.ref_id);
      await fillWarehouseDragList(); // выданная позиция должна пропасть из кармана
      renderWarehouse();
      renderSoftwareRegistry(); // если выдали ПО — новая установка должна появиться в реестре
    }

    if (planState.selectedNode === target.node) renderInspector(target.node);
  });
}

// ------------------------------------------------------------
// Масштабирование
// ------------------------------------------------------------

function clampScale(s) { return Math.max(0.3, Math.min(3, s)); }

function updateZoomLabel(scale) {
  document.getElementById('zoom-label').textContent = `${Math.round(scale * 100)}%`;
}

function setZoom(newScale) {
  newScale = clampScale(newScale);
  const stage = planState.stage;
  const wrap = document.getElementById('plan-stage-wrap');
  const oldScale = stage.scaleX();
  const center = { x: wrap.clientWidth / 2, y: wrap.clientHeight / 2 };
  const relatedTo = { x: (center.x - stage.x()) / oldScale, y: (center.y - stage.y()) / oldScale };
  stage.scale({ x: newScale, y: newScale });
  stage.position({ x: center.x - relatedTo.x * newScale, y: center.y - relatedTo.y * newScale });
  stage.batchDraw();
  updateZoomLabel(newScale);
}

/** Кнопки зума — вешаем один раз, они всегда читают planState.stage на момент клика */
function bindZoomButtons() {
  document.getElementById('zoom-in').addEventListener('click', () => setZoom(planState.stage.scaleX() * 1.2));
  document.getElementById('zoom-out').addEventListener('click', () => setZoom(planState.stage.scaleX() / 1.2));
  document.getElementById('zoom-reset').addEventListener('click', () => {
    planState.stage.position({ x: 0, y: 0 });
    setZoom(1);
  });
  document.getElementById('ping-plan-btn').addEventListener('click', () => {
    pingManyDevices([...planState.itemsById.keys()], 'весь этаж');
  });
}

/** Кнопки видимости слоёв (0=стены/мебель, 1=кабели, 2=оборудование) — глобальная
 *  настройка вида, сохраняется при переключении этажей. Привязывается один раз. */
function bindLayerToggles() {
  document.querySelectorAll('.layer-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const layerNum = Number(btn.dataset.layer);
      planState.layerVisibility[layerNum] = !planState.layerVisibility[layerNum];
      btn.classList.toggle('active', planState.layerVisibility[layerNum]);
      applyLayerVisibility();
    });
  });
}

/** Применяет текущее planState.layerVisibility ко всем уже отрисованным объектам —
 *  вызывается и по клику на переключатель, и не нужна при создании новых объектов
 *  (те сами выставляют себе видимость при отрисовке, см. planLayerFor). */
function applyLayerVisibility() {
  planState.itemsById.forEach((node) => {
    const planLayer = node.getAttr('planLayer');
    if (planLayer !== null && planLayer !== undefined) node.visible(planState.layerVisibility[planLayer]);
  });
  planState.cablesById.forEach((line) => {
    line.visible(planState.layerVisibility[2]);
  });
  planState.zonesById.forEach((node) => {
    node.visible(planState.layerVisibility[0]);
  });
  if (planState.layer) planState.layer.batchDraw();
}

// ------------------------------------------------------------
// Переключатель "Рисование" / "Просмотр" — в просмотре элементы закреплены:
// нельзя двигать, удалять, создавать новые, что заодно исключает случайное
// изменение плана, если он открыт просто для справки.
// ------------------------------------------------------------

function bindModeSwitch() {
  document.getElementById('mode-switch-btn').addEventListener('click', () => {
    planState.viewMode = !planState.viewMode;
    updateModeSwitchUI();
  });
  updateModeSwitchUI(); // выставляем подпись кнопки сразу при старте
}

function updateModeSwitchUI() {
  const btn = document.getElementById('mode-switch-btn');
  const toolsAside = document.getElementById('plan-tools');
  if (planState.viewMode) {
    btn.textContent = '🔒 Просмотр';
    btn.classList.add('view-mode');
    toolsAside.classList.add('view-mode-locked');
    if (planState.setToolMode) planState.setToolMode(null); // текущий инструмент всё равно недоступен
  } else {
    btn.textContent = '✏️ Рисование';
    btn.classList.remove('view-mode');
    toolsAside.classList.remove('view-mode-locked');
  }

  // У уже отрисованных объектов включаем/выключаем перетаскивание "живьём",
  // не дожидаясь пересборки этажа
  planState.itemsById.forEach((node) => {
    if (node.getAttr('kind') === 'point') node.draggable(!planState.viewMode);
  });
  planState.zonesById.forEach((node) => {
    const label = node.getAttr('labelNode');
    if (label) label.draggable(!planState.viewMode);
  });
}

/** Колесо мыши висит на конкретном объекте Stage — перевешиваем при каждой пересборке стейджа
 *  (переключение этажа создаёт новый Stage), иначе на старом объекте всё равно ничего не сработает,
 *  а вешать через bindZoomButtons() было бы дублированием при каждом переключении. */
function bindZoomWheel() {
  planState.stage.on('wheel', (e) => {
    e.evt.preventDefault();
    const stage = planState.stage;
    const oldScale = stage.scaleX();
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    const mousePointTo = { x: (pointer.x - stage.x()) / oldScale, y: (pointer.y - stage.y()) / oldScale };
    const direction = e.evt.deltaY > 0 ? -1 : 1;
    const newScale = clampScale(direction > 0 ? oldScale / 1.08 : oldScale * 1.08);
    stage.scale({ x: newScale, y: newScale });
    stage.position({ x: pointer.x - mousePointTo.x * newScale, y: pointer.y - mousePointTo.y * newScale });
    stage.batchDraw();
    updateZoomLabel(newScale);
  });
}

/** Панорамирование зажатой средней кнопкой мыши (колесо) — привязывается на каждый новый Stage,
 *  как и bindZoomWheel: событие живёт на конкретном объекте Stage, который пересоздаётся при смене этажа. */
function bindMiddleClickPan() {
  const stage = planState.stage;

  stage.on('mousedown', (e) => {
    if (e.evt.button !== 1) return; // средняя кнопка
    e.evt.preventDefault();
    planState.panFrom = {
      x: e.evt.clientX, y: e.evt.clientY,
      stageX: stage.x(), stageY: stage.y()
    };
    stage.container().style.cursor = 'grabbing';
  });

  stage.on('mousemove', (e) => {
    if (!planState.panFrom) return;
    const evt = e.evt;
    const dx = evt.clientX - planState.panFrom.x;
    const dy = evt.clientY - planState.panFrom.y;
    stage.position({ x: planState.panFrom.stageX + dx, y: planState.panFrom.stageY + dy });
    stage.batchDraw();
  });

  const stopPan = (e) => {
    if (e.button !== undefined && e.button !== 1) return;
    if (!planState.panFrom) return;
    planState.panFrom = null;
    stage.container().style.cursor = '';
  };
  stage.container().addEventListener('mouseup', stopPan);
  window.addEventListener('mouseup', stopPan); // если отпустили кнопку за пределами канвы
}

// ------------------------------------------------------------
// Поиск по плану (рядом с зумом): фильтрация иконок + история запросов
// ------------------------------------------------------------

const SEARCH_HISTORY_KEY = 'networkmap.planSearchHistory';
const SEARCH_HISTORY_LIMIT = 10;
const searchToolState = { caseSensitive: false, wildcard: false };

function loadSearchHistory() {
  try { return JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]'); }
  catch { return []; }
}

function saveSearchHistory(list) {
  try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(list.slice(0, SEARCH_HISTORY_LIMIT))); }
  catch { /* localStorage недоступен — история просто не сохранится между запусками */ }
}

function pushSearchHistory(query) {
  if (!query) return;
  const list = [query, ...loadSearchHistory().filter((q) => q !== query)];
  saveSearchHistory(list);
  renderSearchHistory();
}

function renderSearchHistory() {
  const list = loadSearchHistory();
  const el = document.getElementById('plan-search-history-list');
  el.innerHTML = '';
  if (list.length === 0) {
    const li = document.createElement('li');
    li.className = 'search-history-empty';
    li.textContent = 'История пуста';
    el.appendChild(li);
    return;
  }
  list.forEach((q) => {
    const li = document.createElement('li');
    li.textContent = q;
    li.onclick = () => {
      document.getElementById('plan-search-input').value = q;
      runPlanSearch(q);
      toggleSearchHistory(false);
    };
    el.appendChild(li);
  });
}

function toggleSearchHistory(force) {
  const list = document.getElementById('plan-search-history-list');
  const show = force !== undefined ? force : list.classList.contains('hidden');
  list.classList.toggle('hidden', !show);
}

/** Простой wildcard (* = любые символы, ? = один символ) переводим в RegExp */
function wildcardToRegex(pattern, caseSensitive) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(escaped, caseSensitive ? '' : 'i');
}

function matchesQuery(text, query, state) {
  if (!text) return false;
  if (state.wildcard) return wildcardToRegex(query, state.caseSensitive).test(text);
  if (state.caseSensitive) return text.includes(query);
  return text.toLowerCase().includes(query.toLowerCase());
}

function searchHaystackFor(item) {
  if (item.item_type === 'device') {
    const zone = findZoneForCell(item.x, item.y);
    return [item.device_hostname, item.device_ip, item.device_inventory_number, item.device_type, item.owner_name, zone ? zone.name : null]
      .filter(Boolean).join(' ');
  }
  if (item.item_type === 'desk') return 'Стол';
  if (item.item_type === 'stairs') return 'Лестница';
  return '';
}

/** Подсвечивает совпадения на плане (приглушает остальное) и центрирует на первом найденном.
 *  Только фильтрует — в историю поиска ничего не пишет (это отдельный, дебаунсенный шаг). */
function runPlanSearch(query) {
  query = query.trim();
  let firstMatch = null;

  planState.itemsById.forEach((node) => {
    const data = node.getAttr('itemData');
    if (!data) return; // стены не участвуют в поиске
    const isMatch = query.length > 0 && matchesQuery(searchHaystackFor(data), query, searchToolState);
    node.opacity(query.length === 0 || isMatch ? 1 : 0.2);
    if (isMatch && !firstMatch) firstMatch = node;
  });

  // Зоны ищутся по названию отдельно — можно найти саму зону, а не только то, что в ней стоит
  planState.zonesById.forEach((node) => {
    const zone = node.getAttr('zoneData');
    const isMatch = query.length > 0 && matchesQuery(zone.name, query, searchToolState);
    // opacity группы множится с уже заданной opacity:0.28 самой заливки —
    // 1 оставляет её как есть, малое значение делает почти невидимой при непопадании в фильтр
    node.opacity(query.length === 0 || isMatch ? 1 : 0.3);
    if (isMatch && !firstMatch) firstMatch = node;
  });

  planState.layer.draw();

  if (firstMatch) focusOnNode(firstMatch);
}

function focusOnNode(node) {
  const stage = planState.stage;
  const targetScale = Math.max(stage.scaleX(), 1);
  setZoom(targetScale);
  const wrap = document.getElementById('plan-stage-wrap');
  wrap.scrollLeft = 0;
  wrap.scrollTop = 0;
  const center = { x: wrap.clientWidth / 2, y: wrap.clientHeight / 2 };
  const nodeCenter = node.getAttr('kind') === 'zone'
    ? computeZoneCentroidPx(JSON.parse(node.getAttr('zoneData').cells))
    : { x: node.x() + CELL_PX / 2, y: node.y() + CELL_PX / 2 };
  stage.position({ x: center.x - nodeCenter.x * stage.scaleX(), y: center.y - nodeCenter.y * stage.scaleY() });
  stage.batchDraw();
}

function clearPlanSearch() {
  document.getElementById('plan-search-input').value = '';
  planState.itemsById.forEach((node) => node.opacity(1));
  planState.layer.draw();
}

function bindPlanSearch() {
  const input = document.getElementById('plan-search-input');
  const clearBtn = document.getElementById('plan-search-clear');
  const caseBtn = document.getElementById('plan-search-case');
  const wildcardBtn = document.getElementById('plan-search-wildcard');
  const historyToggle = document.getElementById('plan-search-history-toggle');
  const historyWrap = document.getElementById('plan-search-history-wrap');

  let historyDebounce = null;
  const HISTORY_DEBOUNCE_MS = 900;

  const commitHistory = () => {
    clearTimeout(historyDebounce);
    const value = input.value.trim();
    if (value) pushSearchHistory(value);
  };

  input.addEventListener('input', () => {
    runPlanSearch(input.value);
    clearTimeout(historyDebounce);
    if (input.value.trim()) historyDebounce = setTimeout(commitHistory, HISTORY_DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { runPlanSearch(input.value); commitHistory(); } });
  input.addEventListener('blur', commitHistory);

  clearBtn.addEventListener('click', () => clearPlanSearch());

  caseBtn.addEventListener('click', () => {
    searchToolState.caseSensitive = !searchToolState.caseSensitive;
    caseBtn.classList.toggle('active', searchToolState.caseSensitive);
    runPlanSearch(input.value);
  });

  wildcardBtn.addEventListener('click', () => {
    searchToolState.wildcard = !searchToolState.wildcard;
    wildcardBtn.classList.toggle('active', searchToolState.wildcard);
    runPlanSearch(input.value);
  });

  historyToggle.addEventListener('click', (e) => { e.stopPropagation(); toggleSearchHistory(); });
  document.addEventListener('click', (e) => {
    if (!historyWrap.contains(e.target)) toggleSearchHistory(false);
  });

  renderSearchHistory();
}

// ------------------------------------------------------------
// Инспектор (правая панель)
// ------------------------------------------------------------

function selectNode(node) {
  if (planState.selectedNode) unhighlight(planState.selectedNode);
  planState.selectedNode = node;
  if (node) { highlight(node); renderInspector(node); }
  else renderInspector(null);
  planState.layer.draw();
}

function highlight(node) {
  const kind = node.getAttr('kind');
  if (kind === 'point') node.findOne('Rect').stroke('#ff9900');
  else if (kind === 'line') node.getChildren()[0].stroke('#ff9900');
  else if (kind === 'cable') node.stroke('#ff9900');
  else if (kind === 'zone') { const s = node.getAttr('shapeNode'); s.stroke('#ff9900'); s.strokeWidth(2); }
}

function unhighlight(node) {
  const kind = node.getAttr('kind');
  if (kind === 'point') node.findOne('Rect').stroke('#333');
  else if (kind === 'line') node.getChildren()[0].stroke(lineColor(node.getAttr('itemData').item_type));
  else if (kind === 'cable') node.stroke(CABLE_COLOR);
  else if (kind === 'zone') { const s = node.getAttr('shapeNode'); s.stroke(undefined); s.strokeWidth(0); }
}

function renderInspector(node) {
  const el = document.getElementById('inspector-content');
  if (!node) { el.innerHTML = ''; el.className = 'inspector-empty'; el.textContent = 'Ничего не выбрано'; return; }

  el.className = '';
  el.innerHTML = '';
  const kind = node.getAttr('kind');

  if (kind === 'point') {
    const item = node.getAttr('itemData');
    if (item.item_type === 'desk') {
      el.appendChild(field('Тип', 'Стол'));
      el.appendChild(field('Координаты', `x=${item.x}, y=${item.y}`));
      if (item.review_note) el.appendChild(field('⚠️ На проверку', item.review_note));
    } else {
      el.appendChild(field('Тип', `Устройство (${item.device_type || '—'})`));
      el.appendChild(field('Hostname', item.device_hostname || '—'));
      el.appendChild(field('IP-адрес', item.device_ip || '—'));
      el.appendChild(field('Статус пинга', pingStatusLabel(item.last_ping_status)));
      el.appendChild(field('Координаты', `x=${item.x}, y=${item.y}`));
      const itemZone = findZoneForCell(item.x, item.y);
      if (itemZone) el.appendChild(field('Зона', itemZone.name));
      if (item.review_note) el.appendChild(field('⚠️ На проверку', item.review_note));
      if (item.device_ip) appendPingButton(el, item);
      if (item.device_type === 'router' || item.device_type === 'switch') {
        const pingConnectedBtn = document.createElement('button');
        pingConnectedBtn.type = 'button';
        pingConnectedBtn.className = 'tool-btn';
        pingConnectedBtn.textContent = '🔄📶 Пинг подключённых устройств';
        pingConnectedBtn.title = 'Обход по уже нарисованным кабелям от этого устройства';
        pingConnectedBtn.onclick = () => pingManyDevices(getConnectedDeviceIds(item.id), item.device_hostname || 'сеть');
        el.appendChild(pingConnectedBtn);
      }

      const openCardBtn = document.createElement('button');
      openCardBtn.type = 'button';
      openCardBtn.className = 'tool-btn';
      openCardBtn.textContent = '📇 Открыть карточку устройства';
      openCardBtn.onclick = () => openDeviceCard(item.ref_id);
      el.appendChild(openCardBtn);

      const ownerField = field('Владелец', item.owner_name || '— перетащите пользователя на иконку');
      el.appendChild(ownerField);
      if (item.owner_user_id) {
        const openOwnerBtn = document.createElement('button');
        openOwnerBtn.type = 'button';
        openOwnerBtn.className = 'tool-btn';
        openOwnerBtn.textContent = '👤 Открыть карточку пользователя';
        openOwnerBtn.onclick = () => openUserCard(item.owner_user_id);
        el.appendChild(openOwnerBtn);

        const unassignBtn = document.createElement('button');
        unassignBtn.textContent = 'Открепить пользователя';
        unassignBtn.className = 'tool-btn';
        unassignBtn.onclick = async () => {
          await window.api.ownership.unassign(item.ref_id);
          item.owner_user_id = null;
          item.owner_name = null;
          node.setAttr('itemData', item);
          refreshPointItemVisual(item);
        };
        el.appendChild(unassignBtn);
      }

      const extras = document.createElement('div');
      extras.id = 'inspector-extras';
      extras.textContent = 'Загрузка…';
      el.appendChild(extras);
      renderDeviceExtras(extras, item.ref_id);
    }
    appendDeleteButton(el, () => removePlanItem(item.id));
  } else if (kind === 'line') {
    const item = node.getAttr('itemData');
    const typeLabels = { wall: 'Стена', door: 'Дверь', stairs: 'Лестница' };
    el.appendChild(field('Тип', typeLabels[item.item_type] || item.item_type));

    if (item.item_type === 'stairs') {
      const x1 = Math.min(item.x, item.x2), y1 = Math.min(item.y, item.y2);
      const x2m = Math.max(item.x, item.x2), y2m = Math.max(item.y, item.y2);
      el.appendChild(field('Область', `(${x1},${y1}) — (${x2m},${y2m})`));
      el.appendChild(field('Размер', `${x2m - x1}×${y2m - y1} клеток`));
      el.appendChild(field('Направление подъёма', rotationLabel(item.rotation || 0)));
    } else {
      el.appendChild(field('Начало', `x=${item.x}, y=${item.y}`));
      el.appendChild(field('Конец', `x=${item.x2}, y=${item.y2}`));
    }

    if (item.item_type === 'door') {
      const actions = document.createElement('div');
      actions.className = 'card-body-actions';
      const flipBtn = document.createElement('button');
      flipBtn.type = 'button';
      flipBtn.textContent = '↔ Развернуть';
      flipBtn.title = 'В какую сторону стены открывается';
      flipBtn.onclick = () => toggleDoorVariant(item, 2);
      const mirrorBtn = document.createElement('button');
      mirrorBtn.type = 'button';
      mirrorBtn.textContent = '⇋ Отразить';
      mirrorBtn.title = 'С какого края петля';
      mirrorBtn.onclick = () => toggleDoorVariant(item, 1);
      actions.append(flipBtn, mirrorBtn);
      el.appendChild(actions);
    }

    appendDeleteButton(el, () => removePlanItem(item.id));
  } else if (kind === 'cable') {
    const cable = node.getAttr('cableData');
    el.appendChild(field('Тип', 'Сетевой кабель'));
    el.appendChild(field('Точек маршрута', String(JSON.parse(cable.waypoints || '[]').length)));
    appendDeleteButton(el, () => removeCable(cable.id));
  } else if (kind === 'zone') {
    renderZoneInspector(el, node);
  }
}

/** Меняет один из двух битов rotation, кодирующих hinge/swing двери, перерисовывает и обновляет инспектор */
async function toggleDoorVariant(item, bitMask) {
  const variant = Math.round((item.rotation || 0) / 90) % 4;
  const newRotation = ((variant ^ bitMask) % 4) * 90;
  const updated = await window.api.planItems.setRotation(item.id, newRotation);
  item.rotation = updated.rotation;
  refreshLineItemVisual(item);
}

/** Перерисовывает уже существующий линейный объект (напр. после смены rotation у двери) */
function refreshLineItemVisual(item) {
  const old = planState.itemsById.get(item.id);
  const wasSelected = planState.selectedNode === old;
  if (old) old.destroy();
  const fresh = renderLineItem(item);
  if (wasSelected) { planState.selectedNode = fresh; highlight(fresh); }
  planState.layer.draw();
  renderInspector(planState.selectedNode);
}

/** Тот же паттерн для точечных объектов — нужен после смены владельца устройства,
 *  раз имя владельца теперь показывается прямо на иконке плана, а не только в инспекторе */
function refreshPointItemVisual(item) {
  const old = planState.itemsById.get(item.id);
  const wasSelected = planState.selectedNode === old;
  if (old) old.destroy();
  const fresh = renderPointItem(item);
  if (wasSelected) { planState.selectedNode = fresh; highlight(fresh); }
  planState.layer.draw();
  if (wasSelected) renderInspector(fresh);
}

/** Подтягивает изменения устройства (hostname/тип/IP и т.п.) на его иконку(и) плана —
 *  вызывается после сохранения карточки на листе "Устройства". Затрагивает только
 *  текущий открытый этаж (planState.itemsById); остальные этажи и так подгрузят
 *  свежие данные из БД при следующем переключении на них. */
function syncPlanDeviceIcon(deviceId, patch) {
  planState.itemsById.forEach((node) => {
    const data = node.getAttr('itemData');
    if (!data || data.item_type !== 'device' || data.ref_id !== deviceId) return;
    Object.assign(data, patch);
    node.setAttr('itemData', data);
    refreshPointItemVisual(data);
  });
}

/** То же самое для смены имени пользователя — обновляет подпись владельца на иконках
 *  тех устройств, что сейчас на него закреплены. Вызывается после сохранения карточки
 *  на листе "Пользователи". */
function syncPlanOwnerName(userId, newName) {
  planState.itemsById.forEach((node) => {
    const data = node.getAttr('itemData');
    if (!data || data.item_type !== 'device' || data.owner_user_id !== userId) return;
    data.owner_name = newName;
    node.setAttr('itemData', data);
    refreshPointItemVisual(data);
  });
}

/** Увольнение/восстановление пользователя должно сразу показать/убрать авто-флаг
 *  "Внимание" на иконках устройств, которыми он владеет, без перезагрузки этажа */
function syncPlanOwnerStatus(userId, newStatus) {
  planState.itemsById.forEach((node) => {
    const data = node.getAttr('itemData');
    if (!data || data.item_type !== 'device' || data.owner_user_id !== userId) return;
    data.owner_status = newStatus;
    node.setAttr('itemData', data);
    refreshPointItemVisual(data);
  });
}

function appendPingButton(el, item) {
  const pingBtn = document.createElement('button');
  pingBtn.textContent = 'Пинговать';
  pingBtn.className = 'tool-btn';
  const status = document.createElement('div');
  status.className = 'inspector-ping-status';
  pingBtn.onclick = async () => {
    status.textContent = '...';
    const result = await window.api.ping.run(item.ref_id, item.device_ip);
    status.textContent = `${result.status}${result.responseTimeMs ? ' (' + result.responseTimeMs + ' ms)' : ''}`;
    updatePingBadge(item.id, result.status);
  };
  el.appendChild(pingBtn);
  el.appendChild(status);
}

function appendDeleteButton(el, onClick) {
  const actions = document.createElement('div');
  actions.className = 'inspector-actions';
  const delBtn = document.createElement('button');
  delBtn.textContent = 'Удалить';
  delBtn.className = 'danger';
  delBtn.onclick = onClick;
  actions.appendChild(delBtn);
  el.appendChild(actions);
}

function field(label, value) {
  const wrap = document.createElement('div');
  wrap.className = 'inspector-field';
  const l = document.createElement('label');
  l.textContent = label;
  const v = document.createElement('div');
  v.className = 'value';
  v.textContent = value;
  wrap.appendChild(l);
  wrap.appendChild(v);
  return wrap;
}

// ------------------------------------------------------------
// Инспектор устройства: история владения, комплектующие, периферия
// ------------------------------------------------------------

async function renderDeviceExtras(container, deviceId, onChanged = () => renderInspector(planState.selectedNode)) {
  const [history, components, peripherals, software, statusHistory] = await Promise.all([
    window.api.ownership.history(deviceId),
    window.api.components.list(deviceId),
    window.api.peripherals.list(deviceId),
    window.api.software.list(deviceId),
    window.api.devices.statusHistory(deviceId)
  ]);

  container.innerHTML = '';

  container.appendChild(sectionTitle('История владельцев'));
  if (history.length === 0) {
    container.appendChild(smallNote('Нет записей'));
  } else {
    const ul = document.createElement('ul');
    ul.className = 'mini-list';
    history.forEach((h) => {
      const li = document.createElement('li');
      const period = h.unassigned_at
        ? `${h.assigned_at || '?'} → ${h.unassigned_at}`
        : `с ${h.assigned_at || '?'} (текущий)`;
      li.textContent = `${h.user_name} — ${period}`;
      ul.appendChild(li);
    });
    container.appendChild(ul);
  }

  container.appendChild(sectionTitle('Комплектующие'));
  container.appendChild(buildAttachableList(components, COMPONENT_TYPE_LABELS,
    async (id) => { await window.api.warehouse.receiveComponent(id); fillWarehouseDragList(); renderWarehouse(); },
    { detachLabel: 'На склад', extraText: (r) => (r.cost != null ? ` — ${r.cost}` : ''), onChanged }));
  container.appendChild(buildComponentAddForm(deviceId, onChanged));

  container.appendChild(sectionTitle('Периферия'));
  container.appendChild(buildAttachableList(peripherals, PERIPHERAL_TYPE_LABELS,
    (id) => window.api.peripherals.detach(id), { onChanged }));
  container.appendChild(buildAddForm(
    Object.keys(PERIPHERAL_TYPE_LABELS), PERIPHERAL_TYPE_LABELS,
    (type, description) => window.api.peripherals.add({ device_id: deviceId, peripheral_type: type, description }),
    onChanged
  ));

  container.appendChild(sectionTitle('Программное обеспечение'));
  container.appendChild(buildAttachableList(software, SOFTWARE_TYPE_LABELS,
    async (id) => {
      await window.api.warehouse.receiveSoftware(id);
      fillWarehouseDragList();
      renderWarehouse();
      renderSoftwareRegistry(); // снятое ПО должно пропасть из реестра действующих установок
    },
    {
      closedField: 'removed_at',
      detachLabel: 'На склад',
      nameField: 'name',
      extraText: (r) => [r.license_key ? ` — ключ: ${r.license_key}` : '', r.cost != null ? ` — ${r.cost}` : ''].join(''),
      onChanged
    }));
  container.appendChild(buildSoftwareAddForm(deviceId, onChanged));

  container.appendChild(sectionTitle('История статусов'));
  if (statusHistory.length === 0) {
    container.appendChild(smallNote('Нет записей'));
  } else {
    const ul = document.createElement('ul');
    ul.className = 'mini-list';
    statusHistory.forEach((s) => {
      const li = document.createElement('li');
      li.textContent = `${s.status} — ${s.changed_at}${s.note ? ' (' + s.note + ')' : ''}`;
      ul.appendChild(li);
    });
    container.appendChild(ul);
  }
}

function sectionTitle(text) {
  const h = document.createElement('div');
  h.className = 'inspector-section-title';
  h.textContent = text;
  return h;
}

function smallNote(text) {
  const d = document.createElement('div');
  d.className = 'inspector-empty-note';
  d.textContent = text;
  return d;
}

/** Список комплектующих/периферии/ПО: активные с кнопкой снятия, снятые/сданные — приглушены, без кнопки.
 *  options.closedField — какое поле считать "закрыто" (detached_at по умолчанию, у ПО — removed_at);
 *  options.nameField — откуда брать текст (description по умолчанию, у ПО — name);
 *  options.detachLabel — подпись кнопки; options.extraText(row) — доп. текст (напр. ключ лицензии). */
function buildAttachableList(rows, typeLabels, onDetach, options = {}) {
  const closedField = options.closedField || 'detached_at';
  const nameField = options.nameField || 'description';
  const detachLabel = options.detachLabel || 'Снять';
  const extraText = options.extraText || (() => '');
  const onChanged = options.onChanged || (() => renderInspector(planState.selectedNode));

  const ul = document.createElement('ul');
  ul.className = 'mini-list';
  if (rows.length === 0) { ul.appendChild(smallNote('Нет данных')); return ul; }
  rows.forEach((r) => {
    const li = document.createElement('li');
    const isClosed = !!r[closedField];
    if (isClosed) li.className = 'detached';
    const label = document.createElement('span');
    const typeKey = r.component_type || r.peripheral_type || r.software_type;
    label.textContent = `[${typeLabels[typeKey] || typeKey}] ${r[nameField]}${extraText(r)}`;
    li.appendChild(label);
    if (!isClosed) {
      const btn = document.createElement('button');
      btn.textContent = detachLabel;
      btn.onclick = async () => { await onDetach(r.id); onChanged(); };
      li.appendChild(btn);
    }
    ul.appendChild(li);
  });
  return ul;
}

function buildAddForm(types, typeLabels, onAdd, onChanged = () => renderInspector(planState.selectedNode)) {
  const form = document.createElement('div');
  form.className = 'inspector-add-form';

  const typeSelect = document.createElement('select');
  types.forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = typeLabels[t];
    typeSelect.appendChild(opt);
  });

  const descInput = document.createElement('input');
  descInput.placeholder = 'Описание';

  const addBtn = document.createElement('button');
  addBtn.textContent = '+';
  addBtn.title = 'Добавить';
  addBtn.onclick = async () => {
    const description = descInput.value.trim();
    if (!description) return;
    await onAdd(typeSelect.value, description);
    onChanged();
  };

  form.appendChild(typeSelect);
  form.appendChild(descInput);
  form.appendChild(addBtn);
  return form;
}

/** Форма добавления ПО — как buildAddForm, но с дополнительным полем лицензионного ключа */
function buildSoftwareAddForm(deviceId, onChanged = () => renderInspector(planState.selectedNode)) {
  const form = document.createElement('div');
  form.className = 'inspector-add-form';

  const typeSelect = document.createElement('select');
  Object.keys(SOFTWARE_TYPE_LABELS).forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = SOFTWARE_TYPE_LABELS[t];
    typeSelect.appendChild(opt);
  });

  const nameInput = document.createElement('input');
  nameInput.placeholder = 'Название (Windows 10…)';
  const keyInput = document.createElement('input');
  keyInput.placeholder = 'Ключ (необязательно)';
  const costInput = document.createElement('input');
  costInput.type = 'number'; costInput.step = '0.01'; costInput.min = '0';
  costInput.placeholder = 'Стоимость';
  costInput.style.width = '80px';

  const addBtn = document.createElement('button');
  addBtn.textContent = '+';
  addBtn.title = 'Добавить';
  addBtn.onclick = async () => {
    const name = nameInput.value.trim();
    if (!name) return;
    await window.api.software.add({
      device_id: deviceId, software_type: typeSelect.value, name,
      license_key: keyInput.value.trim() || null,
      cost: costInput.value ? Number(costInput.value) : null
    });
    onChanged();
    renderSoftwareRegistry();
  };

  form.appendChild(typeSelect);
  form.appendChild(nameInput);
  form.appendChild(keyInput);
  form.appendChild(costInput);
  form.appendChild(addBtn);
  return form;
}

/** Форма добавления комплектующей — как buildAddForm, но с полем стоимости */
function buildComponentAddForm(deviceId, onChanged = () => renderInspector(planState.selectedNode)) {
  const form = document.createElement('div');
  form.className = 'inspector-add-form';

  const typeSelect = document.createElement('select');
  Object.keys(COMPONENT_TYPE_LABELS).forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = COMPONENT_TYPE_LABELS[t];
    typeSelect.appendChild(opt);
  });

  const descInput = document.createElement('input');
  descInput.placeholder = 'Описание';
  const costInput = document.createElement('input');
  costInput.type = 'number'; costInput.step = '0.01'; costInput.min = '0';
  costInput.placeholder = 'Стоимость';
  costInput.style.width = '80px';

  const addBtn = document.createElement('button');
  addBtn.textContent = '+';
  addBtn.title = 'Добавить';
  addBtn.onclick = async () => {
    const description = descInput.value.trim();
    if (!description) return;
    await window.api.components.add({
      device_id: deviceId, component_type: typeSelect.value, description,
      cost: costInput.value ? Number(costInput.value) : null
    });
    onChanged();
  };

  form.appendChild(typeSelect);
  form.appendChild(descInput);
  form.appendChild(costInput);
  form.appendChild(addBtn);
  return form;
}

// ============================================================
// Подключение к базе данных (локальный файл или сетевой путь)
// ============================================================

async function refreshDbSettingsInfo() {
  const info = await window.api.settings.getDbInfo();
  document.getElementById('db-current-path').textContent = info.path || '—';

  const badge = document.getElementById('db-current-badge');
  badge.textContent = info.isDefault ? 'по умолчанию' : 'своя (сетевая или другая)';
  badge.classList.toggle('custom', !info.isDefault);

  const warningEl = document.getElementById('db-warning-note');
  if (info.warning) {
    warningEl.textContent = `⚠ ${info.warning}`;
    warningEl.classList.remove('hidden');
  } else {
    warningEl.classList.add('hidden');
  }
  return info;
}

function bindDbSettingsModal() {
  const overlay = document.getElementById('db-settings-modal');
  const statusNote = document.getElementById('db-status-note');

  document.getElementById('db-settings-btn').addEventListener('click', async () => {
    statusNote.textContent = '';
    await refreshDbSettingsInfo();
    overlay.classList.remove('hidden');
  });
  document.getElementById('db-settings-close').addEventListener('click', () => overlay.classList.add('hidden'));

  async function connectAndRelaunch(filePath, confirmText) {
    if (!confirm(confirmText)) return;
    statusNote.textContent = 'Подключение…';
    const result = await window.api.settings.connectDb(filePath);
    // При успехе главный процесс перезапускает приложение сам — сюда управление не вернётся.
    // Если result вообще пришёл — значит подключиться не удалось.
    if (result && result.success === false) {
      statusNote.textContent = `Ошибка: ${result.error}`;
    }
  }

  document.getElementById('db-pick-existing-btn').addEventListener('click', async () => {
    const filePath = await window.api.settings.pickExistingDbFile();
    if (!filePath) return;
    await connectAndRelaunch(filePath, `Подключиться к базе данных по пути:\n${filePath}\n\nПриложение перезапустится.`);
  });

  document.getElementById('db-pick-new-btn').addEventListener('click', async () => {
    const filePath = await window.api.settings.pickNewDbLocation();
    if (!filePath) return;
    await connectAndRelaunch(filePath, `Создать новую пустую базу данных здесь и переключиться на неё:\n${filePath}\n\nПриложение перезапустится.`);
  });

  document.getElementById('db-reset-btn').addEventListener('click', async () => {
    if (!confirm('Вернуться к локальной базе данных по умолчанию? Приложение перезапустится.')) return;
    statusNote.textContent = 'Переключение…';
    const result = await window.api.settings.resetDb();
    if (result && result.success === false) {
      statusNote.textContent = `Ошибка: ${result.error}`;
    }
  });
}


initTabs();
window.api.app.version().then((v) => { document.getElementById('app-version').textContent = `v${v}`; });
bindDbSettingsModal();
window.api.settings.getDbInfo().then((info) => {
  if (info.warning) {
    const btn = document.getElementById('db-settings-btn');
    btn.classList.add('has-warning');
    btn.title = info.warning;
  }
});
renderUsers();
renderDevices();
renderWarehouse();
renderSoftwareRegistry();
initPlan();
