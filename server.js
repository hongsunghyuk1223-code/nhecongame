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
  START_MONEY: 15000,
  INTEREST_RATE: 0.20,
  MAX_HP: 4,             // 이동에 쓰는 체력(행동마다 1 소모, 0이면 한 턴 휴식 후 회복 + 병원비)
  HOSPITAL_FEE: 4000,    // 체력이 모두 닳아 강제 휴식할 때 드는 병원비
  MOVE_STEP: 20,         // 방향키 한 번에 움직이는 거리(px)
  MAP_WIDTH: 1900,       // 넓은 아이소 마름모 지형 — 한 화면보다 커서 카메라가 따라 스크롤
  MAP_HEIGHT: 1400,
  TURN_SECONDS: parseInt(process.env.TURN_SECONDS) || 90,      // 팀별 턴 제한시간(1분 30초) — 초과 시 자동으로 다음 팀
  DISCUSSION_SECONDS: parseInt(process.env.DISCUSSION_SECONDS) || 300, // 게임 시작 전 상의(작전) 시간(5분)
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

// ── 단어 기반 자동 가격 (현실 시세 사전 + 패턴 휴리스틱) ──
// 관리자가 어떤 물건을 추가해도 이름을 보고 대략의 현실 가격을 매김. (가격 정하기 단계 대체)
const PRICE_DICT = {
  // 음식·간식
  '생수':1000,'우유':1500,'두유':1500,'요구르트':1500,'요구트':1000,
  '컵라면':1500,'라면':900,'삼각김밥':1300,'김밥':3500,'주먹밥':2500,
  '떡볶이':4000,'라볶이':4500,'순대':4000,'튀김':3000,'어묵':1500,'오뎅':1500,'호떡':1000,
  '우동':5000,'국수':4000,'쫄면':4500,'냉면':6000,'라멘':7000,
  '과자':1500,'스낵':1500,'사탕':500,'캔디':500,'초콜릿':1500,'초코':1500,'젤리':1500,'껌':1000,
  '아이스크림':1500,'빙수':8000,'슬러시':2000,'하드':1000,
  '빵':2000,'도넛':1500,'크림빵':1500,'단팥빵':1500,'샌드위치':3500,'토스트':3000,'핫도그':3000,'베이글':3000,
  '치즈':3000,'햄':4000,'소시지':3000,'계란':1000,'달걀':1000,
  '사과':1500,'바나나':3000,'딸기':6000,'포도':7000,'귤':5000,'수박':15000,'고구마':4000,'감자':3000,'토마토':4000,
  '음료수':2000,'음료':2000,'주스':2500,'콜라':2000,'사이다':2000,'탄산':2000,'이온음료':1500,
  '커피':3000,'코코아':2500,'스무디':4000,'파르페':7000,'버블티':4500,
  '피자':15000,'치킨':18000,'햄버거':6000,'감자튀김':3000,'핫바':1500,'만두':4000,
  // 학용품
  '스프링노트':2500,'공책':1500,'노트북':500000,'노트':1500,'연필':500,'샤프':3000,'볼펜':1000,'만년필':15000,'펜':1500,
  '색연필':5000,'크레파스':4000,'크레용':4000,'물감':6000,'붓':2000,'팔레트':3000,
  '지우개':1000,'가위':2500,'풀':1500,'테이프':2000,'스테이플러':4000,'컴퍼스':3000,
  '필통':8000,'파일':2000,'바인더':4000,'색종이':2000,'스케치북':3000,'도화지':2000,
  '형광펜':1500,'마커':2500,'사인펜':3000,'스티커':2000,'메모지':2000,'포스트잇':3000,
  // 장난감·충동구매
  '장난감':12000,'인형':15000,'피규어':20000,'레고':30000,'블록':15000,'로봇':25000,'드론':40000,
  '팽이':6000,'요요':5000,'딱지':2000,'구슬':2000,'슬라임':3000,'점토':3000,'퍼즐':8000,'킥보드':40000,
  '게임카드':5000,'보드게임':20000,'카드':4000,'축구공':18000,'농구공':20000,'공':10000,'줄넘기':5000,
  '자동차':12000,'기차':15000,'비행기':15000,'헬리콥터':20000,
  // 생필품·기타
  '비누':2000,'칫솔':2000,'치약':3000,'샴푸':6000,'수건':3000,'휴지':3000,'물티슈':2000,'마스크':500,
  '양말':3000,'장갑':4000,'모자':12000,'티셔츠':12000,'우산':8000,'지갑':10000,'가방':25000,'신발':30000,
  '건전지':3000,'배터리':3000,'충전기':10000,'이어폰':20000,'헤드폰':40000,'시계':25000,
  '핸드폰':500000,'휴대폰':500000,'스마트폰':500000,'태블릿':400000,'게임기':300000,
  '만화책':8000,'문제집':12000,'책':10000,'색칠공부':4000,
  '꽃':5000,'화분':8000,'풍선':1000,'선물':10000,'생일선물':15000,
};
const DICT_KEYS = Object.keys(PRICE_DICT).sort((a, b) => b.length - a.length);   // 긴(구체적) 키 우선
// { price, known } — known=false면 시세를 확신 못 함(→ 팀 평균으로 정할 대상)
function priceInfo(name) {
  const s = String(name || '').replace(/\s+/g, '');
  let base = null, known = true;
  // 두 글자 이상 키는 포함(substring), 한 글자 키는 끝말/정확일치만 (물건·건물 같은 오매칭 방지)
  for (const k of DICT_KEYS) {
    if (k.length >= 2 ? s.includes(k) : (s.endsWith(k) || s === k)) { base = PRICE_DICT[k]; break; }
  }
  if (base == null) {
    if (/장난감|인형|피규어|레고|로봇|드론|블록|게임/.test(s)) base = 15000;
    else if (/과자|사탕|젤리|음료|우유|껌|스티커/.test(s)) base = 1500;
    else { base = 3000; known = false; }   // 사전·패턴에도 없음 → 시세 불명
  }
  let mult = 1;
  const q = s.match(/(\d+)\s*(개|병|장|판|봉|입|팩|줄|묶음|세트)/);
  if (q) mult = Math.min(12, Math.max(1, parseInt(q[1]) || 1)) * 0.85;   // 다발이면 개당 살짝 할인
  else if (/세트|묶음|모음|팩/.test(s)) mult = 2;
  if (/한정판|명품|프리미엄|고급|브랜드/.test(s)) mult *= 1.6;
  const price = Math.max(100, Math.min(99999, Math.round(base * mult / 100) * 100));
  return { price, known };
}
function autoPrice(name) { return priceInfo(name).price; }

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

