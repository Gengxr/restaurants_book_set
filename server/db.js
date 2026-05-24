import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword, randomPassword } from './auth.js';
import { ROOMS } from './rooms.js';

export function nowIso() {
  return new Date().toISOString();
}

export function openDatabase(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  migrate(db);
  seedRooms(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('super_admin', 'boss', 'employee')),
      password_hash TEXT NOT NULL,
      password_plain TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      recommended INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      slot TEXT NOT NULL,
      room_id INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('free', 'reserved', 'dining')),
      guest_name TEXT NOT NULL DEFAULT '',
      guest_phone TEXT NOT NULL DEFAULT '',
      party_size INTEGER,
      has_deposit INTEGER NOT NULL DEFAULT 0,
      deposit_amount REAL NOT NULL DEFAULT 0,
      remark TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 0,
      updated_by INTEGER,
      updated_at TEXT NOT NULL,
      UNIQUE(date, slot, room_id)
    );

    CREATE TABLE IF NOT EXISTS reservation_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      slot TEXT NOT NULL,
      room_id INTEGER NOT NULL,
      user_id INTEGER,
      action TEXT NOT NULL,
      state TEXT NOT NULL,
      guest_name TEXT NOT NULL DEFAULT '',
      guest_phone TEXT NOT NULL DEFAULT '',
      party_size INTEGER,
      has_deposit INTEGER NOT NULL DEFAULT 0,
      deposit_amount REAL NOT NULL DEFAULT 0,
      remark TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_operation_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      slot TEXT NOT NULL,
      room_id INTEGER NOT NULL,
      base_version INTEGER NOT NULL,
      server_version INTEGER NOT NULL,
      requested_json TEXT NOT NULL,
      server_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      resolution TEXT,
      created_at TEXT NOT NULL,
      resolved_by INTEGER,
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_reservations_date ON reservations(date);
    CREATE INDEX IF NOT EXISTS idx_history_date ON reservation_history(date);
    CREATE INDEX IF NOT EXISTS idx_conflicts_status ON sync_conflicts(status);
  `);
  ensureColumn(db, 'users', 'password_plain', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'reservation_history', 'actor_username', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'reservation_history', 'actor_display_name', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'reservation_history', 'actor_role', "TEXT NOT NULL DEFAULT ''");
  db.exec('UPDATE users SET must_change_password = 0 WHERE must_change_password != 0;');
  db.exec(`
    UPDATE reservation_history
    SET
      actor_username = COALESCE((SELECT username FROM users WHERE users.id = reservation_history.user_id), ''),
      actor_display_name = COALESCE((SELECT display_name FROM users WHERE users.id = reservation_history.user_id), ''),
      actor_role = COALESCE((SELECT role FROM users WHERE users.id = reservation_history.user_id), '')
    WHERE actor_username = '' AND user_id IS NOT NULL;
  `);
}

function ensureColumn(db, table, column, definition) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!rows.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function seedRooms(db) {
  const stmt = db.prepare(`
    INSERT INTO rooms (id, name, recommended, active)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      recommended = excluded.recommended,
      active = 1
  `);
  for (const room of ROOMS) {
    stmt.run(room.id, room.name, room.recommended);
  }
}

export function bootstrapUsers(db) {
  const count = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (count > 0) return [];

  const createdAt = nowIso();
  const insert = db.prepare(`
    INSERT INTO users (username, display_name, role, password_hash, password_plain, active, must_change_password, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)
  `);
  const adminPassword = randomPassword();
  const bossPassword = randomPassword();
  insert.run('admin', '超级管理员', 'super_admin', hashPassword(adminPassword), adminPassword, createdAt, createdAt);
  insert.run('boss', '老板', 'boss', hashPassword(bossPassword), bossPassword, createdAt, createdAt);
  return [
    { username: 'admin', role: 'super_admin', password: adminPassword },
    { username: 'boss', role: 'boss', password: bossPassword }
  ];
}

export function toUser(row, options = {}) {
  if (!row) return null;
  const user = {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    active: Boolean(row.active),
    mustChangePassword: Boolean(row.must_change_password),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (options.includePassword) user.visiblePassword = row.password_plain || '';
  return user;
}

export function getUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
}

export function getUserByUsername(db, username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
}

export function listUsers(db, viewer) {
  const rows = viewer.role === 'super_admin'
    ? db.prepare('SELECT * FROM users ORDER BY role, id').all()
    : db.prepare("SELECT * FROM users WHERE role = 'employee' ORDER BY id").all();
  return rows.map((row) => toUser(row, { includePassword: viewer.role === 'super_admin' }));
}

export function createUser(db, actor, input) {
  const username = String(input.username || '').trim();
  const displayName = String(input.displayName || input.username || '').trim();
  const requestedRole = input.role || 'employee';
  const role = actor.role === 'super_admin' ? requestedRole : 'employee';
  if (!username || username.length < 2) throw httpError(400, '账号至少需要 2 个字符');
  if (!displayName) throw httpError(400, '请输入显示名称');
  if (!['boss', 'employee'].includes(role)) throw httpError(400, '只能创建老板或员工账号');
  const password = String(input.password || '');
  if (!password) throw httpError(400, '请输入密码');
  if (password.length < 6) throw httpError(400, '密码至少需要 6 位');
  const createdAt = nowIso();
  try {
    const result = db.prepare(`
      INSERT INTO users (username, display_name, role, password_hash, password_plain, active, must_change_password, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)
    `).run(username, displayName, role, hashPassword(password), password, createdAt, createdAt);
    return { user: toUser(getUserById(db, result.lastInsertRowid), { includePassword: actor.role === 'super_admin' }), password };
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) throw httpError(409, '账号已存在');
    throw err;
  }
}

export function updateUser(db, actor, id, input) {
  const existing = getUserById(db, id);
  if (!existing) throw httpError(404, '用户不存在');
  if (actor.role !== 'super_admin' && existing.role !== 'employee') {
    throw httpError(403, '老板只能管理员工账号');
  }
  const username = actor.role === 'super_admin' && input.username != null
    ? String(input.username).trim()
    : existing.username;
  const displayName = input.displayName == null ? existing.display_name : String(input.displayName).trim();
  const active = input.active == null ? existing.active : (input.active ? 1 : 0);
  const role = actor.role === 'super_admin' && input.role ? input.role : existing.role;
  const password = actor.role === 'super_admin' && input.password ? String(input.password) : '';
  if (!username || username.length < 2) throw httpError(400, '账号至少需要 2 个字符');
  if (!displayName) throw httpError(400, '请输入显示名称');
  if (!['super_admin', 'boss', 'employee'].includes(role)) throw httpError(400, '角色无效');
  if (password && password.length < 6) throw httpError(400, '密码至少需要 6 位');
  try {
    if (password) {
      db.prepare(`
        UPDATE users
        SET username = ?, display_name = ?, active = ?, role = ?, password_hash = ?, password_plain = ?, must_change_password = 0, updated_at = ?
        WHERE id = ?
      `).run(username, displayName, active, role, hashPassword(password), password, nowIso(), Number(id));
    } else {
      db.prepare(`
        UPDATE users
        SET username = ?, display_name = ?, active = ?, role = ?, updated_at = ?
        WHERE id = ?
      `).run(username, displayName, active, role, nowIso(), Number(id));
    }
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) throw httpError(409, '账号已存在');
    throw err;
  }
  return toUser(getUserById(db, id), { includePassword: actor.role === 'super_admin' });
}

export function deleteUser(db, actor, id) {
  const existing = getUserById(db, id);
  if (!existing) throw httpError(404, '用户不存在');
  if (existing.role !== 'employee') throw httpError(403, '只能删除员工账号');
  if (!['boss', 'super_admin'].includes(actor.role)) throw httpError(403, '没有权限');
  db.prepare('DELETE FROM users WHERE id = ?').run(Number(id));
  return toUser(existing);
}

export function resetUserPassword(db, actor, id) {
  const existing = getUserById(db, id);
  if (!existing) throw httpError(404, '用户不存在');
  if (actor.role !== 'super_admin' && existing.role !== 'employee') {
    throw httpError(403, '老板只能重置员工密码');
  }
  const password = randomPassword();
  db.prepare(`
    UPDATE users
    SET password_hash = ?, password_plain = ?, must_change_password = 0, updated_at = ?
    WHERE id = ?
  `).run(hashPassword(password), password, nowIso(), Number(id));
  return { user: toUser(getUserById(db, id), { includePassword: actor.role === 'super_admin' }), password };
}

export function getReservation(db, date, slot, roomId) {
  const row = db.prepare(`
    SELECT * FROM reservations
    WHERE date = ? AND slot = ? AND room_id = ?
  `).get(date, slot, Number(roomId));
  return row ? toReservation(row) : defaultReservation(date, slot, roomId);
}

export function listReservations(db, startDate, endDate) {
  const rows = db.prepare(`
    SELECT * FROM reservations
    WHERE date BETWEEN ? AND ?
    ORDER BY date, slot, room_id
  `).all(startDate, endDate);
  return rows.map(toReservation);
}

export function applyOperation(db, user, rawOperation) {
  const operation = normalizeOperation(rawOperation);
  const current = getReservation(db, operation.date, operation.slot, operation.roomId);
  const baseVersion = Number(operation.baseVersion || 0);

  if (current.version !== baseVersion) {
    const conflict = createConflict(db, user, operation, current);
    return { status: 'conflict', conflict };
  }

  const next = normalizeReservationPatch({
    ...current,
    ...operation.patch,
    date: operation.date,
    slot: operation.slot,
    roomId: operation.roomId,
    version: current.version + 1,
    updatedBy: user.id,
    updatedAt: nowIso()
  });

  upsertReservation(db, next);
  insertHistory(db, user, next, current);
  return { status: 'applied', reservation: next };
}

export function listConflicts(db, status = 'pending') {
  const rows = db.prepare(`
    SELECT c.*, u.username, u.display_name
    FROM sync_conflicts c
    LEFT JOIN users u ON u.id = c.user_id
    WHERE c.status = ?
    ORDER BY c.id DESC
  `).all(status);
  return rows.map(toConflict);
}

export function resolveConflict(db, actor, id, action) {
  const row = db.prepare('SELECT * FROM sync_conflicts WHERE id = ?').get(Number(id));
  if (!row) throw httpError(404, '冲突不存在');
  if (row.status !== 'pending') throw httpError(409, '冲突已处理');
  const resolvedAt = nowIso();

  if (action === 'keep_server') {
    db.prepare(`
      UPDATE sync_conflicts
      SET status = 'resolved', resolution = 'keep_server', resolved_by = ?, resolved_at = ?
      WHERE id = ?
    `).run(actor.id, resolvedAt, Number(id));
    return { action, reservation: JSON.parse(row.server_json) };
  }

  if (action === 'overwrite') {
    const requested = JSON.parse(row.requested_json);
    const current = getReservation(db, row.date, row.slot, row.room_id);
    const next = normalizeReservationPatch({
      ...current,
      ...requested.patch,
      date: row.date,
      slot: row.slot,
      roomId: row.room_id,
      version: current.version + 1,
      updatedBy: actor.id,
      updatedAt: resolvedAt
    });
    upsertReservation(db, next);
    insertHistory(db, actor, next, current);
    db.prepare(`
      UPDATE sync_conflicts
      SET status = 'resolved', resolution = 'overwrite', resolved_by = ?, resolved_at = ?
      WHERE id = ?
    `).run(actor.id, resolvedAt, Number(id));
    return { action, reservation: next };
  }

  throw httpError(400, '处理方式无效');
}

export function getStats(db, startDate, endDate) {
  const totals = db.prepare(`
    SELECT
      SUM(CASE WHEN action = 'reserve' THEN 1 ELSE 0 END) AS reserved_count,
      SUM(CASE WHEN action = 'cancelled' THEN 1 ELSE 0 END) AS cancel_count,
      SUM(CASE WHEN action = 'dining' THEN 1 ELSE 0 END) AS dining_count
    FROM reservation_history
    WHERE date BETWEEN ? AND ?
  `).get(startDate, endDate);

  const rooms = db.prepare(`
    SELECT h.room_id, r.name, COUNT(*) AS count
    FROM reservation_history h
    LEFT JOIN rooms r ON r.id = h.room_id
    WHERE h.date BETWEEN ? AND ? AND h.action = 'reserve'
    GROUP BY h.room_id
    ORDER BY count DESC, h.room_id ASC
    LIMIT 10
  `).all(startDate, endDate);

  const operations = db.prepare(`
    SELECT
      h.*,
      r.name AS room_name,
      u.username AS current_username,
      u.display_name AS current_display_name
    FROM reservation_history h
    LEFT JOIN rooms r ON r.id = h.room_id
    LEFT JOIN users u ON u.id = h.user_id
    WHERE h.date BETWEEN ? AND ?
    ORDER BY h.id DESC
    LIMIT 200
  `).all(startDate, endDate);

  return {
    reservedCount: totals.reserved_count || 0,
    cancelCount: totals.cancel_count || 0,
    diningCount: totals.dining_count || 0,
    popularRooms: rooms.map((row) => ({
      roomId: row.room_id,
      roomName: row.name || String(row.room_id),
      count: row.count
    })),
    operations: operations.map((row) => ({
      id: row.id,
      date: row.date,
      slot: row.slot,
      roomId: row.room_id,
      roomName: row.room_name || String(row.room_id),
      action: row.action,
      state: row.state,
      guestName: row.guest_name || '',
      guestPhone: row.guest_phone || '',
      partySize: row.party_size == null ? null : row.party_size,
      hasDeposit: Boolean(row.has_deposit),
      depositAmount: Number(row.deposit_amount || 0),
      remark: row.remark || '',
      userId: row.user_id,
      username: row.actor_username || row.current_username || '未知账号',
      displayName: row.actor_display_name || row.current_display_name || '未知姓名',
      role: row.actor_role || '',
      createdAt: row.created_at
    }))
  };
}

export function backupDatabase(db, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  const filename = `booking-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.sqlite`;
  const target = path.join(backupDir, filename);
  const escaped = target.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  return target;
}

function defaultReservation(date, slot, roomId) {
  return {
    date,
    slot,
    roomId: Number(roomId),
    state: 'free',
    guestName: '',
    guestPhone: '',
    partySize: null,
    hasDeposit: false,
    depositAmount: 0,
    remark: '',
    version: 0,
    updatedBy: null,
    updatedAt: null
  };
}

function toReservation(row) {
  return {
    date: row.date,
    slot: row.slot,
    roomId: row.room_id,
    state: row.state,
    guestName: row.guest_name || '',
    guestPhone: row.guest_phone || '',
    partySize: row.party_size == null ? null : row.party_size,
    hasDeposit: Boolean(row.has_deposit),
    depositAmount: Number(row.deposit_amount || 0),
    remark: row.remark || '',
    version: row.version,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at
  };
}

function normalizeOperation(raw) {
  const operation = raw || {};
  const date = String(operation.date || '').trim();
  const slot = String(operation.slot || '').trim();
  const roomId = Number(operation.roomId);
  const clientOperationId = String(operation.clientOperationId || '').trim();
  if (!clientOperationId) throw httpError(400, '缺少操作 ID');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw httpError(400, '日期格式无效');
  if (!['noon', 'evening'].includes(slot)) throw httpError(400, '时段无效');
  if (!ROOMS.some((room) => room.id === roomId)) throw httpError(400, '房间不存在');
  return {
    clientOperationId,
    date,
    slot,
    roomId,
    baseVersion: Number(operation.baseVersion || 0),
    patch: operation.patch || {}
  };
}

function normalizeReservationPatch(input) {
  const state = String(input.state || 'free');
  if (!['free', 'reserved', 'dining'].includes(state)) throw httpError(400, '状态无效');
  const hasDeposit = Boolean(input.hasDeposit);
  const depositAmount = hasDeposit ? Number(input.depositAmount || 0) : 0;
  const partySize = input.partySize === '' || input.partySize == null ? null : Number(input.partySize);
  if (partySize != null && (!Number.isInteger(partySize) || partySize < 1 || partySize > 99)) {
    throw httpError(400, '到店人数需要是 1-99 的整数');
  }
  if (hasDeposit && (!Number.isFinite(depositAmount) || depositAmount <= 0)) {
    throw httpError(400, '请输入有效订金金额');
  }
  const guestName = state === 'free' ? '' : String(input.guestName || '').trim();
  const guestPhone = state === 'free' ? '' : String(input.guestPhone || '').trim();
  if (state === 'reserved' && (!guestName || !guestPhone)) {
    throw httpError(400, '预订需要填写姓名和手机号');
  }
  return {
    date: input.date,
    slot: input.slot,
    roomId: Number(input.roomId),
    state,
    guestName,
    guestPhone,
    partySize: state === 'free' ? null : partySize,
    hasDeposit: state === 'free' ? false : hasDeposit,
    depositAmount: state === 'free' ? 0 : depositAmount,
    remark: state === 'free' ? '' : String(input.remark || '').trim(),
    version: Number(input.version || 0),
    updatedBy: input.updatedBy == null ? null : Number(input.updatedBy),
    updatedAt: input.updatedAt || nowIso()
  };
}

function upsertReservation(db, reservation) {
  db.prepare(`
    INSERT INTO reservations (
      date, slot, room_id, state, guest_name, guest_phone, party_size,
      has_deposit, deposit_amount, remark, version, updated_by, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, slot, room_id) DO UPDATE SET
      state = excluded.state,
      guest_name = excluded.guest_name,
      guest_phone = excluded.guest_phone,
      party_size = excluded.party_size,
      has_deposit = excluded.has_deposit,
      deposit_amount = excluded.deposit_amount,
      remark = excluded.remark,
      version = excluded.version,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  `).run(
    reservation.date,
    reservation.slot,
    reservation.roomId,
    reservation.state,
    reservation.guestName,
    reservation.guestPhone,
    reservation.partySize,
    reservation.hasDeposit ? 1 : 0,
    reservation.depositAmount,
    reservation.remark,
    reservation.version,
    reservation.updatedBy,
    reservation.updatedAt
  );
}

function insertHistory(db, user, reservation, previous) {
  const action = getHistoryAction(previous, reservation);
  db.prepare(`
    INSERT INTO reservation_history (
      date, slot, room_id, user_id, actor_username, actor_display_name, actor_role,
      action, state, guest_name, guest_phone, party_size, has_deposit, deposit_amount, remark, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    reservation.date,
    reservation.slot,
    reservation.roomId,
    user.id,
    user.username || '',
    user.displayName || '',
    user.role || '',
    action,
    reservation.state,
    reservation.guestName,
    reservation.guestPhone,
    reservation.partySize,
    reservation.hasDeposit ? 1 : 0,
    reservation.depositAmount,
    reservation.remark,
    nowIso()
  );
}

