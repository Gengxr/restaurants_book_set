const STATES = {
  FREE: 'free',
  RESERVED: 'reserved',
  DINING: 'dining'
};

const STATE_LABELS = {
  free: '空闲',
  reserved: '已预订',
  dining: '就餐中'
};

const SLOT_LABELS = {
  noon: '中午',
  evening: '晚上'
};

const ROLE_LABELS = {
  employee: '员工',
  boss: '老板',
  super_admin: '超级管理员'
};

const ACTION_LABELS = {
  reserve: '预订',
  updated: '编辑',
  dining: '改为就餐中',
  cancelled: '取消/设为空闲'
};

const auth = {
  token: localStorage.getItem('booking_token') || '',
  user: JSON.parse(localStorage.getItem('booking_user') || 'null')
};

const state = {
  rooms: [],
  reservations: new Map(),
  selectedDate: todayStr(),
  selectedSlot: 'noon',
  socket: null,
  online: navigator.onLine,
  pendingCount: 0
};

const els = {
  loginView: document.getElementById('loginView'),
  appView: document.getElementById('appView'),
  loginForm: document.getElementById('loginForm'),
  loginUsername: document.getElementById('loginUsername'),
  loginPassword: document.getElementById('loginPassword'),
  loginError: document.getElementById('loginError'),
  userLine: document.getElementById('userLine'),
  logoutBtn: document.getElementById('logoutBtn'),
  syncStrip: document.getElementById('syncStrip'),
  dateInput: document.getElementById('dateInput'),
  roomsGrid: document.getElementById('roomsGrid'),
  managerBar: document.getElementById('managerBar'),
  usersBtn: document.getElementById('usersBtn'),
  conflictsBtn: document.getElementById('conflictsBtn'),
  statsBtn: document.getElementById('statsBtn'),
  modalOverlay: document.getElementById('modalOverlay'),
  modalTitle: document.getElementById('modalTitle'),
  modalBody: document.getElementById('modalBody'),
  modalClose: document.getElementById('modalClose')
};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  els.dateInput.value = state.selectedDate;
  bindEvents();
  await window.bookingDb.openBookingCache();
  await refreshPendingCount();
  if (!auth.token) {
    showLogin();
    return;
  }
  try {
    const result = await api('/api/me');
    setAuth(auth.token, result.user);
    await enterApp();
  } catch (_) {
    showLogin('登录已过期，请重新登录');
  }
}

function bindEvents() {
  els.loginForm.addEventListener('submit', handleLogin);
  els.logoutBtn.addEventListener('click', logout);
  els.dateInput.addEventListener('change', () => {
    state.selectedDate = els.dateInput.value;
    loadReservations();
  });
  document.querySelectorAll('.segment').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedSlot = button.dataset.slot;
      document.querySelectorAll('.segment').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      renderRooms();
    });
  });
  els.modalClose.addEventListener('click', closeModal);
  els.modalOverlay.addEventListener('click', (event) => {
    if (event.target === els.modalOverlay) closeModal();
  });
  els.usersBtn.addEventListener('click', openUsersModal);
  els.conflictsBtn.addEventListener('click', openConflictsModal);
  els.statsBtn.addEventListener('click', openStatsModal);
  window.addEventListener('online', () => {
    state.online = true;
    updateSyncStrip();
    syncPendingOperations(true);
  });
  window.addEventListener('offline', () => {
    state.online = false;
    updateSyncStrip();
  });
}

async function handleLogin(event) {
  event.preventDefault();
  els.loginError.textContent = '';
  try {
    const result = await fetchJson('/api/auth/login', {
      method: 'POST',
      body: {
        username: els.loginUsername.value.trim(),
        password: els.loginPassword.value
      }
    });
    setAuth(result.token, result.user);
    els.loginPassword.value = '';
    await enterApp();
  } catch (err) {
    els.loginError.textContent = err.message;
  }
}

