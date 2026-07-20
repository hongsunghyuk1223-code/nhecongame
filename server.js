const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

// 같은 와이파이의 다른 기기가 접속할 수 있는 이 컴퓨터의 IP 목록
function getLanIPs() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name]) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 브라우저가 옛 화면을 캐시하지 않도록(수정사항이 새로고침에 바로 반영되게)
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store, must-revalidate'),
}));

// 역할별 참여 링크: /manage = 관리자 입장 화면, /player = 참가자 입장 화면
app.get(['/manage', '/player'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const CONFIG = {
  START_MONEY: 10000,
  INTEREST_RATE: 0.20,
  MAX_HP: 3,             // 이동에 쓰는 체력(행동마다 1 소모, 0이면 한 턴 휴식 후 회복)
  MOVE_STEP: 20,         // 방향키 한 번에 움직이는 거리(px)
  MAP_WIDTH: 1200,       // 넓은 맵 (화면에 한 번에 안 들어와도 됨)
  MAP_HEIGHT: 880,
};

// 마을(town): 직선 격자 도시 블록 구조 — 세로 산책로 x=395/805, 가로 산책로 y=310/580,
// 블록마다 건물 1개(자기 부지 포함), 가운데 블록은 분수 광장 (아이소 도시 레퍼런스)
const TOWN_ZONES = [
  { id: 'mart',       type: 'shop',  name: '대형마트',   x: 30,  y: 70,  w: 330, h: 220 }, // 왼쪽 위 블록 (간판이 맵 위로 안 잘리게)
  { id: 'house',      type: 'house', name: '집',         x: 425, y: 45,  w: 250, h: 235 }, // 가운데 위 블록
  { id: 'market',     type: 'shop',  name: '전통시장',   x: 830, y: 35,  w: 310, h: 250 }, // 오른쪽 위 블록
  { id: 'bank',       type: 'bank',  name: '디지털 은행', x: 55,  y: 330, w: 290, h: 240 }, // 왼쪽 가운데 블록
  { id: 'cvs',        type: 'shop',  name: '편의점',     x: 860, y: 330, w: 280, h: 240 }, // 오른쪽 가운데 블록
  { id: 'restaurant', type: 'shop',  name: '푸드코트',   x: 430, y: 590, w: 270, h: 240 }, // 가운데 아래 블록
];
const MAPS = {
  town: { width: CONFIG.MAP_WIDTH, height: CONFIG.MAP_HEIGHT, zones: TOWN_ZONES },
};
const SHOP_IDS = ['mart', 'market', 'cvs', 'restaurant'];
const ACTIONABLE_TYPES = ['shop', 'bank', 'house'];

// 상점별 기본 판매 물건 (setup 단계에서 아이들이 추가·삭제·변경 가능)
// category: need(꼭 필요) | want(있으면 좋음) | impulse(충동구매)
const DEFAULT_SHOP_ITEMS = {
  mart: [
    { name: '생수 6병',     price: 3000,  category: 'need' },
    { name: '라면 5개입',   price: 4000,  category: 'need' },
    { name: '과자 세트',    price: 3500,  category: 'want' },
    { name: '아이스크림',   price: 1500,  category: 'want' },
    { name: '장난감 자동차', price: 12000, category: 'impulse' },
  ],
  market: [
    { name: '사과 5개',     price: 5000,  category: 'need' },
    { name: '고구마 1봉',   price: 4000,  category: 'need' },
    { name: '어묵 한 줄',   price: 1500,  category: 'want' },
    { name: '호떡',         price: 1000,  category: 'want' },
    { name: '장난감 팽이',  price: 6000,  category: 'impulse' },
  ],
  cvs: [
    { name: '삼각김밥',     price: 1200,  category: 'need' },
    { name: '우유',         price: 1500,  category: 'need' },
    { name: '음료수',       price: 2000,  category: 'want' },
    { name: '젤리',         price: 1500,  category: 'want' },
    { name: '한정판 스티커', price: 4000,  category: 'impulse' },
  ],
  restaurant: [
    { name: '김밥 한 줄',   price: 3000,  category: 'need' },
    { name: '우동',         price: 5000,  category: 'need' },
    { name: '떡볶이',       price: 4000,  category: 'want' },
    { name: '치즈 핫도그',  price: 3500,  category: 'want' },
    { name: '딸기 파르페',  price: 7000,  category: 'impulse' },
  ],
};
const CATEGORIES = ['need', 'want', 'impulse'];

let itemCounter = 0;
function newItemId() { return 'it' + (++itemCounter); }
function buildDefaultShopItems() {
  const out = {};
  for (const [shopId, list] of Object.entries(DEFAULT_SHOP_ITEMS)) {
    out[shopId] = list.map(it => ({ id: newItemId(), ...it }));
  }
  return out;
}
let shopItems = buildDefaultShopItems();

// 매 턴 시작 시 그 차례의 플레이어에게 무작위로 하나 발생
// amount: 돈 변화, hp: 체력 변화(숫자) 또는 'full'(전부 회복)
const EVENTS = [
  { text: '학용품을 잃어버렸어요! 다시 사느라 150원을 썼습니다.', amount: -150 },
  { text: '친구 생일 선물을 깜빡했어요. 100원을 썼습니다.',        amount: -100 },
  { text: '길에서 100원을 주웠어요! 운이 좋네요.',                  amount: 100  },
  { text: '심부름을 도와드리고 용돈 200원을 받았어요!',             amount: 200  },
  { text: '친구들과 신나게 뛰어놀아 기운이 솟았어요! 체력을 모두 회복합니다.', hp: 'full' },
  { text: '감기 기운이 있어 체력을 하나 잃었어요...',               hp: -1 },
];

// 선택 가능한 캐릭터 목록 (시각적 디자인은 클라이언트에서 그립니다)
const ANIMALS = [
  { id: 'dog',      name: '강아지' },
  { id: 'cat',      name: '고양이' },
  { id: 'rabbit',   name: '토끼'   },
  { id: 'lion',     name: '사자'   },
  { id: 'bear',     name: '곰'     },
  { id: 'panda',    name: '판다'   },
  { id: 'monkey',   name: '원숭이' },
  { id: 'tiger',    name: '호랑이' },
  { id: 'elephant', name: '코끼리' },
];

let gameState = {
  phase: 'lobby',        // lobby(대기) | selecting(캐릭터) | setup(상점) | playing | over
  requiredPlayers: 2,
  round: 1,
  bankOpen: false,
  turnOrder: [],
  currentTurnIdx: 0,
  adminId: null,         // 관리자(진행자) 소켓 id — 플레이어가 아님
};
let adminToken = null;   // 관리자 새로고침 재접속용

const players = {};      // 실제 플레이어들(관리자 제외)

// 특정 맵에서 좌표가 들어있는 구역(건물)을 찾음
function zoneAt(mapId, x, y) {
  const m = MAPS[mapId] || MAPS.town;
  return m.zones.find(z => x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) || null;
}
const COLORS = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#34495e'];

function spawnPlayer(id, name, colorIdx) {
  return {
    id,
    name,
    zoneId: null,
    x: CONFIG.MAP_WIDTH / 2,
    y: CONFIG.MAP_HEIGHT / 2,
    color: COLORS[colorIdx % COLORS.length],
    token: null,           // 새로고침 후 재접속 식별용
    connected: true,       // 접속 상태 (false면 새로고침/이탈로 잠시 끊김)
    map: 'town',           // 학교 맵 제거 — 모두 마을에서 시작
    character: null,       // 선택한 동물 id (캐릭터 선택 화면에서 결정)
    dir: 'down',           // 바라보는 방향: up | down | left | right
    money: CONFIG.START_MONEY,
    savings: 0,
    hp: CONFIG.MAX_HP,     // 이동 체력
    freePass: false,       // 부모님 찬스: 다음 구매 1회 무료
    bought: [],
    hasMovedThisTurn: false,
  };
}

// 집(우리 집)에 도착했을 때 일어나는 일 (확률 분포는 아래 주석 참고)
function houseOutcome(p) {
  const r = Math.random();
  if (r < 0.50) {
    // 용돈 받기(50%): 활동은 균일, 금액은 3000(50%)/5000(40%)/10000(10%)
    const activities = ['설거지', '청소', '식사 준비'];
    const act = activities[Math.floor(Math.random() * activities.length)];
    const pr = Math.random();
    const amount = pr < 0.5 ? 3000 : (pr < 0.9 ? 5000 : 10000);
    p.money += amount;
    return { type: 'money', text: `${act}를 도와드려 용돈 ${amount.toLocaleString()}원을 받았어요!` };
  } else if (r < 0.70) {
    // 휴식(20%)
    p.hp = CONFIG.MAX_HP;
    return { type: 'rest', text: '집에서 푹 쉬어서 HP가 모두 회복되었어요!' };
  } else if (r < 0.90) {
    // 숙제(20%)
    p.hp = Math.max(0, p.hp - 1);
    return { type: 'homework', text: '숙제를 하느라 HP를 하나 소모했어요.' };
  } else {
    // 부모님 찬스(10%)
    p.freePass = true;
    return { type: 'freepass', text: '부모님 찬스를 획득했어요! 다음 물건 구매를 무료로 할 수 있어요.' };
  }
}

// 게임 시작 시 모든 플레이어를 광장(분수 앞)에 겹치지 않게 균일 배치
function placePlayersAtStart() {
  const ids = gameState.turnOrder, n = ids.length;
  if (!n) return;
  const cols = Math.min(n, 4), rows = Math.ceil(n / cols);
  ids.forEach((id, i) => {
    const p = players[id];
    if (!p) return;
    const col = i % cols, row = Math.floor(i / cols);
    const colsInRow = (row === rows - 1) ? (n - cols * (rows - 1)) : cols;
    p.map = 'town';
    p.x = 600 + (col - (colsInRow - 1) / 2) * 64;
    p.y = 486 + row * 48;                        // 광장 분수 아래쪽
    p.zoneId = null;
    p.dir = 'down';
  });
}

function currentPlayerId() {
  if (!gameState.turnOrder.length) return null;
  return gameState.turnOrder[gameState.currentTurnIdx % gameState.turnOrder.length];
}

// 턴 시작 이벤트: 차례가 된 플레이어에게 무작위 이벤트를 적용하고 모두에게 알림
function triggerTurnEvent(playerId) {
  const p = players[playerId];
  if (!p) return;
  const ev = EVENTS[Math.floor(Math.random() * EVENTS.length)];
  if (typeof ev.amount === 'number') p.money = Math.max(0, p.money + ev.amount);
  if (ev.hp === 'full') p.hp = CONFIG.MAX_HP;
  else if (typeof ev.hp === 'number') p.hp = Math.max(0, Math.min(CONFIG.MAX_HP, p.hp + ev.hp));
  const sock = io.sockets.sockets.get(playerId);
  if (sock) sock.emit('eventTriggered', ev);
  io.emit('notice', `❗ ${p.name}: ${ev.text}`);
}

function broadcastState() {
  io.emit('state', { players, gameState, shopItems });
}

function allCharactersChosen() {
  const ids = Object.keys(players);
  return ids.length > 0 && ids.every(id => players[id].character);
}

function isAdmin(id) { return !!gameState.adminId && id === gameState.adminId; }

// 아직 캐릭터를 안 고른 플레이어에게 남은 동물을 무작위로 배정
function assignRandomCharacters() {
  const used = new Set(Object.values(players).map(p => p.character).filter(Boolean));
  const pool = ANIMALS.map(a => a.id).filter(id => !used.has(id));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  Object.values(players).forEach(p => { if (!p.character) p.character = pool.pop() || ANIMALS[0].id; });
}

function startGame() {
  gameState.phase = 'playing';
  gameState.turnOrder = Object.keys(players);
  gameState.currentTurnIdx = 0;
  Object.values(players).forEach(p => {
    p.hasMovedThisTurn = false;
    p.hp = CONFIG.MAX_HP;
    p.freePass = false;
  });
  placePlayersAtStart();
  const firstName = players[gameState.turnOrder[0]]?.name;
  io.emit('notice', `게임 시작! ${firstName}님의 첫 번째 차례입니다. (광장에서 출발 — 방향키로 원하는 건물까지 이동!)`);
  triggerTurnEvent(gameState.turnOrder[0]);
  broadcastState();
}

// 다음 차례로 넘기기 (턴 종료/건너뛰기 공통).
// 체력이 0인 플레이어는 이번 턴을 '휴식'으로 건너뛰고 체력을 모두 회복.
function passTurn() {
  const n = gameState.turnOrder.length;
  if (n === 0) return;
  for (let step = 0; step <= n; step++) {
    gameState.currentTurnIdx++;
    if (gameState.currentTurnIdx % n === 0) {
      gameState.round++;
      if (gameState.round === 2 && !gameState.bankOpen) {
        gameState.bankOpen = true;
        io.emit('notice', `🏦 라운드 ${gameState.round} 시작! 디지털 은행이 열렸습니다.`);
      } else {
        io.emit('notice', `라운드 ${gameState.round} 시작!`);
      }
    }
    const cur = players[currentPlayerId()];
    if (cur && cur.hp <= 0) {
      // 체력 없음 → 이번 턴 휴식하고 체력 회복, 다음 사람에게 넘김
      cur.hp = CONFIG.MAX_HP;
      cur.hasMovedThisTurn = false;
      io.emit('notice', `😴 ${cur.name}님은 체력이 없어 이번 턴은 휴식! 체력이 모두 회복됐어요.`);
      continue;
    }
    io.emit('notice', `${cur ? cur.name : '?'}님의 차례입니다!`);
    if (cur) triggerTurnEvent(cur.id);
    return;
  }
}

io.on('connection', (socket) => {
  console.log('접속:', socket.id);
  socket.emit('init', { maps: MAPS, config: CONFIG, animals: ANIMALS, shopIds: SHOP_IDS, categories: CATEGORIES, shopItems });
  socket.emit('state', { players, gameState, shopItems });   // 접속 즉시 현재 상태 전달(기본 로비로 보이는 문제 방지)

  // ── 관리자(진행자)로 입장 ──
  socket.on('joinAdmin', ({ requiredPlayers, token }) => {
    if (gameState.adminId && gameState.adminId !== socket.id) {
      if (adminToken && token && token === adminToken) {
        gameState.adminId = socket.id;          // 같은 사람의 재접속 → 관리자 자리 이전
      } else {
        socket.emit('joinDenied', '이미 관리자가 있어요. 참가자로 입장해주세요.');
        return;
      }
    } else {
      gameState.adminId = socket.id;
    }
    if (token) adminToken = token;
    if (requiredPlayers != null) {
      gameState.requiredPlayers = Math.max(1, Math.min(8, parseInt(requiredPlayers) || 2));
    }
    socket.emit('roleAssigned', 'admin');
    broadcastState();
  });

  // ── 참가자로 입장 ──
  socket.on('join', ({ name, token }) => {
    if (gameState.phase !== 'lobby' && gameState.phase !== 'selecting') {
      socket.emit('joinDenied', '지금은 입장할 수 없어요.');
      return;
    }
    if (players[socket.id]) { broadcastState(); return; }
    const colorIdx = Object.keys(players).length;
    const p = spawnPlayer(socket.id, name || '대원', colorIdx);
    p.token = token || null;
    players[socket.id] = p;
    socket.emit('roleAssigned', 'player');
    broadcastState();
  });

  // ── 새로고침 후 재접속 (관리자/참가자 모두) ──
  socket.on('rejoin', ({ token, name, character }) => {
    // 관리자 재접속
    if (token && adminToken && token === adminToken) {
      gameState.adminId = socket.id;
      socket.emit('roleAssigned', 'admin');
      broadcastState();
      return;
    }
    // 참가자: 토큰으로 기존 슬롯을 새 소켓에 재바인딩 (게임 중에도 자리 복원)
    if (token) {
      const existing = Object.values(players).find(p => p.token === token);
      if (existing) {
        const oldId = existing.id;
        if (oldId !== socket.id) {
          delete players[oldId];
          existing.id = socket.id;
          players[socket.id] = existing;
          const ti = gameState.turnOrder.indexOf(oldId);
          if (ti !== -1) gameState.turnOrder[ti] = socket.id;
        }
        existing.connected = true;
        socket.emit('roleAssigned', 'player');
        broadcastState();
        return;
      }
    }
    // 기존 자리 없음
    if (gameState.phase !== 'lobby' && gameState.phase !== 'selecting') {
      socket.emit('joinDenied', '게임이 이미 진행 중입니다. 다시 입장해주세요.');
      return;
    }
    // 대기/선택 단계: 새 참가자로 추가하고 고른 캐릭터 복원
    const colorIdx = Object.keys(players).length;
    const p = spawnPlayer(socket.id, name || '대원', colorIdx);
    p.token = token || null;
    if (character && ANIMALS.find(a => a.id === character)) {
      const taken = Object.values(players).some(o => o.character === character);
      if (!taken) p.character = character;
    }
    players[socket.id] = p;
    socket.emit('roleAssigned', 'player');
    broadcastState();
  });

  // ── 캐릭터 선택 (선택 단계, 중복 불가) ──
  socket.on('selectCharacter', (animalId) => {
    if (gameState.phase !== 'selecting') return;
    const p = players[socket.id];
    if (!p) return;
    if (animalId === null) { p.character = null; broadcastState(); return; }
    if (!ANIMALS.find(a => a.id === animalId)) return;
    const takenByOther = Object.values(players).some(o => o.id !== socket.id && o.character === animalId);
    if (takenByOther) { socket.emit('notice', '이미 다른 친구가 고른 캐릭터예요.'); return; }
    p.character = animalId;
    broadcastState();
  });

  // ── 방향키/WASD 이동 (한 칸씩) ──
  socket.on('move', (dir) => {
    if (gameState.phase !== 'playing') return;
    if (socket.id !== currentPlayerId()) return;     // 내 차례 아니면 이동 불가(조용히 무시)
    const p = players[socket.id];
    if (!p || p.hasMovedThisTurn) return;            // 이미 행동했으면 이동 잠금
    const map = MAPS[p.map] || MAPS.town;
    const step = CONFIG.MOVE_STEP;
    let nx = p.x, ny = p.y;
    if (dir === 'up') ny -= step; else if (dir === 'down') ny += step;
    else if (dir === 'left') nx -= step; else if (dir === 'right') nx += step; else return;
    p.dir = dir;
    p.x = Math.max(24, Math.min(map.width - 24, nx));
    p.y = Math.max(40, Math.min(map.height - 24, ny));
    const z = zoneAt(p.map, p.x, p.y);
    if (z && z.type === 'portal' && z.target) {
      // 포털(정문)에 닿으면 다른 맵으로 전환 (ZEP식 방 이동)
      p.map = z.target.map;
      p.x = z.target.x;
      p.y = z.target.y;
      p.zoneId = null;
      socket.emit('notice', z.target.map === 'town' ? '🚪 마을에 도착했어요!' : '🚪 학교로 돌아왔어요!');
    } else {
      p.zoneId = z ? z.id : null;
    }
    broadcastState();
  });

  // ── 현재 서 있는 건물에서 행동하기 ──
  socket.on('act', () => {
    if (gameState.phase !== 'playing') return;
    if (socket.id !== currentPlayerId()) { socket.emit('notice', '지금은 내 차례가 아니에요!'); return; }
    const p = players[socket.id];
    if (!p) return;
    if (p.hasMovedThisTurn) { socket.emit('notice', '이미 행동했어요. 턴을 종료하세요.'); return; }
    if (p.hp <= 0) { socket.emit('notice', '체력이 없어요. 턴을 종료하면 다음에 회복돼요.'); return; }
    const zone = zoneAt(p.map, p.x, p.y);
    if (!zone || !ACTIONABLE_TYPES.includes(zone.type)) {
      socket.emit('notice', '여기선 행동할 게 없어요. 마을의 건물 칸으로 이동하세요.'); return;
    }

    // 건물 가운데로 정렬하고 행동 확정 (체력 1 소모)
    p.x = zone.x + zone.w / 2;
    p.y = zone.y + zone.h / 2;
    p.zoneId = zone.id;
    p.hasMovedThisTurn = true;
    p.hp = Math.max(0, p.hp - 1);
    broadcastState();

    if (zone.type === 'house') {
      const out = houseOutcome(p);
      socket.emit('houseEvent', out);
      broadcastState();
    } else {
      socket.emit('zoneEntered', { zone });
    }
  });

  // ── 턴 종료 ──
  socket.on('endTurn', () => {
    if (gameState.phase !== 'playing') return;
    if (socket.id !== currentPlayerId()) return;
    const p = players[socket.id];
    if (!p) return;
    // 턴 시작 이벤트로 체력이 0이 되면 행동 없이도 턴 종료 가능
    if (!p.hasMovedThisTurn && p.hp > 0) {
      socket.emit('notice', "먼저 건물 칸으로 이동해서 '행동하기'를 누르세요!");
      return;
    }
    p.hasMovedThisTurn = false;
    passTurn();
    broadcastState();
  });

  // ── 구매 (상점에서 '행동하기'를 누른 뒤에만 가능) ──
  socket.on('buy', ({ shopId, itemId }) => {
    if (gameState.phase !== 'playing') return;
    if (socket.id !== currentPlayerId()) { socket.emit('notice', '내 차례에만 구매할 수 있어요.'); return; }
    const p = players[socket.id];
    if (!p || p.zoneId !== shopId || !p.hasMovedThisTurn) {
      socket.emit('notice', "상점 칸에서 '행동하기'를 먼저 눌러주세요."); return;
    }
    const list = shopItems[shopId];
    if (!list) return;
    const item = list.find(i => i.id === itemId);
    if (!item) { socket.emit('notice', '그 물건은 지금 없어요.'); return; }
    const usedFreePass = p.freePass && item.price > 0;
    const cost = usedFreePass ? 0 : item.price;
    if (p.money < cost) { socket.emit('notice', '돈이 부족해요!'); return; }
    p.money -= cost;
    if (usedFreePass) p.freePass = false;
    p.bought.push({ id: item.id, name: item.name, price: item.price, paid: cost, category: item.category, shopId });
    socket.emit('notice', usedFreePass
      ? `🎟️ 부모님 찬스로 '${item.name}'을(를) 무료로 샀어요!`
      : `'${item.name}'을(를) ${item.price.toLocaleString()}원에 샀어요!`);
    broadcastState();
  });

  // ── 저축 / 출금 (은행에서 '행동하기'를 누른 뒤에만) ──
  socket.on('save', (amount) => {
    const p = players[socket.id];
    if (!p || p.zoneId !== 'bank' || !p.hasMovedThisTurn) { socket.emit('notice', "은행 칸에서 '행동하기'를 먼저 눌러주세요."); return; }
    if (!gameState.bankOpen) { socket.emit('notice', '은행은 라운드 2부터 열려요.'); return; }
    amount = parseInt(amount);
    if (isNaN(amount) || amount <= 0 || amount > p.money) { socket.emit('notice', '금액을 다시 확인하세요.'); return; }
    p.money -= amount; p.savings += amount;
    socket.emit('notice', `${amount.toLocaleString()}원을 저축했어요!`);
    broadcastState();
  });

  socket.on('withdraw', (amount) => {
    const p = players[socket.id];
    if (!p || p.zoneId !== 'bank' || !p.hasMovedThisTurn) { socket.emit('notice', "은행 칸에서 '행동하기'를 먼저 눌러주세요."); return; }
    amount = parseInt(amount);
    if (isNaN(amount) || amount <= 0 || amount > p.savings) { socket.emit('notice', '금액을 다시 확인하세요.'); return; }
    p.savings -= amount; p.money += amount;
    socket.emit('notice', `${amount.toLocaleString()}원을 출금했어요!`);
    broadcastState();
  });

  // ── 상점 물건 설정 (setup 단계, 관리자만) ──
  socket.on('shop:addItem', ({ shopId, name, price, category }) => {
    if (gameState.phase !== 'setup' || !isAdmin(socket.id)) return;
    if (!shopItems[shopId]) return;
    name = String(name || '').trim().slice(0, 20);
    price = parseInt(price);
    if (!name || isNaN(price) || price <= 0) { socket.emit('notice', '이름과 올바른 가격을 입력하세요.'); return; }
    if (!CATEGORIES.includes(category)) category = 'need';
    if (shopItems[shopId].length >= 12) { socket.emit('notice', '한 상점에는 최대 12개까지예요.'); return; }
    shopItems[shopId].push({ id: newItemId(), name, price, category });
    broadcastState();
  });

  socket.on('shop:removeItem', ({ shopId, itemId }) => {
    if (gameState.phase !== 'setup' || !isAdmin(socket.id)) return;
    if (!shopItems[shopId]) return;
    shopItems[shopId] = shopItems[shopId].filter(i => i.id !== itemId);
    broadcastState();
  });

  socket.on('shop:resetDefaults', () => {
    if (gameState.phase !== 'setup' || !isAdmin(socket.id)) return;
    shopItems = buildDefaultShopItems();
    io.emit('notice', '상점 물건을 기본값으로 되돌렸어요.');
    broadcastState();
  });

  // ── 관리자 전용: 단계 진행 ──
  socket.on('admin:setCount', (n) => {
    if (!isAdmin(socket.id) || gameState.phase !== 'lobby') return;
    gameState.requiredPlayers = Math.max(1, Math.min(8, parseInt(n) || 2));
    broadcastState();
  });

  socket.on('admin:toSelecting', () => {
    if (!isAdmin(socket.id) || gameState.phase !== 'lobby') return;
    if (Object.keys(players).length < 1) { socket.emit('notice', '참가자가 한 명 이상 있어야 해요.'); return; }
    gameState.phase = 'selecting';
    io.emit('notice', '🎭 캐릭터를 선택해주세요!');
    broadcastState();
  });

  socket.on('admin:toSetup', () => {
    if (!isAdmin(socket.id) || gameState.phase !== 'selecting') return;
    assignRandomCharacters();   // 안 고른 사람은 무작위 배정
    gameState.phase = 'setup';
    io.emit('notice', '🛒 관리자가 상점 물건을 정하고 있어요.');
    broadcastState();
  });

  socket.on('admin:startGame', () => {
    if (!isAdmin(socket.id) || gameState.phase !== 'setup') return;
    startGame();
  });

  socket.on('admin:nextRound', () => {
    if (!isAdmin(socket.id)) return;
    gameState.round = Math.max(2, gameState.round);
    gameState.bankOpen = true;
    io.emit('notice', '🏦 디지털 은행이 문을 열었습니다!');
    broadcastState();
  });

  socket.on('admin:skipTurn', () => {
    if (!isAdmin(socket.id) || gameState.phase !== 'playing' || gameState.turnOrder.length === 0) return;
    const cur = players[currentPlayerId()];
    if (cur) cur.hasMovedThisTurn = false;
    passTurn();
    broadcastState();
  });

  socket.on('admin:finish', () => {
    if (!isAdmin(socket.id)) return;
    gameState.phase = 'over';
    const ranking = Object.values(players).map(p => {
      const interest = Math.round(p.savings * CONFIG.INTEREST_RATE);
      return { name: p.name, money: p.money, savings: p.savings, interest, total: p.money + p.savings + interest };
    }).sort((a, b) => b.total - a.total);
    io.emit('gameOver', ranking);
    broadcastState();
  });

  socket.on('admin:reset', () => {
    if (!isAdmin(socket.id)) return;
    const keepReq = gameState.requiredPlayers, keepAdmin = gameState.adminId;
    gameState = { phase: 'lobby', requiredPlayers: keepReq, round: 1, bankOpen: false, turnOrder: [], currentTurnIdx: 0, adminId: keepAdmin };
    shopItems = buildDefaultShopItems();
    for (const id in players) delete players[id];
    io.emit('reset');       // 참가자들은 입장 화면으로 (관리자는 그대로 유지)
    broadcastState();
  });

  socket.on('disconnect', () => {
    if (socket.id === gameState.adminId) {
      // 관리자 끊김: 자리(adminId)는 비우되 토큰은 유지 → 새로고침 시 복구. 게임은 계속.
      gameState.adminId = null;
      broadcastState();
      console.log('관리자 접속 끊김:', socket.id);
      return;
    }
    const p = players[socket.id];
    if (!p) return;
    if (gameState.phase === 'lobby' || gameState.phase === 'selecting') {
      delete players[socket.id];    // 대기/선택 단계: 슬롯 제거
      broadcastState();
      console.log('접속 해제(대기):', socket.id);
      return;
    }
    p.connected = false;            // 게임 중: 자리 유지, 끊김 표시
    broadcastState();
    console.log('접속 끊김(자리 유지):', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
// '0.0.0.0' = 같은 와이파이의 다른 기기(다른 노트북)에서도 접속 가능하게 모든 네트워크에서 수신
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n========================================`);
  console.log(`  슬기로운 용돈 생활 서버 실행 중!`);
  console.log(`  [관리자] 이 컴퓨터:  http://localhost:${PORT}/manage`);
  const ips = getLanIPs();
  ips.forEach(ip => {
    console.log(`  [참가자] 다른 노트북: http://${ip}:${PORT}/player`);
  });
  console.log(`  (공통 입장 화면:      http://localhost:${PORT})`);
  console.log(`========================================\n`);
});
