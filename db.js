// 본가ON 데이터베이스 (Node 내장 SQLite — 별도 설치 불필요)
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');

// Vercel 등 서버리스 환경은 쓰기 가능한 경로가 /tmp뿐 (콜드스타트마다 재시드됨)
const DB_PATH = process.env.VERCEL ? '/tmp/bonga-on.db' : path.join(__dirname, 'bonga-on.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('hq','store')),
    store_name TEXT,
    plan TEXT NOT NULL DEFAULT 'basic' CHECK(plan IN ('basic','pro')),
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id INTEGER NOT NULL REFERENCES users(id),
    date TEXT NOT NULL,
    channel TEXT NOT NULL CHECK(channel IN ('baemin','coupang','yogiyo','hall','takeout')),
    amount INTEGER NOT NULL,
    orders_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_sales_store_date ON sales(store_id, date);

  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id INTEGER NOT NULL REFERENCES users(id),
    platform TEXT NOT NULL,
    author TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
    body TEXT NOT NULL,
    reply TEXT,
    reply_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    unit TEXT NOT NULL,
    price INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT '접수' CHECK(status IN ('접수','확정','배송중','완료','취소')),
    total INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    qty INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag TEXT NOT NULL DEFAULT '본사',
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS notice_reads (
    notice_id INTEGER NOT NULL REFERENCES notices(id),
    store_id INTEGER NOT NULL REFERENCES users(id),
    read_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (notice_id, store_id)
  );
`);

// ---------- 시드 데이터 (최초 1회) ----------
function seed() {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount > 0) return;

  const hash = bcrypt.hashSync('bonga1234', 10);
  const insUser = db.prepare(
    'INSERT INTO users (username, password_hash, role, store_name, plan) VALUES (?,?,?,?,?)');
  insUser.run('hq', hash, 'hq', '경주본가 본사', 'pro');
  const suwon = insUser.run('suwon', hash, 'store', '경주본가 수원인계점', 'pro').lastInsertRowid;
  const gangnam = insUser.run('gangnam', hash, 'store', '경주본가 강남점', 'basic').lastInsertRowid;

  const insProduct = db.prepare('INSERT INTO products (name, unit, price) VALUES (?,?,?)');
  const products = [
    ['간장게장', '1kg', 38000], ['양념게장', '1kg', 36000], ['울진대게장', '500g', 42000],
    ['간장새우장', '500g', 16500], ['양념새우장', '500g', 16500],
    ['양념닭갈비', '1kg', 14000], ['간장닭갈비', '1kg', 14000],
    ['대파쭈꾸미', '500g', 12500], ['가오리무침', '500g', 11000],
    ['해파리냉채', '300g', 9500], ['부추양념꼬막장', '300g', 13500],
  ];
  for (const p of products) insProduct.run(...p);

  // 최근 35일 매출 — 결정적 의사난수(시드 고정)로 그럴듯한 패턴 생성
  let rngState = 42;
  const rng = () => { rngState = (rngState * 1103515245 + 12345) % 2147483648; return rngState / 2147483648; };
  const channels = [
    ['baemin', 0.38], ['coupang', 0.22], ['yogiyo', 0.08], ['hall', 0.24], ['takeout', 0.08],
  ];
  const insSale = db.prepare(
    'INSERT INTO sales (store_id, date, channel, amount, orders_count) VALUES (?,?,?,?,?)');
  for (const [storeId, base] of [[suwon, 1150000], [gangnam, 1580000]]) {
    for (let d = 34; d >= 0; d--) {
      const day = new Date(Date.now() - d * 86400000);
      const dateStr = day.toISOString().slice(0, 10);
      const dow = day.getDay();                       // 주말 매출 상승
      const weekendBoost = (dow === 5 || dow === 6) ? 1.35 : (dow === 0 ? 1.15 : 1.0);
      const dayTotal = Math.round(base * weekendBoost * (0.82 + rng() * 0.4));
      for (const [ch, share] of channels) {
        const amount = Math.round(dayTotal * share * (0.85 + rng() * 0.3) / 100) * 100;
        const ordersCount = Math.max(1, Math.round(amount / (19000 + rng() * 6000)));
        insSale.run(storeId, dateStr, ch, amount, ordersCount);
      }
    }
  }

  const insReview = db.prepare(
    `INSERT INTO reviews (store_id, platform, author, rating, body, reply, created_at)
     VALUES (?,?,?,?,?,?, datetime('now','localtime', ?))`);
  const reviews = [
    [suwon, '배달의민족', '김*진', 5, '간장게장 진짜 밥도둑이에요. 살이 꽉 차 있어서 놀랐어요!', null, '-2 hours'],
    [suwon, '쿠팡이츠', '이*아', 4, '닭갈비 양념이 좋았는데 배달이 조금 늦었어요.', null, '-5 hours'],
    [suwon, '배달의민족', '박*수', 2, '새우장이 사진보다 양이 적게 느껴졌습니다.', null, '-1 day'],
    [suwon, '네이버', '최*희', 5, '부모님 선물로 보냈는데 너무 좋아하셨어요. 포장도 깔끔!',
      '소중한 후기 감사합니다. 부모님께서 좋아하셨다니 저희도 기쁩니다. 늘 정성껏 준비하겠습니다!', '-3 days'],
    [gangnam, '배달의민족', '정*우', 5, '울진대게장 처음 먹어봤는데 신세계네요.', null, '-3 hours'],
    [gangnam, '쿠팡이츠', '한*별', 3, '맛은 있는데 가격이 조금 부담스러워요.', null, '-1 day'],
    [gangnam, '배달의민족', '오*민', 5, '재주문 3번째입니다. 꼬막장 최고!', null, '-2 days'],
  ];
  for (const r of reviews) insReview.run(...r);
  db.exec(`UPDATE reviews SET reply_at = datetime('now','localtime','-2 days') WHERE reply IS NOT NULL`);

  const insNotice = db.prepare('INSERT INTO notices (tag, title, body, created_at) VALUES (?,?,?, datetime(\'now\',\'localtime\', ?))');
  insNotice.run('본사', '추석 선물세트 사전예약 오픈 안내',
    '9월 10일부터 추석 선물세트(간장게장 프리미엄 세트, 새우장 혼합 세트) 사전예약이 시작됩니다. 지점별 예약 물량은 발주 시스템에서 신청해 주세요.', '-3 hours');
  insNotice.run('신메뉴', '부추양념꼬막장 조리 가이드 배포',
    '신메뉴 부추양념꼬막장의 매장 조리·플레이팅 가이드를 배포합니다. 자료실에서 PDF를 내려받아 전 직원 교육 부탁드립니다.', '-1 day');
  insNotice.run('본사', '9월 위생 점검 일정 공지',
    '9월 둘째 주 전 지점 정기 위생 점검이 진행됩니다. 지점별 세부 일정은 추후 개별 안내드립니다.', '-3 days');
  insNotice.run('이벤트', '가을 시즌 배너 시안 다운로드',
    '가을 시즌 프로모션 배너 시안(온라인용/매장 부착용)이 준비되었습니다. 자료실에서 내려받아 사용해 주세요.', '-5 days');

  // 샘플 발주 1건 (수원점, 완료 상태)
  const orderId = db.prepare(
    `INSERT INTO orders (store_id, status, total, created_at) VALUES (?,?,?, datetime('now','localtime','-2 days'))`)
    .run(suwon, '완료', 251000).lastInsertRowid;
  const insItem = db.prepare(
    'INSERT INTO order_items (order_id, product_id, name, price, qty) VALUES (?,?,?,?,?)');
  insItem.run(orderId, 1, '간장게장', 38000, 4);
  insItem.run(orderId, 4, '간장새우장', 16500, 6);

  console.log('[db] 시드 데이터 생성 완료 (계정: hq / suwon / gangnam, 비밀번호: bonga1234)');
}

seed();

module.exports = db;
