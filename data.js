// 한큐배달 데이터 계층 — Postgres(Supabase)와 SQLite(로컬) 겸용, 멀티 브랜드(테넌트)
const path = require('path');
const bcrypt = require('bcryptjs');

const SCHEMA_VERSION = '4';

const PG_URL = process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL || process.env.POSTGRES_URL_NON_POOLING;
const dialect = PG_URL ? 'pg' : 'sqlite';

// ---------- KST 시간 유틸 (서버가 UTC여도 한국 기준으로 집계) ----------
function kstParts(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000 + 9 * 3600000);
  return d.toISOString();
}
const kstDate = (offsetDays = 0) => kstParts(offsetDays).slice(0, 10);
const kstNow = () => kstParts(0).slice(0, 19).replace('T', ' ');

// ---------- 백엔드 ----------
let pgPool = null, sq = null;

if (dialect === 'pg') {
  const { Pool, types } = require('pg');
  types.setTypeParser(20, v => parseInt(v, 10));
  types.setTypeParser(1700, v => parseFloat(v));
  // URL의 sslmode 파라미터가 pg의 ssl 옵션을 덮어쓰므로 제거하고 명시 설정을 쓴다
  const u = new URL(PG_URL);
  u.searchParams.delete('sslmode');
  pgPool = new Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false }, max: 3 });
} else {
  const { DatabaseSync } = require('node:sqlite');
  const DB_PATH = process.env.VERCEL ? '/tmp/hanq.db' : path.join(__dirname, 'hanq.db');
  sq = new DatabaseSync(DB_PATH);
  sq.exec('PRAGMA journal_mode = WAL;');
}

const toPgParams = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };

async function query(sql, params = []) {
  if (dialect === 'pg') return (await pgPool.query(toPgParams(sql), params)).rows;
  return sq.prepare(sql).all(...params);
}
async function one(sql, params = []) { return (await query(sql, params))[0]; }
async function run(sql, params = []) {
  if (dialect === 'pg') { const r = await pgPool.query(toPgParams(sql), params); return { changes: r.rowCount }; }
  const r = sq.prepare(sql).run(...params); return { changes: r.changes };
}
async function insert(sql, params = []) {
  if (dialect === 'pg') return (await pgPool.query(toPgParams(sql) + ' RETURNING id', params)).rows[0].id;
  return sq.prepare(sql).run(...params).lastInsertRowid;
}
async function insertIgnore(sql, params = []) {
  if (dialect === 'pg') { await pgPool.query(toPgParams(sql) + ' ON CONFLICT DO NOTHING', params); return; }
  sq.prepare(sql.replace(/^INSERT/i, 'INSERT OR IGNORE')).run(...params);
}

// ---------- 스키마 ----------
const PK = dialect === 'pg' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
const TABLES = ['leads', 'customer_orders', 'chat_logs', 'faqs', 'notice_reads', 'order_items',
  'orders', 'notices', 'reviews', 'sales', 'products', 'users', 'brands'];

async function ensureSchema() {
  await run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const ver = await one(`SELECT value FROM meta WHERE key = 'schema_version'`);
  if (ver?.value === SCHEMA_VERSION) {
    try {
      const users = await one('SELECT COUNT(*) AS c FROM users');
      const sales = await one('SELECT COUNT(*) AS c FROM sales');
      if (users.c > 0 && sales.c >= 500) return false;   // 정상 시드 완료 상태
    } catch (e) { /* 테이블 손상 — 아래에서 재구축 */ }
  }
  // 구버전 스키마 또는 불완전 시드 — 전부 재구축 (데모 단계이므로 안전)
  for (const t of TABLES) await run(`DROP TABLE IF EXISTS ${t}`);

  const ddl = [
    `CREATE TABLE brands (id ${PK}, name TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE users (
      id ${PK}, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL, brand_id INTEGER NOT NULL, store_name TEXT,
      plan TEXT NOT NULL DEFAULT 'basic', auto_accept INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL)`,
    `CREATE TABLE sales (
      id ${PK}, store_id INTEGER NOT NULL, date TEXT NOT NULL, channel TEXT NOT NULL,
      amount INTEGER NOT NULL, orders_count INTEGER NOT NULL DEFAULT 0)`,
    `CREATE INDEX idx_sales_store_date ON sales(store_id, date)`,
    `CREATE TABLE reviews (
      id ${PK}, store_id INTEGER NOT NULL, platform TEXT NOT NULL, author TEXT NOT NULL,
      rating INTEGER NOT NULL, body TEXT NOT NULL, reply TEXT, reply_at TEXT, created_at TEXT NOT NULL)`,
    `CREATE TABLE products (
      id ${PK}, brand_id INTEGER NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL,
      price INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE orders (
      id ${PK}, store_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT '접수',
      total INTEGER NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE order_items (
      id ${PK}, order_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      name TEXT NOT NULL, price INTEGER NOT NULL, qty INTEGER NOT NULL)`,
    `CREATE TABLE notices (
      id ${PK}, brand_id INTEGER NOT NULL, tag TEXT NOT NULL DEFAULT '본사',
      title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE notice_reads (
      notice_id INTEGER NOT NULL, store_id INTEGER NOT NULL, read_at TEXT NOT NULL,
      PRIMARY KEY (notice_id, store_id))`,
    `CREATE TABLE faqs (
      id ${PK}, brand_id INTEGER NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL,
      created_at TEXT NOT NULL)`,
    `CREATE TABLE chat_logs (
      id ${PK}, brand_id INTEGER NOT NULL, store_id INTEGER NOT NULL,
      question TEXT NOT NULL, answer TEXT NOT NULL, answered INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL)`,
    `CREATE TABLE customer_orders (
      id ${PK}, store_id INTEGER NOT NULL, platform TEXT NOT NULL,
      items TEXT NOT NULL, total INTEGER NOT NULL, customer TEXT NOT NULL,
      request TEXT, status TEXT NOT NULL DEFAULT '신규', created_at TEXT NOT NULL)`,
    `CREATE TABLE leads (
      id ${PK}, name TEXT NOT NULL, phone TEXT NOT NULL, brand_name TEXT,
      message TEXT, created_at TEXT NOT NULL)`,
  ];
  for (const s of ddl) await run(s);
  return true;   // 시드 필요
}