function setAuth(token, user) {
  auth.token = token;
  auth.user = user;
  localStorage.setItem('booking_token', token);
  localStorage.setItem('booking_user', JSON.stringify(user));
}

function showLogin(message = '') {
  els.appView.hidden = true;
  els.loginView.hidden = false;
  els.loginForm.hidden = false;
  els.loginError.textContent = message;
}

async function enterApp() {
  els.loginView.hidden = true;
  els.appView.hidden = false;
  els.managerBar.hidden = !canManage();
  els.userLine.textContent = `${auth.user.displayName} · ${ROLE_LABELS[auth.user.role] || auth.user.role}`;
  connectSocket();
  updateSyncStrip();
  await loadReservations();
  await syncPendingOperations();
}

function logout() {
  localStorage.removeItem('booking_token');
  localStorage.removeItem('booking_user');
  auth.token = '';
  auth.user = null;
  if (state.socket) state.socket.disconnect();
  showLogin();
}

async function loadReservations() {
  updateSyncStrip('正在读取订桌数据...');
  try {
    const result = await api(`/api/reservations?startDate=${state.selectedDate}&endDate=${state.selectedDate}`);
    state.rooms = result.rooms || state.rooms;
    setReservations(result.reservations || []);
    await window.bookingDb.cacheReservations(result.reservations || []);
    await mergeCachedPending();
  } catch (_) {
    const cached = await window.bookingDb.getCachedReservationsByDate(state.selectedDate);
    setReservations(cached);
    await mergeCachedPending();
    updateSyncStrip('离线模式：正在显示本机缓存');
  }
  renderRooms();
  updateSyncStrip();
}

function setReservations(rows) {
  rows.forEach((row) => {
    state.reservations.set(roomKey(row.date, row.slot, row.roomId), row);
  });
}

async function mergeCachedPending() {
  const pending = await window.bookingDb.getPendingOperations();
  state.pendingCount = pending.length;
  for (const operation of pending) {
    if (operation.date === state.selectedDate) {
      const current = getRoomData(operation.date, operation.slot, operation.roomId);
      state.reservations.set(roomKey(operation.date, operation.slot, operation.roomId), {
        ...current,
        ...operation.patch,
        date: operation.date,
        slot: operation.slot,
        roomId: operation.roomId,
        version: operation.baseVersion,
        pending: true
      });
    }
  }
}

function renderRooms() {
  els.roomsGrid.innerHTML = '';
  if (state.rooms.length === 0) {
    els.roomsGrid.innerHTML = '<p class="empty">暂无房间数据</p>';
    return;
  }
  state.rooms.forEach((room) => {
    const data = getRoomData(state.selectedDate, state.selectedSlot, room.id);
    const card = document.createElement('article');
    card.className = `room-card state-${data.state}${data.pending ? ' pending' : ''}`;
    card.innerHTML = `
      <div class="room-title">
        <strong>${escapeHtml(room.name)}</strong>
        <span>${STATE_LABELS[data.state]}</span>
      </div>
      <div class="room-meta">推荐 ${room.recommended} 人${data.partySize ? ` · 到店 ${data.partySize} 人` : ''}</div>
      ${data.guestName || data.guestPhone ? `<div class="guest">${escapeHtml(data.guestName || '-')} · ${escapeHtml(data.guestPhone || '-')}</div>` : ''}
      ${data.hasDeposit ? `<div class="deposit">订金：${money(data.depositAmount)} 元</div>` : ''}
      ${data.remark ? `<div class="remark">${escapeHtml(data.remark)}</div>` : ''}
      ${data.pending ? '<div class="pending-tag">待同步</div>' : ''}
      ${renderActions(data)}
    `;
    card.addEventListener('click', (event) => handleRoomTap(event, room, data));
    els.roomsGrid.appendChild(card);
  });
}

function renderActions(data) {
  if (data.state === STATES.FREE) return '';
  return `
    <div class="card-actions">
      ${data.state === STATES.RESERVED ? '<button type="button" data-action="dining">就餐</button>' : ''}
      <button type="button" data-action="edit">编辑</button>
      <button type="button" data-action="free">空闲</button>
    </div>
  `;
}

