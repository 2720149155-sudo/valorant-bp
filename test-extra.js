/* 扩展端到端测试：错误码 / 观战 / 撤销 / 重连恢复 / 持久化重启 / guest.js 完整对局 / 纯函数 */
/* 自带服务器（端口 3101，落盘文件 /tmp/bp-test-rooms.json），跑完自动清理 */
const WebSocket = require('ws');
const { spawn, execSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 3101;
const URL = `ws://localhost:${PORT}/ws`;
const DATA_FILE = '/tmp/bp-test-rooms.json';
let failures = 0;
const assert = (cond, msg) => {
if (cond) console.log(' ✓', msg);
else { failures++; console.error(' ✗ FAIL:', msg);}
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function connect() {
return new Promise((resolve, reject) => {
const ws = new WebSocket(URL);
ws.on('open', () => resolve(ws));
ws.on('error', reject);
// 记录 joined 下发的 token，供重连/重启恢复测试使用；同时缓存最新 state，
// 让 waitState 能命中“已经到达过的”状态，避免广播先到、监听后挂的竞态
ws.on('message', (raw) => {
try {
const m = JSON.parse(raw.toString());
if (m.type === 'joined' && m.token) ws.__token = m.token;
if (m.type === 'state') ws.__lastState = m.state;
} catch {}
});
});
}

function waitFor(ws, pred, label, timeout = 6000) {
// 先查缓存：目标消息可能在监听挂上之前就已到达
if (ws.__lastState && pred({ type: 'state', state: ws.__lastState })) {
return Promise.resolve({ type: 'state', state: ws.__lastState });
}
return new Promise((resolve, reject) => {
const timer = setTimeout(() => {
ws.removeListener('message', handler);
reject(new Error(`timeout waiting: ${label}`));
}, timeout);
const handler = (raw) => {
let msg;
try { msg = JSON.parse(raw.toString());} catch { return;}
if (pred(msg)) {
clearTimeout(timer);
ws.removeListener('message', handler);
resolve(msg);
}
};
ws.on('message', handler);
});
}
const waitState = (ws, pred, label, timeout) => waitFor(ws, m => m.type === 'state' && pred(m.state), label, timeout).then(m => m.state);
const waitError = (ws, label, timeout) => waitFor(ws, m => m.type === 'error', label, timeout).then(m => m);
function send(ws, obj) { ws.send(JSON.stringify(obj));}

let serverProc = null;
function startServer() {
return new Promise((resolve, reject) => {
serverProc = spawn('node', ['server.js'], {
cwd: __dirname,
env: {...process.env, PORT: String(PORT), BP_DATA_FILE: DATA_FILE},
stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
const serverLog = fs.createWriteStream('/tmp/bp-test-server.log', { flags: 'a' });
serverProc.stdout.on('data', d => { out += d; serverLog.write('[out] ' + d);});
serverProc.stderr.on('data', d => { out += d; serverLog.write('[err] ' + d);});
serverProc.on('exit', (code, sig) => { serverLog.write('[exit] code=' + code + ' sig=' + sig + '\n'); });
const check = setInterval(async () => {
try {
await new Promise((res, rej) => {
const ws = new WebSocket(URL);
ws.on('open', () => { ws.close(); res();});
ws.on('error', rej);
});
clearInterval(check);
resolve();
} catch { /* 未就绪继续等 */}
}, 200);
setTimeout(() => { clearInterval(check); reject(new Error('server 启动超时: ' + out));}, 8000);
});
}
function stopServer() {
return new Promise((resolve) => {
// 关键：用局部变量锁住要停的进程；定时器只杀这个进程，且退出时清除定时器。
// 否则定时器醒来时会误杀 stopServer 之后新启动的服务（曾导致 F 节对局中服务端被 SIGKILL）。
const proc = serverProc;
if (!proc) return resolve();
serverProc = null;
let done = false;
let timer;
const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
proc.on('exit', finish);
proc.kill('SIGTERM');
timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} finish(); }, 3000);
});
}

// 用 guest.js 模拟对手打满一局（房主驱动己方回合）
async function playFullGameWithGuest(bo) {
const host = await connect();
send(host, { type: 'create'});
const s1 = await waitState(host, s => s.phase === 'waiting', '建房');
const code = s1.code;
const guest = spawn('node', ['guest.js', code, '机械队', bo, `ws://localhost:${PORT}`], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe']});
let guestOut = '';
guest.stdout.on('data', d => { guestOut += d;});
guest.stderr.on('data', d => { guestOut += d;});

const done = new Promise((resolve, reject) => {
const timer = setTimeout(() => reject(new Error(`BO ${bo} 对局超时`)), 90000);
host.on('message', (raw) => {
let msg;
try { msg = JSON.parse(raw.toString());} catch { return;}
if (msg.type!== 'state') return;
const s = msg.state;
if (s.phase === 'dice' &&!s.players.A.rolled) {
setTimeout(() => send(host, { type: 'roll'}), 200);
} else if (s.phase === 'order' && s.diceWinner === 'A') {
setTimeout(() => send(host, { type: 'order', role: 'A'}), 200);
} else if (s.phase === 'bp') {
const step = s.steps[s.stepIndex];
if (step && step.team === 'A') {
setTimeout(() => {
if (step.type === 'side') send(host, { type: 'side', side: 'attack'});
else {
const avail = s.mapsMeta.find(m => s.maps[m.id].status === 'available');
send(host, { type: 'map', mapId: avail.id});
}
}, 300);
}
} else if (s.phase === 'done') {
clearTimeout(timer);
resolve(s);
}
});
});

send(host, { type: 'name', name: '电子队'});
// 等 guest 加入（phase 变 setup）后再定赛制开局
await waitState(host, s => s.phase === 'setup', 'guest 加入');
send(host, { type: 'bo', bo});
await waitState(host, s => s.bo === bo, '赛制设定');
send(host, { type: 'startDice'});

const final = await done;
// guest 收到 done 状态后才会打印“BP 完成”，等它最多 3 秒再结束进程，避免竞态误判
const t0 = Date.now();
while (!guestOut.includes('BP 完成') && Date.now() - t0 < 3000) await sleep(200);
host.close();
guest.kill('SIGTERM');
await sleep(300);
return { final, guestOut};
}

(async () => {
try { fs.unlinkSync(DATA_FILE);} catch {}
await startServer();
console.log('== 服务器已启动（端口 3101，落盘 /tmp/bp-test-rooms.json）==');

/* ---------- A. 错误码 ---------- */
console.log('== A. 错误码 ==');
const stranger = await connect();
send(stranger, { type: 'join', code: 'ZZZZZ'});
const e1 = await waitError(stranger, '不存在的房间');
assert(e1.code === 'room_not_found', `房间不存在 code=room_not_found（得 ${e1.code}）`);
send(stranger, { type: 'spectate', code: 'ZZZZZ'});
const e1b = await waitError(stranger, '观战不存在的房间');
assert(e1b.code === 'room_not_found', `观战不存在房间 code=room_not_found`);

/* ---------- B. 观战 ---------- */
console.log('== B. 观战模式 ==');
const host = await connect();
const guest = await connect();
send(host, { type: 'create'});
const s1 = await waitState(host, s => s.phase === 'waiting', '建房');
const code = s1.code;
send(guest, { type: 'join', code});
await waitState(guest, s => s.phase === 'setup', 'B 加入');
assert(s1.expiresAt && s1.expiresAt - Date.now() > 24 * 3600 * 1000 - 60000 && s1.expiresAt - Date.now() <= 24 * 3600 * 1000,
`state 含 expiresAt，约为 24 小时后（剩余 ${Math.round((s1.expiresAt - Date.now()) / 3600000 * 10) / 10} 小时）`);

const third = await connect();
send(third, { type: 'join', code});
const e2 = await waitError(third, '第三人加入已满房间');
assert(e2.code === 'room_full', `房间已满 code=room_full（得 ${e2.code}）`);

send(third, { type: 'spectate', code});
const j3 = await waitFor(third, m => m.type === 'joined', '观战加入');
assert(j3.team === 'S', '观战者身份为 S');
const specState = await waitState(third, s => s.phase === 'setup', '观战者收到 state');
assert(specState.spectators === 1, `观战人数为 1（得 ${specState.spectators}）`);
const hostSeesSpec = await waitState(host, s => s.spectators === 1, '房主看到观战人数 1');
assert(hostSeesSpec.spectators === 1, '房主端 spectators=1');

/* ---------- C. 撤销（用当前房间打到 BP） ---------- */
console.log('== C. 撤销 ==');
send(host, { type: 'name', name: '电子队'});
send(guest, { type: 'name', name: '机械队'});
send(host, { type: 'bo', bo: 'bo1'});
await waitState(host, s => s.bo === 'bo1', 'BO1 设定');
send(guest, { type: 'startDice'});
await waitState(host, s => s.phase === 'dice', '进入掷骰');
let bpState = null;
for (let r = 0; r < 20 &&!bpState; r++) {
send(host, { type: 'roll'});
send(guest, { type: 'roll'});
const o = await waitState(host, s => s.phase === 'order', '掷骰', 2500).catch(() => null);
if (o) { bpState = o; break;}
await sleep(250);
send(host, { type: 'name', name: '电子队'});
}
assert(bpState && bpState.phase === 'order', '掷骰分出胜负');
send(bpState.diceWinner === 'A'? host: guest, { type: 'order', role: 'A'});
bpState = await waitState(host, s => s.phase === 'bp', '进入 BP');
const first = bpState.steps[0].team;
const firstWs = first === 'A'? host: guest;
const otherWs = first === 'A'? guest: host;
const banMap = bpState.mapsMeta[0].id;
send(firstWs, { type: 'map', mapId: banMap});
let s = await waitState(host, st => st.stepIndex === 1, 'ban 生效');
assert(s.maps[banMap].status === 'banned', `${banMap} 已禁用`);
assert(s.undo && s.undo.by === first, 'state 下发 undo 窗口信息');
// 对方撤销应被拒绝
send(otherWs, { type: 'undo'});
await sleep(600);
// 操作方本人撤销应成功
send(firstWs, { type: 'undo'});
s = await waitState(host, st => st.stepIndex === 0 && st.maps[banMap].status === 'available', '本人撤销成功');
assert(s.maps[banMap].status === 'available' && s.stepIndex === 0, '撤销后地图恢复可选、stepIndex 回 0');
// 再 ban 一次，等窗口过期后撤销应被拒绝
send(firstWs, { type: 'map', mapId: banMap});
s = await waitState(host, st => st.stepIndex === 1, '再次 ban 生效');
await sleep(5600);
send(firstWs, { type: 'undo'});
await sleep(600);
const sNoUndo = await new Promise((resolve) => {
send(host, { type: 'name', name: '电子队'});
const h = (raw) => {
const m = JSON.parse(raw.toString());
if (m.type === 'state') { host.removeListener('message', h); resolve(m.state);}
};
host.on('message', h);
});
assert(sNoUndo.stepIndex === 1 && sNoUndo.maps[banMap].status === 'banned', '5 秒后撤销被拒绝（仍为 ban 状态）');
// 观战者发 map/undo 应被拒绝
send(third, { type: 'map', mapId: 'haven'});
send(third, { type: 'undo'});
await sleep(500);
const sSpecNoOp = await new Promise((resolve) => {
send(host, { type: 'name', name: '电子队'});
const h = (raw) => {
const m = JSON.parse(raw.toString());
if (m.type === 'state') { host.removeListener('message', h); resolve(m.state);}
};
host.on('message', h);
});
assert(sSpecNoOp.stepIndex === 1, '观战者操作被拒绝（stepIndex 未变）');

/* ---------- D. 重连恢复 ---------- */
console.log('== D. 断线重连恢复 ==');
const beforeClose = sSpecNoOp;
const guestToken = guest.__token;
guest.close();
await sleep(400);
const guest2 = await connect();
send(guest2, { type: 'join', code, token: guestToken});
const j2 = await waitFor(guest2, m => m.type === 'joined', 'B 凭 token 重连');
assert(j2.team === 'B', '重连后仍是 B 队');
const sRe = await waitState(guest2, st => st.phase === 'bp', '重连后收到 state');
assert(sRe.phase === beforeClose.phase && sRe.stepIndex === beforeClose.stepIndex,
`重连后回到 BP 中途（phase=${sRe.phase} stepIndex=${sRe.stepIndex}，与断线前一致）`);
assert(JSON.stringify(sRe.maps) === JSON.stringify(beforeClose.maps), '重连后地图 Ban/Pick 状态完整一致');

/* ---------- E. 持久化：重启服务器后恢复 ---------- */
console.log('== E. 持久化重启恢复 ==');
const hostToken = host.__token;
const snapshot = sRe;
await stopServer();
assert(fs.existsSync(DATA_FILE), `落盘文件存在：${DATA_FILE}`);
const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
assert(Array.isArray(saved) && saved.some(r => r.code === code), '落盘文件含当前房间');
await startServer();
const host2 = await connect();
send(host2, { type: 'join', code, token: hostToken});
const jH = await waitFor(host2, m => m.type === 'joined', '重启后 A 凭 token 重连');
assert(jH.team === 'A', '重启后仍是 A 队');
const sAfter = await waitState(host2, st => st.phase === 'bp', '重启后收到 state');
assert(sAfter.phase === snapshot.phase && sAfter.stepIndex === snapshot.stepIndex, '重启后 phase/stepIndex 恢复');
assert(JSON.stringify(sAfter.maps) === JSON.stringify(snapshot.maps), '重启后地图状态恢复');
assert(sAfter.bo === 'bo1' && sAfter.players.A.name === '电子队' && sAfter.players.B.name === '机械队', '重启后赛制与队名恢复');
const guest3 = await connect();
send(guest3, { type: 'join', code, token: guestToken});
await waitFor(guest3, m => m.type === 'joined', '重启后 B 重连');
host2.close(); guest3.close(); third.close(); stranger.close();

/* ---------- F/G. guest.js 完整对局：BO1 + BO3 ---------- */
console.log('== F. guest.js 模拟 BO1 完整对局 ==');
const g1 = await playFullGameWithGuest('bo1');
assert(g1.final.phase === 'done', 'BO1 打完进入 done');
const matchMaps = g1.final.mapsMeta.filter(m => g1.final.maps[m.id].status === 'match');
assert(matchMaps.length === 1 && matchMaps[0] && g1.final.maps[matchMaps[0].id].side, `BO1 剩 1 张比赛地图且已选边：${matchMaps[0]? matchMaps[0].zh: '?'}`);
assert(g1.guestOut.includes('BP 完成'), 'guest.js 输出含“BP 完成”');
console.log('== G. guest.js 模拟 BO3 完整对局 ==');
const g3 = await playFullGameWithGuest('bo3');
assert(g3.final.phase === 'done', 'BO3 打完进入 done');
const picks3 = g3.final.mapsMeta.filter(m => g3.final.maps[m.id].status === 'picked');
const dec3 = g3.final.mapsMeta.filter(m => g3.final.maps[m.id].status === 'decider');
assert(picks3.length === 2 && dec3.length === 1, `BO3 选图 2 张 + 决胜图 1 张（得 pick=${picks3.length} decider=${dec3.length}）`);
assert(picks3.every(m => g3.final.maps[m.id].side), 'BO3 两张选图均已选边');
assert(g3.guestOut.includes('BP 完成'), 'guest.js 输出含“BP 完成”');

/* ---------- H. 纯函数（从 app.js 抽取验证） ---------- */
console.log('== H. 纯函数验证（buildResultText / formatRemaining） ==');
const appSrc = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
function extractFn(name) {
const m = appSrc.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
if (!m) throw new Error('未找到函数 ' + name);
return eval('(' + m[0] + ')');
}
const buildResultText = extractFn('buildResultText');
const formatRemaining = extractFn('formatRemaining');
const bo3State = {
bo: 'bo3',
players: { A: { name: '电子队'}, B: { name: '机械队'}},
mapsMeta: [
{ id: 'bind', zh: '源工重镇', en: 'Bind'},
{ id: 'haven', zh: '隐世修所', en: 'Haven'},
{ id: 'lotus', zh: '莲华古城', en: 'Lotus'},
{ id: 'sunset', zh: '日落之城', en: 'Sunset'},
{ id: 'abyss', zh: '幽邃地窟', en: 'Abyss'},
{ id: 'corrode', zh: '盐海矿镇', en: 'Corrode'},
{ id: 'summit', zh: '天枢云阙', en: 'Summit'},
],
maps: {
bind: { status: 'banned', by: 'A'},
haven: { status: 'banned', by: 'B'},
lotus: { status: 'picked', by: 'A', order: 1, side: 'attack', sideBy: 'B'},
sunset: { status: 'picked', by: 'B', order: 2, side: 'attack', sideBy: 'A'},
abyss: { status: 'banned', by: 'A'},
corrode: { status: 'banned', by: 'B'},
summit: { status: 'decider', side: 'defense', sideBy: 'A'},
},
};
const txt = buildResultText(bo3State);
const expected = [
'【瓦部赛事台】BO3 赛果',
'图一 莲华古城：电子队选图，机械队进攻开局',
'图二 日落之城：机械队选图，电子队进攻开局',
'决胜图 天枢云阙：电子队选边，机械队进攻开局',
].join('\n');
assert(txt === expected, 'BO3 赛果文案格式正确\n' + txt.split('\n').map(l => ' ' + l).join('\n'));
const bo1State = JSON.parse(JSON.stringify(bo3State));
bo1State.bo = 'bo1';
bo1State.maps = {
bind: { status: 'banned', by: 'A'},
haven: { status: 'banned', by: 'B'},
lotus: { status: 'match', side: 'defense', sideBy: 'A'},
sunset: { status: 'banned', by: 'A'},
abyss: { status: 'banned', by: 'B'},
corrode: { status: 'banned', by: 'A'},
summit: { status: 'banned', by: 'B'},
};
const txt1 = buildResultText(bo1State);
assert(txt1 === '【瓦部赛事台】BO1 赛果\n比赛地图 莲华古城：电子队选边，机械队进攻开局', 'BO1 赛果文案格式正确：' + txt1.replace(/\n/g, ' / '));
assert(formatRemaining(0) === '已过期', 'formatRemaining(0)=已过期');
assert(formatRemaining(-1000) === '已过期', 'formatRemaining(负数)=已过期');
assert(formatRemaining(5 * 60000) === '有效期剩余 5 分', 'formatRemaining(5分钟)');
assert(formatRemaining(65 * 60000) === '有效期剩余 1 小时 5 分', 'formatRemaining(65分钟)');
assert(formatRemaining(24 * 3600 * 1000) === '有效期剩余 24 小时 0 分', 'formatRemaining(24小时)');

await stopServer();
try { fs.unlinkSync(DATA_FILE);} catch {}
console.log('');
console.log(failures === 0? '✅ 扩展测试全部通过': `❌ ${failures} 项失败`);
process.exit(failures === 0? 0: 1);
})().catch(async (e) => {
console.error('测试异常:', e.message);
try { await stopServer();} catch {}
process.exit(1);
});

