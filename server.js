const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// 房间状态落盘位置（测试可用 BP_DATA_FILE 环境变量覆盖）。
// 注意：Render 免费版的磁盘是临时盘（ephemeral disk），重新部署/服务迁移后
// data/rooms.json 会丢失。落盘防的是进程崩溃、休眠唤醒丢房，不是 redeploy。
const DATA_FILE = process.env.BP_DATA_FILE || path.join(__dirname, 'data', 'rooms.json');
const UNDO_WINDOW_MS = 5000;

const MAPS = [
  { id: 'bind', en: 'Bind', zh: '源工重镇', sites: 'A/B' },
  { id: 'haven', en: 'Haven', zh: '隐世修所', sites: 'A/B/C' },
  { id: 'lotus', en: 'Lotus', zh: '莲华古城', sites: 'A/B/C' },
  { id: 'sunset', en: 'Sunset', zh: '日落之城', sites: 'A/B' },
  { id: 'abyss', en: 'Abyss', zh: '幽邃地窟', sites: 'A/B' },
  { id: 'corrode', en: 'Corrode', zh: '盐海矿镇', sites: 'A/B' },
  { id: 'summit', en: 'Summit', zh: '天枢云阙', sites: 'A/B' },
];

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/health', (req, res) => res.json({ ok: true, rooms: ROOMS.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const ROOMS = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// 与首页文案一致：房间有效期 24 小时
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

/* ---------- 房间持久化（JSON 落盘） ---------- */

// 序列化：只存纯数据，socket / 观战者集合不落盘；重连时 connected 复位为 false
function serializeRoom(r) {
  return {
    code: r.code,
    createdAt: r.createdAt,
    bo: r.bo,
    phase: r.phase,
    diceWinner: r.diceWinner,
    diceRound: r.diceRound,
    steps: r.steps,
    stepIndex: r.stepIndex,
    maps: r.maps,
    pickCount: r.pickCount,
    players: {
      A: { name: r.players.A.name, dice: r.players.A.dice, rolled: r.players.A.rolled, token: r.players.A.token },
      B: { name: r.players.B.name, dice: r.players.B.dice, rolled: r.players.B.rolled, token: r.players.B.token },
    },
  };
}

function saveRooms() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const data = [...ROOMS.values()].map(serializeRoom);
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[persist] 保存房间失败:', e.message);
  }
}

function loadRooms() {
  let raw;
  try {
    raw = fs.readFileSync(DATA_FILE, 'utf8');
  } catch {
    return; // 首次启动尚无落盘文件，正常
  }
  let list;
  try {
    list = JSON.parse(raw);
  } catch (e) {
    console.error('[persist] rooms.json 损坏，跳过恢复:', e.message);
    return;
  }
  if (!Array.isArray(list)) return;
  const now = Date.now();
  let restored = 0;
  for (const d of list) {
    if (!d || !d.code || typeof d.createdAt !== 'number') continue;
    if (now - d.createdAt > ROOM_TTL_MS) continue; // 已过期的房间不恢复
    const r = newRoom(d.code);
    r.createdAt = d.createdAt;
    r.bo = d.bo || null;
    r.phase = d.phase || 'waiting';
    r.diceWinner = d.diceWinner || null;
    r.diceRound = d.diceRound || 1;
    r.steps = Array.isArray(d.steps) ? d.steps : [];
    r.stepIndex = d.stepIndex || 0;
    r.maps = d.maps || r.maps;
    r.pickCount = d.pickCount || 0;
    for (const t of ['A', 'B']) {
      const pd = d.players && d.players[t];
      if (pd) {
        r.players[t].name = pd.name || '';
        r.players[t].dice = pd.dice ?? null;
        r.players[t].rolled = !!pd.rolled;
        r.players[t].token = pd.token || null;
      }
      r.players[t].connected = false;
      r.players[t].socket = null;
    }
    ROOMS.set(r.code, r);
    restored++;
  }
  if (restored) console.log(`[persist] 已恢复 ${restored} 个房间（来自 ${DATA_FILE}）`);
}

function isExpired(room) {
  return Date.now() - room.createdAt > ROOM_TTL_MS;
}

function genCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (ROOMS.has(code));
  return code;
}

function other(team) {
  return team === 'A' ? 'B' : 'A';
}