function handleRoomTap(event, room, data) {
  const actionButton = event.target.closest('button[data-action]');
  if (actionButton) {
    event.stopPropagation();
    const action = actionButton.dataset.action;
    if (action === 'dining') {
      enqueueReservation(room.id, { ...data, state: STATES.DINING });
      return;
    }
    if (action === 'free') {
      if (confirm(`确定将「${room.name}」设为空闲吗？`)) {
        enqueueReservation(room.id, { state: STATES.FREE });
      }
      return;
    }
    if (action === 'edit') {
      openReservationModal(room, data);
      return;
    }
  }
  if (data.state === STATES.FREE) {
    openReservationModal(room, data);
  }
}

function openReservationModal(room, data) {
  const isEdit = data.state !== STATES.FREE;
  openModal(isEdit ? '编辑订桌' : '新增订桌', `
    <form id="reservationForm" class="form-stack">
      <p class="modal-note">${escapeHtml(room.name)} · ${state.selectedDate} ${SLOT_LABELS[state.selectedSlot]}</p>
      <label>预订人姓名<input name="guestName" value="${escapeAttr(data.guestName || '')}" required /></label>
      <label>手机号<input name="guestPhone" type="tel" value="${escapeAttr(data.guestPhone || '')}" required /></label>
      <label>到店人数<input name="partySize" type="number" min="1" max="99" value="${data.partySize || ''}" required /></label>
      <label class="check-row"><input name="hasDeposit" type="checkbox" ${data.hasDeposit ? 'checked' : ''} /> 有订金</label>
      <label>订金金额<input name="depositAmount" type="number" min="0" step="0.01" value="${data.depositAmount || ''}" /></label>
      <label>备注<textarea name="remark" rows="3">${escapeHtml(data.remark || '')}</textarea></label>
      <button type="submit" class="btn primary">保存</button>
    </form>
  `);
  const form = document.getElementById('reservationForm');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const hasDeposit = formData.get('hasDeposit') === 'on';
    enqueueReservation(room.id, {
      state: STATES.RESERVED,
      guestName: String(formData.get('guestName') || '').trim(),
      guestPhone: String(formData.get('guestPhone') || '').trim(),
      partySize: Number(formData.get('partySize')),
      hasDeposit,
      depositAmount: hasDeposit ? Number(formData.get('depositAmount') || 0) : 0,
      remark: String(formData.get('remark') || '').trim()
    });
    closeModal();
  });
}

async function enqueueReservation(roomId, patch) {
  const current = getRoomData(state.selectedDate, state.selectedSlot, roomId);
  const cleanPatch = normalizePatch(patch);
  const operation = {
    clientOperationId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    date: state.selectedDate,
    slot: state.selectedSlot,
    roomId: Number(roomId),
    baseVersion: current.version || 0,
    patch: cleanPatch,
    createdAt: new Date().toISOString()
  };
  const localReservation = {
    ...current,
    ...cleanPatch,
    date: operation.date,
    slot: operation.slot,
    roomId: operation.roomId,
    version: operation.baseVersion,
    pending: true
  };
  await window.bookingDb.removePendingForRoom(operation.date, operation.slot, operation.roomId);
  await window.bookingDb.addPendingOperation(operation);
  await window.bookingDb.putCachedReservation(localReservation);
  state.reservations.set(roomKey(operation.date, operation.slot, operation.roomId), localReservation);
  await refreshPendingCount();
  renderRooms();
  updateSyncStrip();
  syncPendingOperations();
}

