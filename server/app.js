import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createHttpServer } from 'node:http';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import {
  applyOperation,
  backupDatabase,
  bootstrapUsers,
  createUser,
  deleteUser,
  getReservation,
  getStats,
  getUserById,
  getUserByUsername,
  listConflicts,
  listReservations,
  listUsers,
  openDatabase,
  resetUserPassword,
  resolveConflict,
  toUser,
  updateUser
} from './db.js';
import { createToken, hashPassword, verifyPassword, verifyToken } from './auth.js';
import { ROOMS } from './rooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CLIENT_FILES = new Set([
  'index.html',
  'admin.html',
  'app.js',
  'admin.js',
  'db.js',
  'styles.css',
  'sw.js',
  'manifest.json'
]);

export function createBookingServer(options = {}) {
  const databasePath = options.databasePath || process.env.DATABASE_PATH || path.join(PROJECT_ROOT, 'data', 'booking.sqlite');
  const clientDir = options.clientDir || PROJECT_ROOT;
  const backupDir = options.backupDir || process.env.BACKUP_DIR || path.join(PROJECT_ROOT, 'backups');
  const jwtSecret = options.jwtSecret || process.env.JWT_SECRET || 'dev-secret-change-me';
  const logger = options.logger || console;
  const db = openDatabase(databasePath);
  const bootstrapCredentials = bootstrapUsers(db);

  const app = express();
  const httpServer = createHttpServer(app);
  const io = new SocketServer(httpServer, {
    cors: { origin: true }
  });

  app.use(express.json({ limit: '1mb' }));

  app.post('/api/auth/login', (req, res, next) => {
    try {
      const username = String(req.body.username || '').trim();
      const password = String(req.body.password || '');
      const row = getUserByUsername(db, username);
      if (!row || !row.active || !verifyPassword(password, row.password_hash)) {
        res.status(401).json({ error: '账号或密码错误' });
        return;
      }
      const user = toUser(row);
      res.json({ token: createToken(user, jwtSecret), user });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/me', authRequired, (req, res) => {
    res.json({ user: toUser(req.user) });
  });

  app.post('/api/auth/change-password', authRequired, (req, res, next) => {
    try {
      const currentPassword = String(req.body.currentPassword || '');
      const newPassword = String(req.body.newPassword || '');
      if (!verifyPassword(currentPassword, req.user.password_hash)) {
        res.status(400).json({ error: '当前密码不正确' });
        return;
      }
      if (newPassword.length < 8) {
        res.status(400).json({ error: '新密码至少需要 8 位' });
        return;
      }
      db.prepare(`
        UPDATE users
        SET password_hash = ?, password_plain = ?, must_change_password = 0, updated_at = ?
        WHERE id = ?
      `).run(hashPassword(newPassword), newPassword, new Date().toISOString(), req.user.id);
      res.json({ user: toUser(getUserById(db, req.user.id)) });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/reservations', authRequired, (req, res, next) => {
    try {
      const startDate = normalizeDate(req.query.startDate) || todayStr();
      const endDate = normalizeDate(req.query.endDate) || startDate;
      res.json({
        rooms: ROOMS,
        reservations: listReservations(db, startDate, endDate)
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/sync/operations', authRequired, (req, res, next) => {
    try {
      const operations = Array.isArray(req.body.operations) ? req.body.operations : [];
      if (operations.length > 100) {
        res.status(400).json({ error: '一次最多同步 100 条操作' });
        return;
      }
      const applied = [];
      const conflicts = [];
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const operation of operations) {
          const result = applyOperation(db, toUser(req.user), operation);
          if (result.status === 'applied') applied.push(result.reservation);
          if (result.status === 'conflict') conflicts.push(result.conflict);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      for (const reservation of applied) {
        io.emit('reservation.changed', { reservation });
      }
      for (const conflict of conflicts) {
        io.to('boss').to('super_admin').emit('reservation.conflict', { conflict });
      }
      res.json({ applied, conflicts });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/conflicts', authRequired, requireRoles('boss', 'super_admin'), (req, res, next) => {
    try {
      res.json({ conflicts: listConflicts(db, 'pending') });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/conflicts/:id/resolve', authRequired, requireRoles('boss', 'super_admin'), (req, res, next) => {
    try {
      const result = resolveConflict(db, toUser(req.user), req.params.id, req.body.action);
      if (result.reservation) {
        io.emit('reservation.changed', { reservation: result.reservation });
      }
      io.to('boss').to('super_admin').emit('reservation.conflict', { resolvedId: Number(req.params.id) });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/users', authRequired, requireRoles('boss', 'super_admin'), (req, res, next) => {
    try {
      res.json({ users: listUsers(db, toUser(req.user)) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/users', authRequired, requireRoles('boss', 'super_admin'), (req, res, next) => {
    try {
      const result = createUser(db, toUser(req.user), req.body);
      io.to('boss').to('super_admin').emit('user.updated', { user: result.user });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  app.patch('/api/users/:id', authRequired, requireRoles('boss', 'super_admin'), (req, res, next) => {
    try {
      const user = updateUser(db, toUser(req.user), req.params.id, req.body);
      io.to('boss').to('super_admin').emit('user.updated', { user });
      res.json({ user });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/users/:id', authRequired, requireRoles('boss', 'super_admin'), (req, res, next) => {
    try {
      const user = deleteUser(db, toUser(req.user), req.params.id);
      io.to('boss').to('super_admin').emit('user.updated', { deletedId: user.id });
      res.json({ deleted: true, user });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/users/:id/reset-password', authRequired, requireRoles('boss', 'super_admin'), (req, res, next) => {
    try {
      const result = resetUserPassword(db, toUser(req.user), req.params.id);
      io.to('boss').to('super_admin').emit('user.updated', { user: result.user });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/stats/summary', authRequired, requireRoles('boss', 'super_admin'), (req, res, next) => {
    try {
      const startDate = normalizeDate(req.query.startDate) || firstDayOfMonth();
      const endDate = normalizeDate(req.query.endDate) || todayStr();
      res.json({ startDate, endDate, stats: getStats(db, startDate, endDate) });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    const payload = verifyToken(token, jwtSecret);
    if (!payload) {
      next(new Error('unauthorized'));
      return;
    }
    const user = getUserById(db, payload.sub);
    if (!user || !user.active) {
      next(new Error('unauthorized'));
      return;
    }
    socket.data.user = toUser(user);
    next();
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.join(user.role);
    socket.emit('connected', { user });
  });

  app.get('/admin', (_req, res) => {
    res.sendFile(path.join(clientDir, 'admin.html'));
  });

  app.get('/favicon.ico', (_req, res) => {
    res.sendFile(path.join(clientDir, 'icons', 'icon-192.png'));
  });

  app.get('/', (_req, res) => {
    res.sendFile(path.join(clientDir, 'index.html'));
  });

  app.get('/:file', (req, res, next) => {
    if (!CLIENT_FILES.has(req.params.file)) {
      next();
      return;
    }
    res.sendFile(path.join(clientDir, req.params.file));
  });

  app.use('/icons', express.static(path.join(clientDir, 'icons'), { maxAge: '1d' }));

  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) logger.error(err);
    res.status(status).json({ error: err.message || '服务器错误' });
  });

  let lastBackupDate = '';
  let backupTimer = null;
  if (!options.disableScheduler) {
    backupTimer = setInterval(() => {
      const now = new Date();
      const date = now.toISOString().slice(0, 10);
      const hour = Number(process.env.BACKUP_HOUR || 3);
      if (now.getHours() === hour && lastBackupDate !== date) {
        try {
          backupDatabase(db, backupDir);
          lastBackupDate = date;
        } catch (err) {
          logger.error('数据库备份失败', err);
        }
      }
    }, 1000 * 60 * 20);
  }

  function authRequired(req, res, next) {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const payload = verifyToken(token, jwtSecret);
    if (!payload) {
      res.status(401).json({ error: '请先登录' });
      return;
    }
    const user = getUserById(db, payload.sub);
    if (!user || !user.active) {
      res.status(401).json({ error: '账号不可用' });
      return;
    }
    req.user = user;
    next();
  }

  function requireRoles(...roles) {
    return (req, res, next) => {
      if (!roles.includes(req.user.role)) {
        res.status(403).json({ error: '没有权限' });
        return;
      }
      next();
    };
  }

  return {
    app,
    httpServer,
    io,
    db,
    backupTimer,
    backup: () => backupDatabase(db, backupDir),
    bootstrapCredentials
  };
}

function normalizeDate(value) {
  const date = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function firstDayOfMonth() {
  const today = todayStr();
  return `${today.slice(0, 8)}01`;
}
