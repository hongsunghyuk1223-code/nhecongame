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
  START_MONEY: 13000,
  INTEREST_RATE: 0.10,   // 은행 저축 턴당 복리 금리 10% (자기 차례마다 붙음)
  MOVE_STEP: 20,         // 방향키 한 번에 움직이는 거리(px)
  MAP_WIDTH: 1900,       // 넓은 아이소 마름모 지형 — 한 화면보다 커서 카메라가 따라 스크롤
  MAP_HEIGHT: 1400,
  DISCUSSION_SECONDS: parseInt(process.env.DISCUSSION_SECONDS) || 300, // 게임 시작 전 상의(작전) 시간(5분)
  TARGET_UTILITY: 20,    // 이 효용 점수를 먼저 채우는 팀이 나오면 게임 종료(관리자가 조절 가능)
};

// 아이소 마름모(다이아몬드) 지형: 논리좌표 (u,v)∈[0,1] → 화면좌표. (클라 배경도 동일 식 사용)
//   u = 위꼭짓점→오른꼭짓점, v = 위꼭짓점→왼꼭짓점
const DIA = { cx: CONFIG.MAP_WIDTH / 2, cy: CONFIG.MAP_HEIGHT * 0.49,
              rx: CONFIG.MAP_WIDTH * 0.47, ry: CONFIG.MAP_WIDTH * 0.47 * 0.5 };
function isoP(u, v) { return [DIA.cx + DIA.rx * (u - v), DIA.cy + DIA.ry * (u + v - 1)]; }
function diaZone(id, type, name, u, v, w, h) {
  const [sx, sy] = isoP(u, v);
  return { id, type, name, x: Math.round(sx - w / 2), y: Math.round(sy - h * 0.58), w, h };
}
// 마을(town): 아이소 마름모 위에 대각 십자 도로로 나뉜 자리에 건물 6개 (레퍼런스 아이소 시티)
const TOWN_ZONES = [
  diaZone('mart',       'shop',  '대형마트',   0.20, 0.20, 420, 290), // 위 꼭짓점 쪽(가장 큼)
  diaZone('bank',       'bank',  '디지털 은행', 0.62, 0.10, 300, 280), // 오른쪽 위
  diaZone('house',      'house', '집',         0.14, 0.58, 310, 280), // 왼쪽 위
  diaZone('cvs',        'shop',  '편의점',     0.86, 0.44, 300, 280), // 오른쪽 아래
  diaZone('market',     'shop',  '전통시장',   0.52, 0.90, 360, 290), // 아래 꼭짓점 쪽
  diaZone('restaurant', 'shop',  '푸드코트',   0.80, 0.80, 320, 290), // 오른쪽 아래 꼭짓점 쪽
];
const MAPS = {
  town: { width: CONFIG.MAP_WIDTH, height: CONFIG.MAP_HEIGHT, zones: TOWN_ZONES },
};
const SHOP_IDS = ['mart', 'market', 'cvs', 'restaurant'];
const ACTIONABLE_TYPES = ['shop', 'bank', 'house'];

// 상점별 판매 물건: 이름·가격 고정(총 16개). 관리자가 추가/삭제/가격조정 불가 — 매 게임 동일.
const DEFAULT_SHOP_ITEMS = {
  mart: [
    { name: '말랑이',   price: 5000 },
    { name: '게임기',   price: 30000 },
    { name: '만화책',   price: 6000 },
    { name: '소고기',   price: 25000 },
  ],
  market: [
    { name: '떡볶이',   price: 4000 },
    { name: '솜사탕',   price: 3000 },
    { name: '꽃게',     price: 30000 },
    { name: '수박',     price: 20000 },
  ],
  cvs: [
    { name: '음료수',       price: 2000 },
    { name: '아이스크림',   price: 2000 },
    { name: '캐릭터 스티커', price: 2000 },
    { name: '묶음 과자',    price: 5000 },
  ],
  restaurant: [
    { name: '돈가스',   price: 11000 },
    { name: '햄버거',   price: 8000 },
    { name: '짜장면',   price: 8000 },
    { name: '스파게티', price: 11000 },
  ],
};

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

// 팀별 효용(1~4점) { [playerId]: { [itemId]: score } } — 물건마다 팀이 자유롭게 매김(쿼터 없음)
let utilities = {};
const SCORES = [1, 2, 3, 4];
const SCORE_LABELS = { 1: '그럭저럭', 2: '좋아요', 3: '너무 좋아요', 4: '꼭 필요해요' };

