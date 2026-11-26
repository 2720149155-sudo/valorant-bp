/* 无畏契约 BP 工具 - 客户端 */

let ws = null;
let myTeam = null;
let roomCode = null;
let st = null;            // 服务器状态
let prevPhase = null;
let prevDice = null;
let prevDiceRound = null;
let reconnectTimer = null;
let pendingCreate = false;
let nameTimer = null;
let toastTimer = null;

const diceRun = {
  A: { timer: null, count: 0, target: 0 },
  B: { timer: null, count: 0, target: 0 },
};

const $ = (id) => document.getElementById(id);

const TEAM_NAME = { A: 'A队', B: 'B队' };
const SIDE_LABEL = { attack: '进攻', defense: '防守' };
const BO_TEXT = { bo1: 'BO1 · 单图决胜', bo3: 'BO3 · 三图两胜', bo5: 'BO5 · 五图三胜' };
// 地图池元数据（与服务端 MAPS 一致，用于首页/赛前地图池预览）
const MAPS_META = [
  { id: 'bind', en: 'Bind', zh: '源工重镇', sites: 'A/B' },
  { id: 'haven', en: 'Haven', zh: '隐世修所', sites: 'A/B/C' },
  { id: 'lotus', en: 'Lotus', zh: '莲华古城', sites: 'A/B/C' },
  { id: 'sunset', en: 'Sunset', zh: '日落之城', sites: 'A/B' },
  { id: 'abyss', en: 'Abyss', zh: '幽邃地窟', sites: 'A/B' },
  { id: 'corrode', en: 'Corrode', zh: '盐海矿镇', sites: 'A/B' },
  { id: 'summit', en: 'Summit', zh: '天枢云阙', sites: 'A/B' },
];

function otherTeam(t) { return t === 'A' ? 'B' : 'A'; }

/* ---------- 纯函数（可被 node 测试抽取验证） ---------- */

// 房间剩余有效期文案
function formatRemaining(ms) {
  if (ms <= 0) return '已过期';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `有效期剩余 ${h} 小时 ${m} 分`;
  return `有效期剩余 ${m} 分`;
}

// 生成可直接发群的赛果文字
function buildResultText(state) {
  const boLabel = { bo1: 'BO1', bo3: 'BO3', bo5: 'BO5' }[state.bo] || state.bo || '';
  const nameOf = (t) => (state.players[t] && state.players[t].name) || (t === 'A' ? 'A队' : 'B队');
  const atkTeamOf = (mm) => {
    if (!mm.side) return null;
    return mm.side === 'attack' ? mm.sideBy : (mm.sideBy === 'A' ? 'B' : 'A');
  };
  const picked = state.mapsMeta.filter(m => state.maps[m.id].status === 'picked')
    .sort((a, b) => state.maps[a.id].order - state.maps[b.id].order);
  const decider = state.mapsMeta.filter(m => state.maps[m.id].status === 'decider');
  const matchMap = state.mapsMeta.filter(m => state.maps[m.id].status === 'match');
  const rows = [...picked, ...decider, ...matchMap];
  const numZh = ['一', '二', '三', '四', '五'];
  const lines = [`【瓦部赛事台】${boLabel} 赛果`];
  rows.forEach((m, i) => {
    const mm = state.maps[m.id];
    let label;
    if (mm.status === 'match') label = '比赛地图';
    else if (mm.status === 'decider') label = '决胜图';
    else label = `图${numZh[i] || (i + 1)}`;
    let desc;
    if (mm.status === 'picked') {
      const atk = atkTeamOf(mm);
      desc = atk ? `${nameOf(mm.by)}选图，${nameOf(atk)}进攻开局` : `${nameOf(mm.by)}选图，阵营待定`;
    } else {
      const atk = atkTeamOf(mm);
      desc = mm.side
        ? `${nameOf(mm.sideBy)}选边，${nameOf(atk)}进攻开局`
        : '开局阵营由比赛内刀局决定';
    }
    lines.push(`${label} ${m.zh}：${desc}`);
  });
  return lines.join('\n');
}

/* ---------- 连接 ---------- */

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

