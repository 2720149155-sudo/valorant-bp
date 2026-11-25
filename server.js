const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

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
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;

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
  } else if (bo === 'bo5') {
    push('ban', first); push('ban', second);
    push('pick', first); push('side', second);
    push('pick', second); push('side', first);
    push('pick', first); push('side', second);
    push('pick', second); push('side', first);
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
  };
}

function publicState(room) {
  return {
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
  };
}

function broadcast(room) {
  const msg = JSON.stringify({ type: 'state', state: publicState(room) });
  for (const t of ['A', 'B']) {
    const p = room.players[t];
    if (p.socket && p.socket.readyState === 1) p.socket.send(msg);
  }
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
    room.maps[id] = { status: room.bo === 'bo1' ? 'match' : 'decider' };
  }
  room.phase = 'done';
}

function handleMsg(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  const room = ws.__room;
  const team = ws.__team;

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
    if (!r) return ws.send(JSON.stringify({ type: 'error', message: '房间不存在，请检查房间码' }));
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
    ws.send(JSON.stringify({ type: 'error', message: '房间已满' }));
    return;
  }

  if (!room || !team) return;
  const p = room.players[team];

  switch (msg.type) {
    case 'name':
      p.name = String(msg.name || '').slice(0, 20).trim();
      broadcast(room);
      break;

    case 'bo': {
      if (room.phase !== 'setup') return;
      const v = String(msg.bo || '');
      if (['bo1', 'bo3', 'bo5'].includes(v)) room.bo = v;
      broadcast(room);
      break;
    }

    case 'startDice': {
      if (room.phase !== 'setup' || !room.bo) return;
      room.phase = 'dice';
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
          room.phase = 'bp';
          room.steps = buildSteps(room.bo, room.diceWinner);
          room.stepIndex = 0;
        }
      }
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
      const m = room.maps[target];
      m.side = side;
      m.sideBy = team;
      room.stepIndex += 1;
      if (room.stepIndex >= room.steps.length) finalize(room);
      broadcast(room);
      break;
    }

    case 'reset': {
      if (room.phase === 'waiting') return;
      room.phase = 'setup';
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
      const p = ws.__room.players[ws.__team];
      if (p.socket === ws) { p.socket = null; p.connected = false; broadcast(ws.__room); }
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, r] of ROOMS) {
    if (now - r.createdAt > ROOM_TTL_MS && !r.players.A.connected && !r.players.B.connected) {
      ROOMS.delete(code);
    }
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Valorant BP server running at http://localhost:${PORT}`);
});