let gameState = {
  phase: 'lobby',        // lobby | selecting | utility | discussion | playing | over
  requiredPlayers: 2,
  round: 1,
  bankOpen: true,        // 은행: 처음부터 개방(저축/이자 사용 가능)
  turnOrder: [],
  currentTurnIdx: 0,
  adminId: null,         // 관리자(진행자) 소켓 id — 플레이어가 아님
  discussionStartedAt: 0,// 상의(작전) 시간 시작 시각
  targetUtility: CONFIG.TARGET_UTILITY, // 이 효용 점수를 먼저 채우면 게임 종료(관리자가 게임 시작 전 조절 가능)
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
    map: 'town',
    character: null,       // 선택한 동물 id (캐릭터 선택 화면에서 결정)
    dir: 'down',           // 바라보는 방향: up | down | left | right
    money: CONFIG.START_MONEY,
    savings: 0,
    bought: [],
    hasMovedThisTurn: false,
  };
}

// 집(우리 집) 방문 = 용돈 받기. 3000(50%)/6500(40%)/13000(10%) 중 하나.
function houseVisit(p) {
  const pr = Math.random();
  const amount = pr < 0.5 ? 4000 : (pr < 0.9 ? 6500 : 13000);
  p.money += amount;
  return `부모님을 도와드리고 용돈 ${amount.toLocaleString()}원을 받았어요!`;
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
    p.x = DIA.cx + (col - (colsInRow - 1) / 2) * 64;   // 마름모 중앙(십자 도로 교차점) 근처
    p.y = DIA.cy + 40 + row * 48;
    p.zoneId = null;
    p.dir = 'down';
  });
}

function currentPlayerId() {
  if (!gameState.turnOrder.length) return null;
  return gameState.turnOrder[gameState.currentTurnIdx % gameState.turnOrder.length];
}

function broadcastState() {
  io.emit('state', { players, gameState, shopItems, utilities });
}

// 배열을 무작위로 섞음(Fisher-Yates) — 원본을 바꾸고 그대로 반환
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; }

// 전체 물품을 상점 순서대로 펼친 목록 (효용 단계에서 사용)
function allItems() {
  const out = [];
  for (const shopId of SHOP_IDS) (shopItems[shopId] || []).forEach(it => out.push({ ...it, shopId }));
  return out;
}

// 한 팀이 모든 물품에 효용 점수(1~4)를 다 매겼는지
function utilityDone(playerId) {
  const mine = utilities[playerId] || {};
  return allItems().every(it => mine[it.id] != null);
}

// 한 팀이 지금까지 산 물건들의 효용 점수 합 (게임 종료 조건에 사용)
function totalUtility(p) {
  const mine = utilities[p.id] || {};
  return (p.bought || []).reduce((s, b) => s + (mine[b.id] || 0), 0);
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
  // 팀 순서는 상의 시간 시작 시점(admin:toDiscussion / admin:restartRound)에 이미 무작위로 정해서
  // 보여줬음 — 게임 시작 시점엔 다시 섞지 않고 그대로 씀(상의 시간에 본 순서와 달라지면 안 되니까).
  gameState.currentTurnIdx = 0;
  Object.values(players).forEach(p => { p.hasMovedThisTurn = false; });
  // 물품별 한정 수량은 상의 시간 시작 시점(admin:toDiscussion / admin:restartRound)에 이미 정해둠 —
  // 팀들이 상의 시간에 재고까지 보고 계획을 짤 수 있도록, 게임 시작 시점엔 다시 섞지 않음.
  placePlayersAtStart();
  const first = players[gameState.turnOrder[0]];
  io.emit('notice', `게임 시작! ${first?.name}님의 첫 번째 차례입니다. (광장에서 출발 — 방향키로 원하는 건물까지 이동!)`);
  broadcastState();
}

// 다음 차례로 넘기기 (턴 종료/건너뛰기 공통). 시간·횟수 제한 없이 계속 순서대로 돌아감.
function passTurn() {
  const n = gameState.turnOrder.length;
  if (n === 0) return;
  gameState.currentTurnIdx = (gameState.currentTurnIdx + 1) % n;
  const cur = players[currentPlayerId()];
  // 자기 차례가 돌아올 때마다 저축에 복리 이자가 붙음
  if (cur && cur.savings > 0) {
    const interest = Math.round(cur.savings * CONFIG.INTEREST_RATE);
    if (interest > 0) {
      cur.savings += interest;
      io.emit('notice', `🏦 ${cur.name}: 저축에 이자 +${interest.toLocaleString()}원! (저축 ${cur.savings.toLocaleString()}원)`);
    }
  }
  io.emit('notice', `${cur ? cur.name : '?'}님의 차례입니다!`);
}

