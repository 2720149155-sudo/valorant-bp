/* 端到端测试：模拟两名玩家完成 BO3 全流程 */
const WebSocket = require('ws');

const URL = 'ws://localhost:3000/ws';
let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  ✓', msg);
  else { failures++; console.error('  ✗ FAIL:', msg); }
};

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitState(ws, pred, label, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error(`timeout waiting: ${label}`));
    }, timeout);
    const handler = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'state' && pred(msg.state)) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msg.state);
      }
    };
    ws.on('message', handler);
  });
}

function send(ws, obj) { ws.send(JSON.stringify(obj)); }

(async () => {
  console.log('== 连接两名玩家 ==');
  const host = await connect();
  const guest = await connect();

  send(host, { type: 'create' });
  const s1 = await waitState(host, s => s.phase === 'waiting', 'host waiting');
  const code = s1.code;
  assert(/^[A-Z0-9]{5}$/.test(code), `房间码格式正确: ${code}`);

  send(guest, { type: 'join', code });
  const s2 = await waitState(guest, s => s.phase === 'setup', 'guest joined -> setup');
  assert(s2.players.B.connected === true, 'B 玩家已连接');

  console.log('== 设置名称和赛制 ==');
  send(host, { type: 'name', name: '电子队' });
  await waitState(host, s => s.players.A.name === '电子队', 'A 名称同步');
  send(guest, { type: 'name', name: '机械队' });
  send(host, { type: 'bo', bo: 'bo3' });
  const s3 = await waitState(host, s => s.bo === 'bo3' && s.players.B.name === '机械队', 'BO3 + 名称同步');
  assert(s3.bo === 'bo3', '赛制为 BO3（房主设置）');

  console.log('== 掷骰 ==');
  send(host, { type: 'startDice' });
  await waitState(host, s => s.phase === 'dice', '进入掷骰阶段');

  // 掷骰直到分出胜负（可能平局重掷）
  let bpState = null;
  for (let round = 0; round < 20 && !bpState; round++) {
    send(host, { type: 'roll' });
    send(guest, { type: 'roll' });
    const orderState = await waitState(host, s => s.phase === 'order', `掷骰分出胜负(第${round + 1}轮)`, 3000).catch(() => null);
    if (orderState) { bpState = orderState; break; }
    await new Promise(r => setTimeout(r, 300));
    const sNow = await new Promise((resolve) => {
      send(host, { type: 'name', name: '电子队' }); // 触发一次 state 广播
      const h = (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'state') { host.removeListener('message', h); resolve(m.state); }
      };
      host.on('message', h);
    });
    if (sNow.phase === 'order') { bpState = sNow; break; }
  }
  assert(bpState && bpState.phase === 'order', `掷骰完成，选择权: ${bpState ? bpState.diceWinner : '?'}`);
  assert(bpState && bpState.diceWinner, 'diceWinner 已确定');
  console.log(`   A骰=${bpState.players.A.dice} B骰=${bpState.players.B.dice} 胜方=${bpState.diceWinner}`);

  console.log('== 掷骰胜方选择 BP 顺序 ==');
  // 非胜方尝试选择应被拒绝
  const loser = bpState.diceWinner === 'A' ? 'B' : 'A';
  send(loser === 'A' ? host : guest, { type: 'order', role: 'A' });
  const sNoOrder = await waitState(host, st => st.phase === 'bp', '非胜方选顺序被拒（等待超时）', 1200).catch(() => null);
  assert(sNoOrder === null, '非胜方选择顺序被拒绝');
  // 胜方选择先禁先选（A）
  send(bpState.diceWinner === 'A' ? host : guest, { type: 'order', role: 'A' });
  bpState = await waitState(host, s => s.phase === 'bp', '胜方选择顺序进入 BP');

  console.log('== BP 流程（BO3: 禁禁选边选边禁禁+决胜图选边）==');
  const first = bpState.diceWinner;
  const second = first === 'A' ? 'B' : 'A';
  const mapIds = bpState.mapsMeta.map(m => m.id);
  assert(mapIds.length === 7, `地图池 7 张: ${mapIds.join(',')}`);

  const wsFor = { A: host, B: guest };
  let s = bpState;

  // 官方 BO3 流程: A禁 B禁 A选 B边 B选 A边 A禁 B禁 → 决胜图 + A边
  const pattern = [
    ['ban', first], ['ban', second],
    ['pick', first], ['side', second],
    ['pick', second], ['side', first],
    ['ban', first], ['ban', second],
    ['side', first, 'final'],
  ];

  let avail = [...mapIds];
  const picked = [];

  for (let i = 0; i < pattern.length; i++) {
    const [act, team, kind] = pattern[i];
    const wsA = wsFor[team];
    if (act === 'ban') {
      const mapId = avail[0];
      avail = avail.slice(1);
      send(wsA, { type: 'map', mapId });
      s = await waitState(host, st => st.stepIndex === i + 1, `步骤${i + 1} ${team} ban ${mapId}`);
      assert(s.maps[mapId].status === 'banned' && s.maps[mapId].by === team, `ban ${mapId} 正确`);
    } else if (act === 'pick') {
      const mapId = avail[0];
      avail = avail.slice(1);
      picked.push(mapId);
      send(wsA, { type: 'map', mapId });
      s = await waitState(host, st => st.stepIndex === i + 1, `步骤${i + 1} ${team} pick ${mapId}`);
      assert(s.maps[mapId].status === 'picked' && s.maps[mapId].order === picked.length, `pick ${mapId} order=${s.maps[mapId].order}`);
    } else if (kind === 'final') {
      // 决胜图选边
      const deciderId = avail[0];
      send(wsA, { type: 'side', side: 'defense' });
      s = await waitState(host, st => st.phase === 'done', '决胜图选边完成');
      assert(s.maps[deciderId].side === 'defense' && s.maps[deciderId].sideBy === team, `决胜图 ${deciderId} 选边正确`);
      assert(s.maps[deciderId].status === 'decider', '决胜图状态保留');
    } else {
      send(wsA, { type: 'side', side: 'attack' });
      s = await waitState(host, st => st.stepIndex === i + 1, `步骤${i + 1} ${team} side`);
      const target = picked[picked.length - 1];
      assert(s.maps[target].side === 'attack' && s.maps[target].sideBy === team, `side attack 应用于 ${target}`);
    }
  }

  assert(s.phase === 'done', 'BP 完成进入 done');
  assert(avail.length === 1, `剩余 1 张决胜图: ${avail[0]}`);
  assert(s.maps[avail[0]].status === 'decider', '剩余图为 decider');

  // 错误方操作应被拒绝
  console.log('== 安全性测试 ==');
  send(guest, { type: 'reset' });
  const sReset = await waitState(host, st => st.phase === 'setup', 'reset 回到设置');
  assert(sReset.phase === 'setup', 'reset 成功');

  // 非 turn 方 ban 应无效
  send(host, { type: 'startDice' });
  await waitState(host, st => st.phase === 'dice', '重新掷骰');
  // 重新掷骰到分出，胜方选顺序进入 BP
  let bp2 = null;
  for (let r = 0; r < 20 && !bp2; r++) {
    send(host, { type: 'roll' });
    send(guest, { type: 'roll' });
    const orderState = await waitState(host, st => st.phase === 'order', '第二次掷骰', 2500).catch(() => null);
    if (orderState) {
      send(orderState.diceWinner === 'A' ? host : guest, { type: 'order', role: 'B' });
      bp2 = await waitState(host, st => st.phase === 'bp', '第二次选顺序进入 BP');
      break;
    }
    await new Promise(res => setTimeout(res, 250));
    send(host, { type: 'name', name: '电子队' });
  }
  const step0 = bp2.steps[0];
  const wrongTeam = step0.team === 'A' ? 'B' : 'A';
  send(wsFor[wrongTeam], { type: 'map', mapId: mapIds[0] });
  const sNoChange = await waitState(host, st => true, '收到广播（或超时）', 800).catch(() => null);
  assert(sNoChange === null || sNoChange.stepIndex === 0, '非回合方操作被拒绝');
  assert(bp2.stepIndex === 0, 'stepIndex 仍为 0');

  console.log('');
  console.log(failures === 0 ? '✅ 全部测试通过' : `❌ ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('测试异常:', e.message); process.exit(1); });
