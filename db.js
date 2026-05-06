/**
 * 预定数据库（IndexedDB）
 * 存储所有预定信息，供房间状态与历史查询使用
 */
const DB_NAME = 'restaurant_booking';
const DB_VERSION = 2;
const STORE_NAME = 'reservations';
const HISTORY_STORE = 'reservation_history';

let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (db) {
      resolve(db);
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      db = req.result;
      resolve(db);
    };
    req.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, {
          keyPath: ['date', 'slot', 'roomId']
        });
        store.createIndex('by_date', 'date', { unique: false });
      }
      // 预定历史表：仅在“预定时”写入一条，变为空闲也不删，供历史查询
      if (!database.objectStoreNames.contains(HISTORY_STORE)) {
        const historyStore = database.createObjectStore(HISTORY_STORE, {
          keyPath: 'id',
          autoIncrement: true
        });
        historyStore.createIndex('by_date', 'date', { unique: false });
      }
    };
  });
}

/**
 * 保存或更新一条预定（空闲且无客人信息时会改为删除）
 */
function saveReservation(record) {
  return openDB().then((database) => {
    return new Promise((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const key = [record.date, record.slot, record.roomId];
      const isFree = record.state === 'free' && !record.guestName && !record.guestPhone;
      if (isFree) {
        const delReq = store.delete(key);
        delReq.onsuccess = () => resolve();
        delReq.onerror = () => reject(delReq.error);
      } else {
        const putReq = store.put({
          date: record.date,
          slot: record.slot,
          roomId: record.roomId,
          guestName: record.guestName || '',
          guestPhone: record.guestPhone || '',
          state: record.state,
          remark: record.remark || ''
        });
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      }
    });
  });
}

/**
 * 预定时写入一条历史记录（只增不删，就餐完变为空闲后仍可查到哪天谁预定了哪间）
 */
function addReservationHistory(record) {
  return openDB().then((database) => {
    return new Promise((resolve, reject) => {
      const tx = database.transaction(HISTORY_STORE, 'readwrite');
      const store = tx.objectStore(HISTORY_STORE);
      const putReq = store.put({
        date: record.date,
        slot: record.slot,
        roomId: record.roomId,
        roomName: record.roomName || '',
        guestName: record.guestName || '',
        guestPhone: record.guestPhone || '',
        remark: record.remark || ''
      });
      putReq.onsuccess = () => resolve(putReq.result);
      putReq.onerror = () => reject(putReq.error);
    });
  });
}

/**
 * 更新某条历史记录的备注（保存房间备注时同步到历史，便于历史查询显示）
 */
function updateHistoryRemark(date, slot, roomId, remark) {
  return openDB().then((database) => {
    return new Promise((resolve, reject) => {
      const tx = database.transaction(HISTORY_STORE, 'readwrite');
      const store = tx.objectStore(HISTORY_STORE);
      const index = store.index('by_date');
      const req = index.openCursor(IDBKeyRange.only(date));
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve();
          return;
        }
        const rec = cursor.value;
        if (rec.slot === slot && rec.roomId === roomId) {
          store.put({ ...rec, remark: remark || '' });
          resolve();
          return;
        }
        cursor.continue();
      };
    });
  });
}

/**
 * 删除某条历史记录（取消预定时同步删除）
 */
function deleteHistoryRecord(date, slot, roomId) {
  return openDB().then((database) => {
    return new Promise((resolve, reject) => {
      const tx = database.transaction(HISTORY_STORE, 'readwrite');
      const store = tx.objectStore(HISTORY_STORE);
      const index = store.index('by_date');
      const req = index.openCursor(IDBKeyRange.only(date));
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const rec = cursor.value;
        if (rec.slot === slot && rec.roomId === roomId) {
          cursor.delete();
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  });
}

/**
 * 按日期范围查询预定历史（从历史表查，包含已变为空闲的记录）
 */
function getHistoryByDateRange(startDate, endDate) {
  return openDB().then((database) => {
    return new Promise((resolve, reject) => {
      const tx = database.transaction(HISTORY_STORE, 'readonly');
      const store = tx.objectStore(HISTORY_STORE);
      const index = store.index('by_date');
      const range = startDate && endDate
        ? IDBKeyRange.bound(startDate, endDate)
        : startDate
          ? IDBKeyRange.lowerBound(startDate)
          : endDate
            ? IDBKeyRange.upperBound(endDate)
            : null;
      const req = range ? index.openCursor(range) : store.openCursor();
      const results = [];
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
    });
  });
}

/**
 * 读取全部预定到内存（用于页面展示当前日期/时段的房间状态）
 */
function getAllReservations() {
  return openDB().then((database) => {
    return new Promise((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.openCursor();
      const map = {};
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const { date, slot, roomId, state, guestName, guestPhone, remark } = cursor.value;
          if (!map[date]) map[date] = {};
          if (!map[date][slot]) map[date][slot] = {};
          map[date][slot][String(roomId)] = { state, guestName, guestPhone, remark: remark || '' };
          cursor.continue();
        } else {
          resolve(map);
        }
      };
    });
  });
}

/**
 * 清空当前数据库：预定状态表 + 预定历史表（不可恢复）
 */
function clearAllData() {
  return openDB().then((database) => {
    return new Promise((resolve, reject) => {
      const tx = database.transaction([STORE_NAME, HISTORY_STORE], 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const historyStore = tx.objectStore(HISTORY_STORE);
      store.clear();
      historyStore.clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  });
}

/**
 * 迁移：从 localStorage 导入旧数据到 IndexedDB，并写入预定历史表
 */
function migrateFromLocalStorage() {
  try {
    const saved = localStorage.getItem('restaurant_reservations');
    if (!saved) return Promise.resolve();
    const data = JSON.parse(saved);
    return openDB().then((database) => {
      const tx = database.transaction([STORE_NAME, HISTORY_STORE], 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const historyStore = tx.objectStore(HISTORY_STORE);
      let count = 0;
      for (const date of Object.keys(data)) {
        const day = data[date];
        if (typeof day !== 'object') continue;
        for (const slot of ['noon', 'evening']) {
          const slotData = day[slot];
          if (!slotData || typeof slotData !== 'object') continue;
          for (const roomIdStr of Object.keys(slotData)) {
            const r = slotData[roomIdStr];
            if (!r || (r.state === 'free' && !r.guestName && !r.guestPhone)) continue;
            const roomId = Number(roomIdStr);
            store.put({
              date,
              slot,
              roomId,
              guestName: r.guestName || '',
              guestPhone: r.guestPhone || '',
              state: r.state || 'reserved'
            });
            if (r.guestName || r.guestPhone) {
              historyStore.put({
                date,
                slot,
                roomId,
                roomName: '', // 迁移时无 roomName，历史列表用 roomId 或后续不显示
                guestName: r.guestName || '',
                guestPhone: r.guestPhone || ''
              });
            }
            count++;
          }
        }
      }
      return new Promise((resolve, reject) => {
        tx.oncomplete = () => {
          if (count > 0) localStorage.removeItem('restaurant_reservations');
          resolve(count);
        };
        tx.onerror = () => reject(tx.error);
      });
    });
  } catch (_) {
    return Promise.resolve();
  }
}
