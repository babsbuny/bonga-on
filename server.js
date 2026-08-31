// 본가ON — 경주본가 가맹점 운영 플랫폼 서버
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 8321;

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 },
}));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 인증 ----------
function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '로그인이 필요합니다' });
  next();
}
function requireHq(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'hq')
    return res.status(403).json({ error: '본사 계정만 접근할 수 있습니다' });
  next();
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '아이디와 비밀번호를 입력해 주세요' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: '아이디 또는 비밀번호가 맞지 않습니다' });
  req.session.user = { id: user.id, username: user.username, role: user.role, store_name: user.store_name, plan: user.plan };
  res.json({ user: req.session.user });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', requireLogin, (req, res) => res.json({ user: req.session.user }));

// ---------- 대시보드 ----------
app.get('/api/dashboard', requireLogin, (req, res) => {
  const storeId = req.session.user.id;
  const yesterday = db.prepare(`
    SELECT COALESCE(SUM(amount),0) AS amount, COALESCE(SUM(orders_count),0) AS orders
    FROM sales WHERE store_id = ? AND date = date('now','localtime','-1 day')`).get(storeId);
  const lastWeekSameDay = db.prepare(`
    SELECT COALESCE(SUM(amount),0) AS amount FROM sales
    WHERE store_id = ? AND date = date('now','localtime','-8 day')`).get(storeId);
  const channelsYesterday = db.prepare(`
    SELECT channel, SUM(amount) AS amount, SUM(orders_count) AS orders FROM sales
    WHERE store_id = ? AND date = date('now','localtime','-1 day') GROUP BY channel`).all(storeId);
  const week = db.prepare(`
    SELECT date, SUM(amount) AS amount FROM sales
    WHERE store_id = ? AND date >= date('now','localtime','-7 day') AND date < date('now','localtime')
    GROUP BY date ORDER BY date`).all(storeId);
  const reviewStats = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN reply IS NULL THEN 1 ELSE 0 END) AS pending,
           ROUND(AVG(rating),1) AS avg_rating
    FROM reviews WHERE store_id = ?`).get(storeId);
  const unreadNotices = db.prepare(`
    SELECT COUNT(*) AS c FROM notices n
    WHERE NOT EXISTS (SELECT 1 FROM notice_reads r WHERE r.notice_id = n.id AND r.store_id = ?)`).get(storeId).c;
  const pendingOrders = db.prepare(`
    SELECT COUNT(*) AS c FROM orders WHERE store_id = ? AND status IN ('접수','확정','배송중')`).get(storeId).c;

  const diff = yesterday.amount - lastWeekSameDay.amount;
  res.json({
    yesterday: { ...yesterday, diff, diffPct: lastWeekSameDay.amount ? +(diff / lastWeekSameDay.amount * 100).toFixed(1) : null },
    channelsYesterday, week,
    reviews: reviewStats,
    unreadNotices, pendingOrders,
  });
});

// ---------- 매출 ----------
app.get('/api/sales', requireLogin, (req, res) => {
  const days = Math.min(parseInt(req.query.days || '30', 10), 90);
  const rows = db.prepare(`
    SELECT date, channel, SUM(amount) AS amount, SUM(orders_count) AS orders FROM sales
    WHERE store_id = ? AND date >= date('now','localtime', ?)
    GROUP BY date, channel ORDER BY date`).all(req.session.user.id, `-${days} day`);
  res.json({ rows });
});

app.post('/api/sales', requireLogin, (req, res) => {
  const { date, channel, amount, orders_count } = req.body || {};
  if (!date || !channel || !(amount > 0))
    return res.status(400).json({ error: '날짜, 채널, 금액을 확인해 주세요' });
  if (!['baemin', 'coupang', 'yogiyo', 'hall', 'takeout'].includes(channel))
    return res.status(400).json({ error: '알 수 없는 채널입니다' });
  db.prepare('INSERT INTO sales (store_id, date, channel, amount, orders_count) VALUES (?,?,?,?,?)')
    .run(req.session.user.id, date, channel, Math.round(amount), Math.max(0, parseInt(orders_count || 0, 10)));
  res.json({ ok: true });
});

// ---------- 리뷰 ----------
app.get('/api/reviews', requireLogin, (req, res) => {
  const filter = req.query.filter === 'pending' ? 'AND reply IS NULL' : '';
  const rows = db.prepare(`
    SELECT id, platform, author, rating, body, reply, reply_at, created_at
    FROM reviews WHERE store_id = ? ${filter} ORDER BY (reply IS NULL) DESC, created_at DESC`)
    .all(req.session.user.id);
  res.json({ rows });
});

// AI 답글 초안 — OpenRouter 경유, 실패 시 규칙 기반 대체
const AI_MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-haiku-4.5';
async function aiDraft(review, storeName) {
  const key = process.env.OPENROUTER_API_KEY;
  if (key) {
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: AI_MODEL,
          max_tokens: 400,
          messages: [{
            role: 'user',
            content:
`너는 한국의 프리미엄 K-푸드 밀키트 프랜차이즈 "경주본가"의 가맹점 "${storeName}" 사장님이다.
30년 전통, 정성 어린 손맛, 신선한 재료가 브랜드 자부심이다.
아래 고객 리뷰에 대한 답글을 작성하라.

규칙:
- 존댓말, 따뜻하고 진정성 있는 톤. 과한 이모지 금지(0~1개).
- 3~4문장, 200자 이내.
- 별점이 낮으면(3점 이하) 진심 어린 사과 + 구체적 개선 약속 + 매장 연락 안내.
- 별점이 높으면 감사 + 다른 메뉴 추천 또는 재방문 유도.
- 답글 본문만 출력하고 따옴표나 설명은 붙이지 마라.

플랫폼: ${review.platform}
별점: ${review.rating}/5
리뷰: ${review.body}`,
          }],
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const text = data.choices?.[0]?.message?.content?.trim();
        if (text) return { draft: text, source: 'ai' };
      } else {
        console.error('[ai] OpenRouter 오류:', resp.status, await resp.text().catch(() => ''));
      }
    } catch (e) {
      console.error('[ai] 호출 실패:', e.message);
    }
  }
  // 대체 답글 (API 키 없음/실패 시)
  const fallback = review.rating <= 3
    ? `기대에 미치지 못해 진심으로 죄송합니다. 말씀 주신 부분은 바로 점검해 개선하겠습니다. 매장으로 연락 주시면 성의껏 보답하고 싶습니다. 소중한 의견 감사합니다.`
    : `소중한 후기 감사합니다. 30년 전통 비법 그대로 정성껏 준비하고 있습니다. 다음에는 다른 메뉴도 꼭 한번 드셔보세요. 또 뵙겠습니다!`;
  return { draft: fallback, source: 'fallback' };
}

app.post('/api/reviews/:id/draft', requireLogin, async (req, res) => {
  if (req.session.user.plan !== 'pro' && req.session.user.role !== 'hq')
    return res.status(402).json({ error: 'AI 답글은 프로 플랜 기능입니다. 요금제 탭에서 업그레이드하세요.' });
  const review = db.prepare('SELECT * FROM reviews WHERE id = ? AND store_id = ?')
    .get(req.params.id, req.session.user.id);
  if (!review) return res.status(404).json({ error: '리뷰를 찾을 수 없습니다' });
  const result = await aiDraft(review, req.session.user.store_name);
  res.json(result);
});

app.put('/api/reviews/:id/reply', requireLogin, (req, res) => {
  const { reply } = req.body || {};
  if (!reply || !reply.trim()) return res.status(400).json({ error: '답글 내용을 입력해 주세요' });
  const r = db.prepare(`
    UPDATE reviews SET reply = ?, reply_at = datetime('now','localtime')
    WHERE id = ? AND store_id = ?`).run(reply.trim(), req.params.id, req.session.user.id);
  if (r.changes === 0) return res.status(404).json({ error: '리뷰를 찾을 수 없습니다' });
  res.json({ ok: true });
});

// ---------- 발주 ----------
app.get('/api/products', requireLogin, (req, res) => {
  res.json({ rows: db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY id').all() });
});

app.post('/api/orders', requireLogin, (req, res) => {
  const items = (req.body?.items || []).filter(i => i.qty > 0);
  if (items.length === 0) return res.status(400).json({ error: '발주 품목을 담아 주세요' });
  const getProduct = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1');
  let total = 0;
  const resolved = [];
  for (const it of items) {
    const p = getProduct.get(it.product_id);
    if (!p) return res.status(400).json({ error: '없는 품목이 포함되어 있습니다' });
    const qty = Math.min(999, Math.max(1, parseInt(it.qty, 10)));
    total += p.price * qty;
    resolved.push({ p, qty });
  }
  const orderId = db.prepare('INSERT INTO orders (store_id, total) VALUES (?,?)')
    .run(req.session.user.id, total).lastInsertRowid;
  const insItem = db.prepare(
    'INSERT INTO order_items (order_id, product_id, name, price, qty) VALUES (?,?,?,?,?)');
  for (const { p, qty } of resolved) insItem.run(orderId, p.id, p.name, p.price, qty);
  res.json({ ok: true, orderId, total });
});

app.get('/api/orders', requireLogin, (req, res) => {
  const orders = db.prepare(
    'SELECT * FROM orders WHERE store_id = ? ORDER BY created_at DESC LIMIT 30').all(req.session.user.id);
  const getItems = db.prepare('SELECT name, price, qty FROM order_items WHERE order_id = ?');
  res.json({ rows: orders.map(o => ({ ...o, items: getItems.all(o.id) })) });
});

// ---------- 공지 ----------
app.get('/api/notices', requireLogin, (req, res) => {
  const rows = db.prepare(`
    SELECT n.*, (SELECT 1 FROM notice_reads r WHERE r.notice_id = n.id AND r.store_id = ?) AS is_read
    FROM notices n ORDER BY n.created_at DESC`).all(req.session.user.id);
  res.json({ rows });
});

app.post('/api/notices/:id/read', requireLogin, (req, res) => {
  db.prepare('INSERT OR IGNORE INTO notice_reads (notice_id, store_id) VALUES (?,?)')
    .run(req.params.id, req.session.user.id);
  res.json({ ok: true });
});

// ---------- 본사(HQ) ----------
app.get('/api/hq/overview', requireHq, (req, res) => {
  const stores = db.prepare(`
    SELECT u.id, u.store_name, u.plan,
      (SELECT COALESCE(SUM(amount),0) FROM sales s WHERE s.store_id = u.id AND s.date = date('now','localtime','-1 day')) AS yesterday,
      (SELECT COALESCE(SUM(amount),0) FROM sales s WHERE s.store_id = u.id AND s.date >= date('now','localtime','-7 day')) AS week,
      (SELECT COUNT(*) FROM reviews r WHERE r.store_id = u.id AND r.reply IS NULL) AS pending_reviews,
      (SELECT ROUND(AVG(rating),1) FROM reviews r WHERE r.store_id = u.id) AS avg_rating
    FROM users u WHERE u.role = 'store' ORDER BY u.id`).all();
  const pendingOrders = db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE status = '접수'`).get().c;
  res.json({ stores, pendingOrders });
});

