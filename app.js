// 房间状态
const STATES = {
  FREE: 'free',
  RESERVED: 'reserved',
  DINING: 'dining'
};

const STATE_LABELS = {
  [STATES.FREE]: '空闲',
  [STATES.RESERVED]: '已预订',
  [STATES.DINING]: '就餐中'
};

// 就餐时段
const SLOTS = { NOON: 'noon', EVENING: 'evening' };
const SLOT_LABELS = { [SLOTS.NOON]: '中午', [SLOTS.EVENING]: '晚上' };

// 16 个房间
const ROOM_CONFIG = [
  { id: 1, name: '步步高升', recommended: 8 },
  { id: 2, name: '丰衣足食', recommended: 8 },
  { id: 3, name: '金玉满堂', recommended: 12 },
  { id: 4, name: '春种秋收', recommended: 8 },
  { id: 5, name: '五福临门', recommended: 10 },
  { id: 6, name: '年年有鱼', recommended: 10 },
  { id: 7, name: '大吉大利', recommended: 4 },
  { id: 8, name: '田园风光', recommended: 10 },
  { id: 9, name: '风调雨顺', recommended: 10 },
  { id: 10, name: '五谷丰登', recommended: 8 },
  { id: 11, name: '乡里乡亲', recommended: 6 },
  { id: 12, name: '左邻右舍', recommended: 6 },
  { id: 13, name: '走亲访友', recommended: 6 },
  { id: 14, name: '长桌1', recommended: 4 },
  { id: 15, name: '长桌2', recommended: 4 },
  { id: 16, name: '长桌3', recommended: 4 },
  { id: 17, name: '地桌5', recommended: 10 },
  { id: 18, name: '地桌6', recommended: 10 },
];

// 预定数据（内存缓存）：reservations[date][slot][roomId] = { state, guestName?, guestPhone? }
// 持久化在 IndexedDB，见 db.js
let reservations = {};

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function getRoomData(date, slot, roomId) {
  const day = reservations[date];
  if (!day) return { state: STATES.FREE };
  const slotData = day[slot];
  if (!slotData) return { state: STATES.FREE };
  const room = slotData[String(roomId)];
  if (!room) return { state: STATES.FREE };
  return { state: room.state || STATES.FREE, guestName: room.guestName, guestPhone: room.guestPhone, remark: room.remark || '' };
}

function setRoomData(date, slot, roomId, data) {
  if (!reservations[date]) reservations[date] = {};
  if (!reservations[date][slot]) reservations[date][slot] = {};
  if (data.state === STATES.FREE && !data.guestName && !data.guestPhone) {
    delete reservations[date][slot][String(roomId)];
    if (Object.keys(reservations[date][slot]).length === 0) delete reservations[date][slot];
    if (Object.keys(reservations[date]).length === 0) delete reservations[date];
  } else {
    reservations[date][slot][String(roomId)] = data;
  }
  // 写入数据库
  saveReservation({
    date,
    slot,
    roomId,
    state: data.state,
    guestName: data.guestName,
    guestPhone: data.guestPhone,
    remark: data.remark || ''
  }).catch((err) => console.error('保存预定失败', err));
}

// UI 状态
let selectedDate = todayStr();
let selectedSlot = SLOTS.NOON;
let pendingReserveRoomId = null;

const dateInput = document.getElementById('dateInput');
const modalOverlay = document.getElementById('modalOverlay');
const modalRoomName = document.getElementById('modalRoomName');
const reserveForm = document.getElementById('reserveForm');
const guestNameInput = document.getElementById('guestName');
const guestPhoneInput = document.getElementById('guestPhone');
const modalCancel = document.getElementById('modalCancel');

function initControls() {
  dateInput.value = selectedDate;
  dateInput.addEventListener('change', () => {
    selectedDate = dateInput.value;
    render();
  });

  document.querySelectorAll('.slot-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      selectedSlot = tab.dataset.slot;
      document.querySelectorAll('.slot-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      render();
    });
  });
}

