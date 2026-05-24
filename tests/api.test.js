import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createBookingServer } from '../server/app.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'booking-test-'));
const service = createBookingServer({
  databasePath: path.join(tempDir, 'test.sqlite'),
  backupDir: path.join(tempDir, 'backups'),
  jwtSecret: 'test-secret',
  clientDir: path.resolve('.'),
  disableScheduler: true,
  logger: { error() {} }
});

let baseUrl;
let adminToken;
let bossToken;
let employeeToken;
let employeeId;

before(async () => {
  await new Promise((resolve, reject) => {
    service.httpServer.once('error', reject);
    service.httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = service.httpServer.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  service.io.close();
  await new Promise((resolve) => service.httpServer.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('bootstrap users can log in without forced password change', async () => {
  const admin = service.bootstrapCredentials.find((item) => item.username === 'admin');
  const result = await post('/api/auth/login', {
    username: 'admin',
    password: admin.password
  });
  adminToken = result.token;
  assert.equal(result.user.role, 'super_admin');
  assert.equal(result.user.mustChangePassword, false);

  const me = await get('/api/me', adminToken);
  assert.equal(me.user.username, 'admin');
});

test('admin can create employee and boss can manage employees only', async () => {
  const boss = service.bootstrapCredentials.find((item) => item.username === 'boss');
  const bossLogin = await post('/api/auth/login', {
    username: 'boss',
    password: boss.password
  });
  bossToken = bossLogin.token;

  const missingPassword = await fetch(`${baseUrl}/api/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bossToken}`
    },
    body: JSON.stringify({
      username: 'no-password',
      displayName: '未设密码',
      role: 'employee'
    })
  });
  assert.equal(missingPassword.status, 400);

  const created = await post('/api/users', {
    username: 'waiter1',
    displayName: '员工一',
    role: 'employee',
    password: 'employee-start-password'
  }, bossToken);
  assert.equal(created.user.role, 'employee');
  assert.equal(created.password, 'employee-start-password');
  employeeId = created.user.id;

  const employeeLogin = await post('/api/auth/login', {
    username: 'waiter1',
    password: 'employee-start-password'
  });
  employeeToken = employeeLogin.token;

  const denied = await fetch(`${baseUrl}/api/users`, {
    headers: { Authorization: `Bearer ${employeeToken}` }
  });
  assert.equal(denied.status, 403);

  const adminUsers = await get('/api/users', adminToken);
  const visibleToAdmin = adminUsers.users.find((user) => user.id === employeeId);
  assert.equal(visibleToAdmin.visiblePassword, 'employee-start-password');

  const bossUsers = await get('/api/users', bossToken);
  const visibleToBoss = bossUsers.users.find((user) => user.id === employeeId);
  assert.equal(Object.hasOwn(visibleToBoss, 'visiblePassword'), false);
});

test('reservation sync applies versions and creates conflicts', async () => {
  const first = await post('/api/sync/operations', {
    operations: [{
      clientOperationId: 'op-1',
      date: '2026-05-23',
      slot: 'noon',
      roomId: 1,
      baseVersion: 0,
      patch: {
        state: 'reserved',
        guestName: '张三',
        guestPhone: '13800000000',
        partySize: 6,
        hasDeposit: true,
        depositAmount: 100,
        remark: '靠窗'
      }
    }]
  }, bossToken);
  assert.equal(first.applied.length, 1);
  assert.equal(first.applied[0].version, 1);

  const conflict = await post('/api/sync/operations', {
    operations: [{
      clientOperationId: 'op-2',
      date: '2026-05-23',
      slot: 'noon',
      roomId: 1,
      baseVersion: 0,
      patch: {
        state: 'reserved',
        guestName: '李四',
        guestPhone: '13900000000',
        partySize: 4,
        hasDeposit: false,
        depositAmount: 0,
        remark: ''
      }
    }]
  }, employeeToken);
  assert.equal(conflict.conflicts.length, 1);

  const conflicts = await get('/api/conflicts', bossToken);
  assert.equal(conflicts.conflicts.length, 1);
});

test('stats and backup are available', async () => {
  const stats = await get('/api/stats/summary?startDate=2026-05-01&endDate=2026-05-31', bossToken);
  assert.equal(stats.stats.reservedCount, 1);
  assert.equal(stats.stats.operations.length, 1);
  assert.equal(stats.stats.operations[0].action, 'reserve');
  assert.equal(stats.stats.operations[0].displayName, '老板');
  assert.match(stats.stats.operations[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);
  const backupPath = service.backup();
  assert.equal(fs.existsSync(backupPath), true);
});

test('admin can edit account information and boss can delete employees', async () => {
  const edited = await patch(`/api/users/${employeeId}`, {
    username: 'waiter-renamed',
    displayName: '员工改名',
    role: 'employee',
    password: 'new-employee-password'
  }, adminToken);
  assert.equal(edited.user.username, 'waiter-renamed');
  assert.equal(edited.user.displayName, '员工改名');
  assert.equal(edited.user.mustChangePassword, false);
  assert.equal(edited.user.visiblePassword, 'new-employee-password');

  const deleted = await del(`/api/users/${employeeId}`, bossToken);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.user.role, 'employee');

  const loginAfterDelete = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'waiter-renamed',
      password: 'new-employee-password'
    })
  });
  assert.equal(loginAfterDelete.status, 401);
});

async function get(url, token) {
  const response = await fetch(`${baseUrl}${url}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return readJson(response);
}

async function post(url, body, token) {
  const response = await fetch(`${baseUrl}${url}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  return readJson(response);
}

async function patch(url, body, token) {
  const response = await fetch(`${baseUrl}${url}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
  return readJson(response);
}

async function del(url, token) {
  const response = await fetch(`${baseUrl}${url}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  return readJson(response);
}

async function readJson(response) {
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}