function normalizePatch(patch) {
  if (patch.state === STATES.FREE) {
    return {
      state: STATES.FREE,
      guestName: '',
      guestPhone: '',
      partySize: null,
      hasDeposit: false,
      depositAmount: 0,
      remark: ''
    };
  }
  return {
    state: patch.state || STATES.RESERVED,
    guestName: patch.guestName || '',
    guestPhone: patch.guestPhone || '',
    partySize: patch.partySize || null,
    hasDeposit: Boolean(patch.hasDeposit),
    depositAmount: patch.hasDeposit ? Number(patch.depositAmount || 0) : 0,
    remark: patch.remark || ''
  };
}

async function syncPendingOperations(showNotice = false) {
  if (!auth.token || !navigator.onLine) {
    updateSyncStrip();
    return;
  }
  const operations = await window.bookingDb.getPendingOperations();
  state.pendingCount = operations.length;
  if (operations.length === 0) {
    updateSyncStrip();
    return;
  }
  updateSyncStrip(`正在同步 ${operations.length} 条离线操作...`);
  try {
    const result = await api('/api/sync/operations', {
      method: 'POST',
      body: { operations }
    });
    const appliedIds = new Set(result.applied.map((reservation) => {
      const op = operations.find((item) =>
        item.date === reservation.date &&
        item.slot === reservation.slot &&
        item.roomId === reservation.roomId
      );
      return op && op.clientOperationId;
    }).filter(Boolean));
    const conflictIds = new Set((result.conflicts || []).map((conflict) => conflict.clientOperationId));
    await window.bookingDb.removePendingOperations([...appliedIds, ...conflictIds]);
    await window.bookingDb.cacheReservations(result.applied || []);
    setReservations(result.applied || []);
    await refreshPendingCount();
    renderRooms();
    updateSyncStrip();
    if (result.conflicts && result.conflicts.length > 0) {
      alert(`有 ${result.conflicts.length} 条操作发生冲突，已交给老板/管理员处理。`);
    } else if (showNotice) {
      updateSyncStrip('同步完成');
    }
  } catch (_) {
    updateSyncStrip('同步失败：稍后会自动重试');
  }
}

async function refreshPendingCount() {
  const operations = await window.bookingDb.getPendingOperations();
  state.pendingCount = operations.length;
}

function connectSocket() {
  if (state.socket) state.socket.disconnect();
  state.socket = io({
    auth: { token: auth.token },
    transports: ['websocket', 'polling']
  });
  state.socket.on('connect', () => updateSyncStrip());
  state.socket.on('disconnect', () => updateSyncStrip());
  state.socket.on('reservation.changed', async ({ reservation }) => {
    const pending = await window.bookingDb.getPendingOperations();
    const hasLocalPending = pending.some((operation) =>
      operation.date === reservation.date &&
      operation.slot === reservation.slot &&
      operation.roomId === reservation.roomId
    );
    if (hasLocalPending) return;
    await window.bookingDb.putCachedReservation(reservation);
    state.reservations.set(roomKey(reservation.date, reservation.slot, reservation.roomId), reservation);
    if (reservation.date === state.selectedDate) renderRooms();
  });
  state.socket.on('reservation.conflict', () => {
    if (canManage()) updateSyncStrip('有新的同步冲突待处理');
  });
}

