// 한큐배달 — 가맹점 운영 플랫폼 서버 (Express + Supabase Postgres/SQLite)
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const data = require('./data');

const app = express();
const PORT = process.env.PORT || 8321;
const ready = data.init();

app.use(express.json());
// 서버리스에서도 로그인이 유지되도록 상태는 서명된 쿠키에 저장
app.use(cookieSession({
  name: 'hanq.sess',
  secret: process.env.SESSION_SECRET
    || crypto.createHash('sha256').update(process.env.POSTGRES_URL || 'hanq-local-dev').digest('hex'),
  httpOnly: true, sameSite: 'lax', maxAge: 12 * 3600 * 1000,
}));
app.use(express.static(path.join(__dirname, 'public')));
app.use(async (req, res, next) => { try { await ready; next(); } catch (e) { next(e); } });

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '로그인이 필요합니다' });
  next();
}
function requireHq(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'hq')
    return res.status(403).json({ error: '본사 계정만 접근할 수 있습니다' });
  next();
}

// ---------- 인증 ----------
app.post('/api/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '아이디와 비밀번호를 입력해 주세요' });
  const user = await data.one(
    'SELECT u.*, b.name AS brand FROM users u JOIN brands b ON b.id = u.brand_id WHERE u.username = ?', [username]);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: '아이디 또는 비밀번호가 맞지 않습니다' });
  req.session.user = { id: user.id, username: user.username, role: user.role,
    brand: user.brand, brand_id: user.brand_id, store_name: user.store_name, plan: user.plan };
  res.json({ user: req.session.user });
}));

app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });
app.get('/api/me', requireLogin, (req, res) => res.json({ user: req.session.user }));

// ---------- 대시보드 ----------
app.get('/api/dashboard', requireLogin, wrap(async (req, res) => {
  const sid = req.session.user.id;
  const yDate = data.kstDate(-1), prevDate = data.kstDate(-8);
  const yesterday = await data.one(
    `SELECT COALESCE(SUM(amount),0) AS amount, COALESCE(SUM(orders_count),0) AS orders
     FROM sales WHERE store_id = ? AND date = ?`, [sid, yDate]);
  const lastWeek = await data.one(
    'SELECT COALESCE(SUM(amount),0) AS amount FROM sales WHERE store_id = ? AND date = ?', [sid, prevDate]);
  const channelsYesterday = await data.query(
    `SELECT channel, SUM(amount) AS amount, SUM(orders_count) AS orders
     FROM sales WHERE store_id = ? AND date = ? GROUP BY channel`, [sid, yDate]);
  const week = await data.query(
    `SELECT date, SUM(amount) AS amount FROM sales
     WHERE store_id = ? AND date >= ? AND date < ? GROUP BY date ORDER BY date`,
    [sid, data.kstDate(-7), data.kstDate(0)]);
  const reviewStats = await data.one(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN reply IS NULL THEN 1 ELSE 0 END) AS pending,
            ROUND(AVG(rating), 1) AS avg_rating
     FROM reviews WHERE store_id = ?`, [sid]);
  const unread = await data.one(
    `SELECT COUNT(*) AS c FROM notices n
     WHERE n.brand_id = ?
       AND NOT EXISTS (SELECT 1 FROM notice_reads r WHERE r.notice_id = n.id AND r.store_id = ?)`,
    [req.session.user.brand_id, sid]);
  const pendingOrders = await data.one(
    `SELECT COUNT(*) AS c FROM orders WHERE store_id = ? AND status IN ('접수','확정','배송중')`, [sid]);

  const diff = yesterday.amount - lastWeek.amount;
  res.json({
    yesterday: { ...yesterday, diff,
      diffPct: lastWeek.amount ? +(diff / lastWeek.amount * 100).toFixed(1) : null },
    channelsYesterday, week,
    reviews: reviewStats,
    unreadNotices: unread.c, pendingOrders: pendingOrders.c,
  });
}));

// ---------- 매출 ----------
app.get('/api/sales', requireLogin, wrap(async (req, res) => {
  const days = Math.min(parseInt(req.query.days || '30', 10), 90);
  const rows = await data.query(
    `SELECT date, channel, SUM(amount) AS amount, SUM(orders_count) AS orders
     FROM sales WHERE store_id = ? AND date >= ? GROUP BY date, channel ORDER BY date`,
    [req.session.user.id, data.kstDate(-days)]);
  res.json({ rows });
}));

app.post('/api/sales', requireLogin, wrap(async (req, res) => {
  const { date, channel, amount, orders_count } = req.body || {};
  if (!date || !channel || !(amount > 0))
    return res.status(400).json({ error: '날짜, 채널, 금액을 확인해 주세요' });
  if (!['baemin', 'coupang', 'yogiyo', 'hall', 'takeout'].includes(channel))
    return res.status(400).json({ error: '알 수 없는 채널입니다' });
  await data.run('INSERT INTO sales (store_id, date, channel, amount, orders_count) VALUES (?,?,?,?,?)',
    [req.session.user.id, date, channel, Math.round(amount), Math.max(0, parseInt(orders_count || 0, 10))]);
  res.json({ ok: true });
}));

// ---------- 리뷰 ----------
app.get('/api/reviews', requireLogin, wrap(async (req, res) => {
  const filter = req.query.filter === 'pending' ? 'AND reply IS NULL' : '';
  const rows = await data.query(
    `SELECT id, platform, author, rating, body, reply, reply_at, created_at
     FROM reviews WHERE store_id = ? ${filter}
     ORDER BY (reply IS NULL) DESC, created_at DESC`, [req.session.user.id]);
  res.json({ rows });
}));

// AI 답글 초안 — OpenRouter 경유, 실패 시 규칙 기반 대체
const AI_MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-haiku-4.5';
async function aiDraft(review, brand, storeName) {
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
`너는 외식 브랜드 "${brand}"의 매장 "${storeName}" 사장님이다.
정성 어린 손맛과 신선한 재료가 브랜드 자부심이다.
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
        const d = await resp.json();
        const text = d.choices?.[0]?.message?.content?.trim();
        if (text) return { draft: text, source: 'ai' };
      } else {
        console.error('[ai] OpenRouter 오류:', resp.status, await resp.text().catch(() => ''));
      }
    } catch (e) { console.error('[ai] 호출 실패:', e.message); }
  }
  const fallback = review.rating <= 3
    ? '기대에 미치지 못해 진심으로 죄송합니다. 말씀 주신 부분은 바로 점검해 개선하겠습니다. 매장으로 연락 주시면 성의껏 보답하고 싶습니다. 소중한 의견 감사합니다.'
    : '소중한 후기 감사합니다. 정성껏 준비한 마음을 알아봐 주셔서 기쁩니다. 다음에는 다른 메뉴도 꼭 한번 드셔보세요. 또 뵙겠습니다!';
  return { draft: fallback, source: 'fallback' };
}

