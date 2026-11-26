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
- **房间持久化**：房间状态落盘到 `data/rooms.json`（每次状态变化即保存），进程崩溃/休眠唤醒后重启仍可恢复；房间有效期 24 小时，房间顶部显示剩余时间
- **观战模式**：第三人打开已满房间时可进入观战，只看不操作，不占 A/B 席位
- **防误触**：Ban/Pick 前二次确认，确认后 5 秒内可撤销最近一步
- **赛果复制**：结果页一键复制可直接发群的赛果文字
- **地图池预览**：首页与赛前确认页展示 7 张地图（缩略图 + 中英文名 + 点位）
- **最近房间**：首页记录最近创建/加入过的房间（最多 8 条），点击直接重进，可一键清空
- **地图池**：当前竞技图池 7 张（Bind/Haven/Lotus/Sunset/Abyss/Corrode/Summit）

## 本地运行

```bash
npm install
npm start
# 打开 http://localhost:3000
```

本地测试（可选）：
- `node test.js` — 自动化端到端测试（需先启动服务器）：BO3 全流程 + 安全性
- `node test-extra.js` — 扩展测试（自带服务器，端口 3101）：错误码 / 观战 / 撤销 / 重连恢复 / 持久化重启 / guest.js 模拟 BO1 与 BO3 完整对局 / 赛果文案与倒计时纯函数
- `node guest.js <房间码> [队名] [赛制] [服务器WS地址]` — 模拟一个自动操作的对手
- `node guest.js <房间码> --spectate [服务器WS地址]` — 以观战者身份加入房间（只看不操作）

## 房间持久化说明

房间状态保存在 `data/rooms.json`（已加入 `.gitignore`，不进仓库）。每次房间状态变化即落盘，服务重启时自动恢复未过期的房间，保留创建时间和 24 小时有效期。

**注意：Render 免费版的磁盘是临时盘（ephemeral disk），重新部署或服务迁移后 `data/rooms.json` 会丢失。** 持久化防的是进程崩溃、休眠唤醒丢房，不是 redeploy。如需 redeploy 也不丢房，需接外部存储（如 Render 免费 PostgreSQL / Redis）。

## 部署（已完成 · Render 免费版）

- 仓库：https://github.com/2720149155-sudo/valorant-bp
- 地址：https://valorant-bp-hg2g.onrender.com（新加坡区域，0.1 CPU / 512MB 免费档）
- Build：`npm install`，Start：`npm run start`
- 15 分钟无访问会休眠——已配置 UptimeRobot 免费版每 5 分钟自动 ping，服务常驻
- 更新代码：`git push` 到 main 分支，Render 自动重新部署
- 保活监控：https://dashboard.uptimerobot.com （GitHub 登录 2720149155-sudo）
- 备选：阿里云学生券轻量服务器（国内速度更快、不休眠）

## 项目结构

```
server.js          # Express + WebSocket 服务端（房间管理/BP状态机/持久化/观战/撤销）
public/
  index.html       # 页面结构
  style.css        # 设计系统（Valorant 深色 + 红）
  app.js           # 客户端逻辑（连接/渲染/交互/最近房间/赛果复制）
  maps/            # 7 张地图卡图与全图 (webp)
test.js            # 自动化测试（BO3 全流程）
test-extra.js      # 扩展测试（错误码/观战/撤销/重连/持久化/guest 对局/纯函数）
guest.js           # 自动对手模拟器（支持 --spectate 观战模式）
data/rooms.json    # 房间落盘文件（运行时生成，不进仓库）
```

## BP 规则说明（VCT 官方禁选流程）

掷骰决定谁先选：点数大者选择先 Ban（A 队）或后 Ban（B 队）。选定身份后，Ban / Pick 顺序按固定流程走，不再改变。

选 A：先 Ban、选图一、决胜图选边；选 B：后 Ban、图一选边、选图二。选图者不选边。正式比赛以瓦部秩序册为准。

| 赛制 | 流程 | 图数 |
|------|------|------|
| BO1 | A禁 B禁 A禁 B禁 A禁 B禁 → 剩余为比赛地图 → A队选攻防 | 1 |
| BO3 | A禁 B禁 → A选图1 B选边 → B选图2 A选边 → A禁 B禁 → 决胜图 → A队选边 | 3 |
| BO5 | A禁 B禁 → A选图1 B选边 → B选图2 A选边 → A选图3 B选边 → B选图4 A选边 → 决胜图 → B队选边 | 5 |

（A = 先禁先选方；每张选图的攻防由非选图方决定；决胜图选边按上表归属）