async function openUsersModal() {
  openModal('员工管理', '<p class="empty">正在加载...</p>');
  try {
    const result = await api('/api/users');
    renderUsersModal(result.users || []);
  } catch (err) {
    els.modalBody.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

function renderUsersModal(users) {
  els.modalBody.innerHTML = `
    <form id="createUserForm" class="inline-form">
      <input name="username" placeholder="账号" required />
      <input name="displayName" placeholder="姓名" required />
      <input name="password" type="text" placeholder="密码" minlength="6" required />
      ${auth.user.role === 'super_admin' ? '<select name="role"><option value="employee">员工</option><option value="boss">老板</option></select>' : ''}
      <button type="submit" class="btn primary small">创建</button>
    </form>
    <div class="list">${users.map(renderUserItem).join('') || '<p class="empty">暂无员工</p>'}</div>
  `;
  document.getElementById('createUserForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    try {
      const result = await api('/api/users', {
        method: 'POST',
        body: {
          username: String(formData.get('username') || '').trim(),
          displayName: String(formData.get('displayName') || '').trim(),
          password: String(formData.get('password') || ''),
          role: String(formData.get('role') || 'employee')
        }
      });
      alert(`账号已创建，密码：${result.password}`);
      openUsersModal();
    } catch (err) {
      alert(err.message);
    }
  });
  els.modalBody.querySelectorAll('[data-reset]').forEach((button) => {
    button.addEventListener('click', async () => {
      const result = await api(`/api/users/${button.dataset.reset}/reset-password`, { method: 'POST' });
      alert(`新密码：${result.password}`);
    });
  });
  els.modalBody.querySelectorAll('[data-toggle]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api(`/api/users/${button.dataset.toggle}`, {
        method: 'PATCH',
        body: { active: button.dataset.active !== 'true' }
      });
      openUsersModal();
    });
  });
  els.modalBody.querySelectorAll('[data-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      const name = button.dataset.name || '该员工';
      if (!confirm(`确定删除「${name}」账号吗？此操作不可恢复。`)) return;
      await api(`/api/users/${button.dataset.delete}`, { method: 'DELETE' });
      openUsersModal();
    });
  });
}

function renderUserItem(user) {
  return `
    <div class="list-item">
      <div>
        <strong>${escapeHtml(user.displayName)}</strong>
        <span>${escapeHtml(user.username)} · ${ROLE_LABELS[user.role] || user.role} · ${user.active ? '启用' : '停用'}</span>
      </div>
      <div class="row-actions">
        <button type="button" data-reset="${user.id}">重置</button>
        <button type="button" data-toggle="${user.id}" data-active="${user.active}">${user.active ? '禁用' : '启用'}</button>
        ${user.role === 'employee' ? `<button type="button" data-delete="${user.id}" data-name="${escapeAttr(user.displayName)}">删除</button>` : ''}
      </div>
    </div>
  `;
}

async function openConflictsModal() {
  openModal('同步冲突', '<p class="empty">正在加载...</p>');
  try {
    const result = await api('/api/conflicts');
    const conflicts = result.conflicts || [];
    els.modalBody.innerHTML = conflicts.length
      ? `<div class="list">${conflicts.map(renderConflictItem).join('')}</div>`
      : '<p class="empty">暂无冲突</p>';
    els.modalBody.querySelectorAll('[data-conflict-action]').forEach((button) => {
      button.addEventListener('click', async () => {
        await api(`/api/conflicts/${button.dataset.id}/resolve`, {
          method: 'POST',
          body: { action: button.dataset.conflictAction }
        });
        openConflictsModal();
        loadReservations();
      });
    });
  } catch (err) {
    els.modalBody.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

function renderConflictItem(conflict) {
  const requested = conflict.requested.patch || {};
  return `
    <div class="list-item conflict-item">
      <div>
        <strong>${conflict.date} ${SLOT_LABELS[conflict.slot]} · ${roomName(conflict.roomId)}</strong>
        <span>${escapeHtml(conflict.displayName || conflict.username)} 的离线操作与服务器数据冲突</span>
        <small>想改为：${STATE_LABELS[requested.state] || requested.state} ${requested.guestName || ''} ${requested.partySize ? `· ${requested.partySize}人` : ''}</small>
      </div>
      <div class="row-actions">
        <button type="button" data-id="${conflict.id}" data-conflict-action="keep_server">保留服务器</button>
        <button type="button" data-id="${conflict.id}" data-conflict-action="overwrite">覆盖</button>
      </div>
    </div>
  `;
}

async function openStatsModal() {
  const start = `${state.selectedDate.slice(0, 8)}01`;
  openModal('简单统计', `
    <form id="statsForm" class="inline-form">
      <input type="date" name="startDate" value="${start}" />
      <input type="date" name="endDate" value="${state.selectedDate}" />
      <button type="submit" class="btn primary small">查询</button>
    </form>
    <div id="statsResult"><p class="empty">正在加载...</p></div>
  `);
  const form = document.getElementById('statsForm');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    loadStats(new FormData(form));
  });
  await loadStats(new FormData(form));
}