function connect() {
  clearTimeout(reconnectTimer);
  try { if (ws) { ws.onclose = null; ws.close(); } } catch (e) {}
  ws = new WebSocket(wsUrl());
  ws.onopen = () => {
    setConn(true);
    if (pendingCreate) {
      send({ type: 'create' });
      pendingCreate = false;
    } else {
      send({ type: 'join', code: roomCode, token: sessionStorage.getItem(`bp-token-${roomCode}`) });
    }
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleMsg(msg);
  };
  ws.onclose = () => {
    setConn(false);
    if (roomCode) {
      reconnectTimer = setTimeout(connect, 2000);
    }
  };
  ws.onerror = () => {};
}

function send(obj) {
  // 观战者禁止一切游戏操作（服务端同样会拦截，这里是前端双保险）
  if (myTeam === 'S' && obj.type !== 'spectate' && obj.type !== 'join') return;
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function handleMsg(msg) {
  if (msg.type === 'joined') {
    roomCode = msg.code;
    myTeam = msg.team;
    if (msg.token) sessionStorage.setItem(`bp-token-${msg.code}`, msg.token);
    const url = new URL(location.href);
    url.searchParams.set('room', msg.code);
    history.replaceState(null, '', url);
    $('screen-home').hidden = true;
    $('screen-loading').hidden = true;
    $('screen-error').hidden = true;
    $('screen-room').hidden = false;
    $('room-code').textContent = msg.code;
    $('waiting-code').textContent = msg.code;
    const spectating = msg.team === 'S';
    document.body.classList.toggle('spectating', spectating);
    $('spectate-badge').hidden = !spectating;
    if (!spectating) recordRecent(msg.code, msg.team);
    else recordRecent(msg.code, 'S');
    return;
  }
  if (msg.type === 'error') {
    if (msg.code === 'room_not_found' || msg.code === 'room_full' || msg.code === 'room_expired') {
      showRoomError(msg.code, msg.message);
      return;
    }
    if (!roomCode) {
      $('home-error').textContent = msg.message;
    } else {
      toast(msg.message);
      if (msg.message.includes('不存在')) {
        setTimeout(() => location.href = '/', 1800);
      }
    }
    return;
  }
  if (msg.type === 'state') {
    render(msg.state);
  }
}

// 全屏错误提示：房间不存在 / 已满 / 已过期，绝不留白
function showRoomError(code, message) {
  const titles = { room_not_found: '房间不存在', room_full: '房间已满', room_expired: '房间已过期' };
  $('screen-home').hidden = true;
  $('screen-room').hidden = true;
  $('screen-loading').hidden = true;
  $('screen-error').hidden = false;
  $('error-title').textContent = titles[code] || '无法进入房间';
  $('error-msg').textContent = code === 'room_full'
    ? `${message}，可以进入观战，或返回首页重新建房。`
    : message;
  $('btn-error-spectate').hidden = code !== 'room_full';
}

function setConn(on) {
  const el = $('conn-status');
  el.innerHTML = on
    ? '<i class="dot dot-on"></i>已连接'
    : '<i class="dot dot-off"></i>连接中断，重连中…';
}

/* ---------- 渲染总控 ---------- */

function render(state) {
  const lastPhase = prevPhase;
  st = state;

  for (const t of ['A', 'B']) {
    if (!st.players[t].name) st.players[t].name = TEAM_NAME[t];
  }

  if (lastPhase === 'dice' && (st.phase === 'order' || st.phase === 'bp')) {
    showDiceOverlay();
  }
  if (lastPhase === 'dice' && st.phase === 'dice' && prevDiceRound !== null && prevDiceRound !== st.diceRound) {
    toast('点数相同，重新掷骰！');
  }

  const map = {
    waiting: 'phase-waiting', setup: 'phase-setup', dice: 'phase-dice',
    order: 'phase-order', bp: 'phase-bp', done: 'phase-done',
  };
  for (const key in map) $(map[key]).hidden = key !== st.phase;

  if (st.phase === 'waiting') renderWaiting();
  if (st.phase === 'setup') renderSetup();
  if (st.phase === 'dice') renderDice();
  if (st.phase === 'order') renderOrder();
  if (st.phase === 'bp') renderBp();
  if (st.phase === 'done') renderDone();
  renderSpectator();
  renderExpiry();
  updateUndoBar();
  updateRecentBo(st.code, st.bo);

  prevPhase = st.phase;
  prevDiceRound = st.diceRound;
  prevDice = { A: st.players.A.dice, B: st.players.B.dice };
  renderDisconnect();
}

function teamName(t) { return st ? st.players[t].name : TEAM_NAME[t]; }

// 观战者：禁用所有输入与操作按钮（服务端同样拦截）
function renderSpectator() {
  if (myTeam !== 'S') return;
  document.querySelectorAll('.input-name, .bo-btn').forEach(el => { el.disabled = true; });
  $('btn-start-dice').hidden = true;
  $('btn-roll').hidden = true;
}

// 房间有效期倒计时
function renderExpiry() {
  const el = $('room-expire');
  if (!st || !st.expiresAt) { el.textContent = '有效期剩余 —'; return; }
  el.textContent = formatRemaining(st.expiresAt - Date.now());
}

// 撤销提示条：仅操作方本人在 5 秒窗口内可见
function updateUndoBar() {
  const bar = $('undo-bar');
  if (!st || st.phase !== 'bp' || !st.undo || st.undo.by !== myTeam) { bar.hidden = true; return; }
  const left = Math.ceil((st.undo.until - Date.now()) / 1000);
  if (left <= 0) { bar.hidden = true; return; }
  bar.hidden = false;
  $('undo-text').textContent = `已操作，可在 ${left} 秒内撤销`;
}

function renderDisconnect() {
  if (myTeam === 'S') return; // 观战者没有“对方”，不显示断线提示
  const other = myTeam === 'A' ? 'B' : 'A';
  const disc = st && st.players[other] && !st.players[other].connected && st.phase !== 'waiting';
  if (!toastTimer) $('disc-toast').hidden = !disc;
}

/* ---------- 房主设置（等待对手） ---------- */

function fillNameInput(sectionSel) {
  if (myTeam === 'S') return; // 观战者没有队名输入
  const input = document.querySelector(sectionSel + ' .input-name');
  if (!input || document.activeElement === input) return;
  const myName = st.players[myTeam].name;
  const val = myName === TEAM_NAME[myTeam] ? '' : myName;
  if (input.value !== val) input.value = val;
}

function renderWaiting() {
  fillNameInput('#phase-waiting');
  document.querySelectorAll('#phase-waiting .bo-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.bo === st.bo);
  });
  $('code-reveal').hidden = !st.bo;
  $('no-bo-hint').hidden = !!st.bo;
  $('waiting-code').textContent = st.code;
}

