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
  MAP_WIDTH: 1800,       // 넓은 맵 — 한 화면보다 커서 카메라가 플레이어를 따라 스크롤
  MAP_HEIGHT: 1300,
};

// 마을(town): 직선 격자 도시 블록 구조 (1800x1300) — 세로 거리 x=590/1210, 가로 거리 y=430/860,
// 블록마다 건물 1개(자기 부지 포함), 가운데 블록은 스폰 잔디 광장 (아이소 도시 레퍼런스)
const TOWN_ZONES = [
  { id: 'mart',       type: 'shop',  name: '대형마트',   x: 70,   y: 190,  w: 440, h: 300 }, // 왼쪽 위 블록
  { id: 'house',      type: 'house', name: '집',         x: 730,  y: 105,  w: 340, h: 310 }, // 가운데 위 블록
  { id: 'market',     type: 'shop',  name: '전통시장',   x: 1300, y: 60,   w: 420, h: 330 }, // 오른쪽 위 블록
  { id: 'bank',       type: 'bank',  name: '디지털 은행', x: 90,   y: 570,  w: 390, h: 320 }, // 왼쪽 가운데 블록
  { id: 'cvs',        type: 'shop',  name: '편의점',     x: 1300, y: 530,  w: 380, h: 320 }, // 오른쪽 가운데 블록
  { id: 'restaurant', type: 'shop',  name: '푸드코트',   x: 720,  y: 1010, w: 360, h: 320 }, // 가운데 아래 블록
];
const MAPS = {
  town: { width: CONFIG.MAP_WIDTH, height: CONFIG.MAP_HEIGHT, zones: TOWN_ZONES },
};
const SHOP_IDS = ['mart', 'market', 'cvs', 'restaurant'];
const ACTIONABLE_TYPES = ['shop', 'bank', 'house'];