// ---------- 시드 ----------
async function seed() {
  const hash = bcrypt.hashSync('bonga1234', 10);
  const now = kstNow();
  const at = (offsetH) => kstParts(-offsetH / 24).slice(0, 19).replace('T', ' ');

  const addBrand = (name) => insert('INSERT INTO brands (name, created_at) VALUES (?,?)', [name, now]);
  const addUser = (u, role, brandId, storeName, plan) => insert(
    'INSERT INTO users (username, password_hash, role, brand_id, store_name, plan, created_at) VALUES (?,?,?,?,?,?,?)',
    [u, hash, role, brandId, storeName, plan, now]);
  const addProducts = async (brandId, list) => {
    for (const [n, u, p] of list)
      await run('INSERT INTO products (brand_id, name, unit, price) VALUES (?,?,?,?)', [brandId, n, u, p]);
  };
  const addFaqs = async (brandId, list) => {
    for (const [q, a] of list)
      await run('INSERT INTO faqs (brand_id, question, answer, created_at) VALUES (?,?,?,?)', [brandId, q, a, now]);
  };

  // ===== 브랜드 1: 경주본가 (K-푸드 밀키트) =====
  const bonga = await addBrand('경주본가');
  await addUser('hq', 'hq', bonga, '경주본가 본사', 'pro');
  const suwon = await addUser('suwon', 'store', bonga, '경주본가 수원인계점', 'pro');
  const gangnam = await addUser('gangnam', 'store', bonga, '경주본가 강남점', 'basic');
  await addProducts(bonga, [
    ['간장게장', '1kg', 38000], ['양념게장', '1kg', 36000], ['울진대게장', '500g', 42000],
    ['간장새우장', '500g', 16500], ['양념새우장', '500g', 16500],
    ['양념닭갈비', '1kg', 14000], ['간장닭갈비', '1kg', 14000],
    ['대파쭈꾸미', '500g', 12500], ['가오리무침', '500g', 11000],
    ['해파리냉채', '300g', 9500], ['부추양념꼬막장', '300g', 13500],
  ]);
  await addFaqs(bonga, [
    ['발주 마감이 몇 시예요?', '매일 오후 5시입니다. 5시 이전에 접수된 발주는 다음 날 오전 매장에 도착합니다.'],
    ['정산은 언제 들어오나요?', '매월 15일에 전월 정산분이 등록된 계좌로 입금됩니다. 정산 내역은 앱의 정산 탭에서 확인할 수 있습니다.'],
    ['AI 리뷰 답글은 어떻게 쓰나요?', '리뷰 관리 탭에서 답글 대기 리뷰의 "AI 답글 초안" 버튼을 누르면 초안이 생성됩니다. 내용을 확인·수정한 뒤 "답글 등록"을 누르면 됩니다. 프로 플랜 전용 기능입니다.'],
    ['프로 플랜은 얼마인가요?', '월 29,000원입니다. AI 리뷰 답글 무제한, 부정 리뷰 실시간 알림, 주간 매출 리포트가 포함됩니다. 요금제 탭에서 변경할 수 있습니다.'],
    ['위생 점검은 언제 하나요?', '분기별 정기 점검이 있으며, 세부 일정은 본사 소식 탭의 공지를 확인해 주세요.'],
    ['신메뉴 조리 가이드는 어디서 받나요?', '본사 소식 탭의 신메뉴 공지에 첨부된 자료실 링크에서 내려받을 수 있습니다.'],
  ]);

  // ===== 브랜드 2: 달빛커피 (카페 프랜차이즈 — 멀티 브랜드 데모) =====
  const moon = await addBrand('달빛커피');
  await addUser('hq2', 'hq', moon, '달빛커피 본사', 'pro');
  const mapo = await addUser('mapo', 'store', moon, '달빛커피 마포점', 'basic');
  await addProducts(moon, [
    ['시그니처 원두', '1kg', 28000], ['콜드브루 원액', '500ml', 12000],
    ['바닐라 시럽', '750ml', 9000], ['종이컵(무지)', '1박스', 15000],
    ['크루아상 냉동생지', '20입', 22000], ['달빛 텀블러', '1개', 18000],
  ]);
  await addFaqs(moon, [
    ['발주 마감이 몇 시예요?', '매일 오후 4시입니다. 원두류는 로스팅 일정에 따라 이틀 뒤 도착할 수 있습니다.'],
    ['원두 유통기한은 어떻게 되나요?', '로스팅일로부터 3개월입니다. 포장에 표기된 로스팅일을 확인해 주세요.'],
    ['정산은 언제 들어오나요?', '매월 10일에 전월 정산분이 입금됩니다.'],
  ]);

  // ===== 매출 시드 (3개 지점, 최근 35일) — 일괄 INSERT =====
  let rngState = 42;
  const rng = () => { rngState = (rngState * 1103515245 + 12345) % 2147483648; return rngState / 2147483648; };
  const channels = [['baemin', 0.38], ['coupang', 0.22], ['yogiyo', 0.08], ['hall', 0.24], ['takeout', 0.08]];
  const salesRows = [];
  for (const [storeId, base] of [[suwon, 1150000], [gangnam, 1580000], [mapo, 860000]]) {
    for (let d = 35; d >= 1; d--) {
      const dateStr = kstDate(-d);
      const dow = new Date(dateStr + 'T00:00:00Z').getUTCDay();
      const boost = (dow === 5 || dow === 6) ? 1.35 : (dow === 0 ? 1.15 : 1.0);
      const dayTotal = Math.round(base * boost * (0.82 + rng() * 0.4));
      for (const [ch, share] of channels) {
        const amount = Math.round(dayTotal * share * (0.85 + rng() * 0.3) / 100) * 100;
        const ordersCount = Math.max(1, Math.round(amount / (19000 + rng() * 6000)));
        salesRows.push([storeId, dateStr, ch, amount, ordersCount]);
      }
    }
  }
  for (let i = 0; i < salesRows.length; i += 100) {
    const chunk = salesRows.slice(i, i + 100);
    await run('INSERT INTO sales (store_id, date, channel, amount, orders_count) VALUES ' +
      chunk.map(() => '(?,?,?,?,?)').join(','), chunk.flat());
  }

  // ===== 리뷰 =====
  const reviews = [
    [suwon, '배달의민족', '김*진', 5, '간장게장 진짜 밥도둑이에요. 살이 꽉 차 있어서 놀랐어요!', null, at(2)],
    [suwon, '쿠팡이츠', '이*아', 4, '닭갈비 양념이 좋았는데 배달이 조금 늦었어요.', null, at(5)],
    [suwon, '배달의민족', '박*수', 2, '새우장이 사진보다 양이 적게 느껴졌습니다.', null, at(24)],
    [suwon, '네이버', '최*희', 5, '부모님 선물로 보냈는데 너무 좋아하셨어요. 포장도 깔끔!',
      '소중한 후기 감사합니다. 부모님께서 좋아하셨다니 저희도 기쁩니다. 늘 정성껏 준비하겠습니다!', at(72)],
    [gangnam, '배달의민족', '정*우', 5, '울진대게장 처음 먹어봤는데 신세계네요.', null, at(3)],
    [gangnam, '쿠팡이츠', '한*별', 3, '맛은 있는데 가격이 조금 부담스러워요.', null, at(24)],
    [gangnam, '배달의민족', '오*민', 5, '재주문 3번째입니다. 꼬막장 최고!', null, at(48)],
    [mapo, '네이버', '서*연', 5, '콜드브루가 진짜 부드러워요. 원두도 구매했습니다!', null, at(6)],
    [mapo, '배달의민족', '임*호', 4, '크루아상이 맛있는데 조금 식어서 왔어요.', null, at(30)],
  ];
  for (const r of reviews)
    await run(`INSERT INTO reviews (store_id, platform, author, rating, body, reply, reply_at, created_at)
               VALUES (?,?,?,?,?,?,?,?)`, [r[0], r[1], r[2], r[3], r[4], r[5], r[5] ? at(48) : null, r[6]]);

  // ===== 공지 =====
  const notices = [
    [bonga, '본사', '추석 선물세트 사전예약 오픈 안내',
      '9월 10일부터 추석 선물세트(간장게장 프리미엄 세트, 새우장 혼합 세트) 사전예약이 시작됩니다. 지점별 예약 물량은 발주 시스템에서 신청해 주세요.', at(3)],
    [bonga, '신메뉴', '부추양념꼬막장 조리 가이드 배포',
      '신메뉴 부추양념꼬막장의 매장 조리·플레이팅 가이드를 배포합니다. 자료실에서 PDF를 내려받아 전 직원 교육 부탁드립니다.', at(24)],
    [bonga, '본사', '9월 위생 점검 일정 공지',
      '9월 둘째 주 전 지점 정기 위생 점검이 진행됩니다. 지점별 세부 일정은 추후 개별 안내드립니다.', at(72)],
    [bonga, '이벤트', '가을 시즌 배너 시안 다운로드',
      '가을 시즌 프로모션 배너 시안(온라인용/매장 부착용)이 준비되었습니다. 자료실에서 내려받아 사용해 주세요.', at(120)],
    [moon, '본사', '가을 신메뉴 "달빛 라떼" 출시 안내',
      '10월 1일부터 전 지점에서 달빛 라떼가 출시됩니다. 레시피 교육 영상을 자료실에서 확인해 주세요.', at(10)],
    [moon, '이벤트', '텀블러 구매 고객 음료 할인 이벤트',
      '9월 한 달간 달빛 텀블러 지참 고객에게 음료 500원 할인이 적용됩니다. 포스터를 매장에 부착해 주세요.', at(48)],
  ];
  for (const [brandId, tag, title, body, ts] of notices)
    await run('INSERT INTO notices (brand_id, tag, title, body, created_at) VALUES (?,?,?,?,?)',
      [brandId, tag, title, body, ts]);

  // ===== 배달앱 고객 주문 (신규 주문 접수 데모) =====
  const cOrders = [
    [suwon, '배달의민족', [{ name: '간장게장 정식', qty: 1, price: 32000 }, { name: '공기밥 추가', qty: 2, price: 2000 }],
      36000, '김*민 (010-****-3421)', '게딱지 많이 주세요!', '신규', at(0.05)],
    [suwon, '쿠팡이츠', [{ name: '양념닭갈비 2인', qty: 1, price: 29000 }], 29000, '이*서 (010-****-8810)', null, '신규', at(0.2)],
    [suwon, '요기요', [{ name: '새우장 덮밥', qty: 2, price: 15000 }], 30000, '박*훈 (010-****-1102)', '수저 빼주세요', '배달중', at(1)],
    [suwon, '배달의민족', [{ name: '간장게장 정식', qty: 1, price: 32000 }], 32000, '최*아 (010-****-5566)', null, '완료', at(3)],
    [gangnam, '배달의민족', [{ name: '울진대게장 세트', qty: 1, price: 55000 }], 55000, '정*원 (010-****-2244)', null, '신규', at(0.1)],
    [mapo, '쿠팡이츠', [{ name: '콜드브루 라떼', qty: 2, price: 5500 }, { name: '크루아상', qty: 1, price: 4200 }],
      15200, '한*별 (010-****-7788)', '얼음 적게요', '신규', at(0.08)],
  ];
  for (const [sid, platform, items, total, customer, request, status, ts] of cOrders)
    await run(`INSERT INTO customer_orders (store_id, platform, items, total, customer, request, status, created_at)
               VALUES (?,?,?,?,?,?,?,?)`, [sid, platform, JSON.stringify(items), total, customer, request, status, ts]);

  // ===== 샘플 발주 =====
  const orderId = await insert('INSERT INTO orders (store_id, status, total, created_at) VALUES (?,?,?,?)',
    [suwon, '완료', 251000, at(48)]);
  await run('INSERT INTO order_items (order_id, product_id, name, price, qty) VALUES (?,?,?,?,?)',
    [orderId, 1, '간장게장', 38000, 4]);
  await run('INSERT INTO order_items (order_id, product_id, name, price, qty) VALUES (?,?,?,?,?)',
    [orderId, 4, '간장새우장', 16500, 6]);

  await run(`DELETE FROM meta WHERE key = 'schema_version'`);
  await run(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`, [SCHEMA_VERSION]);
  console.log(`[data] 시드 완료 (${dialect}, v${SCHEMA_VERSION}) — 브랜드 2개, 계정: hq/suwon/gangnam/hq2/mapo (비번 bonga1234)`);
}

let readyPromise = null;
function init() {
  if (!readyPromise) readyPromise = (async () => { if (await ensureSchema()) await seed(); })();
  return readyPromise;
}

module.exports = { dialect, query, one, run, insert, insertIgnore, init, kstDate, kstNow };