app.post('/api/reviews/:id/draft', requireLogin, wrap(async (req, res) => {
  if (req.session.user.plan !== 'pro' && req.session.user.role !== 'hq')
    return res.status(402).json({ error: 'AI 답글은 프로 플랜 기능입니다. 요금제 탭에서 업그레이드하세요.' });
  const review = await data.one('SELECT * FROM reviews WHERE id = ? AND store_id = ?',
    [req.params.id, req.session.user.id]);
  if (!review) return res.status(404).json({ error: '리뷰를 찾을 수 없습니다' });
  res.json(await aiDraft(review, req.session.user.brand, req.session.user.store_name));
}));

app.put('/api/reviews/:id/reply', requireLogin, wrap(async (req, res) => {
  const { reply } = req.body || {};
  if (!reply || !reply.trim()) return res.status(400).json({ error: '답글 내용을 입력해 주세요' });
  const r = await data.run('UPDATE reviews SET reply = ?, reply_at = ? WHERE id = ? AND store_id = ?',
    [reply.trim(), data.kstNow(), req.params.id, req.session.user.id]);
  if (r.changes === 0) return res.status(404).json({ error: '리뷰를 찾을 수 없습니다' });
  res.json({ ok: true });
}));

// ---------- 발주 ----------
app.get('/api/products', requireLogin, wrap(async (req, res) => {
  res.json({ rows: await data.query(
    'SELECT * FROM products WHERE active = 1 AND brand_id = ? ORDER BY id', [req.session.user.brand_id]) });
}));

app.post('/api/orders', requireLogin, wrap(async (req, res) => {
  const items = (req.body?.items || []).filter(i => i.qty > 0);
  if (items.length === 0) return res.status(400).json({ error: '발주 품목을 담아 주세요' });
  let total = 0;
  const resolved = [];
  for (const it of items) {
    const p = await data.one('SELECT * FROM products WHERE id = ? AND active = 1 AND brand_id = ?',
      [it.product_id, req.session.user.brand_id]);
    if (!p) return res.status(400).json({ error: '없는 품목이 포함되어 있습니다' });
    const qty = Math.min(999, Math.max(1, parseInt(it.qty, 10)));
    total += p.price * qty;
    resolved.push({ p, qty });
  }
  const orderId = await data.insert('INSERT INTO orders (store_id, status, total, created_at) VALUES (?,?,?,?)',
    [req.session.user.id, '접수', total, data.kstNow()]);
  for (const { p, qty } of resolved)
    await data.run('INSERT INTO order_items (order_id, product_id, name, price, qty) VALUES (?,?,?,?,?)',
      [orderId, p.id, p.name, p.price, qty]);
  res.json({ ok: true, orderId, total });
}));

