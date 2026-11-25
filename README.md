# 瓦部赛事台 · 无畏契约 BP 工具

深圳技术大学电竞社瓦部赛事平台的 Ban / Pick 工具。两名玩家实时同步进行地图禁选，支持 BO1 / BO3 / BO5，掷骰决定先手。

**线上地址：https://valorant-bp-hg2g.onrender.com**

## 功能

- **房间制**：房主创建房间、选赛制后生成邀请链接，对方输入队名确认即开始
- **掷骰获选择权**：双方各掷一次骰子，点数大者选择先禁先选（A）或后禁后选（B），平局自动重掷
- **三种赛制**（VCT 官方禁选流程）
  - BO1：双方交替各禁 3 张（六禁一剩），A 队为比赛地图选攻防
  - BO3：禁禁选边选边禁禁，剩余决胜图由 A 队选攻防
  - BO5：禁禁 + 四选四边，剩余决胜图由 B 队选攻防
- **阵营选择**：每张选图由非选图方决定进攻/防守开局，决胜图按规则归属选边
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

## BP 规则说明（VCT 官方禁选流程）

掷骰点数大者获得选择权：先 Ban（A 队）或后 Ban（B 队）。

| 赛制 | 流程 | 图数 |
|------|------|------|
| BO1 | A禁 B禁 A禁 B禁 A禁 B禁 → 剩余为比赛地图 → A队选攻防 | 1 |
| BO3 | A禁 B禁 → A选图1 B选边 → B选图2 A选边 → A禁 B禁 → 决胜图 → A队选边 | 3 |
| BO5 | A禁 B禁 → A选图1 B选边 → B选图2 A选边 → A选图3 B选边 → B选图4 A选边 → 决胜图 → B队选边 | 5 |

（A = 先禁先选方；每张选图的攻防由非选图方决定；决胜图选边按上表归属）