function buildSteps(bo, first) {
  const second = other(first);
  const steps = [];
  const push = (type, team) => steps.push({ type, team });
  if (bo === 'bo1') {
    ['ban', 'ban', 'ban', 'ban', 'ban', 'ban'].forEach((_, i) => push('ban', i % 2 === 0 ? first : second));
    push('side', first);
  } else if (bo === 'bo3') {
    push('ban', first); push('ban', second);
    push('pick', first); push('side', second);
    push('pick', second); push('side', first);
    push('ban', first); push('ban', second);
    push('side', first);
  } else if (bo === 'bo5') {
    push('ban', first); push('ban', second);
    push('pick', first); push('side', second);
    push('pick', second); push('side', first);
    push('pick', first); push('side', second);
    push('pick', second); push('side', first);
    push('side', second);
  }
  return steps;
}

function newRoom(code) {
  const maps = {};
  for (const m of MAPS) maps[m.id] = { status: 'available' };
  return {
    code,
    createdAt: Date.now(),
    players: {
      A: { name: '', dice: null, rolled: false, connected: false, token: null, socket: null },
      B: { name: '', dice: null, rolled: false, connected: false, token: null, socket: null },
    },
    bo: null,
    phase: 'waiting',
    diceWinner: null,
    diceRound: 1,
    steps: [],
    stepIndex: 0,
    maps,
    pickCount: 0,
    spectators: new Set(), // 观战者 socket 集合（不落盘）
    lastAction: null, // 最近一步快照，用于 5 秒内撤销 {type, team, at, prev, afterStepIndex, afterPhase}
  };
}

function publicState(room) {
  const state = {
    code: room.code,
    phase: room.phase,
    bo: room.bo,
    diceWinner: room.diceWinner,
    diceRound: room.diceRound,
    players: {
      A: { name: room.players.A.name, dice: room.players.A.dice, rolled: room.players.A.rolled, connected: room.players.A.connected },
      B: { name: room.players.B.name, dice: room.players.B.dice, rolled: room.players.B.rolled, connected: room.players.B.connected },
    },
    steps: room.steps,
    stepIndex: room.stepIndex,
    maps: room.maps,
    mapsMeta: MAPS,
    expiresAt: room.createdAt + ROOM_TTL_MS,
    spectators: room.spectators.size,
  };
  // 撤销窗口信息（仅当最近一步仍在 5 秒窗口内时下发）
  if (room.lastAction && Date.now() - room.lastAction.at < UNDO_WINDOW_MS) {
    state.undo = { by: room.lastAction.team, until: room.lastAction.at + UNDO_WINDOW_MS };
  }
  return state;
}

function broadcast(room) {
  const msg = JSON.stringify({ type: 'state', state: publicState(room) });
  for (const t of ['A', 'B']) {
    const p = room.players[t];
    if (p.socket && p.socket.readyState === 1) p.socket.send(msg);
  }
  for (const s of room.spectators) {
    if (s.readyState === 1) s.send(msg);
  }
  saveRooms(); // 每次状态变化即落盘
}

function sideTarget(room) {
  const pickedNoSide = Object.entries(room.maps).filter(([, m]) => m.status === 'picked' && !m.side);
  if (pickedNoSide.length) return pickedNoSide[pickedNoSide.length - 1][0];
  const avail = Object.entries(room.maps).filter(([, m]) => m.status === 'available');
  if (avail.length === 1) return avail[0][0];
  return null;
}

function finalize(room) {
  const avail = Object.entries(room.maps).filter(([, m]) => m.status === 'available');
  for (const [id] of avail) {
    room.maps[id].status = room.bo === 'bo1' ? 'match' : 'decider';
  }
  room.phase = 'done';
}