// 매 턴 시작 시 그 차례의 플레이어에게 가중치(weight) 기반으로 하나 발생
// amount: 돈 변화, hp: 체력 변화(숫자) 또는 'full', soldOutPass: 완판 구매권, skip: 이번 턴 못 움직임
const EVENTS = [
  { id: 'lose_supply',  text: '학용품을 잃어버렸어요! 다시 사느라 2,000원을 썼습니다.', amount: -2000, weight: 1 },
  { id: 'forgot_gift',  text: '친구 생일 선물을 깜빡했어요. 4,000원을 썼습니다.',        amount: -4000, weight: 1 },
  { id: 'good_grade',   text: '성적을 잘 받아서 부모님께 용돈 5,000원을 받았어요!',       amount: 5000,  weight: 1 },
  { id: 'play',         text: '친구들과 신나게 놀아 기운이 솟았어요! 체력을 모두 회복합니다.', hp: 'full', weight: 1 },
  { id: 'cold',         text: '감기 기운이 있어 체력을 하나 잃었어요...',               hp: -1, weight: 1 },
  { id: 'soldout_pass', text: '완판 물품 구매권을 받았어요! (다 팔려서 구매할 수 없는 물건을 한 번 구매할 수 있어요)', soldOutPass: 1, weight: 0.5 },
  { id: 'scolded',      text: '부모님께 혼나 이번 턴은 움직일 수 없어요!',              skip: true, weight: 1 },
];
// 숙제하기(study)를 하면 다음 차례에 '성적 용돈'(good_grade) 확률이 오르는 가중치 배수
const STUDY_GRADE_BOOST = 4;

