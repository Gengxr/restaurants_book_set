# 老街坊劈柴院订桌系统

一套面向餐厅包间订桌的实时同步系统，包含员工/老板手机端、超级管理员 Web 后台、Node.js 后端、SQLite 数据库和 Android WebView 安装包工程。

## 功能概览

- 手机端 `/`：员工和老板登录后按角色显示订桌、取消、就餐中、备注、冲突、统计和员工管理能力。
- 管理端 `/admin`：超级管理员查看订桌、处理冲突、查看统计、管理账号。
- 实时同步：通过 Socket.IO 推送订桌、冲突和账号变更。
- 离线队列：手机端断网时保存本地操作，恢复网络后同步；版本冲突交给老板或超级管理员处理。
- 账号权限：
  - `employee`：订桌、取消、改为就餐中、备注。
  - `boss`：员工能力 + 员工账号创建、禁用、删除、重置密码 + 冲突处理 + 统计。
  - `super_admin`：全量账号管理、查看/修改已保存密码、全量订桌和统计。
- 数据持久化：SQLite WAL 模式，支持服务器定时备份。

## 技术栈

- 前端：原生 HTML/CSS/JavaScript、IndexedDB、Service Worker。
- 后端：Node.js ESM、Express、Socket.IO、`node:sqlite`、bcrypt。
- 数据库：SQLite。
- 部署：Node.js + systemd + Nginx + HTTPS 证书。
- APK：Android Java WebView，加载线上地址 `https://www.gxr123.cn/`。

## 目录结构

```text
.
├── index.html            # 手机端入口
├── app.js                # 手机端业务逻辑
├── admin.html            # 超级管理员入口
├── admin.js              # 超级管理员业务逻辑
├── db.js                 # 手机端 IndexedDB 缓存与离线队列
├── server/               # 后端接口、认证、数据库与备份脚本
├── tests/                # Node API 测试
├── android-apk/          # Android WebView APK 工程
├── icons/                # Web 图标
└── 部署文档.md            # 当前服务器部署说明
```

## 本地运行

项目使用 `node:sqlite`，建议使用 Node.js 24 或更高版本。

```bash
npm ci
npm start
```

默认访问：

- 手机端：`http://localhost:3000/`
- 超级管理员后台：`http://localhost:3000/admin`
- 健康检查：`http://localhost:3000/api/health`

可通过环境变量配置：

```bash
JWT_SECRET=replace-with-a-random-secret
DATABASE_PATH=./data/booking.sqlite
BACKUP_DIR=./backups
PORT=3000
```

## 测试

```bash
npm test
```

测试覆盖登录、用户权限、订桌同步、冲突生成、统计和备份能力。

## 账号与密码

首次初始化数据库时会自动生成 `admin` 和 `boss` 初始账号，密码只在部署终端输出一次。

当前版本不再强制首次登录修改密码。老板或超级管理员创建员工账号时必须主动设置密码；超级管理员后台可以查看和修改系统已保存的账号密码。旧版本中已经存在但未保存明文密码的账号，需要重新设置密码后才会显示。

## 部署

当前线上服务使用直部署方式：

- 线上地址：`https://www.gxr123.cn/`
- 管理后台：`https://www.gxr123.cn/admin`
- 应用目录：`/opt/booking-app`
- 进程管理：`systemd` 服务 `booking-app`
- 反向代理：Nginx
- 数据库：`/opt/booking-app/data/booking.sqlite`

更新发布通常执行：

```bash
cd /opt/booking-app
npm ci --omit=dev
systemctl restart booking-app
```

更完整的服务器命令和证书说明见 `部署文档.md`。

## Android APK

`android-apk/` 是正式 APK 的源码工程。APK 本身不内置业务代码和密码，启动后用 WebView 加载线上手机端：

```text
https://www.gxr123.cn/
```

因此服务器端更新业务功能后，手机端通常无需重新安装 APK；只有修改应用图标、包名、权限、原生 WebView 配置或加载域名时才需要重新打包。

构建 debug 包：

```bash
cd android-apk
gradle assembleDebug
```

构建正式包需要本地 `android-apk/signing.properties` 和 `android-apk/keystore/`，这些文件包含签名敏感信息，已被 `.gitignore` 排除。

## 安全说明

- 不要提交服务器 SSH 密码、证书私钥、release keystore、签名密码或数据库文件。
- `.env.example` 只提供环境变量示例，生产环境请使用强随机 `JWT_SECRET`。
- `release-apk/` 下的 APK 和签名说明文件不进入 Git 仓库。
