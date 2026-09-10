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
      if (btn.dataset.tab === 'network') renderNetworkTab();
      if (btn.dataset.tab === 'audit') loadAuditLog();
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

/** Модальное подтверждение — замена window.confirm(). Нативный confirm() в Electron
 *  периодически оставляет интерфейс намертво заблокированным (все клики "проваливаются",
 *  помогает только перезапуск приложения) — именно так проявлял себя баг после увольнения
 *  пользователя. Возвращает Promise<boolean> вместо синхронного значения — вызывающий код
 *  должен быть async и делать await. */
function confirmModal(message) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirm-modal');
    const okBtn = document.getElementById('confirm-modal-ok');
    const cancelBtn = document.getElementById('confirm-modal-cancel');
    document.getElementById('confirm-modal-title').textContent = message;
    overlay.classList.remove('hidden');
    okBtn.focus();

    const cleanup = (result) => {
      overlay.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('keydown', onKeydown);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onKeydown = (e) => {
      if (e.key === 'Enter') onOk();
      if (e.key === 'Escape') onCancel();
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('keydown', onKeydown);
  });
}

/** Модальное уведомление — замена window.alert(), по той же причине. */
function alertModal(message) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('alert-modal');
    const okBtn = document.getElementById('alert-modal-ok');
    document.getElementById('alert-modal-title').textContent = message;
    overlay.classList.remove('hidden');
    okBtn.focus();

    const cleanup = () => {
      overlay.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      overlay.removeEventListener('keydown', onKeydown);
      resolve();
    };
    const onOk = () => cleanup();
    const onKeydown = (e) => { if (e.key === 'Enter' || e.key === 'Escape') onOk(); };

    okBtn.addEventListener('click', onOk);
    overlay.addEventListener('keydown', onKeydown);
  });
}

/** Модалка разрешения расхождений при импорте сведений о ПК (см. scripts/collect-pc-info.ps1).
 *  position/total — номер файла и всего файлов для прогресса в пакетном импорте (null/null
 *  для одиночного импорта из карточки устройства). Возвращает Promise<{action, fieldChoices}>,
 *  где action: 'apply' | 'skip' | 'apply-all-old' | 'apply-all-new' (два последних — только
 *  в пакетном режиме, задают политику для всех оставшихся конфликтов без повторного вопроса). */
function showPcImportConflictModal(parsed, position, total) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('pc-import-modal');
    const progressEl = document.getElementById('pc-import-modal-progress');
    const warningEl = document.getElementById('pc-import-modal-hostname-warning');
    const fieldsEl = document.getElementById('pc-import-modal-fields');
    const skipBtn = document.getElementById('pc-import-modal-skip');
    const allOldBtn = document.getElementById('pc-import-modal-all-old');
    const allNewBtn = document.getElementById('pc-import-modal-all-new');
    const applyBtn = document.getElementById('pc-import-modal-apply');

    document.getElementById('pc-import-modal-title').textContent =
      `${parsed.isNew ? 'Новое устройство' : 'Обновление устройства'} «${parsed.hostname}» (${parsed.fileName})`;
    progressEl.textContent = (position && total) ? `Файл ${position} из ${total}` : '';

    if (parsed.hostnameMismatch) {
      warningEl.classList.remove('hidden');
      warningEl.textContent = `В файле hostname «${parsed.hostname}» — отличается от карточки. Hostname карточки не меняем, импортируем только остальные поля.`;
    } else {
      warningEl.classList.add('hidden');
    }

    fieldsEl.innerHTML = '';
    parsed.fields.forEach((f) => {
      const row = document.createElement('div');
      row.className = `pc-import-field${f.conflict ? '' : ' no-conflict'}`;
      const label = document.createElement('div');
      label.className = 'pc-import-field-label';
      label.textContent = f.label;
      row.appendChild(label);

      if (f.conflict) {
        const options = document.createElement('div');
        options.className = 'pc-import-field-options';
        const groupName = `pc-import-field-${f.key}`;
        const newLabel = document.createElement('label');
        const newRadio = document.createElement('input');
        newRadio.type = 'radio'; newRadio.name = groupName; newRadio.value = 'new'; newRadio.checked = true;
        newLabel.append(newRadio, document.createTextNode(` Из файла: ${f.newValue}`));
        const oldLabel = document.createElement('label');
        const oldRadio = document.createElement('input');
        oldRadio.type = 'radio'; oldRadio.name = groupName; oldRadio.value = 'old';
        oldLabel.append(oldRadio, document.createTextNode(` Оставить: ${f.oldValue}`));
        options.append(newLabel, oldLabel);
        row.appendChild(options);
      } else {
        const info = document.createElement('div');
        info.textContent = f.newValue;
        row.appendChild(info);
      }
      fieldsEl.appendChild(row);
    });

    const showBulkButtons = !!(total && total > 1);
    allOldBtn.classList.toggle('hidden', !showBulkButtons);
    allNewBtn.classList.toggle('hidden', !showBulkButtons);

    const collectChoices = (forcedValue) => {
      const choices = {};
      parsed.fields.forEach((f) => {
        if (!f.conflict) return;
        if (forcedValue) { choices[f.key] = forcedValue; return; }
        const checked = fieldsEl.querySelector(`input[name="pc-import-field-${f.key}"]:checked`);
        choices[f.key] = checked ? checked.value : 'new';
      });
      return choices;
    };

    const cleanup = (result) => {
      overlay.classList.add('hidden');
      skipBtn.onclick = null;
      allOldBtn.onclick = null;
      allNewBtn.onclick = null;
      applyBtn.onclick = null;
      resolve(result);
    };

    skipBtn.onclick = () => cleanup({ action: 'skip' });
    allOldBtn.onclick = () => cleanup({ action: 'apply-all-old', fieldChoices: collectChoices('old') });
    allNewBtn.onclick = () => cleanup({ action: 'apply-all-new', fieldChoices: collectChoices('new') });
    applyBtn.onclick = () => cleanup({ action: 'apply', fieldChoices: collectChoices() });

    overlay.classList.remove('hidden');
  });
}

/** Применяет список уже разобранных файлов: без конфликтов — сразу, с конфликтами —
 *  по очереди через модалку (кроме случая, когда пользователь выбрал "для всех
 *  оставшихся" — тогда дальше решается автоматически по этой политике, без вопросов). */
async function resolveAndApplyPcImports(parsedList) {
  const summary = { created: 0, updated: 0, softwareAdded: 0, componentsAdded: 0, skipped: 0 };
  let bulkPolicy = null; // null | 'old' | 'new'

  const applyOne = async (p, fieldChoices) => {
    const r = await window.api.importPcInfo.apply(p, fieldChoices);
    if (r.isNew) summary.created++; else summary.updated++;
    summary.softwareAdded += r.softwareAdded;
    summary.componentsAdded += r.componentsAdded;
  };

  const clean = parsedList.filter((p) => !p.hasConflicts);
  const conflicting = parsedList.filter((p) => p.hasConflicts);

  for (const p of clean) await applyOne(p, {});

  for (let i = 0; i < conflicting.length; i++) {
    const p = conflicting[i];
    if (bulkPolicy) {
      const fieldChoices = {};
      p.fields.forEach((f) => { if (f.conflict) fieldChoices[f.key] = bulkPolicy; });
      await applyOne(p, fieldChoices);
      continue;
    }
    const result = await showPcImportConflictModal(p, i + 1, conflicting.length);
    if (result.action === 'skip') { summary.skipped++; continue; }
    if (result.action === 'apply-all-old') bulkPolicy = 'old';
    if (result.action === 'apply-all-new') bulkPolicy = 'new';
    await applyOne(p, result.fieldChoices);
  }

  return summary;
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
  header.addEventListener('click', () => {
    row.classList.toggle('expanded');
    if (row.classList.contains('expanded') && !devicesLoaded) {
      devicesLoaded = true;
      refreshUserDevices();
    }
  });
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
          if (!(await confirmModal(`Удалить пользователя «${u.full_name}»?`))) return;
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
    if (newStatus === 'dismissed' && !(await confirmModal(`Отметить «${u.full_name}» как уволенного? Карточка скроется из общего списка (её можно будет включить обратно через «показать уволенных»).`))) return;
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

  const devicesExtras = document.createElement('div');
  devicesExtras.className = 'device-card-extras';
  devicesExtras.textContent = 'Загрузка…';
  body.appendChild(devicesExtras);
  let devicesLoaded = false;
  let refreshUserDevices;
  refreshUserDevices = () => renderUserDevices(devicesExtras, u.id);

  row.append(header, body);
  return row;
}

/** Устройства, которыми пользователь владеет сейчас и владел раньше — обратная сторона
 *  "Истории владельцев" на карточке устройства. Лениво подгружается при разворачивании. */