function openReserveModal(room) {
  pendingReserveRoomId = room.id;
  modalRoomName.textContent = `预定「${room.name}」· ${selectedDate} ${SLOT_LABELS[selectedSlot]}`;
  guestNameInput.value = '';
  guestPhoneInput.value = '';
  modalOverlay.setAttribute('aria-hidden', 'false');
  modalOverlay.classList.add('open');
  guestNameInput.focus();
}

function closeModal() {
  pendingReserveRoomId = null;
  modalOverlay.setAttribute('aria-hidden', 'true');
  modalOverlay.classList.remove('open');
}

reserveForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = guestNameInput.value.trim();
  const phone = guestPhoneInput.value.trim();
  if (!name || !phone) return;
  if (pendingReserveRoomId == null) return;
  const room = ROOM_CONFIG.find(r => r.id === pendingReserveRoomId);
  setRoomData(selectedDate, selectedSlot, pendingReserveRoomId, {
    state: STATES.RESERVED,
    guestName: name,
    guestPhone: phone
  });
  // 预定时写入历史表（只增不删），就餐完变空闲后仍可查到哪天谁预定了哪间
  addReservationHistory({
    date: selectedDate,
    slot: selectedSlot,
    roomId: pendingReserveRoomId,
    roomName: room ? room.name : '',
    guestName: name,
    guestPhone: phone,
    remark: ''
  }).catch((err) => console.error('写入预定历史失败', err));
  closeModal();
  render();
});

modalCancel.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

// ---------- 备注弹窗 ----------
const remarkOverlay = document.getElementById('remarkOverlay');
const remarkRoomName = document.getElementById('remarkRoomName');
const remarkInput = document.getElementById('remarkInput');
const remarkForm = document.getElementById('remarkForm');
const remarkCancel = document.getElementById('remarkCancel');
let pendingRemarkRoomId = null;

function openRemarkModal(room) {
  const data = getRoomData(selectedDate, selectedSlot, room.id);
  pendingRemarkRoomId = room.id;
  remarkRoomName.textContent = `${room.name} · ${selectedDate} ${SLOT_LABELS[selectedSlot]}`;
  remarkInput.value = data.remark || '';
  remarkOverlay.setAttribute('aria-hidden', 'false');
  remarkOverlay.classList.add('open');
  remarkInput.focus();
}

function closeRemarkModal() {
  pendingRemarkRoomId = null;
  remarkOverlay.setAttribute('aria-hidden', 'true');
  remarkOverlay.classList.remove('open');
}

remarkForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const roomId = pendingRemarkRoomId;
  if (roomId == null) return;
  const room = ROOM_CONFIG.find(r => r.id === roomId);
  const data = getRoomData(selectedDate, selectedSlot, roomId);
  const text = remarkInput.value.trim();
  setRoomData(selectedDate, selectedSlot, roomId, {
    state: data.state,
    guestName: data.guestName,
    guestPhone: data.guestPhone,
    remark: text
  });
  updateHistoryRemark(selectedDate, selectedSlot, roomId, text).catch(() => {});
  closeRemarkModal();
  render();
});

remarkCancel.addEventListener('click', closeRemarkModal);
remarkOverlay.addEventListener('click', (e) => {
  if (e.target === remarkOverlay) closeRemarkModal();
});

// ---------- 编辑预定人弹窗 ----------
const editGuestOverlay = document.getElementById('editGuestOverlay');
const editGuestRoomName = document.getElementById('editGuestRoomName');
const editGuestNameInput = document.getElementById('editGuestName');
const editGuestPhoneInput = document.getElementById('editGuestPhone');
const editGuestForm = document.getElementById('editGuestForm');
const editGuestCancel = document.getElementById('editGuestCancel');
let pendingEditRoomId = null;

function openEditGuestModal(room) {
  const data = getRoomData(selectedDate, selectedSlot, room.id);
  pendingEditRoomId = room.id;
  editGuestRoomName.textContent = `${room.name} · ${selectedDate} ${SLOT_LABELS[selectedSlot]}`;
  editGuestNameInput.value = data.guestName || '';
  editGuestPhoneInput.value = data.guestPhone || '';
  editGuestOverlay.setAttribute('aria-hidden', 'false');
  editGuestOverlay.classList.add('open');
  editGuestNameInput.focus();
}