app.get('/api/hq/orders', requireHq, (req, res) => {
  const orders = db.prepare(`
    SELECT o.*, u.store_name FROM orders o JOIN users u ON u.id = o.store_id
    ORDER BY o.created_at DESC LIMIT 50`).all();
  const getItems = db.prepare('SELECT name, price, qty FROM order_items WHERE order_id = ?');
  res.json({ rows: orders.map(o => ({ ...o, items: getItems.all(o.id) })) });
});

app.put('/api/hq/orders/:id/status', requireHq, (req, res) => {
  const { status } = req.body || {};
  if (!['접수', '확정', '배송중', '완료', '취소'].includes(status))
    return res.status(400).json({ error: '알 수 없는 상태입니다' });
  const r = db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: '발주를 찾을 수 없습니다' });
  res.json({ ok: true });
});

app.post('/api/hq/notices', requireHq, (req, res) => {
  const { tag, title, body } = req.body || {};
  if (!title?.trim() || !body?.trim()) return res.status(400).json({ error: '제목과 내용을 입력해 주세요' });
  db.prepare('INSERT INTO notices (tag, title, body) VALUES (?,?,?)')
    .run((tag || '본사').trim(), title.trim(), body.trim());
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[본가ON] http://localhost:${PORT}`);
  console.log(`[본가ON] AI 답글: ${process.env.OPENROUTER_API_KEY ? `OpenRouter (${AI_MODEL})` : '규칙 기반 대체 모드 (OPENROUTER_API_KEY 없음)'}`);
});