// 상점별 기본 판매 물건 (setup 단계에서 아이들이 추가·삭제·변경 가능)
// 분류(꼭 필요/갖고 싶은)는 저장하지 않음 — 팀마다 무작위로 다르게 부여됨(teamNeeds)
const DEFAULT_SHOP_ITEMS = {
  mart: [
    { name: '생수 6병',     price: 3000 },
    { name: '라면 5개입',   price: 4000 },
    { name: '과자 세트',    price: 3500 },
    { name: '아이스크림',   price: 1500 },
    { name: '장난감 자동차', price: 12000 },
  ],
  market: [
    { name: '사과 5개',     price: 5000 },
    { name: '고구마 1봉',   price: 4000 },
    { name: '어묵 한 줄',   price: 1500 },
    { name: '호떡',         price: 1000 },
    { name: '장난감 팽이',  price: 6000 },
  ],
  cvs: [
    { name: '삼각김밥',     price: 1200 },
    { name: '우유',         price: 1500 },
    { name: '음료수',       price: 2000 },
    { name: '젤리',         price: 1500 },
    { name: '한정판 스티커', price: 4000 },
  ],
  restaurant: [
    { name: '김밥 한 줄',   price: 3000 },
    { name: '우동',         price: 5000 },
    { name: '떡볶이',       price: 4000 },
    { name: '치즈 핫도그',  price: 3500 },
    { name: '딸기 파르페',  price: 7000 },
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

// 팀별 '꼭 필요한 물건' { [playerId]: [itemId, ...] } — 전체 물품의 1/4을 팀마다 다르게 무작위 부여
let teamNeeds = {};
// 팀별 효용(1~5점) { [playerId]: { [itemId]: score } } — 가격 책정 전에 팀마다 다르게 정함
let utilities = {};
// 물품별 팀 제출 가격 { [itemId]: { [playerId]: price } } — 제출한 팀 평균이 그 물품 가격
let priceBids = {};

let gameState = {
  phase: 'lobby',        // lobby(대기) | selecting(캐릭터) | setup(물품) | utility(효용) | pricing(가격) | playing | over
  requiredPlayers: 2,
  round: 1,
  bankOpen: false,
  turnOrder: [],
  currentTurnIdx: 0,
  adminId: null,         // 관리자(진행자) 소켓 id — 플레이어가 아님
  utilQuota: null,       // 효용 점수별 배정 가능 개수 { '1':n, ..., '5':n } (모든 팀 동일)
  pricingOrder: [],      // 가격을 정할 물품 id 순서
  pricingIdx: 0,         // 지금 가격을 정하는 물품 위치 (== length 이면 전부 완료)
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
    p.x = 900 + (col - (colsInRow - 1) / 2) * 64;
    p.y = 650 + row * 48;                        // 가운데 블록 잔디 광장
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
  io.emit('state', { players, gameState, shopItems, utilities, priceBids, teamNeeds });
}

// 팀마다 다르게 '꼭 필요한 물건'을 무작위로 부여 (전체 물품의 1/4)
function assignTeamNeeds() {
  const ids = allItems().map(i => i.id);
  const cnt = Math.max(1, Math.round(ids.length / 4));
  teamNeeds = {};
  Object.keys(players).forEach(pid => {
    const pool = ids.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    teamNeeds[pid] = pool.slice(0, cnt);
  });
}
function isNeedFor(playerId, itemId) { return (teamNeeds[playerId] || []).includes(itemId); }

// 전체 물품을 상점 순서대로 펼친 목록 (효용/가격 단계 공통)
function allItems() {
  const out = [];
  for (const shopId of SHOP_IDS) (shopItems[shopId] || []).forEach(it => out.push({ ...it, shopId }));
  return out;
}

// 효용 점수별 배정 개수: 전체 개수를 1~5점에 고르게 5등분 (나머지는 낮은 점수부터 1개씩)
function buildUtilQuota(total) {
  const base = Math.floor(total / 5), rem = total % 5;
  const q = {};
  for (let s = 1; s <= 5; s++) q[s] = base + (s <= rem ? 1 : 0);
  return q;
}

// 한 팀이 효용 배정을 규칙대로 마쳤는지 (모든 물품 배정 + 점수별 개수 정확히 일치)
function utilityDone(playerId) {
  const q = gameState.utilQuota;
  if (!q) return false;
  const mine = utilities[playerId] || {};
  const items = allItems();
  if (items.some(it => !mine[it.id])) return false;
  const cnt = { 1:0, 2:0, 3:0, 4:0, 5:0 };
  items.forEach(it => { const s = mine[it.id]; if (s) cnt[s]++; });
  return [1,2,3,4,5].every(s => cnt[s] === q[s]);
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
    // 라운드1은 은행/저축 없음 — 자동 라운드 증가·은행 개방을 하지 않음(한 판 = 라운드 1)
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

// 라운드1 규칙: 물건 하나를 사거나 집에 방문하면 그 팀의 턴이 자동으로 끝난다.
function autoEndTurn(p) {
  if (p) p.hasMovedThisTurn = false;
  passTurn();
}

io.on('connection', (socket) => {
  console.log('접속:', socket.id);
  socket.emit('init', { maps: MAPS, config: CONFIG, animals: ANIMALS, shopIds: SHOP_IDS, shopItems });
  socket.emit('state', { players, gameState, shopItems, utilities, priceBids, teamNeeds });   // 접속 즉시 현재 상태 전달(기본 로비로 보이는 문제 방지)

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
          // 새로고침으로 소켓 id가 바뀌어도 팀 데이터(효용·필수품목·제출가격)를 그대로 이어받음
          if (utilities[oldId]) { utilities[socket.id] = utilities[oldId]; delete utilities[oldId]; }
          if (teamNeeds[oldId]) { teamNeeds[socket.id] = teamNeeds[oldId]; delete teamNeeds[oldId]; }
          for (const iid of Object.keys(priceBids)) {
            if (priceBids[iid] && priceBids[iid][oldId] != null) {
              priceBids[iid][socket.id] = priceBids[iid][oldId];
              delete priceBids[iid][oldId];
            }
          }
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
      // 집 방문 = 이번 턴 행동 완료 → 자동 턴 종료 (모달은 결과 확인용으로 남겨둠)
      autoEndTurn(p);
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
    p.bought.push({ id: item.id, name: item.name, price: item.price, paid: cost, shopId });
    socket.emit('notice', usedFreePass
      ? `🎟️ 부모님 찬스로 '${item.name}'을(를) 무료로 샀어요!`
      : `'${item.name}'을(를) ${item.price.toLocaleString()}원에 샀어요!`);
    // 라운드1 규칙: 물건 하나를 사면 이번 턴 종료 → 자동으로 다음 팀 차례
    socket.emit('autoTurnEnd');   // 구매자 화면의 상점 모달 닫기
    autoEndTurn(p);
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

  // ── 상점 물건 설정 (setup 단계, 관리자만) — 가격은 여기서 정하지 않고 pricing 단계에서 팀 평균으로 결정 ──
  socket.on('shop:addItem', ({ shopId, name }) => {
    if (gameState.phase !== 'setup' || !isAdmin(socket.id)) return;
    if (!shopItems[shopId]) return;
    name = String(name || '').trim().slice(0, 20);
    if (!name) { socket.emit('notice', '물건 이름을 입력하세요.'); return; }
    if (shopItems[shopId].length >= 12) { socket.emit('notice', '한 상점에는 최대 12개까지예요.'); return; }
    // 분류(꼭 필요/갖고 싶은)는 관리자가 정하지 않음 — 팀별로 무작위 배정됨
    shopItems[shopId].push({ id: newItemId(), name, price: 0 });
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

  // ── 물품 확정 → 효용(1~5점) 정하기 단계로 ──
  socket.on('admin:toUtility', () => {
    if (!isAdmin(socket.id) || gameState.phase !== 'setup') return;
    const items = allItems();
    if (items.length < 5) { socket.emit('notice', '물건이 5개 이상 있어야 효용을 나눌 수 있어요.'); return; }
    utilities = {};
    Object.keys(players).forEach(pid => { utilities[pid] = {}; });
    assignTeamNeeds();          // 팀마다 다른 '꼭 필요한 물건'(전체의 1/4) 무작위 배정
    gameState.utilQuota = buildUtilQuota(items.length);
    gameState.phase = 'utility';
    io.emit('notice', '⭐ 팀별 «꼭 필요한 물건»이 정해졌어요! 이제 물건마다 효용(1~5점)을 정해주세요.');
    broadcastState();
  });

  // ── 효용 배정 (팀마다 다르게, 점수별 개수 제한) ──
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
    if (!(score >= 1 && score <= 5)) return;
    // 이 점수를 이미 몇 개 썼는지 (지금 바꾸려는 물건은 제외)
    const used = Object.entries(mine).filter(([iid, s]) => s === score && iid !== itemId).length;
    if (used >= (gameState.utilQuota?.[score] || 0)) {
      socket.emit('notice', `${score}점은 ${gameState.utilQuota[score]}개까지만 줄 수 있어요.`); return;
    }
    mine[itemId] = score;
    broadcastState();
  });

  // ── 효용 확정 → 가격 정하기 단계로 ──
  socket.on('admin:toPricing', () => {
    if (!isAdmin(socket.id) || gameState.phase !== 'utility') return;
    const notDone = Object.values(players).filter(p => !utilityDone(p.id)).map(p => p.name);
    if (notDone.length) { socket.emit('notice', `아직 효용을 다 못 정한 팀: ${notDone.join(', ')}`); return; }
    priceBids = {};
    gameState.pricingOrder = allItems().map(i => i.id);
    gameState.pricingIdx = 0;
    gameState.phase = 'pricing';
    io.emit('notice', '💰 물건마다 적정 가격을 제출해주세요! (모든 팀 평균이 가격이 됩니다)');
    broadcastState();
  });

  // ── 가격 제출 (지금 정하는 물품에 대해서만, 다음으로 넘어가기 전엔 수정 가능) ──
  socket.on('price:bid', (price) => {
    if (gameState.phase !== 'pricing') return;
    const p = players[socket.id];
    if (!p) return;
    const itemId = gameState.pricingOrder[gameState.pricingIdx];
    if (!itemId) return;
    price = parseInt(price);
    if (isNaN(price) || price <= 0 || price > 99999) { socket.emit('notice', '1~99999원 사이로 입력해주세요.'); return; }
    if (!priceBids[itemId]) priceBids[itemId] = {};
    priceBids[itemId][socket.id] = price;
    socket.emit('notice', `${price.toLocaleString()}원을 제출했어요.`);
    broadcastState();
  });

  // ── 관리자: 다음 물품으로 (제출한 팀 평균으로 가격 확정, 미제출 팀은 제외) ──
  socket.on('admin:nextItem', () => {
    if (!isAdmin(socket.id) || gameState.phase !== 'pricing') return;
    const itemId = gameState.pricingOrder[gameState.pricingIdx];
    if (!itemId) return;
    const item = allItems().find(i => i.id === itemId);
    const bids = Object.values(priceBids[itemId] || {});
    let finalPrice;
    if (bids.length) finalPrice = Math.max(1, Math.round(bids.reduce((a, b) => a + b, 0) / bids.length));
    else finalPrice = (item && item.price > 0) ? item.price : 1000;   // 아무도 제출 안 하면 기본값 유지
    for (const shopId of SHOP_IDS) {
      const found = (shopItems[shopId] || []).find(i => i.id === itemId);
      if (found) found.price = finalPrice;
    }
    io.emit('notice', `'${item ? item.name : '?'}' 가격이 ${finalPrice.toLocaleString()}원으로 정해졌어요! (제출 ${bids.length}팀 평균)`);
    gameState.pricingIdx++;
    if (gameState.pricingIdx >= gameState.pricingOrder.length) {
      io.emit('notice', '✅ 모든 물건의 가격이 정해졌어요! 이제 게임을 시작할 수 있어요.');
    }
    broadcastState();
  });

  socket.on('admin:startGame', () => {
    if (!isAdmin(socket.id) || gameState.phase !== 'pricing') return;
    if (gameState.pricingIdx < gameState.pricingOrder.length) {
      socket.emit('notice', '아직 가격을 다 정하지 않았어요.'); return;
    }
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

  // 팀별 차례 건너뛰기 (3분 초과 시 관리자가 특정 팀의 차례를 건너뜀 — 그 팀의 차례일 때만 동작)
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
    gameState.phase = 'over';

    // 라운드1 승리 기준 3가지 (각 1점, 동점 시 공동 수상):
    //  1) '우리 팀에게 꼭 필요한 물건'(팀별 무작위)을 가장 많이 산 팀
    //  2) 산 물건들의 효용 합이 가장 높은 팀 (팀마다 정한 1~5점)
    //  3) 소비를 가장 많이 한 팀 (구매 물품의 가격 합) — 소비를 안 해서 이기는 편법 방지
    const rows = Object.values(players).map(p => {
      const bought = p.bought || [];
      const mine = utilities[p.id] || {};
      const needCount = bought.filter(b => isNeedFor(p.id, b.id)).length;
      const wantCount = bought.length - needCount;
      const needTotal = (teamNeeds[p.id] || []).length;
      const utilSum = bought.reduce((s, b) => s + (mine[b.id] || 0), 0);
      const spent = bought.reduce((s, b) => s + (b.price || 0), 0);   // 구매 물품의 가격 합
      return { name: p.name, color: p.color, needCount, needTotal, wantCount, utilSum, spent, remaining: p.money,
               points: 0, wonNeed: false, wonUtil: false, wonSpent: false };
    });
    const maxNeed  = Math.max(0, ...rows.map(r => r.needCount));
    const maxUtil  = Math.max(0, ...rows.map(r => r.utilSum));
    const maxSpent = Math.max(0, ...rows.map(r => r.spent));
    rows.forEach(r => {
      if (maxNeed  > 0 && r.needCount === maxNeed)  { r.wonNeed  = true; r.points++; }
      if (maxUtil  > 0 && r.utilSum   === maxUtil)  { r.wonUtil  = true; r.points++; }
      if (maxSpent > 0 && r.spent     === maxSpent) { r.wonSpent = true; r.points++; }
    });
    rows.sort((a, b) => b.points - a.points || b.utilSum - a.utilSum || b.needCount - a.needCount);
    io.emit('gameOver', { criteria: 'round1', rows });
    broadcastState();
  });

  socket.on('admin:reset', () => {
    if (!isAdmin(socket.id)) return;
    const keepReq = gameState.requiredPlayers, keepAdmin = gameState.adminId;
    gameState = { phase: 'lobby', requiredPlayers: keepReq, round: 1, bankOpen: false, turnOrder: [], currentTurnIdx: 0,
                  adminId: keepAdmin, utilQuota: null, pricingOrder: [], pricingIdx: 0 };
    shopItems = buildDefaultShopItems();
    utilities = {}; priceBids = {}; teamNeeds = {};
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
