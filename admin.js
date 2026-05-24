const ADMIN_ROLE_LABELS = {
  super_admin: '超级管理员',
  boss: '老板',
  employee: '员工'
};

const ADMIN_STATE_LABELS = {
  free: '空闲',
  reserved: '已预订',
  dining: '就餐中'
};

const ADMIN_SLOT_LABELS = {
  noon: '中午',
  evening: '晚上'
};

const ADMIN_ACTION_LABELS = {
  reserve: '预订',
  updated: '编辑',
  dining: '改为就餐中',
  cancelled: '取消/设为空闲'
};

const adminAuth = {
  token: localStorage.getItem('admin_token') || '',
  user: JSON.parse(localStorage.getItem('admin_user') || 'null')
};

const adminState = {
  rooms: [],
  socket: null
};

const adminEls = {
  login: document.getElementById('adminLogin'),
  shell: document.getElementById('adminShell'),
  loginForm: document.getElementById('adminLoginForm'),
  username: document.getElementById('adminUsername'),
  password: document.getElementById('adminPassword'),
  error: document.getElementById('adminError'),
  userLine: document.getElementById('adminUserLine'),
  logout: document.getElementById('adminLogout'),
  usersList: document.getElementById('adminUsersList'),
  editUserPanel: document.getElementById('adminEditUserPanel'),
  createUserForm: document.getElementById('adminCreateUserForm'),
  conflictsList: document.getElementById('adminConflictsList'),
  statsForm: document.getElementById('adminStatsForm'),
  statsStart: document.getElementById('adminStatsStart'),
  statsEnd: document.getElementById('adminStatsEnd'),
  statsResult: document.getElementById('adminStatsResult'),
  reservationForm: document.getElementById('adminReservationForm'),
  reservationDate: document.getElementById('adminReservationDate'),
  reservationsList: document.getElementById('adminReservationsList')
};

document.addEventListener('DOMContentLoaded', initAdmin);

async function initAdmin() {
  const today = todayStr();
  adminEls.statsStart.value = `${today.slice(0, 8)}01`;
  adminEls.statsEnd.value = today;
  adminEls.reservationDate.value = today;
  bindAdminEvents();
  if (!adminAuth.token) {
    showAdminLogin();
    return;
  }
  try {
    const result = await adminApi('/api/me');
    setAdminAuth(adminAuth.token, result.user);
    await enterAdmin();
  } catch (_) {
    showAdminLogin('登录已过期，请重新登录');
  }
}

function bindAdminEvents() {
  adminEls.loginForm.addEventListener('submit', handleAdminLogin);
  adminEls.logout.addEventListener('click', adminLogout);
  adminEls.createUserForm.addEventListener('submit', createAdminUser);
  adminEls.statsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    loadAdminStats();
  });
  adminEls.reservationForm.addEventListener('submit', (event) => {
    event.preventDefault();
    loadAdminReservations();
  });
  document.getElementById('refreshUsers').addEventListener('click', loadAdminUsers);
  document.getElementById('refreshConflicts').addEventListener('click', loadAdminConflicts);
  document.querySelectorAll('.admin-tabs button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.admin-tabs button').forEach((item) => item.classList.remove('active'));
      document.querySelectorAll('.admin-panel').forEach((panel) => panel.classList.remove('active'));
      button.classList.add('active');
      document.getElementById(button.dataset.panel).classList.add('active');
    });
  });
}

async function handleAdminLogin(event) {
  event.preventDefault();
  adminEls.error.textContent = '';
  try {
    const result = await adminFetch('/api/auth/login', {
      method: 'POST',
      body: {
        username: adminEls.username.value.trim(),
        password: adminEls.password.value
      }
    });
    if (result.user.role !== 'super_admin') {
      throw new Error('只有超级管理员可以进入 Web 后台');
    }
    setAdminAuth(result.token, result.user);
    adminEls.password.value = '';
    await enterAdmin();
  } catch (err) {
    adminEls.error.textContent = err.message;
  }
}

async function enterAdmin() {
  adminEls.login.hidden = true;
  adminEls.shell.hidden = false;
  adminEls.userLine.textContent = `${adminAuth.user.displayName} · ${ADMIN_ROLE_LABELS[adminAuth.user.role]}`;
  connectAdminSocket();
  await Promise.all([loadAdminUsers(), loadAdminConflicts(), loadAdminStats(), loadAdminReservations()]);
}

function showAdminLogin(message = '') {
  adminEls.shell.hidden = true;
  adminEls.login.hidden = false;
  adminEls.loginForm.hidden = false;
  adminEls.error.textContent = message;
}

function setAdminAuth(token, user) {
  adminAuth.token = token;
  adminAuth.user = user;
  localStorage.setItem('admin_token', token);
  localStorage.setItem('admin_user', JSON.stringify(user));
}

