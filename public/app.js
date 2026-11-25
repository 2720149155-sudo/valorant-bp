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

function otherTeam(t) { return t === 'A' ? 'B' : 'A'; }

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
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function handleMsg(msg) {
  if (msg.type === 'joined') {
    roomCode = msg.code;
    myTeam = msg.team;
    sessionStorage.setItem(`bp-token-${msg.code}`, msg.token);
    const url = new URL(location.href);
    url.searchParams.set('room', msg.code);
    history.replaceState(null, '', url);
    $('screen-home').hidden = true;
    $('screen-room').hidden = false;
    $('room-code').textContent = msg.code;
    $('waiting-code').textContent = msg.code;
    return;
  }
  if (msg.type === 'error') {
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

  prevPhase = st.phase;
  prevDiceRound = st.diceRound;
  prevDice = { A: st.players.A.dice, B: st.players.B.dice };
  renderDisconnect();
}

function teamName(t) { return st ? st.players[t].name : TEAM_NAME[t]; }

function renderDisconnect() {
  const other = myTeam === 'A' ? 'B' : 'A';
  const disc = st && st.players[other] && !st.players[other].connected && st.phase !== 'waiting';
  if (!toastTimer) $('disc-toast').hidden = !disc;
}

/* ---------- 房主设置（等待对手） ---------- */

function fillNameInput(sectionSel) {
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

  const me = st.players[myTeam];
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
  $('order-winner-text').innerHTML = `<span style="color:${win === 'A' ? 'var(--blue)' : 'var(--red)'}">${name}</span> 掷骰获胜，可决定先禁先选或后禁后选`;
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
        card.onclick = () => send({ type: 'map', mapId: m.id });
      } else {
        card.classList.add('dimmed');
      }
    } else if (mm.status === 'banned') {
      card.classList.add('banned');
      addStamp(card, 'stamp-ban', 'BAN');
      addBottomChip(card, `${teamName(mm.by)} 禁用`);
    } else if (mm.status === 'picked') {
      card.classList.add('picked');
      addStamp(card, 'stamp-pick', 'PICK');
      addOrderBadge(card, mm.order, false);
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

function addOrderBadge(card, n, gold) {
  const b = document.createElement('div');
  b.className = 'map-order' + (gold ? ' gold' : '');
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
    name.innerHTML = `<b>${m.zh}</b><span>${m.en} · ${m.sites}</span>`;
    row.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'rr-meta';
    let by = '';
    if (mm.status === 'picked') by = `${teamName(mm.by)} 选图`;
    else if (mm.status === 'match') by = '六禁一剩';
    else by = '剩余决胜';
    let sidesHtml = '';
    if (mm.side) {
      const atk = mm.side === 'attack' ? mm.sideBy : otherTeam(mm.sideBy);
      const def = otherTeam(atk);
      sidesHtml = `<span class="rr-chip rr-atk">进攻 · ${teamName(atk)}</span><span class="rr-chip rr-def">防守 · ${teamName(def)}</span>`;
    } else if (mm.status === 'decider') {
      sidesHtml = `<span class="rr-chip rr-knife">开局阵营由比赛内刀局决定</span>`;
    }
    meta.innerHTML = `<div class="rr-by">${by}</div><div class="rr-sides">${sidesHtml}</div>`;
    row.appendChild(meta);

    list.appendChild(row);
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
  if (st && st.phase === 'dice' && !st.players[myTeam].rolled) {
    startDiceAnim(myTeam);
    send({ type: 'roll' });
  }
}
$('btn-roll').onclick = tryRoll;
$('dice-a').onclick = () => { if (myTeam === 'A') tryRoll(); };
$('dice-b').onclick = () => { if (myTeam === 'B') tryRoll(); };

document.querySelectorAll('.side-btn').forEach(b => {
  b.onclick = () => send({ type: 'side', side: b.dataset.side });
});

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

const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) {
  roomCode = urlRoom.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  $('screen-home').hidden = true;
  $('screen-room').hidden = false;
  $('room-code').textContent = roomCode;
  $('waiting-code').textContent = roomCode;
  setConn(false);
  connect();
}