function handleMsg(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  const room = ws.__room;
  const team = ws.__team;

  // 撤销支持：记录一步操作前的完整快照（地图状态/stepIndex/pickCount/phase）
  function snapshotLastAction(type) {
    room.lastAction = {
      type,
      team,
      at: Date.now(),
      prev: {
        maps: JSON.parse(JSON.stringify(room.maps)),
        stepIndex: room.stepIndex,
        pickCount: room.pickCount,
        phase: room.phase,
      },
      afterStepIndex: null,
      afterPhase: null,
    };
  }

  if (msg.type === 'create') {
    if (room) return;
    const code = genCode();
    const r = newRoom(code);
    ROOMS.set(code, r);
    const token = crypto.randomBytes(16).toString('hex');
    r.players.A.token = token;
    r.players.A.socket = ws;
    r.players.A.connected = true;
    ws.__room = r; ws.__team = 'A';
    ws.send(JSON.stringify({ type: 'joined', code, team: 'A', token }));
    broadcast(r);
    return;
  }

  if (msg.type === 'join') {
    if (room) return;
    const r = ROOMS.get(String(msg.code || '').toUpperCase());
    if (!r) return ws.send(JSON.stringify({ type: 'error', code: 'room_not_found', message: '房间不存在，请检查房间码' }));
    if (isExpired(r) && !r.players.A.connected && !r.players.B.connected) {
      ROOMS.delete(r.code);
      saveRooms();
      return ws.send(JSON.stringify({ type: 'error', code: 'room_expired', message: '房间已过期（有效期 24 小时），请重新创建房间' }));
    }
    const token = msg.token;
    for (const t of ['A', 'B']) {
      if (r.players[t].token && r.players[t].token === token) {
        r.players[t].socket = ws;
        r.players[t].connected = true;
        ws.__room = r; ws.__team = t;
        ws.send(JSON.stringify({ type: 'joined', code: r.code, team: t, token }));
        broadcast(r);
        return;
      }
    }
    const b = r.players.B;
    if (!b.token || !b.connected) {
      const newToken = crypto.randomBytes(16).toString('hex');
      b.token = newToken;
      b.socket = ws;
      b.connected = true;
      b.name = b.name || '';
      ws.__room = r; ws.__team = 'B';
      ws.send(JSON.stringify({ type: 'joined', code: r.code, team: 'B', token: newToken }));
      if (r.phase === 'waiting') r.phase = 'setup';
      broadcast(r);
      return;
    }
    ws.send(JSON.stringify({ type: 'error', code: 'room_full', message: '房间已满，A、B 两队均已就位' }));
    return;
  }

  // 观战加入：不占 A/B 席位，只收 state 广播，不能发任何游戏操作
  if (msg.type === 'spectate') {
    if (room) return;
    const r = ROOMS.get(String(msg.code || '').toUpperCase());
    if (!r) return ws.send(JSON.stringify({ type: 'error', code: 'room_not_found', message: '房间不存在，请检查房间码' }));
    if (isExpired(r) && !r.players.A.connected && !r.players.B.connected) {
      ROOMS.delete(r.code);
      saveRooms();
      return ws.send(JSON.stringify({ type: 'error', code: 'room_expired', message: '房间已过期（有效期 24 小时），请重新创建房间' }));
    }
    r.spectators.add(ws);
    ws.__room = r; ws.__team = 'S'; ws.__spectator = true;
    ws.send(JSON.stringify({ type: 'joined', code: r.code, team: 'S', token: null }));
    broadcast(r);
    return;
  }

  if (!room || !team) return;
  if (ws.__spectator) return; // 观战者禁止一切游戏操作
  const p = room.players[team];

  switch (msg.type) {
    case 'name':
      p.name = String(msg.name || '').slice(0, 20).trim();
      broadcast(room);
      break;

    case 'bo': {
      if (team !== 'A') return;
      if (room.phase !== 'waiting' && room.phase !== 'setup') return;
      const v = String(msg.bo || '');
      if (['bo1', 'bo3', 'bo5'].includes(v)) room.bo = v;
      broadcast(room);
      break;
    }

    case 'startDice': {
      if (room.phase !== 'setup' || !room.bo) return;
      room.phase = 'dice';
      room.lastAction = null;
      room.diceWinner = null;
      room.diceRound = 1;
      room.players.A.dice = null; room.players.A.rolled = false;
      room.players.B.dice = null; room.players.B.rolled = false;
      broadcast(room);
      break;
    }

    case 'roll': {
      if (room.phase !== 'dice' || p.rolled) return;
      p.dice = 1 + Math.floor(Math.random() * 6);
      p.rolled = true;
      const a = room.players.A, b = room.players.B;
      if (a.rolled && b.rolled) {
        if (a.dice === b.dice) {
          room.diceRound += 1;
          a.rolled = false; b.rolled = false;
          a.dice = null; b.dice = null;
        } else {
          room.diceWinner = a.dice > b.dice ? 'A' : 'B';
          room.phase = 'order';
        }
      }
      broadcast(room);
      break;
    }

    case 'order': {
      if (room.phase !== 'order' || team !== room.diceWinner) return;
      const first = msg.role === 'B' ? other(room.diceWinner) : room.diceWinner;
      room.steps = buildSteps(room.bo, first);
      room.stepIndex = 0;
      room.phase = 'bp';
      room.lastAction = null;
      broadcast(room);
      break;
    }

    case 'map': {
      if (room.phase !== 'bp') return;
      const step = room.steps[room.stepIndex];
      if (!step || step.team !== team) return;
      if (step.type !== 'ban' && step.type !== 'pick') return;
      const mapId = String(msg.mapId || '');
      const m = room.maps[mapId];
      if (!m || m.status !== 'available') return;
      snapshotLastAction('map');
      if (step.type === 'ban') {
        m.status = 'banned';
        m.by = team;
      } else {
        m.status = 'picked';
        m.by = team;
        m.order = ++room.pickCount;
        m.side = null;
      }
      room.stepIndex += 1;
      if (room.stepIndex >= room.steps.length) finalize(room);
      room.lastAction.afterStepIndex = room.stepIndex;
      room.lastAction.afterPhase = room.phase;
      broadcast(room);
      break;
    }

    case 'side': {
      if (room.phase !== 'bp') return;
      const step = room.steps[room.stepIndex];
      if (!step || step.type !== 'side' || step.team !== team) return;
      const side = msg.side === 'attack' ? 'attack' : 'defense';
      const target = sideTarget(room);
      if (!target) return;
      snapshotLastAction('side');
      const m = room.maps[target];
      m.side = side;
      m.sideBy = team;
      room.stepIndex += 1;
      if (room.stepIndex >= room.steps.length) finalize(room);
      room.lastAction.afterStepIndex = room.stepIndex;
      room.lastAction.afterPhase = room.phase;
      broadcast(room);
      break;
    }

    case 'undo': {
      // 5 秒内撤销最近一步：仅操作方本人、且此后无人操作过（stepIndex/phase 未变）
      const la = room.lastAction;
      if (!la || la.team !== team) return;
      if (Date.now() - la.at > UNDO_WINDOW_MS) return;
      if (room.stepIndex !== la.afterStepIndex || room.phase !== la.afterPhase) return;
      room.maps = JSON.parse(JSON.stringify(la.prev.maps));
      room.stepIndex = la.prev.stepIndex;
      room.pickCount = la.prev.pickCount;
      room.phase = la.prev.phase;
      room.lastAction = null; // 一次撤销机会，用完即止
      broadcast(room);
      break;
    }

    case 'reset': {
      if (room.phase === 'waiting') return;
      room.phase = 'setup';
      room.lastAction = null;
      room.diceWinner = null;
      room.diceRound = 1;
      room.steps = [];
      room.stepIndex = 0;
      room.pickCount = 0;
      for (const m of MAPS) room.maps[m.id] = { status: 'available' };
      room.players.A.dice = null; room.players.A.rolled = false;
      room.players.B.dice = null; room.players.B.rolled = false;
      broadcast(room);
      break;
    }
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (data) => handleMsg(ws, data.toString()));
  ws.on('close', () => {
    if (ws.__room && ws.__team) {
      if (ws.__spectator) {
        ws.__room.spectators.delete(ws);
        broadcast(ws.__room);
        return;
      }
      const p = ws.__room.players[ws.__team];
      if (p.socket === ws) { p.socket = null; p.connected = false; broadcast(ws.__room); }
    }
  });
});

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [code, r] of ROOMS) {
    if (now - r.createdAt > ROOM_TTL_MS && !r.players.A.connected && !r.players.B.connected) {
      ROOMS.delete(code);
      changed = true;
    }
  }
  if (changed) saveRooms();
}, 10 * 60 * 1000);

loadRooms(); // 启动时从 data/rooms.json 恢复房间

server.listen(PORT, () => {
  console.log(`Valorant BP server running at http://localhost:${PORT}`);
});