/* ---------- 赛前确认（双方就位） ---------- */

function renderSetup() {
  const isHost = myTeam === 'A';

  $('bo-fixed').hidden = isHost;
  $('bo-select-2').hidden = !isHost;
  if (!isHost) $('bo-fixed').textContent = st.bo ? BO_TEXT[st.bo] : '等待房主选择赛制';
  document.querySelectorAll('#phase-setup .bo-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.bo === st.bo);
  });

  fillNameInput('#phase-setup');

  $('mini-a-name').textContent = st.players.A.name;
  $('mini-b-name').textContent = st.players.B.name;
  setConnBadge('mini-a-conn', st.players.A.connected);
  setConnBadge('mini-b-conn', st.players.B.connected);

  const startBtn = $('btn-start-dice');
  if (!isHost) {
    startBtn.hidden = false;
    const named = st.players[myTeam].name && st.players[myTeam].name !== TEAM_NAME[myTeam];
    startBtn.disabled = !(st.bo && named);
    $('setup-hint').textContent = st.bo
      ? '输入队名后点击开始，掷骰决定先后手'
      : '等待房主确定赛制…';
  } else {
    startBtn.hidden = true;
    $('setup-hint').textContent = '对方确认队名后将自动开始掷骰';
  }
}

function setConnBadge(id, on) {
  const el = $(id);
  el.textContent = on ? '在线' : '未连接';
  el.className = on ? 'em-on' : 'em-off';
}

/* ---------- 掷骰阶段 ---------- */