app.get('/api/orders', requireLogin, wrap(async (req, res) => {
  const orders = await data.query(
    'SELECT * FROM orders WHERE store_id = ? ORDER BY created_at DESC LIMIT 30', [req.session.user.id]);
  for (const o of orders)
    o.items = await data.query('SELECT name, price, qty FROM order_items WHERE order_id = ?', [o.id]);
  res.json({ rows: orders });
}));

// ---------- 공지 ----------
app.get('/api/notices', requireLogin, wrap(async (req, res) => {
  const rows = await data.query(
    `SELECT n.*, (SELECT 1 FROM notice_reads r WHERE r.notice_id = n.id AND r.store_id = ?) AS is_read
     FROM notices n WHERE n.brand_id = ? ORDER BY n.created_at DESC`,
    [req.session.user.id, req.session.user.brand_id]);
  res.json({ rows });
}));

app.post('/api/notices/:id/read', requireLogin, wrap(async (req, res) => {
  await data.insertIgnore('INSERT INTO notice_reads (notice_id, store_id, read_at) VALUES (?,?,?)',
    [req.params.id, req.session.user.id, data.kstNow()]);
  res.json({ ok: true });
}));

// ---------- 본사(HQ) ----------
app.get('/api/hq/overview', requireHq, wrap(async (req, res) => {
  const stores = await data.query(
    `SELECT u.id, u.store_name, u.plan,
      (SELECT COALESCE(SUM(amount),0) FROM sales s WHERE s.store_id = u.id AND s.date = ?) AS yesterday,
      (SELECT COALESCE(SUM(amount),0) FROM sales s WHERE s.store_id = u.id AND s.date >= ?) AS week,
      (SELECT COUNT(*) FROM reviews r WHERE r.store_id = u.id AND r.reply IS NULL) AS pending_reviews,
      (SELECT ROUND(AVG(rating),1) FROM reviews r WHERE r.store_id = u.id) AS avg_rating
     FROM users u WHERE u.role = 'store' AND u.brand_id = ? ORDER BY u.id`,
    [data.kstDate(-1), data.kstDate(-7), req.session.user.brand_id]);
  const pending = await data.one(
    `SELECT COUNT(*) AS c FROM orders o JOIN users u ON u.id = o.store_id
     WHERE o.status = '접수' AND u.brand_id = ?`, [req.session.user.brand_id]);
  res.json({ stores, pendingOrders: pending.c });
}));

app.get('/api/hq/orders', requireHq, wrap(async (req, res) => {
  const orders = await data.query(
    `SELECT o.*, u.store_name FROM orders o JOIN users u ON u.id = o.store_id
     WHERE u.brand_id = ? ORDER BY o.created_at DESC LIMIT 50`, [req.session.user.brand_id]);
  for (const o of orders)
    o.items = await data.query('SELECT name, price, qty FROM order_items WHERE order_id = ?', [o.id]);
  res.json({ rows: orders });
}));

app.put('/api/hq/orders/:id/status', requireHq, wrap(async (req, res) => {
  const { status } = req.body || {};
  if (!['접수', '확정', '배송중', '완료', '취소'].includes(status))
    return res.status(400).json({ error: '알 수 없는 상태입니다' });
  const r = await data.run('UPDATE orders SET status = ? WHERE id = ?', [status, req.params.id]);
  if (r.changes === 0) return res.status(404).json({ error: '발주를 찾을 수 없습니다' });
  res.json({ ok: true });
}));

app.post('/api/hq/notices', requireHq, wrap(async (req, res) => {
  const { tag, title, body } = req.body || {};
  if (!title?.trim() || !body?.trim()) return res.status(400).json({ error: '제목과 내용을 입력해 주세요' });
  await data.run('INSERT INTO notices (brand_id, tag, title, body, created_at) VALUES (?,?,?,?,?)',
    [req.session.user.brand_id, (tag || '본사').trim(), title.trim(), body.trim(), data.kstNow()]);
  res.json({ ok: true });
}));