async function loadStats(formData) {
  const target = document.getElementById('statsResult');
  const startDate = formData.get('startDate');
  const endDate = formData.get('endDate');
  try {
    const result = await api(`/api/stats/summary?startDate=${startDate}&endDate=${endDate}`);
    const stats = result.stats;
    target.innerHTML = `
      <div class="stats-grid">
        <div><strong>${stats.reservedCount}</strong><span>预订</span></div>
        <div><strong>${stats.diningCount}</strong><span>就餐</span></div>
        <div><strong>${stats.cancelCount}</strong><span>取消/空闲</span></div>
      </div>
      <h3>热门房间</h3>
      <div class="mini-list">${stats.popularRooms.map((item) => `<p>${escapeHtml(item.roomName)}：${item.count} 次</p>`).join('') || '<p>暂无</p>'}</div>
      <h3>操作明细</h3>
      <div class="mini-list">${stats.operations.map(renderOperationLine).join('') || '<p>暂无</p>'}</div>
    `;
  } catch (err) {
    target.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

function renderOperationLine(item) {
  const actor = `${item.displayName || '未知姓名'}（${item.username || '未知账号'}）`;
  const guest = item.guestName ? ` · ${item.guestName}` : '';
  const party = item.partySize ? ` · ${item.partySize}人` : '';
  const deposit = item.hasDeposit ? ` · 订金${money(item.depositAmount)}元` : '';
  return `<p>${formatDateTime(item.createdAt)} · ${SLOT_LABELS[item.slot] || item.slot} · ${escapeHtml(actor)} · ${escapeHtml(ACTION_LABELS[item.action] || item.action)} · ${escapeHtml(item.roomName)}${escapeHtml(guest + party + deposit)}</p>`;
}

function getRoomData(date, slot, roomId) {
  return state.reservations.get(roomKey(date, slot, roomId)) || {
    date,
    slot,
    roomId: Number(roomId),
    state: STATES.FREE,
    guestName: '',
    guestPhone: '',
    partySize: null,
    hasDeposit: false,
    depositAmount: 0,
    remark: '',
    version: 0
  };
}

function roomKey(date, slot, roomId) {
  return `${date}|${slot}|${roomId}`;
}

function roomName(roomId) {
  const room = state.rooms.find((item) => item.id === Number(roomId));
  return room ? room.name : String(roomId);
}

async function api(url, options = {}) {
  return fetchJson(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${auth.token}`
    }
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

function canManage() {
  return auth.user && ['boss', 'super_admin'].includes(auth.user.role);
}

function updateSyncStrip(message) {
  if (message) {
    els.syncStrip.textContent = message;
    return;
  }
  const socketOnline = state.socket && state.socket.connected;
  if (!navigator.onLine) {
    els.syncStrip.textContent = `离线：${state.pendingCount} 条待同步`;
  } else if (state.pendingCount > 0) {
    els.syncStrip.textContent = `在线：${state.pendingCount} 条待同步`;
  } else {
    els.syncStrip.textContent = socketOnline ? '在线：实时同步中' : '在线：正在连接实时同步';
  }
}

function openModal(title, html) {
  els.modalTitle.textContent = title;
  els.modalBody.innerHTML = html;
  els.modalOverlay.classList.add('open');
  els.modalOverlay.setAttribute('aria-hidden', 'false');
}

function closeModal() {
  els.modalOverlay.classList.remove('open');
  els.modalOverlay.setAttribute('aria-hidden', 'true');
  els.modalBody.innerHTML = '';
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function money(value) {
  return Number(value || 0).toFixed(2).replace(/\.00$/, '');
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).replace('T', ' ').slice(0, 19);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value == null ? '' : value);
  return div.innerHTML;
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('"', '&quot;');
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