function renderDice() {
  $('dice-name-a').textContent = st.players.A.name;
  $('dice-name-b').textContent = st.players.B.name;
  $('dice-round').textContent = `第 ${st.diceRound} 轮`;

  for (const t of ['A', 'B']) {
    const p = st.players[t];
    const run = diceRun[t];
    const faceEl = $(`dice-face-${t.toLowerCase()}`);
    const diceEl = $(`dice-${t.toLowerCase()}`);
    const hint = $(`dice-hint-${t.toLowerCase()}`);

    if (p.dice !== null) {
      run.target = p.dice;
      const justArrived = prevDice && prevDice[t] === null;
      if (!run.timer && justArrived) startDiceAnim(t);
      if (!run.timer) setFace(faceEl, p.dice);
      diceEl.classList.remove('can-roll');
      diceEl.classList.add(t === 'A' ? 'done-a' : 'done-b');
      hint.textContent = `掷出 ${p.dice} 点`;
    } else if (!run.timer) {
      run.target = 0;
      setFace(faceEl, 0);
      diceEl.classList.remove('done-a', 'done-b', 'rolling');
      const canRoll = t === myTeam;
      diceEl.classList.toggle('can-roll', canRoll);
      hint.textContent = canRoll ? '点击骰子掷点' : '等待对方掷骰';
    }
  }

  const me = st.players[myTeam] || { rolled: true };
  $('btn-roll').hidden = me.rolled;
  $('btn-roll').disabled = me.rolled;
}

function setFace(faceEl, v) {
  faceEl.dataset.face = String(v);
}

function startDiceAnim(t) {
  const run = diceRun[t];
  const faceEl = $(`dice-face-${t.toLowerCase()}`);
  const diceEl = $(`dice-${t.toLowerCase()}`);
  if (run.timer) clearInterval(run.timer);
  diceEl.classList.add('rolling');
  diceEl.classList.remove('can-roll', 'done-a', 'done-b');
  run.count = 0;
  run.timer = setInterval(() => {
    run.count++;
    if (run.count >= 10 && run.target > 0) {
      clearInterval(run.timer);
      run.timer = null;
      diceEl.classList.remove('rolling');
      setFace(faceEl, run.target);
    } else if (run.count >= 60) {
      clearInterval(run.timer);
      run.timer = null;
      diceEl.classList.remove('rolling');
      setFace(faceEl, 1 + Math.floor(Math.random() * 6));
    } else {
      setFace(faceEl, 1 + Math.floor(Math.random() * 6));
    }
  }, 85);
}

function showDiceOverlay() {
  const a = st.players.A, b = st.players.B;
  $('ov-die-a').textContent = a.dice;
  $('ov-die-b').textContent = b.dice;
  const win = st.diceWinner;
  const name = teamName(win);
  $('ov-title').textContent = `${name} 获得选择权！`;
  $('ov-title').style.color = win === 'A' ? 'var(--blue)' : 'var(--red)';
  const ov = $('dice-overlay');
  ov.hidden = false;
  setTimeout(() => { ov.hidden = true; }, 2200);
}

/* ---------- 选择 BP 顺序 ---------- */

function renderOrder() {
  const win = st.diceWinner;
  const name = teamName(win);
  const isWinner = myTeam === win;
  $('order-winner-text').innerHTML = `<span style="color:${win === 'A' ? 'var(--blue)' : 'var(--red)'}">${name}</span> 掷骰获胜，可决定先 Ban 或后 Ban`;
  $('order-btns').hidden = !isWinner;
  $('order-wait').hidden = isWinner;
}

/* ---------- BP 阶段 ---------- */

function curStep() {
  if (!st || st.phase !== 'bp') return null;
  return st.steps[st.stepIndex] || null;
}