function adminLogout() {
  localStorage.removeItem('admin_token');
  localStorage.removeItem('admin_user');
  if (adminState.socket) adminState.socket.disconnect();
  adminAuth.token = '';
  adminAuth.user = null;
  showAdminLogin();
}

async function loadAdminUsers() {
  const result = await adminApi('/api/users');
  adminEls.usersList.innerHTML = result.users.map((user) => `
    <div class="table-row">
      <div><strong>${escapeHtml(user.displayName)}</strong><span>${escapeHtml(user.username)}</span></div>
      <div>${ADMIN_ROLE_LABELS[user.role]}</div>
      <div>${user.active ? '启用' : '停用'}</div>
      <div>${user.visiblePassword ? escapeHtml(user.visiblePassword) : '未保存'}</div>
      <div class="row-actions">
        <button type="button" data-edit="${user.id}">编辑</button>
        <button type="button" data-reset="${user.id}">重置密码</button>
        <button type="button" data-toggle="${user.id}" data-active="${user.active}">${user.active ? '禁用' : '启用'}</button>
        ${user.role === 'employee' ? `<button type="button" data-delete="${user.id}" data-name="${escapeAttr(user.displayName)}">删除</button>` : ''}
      </div>
    </div>
  `).join('');
  adminEls.usersList.querySelectorAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      const user = result.users.find((item) => item.id === Number(button.dataset.edit));
      if (user) renderAdminEditUser(user);
    });
  });
  adminEls.usersList.querySelectorAll('[data-reset]').forEach((button) => {
    button.addEventListener('click', async () => {
      const result = await adminApi(`/api/users/${button.dataset.reset}/reset-password`, { method: 'POST' });
      alert(`新密码：${result.password}`);
    });
  });
  adminEls.usersList.querySelectorAll('[data-toggle]').forEach((button) => {
    button.addEventListener('click', async () => {
      await adminApi(`/api/users/${button.dataset.toggle}`, {
        method: 'PATCH',
        body: { active: button.dataset.active !== 'true' }
      });
      loadAdminUsers();
    });
  });
  adminEls.usersList.querySelectorAll('[data-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      const name = button.dataset.name || '该员工';
      if (!confirm(`确定删除「${name}」账号吗？此操作不可恢复。`)) return;
      await adminApi(`/api/users/${button.dataset.delete}`, { method: 'DELETE' });
      adminEls.editUserPanel.innerHTML = '';
      loadAdminUsers();
    });
  });
}

function renderAdminEditUser(user) {
  adminEls.editUserPanel.innerHTML = `
    <form id="adminEditUserForm" class="admin-edit-panel">
      <h3>编辑账号</h3>
      <input name="username" placeholder="账号" value="${escapeAttr(user.username)}" required />
      <input name="displayName" placeholder="姓名" value="${escapeAttr(user.displayName)}" required />
      <select name="role">
        <option value="employee" ${user.role === 'employee' ? 'selected' : ''}>员工</option>
        <option value="boss" ${user.role === 'boss' ? 'selected' : ''}>老板</option>
        <option value="super_admin" ${user.role === 'super_admin' ? 'selected' : ''}>超级管理员</option>
      </select>
      <select name="active">
        <option value="true" ${user.active ? 'selected' : ''}>启用</option>
        <option value="false" ${!user.active ? 'selected' : ''}>停用</option>
      </select>
      <input name="password" type="text" placeholder="密码（留空不改）" value="${escapeAttr(user.visiblePassword || '')}" />
      <button type="submit" class="btn primary small">保存修改</button>
      <button type="button" class="btn small" id="cancelEditUser">取消</button>
    </form>
  `;
  document.getElementById('cancelEditUser').addEventListener('click', () => {
    adminEls.editUserPanel.innerHTML = '';
  });
  document.getElementById('adminEditUserForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const password = String(formData.get('password') || '');
    const body = {
      username: String(formData.get('username') || '').trim(),
      displayName: String(formData.get('displayName') || '').trim(),
      role: String(formData.get('role') || 'employee'),
      active: String(formData.get('active')) === 'true'
    };
    if (password) body.password = password;
    await adminApi(`/api/users/${user.id}`, {
      method: 'PATCH',
      body
    });
    alert('账号信息已保存');
    adminEls.editUserPanel.innerHTML = '';
    loadAdminUsers();
  });
}

async function createAdminUser(event) {
  event.preventDefault();
  const formData = new FormData(adminEls.createUserForm);
  try {
    const result = await adminApi('/api/users', {
      method: 'POST',
      body: {
        username: String(formData.get('username') || '').trim(),
        displayName: String(formData.get('displayName') || '').trim(),
        password: String(formData.get('password') || ''),
        role: String(formData.get('role') || 'employee')
      }
    });
    adminEls.createUserForm.reset();
    alert(`账号已创建，密码：${result.password}`);
    loadAdminUsers();
  } catch (err) {
    alert(err.message);
  }
}

