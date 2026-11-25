# 瓦部赛事台 · 无畏契约 BP 工具

深圳技术大学电竞社瓦部赛事平台的 Ban / Pick 工具。两名玩家实时同步进行地图禁选，支持 BO1 / BO3 / BO5，掷骰决定先手。

## 功能

- **房间制**：一方创建房间生成 5 位房间码，另一方通过链接或房间码加入
- **掷骰定先手**：双方各掷一次骰子，点数大者先手（平局自动重掷）
- **三种赛制**
  - BO1：双方交替各禁 3 张（六禁一剩），剩余为比赛地图，掷骰胜方选起始阵营
  - BO3：禁-禁-选-方-选-方-禁-禁，剩余为决胜图（VCT 标准格式）
  - BO5：禁-禁-选-方-选-方-选-方-选-方，剩余为决胜图
- **阵营选择**：每张选图由非选图方决定进攻/防守开局
- **实时同步**：WebSocket 双端同步，断线自动重连，刷新页面不掉房间
- **地图池**：当前竞技图池 7 张（Bind/Haven/Lotus/Sunset/Abyss/Corrode/Summit）

## 本地运行

```bash
npm install
npm start
# 打开 http://localhost:3000
```

本地测试（可选）：
- `node test.js` — 自动化端到端测试（需先启动服务器）
- `node guest.js <房间码> [队名] [赛制]` — 模拟一个自动操作的对手

## 部署（免费方案）

### 方案 A：Claw Cloud Run（推荐，国内访问快）

每月免费额度足够个人赛事使用，无休眠。

1. 注册 [Claw Cloud Run](https://run.claw.cloud/)（需 GitHub 账号注册满 180 天）
2. App Launchpad → 创建应用
3. 镜像：`node:24-alpine`，启动命令：`sh -c "npm install --omit=dev && node server.js"`
   （或本地构建镜像推送）
4. 端口填 `3000`，开启公网访问

### 方案 B：Render（国际平台）

1. 把项目推到 GitHub 仓库
2. [Render](https://render.com/) → New → Web Service，连接仓库
3. Build: `npm install`，Start: `npm start`
4. 免费版 15 分钟无访问会休眠，冷启动约 30-60 秒

### 方案 C：任意 VPS / 服务器

```bash
npm install
PORT=8080 node server.js
```
配合 nginx 反代或直接开放端口即可。数据在内存中，重启后房间清空（BP 进行中请勿重启）。

## 项目结构

```
server.js          # Express + WebSocket 服务端（房间管理/BP状态机）
public/
  index.html       # 页面结构
  style.css        # 设计系统（浅色蓝白赛事风）
  app.js           # 客户端逻辑（连接/渲染/交互）
  maps/            # 7 张地图卡图与全图 (webp)
test.js            # 自动化测试
guest.js           # 自动对手模拟器
```

## BP 规则说明

| 赛制 | 流程 | 图数 |
|------|------|------|
| BO1 | A禁 B禁 A禁 B禁 A禁 B禁 → 剩余图 + 掷骰胜方选边 | 1 |
| BO3 | A禁 B禁 A选 B方 B选 A方 A禁 B禁 → 剩余决胜 | 3 |
| BO5 | A禁 B禁 A选 B方 B选 A方 A选 B方 B选 A方 → 剩余决胜 | 5 |

（A = 掷骰胜方；"X方" 表示非选图方选择该图开局阵营）