function renderBp() {
  const step = curStep();

  for (const t of ['A', 'B']) {
    $(`tp-name-${t.toLowerCase()}`).textContent = st.players[t].name;
    const panel = $(`panel-${t.toLowerCase()}`);
    panel.classList.toggle('active', !!step && step.team === t);

    const bans = [], picks = [];
    for (const m of st.mapsMeta) {
      const mm = st.maps[m.id];
      if (!mm || mm.by !== t) continue;
      if (mm.status === 'banned') bans.push(m);
      if (mm.status === 'picked') picks.push(m);
    }
    picks.sort((x, y) => st.maps[x.id].order - st.maps[y.id].order);
    $(`tp-bans-${t.toLowerCase()}`).innerHTML = bans.length
      ? bans.map(m => `<li class="tp-ban-li"><i class="tdot td-${t === 'A' ? 'a' : 'b'}" style="opacity:.35"></i>${m.zh}</li>`).join('')
      : '<li class="muted small">—</li>';
    $(`tp-picks-${t.toLowerCase()}`).innerHTML = picks.length
      ? picks.map(m => {
          const mm = st.maps[m.id];
          const sideTxt = mm.side ? ` · ${teamName(mm.sideBy)}${SIDE_LABEL[mm.side]}` : '';
          return `<li><i class="tdot td-${t === 'A' ? 'a' : 'b'}"></i>${m.zh}<span class="muted small">${sideTxt}</span></li>`;
        }).join('')
      : '<li class="muted small">—</li>';

    const turnEl = $(`tp-turn-${t.toLowerCase()}`);
    if (step && step.team === t) {
      turnEl.textContent = step.type === 'ban' ? '禁用回合' : step.type === 'pick' ? '选图回合' : '选择阵营';
    } else {
      turnEl.textContent = '等待';
    }

    let offTag = panel.querySelector('.tp-off');
    if (!st.players[t].connected) {
      if (!offTag) {
        offTag = document.createElement('div');
        offTag.className = 'tp-off';
        offTag.textContent = '⚠ 已断线';
        panel.querySelector('.tp-head').appendChild(offTag);
      }
    } else if (offTag) offTag.remove();
  }

  const banner = $('step-banner');
  if (step) {
    const n = st.players[step.team].name;
    const dot = `<i class="turn-dot" style="background:${step.team === 'A' ? 'var(--blue)' : 'var(--red)'}"></i>`;
    let txt;
    if (step.type === 'ban') txt = `${n} 禁用一张地图`;
    else if (step.type === 'pick') txt = `${n} 选择一张地图`;
    else txt = isFinalSideStep()
      ? `${n} 为${st.bo === 'bo1' ? '比赛地图' : '决胜图'}选择阵营`
      : `${n} 选择起始阵营`;
    const mine = step.team === myTeam;
    $('step-text').innerHTML = `${dot}<span>${txt}${mine ? '（你）' : ''}</span>`;
    banner.classList.toggle('my-step', mine);
    banner.querySelectorAll('.step-sub').forEach(el => el.remove());
    const sub = document.createElement('span');
    sub.className = 'step-sub';
    sub.textContent = `第 ${st.stepIndex + 1} / ${st.steps.length} 步`;
    banner.appendChild(sub);
  }

  renderMapGrid(step);
  renderSidePick(step);
  renderSeq(step);
}

function renderMapGrid(step) {
  const grid = $('map-grid');
  grid.innerHTML = '';
  const canAct = !!step && (step.type === 'ban' || step.type === 'pick') && step.team === myTeam;
  const maxOrder = st.mapsMeta.reduce((acc, m) => Math.max(acc, st.maps[m.id].order || 0), 0);

  for (const m of st.mapsMeta) {
    const mm = st.maps[m.id];
    const card = document.createElement('div');
    card.className = 'map-card';
    card.style.backgroundImage = `url(maps/${m.id}-card.webp)`;

    const nameEl = document.createElement('div');
    nameEl.className = 'map-name';
    nameEl.innerHTML = `<b>${m.zh}</b><span>${m.en}</span>`;
    card.appendChild(nameEl);

    const sites = document.createElement('div');
    sites.className = 'map-sites';
    sites.textContent = m.sites;
    card.appendChild(sites);

    if (mm.status === 'available') {
      if (canAct) {
        card.classList.add('clickable');
        if (step.team === 'B') card.classList.add('b-turn');
        card.onclick = () => openConfirm(m.id, step.type);
      } else {
        card.classList.add('dimmed');
      }
    } else if (mm.status === 'banned') {
      card.classList.add('banned');
      addStamp(card, 'stamp-ban', 'BAN');
      addBottomChip(card, `${teamName(mm.by)} 禁用`);
    } else if (mm.status === 'picked') {
      card.classList.add('picked', mm.by === 'A' ? 'picked-a' : 'picked-b');
      addStamp(card, mm.by === 'A' ? 'stamp-pick-a' : 'stamp-pick-b', 'PICK');
      addOrderBadge(card, mm.order, false, mm.by === 'A' ? 'ord-a' : 'ord-b');
      if (mm.side) addBottomChip(card, null, mm.side, mm.sideBy);
    } else if (mm.status === 'decider') {
      card.classList.add('decider');
      addStamp(card, 'stamp-gold', '决胜图');
      addOrderBadge(card, maxOrder + 1, true);
      if (mm.side) addBottomChip(card, null, mm.side, mm.sideBy);
    } else if (mm.status === 'match') {
      card.classList.add('match');
      addStamp(card, 'stamp-gold', '比赛地图');
      if (mm.side) addBottomChip(card, null, mm.side, mm.sideBy);
    }
    grid.appendChild(card);
  }
}