function closeEditGuestModal() {
  pendingEditRoomId = null;
  editGuestOverlay.setAttribute('aria-hidden', 'true');
  editGuestOverlay.classList.remove('open');
}

editGuestForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const roomId = pendingEditRoomId;
  if (roomId == null) return;
  const data = getRoomData(selectedDate, selectedSlot, roomId);
  const name = editGuestNameInput.value.trim();
  const phone = editGuestPhoneInput.value.trim();
  if (!name || !phone) return;
  setRoomData(selectedDate, selectedSlot, roomId, {
    state: data.state,
    guestName: name,
    guestPhone: phone,
    remark: data.remark
  });
  closeEditGuestModal();
  render();
});

editGuestCancel.addEventListener('click', closeEditGuestModal);
editGuestOverlay.addEventListener('click', (e) => {
  if (e.target === editGuestOverlay) closeEditGuestModal();
});

// ---------- 历史预定记录 ----------
const historyOverlay = document.getElementById('historyOverlay');
const historyList = document.getElementById('historyList');
const historyEmpty = document.getElementById('historyEmpty');
const historyStartDate = document.getElementById('historyStartDate');
const historyEndDate = document.getElementById('historyEndDate');

/** 从预定历史表按日期范围查询（包含已变为空闲的记录：哪天预定了哪间、预定人信息） */
function getHistoryRecordsFromDB(startDate, endDate) {
  return getHistoryByDateRange(startDate || null, endDate || null).then((rows) => {
    const list = rows.map((r) => ({
      date: r.date,
      slot: r.slot,
      roomId: r.roomId,
      roomName: r.roomName || String(r.roomId),
      guestName: r.guestName || '—',
      guestPhone: r.guestPhone || '—',
      remark: r.remark || '',
      state: 'reserved' // 历史里统一显示为“已预定”
    }));
    list.sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      if (a.slot !== b.slot) return a.slot === SLOTS.NOON ? 1 : -1;
      return a.roomId - b.roomId;
    });
    return list;
  });
}

function openHistoryModal() {
  const t = new Date();
  const endStr = todayStr();
  const startStr = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-01';
  historyStartDate.value = startStr;
  historyEndDate.value = endStr;
  historyOverlay.setAttribute('aria-hidden', 'false');
  historyOverlay.classList.add('open');
  renderHistoryList([]);
  getHistoryRecordsFromDB(startStr, endStr).then((records) => renderHistoryList(records));
}

function closeHistoryModal() {
  historyOverlay.setAttribute('aria-hidden', 'true');
  historyOverlay.classList.remove('open');
}

function renderHistoryList(records) {
  historyList.innerHTML = '';
  historyEmpty.hidden = records.length > 0;
  records.forEach(r => {
    const li = document.createElement('li');
    li.className = `history-item state-${r.state}`;
    const remarkBlock = r.remark
      ? `<div class="history-item-remark">备注：${escapeHtml(r.remark)}</div>`
      : '';
    li.innerHTML = `
      <div class="history-item-head">
        <span class="history-date">${r.date}</span>
        <span class="history-slot">${SLOT_LABELS[r.slot]}</span>
        <span class="history-state-badge">${STATE_LABELS[r.state]}</span>
      </div>
      <div class="history-item-body">
        <span class="history-room">${r.roomName}</span>
        <span class="history-guest">${r.guestName} · ${r.guestPhone}</span>
      </div>
      ${remarkBlock}
    `;
    historyList.appendChild(li);
  });
}

document.getElementById('btnHistory').addEventListener('click', openHistoryModal);
document.getElementById('btnCloseHistory').addEventListener('click', closeHistoryModal);
historyOverlay.addEventListener('click', (e) => {
  if (e.target === historyOverlay) closeHistoryModal();
});