// 물건 하나를 사거나 집에 방문하면 그 팀의 턴이 자동으로 끝난다(집 방문 한정 — 상점은 여러 개 살 수 있음).
function autoEndTurn(p) {
  if (p) p.hasMovedThisTurn = false;
  passTurn();
}

// 게임 종료: 어느 한 팀의 (산 물건들의) 효용 점수 합이 목표(targetUtility)에 먼저 도달하면 그 팀이 우승.
// winnerId 없이 호출되면(관리자가 수동 종료) 그 시점 효용 합이 가장 높은 팀이 우승.
function finishGame(winnerId) {
  gameState.phase = 'over';
  const rows = Object.values(players).map(p => ({
    id: p.id, name: p.name, color: p.color,
    utilSum: totalUtility(p),
    boughtCount: (p.bought || []).length,
    spent: (p.bought || []).reduce((s, b) => s + (b.price || 0), 0),
    savings: p.savings || 0, remaining: p.money,
  })).sort((a, b) => b.utilSum - a.utilSum);
  io.emit('gameOver', { winnerId: winnerId || (rows[0] && rows[0].id) || null, target: gameState.targetUtility, rows });
  broadcastState();
}

io.on('connection', (socket) => {
  console.log('접속:', socket.id);
  socket.emit('init', { maps: MAPS, config: CONFIG, animals: ANIMALS, shopIds: SHOP_IDS, shopItems });
  socket.emit('state', { players, gameState, shopItems, utilities });   // 접속 즉시 현재 상태 전달(기본 로비로 보이는 문제 방지)

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
          // 새로고침으로 소켓 id가 바뀌어도 팀 데이터(효용)를 그대로 이어받음
          if (utilities[oldId]) { utilities[socket.id] = utilities[oldId]; delete utilities[oldId]; }
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
  // 내 차례가 아니어도 자유롭게 돌아다니며 상점 미리보기는 가능(구매는 act가 currentPlayerId만 허용해 계속 막힘).
  socket.on('move', (dir) => {
    if (gameState.phase !== 'playing') return;
    const p = players[socket.id];
    if (!p) return;
    const isMyTurn = socket.id === currentPlayerId();
    if (isMyTurn && p.hasMovedThisTurn) return;   // 내 차례인데 이미 행동했으면 이동 잠금
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
    const zone = zoneAt(p.map, p.x, p.y);
    if (!zone || !ACTIONABLE_TYPES.includes(zone.type)) {
      socket.emit('notice', '여기선 행동할 게 없어요. 마을의 건물 칸으로 이동하세요.'); return;
    }

    // 건물 가운데로 정렬하고 행동 확정
    p.x = zone.x + zone.w / 2;
    p.y = zone.y + zone.h / 2;
    p.zoneId = zone.id;
    p.hasMovedThisTurn = true;

    if (zone.type === 'house') {
      // 집 = 용돈 받기(자동). 받고 나면 바로 턴 종료.
      const text = houseVisit(p);
      socket.emit('houseEvent', { text });
      autoEndTurn(p);
      broadcastState();
    } else {
      socket.emit('zoneEntered', { zone });
      broadcastState();
    }
  });

  // ── 턴 종료 ──
  socket.on('endTurn', () => {
    if (gameState.phase !== 'playing') return;
    if (socket.id !== currentPlayerId()) return;
    const p = players[socket.id];
    if (!p) return;
    if (!p.hasMovedThisTurn) {
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
    if ((p.bought || []).some(b => b.id === itemId)) {
      socket.emit('notice', `'${item.name}'은(는) 이미 샀어요! 같은 물건은 한 팀당 하나만 살 수 있어요.`); return;
    }

    // 한정 수량: 다 팔렸으면 구매 불가
    const left = (item.stock == null) ? Infinity : item.stock - (item.sold || 0);
    if (left <= 0) { socket.emit('notice', `'${item.name}'은(는) 다 팔렸어요!`); return; }

    const cost = item.price;
    if (p.money < cost) { socket.emit('notice', '돈이 부족해요!'); return; }
    p.money -= cost;
    item.sold = (item.sold || 0) + 1;
    p.bought.push({ id: item.id, name: item.name, price: item.price, paid: cost, shopId });
    io.emit('notice', `🛍️ ${p.name}: '${item.name}'을(를) ${item.price.toLocaleString()}원에 샀어요!`);
    if ((item.stock != null) && item.stock - item.sold <= 0) io.emit('notice', `📦 '${item.name}'이(가) 다 팔렸어요!`);
    // 한 장소(상점)에서는 여러 개를 살 수 있음 — 턴은 자동 종료하지 않고, 다 사면 '턴 종료'로 끝냄
    broadcastState();

    if (totalUtility(p) >= gameState.targetUtility) {
      io.emit('notice', `🏆 ${p.name} 팀이 목표 효용 점수 ${gameState.targetUtility}점을 채웠어요! 게임 종료!`);
      finishGame(p.id);
    }
  });

  // ── 저축 / 출금 (은행에서 '행동하기'를 누른 뒤에만) ──
  socket.on('save', (amount) => {
    const p = players[socket.id];
    if (!p || p.zoneId !== 'bank' || !p.hasMovedThisTurn) { socket.emit('notice', "은행 칸에서 '행동하기'를 먼저 눌러주세요."); return; }
    if (!gameState.bankOpen) { socket.emit('notice', '지금은 은행을 이용할 수 없어요.'); return; }
    amount = parseInt(amount);
    if (isNaN(amount) || amount <= 0 || amount > p.money) { socket.emit('notice', '금액을 다시 확인하세요.'); return; }
    p.money -= amount; p.savings += amount;
    socket.emit('notice', `${amount.toLocaleString()}원을 저축했어요! (내 차례마다 이자 ${Math.round(CONFIG.INTEREST_RATE*100)}%가 붙어요)`);
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

  // ── 관리자 전용: 단계 진행 ──
  socket.on('admin:setCount', (n) => {
    if (!isAdmin(socket.id) || gameState.phase !== 'lobby') return;
    gameState.requiredPlayers = Math.max(1, Math.min(8, parseInt(n) || 2));
    broadcastState();
  });

  // 목표 효용 점수(게임 종료 조건) 설정 — 게임이 진행 중(playing)이 아닐 때 언제든 변경 가능
  socket.on('admin:setTargetUtility', (n) => {
    if (!isAdmin(socket.id) || gameState.phase === 'playing') return;
    gameState.targetUtility = Math.max(8, Math.min(40, parseInt(n) || CONFIG.TARGET_UTILITY));
    broadcastState();
  });

  socket.on('admin:toSelecting', () => {
    if (!isAdmin(socket.id) || gameState.phase !== 'lobby') return;
    if (Object.keys(players).length < 1) { socket.emit('notice', '참가자가 한 명 이상 있어야 해요.'); return; }
    gameState.phase = 'selecting';
    io.emit('notice', '🎭 캐릭터를 선택해주세요!');
    broadcastState();
  });

  // ── 캐릭터 선택 확정 → 바로 효용 점수 매기기 단계로 (물건 목록·가격은 고정) ──
  socket.on('admin:toUtility', () => {
    if (!isAdmin(socket.id) || gameState.phase !== 'selecting') return;
    assignRandomCharacters();   // 안 고른 사람은 무작위 배정
    utilities = {};
    Object.keys(players).forEach(pid => { utilities[pid] = {}; });
    gameState.phase = 'utility';
    io.emit('notice', '⭐ 물건마다 우리 팀 마음에 드는 정도를 점수로 매겨주세요! (1~4점)');
    broadcastState();
  });

  // ── 효용 배정 (팀마다 자유롭게, 1~4점) ──
  socket.on('utility:set', ({ itemId, score }) => {
    if (gameState.phase !== 'utility') return;
    const p = players[socket.id];
    if (!p) return;
    const item = allItems().find(i => i.id === itemId);
    if (!item) return;
    if (!utilities[socket.id]) utilities[socket.id] = {};
    const mine = utilities[socket.id];
    if (score === null || score === 0) { delete mine[itemId]; broadcastState(); return; }   // 배정 취소
    score = parseInt(score);
    if (!SCORES.includes(score)) { socket.emit('notice', '1~4점 중에서 골라주세요.'); return; }
    mine[itemId] = score;
    broadcastState();
  });

  // ── 효용 확정 → 상의(작전) 시간(5분)으로 ──
  socket.on('admin:toDiscussion', () => {
    if (!isAdmin(socket.id) || gameState.phase !== 'utility') return;
    const notDone = Object.values(players).filter(p => !utilityDone(p.id)).map(p => p.name);
    if (notDone.length) { socket.emit('notice', `아직 효용을 다 못 정한 팀: ${notDone.join(', ')}`); return; }
    gameState.phase = 'discussion';
    gameState.discussionStartedAt = Date.now();
    // 상의 시간에 한정 수량까지 보고 계획을 짤 수 있도록, 재고를 게임 시작이 아니라 여기서 미리 정함.
    // (최소=팀 수의 절반-1, 최대=팀 수-1 무작위. 6팀이면 2~5개)
    const teamCount = Math.max(1, Object.keys(players).length);
    const minStock = Math.max(1, Math.floor(teamCount / 2) - 1);
    const maxStock = Math.max(minStock, teamCount - 1);
    for (const shopId of SHOP_IDS) {
      (shopItems[shopId] || []).forEach(it => {
        it.stock = minStock + Math.floor(Math.random() * (maxStock - minStock + 1));
        it.sold = 0;
      });
    }
    // 팀 플레이 순서도 상의 시간 시작 시점에 무작위로 미리 정해서 상의 시간에 보여줌
    gameState.turnOrder = shuffle(Object.keys(players));
    gameState.currentTurnIdx = 0;
    io.emit('notice', '🗣️ 상의 시간(5분)! 상점별 물건·가격·한정 수량과 우리 팀 순서를 확인하고, 어떤 물건을 살지·언제 용돈을 벌지 작전을 짜세요.');
    broadcastState();
  });

  socket.on('admin:startGame', () => {
    // 게임 시작은 상의 시간 단계에서만 (물품→효용→상의→게임 순서를 강제)
    if (!isAdmin(socket.id)) return;
    if (gameState.phase !== 'discussion') { socket.emit('notice', '먼저 효용을 정하고 상의 시간을 거쳐주세요.'); return; }
    startGame();
  });

  socket.on('admin:skipTurn', () => {
    if (!isAdmin(socket.id) || gameState.phase !== 'playing' || gameState.turnOrder.length === 0) return;
    const cur = players[currentPlayerId()];
    if (cur) cur.hasMovedThisTurn = false;
    passTurn();
    broadcastState();
  });

  // 팀별 차례 건너뛰기 (관리자가 특정 팀의 차례를 건너뜀 — 그 팀의 차례일 때만 동작)
  socket.on('admin:skipPlayer', (playerId) => {
    if (!isAdmin(socket.id) || gameState.phase !== 'playing' || gameState.turnOrder.length === 0) return;
    if (playerId !== currentPlayerId()) {
      socket.emit('notice', '지금은 그 팀의 차례가 아니에요.'); return;
    }
    const cur = players[playerId];
    if (cur) { cur.hasMovedThisTurn = false; io.emit('notice', `⏭️ 관리자가 ${cur.name}님의 차례를 건너뛰었어요.`); }
    passTurn();
    broadcastState();
  });

  socket.on('admin:finish', () => {
    if (!isAdmin(socket.id)) return;
    finishGame();
  });

  // ── 재시작: 상의 시간 창으로 돌아가 다시 플레이 (물품·효용은 그대로 유지) ──
  socket.on('admin:restartRound', () => {
    if (!isAdmin(socket.id)) return;
    Object.values(players).forEach(p => {
      p.money = CONFIG.START_MONEY; p.savings = 0;
      p.bought = []; p.hasMovedThisTurn = false; p.zoneId = null; p.map = 'town';
    });
    // 재고는 상의 시간 시작 시점에 새로 배정(팀이 한정 수량까지 보고 계획을 짤 수 있도록)
    const teamCount = Math.max(1, Object.keys(players).length);
    const minStock = Math.max(1, Math.floor(teamCount / 2) - 1);
    const maxStock = Math.max(minStock, teamCount - 1);
    for (const sh of SHOP_IDS) (shopItems[sh] || []).forEach(it => {
      it.stock = minStock + Math.floor(Math.random() * (maxStock - minStock + 1));
      it.sold = 0;
    });
    // 팀 순서도 재시작할 때마다 새로 무작위로 정해서 상의 시간에 보여줌
    gameState.turnOrder = shuffle(Object.keys(players)); gameState.currentTurnIdx = 0;
    gameState.phase = 'discussion'; gameState.discussionStartedAt = Date.now();
    io.emit('notice', '🔄 상의 시간부터 다시 시작! (물품·효용은 그대로, 팀 순서는 새로 정해졌어요)');
    broadcastState();
  });

  socket.on('admin:reset', () => {
    if (!isAdmin(socket.id)) return;
    const keepReq = gameState.requiredPlayers, keepAdmin = gameState.adminId, keepTarget = gameState.targetUtility;
    gameState = { phase: 'lobby', requiredPlayers: keepReq, round: 1, bankOpen: true, turnOrder: [], currentTurnIdx: 0,
                  adminId: keepAdmin, discussionStartedAt: 0,
                  targetUtility: keepTarget || CONFIG.TARGET_UTILITY };
    shopItems = buildDefaultShopItems();
    utilities = {};
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
