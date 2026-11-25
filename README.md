# 瓦部赛事台 · 无畏契约 BP 工具

深圳技术大学电竞社瓦部赛事平台的 Ban / Pick 工具。两名玩家实时同步进行地图禁选，支持 BO1 / BO3 / BO5，掷骰决定先手。

**线上地址：https://valorant-bp-hg2g.onrender.com**

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
- `node guest.js <房间码> [队名] [赛制] [服务器WS地址]` — 模拟一个自动操作的对手

## 部署（已完成 · Render 免费版）

- 仓库：https://github.com/2720149155-sudo/valorant-bp
- 地址：https://valorant-bp-hg2g.onrender.com（新加坡区域，0.1 CPU / 512MB 免费档）
- Build：`npm install`，Start：`npm run start`
- 15 分钟无访问会休眠，首次打开约慢 30-60 秒；比赛前提前点开即可
- 更新代码：`git push` 到 main 分支，Render 自动重新部署
- 保持常驻（可选）：[UptimeRobot](https://uptimerobot.com/) 免费版每 5 分钟 GET `/api/health`
- 备选：阿里云学生券轻量服务器（国内速度更快、不休眠）

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