function getHistoryAction(previous, reservation) {
  if (reservation.state === 'free') return 'cancelled';
  if (reservation.state === 'dining') return 'dining';
  if (!previous || previous.state === 'free') return 'reserve';
  return 'updated';
}

function createConflict(db, user, operation, serverReservation) {
  const createdAt = nowIso();
  const result = db.prepare(`
    INSERT INTO sync_conflicts (
      client_operation_id, user_id, date, slot, room_id, base_version, server_version,
      requested_json, server_json, status, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    operation.clientOperationId,
    user.id,
    operation.date,
    operation.slot,
    operation.roomId,
    operation.baseVersion,
    serverReservation.version,
    JSON.stringify(operation),
    JSON.stringify(serverReservation),
    createdAt
  );
  return toConflict(db.prepare('SELECT c.*, u.username, u.display_name FROM sync_conflicts c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(result.lastInsertRowid));
}

function toConflict(row) {
  return {
    id: row.id,
    clientOperationId: row.client_operation_id,
    userId: row.user_id,
    username: row.username || '',
    displayName: row.display_name || '',
    date: row.date,
    slot: row.slot,
    roomId: row.room_id,
    baseVersion: row.base_version,
    serverVersion: row.server_version,
    requested: JSON.parse(row.requested_json),
    server: JSON.parse(row.server_json),
    status: row.status,
    resolution: row.resolution,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
  };
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