// 가중치로 이벤트 하나 선택 (숙제한 팀은 good_grade가 커지고, 그만큼 나머지는 상대적으로 낮아짐)
function pickEvent(studied) {
  const weights = EVENTS.map(e => e.weight * (studied && e.id === 'good_grade' ? STUDY_GRADE_BOOST : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < EVENTS.length; i++) { if ((r -= weights[i]) < 0) return EVENTS[i]; }
  return EVENTS[EVENTS.length - 1];
}

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
// 시세 불명 물품만 팀이 가격 제출 { [itemId]: { [playerId]: price } } — 제출한 팀 평균이 그 물품 가격
let priceBids = {};

let gameState = {
  phase: 'lobby',        // lobby | selecting | setup | pricing(시세불명만) | utility | discussion | playing | over
  requiredPlayers: 2,
  round: 1,
  bankOpen: false,
  turnOrder: [],
  currentTurnIdx: 0,
  adminId: null,         // 관리자(진행자) 소켓 id — 플레이어가 아님
  utilQuota: null,       // 효용 점수별 배정 가능 개수 { '1':n, ..., '7':n } (모든 팀 동일)
  expensiveIds: [],      // 비싼 물건(가격 상위 20%) — 6·7점만 줄 수 있음
  pricingOrder: [],      // 가격을 정할 시세불명 물품 id 순서
  pricingIdx: 0,         // 지금 가격을 정하는 물품 위치 (== length 이면 전부 완료)
  discussionStartedAt: 0,// 상의(작전) 시간 시작 시각
  turnStartedAt: 0,      // 현재 턴 시작 시각(제한시간 표시용)
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
    freePass: false,       // 부모님 찬스: 다음 구매 1회 무료 + 완판 물품도 구매 가능
    soldOutPass: 0,        // 완판 물품 구매권: 다 팔린 물건을 1회 구매 가능(값은 지불)
    studied: false,        // 숙제함 → 다음 차례에 성적 용돈 확률 상승
    skipThisTurn: false,   // 돌발 이벤트로 이번 턴 이동/행동 불가(턴 종료만 가능)
    bought: [],
    hasMovedThisTurn: false,
  };
}