// ---------- 사장님 지원 챗봇 ----------
async function chatAnswer(message, faqs, brand) {
  const key = process.env.OPENROUTER_API_KEY;
  const guide = '죄송해요, 이 질문은 제가 정확히 답변드리기 어려워요. 본사 소식 탭을 확인하시거나 본사 담당자에게 문의해 주세요. 이 질문은 본사에 전달해 둘게요!';
  if (key && faqs.length) {
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
`너는 외식 브랜드 "${brand}" 가맹점 사장님을 돕는 운영 지원 챗봇 "한큐봇"이다.
아래 FAQ 목록에 있는 내용만 근거로 답하라. 친절한 존댓말, 2~4문장, 간결하게.

FAQ 목록:
${faqs.map((f, i) => `${i + 1}. Q: ${f.question}\n   A: ${f.answer}`).join('\n')}

규칙:
- FAQ에서 답을 찾을 수 있으면 그 내용으로 자연스럽게 답하라.
- FAQ에 없는 내용은 절대 추측하지 말고, 답변 맨 앞에 정확히 [모름] 이라고 붙인 뒤 본사 문의를 안내하라.
- 욕설·악성 문의에는 정중히 안내하고 대화를 마무리하라.

사장님 질문: ${message}`,
          }],
        }),
      });
      if (resp.ok) {
        const d = await resp.json();
        let text = d.choices?.[0]?.message?.content?.trim();
        if (text) {
          const unknown = text.startsWith('[모름]');
          if (unknown) text = text.replace(/^\[모름\]\s*/, '') || guide;
          return { answer: text, answered: unknown ? 0 : 1 };
        }
      }
    } catch (e) { console.error('[chat] 호출 실패:', e.message); }
  }
  // 대체: 키워드 매칭
  const terms = message.replace(/[?!.,]/g, ' ').split(/\s+/).filter(w => w.length >= 2);
  let best = null, bestScore = 0;
  for (const f of faqs) {
    const hay = f.question + ' ' + f.answer;
    const score = terms.filter(t => hay.includes(t)).length;
    if (score > bestScore) { best = f; bestScore = score; }
  }
  if (best && bestScore >= 1) return { answer: best.answer, answered: 1 };
  return { answer: guide, answered: 0 };
}

app.post('/api/chat', requireLogin, wrap(async (req, res) => {
  const message = (req.body?.message || '').trim().slice(0, 500);
  if (!message) return res.status(400).json({ error: '질문을 입력해 주세요' });
  const u = req.session.user;
  const faqs = await data.query(
    'SELECT question, answer FROM faqs WHERE brand_id = ? ORDER BY id', [u.brand_id]);
  const result = await chatAnswer(message, faqs, u.brand);
  await data.run(
    'INSERT INTO chat_logs (brand_id, store_id, question, answer, answered, created_at) VALUES (?,?,?,?,?,?)',
    [u.brand_id, u.id, message, result.answer, result.answered, data.kstNow()]);
  res.json(result);
}));

// ---------- 본사: FAQ 관리 · 챗봇 로그 ----------
app.get('/api/hq/faqs', requireHq, wrap(async (req, res) => {
  res.json({ rows: await data.query(
    'SELECT * FROM faqs WHERE brand_id = ? ORDER BY id', [req.session.user.brand_id]) });
}));

app.post('/api/hq/faqs', requireHq, wrap(async (req, res) => {
  const { question, answer } = req.body || {};
  if (!question?.trim() || !answer?.trim())
    return res.status(400).json({ error: '질문과 답변을 입력해 주세요' });
  await data.run('INSERT INTO faqs (brand_id, question, answer, created_at) VALUES (?,?,?,?)',
    [req.session.user.brand_id, question.trim(), answer.trim(), data.kstNow()]);
  res.json({ ok: true });
}));

app.put('/api/hq/faqs/:id', requireHq, wrap(async (req, res) => {
  const { question, answer } = req.body || {};
  if (!question?.trim() || !answer?.trim())
    return res.status(400).json({ error: '질문과 답변을 입력해 주세요' });
  const r = await data.run('UPDATE faqs SET question = ?, answer = ? WHERE id = ? AND brand_id = ?',
    [question.trim(), answer.trim(), req.params.id, req.session.user.brand_id]);
  if (r.changes === 0) return res.status(404).json({ error: 'FAQ를 찾을 수 없습니다' });
  res.json({ ok: true });
}));

app.delete('/api/hq/faqs/:id', requireHq, wrap(async (req, res) => {
  const r = await data.run('DELETE FROM faqs WHERE id = ? AND brand_id = ?',
    [req.params.id, req.session.user.brand_id]);
  if (r.changes === 0) return res.status(404).json({ error: 'FAQ를 찾을 수 없습니다' });
  res.json({ ok: true });
}));

app.get('/api/hq/chat-logs', requireHq, wrap(async (req, res) => {
  const onlyUnanswered = req.query.filter === 'unanswered' ? 'AND c.answered = 0' : '';
  res.json({ rows: await data.query(
    `SELECT c.*, u.store_name FROM chat_logs c JOIN users u ON u.id = c.store_id
     WHERE c.brand_id = ? ${onlyUnanswered} ORDER BY c.created_at DESC LIMIT 100`,
    [req.session.user.brand_id]) });
}));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[server]', err);
  res.status(500).json({ error: '서버 오류가 발생했습니다' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[한큐배달] http://localhost:${PORT} (DB: ${data.dialect})`);
    console.log(`[한큐배달] AI 답글: ${process.env.OPENROUTER_API_KEY ? `OpenRouter (${AI_MODEL})` : '규칙 기반 대체 모드'}`);
  });
}

module.exports = app;
