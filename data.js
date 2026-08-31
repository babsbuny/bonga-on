// 한큐배달 데이터 계층 — Postgres(Supabase)와 SQLite(로컬) 겸용
// 배포 환경(POSTGRES_URL 존재)에서는 Supabase Postgres, 로컬에서는 Node 내장 SQLite를 사용한다.
const path = require('path');
const bcrypt = require('bcryptjs');

const PG_URL = process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL || process.env.POSTGRES_URL_NON_POOLING;
const dialect = PG_URL ? 'pg' : 'sqlite';

// ---------- KST 시간 유틸 (서버가 UTC여도 한국 기준으로 집계) ----------
function kstParts(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000 + 9 * 3600000);
  return d.toISOString(); // KST로 밀어둔 UTC 표현
}
const kstDate = (offsetDays = 0) => kstParts(offsetDays).slice(0, 10);
const kstNow = () => kstParts(0).slice(0, 19).replace('T', ' ');

// ---------- 백엔드 ----------
let pgPool = null, sq = null;

if (dialect === 'pg') {
  const { Pool, types } = require('pg');
  types.setTypeParser(20, v => parseInt(v, 10));     // int8 (SUM 등)
  types.setTypeParser(1700, v => parseFloat(v));     // numeric (AVG/ROUND 등)
  // URL의 sslmode 파라미터가 pg의 ssl 옵션을 덮어쓰므로 제거하고 명시 설정을 쓴다
  const u = new URL(PG_URL);
  u.searchParams.delete('sslmode');
  pgPool = new Pool({
    connectionString: u.toString(),
    ssl: { rejectUnauthorized: false },
    max: 3,
  });
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

// ---------- 스키마 + 시드 ----------
const PK = dialect === 'pg' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';

async function ensureSchema() {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS users (
      id ${PK}, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL, brand TEXT NOT NULL DEFAULT '', store_name TEXT,
      plan TEXT NOT NULL DEFAULT 'basic', created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS sales (
      id ${PK}, store_id INTEGER NOT NULL, date TEXT NOT NULL, channel TEXT NOT NULL,
      amount INTEGER NOT NULL, orders_count INTEGER NOT NULL DEFAULT 0)`,
    `CREATE INDEX IF NOT EXISTS idx_sales_store_date ON sales(store_id, date)`,
    `CREATE TABLE IF NOT EXISTS reviews (
      id ${PK}, store_id INTEGER NOT NULL, platform TEXT NOT NULL, author TEXT NOT NULL,
      rating INTEGER NOT NULL, body TEXT NOT NULL, reply TEXT, reply_at TEXT, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS products (
      id ${PK}, name TEXT NOT NULL, unit TEXT NOT NULL, price INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS orders (
      id ${PK}, store_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT '접수',
      total INTEGER NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS order_items (
      id ${PK}, order_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      name TEXT NOT NULL, price INTEGER NOT NULL, qty INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS notices (
      id ${PK}, tag TEXT NOT NULL DEFAULT '본사', title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS notice_reads (
      notice_id INTEGER NOT NULL, store_id INTEGER NOT NULL, read_at TEXT NOT NULL,
      PRIMARY KEY (notice_id, store_id))`,
  ];
  for (const s of ddl) await run(s);
}

async function seed() {
  const users = await one('SELECT COUNT(*) AS c FROM users');
  const sales = await one('SELECT COUNT(*) AS c FROM sales');
  if (users.c > 0 && sales.c >= 350) return;
  if (users.c > 0) {
    // 이전 시드가 도중에 끊긴 상태 — 정리 후 다시 시드
    for (const t of ['notice_reads', 'order_items', 'orders', 'notices', 'reviews', 'sales', 'products', 'users'])
      await run(`DELETE FROM ${t}`);
  }

  const BRAND = '경주본가';   // 첫 데모 고객사
  const hash = bcrypt.hashSync('bonga1234', 10);
  const now = kstNow();
  const at = (offsetH) => kstParts(-offsetH / 24).slice(0, 19).replace('T', ' ');

  const insUser = (u, r, s, p) => insert(
    'INSERT INTO users (username, password_hash, role, brand, store_name, plan, created_at) VALUES (?,?,?,?,?,?,?)',
    [u, hash, r, BRAND, s, p, now]);
  await insUser('hq', 'hq', `${BRAND} 본사`, 'pro');
  const suwon = await insUser('suwon', 'store', `${BRAND} 수원인계점`, 'pro');
  const gangnam = await insUser('gangnam', 'store', `${BRAND} 강남점`, 'basic');

  const products = [
    ['간장게장', '1kg', 38000], ['양념게장', '1kg', 36000], ['울진대게장', '500g', 42000],
    ['간장새우장', '500g', 16500], ['양념새우장', '500g', 16500],
    ['양념닭갈비', '1kg', 14000], ['간장닭갈비', '1kg', 14000],
    ['대파쭈꾸미', '500g', 12500], ['가오리무침', '500g', 11000],
    ['해파리냉채', '300g', 9500], ['부추양념꼬막장', '300g', 13500],
  ];
  for (const [n, u, p] of products)
    await run('INSERT INTO products (name, unit, price) VALUES (?,?,?)', [n, u, p]);

  // 최근 35일 매출 — 시드 고정 의사난수
  let rngState = 42;
  const rng = () => { rngState = (rngState * 1103515245 + 12345) % 2147483648; return rngState / 2147483648; };
  const channels = [['baemin', 0.38], ['coupang', 0.22], ['yogiyo', 0.08], ['hall', 0.24], ['takeout', 0.08]];
  const salesRows = [];
  for (const [storeId, base] of [[suwon, 1150000], [gangnam, 1580000]]) {
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
  // 일괄 INSERT — 왕복 지연이 큰 원격 DB에서 시드가 타임아웃되지 않도록 청크 처리
  for (let i = 0; i < salesRows.length; i += 100) {
    const chunk = salesRows.slice(i, i + 100);
    await run(
      'INSERT INTO sales (store_id, date, channel, amount, orders_count) VALUES ' +
      chunk.map(() => '(?,?,?,?,?)').join(','),
      chunk.flat());
  }

  const reviews = [
    [suwon, '배달의민족', '김*진', 5, '간장게장 진짜 밥도둑이에요. 살이 꽉 차 있어서 놀랐어요!', null, at(2)],
    [suwon, '쿠팡이츠', '이*아', 4, '닭갈비 양념이 좋았는데 배달이 조금 늦었어요.', null, at(5)],
    [suwon, '배달의민족', '박*수', 2, '새우장이 사진보다 양이 적게 느껴졌습니다.', null, at(24)],
    [suwon, '네이버', '최*희', 5, '부모님 선물로 보냈는데 너무 좋아하셨어요. 포장도 깔끔!',
      '소중한 후기 감사합니다. 부모님께서 좋아하셨다니 저희도 기쁩니다. 늘 정성껏 준비하겠습니다!', at(72)],
    [gangnam, '배달의민족', '정*우', 5, '울진대게장 처음 먹어봤는데 신세계네요.', null, at(3)],
    [gangnam, '쿠팡이츠', '한*별', 3, '맛은 있는데 가격이 조금 부담스러워요.', null, at(24)],
    [gangnam, '배달의민족', '오*민', 5, '재주문 3번째입니다. 꼬막장 최고!', null, at(48)],
  ];
  for (const r of reviews)
    await run(`INSERT INTO reviews (store_id, platform, author, rating, body, reply, reply_at, created_at)
               VALUES (?,?,?,?,?,?,?,?)`, [r[0], r[1], r[2], r[3], r[4], r[5], r[5] ? at(48) : null, r[6]]);

  const notices = [
    ['본사', '추석 선물세트 사전예약 오픈 안내',
      '9월 10일부터 추석 선물세트(간장게장 프리미엄 세트, 새우장 혼합 세트) 사전예약이 시작됩니다. 지점별 예약 물량은 발주 시스템에서 신청해 주세요.', at(3)],
    ['신메뉴', '부추양념꼬막장 조리 가이드 배포',
      '신메뉴 부추양념꼬막장의 매장 조리·플레이팅 가이드를 배포합니다. 자료실에서 PDF를 내려받아 전 직원 교육 부탁드립니다.', at(24)],
    ['본사', '9월 위생 점검 일정 공지',
      '9월 둘째 주 전 지점 정기 위생 점검이 진행됩니다. 지점별 세부 일정은 추후 개별 안내드립니다.', at(72)],
    ['이벤트', '가을 시즌 배너 시안 다운로드',
      '가을 시즌 프로모션 배너 시안(온라인용/매장 부착용)이 준비되었습니다. 자료실에서 내려받아 사용해 주세요.', at(120)],
  ];
  for (const [tag, title, body, ts] of notices)
    await run('INSERT INTO notices (tag, title, body, created_at) VALUES (?,?,?,?)', [tag, title, body, ts]);

  const orderId = await insert('INSERT INTO orders (store_id, status, total, created_at) VALUES (?,?,?,?)',
    [suwon, '완료', 251000, at(48)]);
  await run('INSERT INTO order_items (order_id, product_id, name, price, qty) VALUES (?,?,?,?,?)',
    [orderId, 1, '간장게장', 38000, 4]);
  await run('INSERT INTO order_items (order_id, product_id, name, price, qty) VALUES (?,?,?,?,?)',
    [orderId, 4, '간장새우장', 16500, 6]);

  console.log(`[data] 시드 완료 (${dialect}) — 계정: hq / suwon / gangnam, 비밀번호: bonga1234`);
}

let readyPromise = null;
function init() {
  if (!readyPromise) readyPromise = (async () => { await ensureSchema(); await seed(); })();
  return readyPromise;
}

module.exports = { dialect, query, one, run, insert, insertIgnore, init, kstDate, kstNow };