// 집(우리 집)에서 고른 행동의 결과 처리 (choice: help | study | rest)
function houseChoiceOutcome(p, choice) {
  if (choice === 'help') {
    // 부모님 도와드리기: 용돈 3000(50%)/5000(40%)/10000(10%) + 30% 확률로 부모님 찬스도 획득
    const pr = Math.random();
    const amount = pr < 0.5 ? 3000 : (pr < 0.9 ? 5000 : 10000);
    p.money += amount;
    let text = `부모님을 도와드리고 용돈 ${amount.toLocaleString()}원을 받았어요!`;
    if (Math.random() < 0.30) { p.freePass = true; text += ' 게다가 🎟️ 부모님 찬스도 얻었어요!'; }
    return { type: 'money', text };
  } else if (choice === 'study') {
    // 숙제하기: 다음 차례에 '성적 용돈' 이벤트 확률이 오름
    p.studied = true;
    return { type: 'study', text: '📚 열심히 숙제했어요! 다음 차례에 «성적을 잘 받아 용돈»을 받을 확률이 높아져요.' };
  } else {
    // 휴식: 체력 전부 회복
    p.hp = CONFIG.MAX_HP;
    return { type: 'rest', text: '😴 집에서 푹 쉬어서 체력이 모두 회복됐어요!' };
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

// 팀별 턴 제한시간(90초): 초과 시 자동으로 다음 팀으로 넘김
let turnTimer = null;
function armTurnTimer() {
  if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
  if (gameState.phase !== 'playing') return;
  const curId = currentPlayerId();
  gameState.turnStartedAt = Date.now();   // 클라 타이머 표시용
  turnTimer = setTimeout(() => {
    if (gameState.phase !== 'playing' || currentPlayerId() !== curId) return;
    const cur = players[curId];
    if (cur) { cur.hasMovedThisTurn = false; io.emit('notice', `⏰ ${cur.name}님, 제한시간(1분 30초)이 지나 다음 팀으로 넘어가요!`); }
    passTurn();
    broadcastState();
  }, CONFIG.TURN_SECONDS * 1000);
}
function stopTurnTimer() { if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; } }

// 턴 시작 이벤트: 차례가 된 플레이어에게 무작위 이벤트를 적용하고 모두에게 알림
function triggerTurnEvent(playerId) {
  const p = players[playerId];
  if (!p) return;
  const ev = pickEvent(p.studied);
  p.studied = false;            // 숙제 효과는 이번 이벤트에만 적용
  p.skipThisTurn = false;
  if (typeof ev.amount === 'number') p.money = Math.max(0, p.money + ev.amount);
  if (ev.hp === 'full') p.hp = CONFIG.MAX_HP;
  else if (typeof ev.hp === 'number') p.hp = Math.max(0, Math.min(CONFIG.MAX_HP, p.hp + ev.hp));
  if (ev.soldOutPass) p.soldOutPass = (p.soldOutPass || 0) + ev.soldOutPass;
  if (ev.skip) p.skipThisTurn = true;   // 이번 턴 이동/행동 불가, 턴 종료만 가능
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

// 효용 배정 계획: 비싼 물건(가격 상위 20%)은 6·7점 전용, 나머지는 1~5점.
//  - 보통 물건 N개를 1~5점에 고르게(나머지는 낮은 점수부터), 비싼 물건 E개는 6·7점에 비슷하게 나눔.
const SCORES = [1, 2, 3, 4, 5, 6, 7];
function computeUtilPlan(items) {
  const T = items.length;
  const E = Math.min(T, Math.max(0, Math.round(T * 0.2)));   // 가격 상위 20%
  const expensiveIds = items.slice().sort((a, b) => (b.price || 0) - (a.price || 0)).slice(0, E).map(i => i.id);
  const N = T - E;
  const base = Math.floor(N / 5), rem = N % 5;
  const q = {};
  for (let s = 1; s <= 5; s++) q[s] = base + (s <= rem ? 1 : 0);   // 보통 물건 → 1~5점
  q[6] = Math.ceil(E / 2);   // 비싼 물건 → 6·7점 비슷하게 (홀수면 6점 하나 더)
  q[7] = Math.floor(E / 2);
  return { quota: q, expensiveIds };
}
function isExpensiveItem(itemId) { return (gameState.expensiveIds || []).includes(itemId); }
function allowedScores(itemId) { return isExpensiveItem(itemId) ? [6, 7] : [1, 2, 3, 4, 5]; }

// 한 팀이 효용 배정을 규칙대로 마쳤는지 (모든 물품 배정 + 점수별 개수 정확히 일치)
function utilityDone(playerId) {
  const q = gameState.utilQuota;
  if (!q) return false;
  const mine = utilities[playerId] || {};
  const items = allItems();
  if (items.some(it => !mine[it.id])) return false;
  const cnt = { 1:0, 2:0, 3:0, 4:0, 5:0, 6:0, 7:0 };
  items.forEach(it => { const s = mine[it.id]; if (s) cnt[s]++; });
  return SCORES.every(s => cnt[s] === (q[s] || 0));
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
    p.soldOutPass = 0;
    p.studied = false;
    p.skipThisTurn = false;
  });
  // 물품별 한정 수량: 최소=팀 수의 절반(내림), 최대=팀 수 사이 무작위. (5팀이면 2~5개)
  // 재고를 적게 두어 품절이 자주 나야 완판 구매권/부모님 찬스가 의미 있음.
  const teamCount = Math.max(1, gameState.turnOrder.length);
  const minStock = Math.max(1, Math.floor(teamCount / 2));
  for (const shopId of SHOP_IDS) {
    (shopItems[shopId] || []).forEach(it => {
      it.stock = minStock + Math.floor(Math.random() * (teamCount - minStock + 1));
      it.sold = 0;
    });
  }
  placePlayersAtStart();
  const firstName = players[gameState.turnOrder[0]]?.name;
  io.emit('notice', `게임 시작! ${firstName}님의 첫 번째 차례입니다. (광장에서 출발 — 방향키로 원하는 건물까지 이동!)`);
  triggerTurnEvent(gameState.turnOrder[0]);
  armTurnTimer();          // 첫 턴 제한시간 시작
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
      // 체력 없음 → 이번 턴 강제 휴식하고 체력 회복 + 병원비 소모(휴식으로 관리 안 하면 아파서 병원행)
      cur.hp = CONFIG.MAX_HP;
      cur.hasMovedThisTurn = false;
      cur.money = Math.max(0, cur.money - CONFIG.HOSPITAL_FEE);
      io.emit('notice', `🏥 ${cur.name}님은 체력이 다 닳아 이번 턴은 쉬어요. 병원비 ${CONFIG.HOSPITAL_FEE.toLocaleString()}원이 들었어요! (체력 회복)`);
      continue;
    }
    io.emit('notice', `${cur ? cur.name : '?'}님의 차례입니다!`);
    if (cur) triggerTurnEvent(cur.id);
    armTurnTimer();          // 새 턴 제한시간 시작
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
              priceBids[iid][socket.id] = priceBids[iid][oldId]; delete priceBids[iid][oldId];
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
    if (!p || p.hasMovedThisTurn || p.skipThisTurn) return;   // 이미 행동했거나 이번 턴 벌칙(움직일 수 없음)이면 이동 잠금
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
    if (p.skipThisTurn) { socket.emit('notice', '이번 턴은 움직일 수 없어요. 턴을 종료하세요.'); return; }
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
      // 집: 세 가지 행동 중 하나를 고르게 함 (선택 후 house:choose에서 결과+턴 종료)
      socket.emit('houseChoices');
    } else {
      socket.emit('zoneEntered', { zone });
    }
  });

  // ── 집에서 행동 선택 (부모님 도와드리기 / 숙제하기 / 휴식) ──
  socket.on('house:choose', (choice) => {
    if (gameState.phase !== 'playing') return;
    if (socket.id !== currentPlayerId()) return;
    const p = players[socket.id];
    if (!p || p.zoneId !== 'house' || !p.hasMovedThisTurn) return;
    if (!['help', 'study', 'rest'].includes(choice)) return;
    const out = houseChoiceOutcome(p, choice);
    socket.emit('houseEvent', out);
    autoEndTurn(p);      // 집에서 행동하면 이번 턴 종료
    broadcastState();
  });

  // ── 턴 종료 ──
  socket.on('endTurn', () => {
    if (gameState.phase !== 'playing') return;
    if (socket.id !== currentPlayerId()) return;
    const p = players[socket.id];
    if (!p) return;
    // 체력 0이거나 '이번 턴 못 움직임' 벌칙이면 행동 없이도 턴 종료 가능
    if (!p.hasMovedThisTurn && p.hp > 0 && !p.skipThisTurn) {
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

    // 한정 수량: 다 팔렸으면 완판 물품 구매권 또는 부모님 찬스가 있어야 살 수 있음
    const left = (item.stock == null) ? Infinity : item.stock - (item.sold || 0);
    let usedSoldOutPass = false, usedFreePass = false;
    if (left <= 0) {
      if (p.soldOutPass > 0) usedSoldOutPass = true;
      else if (p.freePass) usedFreePass = true;
      else {
        socket.emit('notice', `'${item.name}'은(는) 다 팔렸어요! 완판 물품 구매권이나 부모님 찬스가 있어야 살 수 있어요.`);
        return;
      }
    }
    if (!usedFreePass && p.freePass && item.price > 0) usedFreePass = true;   // 부모님 찬스는 다음 구매 1회 무료

    const cost = usedFreePass ? 0 : item.price;
    if (p.money < cost) { socket.emit('notice', '돈이 부족해요!'); return; }
    p.money -= cost;
    if (usedFreePass) p.freePass = false;
    if (usedSoldOutPass) p.soldOutPass = Math.max(0, (p.soldOutPass || 0) - 1);
    item.sold = (item.sold || 0) + 1;
    p.bought.push({ id: item.id, name: item.name, price: item.price, paid: cost, shopId });
    socket.emit('notice',
      usedSoldOutPass ? `🎫 완판 물품 구매권으로 '${item.name}'을(를) ${cost.toLocaleString()}원에 샀어요!`
      : usedFreePass  ? `🎟️ 부모님 찬스로 '${item.name}'을(를) 무료로 샀어요!`
      : `'${item.name}'을(를) ${item.price.toLocaleString()}원에 샀어요!`);
    if ((item.stock != null) && item.stock - item.sold <= 0) io.emit('notice', `📦 '${item.name}'이(가) 다 팔렸어요!`);
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
    // 분류(꼭 필요/갖고 싶은)는 팀별 무작위 배정.
    // 가격: 시세를 알면 자동 설정(autoPriced=true), 모르면 0원(미정)으로 두고 나중에 팀 평균으로 정함.
    const info = priceInfo(name);
    const item = { id: newItemId(), name, price: info.known ? info.price : 0, autoPriced: info.known };
    shopItems[shopId].push(item);
    socket.emit('notice', info.known
      ? `'${name}' 자동 시세 ${info.price.toLocaleString()}원으로 추가했어요.`
      : `'${name}'은(는) 시세를 몰라 팀들이 함께 가격을 정하게 돼요.`);
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

  // 효용 단계 진입(팀별 필수품목·효용쿼터 배정). 가격은 이 시점엔 모두 정해져 있어야 함.
  function enterUtility() {
    utilities = {};
    Object.keys(players).forEach(pid => { utilities[pid] = {}; });
    assignTeamNeeds();          // 팀마다 다른 '꼭 필요한 물건'(전체의 1/4) 무작위 배정
    const plan = computeUtilPlan(allItems());
    gameState.utilQuota = plan.quota;
    gameState.expensiveIds = plan.expensiveIds;   // 비싼 물건(상위 20%)은 6·7점 전용
    gameState.phase = 'utility';
    io.emit('notice', '⭐ 팀별 «꼭 필요한 물건»이 정해졌어요! 물건마다 효용을 정해주세요. (비싼 물건은 6·7점!)');
  }

  // ── 물품 확정 → (시세불명 물품이 있으면 그것만 팀 가격 결정, 없으면 바로 효용) ──
  socket.on('admin:toUtility', () => {
    if (!isAdmin(socket.id) || gameState.phase !== 'setup') return;
    const items = allItems();
    if (items.length < 5) { socket.emit('notice', '물건이 5개 이상 있어야 효용을 나눌 수 있어요.'); return; }
    const unknown = items.filter(i => !i.autoPriced && !(i.price > 0));   // 시세 불명 + 아직 가격 없음
    if (unknown.length) {
      priceBids = {};
      gameState.pricingOrder = unknown.map(i => i.id);
      gameState.pricingIdx = 0;
      gameState.phase = 'pricing';
      io.emit('notice', `💰 시세를 모르는 물건 ${unknown.length}개는 팀들이 함께 적정 가격을 정해요!`);
      broadcastState();
    } else {
      enterUtility();
      broadcastState();
    }
  });

  // ── 시세불명 물품 가격 제출 (지금 정하는 물품에 대해서만) ──
  socket.on('price:bid', (price) => {
    if (gameState.phase !== 'pricing') return;
    const p = players[socket.id]; if (!p) return;
    const itemId = gameState.pricingOrder[gameState.pricingIdx];
    if (!itemId) return;
    price = parseInt(price);
    if (isNaN(price) || price <= 0 || price > 99999) { socket.emit('notice', '1~99999원 사이로 입력해주세요.'); return; }
    if (!priceBids[itemId]) priceBids[itemId] = {};
    priceBids[itemId][socket.id] = price;
    socket.emit('notice', `${price.toLocaleString()}원을 제출했어요.`);
    broadcastState();
  });

  // ── 관리자: 다음 물품으로 (제출한 팀 평균으로 확정, 미제출 제외). 전부 끝나면 효용 단계로 ──
  socket.on('admin:nextItem', () => {
    if (!isAdmin(socket.id) || gameState.phase !== 'pricing') return;
    const itemId = gameState.pricingOrder[gameState.pricingIdx];
    if (!itemId) return;
    const item = allItems().find(i => i.id === itemId);
    const bids = Object.values(priceBids[itemId] || {});
    const finalPrice = bids.length ? Math.max(100, Math.round(bids.reduce((a, b) => a + b, 0) / bids.length)) : 3000;
    for (const shopId of SHOP_IDS) {
      const found = (shopItems[shopId] || []).find(i => i.id === itemId);
      if (found) { found.price = finalPrice; found.autoPriced = true; }
    }
    io.emit('notice', `'${item ? item.name : '?'}' 가격이 ${finalPrice.toLocaleString()}원으로 정해졌어요! (제출 ${bids.length}팀 평균)`);
    gameState.pricingIdx++;
    if (gameState.pricingIdx >= gameState.pricingOrder.length) enterUtility();   // 다 정했으면 효용으로
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
    // 비싼 물건(상위 20%)은 6·7점만, 보통 물건은 1~5점만 줄 수 있음
    const allow = allowedScores(itemId);
    if (!allow.includes(score)) {
      socket.emit('notice', isExpensiveItem(itemId) ? '💎 비싼 물건은 6점 또는 7점만 줄 수 있어요.' : '이 물건은 1~5점만 줄 수 있어요.');
      return;
    }
    // 이 점수를 이미 몇 개 썼는지 (지금 바꾸려는 물건은 제외)
    const used = Object.entries(mine).filter(([iid, s]) => s === score && iid !== itemId).length;
    if (used >= (gameState.utilQuota?.[score] || 0)) {
      socket.emit('notice', `${score}점은 ${gameState.utilQuota[score]}개까지만 줄 수 있어요.`); return;
    }
    mine[itemId] = score;
    broadcastState();
  });

  // ── 효용 확정 → 바로 상의(작전) 시간(5분)으로 (가격은 물품 추가 시 자동 시세로 이미 정해짐) ──
  socket.on('admin:toDiscussion', () => {
    if (!isAdmin(socket.id) || gameState.phase !== 'utility') return;
    const notDone = Object.values(players).filter(p => !utilityDone(p.id)).map(p => p.name);
    if (notDone.length) { socket.emit('notice', `아직 효용을 다 못 정한 팀: ${notDone.join(', ')}`); return; }
    gameState.phase = 'discussion';
    gameState.discussionStartedAt = Date.now();
    io.emit('notice', '🗣️ 상의 시간(5분)! 상점별 물건과 가격·위치를 살펴보고 작전을 짜세요.');
    broadcastState();
  });

  socket.on('admin:startGame', () => {
    // 게임 시작은 상의 시간 단계에서만 (물품→효용→상의→게임 순서를 강제)
    if (!isAdmin(socket.id)) return;
    if (gameState.phase !== 'discussion') { socket.emit('notice', '먼저 효용을 정하고 상의 시간을 거쳐주세요.'); return; }
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
    stopTurnTimer();
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
    stopTurnTimer();
    const keepReq = gameState.requiredPlayers, keepAdmin = gameState.adminId;
    gameState = { phase: 'lobby', requiredPlayers: keepReq, round: 1, bankOpen: false, turnOrder: [], currentTurnIdx: 0,
                  adminId: keepAdmin, utilQuota: null, expensiveIds: [], pricingOrder: [], pricingIdx: 0, discussionStartedAt: 0, turnStartedAt: 0 };
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