function addStamp(card, cls, text) {
  const s = document.createElement('div');
  s.className = `stamp ${cls}`;
  s.textContent = text;
  card.appendChild(s);
}

function addOrderBadge(card, n, gold, extraCls) {
  const b = document.createElement('div');
  b.className = 'map-order' + (gold ? ' gold' : '') + (extraCls ? ' ' + extraCls : '');
  b.textContent = n;
  card.appendChild(b);
}

function addBottomChip(card, text, side, sideBy) {
  const chip = document.createElement('div');
  chip.className = 'map-side';
  if (side) {
    const label = SIDE_LABEL[side];
    chip.innerHTML = side === 'attack'
      ? `<span class="sa">${label} · ${teamName(sideBy)}</span>`
      : `<span class="sd">${label} · ${teamName(sideBy)}</span>`;
  } else {
    chip.textContent = text;
  }
  card.appendChild(chip);
}

function isFinalSideStep() {
  if (!st || st.phase !== 'bp') return false;
  const step = st.steps[st.stepIndex];
  if (!step || step.type !== 'side') return false;
  return !st.mapsMeta.some(m => {
    const mm = st.maps[m.id];
    return mm && mm.status === 'picked' && !mm.side;
  });
}

function renderSidePick(step) {
  const panel = $('side-pick');
  const show = !!step && step.type === 'side';
  panel.hidden = !show;
  if (!show) return;
  const n = st.players[step.team].name;
  const mine = step.team === myTeam;
  const final = isFinalSideStep();
  const mapLabel = st.bo === 'bo1' ? '比赛地图' : '决胜图';
  $('side-title').textContent = mine
    ? `${n}，请选择${final ? mapLabel : ''}阵营`
    : `${n} 正在选择${final ? mapLabel : ''}阵营…`;
  $('side-sub').textContent = mine
    ? (final ? `${mapLabel}已确定，由你决定开局攻防` : '对方选图后，由你决定该图的开局阵营')
    : '等待对方选择';
  panel.querySelectorAll('.side-btn').forEach(b => {
    b.style.pointerEvents = mine ? '' : 'none';
    b.style.opacity = mine ? '' : '.5';
  });
}

function renderSeq(step) {
  const el = $('seq-tracker');
  el.innerHTML = '<span class="seq-label">流程</span>';
  st.steps.forEach((s, i) => {
    const chip = document.createElement('span');
    chip.className = 'seq-chip';
    if (s.team === 'B') chip.classList.add('b-chip');
    if (i < st.stepIndex) chip.classList.add('done');
    if (i === st.stepIndex) chip.classList.add('current');
    let label;
    if (s.type === 'ban') label = '禁';
    else if (s.type === 'pick') label = '选';
    else label = (i === st.steps.length - 1) ? '决' : '边';
    chip.innerHTML = `<i class="sc-dot sc-${s.team === 'A' ? 'a' : 'b'}"></i>${label}`;
    el.appendChild(chip);
  });
}

/* ---------- 结果阶段 ---------- */

function renderDone() {
  const list = $('result-list');
  list.innerHTML = '';

  const picked = st.mapsMeta.filter(m => st.maps[m.id].status === 'picked')
    .sort((a, b) => st.maps[a.id].order - st.maps[b.id].order);
  const decider = st.mapsMeta.filter(m => st.maps[m.id].status === 'decider');
  const matchMap = st.mapsMeta.filter(m => st.maps[m.id].status === 'match');
  const rows = [...picked, ...decider, ...matchMap];

  rows.forEach((m, i) => {
    const mm = st.maps[m.id];
    const row = document.createElement('div');
    row.className = 'result-row';

    const idx = document.createElement('div');
    if (mm.status === 'match') {
      idx.className = 'rr-index gold';
      idx.textContent = '比赛地图';
    } else if (mm.status === 'decider') {
      idx.className = 'rr-index gold';
      idx.textContent = `第${i + 1}图 · 决胜`;
    } else {
      idx.className = 'rr-index';
      idx.textContent = `第${i + 1}图`;
    }
    row.appendChild(idx);

    const thumb = document.createElement('div');
    thumb.className = 'rr-thumb';
    thumb.style.backgroundImage = `url(maps/${m.id}-full.webp)`;
    row.appendChild(thumb);

    const name = document.createElement('div');
    name.className = 'rr-name';
    name.innerHTML = `<b>${m.zh}</b><span>${m.en}</span>`;
    row.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'rr-meta';
    let by = '';
    if (mm.status === 'picked') by = `${teamName(mm.by)} 选图`;
    else if (mm.status === 'decider') by = '剩余决胜';
    let sidesHtml = '';
    if (mm.side) {
      const atk = mm.side === 'attack' ? mm.sideBy : otherTeam(mm.sideBy);
      const def = otherTeam(atk);
      sidesHtml = `<span class="rr-chip rr-atk">进攻 · ${teamName(atk)}</span><span class="rr-chip rr-def">防守 · ${teamName(def)}</span>`;
    } else if (mm.status === 'decider') {
      sidesHtml = `<span class="rr-chip rr-knife">开局阵营由比赛内刀局决定</span>`;
    }
    meta.innerHTML = by
      ? `<div class="rr-by">${by}</div><div class="rr-sides">${sidesHtml}</div>`
      : `<div class="rr-sides">${sidesHtml}</div>`;
    row.appendChild(meta);

    list.appendChild(row);
  });
}