async function renderUserDevices(container, userId) {
  const history = await window.api.ownership.historyForUser(userId);
  container.innerHTML = '';

  const current = history.filter((h) => !h.unassigned_at);
  const past = history.filter((h) => h.unassigned_at);

  const buildDeviceRow = (h) => {
    const li = document.createElement('li');
    const label = document.createElement('span');
    const period = h.unassigned_at ? `${h.assigned_at || '?'} → ${h.unassigned_at}` : `с ${h.assigned_at || '?'}`;
    label.textContent = `${h.device_hostname || '(без имени)'} (${h.device_type || '—'}) — ${period}`;
    li.appendChild(label);
    const openBtn = document.createElement('button');
    openBtn.textContent = '📇';
    openBtn.title = 'Открыть карточку устройства';
    openBtn.onclick = () => openDeviceCard(h.device_id);
    li.appendChild(openBtn);
    const findBtn = document.createElement('button');
    findBtn.textContent = '📍';
    findBtn.title = 'Найти на плане';
    findBtn.onclick = () => findDeviceOnPlan(h.device_id);
    li.appendChild(findBtn);
    return li;
  };

  container.appendChild(sectionTitle('Текущие устройства'));
  if (current.length === 0) {
    container.appendChild(smallNote('Нет устройств'));
  } else {
    const ul = document.createElement('ul');
    ul.className = 'mini-list';
    current.forEach((h) => ul.appendChild(buildDeviceRow(h)));
    container.appendChild(ul);
  }

  container.appendChild(sectionTitle('Ранее'));
  if (past.length === 0) {
    container.appendChild(smallNote('Нет записей'));
  } else {
    const ul = document.createElement('ul');
    ul.className = 'mini-list';
    past.forEach((h) => {
      const li = buildDeviceRow(h);
      li.className = 'detached';
      ul.appendChild(li);
    });
    container.appendChild(ul);
  }
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
let clientModeActive = false; // true, если это клиент чужого хоста — формы редактирования требуют явного запроса права (см. requestEditLock)
let clientAllowWritesFlag = false; // текущее состояние тумблера хоста (см. onLocksStateChanged) — для текста баннера
let clientHeldLockKeys = new Set(); // "type:id" — объекты, на которые ЭТОТ клиент прямо сейчас имеет право (см. isNodeLocked)
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

  let editLockControls = null; // назначается ниже, после создания формы — используется при сворачивании карточки

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
    if (!row.classList.contains('expanded') && editLockControls) {
      // Свернули карточку — освобождаем право сразу, не дожидаясь протухания за минуту
      // бездействия, чтобы объект быстрее стал доступен другим (только режим клиента)
      editLockControls.releaseIfHeld();
    }
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
          if (!(await confirmModal(`Удалить устройство «${d.hostname}»?`))) return;
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
    <label class="span-2 device-edit-host-row hidden">Хост (физический сервер) <select name="host_device_id"><option value="">— не выбран —</option></select></label>
    <label class="span-2">Заметки <input name="notes" /></label>
  `;
  form.device_type.value = d.device_type;
  form.status.value = d.status || 'active';
  form.hostname.value = d.hostname || '';
  form.inventory_number.value = d.inventory_number || '';
  form.ip_address.value = d.primary_ip || '';
  form.mac_address.value = d.primary_mac || '';
  form.notes.value = d.notes || '';

  const hostRow = form.querySelector('.device-edit-host-row');
  const hostSelect = form.host_device_id;
  /** Показывает поле хоста только для VM (та же логика, что и в форме создания —
   *  см. updateDeviceFormHostField) и заполняет списком не-VM устройств, кроме себя самого. */
  function refreshEditHostField() {
    const isVm = form.device_type.value === 'vm';
    hostRow.classList.toggle('hidden', !isVm);
    if (!isVm) { hostSelect.value = ''; return; }
    const currentValue = hostSelect.value || (d.host_device_id ? String(d.host_device_id) : '');
    hostSelect.innerHTML = '<option value="">— не выбран —</option>';
    devicesCache
      .filter((dv) => dv.device_type !== 'vm' && dv.id !== d.id && dv.status !== 'decommissioned')
      .sort((a, b) => (a.hostname || '').localeCompare(b.hostname || ''))
      .forEach((dv) => {
        const opt = document.createElement('option');
        opt.value = dv.id;
        opt.textContent = `${dv.hostname || '(без имени)'} (${dv.device_type})`;
        hostSelect.appendChild(opt);
      });
    hostSelect.value = currentValue;
  }
  refreshEditHostField();
  form.device_type.addEventListener('change', refreshEditHostField);

  if (clientModeActive) {
    editLockControls = createEditLockControls('device', d.id, form);
    form.insertBefore(editLockControls.wrap, form.firstChild);
  }

  const actions = document.createElement('div');
  actions.className = 'card-body-actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.textContent = 'Сохранить';
  const findBtn = document.createElement('button');
  findBtn.type = 'button';
  findBtn.textContent = '📍 Найти на плане';
  findBtn.onclick = () => findDeviceOnPlan(d.id);
  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.textContent = '📥 Импорт из файла';
  importBtn.title = 'Импортировать сведения из JSON-файла (см. scripts/collect-pc-info.ps1)';
  importBtn.onclick = async () => {
    const parsed = await window.api.importPcInfo.pickFile(d.id);
    if (!parsed) return; // отмена выбора файла
    let fieldChoices = {};
    if (parsed.hasConflicts) {
      const result = await showPcImportConflictModal(parsed, null, null);
      if (result.action === 'skip') return;
      fieldChoices = result.fieldChoices;
    }
    const applyResult = await window.api.importPcInfo.apply(parsed, fieldChoices);
    await renderDevices(); // полный перерендер с бэкенда — надёжнее, чем точечно патчить карточку
    applyDevicesFilter();
    await alertModal(`Импортировано. Установленного ПО добавлено: ${applyResult.softwareAdded}. Комплектующих добавлено: ${applyResult.componentsAdded}.`);
  };
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
      if (!(await confirmModal(`Списать «${d.hostname}»? Карточка скроется из общего списка (её можно будет включить обратно через «показать списанные»).`))) return;
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

  actions.append(saveBtn, findBtn, importBtn, pingBtn, serviceBtn, lifecycleBtn, statusNote);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const payload = {
      device_type: fd.get('device_type'),
      hostname: fd.get('hostname'),
      inventory_number: fd.get('inventory_number') || null,
      status: fd.get('status'),
      notes: fd.get('notes') || null,
      host_device_id: fd.get('host_device_id') ? Number(fd.get('host_device_id')) : null,
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

/** Показывает поле выбора хоста только для типа "vm" — у остальных типов он бессмысленен
 *  (ограничено и на уровне БД: CHECK разрешает host_device_id только у VM). Список — все
 *  НЕ-VM устройства (VM разумно привязывать к физическому серверу, не к другой VM). */
function updateDeviceFormHostField() {
  const typeSelect = document.querySelector('#device-form select[name="device_type"]');
  const hostSelect = document.getElementById('device-form-host-select');
  const isVm = typeSelect.value === 'vm';
  hostSelect.classList.toggle('hidden', !isVm);
  if (!isVm) { hostSelect.value = ''; return; }

  const currentValue = hostSelect.value;
  hostSelect.innerHTML = '<option value="">Хост (физический сервер) — необязательно</option>';
  devicesCache
    .filter((d) => d.device_type !== 'vm' && d.status !== 'decommissioned')
    .sort((a, b) => (a.hostname || '').localeCompare(b.hostname || ''))
    .forEach((d) => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `${d.hostname || '(без имени)'} (${d.device_type})`;
      hostSelect.appendChild(opt);
    });
  hostSelect.value = currentValue; // сохраняем выбор, если он всё ещё существует в списке
}
document.querySelector('#device-form select[name="device_type"]').addEventListener('change', updateDeviceFormHostField);

document.getElementById('device-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const hostDeviceId = form.get('host_device_id');
  await window.api.devices.create({
    device_type: form.get('device_type'),
    hostname: form.get('hostname'),
    ip_address: form.get('ip_address') || null,
    host_device_id: hostDeviceId ? Number(hostDeviceId) : null
  });
  e.target.reset();
  updateDeviceFormHostField();
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
    await alertModal('Это устройство пока не размещено ни на одном плане.');
    return;
  }
  const target = placements[0]; // на нескольких этажах сразу — берём первый найденный
  document.querySelector('.tab-btn[data-tab="plan"]').click();
  await switchFloorPlan(target.floor_plan_id);
  const node = planState.itemsById.get(target.id);
  if (node) {
    selectNode(node);
    focusOnNode(node);
    blinkNode(node);
    if (target.via_group) openGroupPanel(target.id); // устройство внутри "шкафа" — сразу открываем его содержимое
  }
}

/** То же самое, но для кабеля — переход из вкладки "Сеть" по клику на подпись "🔌 Кабель №..." */
async function findCableOnPlan(cableId) {
  const cable = await window.api.cables.get(cableId);
  if (!cable) { await alertModal('Этот кабель не найден — возможно, был удалён.'); return; }
  document.querySelector('.tab-btn[data-tab="plan"]').click();
  await switchFloorPlan(cable.floor_plan_id);
  const node = planState.cablesById.get(cableId);
  if (node) { selectNode(node); focusOnNode(node); blinkNode(node); }
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

document.getElementById('import-pc-info-folder-btn').addEventListener('click', async () => {
  const btn = document.getElementById('import-pc-info-folder-btn');
  const status = document.getElementById('import-pc-info-status');

  btn.disabled = true;
  status.textContent = 'Читаю папку…';

  try {
    const batch = await window.api.importPcInfo.pickFolder();
    if (!batch) { status.textContent = ''; return; } // диалог отменён
    if (batch.results.length === 0 && batch.errors.length === 0) {
      status.textContent = 'В папке нет .json-файлов.';
      return;
    }

    status.textContent = `Разобрано ${batch.results.length} файлов${batch.errors.length ? `, ошибок: ${batch.errors.length}` : ''}. Применяю…`;
    const summary = await resolveAndApplyPcImports(batch.results);

    const parts = [`создано ${summary.created}`, `обновлено ${summary.updated}`, `ПО добавлено ${summary.softwareAdded}`, `комплектующих добавлено ${summary.componentsAdded}`];
    if (summary.skipped) parts.push(`пропущено ${summary.skipped}`);
    status.textContent = `Готово: ${parts.join(', ')}.`;

    if (batch.errors.length > 0) {
      await alertModal(`Не удалось разобрать ${batch.errors.length} файл(ов):\n${batch.errors.join('\n')}`);
    }

    await renderDevices();
    applyDevicesFilter();
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
        if (!(await confirmModal(`Удалить запись «${w.description}» насовсем? Действие необратимо.`))) return;
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
          if (!(await confirmModal(`Снять «${s.name}» с «${s.device_hostname}» и отправить на склад?`))) return;
          await window.api.warehouse.receiveSoftware(s.id);
          renderSoftwareRegistry();
          renderWarehouse();
          fillWarehouseDragList();
        }
      });
    } else {
      items.push({
        label: 'Удалить запись', danger: true, onClick: async () => {
          if (!(await confirmModal(`Удалить «${s.name}» со склада насовсем?`))) return;
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
  cableEditHandles: null, // [Konva.Circle, ...] — точки редактирования выделенного кабеля, либо null
  zonesById: new Map(),   // zone.id -> Konva.Group (заливка + подпись)
  pendingLine: null,      // { x, y, type } — первая точка стены/двери/лестницы
  previewLine: null,      // Konva.Line — превью линии при рисовании
  cableDraft: null,       // { fromItemId, waypoints: [{x,y}] }
  cablePreviewLine: null,
  doorPreviewLine: null,  // Konva.Line — превью двери при наведении на стену
  deskPreviewRect: null,  // Konva.Rect — превью размещения стола под курсором
  panFrom: null,          // { x, y, stageX, stageY } — активна панорама зажатой средней кнопкой мыши
  viewMode: false,        // true = "Просмотр": элементы закреплены, нельзя двигать/удалять/рисовать
  // 0=зоны, 1=стены/мебель, 2=кабели, 3=оборудование; глобально, не сбрасывается по этажам.
  // 'visible' — видно и редактируется; 'locked' — видно, но нельзя двигать/удалять/рисовать
  // на этом слое; 'hidden' — не видно (и, соответственно, тоже нельзя взаимодействовать)
  layerState: { 0: 'visible', 1: 'visible', 2: 'visible', 3: 'visible', 4: 'visible' }
};

/** К какому логическому слою относится тип объекта плана — используется и при отрисовке
 *  (сразу выставить видимость/блокировку), и переключателями слоёв.
 *  Зоны — слой 0, самый нижний (под стенами); кабели (отдельная сущность, не plan_item) — слой 2. */
function planLayerFor(itemType) {
  if (itemType === 'device' || itemType === 'group') return 4;
  if (itemType === 'desk') return 2;
  if (itemType === 'wall' || itemType === 'door' || itemType === 'stairs') return 1;
  return null;
}

/** Заблокирован ли конкретный узел на канве — либо весь план в режиме "Просмотр",
 *  либо конкретно его логический слой стоит в состоянии "заблокирован". Используется
 *  везде, где раньше проверялся только planState.viewMode (драг, удаление, контекстное меню). */
function isNodeLocked(node) {
  const itemData = node.getAttr('itemData');
  if (itemData && (itemData.item_type === 'device' || itemData.item_type === 'group') && !itemData.via_group) {
    const key = `plan_item:${itemData.id}`;
    if (clientModeActive) {
      // Клиент: персональное право на КОНКРЕТНЫЙ объект — главная проверка, перебивает
      // общий viewMode: получения права на объект достаточно само по себе, без
      // отдельного переключения в общий "режим рисования" (тот нужен только для НОВЫХ
      // объектов — стен/столов/кабелей — не покрытых per-object блокировками).
      return !clientHeldLockKeys.has(key);
    }
    // Хост: у него нет понятия "своя" блокировка — если объект занят хоть кем-то
    // (обязательно клиентом, раз хост сам блокировок не держит), редактировать нельзя.
    // Раньше хост мог перехватить зарезервированный клиентом объект без предупреждения —
    // теперь он видит занятость точно так же, как её видит клиент (см. activeLocksSnapshot).
    if (activeLocksSnapshot.some((l) => l.type === 'plan_item' && l.id === itemData.id)) return true;
  }
  if (planState.viewMode) return true;
  const layer = node.getAttr('planLayer');
  if (layer !== null && layer !== undefined && planState.layerState[layer] === 'locked') return true;
  return false;
}

/** То же самое, но по номеру слоя напрямую — для мест, где узла ещё нет
 *  (инструменты рисования проверяют ДО создания объекта). */
function isLayerLocked(layerNum) {
  return planState.viewMode || planState.layerState[layerNum] === 'locked';
}

/** Гарантирует, что z-порядок в Konva-слое соответствует логическим слоям (0..3) —
 *  элемент на более низком слое никогда не окажется выше элемента на более высоком,
 *  независимо от порядка создания. Зовём сразу после добавления любого нового узла
 *  с атрибутом planLayer в planState.layer. */
function enforceLayerZOrder(node) {
  const myLayer = node.getAttr('planLayer');
  if (myLayer === null || myLayer === undefined) return;
  node.moveToTop();
  const children = planState.layer.getChildren();
  let below = node.zIndex() > 0 ? children[node.zIndex() - 1] : null;
  while (below) {
    const belowLayer = below.getAttr('planLayer');
    if (belowLayer !== null && belowLayer !== undefined && belowLayer > myLayer) {
      node.moveDown();
      const refreshed = planState.layer.getChildren();
      below = node.zIndex() > 0 ? refreshed[node.zIndex() - 1] : null;
    } else {
      break;
    }
  }
}

/** Полный пересчёт z-порядка ВСЕХ объектов слоя разом — устойчивая сортировка по
 *  planLayer, взаимный порядок объектов внутри одного логического слоя сохраняется.
 *  В отличие от enforceLayerZOrder (точечная вставка одного нового узла — дёшево для
 *  живого рисования во время сессии), это страховочный полный проход: гарантирует
 *  корректность НЕЗАВИСИМО от истории вставок — например, если в будущем появится
 *  путь добавления объекта на канву в обход enforceLayerZOrder, эта функция всё равно
 *  восстановит правильный порядок при следующей загрузке этажа. Объекты без атрибута
 *  planLayer (сетка, превью рисования) считаются самым нижним слоем — остаются под всем. */
function resortPlanLayerZOrder() {
  const children = planState.layer.getChildren().slice();
  const indexed = children.map((node, i) => ({
    node, i, layer: node.getAttr('planLayer')
  }));
  indexed.sort((a, b) => {
    const al = (a.layer === null || a.layer === undefined) ? -1 : a.layer;
    const bl = (b.layer === null || b.layer === undefined) ? -1 : b.layer;
    if (al !== bl) return al - bl;
    return a.i - b.i; // стабильность: сохраняем исходный относительный порядок внутри слоя
  });
  indexed.forEach(({ node }, newIndex) => node.zIndex(newIndex));
  planState.layer.batchDraw();
}

async function initPlan() {
  const floors = await window.api.floorPlans.list();
  planState.floorPlan = floors.length > 0 ? floors[0] : await window.api.floorPlans.ensureDefault();

  // Разовые привязки — не зависят от того, какой именно этаж сейчас открыт
  bindPlanToolbar();
  bindPlanSearch();
  bindZoomButtons();
  bindPlanInspectorResizer();
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

  document.getElementById('group-panel-close-btn').addEventListener('click', closeGroupPanel);

  // Drag иконки ИЗ панели группы наружу (на основной план) — глобальные обработчики,
  // не по одному на иконку: mousedown стартует в renderGroupPanelIcon, а следит за
  // перемещением и завершением курсора вот этот единственный слушатель на весь документ
  document.addEventListener('mousemove', (e) => {
    if (groupPanelDragOutState.active) updateGroupPanelDragGhost(e.clientX, e.clientY);
  });
  document.addEventListener('mouseup', (e) => {
    if (groupPanelDragOutState.active) {
      finishGroupPanelIconDragOut(e.clientX, e.clientY).catch((err) => console.error('finishGroupPanelIconDragOut упал:', err));
    }
  });
  document.getElementById('group-panel-rename-btn').addEventListener('click', async () => {
    if (!groupPanelState.groupItemId) return;
    const label = document.getElementById('group-panel-label-input').value;
    const updated = await window.api.planItems.renameGroup(groupPanelState.groupItemId, label);
    const groupNode = planState.itemsById.get(groupPanelState.groupItemId);
    if (groupNode) {
      const data = groupNode.getAttr('itemData');
      refreshPointItemVisual({ ...data, group_label: updated.group_label });
      if (planState.selectedNode && planState.selectedNode.getAttr('itemData')?.id === groupPanelState.groupItemId) {
        selectNode(planState.itemsById.get(groupPanelState.groupItemId)); // обновляем инспектор со свежим названием
      }
    }
  });
  bindGroupPanelDragDrop();

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
              await alertModal('Нельзя удалить последний план — должен остаться хотя бы один.');
              return;
            }
            if (!(await confirmModal(`Удалить план «${f.name}» вместе со всеми объектами на нём? Действие необратимо.`))) return;

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

  closeGroupPanel(); // группа принадлежит конкретному этажу — на другом этаже её панель не актуальна
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
  planState.cableEditHandles = null;
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
  planState.stage.on('contextmenu', (e) => {
    if (planState.mode === 'cable' && planState.cableDraft) {
      e.evt.preventDefault();
      finishCableDraft();
    }
  });

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


  resortPlanLayerZOrder(); // страховка: гарантированно верный z-порядок для всего, что уже отрисовано
}

// ------------------------------------------------------------
// Лист "Сеть": иерархия по кабелям + ручным аплинкам (см. networkRepo.buildTree)
// ------------------------------------------------------------

const NETWORK_TYPE_ICONS = {
  router: '📡', switch: '🔀', server: '🖥', computer: '💻', laptop: '💻',
  printer: '🖨', vm: '🗔', other: '❓'
};

/** Заполняет выпадающий список корней (роутеры/свитчи) — вызывается один раз при
 *  старте приложения, как и остальные листы-списки. */
async function renderNetworkTab() {
  const roots = await window.api.network.listRoots();
  const select = document.getElementById('network-root-select');
  const previousValue = select.value;
  select.innerHTML = '<option value="">— выбрать —</option>';
  roots.forEach((r) => {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = `[${r.device_type}] ${r.hostname || '(без имени)'}`;
    select.appendChild(opt);
  });
  if (previousValue && roots.some((r) => String(r.id) === previousValue)) {
    select.value = previousValue;
  }
  // Перечитываем и само дерево — иначе переключение на вкладку не покажет свежие
  // подключения к сокетам/аплинки, если корень в списке не поменялся (у <select>
  // событие change не срабатывает повторно на то же самое значение)
  if (select.value) await loadNetworkTree(select.value);
}

let currentNetworkTree = null; // дерево, которое сейчас показано — нужно кнопке "Пинговать дерево"

async function loadNetworkTree(rootDeviceId) {
  const container = document.getElementById('network-tree');
  if (!rootDeviceId) {
    currentNetworkTree = null;
    container.innerHTML = '';
    container.appendChild(smallListNote('Выберите корень дерева выше'));
    return;
  }
  container.textContent = 'Загрузка…';
  currentNetworkTree = await window.api.network.buildTree(Number(rootDeviceId));
  renderNetworkTreeContainer();
}

function renderNetworkTreeContainer() {
  const container = document.getElementById('network-tree');
  container.innerHTML = '';
  if (!currentNetworkTree) {
    container.appendChild(smallListNote('Устройство не найдено'));
    return;
  }
  container.appendChild(renderNetworkTreeNode(currentNetworkTree, true, false));
}

/** Собирает все узлы дерева в плоский список — для кнопки "Пинговать дерево" */
function flattenNetworkTree(node, acc = []) {
  if (!node) return acc;
  acc.push(node);
  (node.children || []).forEach((child) => flattenNetworkTree(child, acc));
  return acc;
}

function renderNetworkTreeNode(node, isRoot, ancestorDown) {
  const wrap = document.createElement('div');
  wrap.className = 'network-node';

  const row = document.createElement('div');
  row.className = 'network-node-row';

  if (ancestorDown) row.classList.add('net-cascade-affected');

  const pingDot = document.createElement('span');
  pingDot.className = 'net-ping-dot';
  pingDot.style.background = pingColor(node.last_ping_status);
  pingDot.title = pingStatusLabel(node.last_ping_status);
  row.appendChild(pingDot);

  const icon = document.createElement('span');
  icon.className = 'net-type-icon';
  icon.textContent = NETWORK_TYPE_ICONS[node.device_type] || '❓';
  row.appendChild(icon);

  const hostname = document.createElement('span');
  hostname.className = 'net-hostname net-clickable';
  hostname.textContent = node.hostname || '(без имени)';
  hostname.title = 'Открыть карточку устройства';
  hostname.onclick = () => openDeviceCard(node.id);
  row.appendChild(hostname);

  if (node.status && node.status !== 'active') {
    const statusEl = document.createElement('span');
    statusEl.className = 'net-via';
    statusEl.textContent = DEVICE_STATUS_LABELS[node.status] || node.status;
    row.appendChild(statusEl);
  }

  if (node.network_role) {
    const roleEl = document.createElement('span');
    roleEl.className = `net-role net-role-${node.network_role}`;
    roleEl.textContent = { primary: 'Главный', backup: 'Резервный', satellite: 'Сателлит' }[node.network_role];
    row.appendChild(roleEl);
  }

  const badge = flagBadge(node.flag);
  if (badge) row.appendChild(badge);

  if (!isRoot && node.via) {
    const via = document.createElement('span');
    via.className = 'net-via';
    if (node.via === 'cable') {
      const cableLink = document.createElement('span');
      cableLink.className = 'net-clickable';
      cableLink.textContent = `🔌 Кабель №${node.via_cable_id}${node.via_cable_label ? ` (${node.via_cable_label})` : ''}`;
      cableLink.title = 'Найти этот кабель на плане';
      cableLink.onclick = () => findCableOnPlan(node.via_cable_id);
      via.appendChild(cableLink);
    } else {
      via.textContent = '🔗 по аплинку';
    }
    row.appendChild(via);
  }

  // Устройство САМО не отвечает на пинг — но если это следствие сбоя выше по дереву
  // (родитель тоже недоступен), явно не подчёркиваем ЕГО как отдельную проблему —
  // тег "возможно недоступно" уже покажет, что искать причину нужно выше
  if (ancestorDown) {
    const cascadeNote = document.createElement('span');
    cascadeNote.className = 'net-via net-cascade-note';
    cascadeNote.textContent = '⚠️ возможно недоступно — проблема выше по дереву';
    row.appendChild(cascadeNote);
  }

  const actions = document.createElement('span');
  actions.className = 'net-actions';
  const openBtn = document.createElement('button');
  openBtn.textContent = '📇';
  openBtn.title = 'Открыть карточку устройства';
  openBtn.onclick = () => openDeviceCard(node.id);
  actions.appendChild(openBtn);
  const findBtn = document.createElement('button');
  findBtn.textContent = '📍';
  findBtn.title = 'Найти на плане';
  findBtn.onclick = () => findDeviceOnPlan(node.id);
  actions.appendChild(findBtn);
  row.appendChild(actions);

  wrap.appendChild(row);

  const isDown = node.last_ping_status === 'offline' || node.last_ping_status === 'timeout';
  if (node.children && node.children.length > 0) {
    const childrenWrap = document.createElement('div');
    childrenWrap.className = 'network-children';
    node.children.forEach((child) => childrenWrap.appendChild(renderNetworkTreeNode(child, false, ancestorDown || isDown)));
    wrap.appendChild(childrenWrap);
  }

  return wrap;
}

document.getElementById('network-root-select').addEventListener('change', (e) => {
  loadNetworkTree(e.target.value);
});

document.getElementById('network-refresh-btn').addEventListener('click', () => {
  const select = document.getElementById('network-root-select');
  if (select.value) loadNetworkTree(select.value);
});

/** Пингует все устройства текущего дерева разом — так и задумано использовать для
 *  диагностики: увидеть, какая ветка не отвечает, и сразу найти проблемный узел
 *  (обычно это САМЫЙ ВЕРХНИЙ недоступный узел — то, что ниже него, просто "заражено"
 *  каскадом, см. net-cascade-affected). */
document.getElementById('network-ping-tree-btn').addEventListener('click', async () => {
  if (!currentNetworkTree) return;
  const btn = document.getElementById('network-ping-tree-btn');
  const nodes = flattenNetworkTree(currentNetworkTree);
  const targets = nodes
    .map((n) => ({ node: n, device: devicesCache.find((d) => d.id === n.id) }))
    .filter((t) => t.device && t.device.primary_ip);
  if (targets.length === 0) return;

  const original = btn.textContent;
  btn.textContent = `Пингуем ${targets.length}…`;
  btn.disabled = true;
  await Promise.all(targets.map(async (t) => {
    try {
      const result = await window.api.ping.run(t.device.id, t.device.primary_ip);
      t.node.last_ping_status = result.status;
    } catch { /* один не отвечающий узел не должен рвать пинг остальных */ }
  }));
  btn.textContent = original;
  btn.disabled = false;
  renderNetworkTreeContainer(); // перерисовать с новыми статусами и каскадной подсветкой
});

// ------------------------------------------------------------
// Лист "Журнал": лог значимых действий (см. auditLogRepo на бэкенде) с фильтром по датам и типу
// ------------------------------------------------------------

const AUDIT_ENTITY_LABELS = {
  user: 'Пользователи', device: 'Устройства', plan_item: 'Объекты плана', cable: 'Кабели',
  cable_connection: 'Подключения к кабелю', zone: 'Зоны', warehouse_item: 'Склад',
  software: 'ПО', component: 'Комплектующие', peripheral: 'Периферия',
  ownership: 'Владение устройством', floor_plan: 'Планы'
};
const AUDIT_ACTION_ICONS = { create: '➕', update: '✏️', delete: '🗑', status_change: '🔄' };

/** 'YYYY-MM-DD HH:MM:SS' (формат SQLite datetime('now')) -> 'ДД.ММ.ГГГГ ЧЧ:ММ' */
function formatAuditTimestamp(sqliteDatetime) {
  const [datePart, timePart] = sqliteDatetime.split(' ');
  const [y, m, d] = datePart.split('-');
  const [hh, mm] = (timePart || '00:00').split(':');
  return `${d}.${m}.${y} ${hh}:${mm}`;
}

/** Заполняет выпадающий список типов сущностей один раз при старте */
function renderAuditFilterOptions() {
  const select = document.getElementById('audit-filter-type');
  Object.entries(AUDIT_ENTITY_LABELS).forEach(([value, label]) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  });
}

async function loadAuditLog() {
  const container = document.getElementById('audit-log-list');
  container.textContent = 'Загрузка…';

  const fromValue = document.getElementById('audit-filter-from').value; // 'YYYY-MM-DD' или ''
  const toValue = document.getElementById('audit-filter-to').value;
  const entityType = document.getElementById('audit-filter-type').value;
  const filters = { limit: 500 };
  if (fromValue) filters.from = fromValue; // сравнение строк 'YYYY-MM-DD' <= 'YYYY-MM-DD HH:MM:SS' работает верно как нижняя граница
  if (toValue) filters.to = `${toValue} 23:59:59`; // включаем весь день целиком, а не только 00:00:00
  if (entityType) filters.entityType = entityType;

  const entries = await window.api.auditLog.list(filters);
  container.innerHTML = '';
  if (entries.length === 0) {
    container.appendChild(smallListNote('Записей не найдено'));
    return;
  }
  entries.forEach((e) => {
    const row = document.createElement('div');
    row.className = 'audit-row';

    const icon = document.createElement('span');
    icon.className = 'audit-icon';
    icon.textContent = AUDIT_ACTION_ICONS[e.action] || '•';
    row.appendChild(icon);

    const time = document.createElement('span');
    time.className = 'audit-time';
    time.textContent = formatAuditTimestamp(e.created_at);
    row.appendChild(time);

    const type = document.createElement('span');
    type.className = 'audit-type';
    type.textContent = AUDIT_ENTITY_LABELS[e.entity_type] || e.entity_type;
    row.appendChild(type);

    const summary = document.createElement('span');
    summary.className = 'audit-summary';
    summary.textContent = e.summary;
    row.appendChild(summary);

    container.appendChild(row);
  });
}

renderAuditFilterOptions();
document.getElementById('audit-filter-from').addEventListener('change', loadAuditLog);
document.getElementById('audit-filter-to').addEventListener('change', loadAuditLog);
document.getElementById('audit-filter-type').addEventListener('change', loadAuditLog);
document.getElementById('audit-refresh-btn').addEventListener('click', loadAuditLog);
document.getElementById('audit-clear-filters-btn').addEventListener('click', () => {
  document.getElementById('audit-filter-from').value = '';
  document.getElementById('audit-filter-to').value = '';
  document.getElementById('audit-filter-type').value = '';
  loadAuditLog();
});

// ------------------------------------------------------------
// Точечные объекты: стол / устройство
// ------------------------------------------------------------

function renderPointItem(item) {
  const planLayer = planLayerFor(item.item_type);
  const locked = planState.viewMode || (planLayer !== null && planState.layerState[planLayer] === 'locked');
  const group = new Konva.Group({
    x: item.x * CELL_PX,
    y: item.y * CELL_PX,
    draggable: !locked
  });
  group.setAttr('kind', 'point');
  group.setAttr('recordId', item.id);
  group.setAttr('itemData', item);
  group.setAttr('planLayer', planLayer);
  if (planLayer !== null) group.visible(planState.layerState[planLayer] !== 'hidden');

  const isDesk = item.item_type === 'desk';
  const isGroup = item.item_type === 'group';
  const size = CELL_PX - 4;
  const color = isDesk ? '#c8a876' : isGroup ? '#5b4b8a' : (DEVICE_COLORS[item.device_type] || '#777');

  // Рамка иконки подсвечивается по статусу устройства — тот же смысл, что и подсветка
  // строки в карточке на вкладке "Устройства"
  const STATUS_BORDER_COLORS = { repair: '#ecc94b', storage: '#7ea6d6', decommissioned: '#999' };
  const borderColor = !isDesk && !isGroup && STATUS_BORDER_COLORS[item.device_status] ? STATUS_BORDER_COLORS[item.device_status] : '#333';
  const borderWidth = !isDesk && !isGroup && STATUS_BORDER_COLORS[item.device_status] ? 2.5 : 1;

  const rect = new Konva.Rect({
    width: size, height: size, x: 2, y: 2,
    fill: color, stroke: borderColor, strokeWidth: borderWidth, cornerRadius: 4
  });
  group.add(rect);

  if (isGroup) {
    // "Стопка карточек" — по аналогии с папкой Android: второй/третий контур позади
    // основного, чтобы читалось как "здесь несколько элементов", а не одно устройство
    group.add(new Konva.Rect({
      width: size - 6, height: size - 6, x: 5, y: -1,
      stroke: 'rgba(255,255,255,0.5)', strokeWidth: 1, cornerRadius: 3, listening: false
    }));
    group.add(new Konva.Rect({
      width: size - 3, height: size - 3, x: 3.5, y: 0.5,
      stroke: 'rgba(255,255,255,0.7)', strokeWidth: 1, cornerRadius: 3, listening: false
    }));

    group.add(new Konva.Text({
      text: String(item.member_count || 0), x: 0, y: size * 0.28, width: size,
      fontSize: 15, fontStyle: 'bold', fill: '#fff', align: 'center', listening: false
    }));

    const labelText = item.group_label || `Группа (${item.member_count || 0})`;
    group.add(new Konva.Text({
      text: labelText, x: 1, y: size - 15, width: size - 2,
      fontSize: 6.5, fontStyle: 'bold', fill: '#fff', align: 'center',
      ellipsis: true, wrap: 'none', lineHeight: 1, listening: false
    }));
  } else if (isDesk) {
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
    if (planState.mode === 'delete') {
      if (isNodeLocked(group)) { flashModeWarning('Слой заблокирован'); return; }
      await removePlanItem(item.id);
      return;
    }
    if (planState.mode === 'cable' && (item.item_type === 'device' || item.item_type === 'desk')) {
      addCablePoint(item.x + 0.5, item.y + 0.5); // точка в центре клетки устройства — удобная привязка, но не обязательная
      return;
    }
    if (item.item_type === 'group') {
      selectNode(group); // сама группа тоже выделяется — инспектор покажет её название/сеть
      openGroupPanel(item.id); // "открыть шкаф" — боковая панель, а не модальное окно поверх экрана
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
    items.push({
      label: '⬆️ Поднять поверх всего', onClick: () => {
        // Ручной способ решить визуальное перекрытие, если автоматическая логика слоёв
        // почему-то не сработала — поднимает буквально на самый верх, в обход layerFor
        group.moveToTop();
        planState.layer.draw();
      }
    });
    showContextMenu(e.evt.clientX, e.evt.clientY, items);
  });

  group.on('dragstart', () => {
    if (planState.panFrom || isNodeLocked(group)) group.stopDrag(); // средняя кнопка занята панорамой, либо слой заблокирован
  });

  group.on('dragend', async () => {
    const cellX = Math.round(group.x() / CELL_PX);
    const cellY = Math.round(group.y() / CELL_PX);
    group.position({ x: cellX * CELL_PX, y: cellY * CELL_PX });
    const data = group.getAttr('itemData');

    if (data.item_type === 'device') {
      // Перетаскивание уже размещённого устройства может попасть на занятую клетку —
      // тогда, как и при перетаскивании НОВОГО устройства с панели (см. placeDeviceItem),
      // вместо перекрытия образуется/пополняется группа
      const result = await window.api.planItems.moveDeviceItemWithGrouping(item.id, planState.floorPlan.id, data.ref_id, cellX, cellY);

      if (!result.wasGrouped) {
        data.x = cellX; data.y = cellY;
        group.setAttr('itemData', data);
        enforceLayerZOrder(group);
        if (planState.selectedNode === group) renderInspector(group);
        planState.layer.draw();
        return;
      }

      // Образовалась/пополнилась группа — этот узел (перетаскиваемое устройство) больше
      // не существует как отдельная точка на плане, убираем его с канвы
      planState.itemsById.delete(item.id);
      group.destroy();
      if (planState.selectedNode === group) selectNode(null);

      // На целевой клетке мог быть ещё чей-то узел под другим id (например, устройство,
      // которое там уже стояло одиночно и теперь стало частью новой группы) — тот же
      // приём, что и в placeDeviceItem
      for (const [oldId, node] of planState.itemsById) {
        const d2 = node.getAttr('itemData');
        if (d2 && d2.x === cellX && d2.y === cellY && oldId !== result.item.id && (d2.item_type === 'device' || d2.item_type === 'group')) {
          destroyPlanItemNode(oldId, node);
        }
      }

      const members = await window.api.planItems.groupMembers(result.item.id);
      const freshItem = { ...result.item, member_count: members.length };
      if (planState.itemsById.has(result.item.id)) {
        refreshPointItemVisual(freshItem);
      } else {
        renderPointItem(freshItem);
      }
      fillDevicePicker();
      planState.layer.draw();
      return;
    }

    // Стол/группа — как раньше, обычное перемещение без группировки (перетаскивание
    // готовой группы на другую занятую клетку слиянием групп пока не поддерживается)
    data.x = cellX; data.y = cellY;
    group.setAttr('itemData', data);
    await window.api.planItems.move(item.id, cellX, cellY);
    enforceLayerZOrder(group); // защитная мера — перетаскивание не должно ломать порядок слоёв
    if (planState.selectedNode === group) renderInspector(group);
    planState.layer.draw();
  });

  // Контур занятости — виден только когда объект зарезервирован кем-то (клиентом или,
  // для хоста, "кем-то ещё"). Только у устройств/групп: у них есть свой plan_item и
  // собственная блокировка; у стола/зоны такого понятия нет. Изначально невидим и без
  // цвета — applyLayerStates() выставляет их по activeLocksSnapshot при каждом изменении.
  if (!isDesk) {
    group.add(new Konva.Rect({
      width: CELL_PX, height: CELL_PX, x: 0, y: 0,
      stroke: "transparent", strokeWidth: 3, cornerRadius: 6,
      listening: false, visible: false, name: "lockOutline"
    }));
  }

  planState.layer.add(group);
  enforceLayerZOrder(group);
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
  if (planLayer !== null) group.visible(planState.layerState[planLayer] !== 'hidden');

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
    if (planState.mode === 'delete') {
      if (isNodeLocked(group)) { flashModeWarning('Слой заблокирован'); return; }
      await removePlanItem(item.id);
      return;
    }
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
  enforceLayerZOrder(group);
  planState.layer.draw();
  planState.itemsById.set(item.id, group);
  return group;
}

function handleLineToolClick(x, y) {
  if (isLayerLocked(1)) { flashModeWarning('Слой "стены" заблокирован'); return; }
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
  if (planState.layer) planState.layer.draw();
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
  if (isLayerLocked(1)) { flashModeWarning('Слой "стены" заблокирован'); return; }
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

/** Точка старта стены/лестницы под курсором — до первого клика, чтобы было видно,
 *  куда именно снапнется начало линии (тот же паттерн, что и у стола/двери). */
function updateLineStartPreview(pointer) {
  const cellX = Math.round(pointer.x / CELL_PX);
  const cellY = Math.round(pointer.y / CELL_PX);
  const x = cellX * CELL_PX;
  const y = cellY * CELL_PX;
  if (!planState.lineStartPreviewDot) {
    planState.lineStartPreviewDot = new Konva.Circle({
      x, y, radius: 5, fill: '#333', opacity: 0.55, listening: false
    });
    planState.layer.add(planState.lineStartPreviewDot);
  } else {
    planState.lineStartPreviewDot.position({ x, y });
  }
  planState.layer.draw();
}

function clearLineStartPreview() {
  if (planState.lineStartPreviewDot) { planState.lineStartPreviewDot.destroy(); planState.lineStartPreviewDot = null; planState.layer.draw(); }
}

/** Полупрозрачный контур клетки под курсором при перетаскивании чего-либо на план
 *  (устройство/пользователь/склад/зона) — dataTransfer.getData() при dragover ненадёжен
 *  почти во всех браузерах (отдаёт пустую строку до самого drop), поэтому превью общее,
 *  без уточнения конкретного типа — просто "сюда попадёт", той же клетки, что и сам drop. */
function updateDropTargetPreview(point) {
  const cellX = Math.round(point.x / CELL_PX);
  const cellY = Math.round(point.y / CELL_PX);
  const x = cellX * CELL_PX + 2;
  const y = cellY * CELL_PX + 2;
  if (!planState.dropTargetPreviewRect) {
    planState.dropTargetPreviewRect = new Konva.Rect({
      x, y, width: CELL_PX - 4, height: CELL_PX - 4,
      fill: '#4a90d9', opacity: 0.35, stroke: '#4a90d9', strokeWidth: 1.5,
      cornerRadius: 4, listening: false
    });
    planState.layer.add(planState.dropTargetPreviewRect);
  } else {
    planState.dropTargetPreviewRect.position({ x, y });
  }
  planState.layer.draw();
}

function clearDropTargetPreview() {
  if (planState.dropTargetPreviewRect) { planState.dropTargetPreviewRect.destroy(); planState.dropTargetPreviewRect = null; planState.layer.draw(); }
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
// Сетевой кабель — самостоятельная ломаная линия (path), не привязанная к устройствам
// напрямую. Устройства подключаются через сокеты (см. ниже), а не как концы кабеля.
// ------------------------------------------------------------

/** Огрубляет путь до сравнимой строки — для поиска кабелей с ИДЕНТИЧНЫМ маршрутом
 *  (чтобы развести их параллельным сдвигом разного цвета, см. ТЗ). */
function pathSignature(path) {
  return JSON.stringify(path.map((p) => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100]));
}

/** Сколько уже отрисованных кабелей имеют точно такой же путь, что и переданный —
 *  используется, чтобы у каждого следующего "параллельного" кабеля был свой сдвиг. */
function countCablesWithSamePath(path) {
  const sig = pathSignature(path);
  let count = 0;
  planState.cablesById.forEach((line) => {
    const otherPath = JSON.parse(line.getAttr('cableData').path || '[]');
    if (pathSignature(otherPath) === sig) count++;
  });
  return count;
}

/** Сдвигает каждую точку пути перпендикулярно направлению линии в этой точке (среднее
 *  нормалей соседних отрезков — простая, но устойчивая аппроксимация параллельного
 *  переноса ломаной). offsetPx — сдвиг в пикселях экрана. */
function offsetPathPerpendicular(path, offsetPx) {
  if (!offsetPx || path.length < 2) return path;
  return path.map((p, i) => {
    const prev = path[i - 1];
    const next = path[i + 1];
    let dx = 0, dy = 0;
    if (prev) { dx += p.x - prev.x; dy += p.y - prev.y; }
    if (next) { dx += next.x - p.x; dy += next.y - p.y; }
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len; // перпендикуляр (нормаль) к направлению линии
    return { x: p.x + (nx * offsetPx) / CELL_PX, y: p.y + (ny * offsetPx) / CELL_PX };
  });
}

function renderCable(cable) {
  const rawPath = JSON.parse(cable.path || '[]');
  if (rawPath.length < 2) return null;

  // Кабели с идентичным маршрутом — цикличный сдвиг 0, +5, -5, +10, -10px, чтобы
  // не накладывались друг на друга, оставаясь при этом разного цвета
  const rank = countCablesWithSamePath(rawPath);
  const offsetPx = rank === 0 ? 0 : Math.ceil(rank / 2) * 5 * (rank % 2 === 0 ? -1 : 1);
  const displayPath = offsetPathPerpendicular(rawPath, offsetPx);
  const points = displayPath.flatMap((p) => [p.x * CELL_PX, p.y * CELL_PX]);

  const line = new Konva.Line({
    points, stroke: cable.color || CABLE_COLOR, strokeWidth: 2, dash: [6, 4], hitStrokeWidth: 10
  });
  line.setAttr('kind', 'cable');
  line.setAttr('recordId', cable.id);
  line.setAttr('cableData', cable);
  line.setAttr('planLayer', 3);
  line.visible(planState.layerState[3] !== 'hidden');

  line.on('click', async (e) => {
    if (e.evt && e.evt.button !== undefined && e.evt.button !== 0) return; // только левая — средняя занята панорамой
    e.cancelBubble = true;
    if (planState.mode === 'delete') {
      if (isNodeLocked(line)) { flashModeWarning('Слой заблокирован'); return; }
      await removeCable(cable.id);
      return;
    }
    selectNode(line);
  });

  line.on('contextmenu', (e) => {
    e.evt.preventDefault();
    e.cancelBubble = true;
    if (isNodeLocked(line)) { flashModeWarning('Слой заблокирован'); return; }
    const pointer = planState.stage.getRelativePointerPosition();
    const cellPoint = { x: pointer.x / CELL_PX, y: pointer.y / CELL_PX };
    showContextMenu(e.evt.clientX, e.evt.clientY, [
      { label: '➕ Добавить точку', onClick: () => insertPointOnCable(cable.id, cellPoint) },
      { label: '➡️ Продолжить из последней точки', onClick: () => startExtendingCable(cable.id) }
    ]);
  });

  planState.layer.add(line);
  enforceLayerZOrder(line);
  planState.layer.draw();
  planState.cablesById.set(cable.id, line);
  return line;
}

/** Пересобирает линию кабеля после правки path — тот же паттерн, что и у остальных
 *  типов объектов (refreshLineItemVisual/refreshPointItemVisual): проще полностью
 *  переотрисовать, чем точечно чинить существующий Konva.Line. */
function refreshCableVisual(cableId, freshCableData) {
  const old = planState.cablesById.get(cableId);
  const wasSelected = planState.selectedNode === old;
  if (old) { old.destroy(); planState.cablesById.delete(cableId); }
  const cable = freshCableData || (old ? old.getAttr('cableData') : null);
  if (!cable) return;
  const fresh = renderCable(cable);
  if (wasSelected && fresh) { planState.selectedNode = fresh; highlight(fresh); showCableEditHandles(fresh); }
  planState.layer.draw();
}

/** Вставляет новую точку на БЛИЖАЙШЕМ сегменте пути (не просто ближайшую точку вообще —
 *  важно найти именно сегмент, чтобы точка встала в правильное место массива) */
async function insertPointOnCable(cableId, cellPoint) {
  const line = planState.cablesById.get(cableId);
  const cable = line.getAttr('cableData');
  const path = JSON.parse(cable.path || '[]');
  let bestSegIndex = 0, bestDist = Infinity, bestPoint = null;
  for (let i = 0; i < path.length - 1; i++) {
    const closest = closestPointOnSegment(cellPoint, path[i], path[i + 1]);
    const dist = Math.hypot(closest.x - cellPoint.x, closest.y - cellPoint.y);
    if (dist < bestDist) { bestDist = dist; bestSegIndex = i; bestPoint = closest; }
  }
  path.splice(bestSegIndex + 1, 0, bestPoint);
  const updated = await window.api.cables.updatePath(cableId, path);
  refreshCableVisual(cableId, updated);
}

/** "Продолжить из последней точки" — переходит в режим рисования кабеля с уже
 *  накопленным путём этого кабеля; следующие клики нарастят ЕГО, а не создадут новый
 *  (см. extendingCableId в finishCableDraft). */
function startExtendingCable(cableId) {
  if (isLayerLocked(3)) { flashModeWarning('Слой "кабель-менеджмент" заблокирован'); return; }
  const line = planState.cablesById.get(cableId);
  const cable = line.getAttr('cableData');
  const path = JSON.parse(cable.path || '[]');
  planState.setToolMode('cable'); // переключает режим, попутно сбрасывает cableDraft в null
  planState.cableDraft = { path: [...path], extendingCableId: cableId };
}

/** Точки редактирования path выделенного кабеля — перетащить, чтобы перенести трассу;
 *  правый клик по точке — удалить её (минимум 2 точки должно остаться). */
function showCableEditHandles(line) {
  clearCableEditHandles();
  const locked = isNodeLocked(line);
  const cable = line.getAttr('cableData');
  const path = JSON.parse(cable.path || '[]');
  const handles = [];

  path.forEach((point, index) => {
    const handle = new Konva.Circle({
      x: point.x * CELL_PX, y: point.y * CELL_PX, radius: 5,
      fill: '#fff', stroke: cable.color || CABLE_COLOR, strokeWidth: 2,
      draggable: !locked, listening: true
    });
    handle.setAttr('kind', 'cable-handle');

    handle.on('dragmove', () => {
      const liveLine = planState.cablesById.get(cable.id);
      if (!liveLine) return;
      const liveCable = liveLine.getAttr('cableData');
      const livePath = JSON.parse(liveCable.path || '[]');
      livePath[index] = { x: handle.x() / CELL_PX, y: handle.y() / CELL_PX };
      liveLine.points(livePath.flatMap((p) => [p.x * CELL_PX, p.y * CELL_PX]));
      liveLine.setAttr('cableData', { ...liveCable, path: JSON.stringify(livePath) });
      planState.layer.batchDraw();
    });
    handle.on('dragend', async () => {
      const liveLine = planState.cablesById.get(cable.id);
      const livePath = JSON.parse(liveLine.getAttr('cableData').path || '[]');
      const updated = await window.api.cables.updatePath(cable.id, livePath);
      liveLine.setAttr('cableData', updated);
    });
    handle.on('contextmenu', (e) => {
      e.evt.preventDefault();
      if (locked) { flashModeWarning('Слой заблокирован'); return; }
      const currentPath = JSON.parse(line.getAttr('cableData').path || '[]');
      if (currentPath.length <= 2) { flashModeWarning('Нужно минимум 2 точки — удалите весь кабель целиком'); return; }
      showContextMenu(e.evt.clientX, e.evt.clientY, [{
        label: '🗑 Удалить точку', onClick: async () => {
          const p = JSON.parse(planState.cablesById.get(cable.id).getAttr('cableData').path || '[]');
          p.splice(index, 1);
          const freshCable = await window.api.cables.updatePath(cable.id, p);
          planState.cablesById.get(cable.id).setAttr('cableData', freshCable);
          refreshCableVisual(cable.id);
        }
      }]);
    });

    planState.layer.add(handle);
    handles.push(handle);
  });

  planState.cableEditHandles = handles;
  planState.layer.draw();
}

function clearCableEditHandles() {
  if (planState.cableEditHandles) {
    planState.cableEditHandles.forEach((h) => h.destroy());
    planState.cableEditHandles = null;
    planState.layer.draw();
  }
}

// ------------------------------------------------------------
// Подключение устройства к кабелю напрямую — без промежуточного сокета. Устройство,
// подключённое к кабелю, становится частью его сетевого сегмента (см. networkRepo.buildTree).
// Роутер/свитч — многопортовые (могут быть подключены к нескольким кабелям сразу),
// остальные устройства — только к одному (правило внутри cableConnectionsRepo на бэкенде).
// ------------------------------------------------------------

const NEAREST_CABLE_THRESHOLD = 0.5; // клеток — по сути "та же клетка"; так и должно быть

/** Ближайшая точка к p на отрезке [a,b] — в тех же координатах, что и сам путь (клетки) */
function closestPointOnSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { x: a.x, y: a.y };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** Ближайший уже нарисованный кабель к точке cellPoint (в клетках) — используется при
 *  размещении устройства (авто-подключение) и в инспекторе (подсветка ближайшего в списке). */
function findNearestCablePoint(cellPoint) {
  let best = null;
  planState.cablesById.forEach((line, cableId) => {
    const cable = line.getAttr('cableData');
    const path = JSON.parse(cable.path || '[]');
    for (let i = 0; i < path.length - 1; i++) {
      const closest = closestPointOnSegment(cellPoint, path[i], path[i + 1]);
      const dist = Math.hypot(closest.x - cellPoint.x, closest.y - cellPoint.y);
      if (!best || dist < best.dist) best = { cableId, x: closest.x, y: closest.y, dist };
    }
  });
  return best;
}

/** Начинает рисование кабеля с указанной точки (в клетках, дробные координаты —
 *  путь кабеля не обязан лежать строго на сетке, это условная трасса реальной проводки). */
function startCableDraft(cellX, cellY) {
  if (isLayerLocked(3)) { flashModeWarning('Слой "кабель-менеджмент" заблокирован'); return; }
  planState.cableDraft = { path: [{ x: cellX, y: cellY }] };
}

/** Добавляет точку к уже начатому пути, либо начинает новый, если рисование ещё не шло —
 *  единая точка входа что для клика по пустому месту, что по устройству/столу. */
function addCablePoint(cellX, cellY) {
  if (isLayerLocked(3)) { flashModeWarning('Слой "кабель-менеджмент" заблокирован'); return; }
  if (!planState.cableDraft) { startCableDraft(cellX, cellY); return; }
  planState.cableDraft.path.push({ x: cellX, y: cellY });
}

function updateCablePreview(pointer) {
  const draft = planState.cableDraft;
  if (!draft) return;
  const pathPx = draft.path.flatMap((p) => [p.x * CELL_PX, p.y * CELL_PX]);
  const pts = [...pathPx, pointer.x, pointer.y];
  if (!planState.cablePreviewLine) {
    planState.cablePreviewLine = new Konva.Line({
      points: pts, stroke: CABLE_COLOR, strokeWidth: 2, dash: [6, 4], opacity: 0.6, listening: false
    });
    planState.layer.add(planState.cablePreviewLine);
  } else {
    planState.cablePreviewLine.points(pts);
  }
  planState.layer.draw();
}

/** Завершает рисование кабеля тем путём, что уже накопился — вызывается правым кликом
 *  по канве в режиме "Кабель" (см. stage.on('contextmenu', ...) в initPlan). Устройства
 *  на концах больше не обязательны: связь с сетью даёт не сам кабель, а прямое
 *  подключение к нему. Если draft.extendingCableId задан (режим "Продолжить из
 *  последней точки") — дорисовывает СУЩЕСТВУЮЩИЙ кабель, а не создаёт новый. */
async function finishCableDraft() {
  if (isLayerLocked(3)) { flashModeWarning('Слой "кабель-менеджмент" заблокирован'); return; }
  const draft = planState.cableDraft;
  if (!draft || draft.path.length < 2) {
    flashModeWarning('Нужно минимум 2 точки — кликните ещё раз перед завершением');
    return;
  }
  if (draft.extendingCableId) {
    const updated = await window.api.cables.updatePath(draft.extendingCableId, draft.path);
    refreshCableVisual(draft.extendingCableId, updated);
  } else {
    const cable = await window.api.cables.create({
      floor_plan_id: planState.floorPlan.id,
      cable_type: 'network',
      path: draft.path
    });
    renderCable(cable);
  }
  cancelCableDraft();
}

function cancelCableDraft() {
  planState.cableDraft = null;
  if (planState.cablePreviewLine) { planState.cablePreviewLine.destroy(); planState.cablePreviewLine = null; }
  if (planState.layer) planState.layer.draw();
}

async function removeCable(id) {
  if (planState.viewMode) return;
  await window.api.cables.remove(id);
  const line = planState.cablesById.get(id);
  if (line) { line.destroy(); planState.cablesById.delete(id); }
  // Подключения устройств к этому кабелю удалятся каскадом на сервере
  // (cable_connections.cable_id ON DELETE CASCADE)
  if (planState.selectedNode === line) { planState.selectedNode = null; renderInspector(null); }
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
  group.visible(planState.layerState[0] !== 'hidden');

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
    if (planState.mode === 'delete') {
      if (isNodeLocked(group)) { flashModeWarning('Слой заблокирован'); return; }
      await removeZone(zone.id);
      return;
    }
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
      rotation: zone.label_rotation || 0, draggable: !isNodeLocked(group), listening: true
    });
    labelNode.offsetX(labelNode.width() / 2);
    labelNode.offsetY(labelNode.height() / 2);
    labelNode.on('click', (e) => {
      if (e.evt && e.evt.button !== undefined && e.evt.button !== 0) return;
      e.cancelBubble = true;
      selectNode(group);
    });
    labelNode.on('dragstart', () => {
      if (planState.panFrom || isNodeLocked(group)) labelNode.stopDrag();
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
  enforceLayerZOrder(group); // зона на слое 0 — всегда самый низ, даже если добавлена позже стен
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
    if (e.target === planState.stage) {
      addCablePoint(pointer.x / CELL_PX, pointer.y / CELL_PX);
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

  if (planState.pendingLine) {
    updateLinePreview(pointer);
    clearLineStartPreview();
  } else if (planState.cableDraft) {
    updateCablePreview(pointer);
  } else if (planState.mode === 'door') {
    updateDoorPreview(pointer);
    clearDeskPreview();
    clearLineStartPreview();
  } else if (planState.mode === 'desk') {
    updateDeskPreview(pointer);
    clearDoorPreview();
    clearLineStartPreview();
  } else if (planState.mode === 'wall' || planState.mode === 'stairs') {
    updateLineStartPreview(pointer);
    clearDeskPreview();
    clearDoorPreview();
  } else {
    clearDeskPreview();
    clearDoorPreview();
    clearLineStartPreview();
  }
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
  const itemType = node && node.getAttr('itemData')?.item_type;
  const wasDevice = itemType === 'device';
  const wasGroup = itemType === 'group';
  if (wasGroup && groupPanelState.groupItemId === id) closeGroupPanel(); // панель показывала именно эту группу
  await window.api.planItems.remove(id);
  if (node) { node.destroy(); planState.itemsById.delete(id); }
  // Кабели больше не удаляются каскадно вместе с устройством (from/to_item_id теперь
  // ON DELETE SET NULL, не CASCADE) — физическая трасса остаётся на плане, как и в жизни
  // отключение компьютера не обрывает провод, идущий в стене
  if (planState.selectedNode === node) { planState.selectedNode = null; renderInspector(null); }
  planState.layer.draw();
  if (wasDevice || wasGroup) fillDevicePicker(); // освободившееся устройство(а) должно снова появиться в кармане
}

async function placeNewItem(x, y) {
  if (isLayerLocked(2)) { flashModeWarning('Слой "столы" заблокирован'); return; }
  if (planState.mode === 'desk') {
    const item = await window.api.planItems.create({ floor_plan_id: planState.floorPlan.id, item_type: 'desk', x, y });
    renderPointItem(item);
  }
}

/** Размещает устройство на плане в указанной клетке — вызывается из drop-обработчика кармана "Устройства" */
async function placeDeviceItem(deviceId, x, y) {
  if (isLayerLocked(4)) { flashModeWarning('Слой "оборудование" заблокирован'); return; }
  const result = await window.api.planItems.placeDeviceWithGrouping(planState.floorPlan.id, deviceId, x, y);
  const item = result.item;

  if (!result.wasGrouped) {
    // Клетка была пуста — обычное одиночное размещение, как и раньше
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

    // Авто-подключение к ближайшему кабелю — только если реально попали в ту же клетку
    // (порог 0.5 клетки), иначе тихо ничего не подключаем — в инспекторе всегда доступен
    // явный выбор из всех кабелей этажа, дистанционный подбор тут лишь удобство при точном попадании
    const nearestCable = findNearestCablePoint({ x: x + 0.5, y: y + 0.5 });
    if (nearestCable && nearestCable.dist <= NEAREST_CABLE_THRESHOLD) {
      await window.api.cableConnections.connect(item.id, nearestCable.cableId);
    }

    renderPointItem(item);
    fillDevicePicker(); // размещённое устройство больше не должно предлагаться повторно
    return;
  }

  // Клетка была занята — образовалась группа (по аналогии с папками Android: второй
  // элемент на ту же клетку создаёт контейнер вместо перекрытия). Два подслучая:
  // либо это СВЕЖАЯ группа с НОВЫМ id (заменила старый одиночный узел на клетке — его
  // нужно убрать с канвы), либо устройство присоединилось к УЖЕ отрисованной группе
  // (id тот же — просто обновляем счётчик на существующем узле).
  for (const [oldId, node] of planState.itemsById) {
    const data = node.getAttr('itemData');
    if (data && data.x === x && data.y === y && oldId !== item.id && (data.item_type === 'device' || data.item_type === 'group')) {
      destroyPlanItemNode(oldId, node);
    }
  }

  const members = await window.api.planItems.groupMembers(item.id);
  item.member_count = members.length;

  if (planState.itemsById.has(item.id)) {
    refreshPointItemVisual(item); // группа уже была на канве — просто перерисовываем со свежим счётчиком
  } else {
    renderPointItem(item);
  }
  fillDevicePicker();
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
    cable: 'клик — точки маршрута (по устройству или пустому месту); правый клик — завершить линию',
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
    clearLineStartPreview();
  }

  Object.entries(buttons).forEach(([key, btn]) => {
    btn.addEventListener('click', () => setMode(planState.mode === key ? null : key));
  });
  cancelBtn.addEventListener('click', () => setMode(null));

  planState.setToolMode = setMode; // нужен переключателю режима просмотра — сбросить активный инструмент
}

let devicePickerCache = [];

let placementsCache = []; // размещения ВСЕХ устройств (device_id -> куда идти) — для поиска по всем этажам/группам

async function fillDevicePicker() {
  const [all, placedIds, placements] = await Promise.all([
    window.api.devices.list(),
    window.api.planItems.listPlacedDeviceIds(),
    window.api.planItems.listAllDevicePlacements()
  ]);
  const placedSet = new Set(placedIds);
  // VM не размещаются на плане — у них нет физического места, они "живут" внутри
  // своего физического хоста (host_device_id). См. комментарий в schema.sql.
  devicePickerCache = all.filter((d) => d.status !== 'decommissioned' && d.device_type !== 'vm' && !placedSet.has(d.id));
  renderDeviceDragList(devicePickerCache);
  placementsCache = placements;
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
  // устройство, которое само подходит под запрос (тот же принцип, что и в обратную
  // сторону) — по ВСЕМ устройствам, не только неразмещённым, иначе "чьё это Х" не
  // находило владельца, если Х уже стоит на плане
  const matchedUsers = !q ? userDragCache : userDragCache.filter((u) => {
    if (u.full_name.toLowerCase().includes(q)) return true;
    return devicesCache.some((d) => d.owner_user_id === u.id && deviceMatchesQuery(d));
  });
  renderUserDragList(matchedUsers);

  renderWarehouseDragList(!q ? warehouseDragCache : warehouseDragCache.filter((w) =>
    `${w.description} ${w.item_type}`.toLowerCase().includes(q)));

  renderPlacedSearchResults(q, deviceMatchesQuery);
}

/** Раздел "уже размещено" — устройства, которые УЖЕ стоят на каком-то этаже (в т.ч.
 *  внутри группы/"шкафа"), а не только те, что ещё лежат в кармане "перетащить на
 *  план". Раньше поиск смотрел только карман — если искомое уже размещено, найти
 *  его было нельзя. Клик — переход на нужный этаж (и открытие группы, если внутри неё). */
function renderPlacedSearchResults(q, deviceMatchesQuery) {
  const container = document.getElementById('plan-search-placed-results');
  if (!q) { container.classList.add('hidden'); container.innerHTML = ''; return; }

  const placedIds = new Set(placementsCache.map((p) => p.device_id));
  const matches = devicesCache.filter((d) => placedIds.has(d.id) && deviceMatchesQuery(d));
  if (matches.length === 0) { container.classList.add('hidden'); container.innerHTML = ''; return; }

  container.classList.remove('hidden');
  container.innerHTML = '';
  const heading = document.createElement('div');
  heading.className = 'plan-search-placed-heading';
  heading.textContent = 'Уже на плане:';
  container.appendChild(heading);

  matches.forEach((d) => {
    const placement = placementsCache.find((p) => p.device_id === d.id);
    const row = document.createElement('div');
    row.className = 'plan-search-placed-row';
    const floorNote = placement.via_group ? ` (в группе, этаж «${placement.floor_plan_name}»)` : ` (этаж «${placement.floor_plan_name}»)`;
    row.innerHTML = `📍 ${d.hostname || '(без имени)'}<span class="group-member-type">${d.device_type}</span>`;
    const note = document.createElement('span');
    note.className = 'plan-search-placed-note';
    note.textContent = floorNote;
    row.appendChild(note);
    row.onclick = () => findDeviceOnPlan(d.id);
    container.appendChild(row);
  });
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
    updateDropTargetPreview(clientToStagePoint(e.clientX, e.clientY));
  });
  container.addEventListener('dragleave', () => {
    clearDropTargetPreview();
  });
  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    clearDropTargetPreview();
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
      if (isLayerLocked(0)) { flashModeWarning('Слой "зоны" заблокирован'); return; }
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
const PLAN_INSPECTOR_WIDTH_KEY = 'networkmap.planInspectorWidth';

/** Вертикальная ручка между рабочей областью плана и инспектором — тянуть можно по
 *  всей высоте разделителя, а не только за нижний правый угол (как было раньше с
 *  нативным CSS resize). Ширина ограничивается теми же min/max, что заданы в CSS
 *  (#plan-inspector), и сохраняется между запусками. */
function bindPlanInspectorResizer() {
  const resizer = document.getElementById('plan-inspector-resizer');
  const inspector = document.getElementById('plan-inspector');
  const MIN_WIDTH = 200;
  const MAX_WIDTH = 640;

  const savedWidth = Number(localStorage.getItem(PLAN_INSPECTOR_WIDTH_KEY));
  if (savedWidth && savedWidth >= MIN_WIDTH && savedWidth <= MAX_WIDTH) {
    inspector.style.width = `${savedWidth}px`;
  }

  let dragging = false;

  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    resizer.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none'; // не выделять текст на канве/инспекторе во время протяжки
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    // Инспектор справа — ширина считается от текущего X мыши до правого края всей области
    const layoutRect = document.querySelector('.plan-layout').getBoundingClientRect();
    const newWidth = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, layoutRect.right - e.clientX)));
    inspector.style.width = `${newWidth}px`;
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('resizing');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    try { localStorage.setItem(PLAN_INSPECTOR_WIDTH_KEY, inspector.style.width.replace('px', '')); }
    catch { /* localStorage недоступен — ширина просто не сохранится между запусками */ }
  });
}

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

const LAYER_NAMES = { 0: 'зоны', 1: 'стены', 2: 'столы', 3: 'кабель-менеджмент', 4: 'оборудование' };
const LAYER_STATE_RU = { visible: 'видимый', locked: 'заблокирован', hidden: 'скрыт' };

/** Кнопки слоёв (0=зоны, 1=стены/мебель, 2=кабели, 3=оборудование) — три состояния:
 *  видимый / заблокирован (виден, но нельзя двигать/удалять/рисовать) / скрыт.
 *  Глобальная настройка, сохраняется при переключении этажей. Привязывается один раз:
 *  клик — быстрое переключение видимый/скрыт (минуя "заблокирован"), правый клик —
 *  меню с явным выбором всех трёх состояний. */
function bindLayerToggles() {
  document.querySelectorAll('.layer-toggle').forEach((btn) => {
    const layerNum = Number(btn.dataset.layer);
    btn.addEventListener('click', () => {
      const next = planState.layerState[layerNum] === 'hidden' ? 'visible' : 'hidden';
      setLayerState(layerNum, next);
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const current = planState.layerState[layerNum];
      const options = [
        { state: 'visible', label: '👁 Показать' },
        { state: 'locked', label: '🔒 Заблокировать' },
        { state: 'hidden', label: '🚫 Скрыть' }
      ].filter((o) => o.state !== current);
      showContextMenu(e.clientX, e.clientY, options.map((o) => ({
        label: o.label, onClick: () => setLayerState(layerNum, o.state)
      })));
    });
  });
  updateLayerToggleButtons();
  updateToolbarLockedState();
}

/** Меняет состояние одного слоя и применяет последствия: видимость и draggable уже
 *  существующих узлов, внешний вид кнопки, доступность связанных кнопок тулбара. */
function setLayerState(layerNum, newState) {
  planState.layerState[layerNum] = newState;
  applyLayerStates();
  updateLayerToggleButtons();
  updateToolbarLockedState();
}

function updateLayerToggleButtons() {
  document.querySelectorAll('.layer-toggle').forEach((btn) => {
    const layerNum = Number(btn.dataset.layer);
    const state = planState.layerState[layerNum];
    const icon = btn.dataset.icon;
    btn.textContent = state === 'locked' ? `${icon}🔒` : icon;
    btn.classList.remove('state-visible', 'state-locked', 'state-hidden');
    btn.classList.add(`state-${state}`);
    btn.title = `Слой ${layerNum}: ${LAYER_NAMES[layerNum]} — ${LAYER_STATE_RU[state]} ` +
      '(клик — вкл/выкл, правый клик — показать/заблокировать/скрыть)';
  });
}

/** Кнопки тулбара, привязанные к конкретному слою, сереют и перестают работать,
 *  если этот слой заблокирован — отдельно от глобального view-mode-locked. */
function updateToolbarLockedState() {
  const zonesLocked = planState.layerState[0] === 'locked';
  const wallsLocked = planState.layerState[1] === 'locked';
  const desksLocked = planState.layerState[2] === 'locked';
  const cablesLocked = planState.layerState[3] === 'locked';
  const devicesLocked = planState.layerState[4] === 'locked';
  ['mode-wall', 'mode-door', 'mode-stairs'].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = wallsLocked;
  });
  const deskBtn = document.getElementById('mode-desk');
  if (deskBtn) deskBtn.disabled = desksLocked;
  const cableBtn = document.getElementById('mode-cable');
  if (cableBtn) cableBtn.disabled = cablesLocked;
  const deviceList = document.getElementById('device-drag-list');
  if (deviceList) deviceList.classList.toggle('layer-locked-pocket', devicesLocked);
  const zoneTool = document.getElementById('zone-drag-item');
  if (zoneTool) zoneTool.classList.toggle('layer-locked-pocket', zonesLocked);
}

/** Применяет текущее planState.layerState ко всем уже отрисованным объектам — видимость
 *  и draggable (для точечных объектов и подписи зоны). Не нужна при создании новых
 *  объектов — те сами выставляют себе то и другое при отрисовке (см. planLayerFor). */
// Палитра для контура занятости на плане — намеренно без красного/жёлтого/оранжевого:
// эти уже заняты системными смыслами (danger/attention, выделение узла) в этом же
// интерфейсе, повторное использование запутало бы, что означает какой цвет.
const LOCK_OUTLINE_PALETTE = ['#3b82f6', '#10b981', '#8b5cf6', '#ec4899', '#06b6d4', '#6366f1', '#65a30d', '#0891b2'];

/** Стабильный цвет для конкретного держателя блокировки — простой хэш hostname в индекс
 *  палитры, так что у одного и того же клиента цвет не "прыгает" между тиками. */
function colorForLockHolder(hostname) {
  let hash = 0;
  for (let i = 0; i < hostname.length; i++) hash = (hash * 31 + hostname.charCodeAt(i)) | 0;
  return LOCK_OUTLINE_PALETTE[Math.abs(hash) % LOCK_OUTLINE_PALETTE.length];
}

function applyLayerStates() {
  planState.itemsById.forEach((node) => {
    const planLayer = node.getAttr('planLayer');
    if (planLayer === null || planLayer === undefined) return;
    node.visible(planState.layerState[planLayer] !== 'hidden');
    if (node.getAttr('kind') === 'point') node.draggable(!isNodeLocked(node));

    // Цветной контур занятости — как в Google Таблицах: видно, что объект держит
    // кто-то, ещё до попытки его отредактировать, а не только по факту отказа.
    const itemData = node.getAttr('itemData');
    if (itemData && (itemData.item_type === 'device' || itemData.item_type === 'group') && !itemData.via_group) {
      const outline = node.findOne('.lockOutline');
      if (outline) {
        const held = activeLocksSnapshot.find((l) => l.type === 'plan_item' && l.id === itemData.id);
        if (held) { outline.visible(true); outline.stroke(colorForLockHolder(held.hostname)); }
        else outline.visible(false);
      }
    }
  });
  planState.cablesById.forEach((line) => {
    line.visible(planState.layerState[3] !== 'hidden');
  });
  planState.zonesById.forEach((node) => {
    node.visible(planState.layerState[0] !== 'hidden');
    const label = node.getAttr('labelNode');
    if (label) label.draggable(!isNodeLocked(node));
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
  // initial=true — при самой первой привязке канва (planState.layer) ещё не создана
  // (buildStageForCurrentFloor выполнится позже в initPlan), поэтому чистить инструменты
  // здесь физически нечего и не из чего — попытка это сделать падала с "Cannot read
  // properties of null (reading 'draw')" именно в клиентском режиме, где planState.viewMode
  // уже true к этому моменту (выставляется до initPlan, см. startup-код).
  updateModeSwitchUI(true);
}

let activeLocksSnapshot = []; // [{type, id, hostname, isMine}, ...] — что сейчас занято прямо сейчас, актуально и хосту, и клиенту

/** Кнопка "✏️ Рисование" доступна клиенту, только если хост разрешил запись (тумблер) —
 *  без этого переключаться в режим редактирования бессмысленно, любое действие всё
 *  равно отклонит бэкенд. Явно показываем это ДО попытки, а не после непонятной ошибки. */
function updateClientWritePermissionUI(allowWrites) {
  const btn = document.getElementById('mode-switch-btn');
  if (!btn) return;
  btn.disabled = !allowWrites;
  btn.title = allowWrites ? '' : 'Хост пока не разрешил изменения клиентам';
  if (!allowWrites && !planState.viewMode) {
    // Хост выключил тумблер, пока пользователь уже был в режиме рисования — откатываем
    planState.viewMode = true;
    updateModeSwitchUI();
  }
}

function updateModeSwitchUI(initial = false) {
  const btn = document.getElementById('mode-switch-btn');
  const toolsAside = document.getElementById('plan-tools');
  if (planState.viewMode) {
    btn.textContent = '🔒 Просмотр';
    btn.classList.add('view-mode');
    toolsAside.classList.add('view-mode-locked');
    if (!initial && planState.setToolMode) planState.setToolMode(null); // текущий инструмент всё равно недоступен
  } else {
    btn.textContent = '✏️ Рисование';
    btn.classList.remove('view-mode');
    toolsAside.classList.remove('view-mode-locked');
  }

  // У уже отрисованных объектов включаем/выключаем перетаскивание "живьём" — applyLayerStates
  // учитывает и viewMode, и блокировку конкретного слоя вместе (isNodeLocked)
  applyLayerStates();
  updateToolbarLockedState();
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

/** Центр объекта в пикселях канвы — общий для focusOnNode и blinkNode.
 *  У зоны это центроид её клеток, у точечного объекта — центр клетки,
 *  у линии/кабеля — центр их bounding box. */
function getNodeCenterPx(node) {
  const kind = node.getAttr('kind');
  if (kind === 'zone') {
    return computeZoneCentroidPx(JSON.parse(node.getAttr('zoneData').cells));
  }
  if (kind === 'point') {
    return { x: node.x() + CELL_PX / 2, y: node.y() + CELL_PX / 2 };
  }
  const rect = node.getClientRect({ relativeTo: planState.layer });
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function focusOnNode(node) {
  const stage = planState.stage;
  const targetScale = Math.max(stage.scaleX(), 1);
  setZoom(targetScale);
  const wrap = document.getElementById('plan-stage-wrap');
  wrap.scrollLeft = 0;
  wrap.scrollTop = 0;
  const center = { x: wrap.clientWidth / 2, y: wrap.clientHeight / 2 };
  const nodeCenter = getNodeCenterPx(node);
  stage.position({ x: center.x - nodeCenter.x * stage.scaleX(), y: center.y - nodeCenter.y * stage.scaleY() });
  stage.batchDraw();
}

/** Пульсирующее кольцо вокруг объекта, 2-3 раза — постоянная оранжевая рамка выделения
 *  легко теряется на маленькой (36px) иконке, особенно после автоматического фокуса
 *  издалека ("Найти на плане"). Само выделение (highlight) при этом не трогаем —
 *  кольцо просто временно привлекает внимание поверх него. */
function blinkNode(node, times = 3) {
  if (!node || !planState.layer) return;
  const { x, y } = getNodeCenterPx(node);
  const ring = new Konva.Circle({
    x, y, radius: CELL_PX * 0.55,
    stroke: '#ff3b30', strokeWidth: 3, opacity: 0, listening: false
  });
  planState.layer.add(ring);
  ring.moveToTop();

  let count = 0;
  const pulseOnce = () => {
    if (!ring.getStage()) return; // этаж успели переключить/объект удалили — тихо прекращаем
    ring.radius(CELL_PX * 0.55);
    ring.opacity(0);
    ring.to({
      opacity: 0.9, duration: 0.2,
      onFinish: () => {
        if (!ring.getStage()) return;
        ring.to({
          opacity: 0, radius: CELL_PX * 1.1, duration: 0.35,
          onFinish: () => {
            count++;
            if (!ring.getStage()) return;
            if (count < times) pulseOnce();
            else ring.destroy();
          }
        });
      }
    });
  };
  pulseOnce();
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

/** Безопасно уничтожает узел плана (устройство/группа), убранный с клетки при
 *  образовании/пополнении группы (см. placeDeviceItem, dragend, finishGroupPanelIconDragOut).
 *  Снимает выделение ПЕРЕД уничтожением, если узел был текущим выделением — иначе
 *  planState.selectedNode остаётся указывать на уже удалённый узел, и следующий клик
 *  где угодно падает в unhighlight() с "Cannot read properties of undefined (reading
 *  'stroke')". Этот же класс бага уже чинился точечно в паре мест — теперь один центр. */
function destroyPlanItemNode(oldId, node) {
  if (planState.selectedNode === node) selectNode(null);
  node.destroy();
  planState.itemsById.delete(oldId);
}

function selectNode(node) {
  if (planState.selectedNode) unhighlight(planState.selectedNode);
  clearCableEditHandles();
  planState.selectedNode = node;
  if (node) {
    highlight(node);
    renderInspector(node);
    if (node.getAttr('kind') === 'cable') showCableEditHandles(node);
    const layer = node.getLayer();
    if (layer) layer.draw();
  } else {
    renderInspector(null);
    planState.layer.draw();
  }
}

/** highlight/unhighlight могут вызываться на узле, который к этому моменту уже
 *  уничтожен (destroy()) — например, при образовании группы старый узел на клетке
 *  убирается, пока он был текущим выделением; это уже точечно чинилось в паре мест
 *  (см. destroyPlanItemNode), но каждый раз всплывает в НОВОМ месте, до которого
 *  точечная защита не дотянулась. Правильнее один раз сделать сами эти функции
 *  устойчивыми к уничтоженному узлу — findOne()/getChildren()[0] на нём возвращают
 *  undefined (уничтожение чистит список детей), а .stroke() на undefined падает с
 *  "Cannot read properties of undefined (reading 'stroke')". Проверка на существование
 *  перед вызовом делает случайный промах тихим и безвредным, а не крашем интерфейса. */
function highlight(node) {
  const kind = node.getAttr('kind');
  if (kind === 'point') { const r = node.findOne('Rect'); if (r) r.stroke('#ff9900'); }
  else if (kind === 'line') { const c = node.getChildren()[0]; if (c) c.stroke('#ff9900'); }
  else if (kind === 'cable') { if (node.stroke) node.stroke('#ff9900'); }
  else if (kind === 'socket') { if (node.stroke) node.stroke('#ff9900'); }
  else if (kind === 'zone') { const s = node.getAttr('shapeNode'); if (s) { s.stroke('#ff9900'); s.strokeWidth(2); } }
}

function unhighlight(node) {
  const kind = node.getAttr('kind');
  if (kind === 'point') { const r = node.findOne('Rect'); if (r) r.stroke('#333'); }
  else if (kind === 'line') { const c = node.getChildren()[0]; if (c) c.stroke(lineColor(node.getAttr('itemData').item_type)); }
  else if (kind === 'cable') { if (node.stroke) node.stroke(node.getAttr('cableData').color || CABLE_COLOR); }
  else if (kind === 'socket') { if (node.stroke) node.stroke('#333'); }
  else if (kind === 'zone') { const s = node.getAttr('shapeNode'); if (s) { s.stroke(undefined); s.strokeWidth(0); } }
}

/** Кнопка запроса/освобождения права ПЕРЕМЕЩАТЬ конкретный объект на плане —
 *  структурная блокировка 'plan_item', отдельная от блокировки данных устройства
 *  'device' (та даётся через карточку на вкладке "Устройства"). Без неё узел просто
 *  не перетаскивается (см. isNodeLocked). Только для clientModeActive. */
function appendPlanItemLockButton(el, item) {
  if (!clientModeActive) {
    // Хост: своего request/release нет (это его собственная БД) — но он должен ВИДЕТЬ
    // занятость точно так же, как её видит клиент, а не узнавать о ней только по факту
    // отказа при попытке сохранить. Единственный доступный хосту способ вмешаться —
    // принудительно отключить клиента целиком (⚙️ Настройки БД → список клиентов).
    const held = activeLocksSnapshot.find((l) => l.type === 'plan_item' && l.id === item.id);
    if (held) {
      const wrap = document.createElement('div');
      wrap.className = 'edit-lock-controls';
      wrap.textContent = `🔒 Сейчас редактируется клиентом «${held.hostname}» — откройте ⚙️ Настройки БД, чтобы отключить его принудительно.`;
      el.appendChild(wrap);
    }
    return;
  }
  const key = `plan_item:${item.id}`;
  const wrap = document.createElement('div');
  wrap.className = 'edit-lock-controls';
  const statusEl = document.createElement('span');
  statusEl.className = 'edit-lock-status';
  const requestBtn = document.createElement('button');
  requestBtn.type = 'button';
  requestBtn.className = 'edit-lock-request-btn';
  requestBtn.textContent = '🔒 Запросить право перемещения';
  const releaseBtn = document.createElement('button');
  releaseBtn.type = 'button';
  releaseBtn.className = 'edit-lock-release-btn hidden';
  releaseBtn.textContent = '🔓 Освободить';

  const alreadyHeld = clientHeldLockKeys.has(key);
  requestBtn.classList.toggle('hidden', alreadyHeld);
  releaseBtn.classList.toggle('hidden', !alreadyHeld);
  if (alreadyHeld) statusEl.textContent = '✏️ Вы можете перемещать';

  requestBtn.onclick = async () => {
    requestBtn.disabled = true;
    statusEl.textContent = 'Запрашиваем…';
    const result = await window.api.locks.request('plan_item', item.id);
    requestBtn.disabled = false;
    if (result.ok) {
      clientHeldLockKeys.add(key);
      applyLayerStates();
      requestBtn.classList.add('hidden');
      releaseBtn.classList.remove('hidden');
      statusEl.textContent = '✏️ Вы можете перемещать';
    } else {
      const message = result.error || 'Не удалось получить право';
      statusEl.textContent = message;
      showToast(`⛔ ${message}`, 'error', 7000);
    }
  };
  releaseBtn.onclick = async () => {
    await window.api.locks.release('plan_item', item.id);
    clientHeldLockKeys.delete(key);
    applyLayerStates();
    requestBtn.classList.remove('hidden');
    releaseBtn.classList.add('hidden');
    statusEl.textContent = '';
  };

  wrap.append(requestBtn, releaseBtn, statusEl);
  el.appendChild(wrap);
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
    } else if (item.item_type === 'group') {
      el.appendChild(field('Тип', 'Группа устройств (шкаф)'));
      el.appendChild(field('Название', item.group_label || '(без названия)'));
      el.appendChild(field('Устройств внутри', String(item.member_count ?? '—')));
      el.appendChild(field('Координаты', `x=${item.x}, y=${item.y}`));
      appendPlanItemLockButton(el, item);

      const openPanelBtn = document.createElement('button');
      openPanelBtn.type = 'button';
      openPanelBtn.className = 'tool-btn';
      openPanelBtn.textContent = '📂 Открыть содержимое';
      openPanelBtn.onclick = () => openGroupPanel(item.id);
      el.appendChild(openPanelBtn);

      // Подключение к кабелю привязано к группе целиком (кабель заходит в шкаф,
      // а не в конкретный юнит внутри него — см. openGroupPanel/renderGroupPanelIcon)
      const cableConnWrap = document.createElement('div');
      cableConnWrap.className = 'inspector-field';
      const cableConnLabel = document.createElement('label');
      cableConnLabel.textContent = 'Подключение к сети (кабель для всей группы)';
      cableConnWrap.appendChild(cableConnLabel);
      const cableConnBody = document.createElement('div');
      cableConnBody.textContent = 'Загрузка…';
      cableConnWrap.appendChild(cableConnBody);
      el.appendChild(cableConnWrap);
      renderDeviceCableConnectionsSection(cableConnBody, item, node);

      appendDeleteButton(el, () => removePlanItem(item.id));
      return; // группа обработана целиком — общий appendDeleteButton в конце функции не нужен
    } else {
      el.appendChild(field('Тип', `Устройство (${item.device_type || '—'})`));
      el.appendChild(field('Hostname', item.device_hostname || '—'));
      el.appendChild(field('IP-адрес', item.device_ip || '—'));
      el.appendChild(field('Статус пинга', pingStatusLabel(item.last_ping_status)));

      if (!item.via_group) {
        // Координаты/зона/подключение к кабелю/комментарий "на проверку" осмысленны
        // только для устройства с СОБСТВЕННЫМ местом на плане — у устройства внутри
        // группы своего plan_item нет вообще, сеть подключается к самой группе целиком
        // (см. openGroupPanel), а не к отдельным устройствам внутри неё
        el.appendChild(field('Координаты', `x=${item.x}, y=${item.y}`));
        appendPlanItemLockButton(el, item);
        const itemZone = findZoneForCell(item.x, item.y);
        if (itemZone) el.appendChild(field('Зона', itemZone.name));
        if (item.review_note) el.appendChild(field('⚠️ На проверку', item.review_note));
        if (item.device_ip) appendPingButton(el, item);

        // Подключение к кабелю напрямую (без сокета) — устройство становится частью
        // сетевого сегмента этого кабеля (вкладка "Сеть"). Роутер/свитч — многопортовые,
        // остальные устройства — только один кабель разом (правило на бэкенде).
        const cableConnWrap = document.createElement('div');
        cableConnWrap.className = 'inspector-field';
        const cableConnLabel = document.createElement('label');
        cableConnLabel.textContent = 'Подключение к сети (кабель)';
        cableConnWrap.appendChild(cableConnLabel);
        const cableConnBody = document.createElement('div');
        cableConnBody.textContent = 'Загрузка…';
        cableConnWrap.appendChild(cableConnBody);
        el.appendChild(cableConnWrap);
        renderDeviceCableConnectionsSection(cableConnBody, item, node);
      } else {
        if (item.device_ip) appendPingButton(el, item);
      }

      if (item.device_type === 'router' || item.device_type === 'switch') {
        const pingConnectedBtn = document.createElement('button');
        pingConnectedBtn.type = 'button';
        pingConnectedBtn.className = 'tool-btn';
        pingConnectedBtn.textContent = '🔄📶 Пинг подключённых устройств';
        pingConnectedBtn.title = 'Обход по уже нарисованным кабелям от этого устройства';
        pingConnectedBtn.onclick = () => pingManyDevices(getConnectedDeviceIds(item.id), item.device_hostname || 'сеть');
        el.appendChild(pingConnectedBtn);

        const uplinkWrap = document.createElement('div');
        uplinkWrap.className = 'inspector-field';
        const uplinkLabel = document.createElement('label');
        uplinkLabel.textContent = 'Аплинк для вкладки "Сеть"';
        const uplinkSelect = document.createElement('select');
        const noneOpt = document.createElement('option');
        noneOpt.value = '';
        noneOpt.textContent = '— не задан —';
        uplinkSelect.appendChild(noneOpt);
        devicesCache
          .filter((d) => ['router', 'switch', 'server'].includes(d.device_type) && d.id !== item.ref_id && d.status !== 'decommissioned')
          .forEach((d) => {
            const opt = document.createElement('option');
            opt.value = d.id;
            opt.textContent = `[${d.device_type}] ${d.hostname || '(без имени)'}`;
            uplinkSelect.appendChild(opt);
          });
        uplinkSelect.value = item.device_uplink_id || '';
        uplinkSelect.title = 'Куда подключён этот роутер/свитч — используется, когда кабель провести нельзя (например, через этажи)';
        uplinkSelect.onchange = async () => {
          const val = uplinkSelect.value ? Number(uplinkSelect.value) : null;
          await window.api.devices.setUplink(item.ref_id, val);
          item.device_uplink_id = val;
          node.setAttr('itemData', item);
        };
        uplinkWrap.appendChild(uplinkLabel);
        uplinkWrap.appendChild(uplinkSelect);
        el.appendChild(uplinkWrap);
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
          if (item.via_group) refreshGroupPanelIcon(item.ref_id, item); else refreshPointItemVisual(item);
        };
        el.appendChild(unassignBtn);
      }

      const extras = document.createElement('div');
      extras.id = 'inspector-extras';
      extras.textContent = 'Загрузка…';
      el.appendChild(extras);
      renderDeviceExtras(extras, item.ref_id);
    }
    if (item.via_group) {
      const removeFromGroupBtn = document.createElement('button');
      removeFromGroupBtn.type = 'button';
      removeFromGroupBtn.className = 'tool-btn tool-danger';
      removeFromGroupBtn.textContent = '✕ Убрать из группы';
      removeFromGroupBtn.onclick = () => removeDeviceFromGroupPanel(item.ref_id);
      el.appendChild(removeFromGroupBtn);
    } else {
      appendDeleteButton(el, () => removePlanItem(item.id));
    }
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
    const path = JSON.parse(cable.path || '[]');
    el.appendChild(field('Кабель', `№${cable.id}`));
    el.appendChild(field('Точек маршрута', String(path.length)));

    const nameWrap = document.createElement('div');
    nameWrap.className = 'inspector-field';
    const nameLabel = document.createElement('label');
    nameLabel.textContent = 'Имя (необязательно)';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = cable.label || '';
    nameInput.placeholder = 'например, «Магистраль А»';
    nameInput.onchange = async () => {
      const updated = await window.api.cables.setLabel(cable.id, nameInput.value);
      node.setAttr('cableData', updated);
    };
    nameWrap.appendChild(nameLabel);
    nameWrap.appendChild(nameInput);
    el.appendChild(nameWrap);

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
/** Открывает модалку управления группой устройств (несколько устройств в одной клетке —
 *  "папка", как в Android). Позволяет переименовать группу, открыть карточку любого
 *  устройства внутри, убрать устройство из группы (с автоматическим разгруппированием,
 *  если останется одно — та же логика уже реализована на бэкенде). */
/** Состояние боковой панели группы — своя мини-канва (Konva.Stage), 1 клетка в ширину,
 *  устройства выстроены в столбик, каждое — настоящий Konva-узел, кликабельный и
 *  выделяемый точно так же, как на основном плане (тот же selectNode/renderInspector). */
let groupPanelState = {
  groupItemId: null,
  stage: null,
  layer: null,
  nodesByDeviceId: new Map() // device.id -> Konva.Group, порядок вставки = порядок отрисовки сверху вниз
};

/** Открывает панель группы (или переключает её на другую группу, если уже открыта) —
 *  боковая полоса рядом с инспектором, а не модальное окно поверх экрана. Именно
 *  поэтому карман с пользователями (#plan-tools) остаётся видимым и доступным для
 *  перетаскивания, пока панель открыта — раньше модалка эту панель полностью закрывала. */
async function openGroupPanel(groupItemId) {
  const panel = document.getElementById('group-panel');
  const labelInput = document.getElementById('group-panel-label-input');

  const groupNode = planState.itemsById.get(groupItemId);
  const groupData = groupNode ? groupNode.getAttr('itemData') : null;
  labelInput.value = groupData ? (groupData.group_label || '') : '';

  if (groupPanelState.stage) {
    // Выделенный узел мог принадлежать ПЕРЕСОБИРАЕМОЙ панели (например, только что убрали
    // устройство из группы и панель обновляется) — снимаем выделение ДО уничтожения канвы,
    // иначе planState.selectedNode будет указывать на уже удалённый узел (тот же приём,
    // что и в closeGroupPanel)
    if (planState.selectedNode && [...groupPanelState.nodesByDeviceId.values()].includes(planState.selectedNode)) {
      selectNode(null);
    }
    groupPanelState.stage.destroy();
  }
  groupPanelState.groupItemId = groupItemId;
  groupPanelState.nodesByDeviceId = new Map();

  const members = await window.api.planItems.groupMembers(groupItemId);
  const stageHeight = Math.max(members.length * CELL_PX, CELL_PX);
  groupPanelState.stage = new Konva.Stage({ container: 'group-panel-stage', width: CELL_PX, height: stageHeight });
  groupPanelState.layer = new Konva.Layer();
  groupPanelState.stage.add(groupPanelState.layer);

  members.forEach((m, i) => renderGroupPanelIcon(m, i));
  groupPanelState.layer.draw();

  panel.classList.remove('hidden');
}

function closeGroupPanel() {
  // Выделенный узел мог принадлежать закрываемой панели — снимаем выделение ДО
  // уничтожения канвы, иначе planState.selectedNode будет указывать на удалённый узел
  if (planState.selectedNode && [...groupPanelState.nodesByDeviceId.values()].includes(planState.selectedNode)) {
    selectNode(null);
  }
  document.getElementById('group-panel').classList.add('hidden');
  if (groupPanelState.stage) { groupPanelState.stage.destroy(); groupPanelState.stage = null; groupPanelState.layer = null; }
  groupPanelState.groupItemId = null;
  groupPanelState.nodesByDeviceId = new Map();
}

/** Рисует одну иконку устройства внутри панели группы — упрощённый аналог
 *  device-ветки renderPointItem: та же раскраска по типу/статусу, тот же глиф,
 *  но без перетаскивания между клетками (клетка тут одна, смысла нет) и без
 *  собственного plan_item — itemData.via_group=true, id это device.id, а не
 *  id несуществующей записи в plan_items (см. renderInspector). */
function renderGroupPanelIcon(device, index) {
  const size = CELL_PX - 4;
  const node = new Konva.Group({ x: 2, y: index * CELL_PX + 2 });
  node.setAttr('kind', 'point');

  const itemData = {
    id: device.id, // синтетический — device_id, у устройства внутри группы своего plan_item нет
    ref_id: device.id,
    item_type: 'device',
    via_group: true,
    device_type: device.device_type,
    device_hostname: device.hostname,
    device_ip: device.primary_ip,
    last_ping_status: device.last_ping_status,
    owner_user_id: device.owner_user_id,
    owner_name: device.owner_name,
    device_status: device.status,
    device_flag: device.flag,
    owner_status: device.owner_status
  };
  node.setAttr('itemData', itemData);

  const STATUS_BORDER_COLORS = { repair: '#ecc94b', storage: '#7ea6d6', decommissioned: '#999' };
  const color = DEVICE_COLORS[device.device_type] || '#777';
  const borderColor = STATUS_BORDER_COLORS[device.status] || '#333';
  const borderWidth = STATUS_BORDER_COLORS[device.status] ? 2.5 : 1;

  node.add(new Konva.Rect({ width: size, height: size, fill: color, stroke: borderColor, strokeWidth: borderWidth, cornerRadius: 4 }));

  const glyphSize = Math.round(size * 0.45);
  const glyphGroup = new Konva.Group({ x: (size - glyphSize) / 2, y: 3 });
  addDeviceGlyph(glyphGroup, device.device_type, glyphSize, glyphSize);
  node.add(glyphGroup);

  node.add(new Konva.Text({
    text: device.hostname || '?', x: -1, y: glyphSize + 5, width: size - 2,
    fontSize: 6.5, fontStyle: 'bold', fill: '#fff', align: 'center',
    ellipsis: true, wrap: 'none', lineHeight: 1, name: 'hostnameLabel'
  }));
  node.add(new Konva.Text({
    text: device.owner_name || '', x: -1, y: glyphSize + 13, width: size - 2,
    fontSize: 6, fill: 'rgba(255,255,255,0.85)', align: 'center',
    ellipsis: true, wrap: 'none', lineHeight: 1, name: 'ownerLabel'
  }));
  node.add(new Konva.Circle({
    x: size - 6, y: 6, radius: 4, fill: pingColor(device.last_ping_status),
    stroke: '#fff', strokeWidth: 1, name: 'pingBadge'
  }));

  node.on('click', () => selectNode(node));
  node.on('mousedown', (e) => {
    if (e.evt.button !== 0) return; // только левая кнопка
    startGroupPanelIconDragOut(device, e.evt.clientX, e.evt.clientY);
  });

  groupPanelState.layer.add(node);
  groupPanelState.nodesByDeviceId.set(device.id, node);
  return node;
}

/** Лёгкое обновление одной иконки (например, после смены владельца) — вместо полной
 *  перерисовки всей панели. */
function refreshGroupPanelIcon(deviceId, freshItemData) {
  const node = groupPanelState.nodesByDeviceId.get(deviceId);
  if (!node) return;
  node.setAttr('itemData', freshItemData);
  const ownerLabel = node.findOne('.ownerLabel');
  if (ownerLabel) ownerLabel.text(freshItemData.owner_name || '');
  const badge = node.findOne('.pingBadge');
  if (badge) badge.fill(pingColor(freshItemData.last_ping_status));
  groupPanelState.layer.draw();
}

/** Убрать устройство из группы через кнопку в инспекторе (когда выбрана иконка внутри
 *  панели группы) — та же логика на бэкенде, что и раньше (auto-разгруппирование при
 *  одном оставшемся), но теперь корректно обновляет и панель, и основной план. */
/** Общая обработка результата removeFromGroup — три исхода (группа опустела,
 *  разгруппировалась в одиночный элемент, осталась группой). Используется и кнопкой
 *  "Убрать из группы" в инспекторе, и перетаскиванием иконки из панели на основной план. */
async function applyRemoveFromGroupResult(result, groupItemId) {
  const groupNode = planState.itemsById.get(groupItemId);
  // Группа сейчас может быть уничтожена (все три исхода ниже её удаляют/заменяют) —
  // если она была текущим выделением, снимаем его ДО уничтожения, иначе
  // planState.selectedNode будет указывать на уже удалённый узел (тот же приём,
  // что и в closeGroupPanel/openGroupPanel, но здесь для самой группы, а не участника)
  if (groupNode && planState.selectedNode === groupNode) selectNode(null);

  if (result.deleted) {
    if (groupNode) { groupNode.destroy(); planState.itemsById.delete(groupItemId); planState.layer.draw(); }
    closeGroupPanel();
  } else if (result.ungroupedToSingle) {
    // Осталось одно устройство — группа развернулась обратно в одиночный элемент на
    // основном плане; дорисовываем его так же, как обычное размещение (device_* поля с нуля)
    if (groupNode) { groupNode.destroy(); planState.itemsById.delete(groupItemId); }
    const remainingDevice = devicesCache.find((d) => d.id === result.item.ref_id);
    const freshItem = { ...result.item };
    freshItem.device_type = remainingDevice?.device_type;
    freshItem.device_hostname = remainingDevice?.hostname;
    freshItem.device_ip = remainingDevice?.primary_ip;
    freshItem.last_ping_status = remainingDevice?.last_ping_status;
    freshItem.owner_user_id = remainingDevice?.owner_user_id;
    freshItem.owner_name = remainingDevice?.owner_name;
    freshItem.device_status = remainingDevice?.status;
    freshItem.device_flag = remainingDevice?.flag;
    freshItem.owner_status = remainingDevice?.owner_status;
    const newNode = renderPointItem(freshItem);
    closeGroupPanel();
    selectNode(newNode);
  } else {
    const groupItemData = groupNode ? groupNode.getAttr('itemData') : null;
    if (groupNode && groupItemData) {
      const members = await window.api.planItems.groupMembers(groupItemId);
      refreshPointItemVisual({ ...groupItemData, member_count: members.length });
    }
    await openGroupPanel(groupItemId); // пересобираем панель без убранного устройства
    selectNode(planState.itemsById.get(groupItemId)); // возвращаем инспектор к самой группе
  }
  fillDevicePicker(); // убранное из группы устройство снова доступно для перетаскивания
}

/** Общее состояние "призрачного" перетаскивания иконки ИЗ панели группы — Konva не
 *  умеет перетаскивать узел между двумя РАЗНЫМИ канвами визуально (drag ограничен
 *  собственным стейджем), поэтому вместо Konva-драга используется плавающий HTML-
 *  элемент, следующий за курсором через document-уровневые mousemove/mouseup. */
let groupPanelDragOutState = { active: false, deviceId: null, ghost: null };

function startGroupPanelIconDragOut(device, clientX, clientY) {
  groupPanelDragOutState.active = true;
  groupPanelDragOutState.deviceId = device.id;
  const ghost = document.createElement('div');
  ghost.className = 'group-drag-ghost';
  ghost.textContent = `🖥 ${device.hostname || device.device_type}`;
  document.body.appendChild(ghost);
  groupPanelDragOutState.ghost = ghost;
  updateGroupPanelDragGhost(clientX, clientY);
}

function updateGroupPanelDragGhost(clientX, clientY) {
  if (!groupPanelDragOutState.ghost) return;
  groupPanelDragOutState.ghost.style.left = `${clientX + 12}px`;
  groupPanelDragOutState.ghost.style.top = `${clientY + 12}px`;
}

/** Отпустили иконку — если это случилось НАД канвой основного плана, убираем
 *  устройство из группы и размещаем его на этой клетке (переиспользует ту же
 *  группировку, что и обычное перетаскивание — если клетка занята, присоединится
 *  или образует новую группу). Если отпустили не над планом — просто отмена,
 *  панель остаётся как была (устройство никуда не делось). */
async function finishGroupPanelIconDragOut(clientX, clientY) {
  const deviceId = groupPanelDragOutState.deviceId;
  const groupItemId = groupPanelState.groupItemId;
  if (groupPanelDragOutState.ghost) { groupPanelDragOutState.ghost.remove(); }
  groupPanelDragOutState = { active: false, deviceId: null, ghost: null };
  if (!deviceId || !groupItemId || !planState.stage) return;

  // Проверяем попадание именно в ВИДИМУЮ область — сама канва логически огромная
  // (масштабируется под весь план, например 3840×2160px) и обрезается видимым окном
  // через overflow на #plan-stage-wrap; getBoundingClientRect() канвы вернул бы полный
  // логический размер, а не то, что реально видно и куда реально попал курсор
  const wrapRect = document.getElementById('plan-stage-wrap').getBoundingClientRect();
  const overMainPlan = clientX >= wrapRect.left && clientX <= wrapRect.right && clientY >= wrapRect.top && clientY <= wrapRect.bottom;
  if (!overMainPlan) return; // отпущено не над планом — ничего не делаем

  const localPoint = clientToStagePoint(clientX, clientY);
  const targetX = Math.max(0, Math.round(localPoint.x / CELL_PX - 0.5));
  const targetY = Math.max(0, Math.round(localPoint.y / CELL_PX - 0.5));
  const floorPlanId = planState.floorPlan.id;

  const removeResult = await window.api.planItems.removeFromGroup(groupItemId, deviceId);
  await applyRemoveFromGroupResult(removeResult, groupItemId);

  // Перетаскиваемое устройство (deviceId) после removeFromGroup ВСЕГДА оказывается без
  // своего plan_item — независимо от того, что произошло с ОСТАЛЬНОЙ группой (опустела/
  // разгруппировалась в одиночный элемент/осталась группой). removeResult.item, если он
  // есть, относится к ОСТАВШЕМУСЯ в группе устройству (например, при ungroupedToSingle —
  // это как раз ДРУГОЕ устройство, ставшее одиночным на месте бывшей группы), а не к
  // перетаскиваемому — поэтому здесь всегда обычное размещение с нуля, без move-варианта.
  const placeResult = await window.api.planItems.placeDeviceWithGrouping(floorPlanId, deviceId, targetX, targetY);

  if (!placeResult.wasGrouped) {
    const device = devicesCache.find((d) => d.id === deviceId);
    const freshItem = { ...placeResult.item };
    freshItem.device_type = device?.device_type;
    freshItem.device_hostname = device?.hostname;
    freshItem.device_ip = device?.primary_ip;
    freshItem.last_ping_status = device?.last_ping_status;
    freshItem.owner_user_id = device?.owner_user_id;
    freshItem.owner_name = device?.owner_name;
    freshItem.device_status = device?.status;
    freshItem.device_flag = device?.flag;
    freshItem.owner_status = device?.owner_status;
    renderPointItem(freshItem);
  } else {
    for (const [oldId, node] of planState.itemsById) {
      const data = node.getAttr('itemData');
      if (data && data.x === targetX && data.y === targetY && oldId !== placeResult.item.id && (data.item_type === 'device' || data.item_type === 'group')) {
        destroyPlanItemNode(oldId, node);
      }
    }
    const members = await window.api.planItems.groupMembers(placeResult.item.id);
    const freshGroupItem = { ...placeResult.item, member_count: members.length };
    if (planState.itemsById.has(placeResult.item.id)) {
      refreshPointItemVisual(freshGroupItem);
    } else {
      renderPointItem(freshGroupItem);
    }
  }
  fillDevicePicker();
  planState.layer.draw();
}

async function removeDeviceFromGroupPanel(deviceId) {
  const groupItemId = groupPanelState.groupItemId;
  if (!groupItemId) return;
  if (!(await confirmModal('Убрать это устройство из группы?'))) return;
  const result = await window.api.planItems.removeFromGroup(groupItemId, deviceId);
  await applyRemoveFromGroupResult(result, groupItemId);
}

/** Перетаскивание пользователя (карман слева) прямо на иконку устройства ВНУТРИ панели
 *  группы — работает благодаря тому, что панель теперь не модалка, а обычная боковая
 *  панель: карман с пользователями остаётся на экране и доступен для перетаскивания. */
function bindGroupPanelDragDrop() {
  const container = document.getElementById('group-panel-scroll');
  container.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (!groupPanelState.stage || !groupPanelState.groupItemId) return;
    let payload;
    try { payload = JSON.parse(e.dataTransfer.getData('application/json')); } catch { return; }
    if (!payload) return;

    if (payload.type === 'device') {
      // Устройство из кармана "перетащить на план" брошено прямо в открытую панель
      // группы — добавляем его в ЭТУ группу. Переиспользуем placeDeviceWithGrouping
      // с координатами самой группы: код там уже умеет "клетка занята группой —
      // присоединиться к ней", ничего нового на бэкенде не нужно.
      const groupNode = planState.itemsById.get(groupPanelState.groupItemId);
      if (!groupNode) return;
      const groupData = groupNode.getAttr('itemData');
      await window.api.planItems.placeDeviceWithGrouping(planState.floorPlan.id, payload.id, groupData.x, groupData.y);

      const members = await window.api.planItems.groupMembers(groupPanelState.groupItemId);
      refreshPointItemVisual({ ...groupData, member_count: members.length });
      await openGroupPanel(groupPanelState.groupItemId); // пересобираем панель со свежим составом
      fillDevicePicker(); // добавленное в группу устройство больше не должно предлагаться в кармане
      return;
    }

    if (payload.type !== 'user') return;

    const stageRect = groupPanelState.stage.container().getBoundingClientRect();
    const localY = e.clientY - stageRect.top + container.scrollTop;
    const index = Math.floor(localY / CELL_PX);
    const entries = [...groupPanelState.nodesByDeviceId.entries()];
    if (index < 0 || index >= entries.length) return;
    const [deviceId, node] = entries[index];

    await window.api.ownership.assign(deviceId, payload.id);
    const user = userDragCache.find((u) => u.id === payload.id);
    const data = node.getAttr('itemData');
    data.owner_user_id = payload.id;
    data.owner_name = user ? user.full_name : null;
    node.setAttr('itemData', data);
    refreshGroupPanelIcon(deviceId, data);
    if (planState.selectedNode === node) renderInspector(node);
  });
}

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
/** Тихая перестройка текущего этажа — используется, когда изменения с хоста затронули
 *  саму структуру плана (устройство переместилось/появилось/пропало/образовало группу),
 *  а не только данные уже существующей иконки. buildStageForCurrentFloor() сама по себе
 *  сбрасывает зум/панораму/выделение к исходным — здесь они сохраняются и восстанавливаются
 *  вокруг перестройки, иначе для пользователя это выглядело бы как внезапный "прыжок"
 *  вида при каждом чужом изменении, а не тихое обновление. */
async function quietlyReloadCurrentFloor() {
  const stage = planState.stage;
  const savedScale = stage ? stage.scaleX() : null;
  const savedPos = stage ? { x: stage.x(), y: stage.y() } : null;
  const selectedData = planState.selectedNode ? planState.selectedNode.getAttr('itemData') : null;

  closeGroupPanel();
  await buildStageForCurrentFloor();

  if (savedScale !== null && planState.stage) {
    planState.stage.scale({ x: savedScale, y: savedScale });
    planState.stage.position(savedPos);
    planState.stage.batchDraw();
    updateZoomLabel(savedScale);
  }
  // Пытаемся восстановить выделение — тот же plan_item id, если он всё ещё существует
  // после перестройки (устройство никуда не делось, просто его данные обновились)
  if (selectedData && selectedData.id != null) {
    const restored = planState.itemsById.get(selectedData.id);
    if (restored) selectNode(restored);
  }
}

/** Применяет изменения с хоста (см. data-changed) на канву плана тихо, без клика
 *  пользователя. Структурные изменения (entity_type='plan_item' — перемещение,
 *  размещение, удаление, группировка) требуют полной перестройки этажа — координаты
 *  и состав могли поменяться как угодно, точечно это не подправить. Изменения только
 *  данных устройства/владельца (hostname/IP/статус/владелец) — точечное обновление уже
 *  отрисованных иконок через syncPlanDeviceIcon, без пересборки канвы вообще. */
async function applyPlanChangesQuietly(changes) {
  const needsStructuralReload = changes.some((c) => c.entity_type === 'plan_item');
  if (needsStructuralReload) {
    await quietlyReloadCurrentFloor();
    return;
  }

  const deviceChanges = changes.filter((c) => c.entity_type === 'device' || c.entity_type === 'ownership');
  if (deviceChanges.length === 0) return;
  const affectedDeviceIds = [...new Set(deviceChanges.map((c) => c.entity_id).filter((id) => id != null))];
  if (affectedDeviceIds.length === 0) return;

  const freshDevices = await window.api.devices.list();
  affectedDeviceIds.forEach((deviceId) => {
    const fresh = freshDevices.find((d) => d.id === deviceId);
    if (!fresh) return;
    const patch = {
      device_type: fresh.device_type, device_hostname: fresh.hostname, device_ip: fresh.primary_ip,
      device_status: fresh.status, device_flag: fresh.flag,
      owner_user_id: fresh.owner_user_id, owner_name: fresh.owner_name, owner_status: fresh.owner_status
    };
    syncPlanDeviceIcon(deviceId, patch);

    // То же устройство может быть сейчас показано внутри открытой панели группы —
    // у неё своя, отдельная от основного плана мини-канва (см. groupPanelState)
    if (groupPanelState.nodesByDeviceId && groupPanelState.nodesByDeviceId.has(deviceId)) {
      const node = groupPanelState.nodesByDeviceId.get(deviceId);
      const freshData = { ...node.getAttr('itemData'), ...patch };
      refreshGroupPanelIcon(deviceId, freshData);
      if (planState.selectedNode === node) renderInspector(node); // инспектор сейчас показывает именно её
    }
  });
}

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

/** Список текущих подключений устройства к кабелям + форма добавления нового +
 *  роль в сети (для роутера/свитча). Асинхронно, т.к. нужен IPC-запрос — используется
 *  в инспекторе плана сразу после выделения точечного объекта типа "устройство", а также
 *  в модалке группы (там item — сама группа, кабель подключается к шкафу целиком).
 *  onChange — что вызвать после connect/disconnect вместо обновления инспектора по
 *  умолчанию (renderInspector(node)) — модалке группы нужно обновить СВОЙ список, не
 *  боковую панель инспектора, которая с ней никак не связана. */
async function renderDeviceCableConnectionsSection(container, item, node, onChange = () => renderInspector(node)) {
  const [connections, allCables] = await Promise.all([
    window.api.cableConnections.listByPlanItem(item.id),
    window.api.cables.list(planState.floorPlan.id)
  ]);
  container.innerHTML = '';

  const cableLabelText = (cable) => `Кабель №${cable.id}${cable.label ? ` (${cable.label})` : ''}`;

  if (connections.length === 0) {
    container.appendChild(smallListNote('Не подключено'));
  } else {
    const ul = document.createElement('ul');
    ul.className = 'mini-list';
    connections.forEach((conn) => {
      const cable = allCables.find((c) => c.id === conn.cable_id);
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = cable ? cableLabelText(cable) : `Кабель №${conn.cable_id}`;
      li.appendChild(label);
      const disconnectBtn = document.createElement('button');
      disconnectBtn.textContent = 'Отключить';
      disconnectBtn.onclick = async () => {
        await window.api.cableConnections.disconnect(item.id, conn.cable_id);
        onChange();
      };
      li.appendChild(disconnectBtn);
      ul.appendChild(li);
    });
    container.appendChild(ul);
  }

  // Форма добавления — только кабели, к которым ЕЩЁ не подключены; ближайший к
  // устройству — сверху списка, для удобства выбора
  const connectedIds = new Set(connections.map((c) => c.cable_id));
  const available = allCables.filter((c) => !connectedIds.has(c.id));
  if (available.length > 0) {
    const deviceCenter = { x: item.x + 0.5, y: item.y + 0.5 };
    const addForm = document.createElement('div');
    addForm.className = 'inspector-add-form';
    const select = document.createElement('select');
    available
      .map((c) => {
        const path = JSON.parse(c.path || '[]');
        const dist = path.length === 0 ? Infinity : Math.min(...path.map((p) => Math.hypot(p.x - deviceCenter.x, p.y - deviceCenter.y)));
        return { c, dist };
      })
      .sort((a, b) => a.dist - b.dist)
      .forEach(({ c }) => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = cableLabelText(c);
        select.appendChild(opt);
      });
    const addBtn = document.createElement('button');
    addBtn.textContent = '🔌 Подключить';
    addBtn.title = 'Роутер/свитч — можно подключить сразу к нескольким кабелям; остальные устройства — только к одному, старое подключение снимется само';
    addBtn.onclick = async () => {
      await window.api.cableConnections.connect(item.id, Number(select.value));
      onChange();
    };
    addForm.appendChild(select);
    addForm.appendChild(addBtn);
    container.appendChild(addForm);
  }

  // Роль в сети — только для роутера/свитча, только если реально подключён хотя бы к одному кабелю
  if ((item.device_type === 'router' || item.device_type === 'switch') && connections.length > 0) {
    const roleWrap = document.createElement('div');
    roleWrap.className = 'inspector-field';
    const roleLabel = document.createElement('label');
    roleLabel.textContent = 'Роль в сети (если на сегменте несколько роутеров)';
    const roleSelect = document.createElement('select');
    [['', '— не задана —'], ['primary', 'Главный'], ['backup', 'Резервный'], ['satellite', 'Сателлит']]
      .forEach(([value, text]) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = text;
        roleSelect.appendChild(opt);
      });
    roleSelect.value = item.network_role || '';
    roleSelect.onchange = async () => {
      const role = roleSelect.value || null;
      await window.api.planItems.setNetworkRole(item.id, role);
      item.network_role = role;
      node.setAttr('itemData', item);
    };
    roleWrap.appendChild(roleLabel);
    roleWrap.appendChild(roleSelect);
    container.appendChild(roleWrap);
  }
}

/** Единая логика "запросить право редактировать перед тем, как разрешить менять форму"
 *  — используется в карточке устройства, инспекторе плана, панели группы. type/id —
 *  что запрашиваем ('device'|'plan_item'), formEl — форма, чьи поля дизейблить/включать
 *  до/после получения права. Возвращает { wrap, releaseIfHeld } — wrap вставить туда,
 *  где нужно в конкретной карточке; releaseIfHeld вызвать при закрытии/сворачивании
 *  карточки, чтобы не держать право впустую, пока никто не смотрит. Только для
 *  clientModeActive — для хоста/локального режима эта функция не вызывается вообще,
 *  там как и было: форма сразу доступна без всякого согласования. */
function createEditLockControls(type, id, formEl, { onGranted, onReleased } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'edit-lock-controls';

  const statusEl = document.createElement('span');
  statusEl.className = 'edit-lock-status';

  const requestBtn = document.createElement('button');
  requestBtn.type = 'button';
  requestBtn.className = 'edit-lock-request-btn';
  requestBtn.textContent = '🔒 Запросить право редактирования';

  const releaseBtn = document.createElement('button');
  releaseBtn.type = 'button';
  releaseBtn.className = 'edit-lock-release-btn hidden';
  releaseBtn.textContent = '🔓 Освободить';

  function setFormEnabled(enabled) {
    [...formEl.elements].forEach((el) => { el.disabled = !enabled; });
  }

  let held = false;
  setFormEnabled(false); // изначально всегда заблокировано, пока право не получено явно

  async function doRequest() {
    requestBtn.disabled = true;
    statusEl.textContent = 'Запрашиваем…';
    const result = await window.api.locks.request(type, id);
    requestBtn.disabled = false;
    if (result.ok) {
      held = true;
      clientHeldLockKeys.add(`${type}:${id}`);
      applyLayerStates(); // немедленно включает draggable у соответствующего узла на плане, если он там есть
      setFormEnabled(true);
      requestBtn.classList.add('hidden');
      releaseBtn.classList.remove('hidden');
      statusEl.textContent = '✏️ Вы редактируете';
      if (onGranted) onGranted();
    } else {
      const message = result.error || 'Не удалось получить право редактирования';
      statusEl.textContent = message;
      showToast(`⛔ ${message}`, 'error', 7000);
    }
  }

  async function doRelease() {
    if (!held) return;
    await window.api.locks.release(type, id);
    held = false;
    clientHeldLockKeys.delete(`${type}:${id}`);
    applyLayerStates();
    setFormEnabled(false);
    requestBtn.classList.remove('hidden');
    releaseBtn.classList.add('hidden');
    statusEl.textContent = '';
    if (onReleased) onReleased();
  }

  requestBtn.onclick = doRequest;
  releaseBtn.onclick = doRelease;

  wrap.append(requestBtn, releaseBtn, statusEl);
  return { wrap, releaseIfHeld: doRelease };
}

async function renderDeviceExtras(container, deviceId, onChanged = () => renderInspector(planState.selectedNode)) {
  const [history, components, peripherals, software, statusHistory, hostedVMs] = await Promise.all([
    window.api.ownership.history(deviceId),
    window.api.components.list(deviceId),
    window.api.peripherals.list(deviceId),
    window.api.software.list(deviceId),
    window.api.devices.statusHistory(deviceId),
    window.api.devices.listVMsByHost(deviceId)
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

  // Виртуальные машины, у которых этот сервер указан хостом (host_device_id) — раньше
  // эта связь была видна только в обратную сторону, в карточке самой VM; физический
  // сервер никак не показывал, что на нём работает. Список кликабельный — переход к
  // карточке VM, как и везде в приложении.
  container.appendChild(sectionTitle('Виртуальные машины на этом сервере'));
  if (hostedVMs.length === 0) {
    container.appendChild(smallNote('Нет данных'));
  } else {
    const ul = document.createElement('ul');
    ul.className = 'mini-list';
    hostedVMs.forEach((vm) => {
      const li = document.createElement('li');
      li.className = 'mini-list-clickable';
      li.textContent = `🖥 ${vm.hostname || '(без имени)'}${vm.primary_ip ? ' — ' + vm.primary_ip : ''}${vm.owner_name ? ' — ' + vm.owner_name : ''}`;
      li.onclick = () => openDeviceCard(vm.id);
      ul.appendChild(li);
    });
    container.appendChild(ul);
  }

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

let cachedIsPortable = false; // обновляется в refreshDbSettingsInfo — используется в предупреждениях перед перезапуском

/** Текст-приписка к сообщениям о перезапуске — portable-версия Electron на Windows
 *  запускается из временной распакованной папки, и автоматический app.relaunch() там
 *  не всегда срабатывает надёжно (известное ограничение таких сборок, не баг именно
 *  этого приложения) — честно предупреждаем вместо того, чтобы молча понадеяться. */
function portableRelaunchWarning() {
  return cachedIsPortable
    ? '\n\n⚠️ Portable-версия: автоматический перезапуск может не сработать — если окно закроется и не откроется само, запустите приложение вручную ещё раз.'
    : '';
}

async function refreshDbSettingsInfo() {
  const info = await window.api.settings.getDbInfo();
  cachedIsPortable = !!info.isPortable;
  document.getElementById('db-current-path').textContent = info.mode === 'client' ? '(на удалённом хосте)' : (info.path || '—');

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

  const sharedStatusEl = document.getElementById('db-shared-access-status');
  sharedStatusEl.classList.remove('is-host', 'is-client');
  const clientsEl = document.getElementById('db-connected-clients');
  const allowWritesRow = document.getElementById('db-allow-writes-row');
  if (info.mode === 'host') {
    sharedStatusEl.textContent = `🖧 Вы — хост. Порт ${info.hostPort}. Остальные подключаются по вашему IP-адресу и этому порту.`;
    sharedStatusEl.classList.add('is-host');
    await refreshConnectedClients();
    allowWritesRow.classList.remove('hidden');
    document.getElementById('db-allow-writes-checkbox').checked = await window.api.settings.getAllowClientWrites();
  } else if (info.mode === 'client') {
    sharedStatusEl.textContent = `🔌 Вы подключены как клиент к ${info.remoteHost}.`;
    sharedStatusEl.classList.add('is-client');
    clientsEl.classList.add('hidden');
    allowWritesRow.classList.add('hidden');
  } else {
    sharedStatusEl.textContent = 'Обычный режим — БД открыта только этим приложением.';
    clientsEl.classList.add('hidden');
    allowWritesRow.classList.add('hidden');
  }

  return info;
}

/** Живой список подключённых клиентов — раньше хост формально их не видел, только
 *  раздавал данные по запросу. Каждый пинг клиента (см. heartbeat в main/index.js)
 *  обновляет список на стороне хоста; здесь просто читаем текущее состояние. */
async function refreshConnectedClients() {
  const clientsEl = document.getElementById('db-connected-clients');
  const clients = await window.api.settings.getConnectedClients();
  if (clients.length === 0) {
    clientsEl.textContent = '👥 Подключённых клиентов нет.';
  } else {
    clientsEl.innerHTML = `👥 Подключено (${clients.length}):`;
    const ul = document.createElement('ul');
    clients.forEach((c) => {
      const li = document.createElement('li');
      li.textContent = `${c.hostname} — виден ${c.secondsAgo} сек назад `;
      const disconnectBtn = document.createElement('button');
      disconnectBtn.type = 'button';
      disconnectBtn.className = 'client-disconnect-btn';
      disconnectBtn.textContent = '⛔ Отключить';
      disconnectBtn.onclick = async () => {
        if (!(await confirmModal(`Экстренно отключить «${c.hostname}»? Все его резервирования на редактирование будут сняты немедленно.`))) return;
        await window.api.settings.forceDisconnectClient(c.clientId);
        await refreshConnectedClients();
      };
      li.appendChild(disconnectBtn);
      ul.appendChild(li);
    });
    clientsEl.appendChild(ul);
  }
  clientsEl.classList.remove('hidden');
}

function bindDbSettingsModal() {
  const overlay = document.getElementById('db-settings-modal');
  const statusNote = document.getElementById('db-status-note');
  let clientsRefreshTimer = null;

  document.getElementById('db-settings-btn').addEventListener('click', async () => {
    statusNote.textContent = '';
    const info = await refreshDbSettingsInfo();
    overlay.classList.remove('hidden');
    if (info.mode === 'host') {
      clientsRefreshTimer = setInterval(refreshConnectedClients, 5000); // список живой, пока модалка открыта
    }
  });
  document.getElementById('db-settings-close').addEventListener('click', () => {
    overlay.classList.add('hidden');
    if (clientsRefreshTimer) { clearInterval(clientsRefreshTimer); clientsRefreshTimer = null; }
  });

  document.getElementById('db-allow-writes-checkbox').addEventListener('change', async (e) => {
    await window.api.settings.setAllowClientWrites(e.target.checked);
  });

  async function connectAndRelaunch(filePath, confirmText) {
    if (confirmText && !(await confirmModal(confirmText))) return;
    statusNote.textContent = 'Подключение…';
    const result = await window.api.settings.connectDb(filePath);
    // При успехе главный процесс перезапускает приложение сам — сюда управление не вернётся.
    // Если result вообще пришёл — значит подключиться не удалось.
    if (result && result.isHostMarker) {
      // Это не настоящий файл БД, а один или несколько маячков хостов (см. discovery.js —
      // каждый хост пишет свой уникальный файл, поэтому их может найтись сразу несколько,
      // в т.ч. протухшие от давно упавших хостов) — подсказываем адрес вместо невнятной
      // ошибки открытия SQLite. Берём самый свежий: сортировка уже сделана на бэкенде,
      // живые сначала, внутри группы — новые сначала.
      statusNote.innerHTML = '';
      const best = result.markers[0];
      const addressText = best.addresses && best.addresses.length
        ? best.addresses.map((a) => `${a}:${best.port}`).join(', ')
        : `порт ${best.port}`;
      const staleNote = best.stale ? ' (маячок давно не обновлялся — возможно, хост сейчас не работает)' : '';
      const extraCount = result.markers.length - 1;
      const extraNote = extraCount > 0 ? ` (и ещё ${extraCount} в той же папке — возможно, от старых хостов)` : '';
      const msg = document.createElement('span');
      msg.textContent = `Здесь сейчас раздаёт данные хост (${addressText})${staleNote}${extraNote}. `;
      statusNote.appendChild(msg);
      const connectBtn = document.createElement('button');
      connectBtn.type = 'button';
      connectBtn.textContent = 'Подключиться как клиент';
      connectBtn.onclick = async () => {
        const candidates = best.addresses && best.addresses.length ? best.addresses : [];
        if (candidates.length === 0) return;

        // Маячок публикует ВСЕ IPv4-адреса хоста, включая виртуальные адаптеры
        // (Hyper-V/WSL/VPN/Docker) — угадать заранее, какой из них реально доступен
        // с ЭТОГО компьютера, нельзя надёжно (виртуальные диапазоны пересекаются с
        // корпоративными сетями). Вместо гадания — реально проверяем каждый по очереди,
        // тем же пингом, что и обычная проверка связи, и используем первый ответивший.
        connectBtn.disabled = true;
        const originalText = connectBtn.textContent;
        let workingAddress = null;
        for (const addr of candidates) {
          const candidate = `${addr}:${best.port}`;
          connectBtn.textContent = `Проверяем ${candidate}…`;
          // eslint-disable-next-line no-await-in-loop
          const alive = await window.api.settings.pingRemoteHost(candidate);
          if (alive) { workingAddress = candidate; break; }
        }
        connectBtn.disabled = false;
        connectBtn.textContent = originalText;

        // Ни один не ответил (например, все временно недоступны) — берём первый как
        // есть, дальше обычный поток подключения покажет свою собственную, уже понятную
        // ошибку, а не молчаливо подставит непроверенный адрес без всякой обратной связи
        document.getElementById('db-client-host-input').value = workingAddress || `${candidates[0]}:${best.port}`;
        document.getElementById('db-become-client-btn').click(); // переиспользуем уже готовый поток подключения
      };
      statusNote.appendChild(connectBtn);
    } else if (result && result.success === false) {
      statusNote.textContent = `Ошибка: ${result.error}`;
    }
  }

  document.getElementById('db-pick-existing-btn').addEventListener('click', async () => {
    const filePath = await window.api.settings.pickExistingDbFile();
    if (!filePath) return;
    await connectAndRelaunch(filePath, `Подключиться к базе данных по пути:\n${filePath}\n\nПриложение перезапустится.${portableRelaunchWarning()}`);
  });

  document.getElementById('db-pick-folder-btn').addEventListener('click', async () => {
    const folderPath = await window.api.settings.pickDiscoveryFolder();
    if (!folderPath) return;
    // connectDb сам распознаёт, что путь — папка, и сканирует её на маячки хостов
    // (см. discovery.js). Подтверждение не нужно — это просто поиск, ничего не меняет;
    // реальное подключение произойдёт отдельным явным кликом "Подключиться как клиент"
    await connectAndRelaunch(folderPath, null);
  });

  document.getElementById('db-pick-new-btn').addEventListener('click', async () => {
    const filePath = await window.api.settings.pickNewDbLocation();
    if (!filePath) return;
    await connectAndRelaunch(filePath, `Создать новую пустую базу данных здесь и переключиться на неё:\n${filePath}\n\nПриложение перезапустится.${portableRelaunchWarning()}`);
  });

  document.getElementById('db-reset-btn').addEventListener('click', async () => {
    if (!(await confirmModal('Вернуться к локальной базе данных по умолчанию? Приложение перезапустится.' + portableRelaunchWarning()))) return;
    statusNote.textContent = 'Переключение…';
    const result = await window.api.settings.resetDb();
    if (result && result.success === false) {
      statusNote.textContent = `Ошибка: ${result.error}`;
    }
  });

  const sharedStatusNote = document.getElementById('db-shared-status-note');

  document.getElementById('db-become-host-btn').addEventListener('click', async () => {
    const port = Number(document.getElementById('db-host-port-input').value) || 47821;
    const discoveryPath = document.getElementById('db-host-discovery-input').value.trim() || null;

    // Раньше здесь всегда передавался null — из-за этого при переходе в режим хоста
    // путь к БД тихо откатывался на дефолтный (AppData/Roaming/.../data.db), даже если
    // на самом деле был открыт другой файл (например, сетевой путь) — сообщение ниже
    // обещало "текущий файл останется", а на деле не оставалось. У клиентского режима
    // своего открытого файла физически нет (клиент свою БД не открывает вообще) — для
    // него null остаётся правильным значением, создастся/откроется дефолтная БД.
    const currentInfo = await window.api.settings.getDbInfo();
    const currentDbPath = currentInfo.mode === 'client' ? null : currentInfo.path;

    if (!(await confirmModal(
      `Стать хостом на порту ${port}? Текущий файл БД${currentDbPath ? ` (${currentDbPath})` : ' (по умолчанию)'} останется у вас локально, остальные компьютеры ` +
      'смогут подключиться и просматривать данные (без редактирования). Приложение перезапустится.' + portableRelaunchWarning()
    ))) return;
    sharedStatusNote.textContent = 'Переключение…';
    const result = await window.api.settings.setHostMode(currentDbPath, port, discoveryPath);
    if (result && result.success === false) sharedStatusNote.textContent = `Ошибка: ${result.error}`;
  });

  document.getElementById('db-become-client-btn').addEventListener('click', async () => {
    const remoteHost = document.getElementById('db-client-host-input').value.trim();
    if (!remoteHost) { sharedStatusNote.textContent = 'Укажите адрес хоста (ip:порт).'; return; }
    if (!(await confirmModal(
      `Подключиться к хосту ${remoteHost}? Собственная БД перестанет использоваться — все данные будут ` +
      'браться с хоста, редактирование будет недоступно (только просмотр). Приложение перезапустится.' + portableRelaunchWarning()
    ))) return;
    sharedStatusNote.textContent = 'Проверяю подключение…';
    const result = await window.api.settings.setClientMode(remoteHost);
    if (result && result.success === false) sharedStatusNote.textContent = `Ошибка: ${result.error}`;
  });
}


initTabs();
window.api.app.version().then((v) => { document.getElementById('app-version').textContent = `v${v}`; });
bindDbSettingsModal();

/** Показывает короткое всплывающее уведомление снизу справа — авто-исчезает через
 *  durationMs. type: 'error' | 'warning' | 'success' (влияет только на цвет). */
function showToast(message, type = 'error', durationMs = 5000) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast-fading');
    setTimeout(() => toast.remove(), 300);
  }, durationMs);
  return toast;
}

/** Обновляет баннер под актуальный статус связи с хостом И текущее разрешение на
 *  запись — вызывается при старте, при каждой смене статуса связи и при каждом
 *  изменении тумблера хоста (см. onHostConnectivityChanged/onLocksStateChanged ниже).
 *  reachable=null — статус ещё не проверялся повторно (сразу после старта). */
function updateReadOnlyBanner(remoteHost, reachable) {
  const banner = document.getElementById('read-only-banner');
  banner.innerHTML = '';
  banner.classList.remove('hidden', 'banner-danger');

  const msg = document.createElement('span');
  if (reachable === false) {
    banner.classList.add('banner-danger');
    msg.textContent = `⚠️ Связь с хостом ${remoteHost} потеряна — данные могут быть устаревшими. Редактирование недоступно.`;
  } else if (clientAllowWritesFlag) {
    msg.textContent = `🔌 Подключено к хосту ${remoteHost}. Хост разрешил изменения — откройте объект и запросите право редактирования.`;
  } else {
    msg.textContent = `🔌 Только просмотр — подключено к хосту ${remoteHost}. Хост пока не разрешил изменения клиентам.`;
  }
  banner.appendChild(msg);

  const settingsBtn = document.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.textContent = '⚙️ Настройки БД';
  settingsBtn.onclick = () => document.getElementById('db-settings-btn').click();
  banner.appendChild(settingsBtn);
}

// Единая точка перехвата ЛЮБОГО сбоя window.api.* (событие рассылается из preload.js,
// см. функцию invoke там) — не переписываем ~90 мест вызова по отдельности. Троттлим,
// чтобы при обрыве связи не засыпать пользователя десятком одинаковых тостов подряд —
// несколько запросов вполне могут упасть почти одновременно.
let lastApiErrorToastAt = 0;
window.addEventListener('api-error', (e) => {
  const now = Date.now();
  if (now - lastApiErrorToastAt < 4000) return;
  lastApiErrorToastAt = now;
  showToast(`Не удалось выполнить действие: ${e.detail.message}`, 'error', 6000);
});

(async () => {
  const info = await window.api.settings.getDbInfo();
  if (info.warning) {
    const btn = document.getElementById('db-settings-btn');
    btn.classList.add('has-warning');
    btn.title = info.warning;
  }
  if (info.startupNotice) {
    // Раньше это был блокирующий нативный dialog.showErrorBox() ДО появления окна —
    // ненадёжно (в части окружений такой диалог до первого BrowserWindow может вообще
    // не вернуть управление, подвешивая весь процесс). Теперь просто тост уже поверх
    // готового интерфейса.
    showToast(info.startupNotice, 'warning', 9000);
  }

  if (info.mode === 'client') {
    clientModeActive = true;
    // Только просмотр по умолчанию, пока не узнаем реальное состояние тумблера хоста
    // (см. ниже onLocksStateChanged) — безопасный старт. Бэкенд в любом случае
    // отклоняет любые попытки записи независимо от состояния интерфейса (см.
    // main/index.js) — это лишь UX-подсказка поверх уже гарантированной защиты.
    planState.viewMode = true;
    updateReadOnlyBanner(info.remoteHost, info.hostReachable);
    updateClientWritePermissionUI(false); // кнопка режима задизейблена, пока не узнаем реальное состояние

    // Живой статус связи — раньше проверка была только один раз на старте; теперь
    // при КАЖДОЙ смене статуса (хост пропал/вернулся) main-процесс шлёт событие
    // (см. heartbeat в main/index.js), баннер и тост обновляются без перезапуска.
    window.api.events.onHostConnectivityChanged(({ reachable, remoteHost }) => {
      updateReadOnlyBanner(remoteHost, reachable);
      if (reachable) showToast('✅ Связь с хостом восстановлена', 'success', 4000);
      else showToast('⚠️ Связь с хостом потеряна — проверьте сеть', 'warning', 8000);
    });

    // Данные отданы из локального кэша (сети сейчас нет) — троттлим тем же способом,
    // что и api-error, иначе загрузка вкладки при обрыве связи даст сразу десяток
    // одинаковых по смыслу уведомлений (по одному на каждый read-запрос этой вкладки)
    let lastStaleCacheToastAt = 0;
    window.api.events.onUsingStaleCache(() => {
      const now = Date.now();
      if (now - lastStaleCacheToastAt < 4000) return;
      lastStaleCacheToastAt = now;
      showToast('📦 Показаны сохранённые ранее данные — сети нет', 'warning', 6000);
    });
  }

  // Живой снимок "кто что сейчас держит" — приходит на каждое изменение блокировок
  // (heartbeat клиента, явный запрос/освобождение, принудительное отключение), не
  // только клиенту, но и хосту: раньше хост "не видел" резервирования клиентов вообще,
  // узнавая о занятости только по факту отказа при попытке что-то отредактировать.
  window.api.events.onLocksStateChanged(({ allowWrites, allLocks, rejected, forceDisconnected }) => {
    activeLocksSnapshot = allLocks || [];
    applyLayerStates(); // видимость занятости (draggable) — актуальна и хосту, и клиенту

    if (clientModeActive) {
      clientAllowWritesFlag = allowWrites;
      updateClientWritePermissionUI(allowWrites);
      // Событие приходит только когда связь с хостом реально жива (main-процесс
      // проверяет это перед отправкой) — reachable=true здесь безопасно
      updateReadOnlyBanner(info.remoteHost, true);
      if (rejected && rejected.length > 0) {
        // Что-то из ранее полученного вдруг отклонено (хост выключил тумблер, блокировка
        // протухла, или хост принудительно отключил этого клиента) — синхронизируем канву
        let changed = false;
        rejected.forEach((r) => { if (clientHeldLockKeys.delete(`${r.type}:${r.id}`)) changed = true; });
        if (changed) applyLayerStates();
      }
      if (forceDisconnected) {
        showToast('🔌 Хост принудительно отключил вас — права на редактирование сброшены', 'warning', 10000);
      }
    }
  });

  // Кто-то ДРУГОЙ изменил данные — для клиента это хост (или другой клиент через
  // хост), для хоста это подключённый клиент, воспользовавшийся правом на запись
  // (см. writeLocks.js). Переиспользует уже существующий журнал изменений (audit_log)
  // вместо отдельного механизма уведомлений — для клиента событие приходит через
  // heartbeat (см. startClientHeartbeat в main/index.js), для хоста — сразу после
  // успешной записи от клиента (см. notifyHostOfClientWrite). Обновление тихое и без
  // участия пользователя, тост с кратким описанием при этом остаётся.
  window.api.events.onDataChanged(async (changes) => {
    if (!changes || changes.length === 0) return;
    renderUsers();
    renderDevices();
    renderWarehouse();
    renderSoftwareRegistry();
    const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
    if (activeTab === 'network') renderNetworkTab();
    if (activeTab === 'audit') loadAuditLog();
    // План обновляется в фоне ВСЕГДА, не только когда эта вкладка сейчас видна —
    // канва существует независимо от того, какая вкладка активна (просто скрыта CSS),
    // так что к моменту, когда пользователь на неё переключится, она уже будет свежей
    fillDevicePicker(); fillUserDragList(); fillWarehouseDragList();
    await applyPlanChangesQuietly(changes);

    const summaryText = changes.length === 1
      ? changes[0].summary
      : `${changes.length} изменени${changes.length < 5 ? 'я' : 'й'}: ${changes[changes.length - 1].summary}`;
    showToast(`🔄 ${summaryText}`, 'success', 9000);
  });

  renderUsers();
  renderDevices();
  renderWarehouse();
  renderSoftwareRegistry();
  renderNetworkTab();
  loadAuditLog();
  initPlan();
})();
