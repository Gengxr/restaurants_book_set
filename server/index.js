import path from 'node:path';
import { createBookingServer } from './app.js';
import { randomSecret } from './auth.js';

if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = randomSecret();
  console.warn('警告：未设置 JWT_SECRET，本次启动使用临时密钥。生产环境请在 .env 中设置固定强密钥。');
}

const port = Number(process.env.PORT || 3000);
const service = createBookingServer({
  databasePath: process.env.DATABASE_PATH || path.resolve('data/booking.sqlite'),
  backupDir: process.env.BACKUP_DIR || path.resolve('backups')
});

if (service.bootstrapCredentials.length > 0) {
  console.log('初始账号已创建，请妥善保存以下密码：');
  for (const account of service.bootstrapCredentials) {
    console.log(`- ${account.role} / ${account.username} / ${account.password}`);
  }
}

service.httpServer.listen(port, () => {
  console.log(`订桌系统已启动：http://0.0.0.0:${port}`);
});
