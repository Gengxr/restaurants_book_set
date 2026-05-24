const BOOKING_CACHE_DB = 'booking_server_cache';
const BOOKING_CACHE_VERSION = 1;

let bookingCacheDb = null;

function openBookingCache() {
  return new Promise((resolve, reject) => {
    if (bookingCacheDb) {
      resolve(bookingCacheDb);
      return;
    }
    const req = indexedDB.open(BOOKING_CACHE_DB, BOOKING_CACHE_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      bookingCacheDb = req.result;
      resolve(bookingCacheDb);
    };
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('reservation_cache')) {
        const store = db.createObjectStore('reservation_cache', {
          keyPath: ['date', 'slot', 'roomId']
        });
        store.createIndex('by_date', 'date', { unique: false });
      }
      if (!db.objectStoreNames.contains('pending_ops')) {
        const store = db.createObjectStore('pending_ops', {
          keyPath: 'clientOperationId'
        });
        store.createIndex('by_room', ['date', 'slot', 'roomId'], { unique: false });
        store.createIndex('by_created', 'createdAt', { unique: false });
      }
    };
  });
}

function tx(storeNames, mode, callback) {
  return openBookingCache().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(storeNames, mode);
    const result = callback(transaction);
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  }));
}

function cacheReservations(reservations) {
  return tx(['reservation_cache'], 'readwrite', (transaction) => {
    const store = transaction.objectStore('reservation_cache');
    reservations.forEach((reservation) => store.put(reservation));
  });
}

function putCachedReservation(reservation) {
  return tx(['reservation_cache'], 'readwrite', (transaction) => {
    transaction.objectStore('reservation_cache').put(reservation);
  });
}

function getCachedReservationsByDate(date) {
  return openBookingCache().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction('reservation_cache', 'readonly');
    const req = transaction.objectStore('reservation_cache').index('by_date').openCursor(IDBKeyRange.only(date));
    const rows = [];
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(rows);
        return;
      }
      rows.push(cursor.value);
      cursor.continue();
    };
  }));
}

function addPendingOperation(operation) {
  return tx(['pending_ops'], 'readwrite', (transaction) => {
    transaction.objectStore('pending_ops').put(operation);
  });
}

function removePendingOperations(ids) {
  return tx(['pending_ops'], 'readwrite', (transaction) => {
    const store = transaction.objectStore('pending_ops');
    ids.forEach((id) => store.delete(id));
  });
}

function removePendingForRoom(date, slot, roomId) {
  return openBookingCache().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction('pending_ops', 'readwrite');
    const index = transaction.objectStore('pending_ops').index('by_room');
    const req = index.openCursor(IDBKeyRange.only([date, slot, Number(roomId)]));
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  }));
}

function getPendingOperations() {
  return openBookingCache().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction('pending_ops', 'readonly');
    const req = transaction.objectStore('pending_ops').index('by_created').openCursor();
    const rows = [];
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(rows);
        return;
      }
      rows.push(cursor.value);
      cursor.continue();
    };
  }));
}

function clearBookingCache() {
  return tx(['reservation_cache', 'pending_ops'], 'readwrite', (transaction) => {
    transaction.objectStore('reservation_cache').clear();
    transaction.objectStore('pending_ops').clear();
  });
}

window.bookingDb = {
  openBookingCache,
  cacheReservations,
  putCachedReservation,
  getCachedReservationsByDate,
  addPendingOperation,
  removePendingOperations,
  removePendingForRoom,
  getPendingOperations,
  clearBookingCache
};
