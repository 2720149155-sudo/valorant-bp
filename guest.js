/* 自动对手模拟器：加入指定房间并自动完成所有回合 */
const WebSocket = require('ws');
const readline = require('readline');

const code = process.argv[2];
const name = process.argv[3] || '机械队';
const bo = process.argv[4] || 'bo3';

if (!code) { console.error('用法: node guest.js <房间码> [队名] [赛制]'); process.exit(1); }

const ws = new WebSocket('ws://localhost:3000/ws');
let myTeam = null;

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'join', code: code.toUpperCase() }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'joined') {
    myTeam = msg.team;
    console.log(`[guest] 已加入房间 ${msg.code}，身份 ${msg.team}`);
    ws.send(JSON.stringify({ type: 'name', name }));
    ws.send(JSON.stringify({ type: 'bo', bo }));
  }
  if (msg.type === 'state') onState(msg.state);
});

ws.on('close', () => { console.log('[guest] 断开'); process.exit(0); });

let lastIdx = -1;
function onState(s) {
  const me = s.players[myTeam];
  if (s.phase === 'dice' && !me.rolled) {
    setTimeout(() => {
      console.log('[guest] 掷骰');
      ws.send(JSON.stringify({ type: 'roll' }));
    }, 600);
  }
  if (s.phase === 'bp' && s.stepIndex !== lastIdx) {
    lastIdx = s.stepIndex;
    const step = s.steps[s.stepIndex];
    if (!step) return;
    if (step.team !== myTeam) return;
    setTimeout(() => {
      if (step.type === 'side') {
        const side = Math.random() < 0.5 ? 'attack' : 'defense';
        console.log(`[guest] 选阵营: ${side}`);
        ws.send(JSON.stringify({ type: 'side', side }));
      } else {
        const avail = s.mapsMeta.filter(m => s.maps[m.id].status === 'available');
        const pick = avail[Math.floor(Math.random() * avail.length)];
        console.log(`[guest] ${step.type === 'ban' ? '禁' : '选'}: ${pick.zh}`);
        ws.send(JSON.stringify({ type: 'map', mapId: pick.id }));
      }
    }, 800);
  }
  if (s.phase === 'done' && lastIdx !== -2) {
    lastIdx = -2;
    console.log('[guest] BP 完成 ✓');
  }
}