/* ---------- Ban/Pick 二次确认 ---------- */

let pendingConfirm = null;

function openConfirm(mapId, actionType) {
  const m = st.mapsMeta.find(x => x.id === mapId);
  if (!m) return;
  pendingConfirm = { mapId, actionType };
  $('confirm-eyebrow').textContent = actionType === 'ban' ? 'BAN · 禁用' : 'PICK · 选择';
  $('confirm-map').textContent = `${m.zh} · ${m.en}`;
  $('confirm-text').textContent = actionType === 'ban'
    ? `确定禁用「${m.zh}」吗？确认后 5 秒内可撤销。`
    : `确定选择「${m.zh}」作为对局地图吗？确认后 5 秒内可撤销。`;
  $('confirm-modal').hidden = false;
}

/* ---------- 地图池预览 ---------- */

function renderMapPool(el) {
  if (!el) return;
  el.innerHTML = '';
  for (const m of MAPS_META) {
    const card = document.createElement('div');
    card.className = 'pool-item';
    card.innerHTML = `<div class="pool-thumb" style="background-image:url(maps/${m.id}-card.webp)"></div>` +
      `<div class="pool-name"><b>${m.zh}</b><span>${m.en} · 点位 ${m.sites}</span></div>`;
    el.appendChild(card);
  }
}

/* ---------- 最近房间（localStorage，最多 8 条） ---------- */

const RECENT_KEY = 'bp-recent-rooms';

function loadRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; }
  catch { return []; }
}

function saveRecentList(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) {}
}

function recordRecent(code, role) {
  const list = loadRecent().filter(r => r.code !== code);
  list.unshift({ code, role, bo: null, visitedAt: Date.now() });
  saveRecentList(list.slice(0, 8));
  renderRecent();
}

function updateRecentBo(code, bo) {
  if (!bo) return;
  const list = loadRecent();
  const r = list.find(x => x.code === code);
  if (r && r.bo !== bo) {
    r.bo = bo;
    saveRecentList(list);
    renderRecent();
  }
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

function renderRecent() {
  const list = loadRecent();
  $('recent-card').hidden = list.length === 0;
  const el = $('recent-list');
  el.innerHTML = '';
  list.forEach(r => {
    const item = document.createElement('button');
    item.className = 'recent-item';
    const roleTxt = r.role === 'S' ? '观战' : r.role === 'A' ? '房主' : '对手';
    item.innerHTML = `<b>${r.code}</b><span>${r.bo ? BO_TEXT[r.bo] : '未选赛制'}</span>` +
      `<span>${roleTxt}</span><em>${timeAgo(r.visitedAt)}</em>`;
    item.onclick = () => {
      $('input-code').value = r.code;
      $('btn-join').click();
    };
    el.appendChild(item);
  });
}

/* ---------- 工具 ---------- */

function toast(text) {
  const t = $('disc-toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
    toastTimer = null;
    renderDisconnect();
  }, 2600);
}