async function loadAdminConflicts() {
  const result = await adminApi('/api/conflicts');
  const conflicts = result.conflicts || [];
  adminEls.conflictsList.innerHTML = conflicts.length ? conflicts.map((conflict) => {
    const requested = conflict.requested.patch || {};
    return `
      <div class="table-row">
        <div><strong>${conflict.date} ${ADMIN_SLOT_LABELS[conflict.slot]}</strong><span>${roomName(conflict.roomId)}</span></div>
        <div>${escapeHtml(conflict.displayName || conflict.username)}</div>
        <div>${ADMIN_STATE_LABELS[requested.state] || requested.state}</div>
        <div class="row-actions">
          <button type="button" data-id="${conflict.id}" data-action="keep_server">保留服务器</button>
          <button type="button" data-id="${conflict.id}" data-action="overwrite">覆盖</button>
        </div>
      </div>
    `;
  }).join('') : '<p class="empty">暂无冲突</p>';
  adminEls.conflictsList.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      await adminApi(`/api/conflicts/${button.dataset.id}/resolve`, {
        method: 'POST',
        body: { action: button.dataset.action }
      });
      loadAdminConflicts();
      loadAdminReservations();
    });
  });
}

async function loadAdminStats() {
  const startDate = adminEls.statsStart.value;
  const endDate = adminEls.statsEnd.value;
  const result = await adminApi(`/api/stats/summary?startDate=${startDate}&endDate=${endDate}`);
  const stats = result.stats;
  adminEls.statsResult.innerHTML = `
    <div class="stats-grid desktop">
      <div><strong>${stats.reservedCount}</strong><span>预订</span></div>
      <div><strong>${stats.diningCount}</strong><span>就餐</span></div>
      <div><strong>${stats.cancelCount}</strong><span>取消/空闲</span></div>
    </div>
    <div class="admin-columns">
      <section><h3>热门房间</h3>${stats.popularRooms.map((item) => `<p>${escapeHtml(item.roomName)}：${item.count} 次</p>`).join('') || '<p>暂无</p>'}</section>
      <section><h3>操作明细</h3>${stats.operations.map(renderAdminOperationLine).join('') || '<p>暂无</p>'}</section>
    </div>
  `;
}

function renderAdminOperationLine(item) {
  const actor = `${item.displayName || '未知姓名'}（${item.username || '未知账号'}）`;
  const guest = item.guestName ? ` · ${item.guestName}` : '';
  const party = item.partySize ? ` · ${item.partySize}人` : '';
  const deposit = item.hasDeposit ? ` · 订金${Number(item.depositAmount || 0)}元` : '';
  return `<p>${formatAdminDateTime(item.createdAt)} · ${ADMIN_SLOT_LABELS[item.slot] || item.slot} · ${escapeHtml(actor)} · ${escapeHtml(ADMIN_ACTION_LABELS[item.action] || item.action)} · ${escapeHtml(item.roomName)}${escapeHtml(guest + party + deposit)}</p>`;
}

async function loadAdminReservations() {
  const date = adminEls.reservationDate.value;
  const result = await adminApi(`/api/reservations?startDate=${date}&endDate=${date}`);
  adminState.rooms = result.rooms || adminState.rooms;
  adminEls.reservationsList.innerHTML = (result.reservations || []).map((reservation) => `
    <div class="table-row">
      <div><strong>${roomName(reservation.roomId)}</strong><span>${ADMIN_SLOT_LABELS[reservation.slot]}</span></div>
      <div>${ADMIN_STATE_LABELS[reservation.state]}</div>
      <div>${escapeHtml(reservation.guestName || '-')} ${reservation.partySize ? `· ${reservation.partySize}人` : ''}</div>
      <div>${reservation.hasDeposit ? `订金 ${reservation.depositAmount}` : '无订金'}</div>
    </div>
  `).join('') || '<p class="empty">当天暂无订桌记录</p>';
}

function connectAdminSocket() {
  if (adminState.socket) adminState.socket.disconnect();
  adminState.socket = io({
    auth: { token: adminAuth.token },
    transports: ['websocket', 'polling']
  });
  adminState.socket.on('reservation.changed', () => loadAdminReservations());
  adminState.socket.on('reservation.conflict', () => loadAdminConflicts());
  adminState.socket.on('user.updated', () => loadAdminUsers());
}

async function adminApi(url, options = {}) {
  return adminFetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${adminAuth.token}`
    }
  });
}

async function adminFetch(url, options = {}) {
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

function roomName(roomId) {
  const room = adminState.rooms.find((item) => item.id === Number(roomId));
  return room ? room.name : String(roomId);
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value == null ? '' : value);
  return div.innerHTML;
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('"', '&quot;');
}

function formatAdminDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).replace('T', ' ').slice(0, 19);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
