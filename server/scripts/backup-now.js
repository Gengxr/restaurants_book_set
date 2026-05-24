import path from 'node:path';
import { backupDatabase, openDatabase } from '../db.js';

const databasePath = process.env.DATABASE_PATH || path.resolve('data/booking.sqlite');
const backupDir = process.env.BACKUP_DIR || path.resolve('backups');
const db = openDatabase(databasePath);
const target = backupDatabase(db, backupDir);
console.log(`数据库已备份到：${target}`);