function copyLink() {
  const url = `${location.origin}/?room=${roomCode}`;
  const done = () => toast('邀请链接已复制，发给对手吧');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done).catch(() => fallbackCopy(url, done));
  } else {
    fallbackCopy(url, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (e) {}
  ta.remove();
}

/* ---------- 事件绑定 ---------- */

$('btn-create').onclick = () => {
  pendingCreate = true;
  $('home-error').textContent = '';
  connect();
};

$('btn-join').onclick = () => {
  const code = $('input-code').value.trim().toUpperCase();
  if (code.length !== 5) {
    $('home-error').textContent = '请输入 5 位房间码';
    return;
  }
  roomCode = code;
  $('home-error').textContent = '';
  connect();
};

$('input-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-join').click();
});
$('input-code').addEventListener('input', (e) => {
  if (e.isComposing) return;
  const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (v !== e.target.value) e.target.value = v;
});
$('input-code').addEventListener('compositionend', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

$('btn-copy').onclick = copyLink;
$('btn-copy2').onclick = copyLink;

document.querySelectorAll('.input-name').forEach(inp => {
  inp.addEventListener('input', (e) => {
    clearTimeout(nameTimer);
    nameTimer = setTimeout(() => send({ type: 'name', name: e.target.value }), 350);
  });
});

document.querySelectorAll('.bo-btn').forEach(b => {
  b.onclick = () => send({ type: 'bo', bo: b.dataset.bo });
});

$('btn-start-dice').onclick = () => send({ type: 'startDice' });

document.querySelectorAll('.order-btn').forEach(b => {
  b.onclick = () => send({ type: 'order', role: b.dataset.role });
});

function tryRoll() {
  if (!st || st.phase !== 'dice' || !st.players[myTeam] || st.players[myTeam].rolled) return;
  startDiceAnim(myTeam);
  send({ type: 'roll' });
}
$('btn-roll').onclick = tryRoll;
$('dice-a').onclick = () => { if (myTeam === 'A') tryRoll(); };
$('dice-b').onclick = () => { if (myTeam === 'B') tryRoll(); };

document.querySelectorAll('.side-btn').forEach(b => {
  b.onclick = () => send({ type: 'side', side: b.dataset.side });
});

$('btn-confirm-ok').onclick = () => {
  if (pendingConfirm) {
    send({ type: 'map', mapId: pendingConfirm.mapId });
    pendingConfirm = null;
  }
  $('confirm-modal').hidden = true;
};
$('btn-confirm-cancel').onclick = () => {
  pendingConfirm = null;
  $('confirm-modal').hidden = true;
};

$('btn-undo').onclick = () => send({ type: 'undo' });

$('btn-copy-result').onclick = () => {
  if (!st) return;
  const text = buildResultText(st);
  const done = () => toast('赛果已复制，发到群里吧');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
};

$('btn-clear-recent').onclick = () => {
  saveRecentList([]);
  renderRecent();
};

$('btn-error-home').onclick = () => { location.href = '/'; };
$('btn-error-create').onclick = () => {
  try { sessionStorage.setItem('bp-autocreate', '1'); } catch (e) {}
  location.href = '/';
};
$('btn-error-spectate').onclick = () => {
  $('screen-error').hidden = true;
  $('screen-loading').hidden = false;
  send({ type: 'spectate', code: roomCode });
};

$('btn-again').onclick = () => {
  if (confirm('确定重新开始 BP？当前结果将清空。')) {
    send({ type: 'reset' });
  }
};

$('btn-home').onclick = () => {
  if (roomCode) sessionStorage.removeItem(`bp-token-${roomCode}`);
  location.href = '/';
};

/* ---------- 启动 ---------- */

// 骰子面生成 9 个点位（3x3 网格）
for (const t of ['a', 'b']) {
  const face = $(`dice-face-${t}`);
  face.innerHTML = Array.from({ length: 9 }, () => '<span class="pip"></span>').join('');
}

// 地图池预览（首页 + 房主等待页 + 赛前确认页）
renderMapPool($('home-pool'));
renderMapPool($('waiting-pool'));
renderMapPool($('setup-pool'));
// 最近房间
renderRecent();
// 倒计时与撤销条每秒刷新
setInterval(() => { renderExpiry(); updateUndoBar(); }, 1000);
// 从错误页“重新建房”回来时自动创建房间
try {
  if (sessionStorage.getItem('bp-autocreate')) {
    sessionStorage.removeItem('bp-autocreate');
    setTimeout(() => $('btn-create').click(), 100);
  }
} catch (e) {}

const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) {
  roomCode = urlRoom.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  $('screen-home').hidden = true;
  $('screen-room').hidden = true;
  $('screen-loading').hidden = false; // 首个 state 到达前显示骨架屏
  $('room-code').textContent = roomCode;
  $('waiting-code').textContent = roomCode;
  setConn(false);
  connect();
}