document.getElementById('btnHistoryQuery').addEventListener('click', () => {
  const start = historyStartDate.value || null;
  const end = historyEndDate.value || null;
  renderHistoryList([]);
  getHistoryRecordsFromDB(start, end).then((records) => renderHistoryList(records));
});

document.getElementById('btnClearDb').addEventListener('click', () => {
  if (!confirm('确定清空所有预定数据与历史记录吗？此操作不可恢复。')) return;
  clearAllData()
    .then(() => {
      reservations = {};
      render();
      if (historyOverlay.classList.contains('open')) {
        renderHistoryList([]);
      }
    })
    .catch((err) => console.error('清空失败', err));
});

function handleRoomClick(room) {
  const data = getRoomData(selectedDate, selectedSlot, room.id);
  if (data.state === STATES.FREE) {
    openReserveModal(room);
    return;
  }
  if (data.state === STATES.RESERVED) {
    setRoomData(selectedDate, selectedSlot, room.id, {
      state: STATES.DINING,
      guestName: data.guestName,
      guestPhone: data.guestPhone,
      remark: data.remark
    });
    render();
    return;
  }
  if (data.state === STATES.DINING) {
    if (!confirm(`确定将「${room.name}」设为空闲吗？`)) return;
    setRoomData(selectedDate, selectedSlot, room.id, { state: STATES.FREE });
    render();
  }
}

function renderRoom(room) {
  const data = getRoomData(selectedDate, selectedSlot, room.id);
  const card = document.createElement('div');
  card.className = `room-card state-${data.state}`;
  card.dataset.id = room.id;
  const guestHtml = (data.guestName || data.guestPhone)
    ? `<div class="room-guest">${data.guestName || '—'}<br><span class="room-phone">${data.guestPhone || '—'}</span></div>`
    : '';
  const isReserved = data.state === STATES.RESERVED;
  const isOccupied = data.state === STATES.RESERVED || data.state === STATES.DINING;
  const actionsHtml = isOccupied
    ? `<div class="room-actions-row">
        ${isReserved ? `<button type="button" class="room-btn room-cancel-btn" data-id="${room.id}">取消预定</button>` : ''}
        <button type="button" class="room-btn room-edit-btn" data-id="${room.id}">编辑</button>
        <button type="button" class="room-btn room-remark-btn" data-id="${room.id}">备注</button>
      </div>`
    : '';
  const remarkTextHtml = isOccupied && data.remark
    ? `<div class="room-remark-text">${escapeHtml(data.remark)}</div>`
    : '';
  card.innerHTML = `
    <div class="room-name">${room.name}</div>
    <div class="room-capacity">推荐 ${room.recommended} 人</div>
    ${guestHtml}
    ${remarkTextHtml}
    ${actionsHtml}
    <div class="room-state">${STATE_LABELS[data.state]}</div>
  `;
  return card;
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function render() {
  const grid = document.getElementById('roomsGrid');
  grid.innerHTML = '';
  ROOM_CONFIG.forEach(room => {
    grid.appendChild(renderRoom(room));
  });
  grid.querySelectorAll('.room-card').forEach(el => {
    const id = parseInt(el.dataset.id, 10);
    const room = ROOM_CONFIG.find(r => r.id === id);
    if (room) {
      el.addEventListener('click', () => handleRoomClick(room));
      el.querySelectorAll('.room-cancel-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!confirm(`确定取消「${room.name}」的预定吗？`)) return;
          setRoomData(selectedDate, selectedSlot, room.id, { state: STATES.FREE });
          deleteHistoryRecord(selectedDate, selectedSlot, room.id).catch(() => {});
          render();
        });
      });
      el.querySelectorAll('.room-edit-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          openEditGuestModal(room);
        });
      });
      el.querySelectorAll('.room-remark-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          openRemarkModal(room);
        });
      });
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await openDB();
    await migrateFromLocalStorage();
    reservations = await getAllReservations();
  } catch (err) {
    console.error('数据库加载失败', err);
  }
  initControls();
  render();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});
