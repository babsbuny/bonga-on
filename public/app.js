// 본가ON 가맹점 앱
let me = null;
const $ = (s) => document.querySelector(s);
const won = (n) => (n ?? 0).toLocaleString('ko-KR') + '원';
const CH_NAMES = { baemin:'배달의민족', coupang:'쿠팡이츠', yogiyo:'요기요', hall:'홀', takeout:'포장' };

let toastTimer;
function toast(msg){
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

async function api(url, opts = {}){
  const res = await fetch(url, { headers: {'Content-Type':'application/json'}, ...opts });
  if (res.status === 401) { location.href = '/login.html'; throw new Error('unauthenticated'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { toast(data.error || '요청에 실패했습니다'); throw new Error(data.error || res.status); }
  return data;
}

async function logout(){ await fetch('/api/logout', {method:'POST'}); location.href = '/login.html'; }

// ---------- 탭 ----------
const loaded = {};
document.querySelectorAll('.side button[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});
function showTab(tab){
  document.querySelectorAll('.side button[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('[data-panel]').forEach(p => p.hidden = p.dataset.panel !== tab);
  const loader = { dash: loadDash, sales: loadSales, reviews: () => loadReviews('pending'),
                   orders: loadOrdersTab, notices: loadNotices, plan: loadPlan }[tab];
  if (loader && !loaded[tab]) { loaded[tab] = true; loader(); }
}

// ---------- 대시보드 ----------
async function loadDash(){
  const d = await api('/api/dashboard');
  const hour = new Date().getHours();
  $('#greeting').textContent =
    (hour < 11 ? '좋은 아침입니다' : hour < 18 ? '좋은 오후입니다' : '수고 많으셨습니다') + ', 사장님';
  const pct = d.yesterday.diffPct;
  $('#greetSub').textContent = pct == null ? '어제 매출 데이터가 준비되었습니다.'
    : `어제 매출이 지난주 같은 요일보다 ${Math.abs(pct)}% ${pct >= 0 ? '올랐어요' : '내렸어요'}.`;

  const rv = d.reviews;
  $('#kpis').innerHTML = `
    <div class="kpi"><div class="k">어제 매출 ${pct != null ? `<span class="pill ${pct>=0?'good':'bad'}">${pct>=0?'▲':'▼'} ${Math.abs(pct)}%</span>`:''}</div>
      <div class="v num">${won(d.yesterday.amount)}</div>
      <div class="d ${d.yesterday.diff>=0?'up':'down'}">전주 대비 ${d.yesterday.diff>=0?'+':''}${won(d.yesterday.diff)}</div></div>
    <div class="kpi"><div class="k">어제 주문</div><div class="v num">${d.yesterday.orders}건</div>
      <div class="d">채널 ${d.channelsYesterday.length}개 합산</div></div>
    <div class="kpi"><div class="k">평균 평점 ${rv.pending ? `<span class="pill warn">답글 ${rv.pending}건 대기</span>` : `<span class="pill good">답글 완료</span>`}</div>
      <div class="v num">${rv.avg_rating ?? '-'}</div><div class="d">누적 리뷰 ${rv.total}건</div></div>
    <div class="kpi"><div class="k">본사 소식 ${d.unreadNotices ? `<span class="pill acc">새 공지 ${d.unreadNotices}건</span>`:''}</div>
      <div class="v num">${d.pendingOrders}건</div><div class="d">진행 중 발주</div></div>`;

  drawWeekChart(d.week);
  $('#channelRows').innerHTML = d.channelsYesterday.length
    ? d.channelsYesterday.sort((a,b) => b.amount - a.amount).map(c =>
      `<tr><td>${CH_NAMES[c.channel] || c.channel}</td><td class="r num">${won(c.amount)}</td><td class="r num">${c.orders}건</td></tr>`).join('')
    : '<tr><td colspan="3" class="empty">어제 매출 기록이 없습니다</td></tr>';
}

function drawWeekChart(week){
  const svg = $('#weekChart');
  if (!week.length) { svg.outerHTML = '<p class="empty">매출 데이터가 없습니다</p>'; return; }
  const W = 560, H = 200, pad = 24;
  const max = Math.max(...week.map(w => w.amount)) * 1.15;
  const x = (i) => pad + i * (W - pad * 2) / Math.max(1, week.length - 1);
  const y = (v) => H - 26 - (v / max) * (H - 60);
  const pts = week.map((w, i) => `${x(i)},${y(w.amount)}`);
  const days = ['일','월','화','수','목','금','토'];
  svg.innerHTML = `
    ${[0.25,0.5,0.75,1].map(f => `<line x1="0" y1="${y(max*f)}" x2="${W}" y2="${y(max*f)}" stroke="var(--line)" stroke-width="1"/>`).join('')}
    <path d="M${pts.join(' L')} L${x(week.length-1)},${H-26} L${x(0)},${H-26} Z" fill="var(--tint)"/>
    <path d="M${pts.join(' L')}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>
    <circle cx="${x(week.length-1)}" cy="${y(week.at(-1).amount)}" r="5" fill="var(--accent)"/>
    ${week.map((w, i) => `<text x="${x(i)}" y="${H-8}" text-anchor="middle" font-size="11" fill="var(--ink3)">${days[new Date(w.date+'T00:00').getDay()]}</text>`).join('')}`;
  $('#weekLegend').innerHTML =
    `<span><i style="background:var(--accent)"></i>일 매출</span>
     <span>7일 합계 <b class="num">${won(week.reduce((s,w) => s + w.amount, 0))}</b></span>`;
}

// ---------- 매출 ----------
async function loadSales(){
  $('#sDate').value = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const { rows } = await api('/api/sales?days=30');
  const byDate = {};
  for (const r of rows) { (byDate[r.date] ??= {}); byDate[r.date][r.channel] = r.amount; }
  const dates = Object.keys(byDate).sort().reverse();
  $('#salesRows').innerHTML = dates.length ? dates.map(d => {
    const c = byDate[d];
    const total = Object.values(c).reduce((s, v) => s + v, 0);
    const cell = (ch) => `<td class="r num">${c[ch] ? won(c[ch]) : '<span style="color:var(--ink3)">—</span>'}</td>`;
    return `<tr><td class="num">${d.slice(5).replace('-','/')}</td>${cell('baemin')}${cell('coupang')}${cell('yogiyo')}${cell('hall')}${cell('takeout')}<td class="r num"><b>${won(total)}</b></td></tr>`;
  }).join('') : '<tr><td colspan="7" class="empty">기록이 없습니다</td></tr>';
}
$('#saleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/sales', { method:'POST', body: JSON.stringify({
    date: $('#sDate').value, channel: $('#sChannel').value,
    amount: +$('#sAmount').value, orders_count: +$('#sOrders').value }) });
  toast('매출이 기록되었습니다');
  $('#sAmount').value = ''; $('#sOrders').value = 0;
  loadSales(); loaded.dash = false;
});

// ---------- 리뷰 ----------
$('#fltPending').addEventListener('click', () => loadReviews('pending'));
$('#fltAll').addEventListener('click', () => loadReviews('all'));
async function loadReviews(filter){
  $('#fltPending').classList.toggle('btn-primary', filter === 'pending');
  $('#fltAll').classList.toggle('btn-primary', filter === 'all');
  const { rows } = await api('/api/reviews?filter=' + filter);
  const list = $('#reviewList');
  if (!rows.length) { list.innerHTML = '<p class="empty">표시할 리뷰가 없습니다 🎉</p>'; return; }
  list.innerHTML = rows.map(r => `
    <div class="rev" id="rev${r.id}">
      <div class="rh"><span>${r.platform} · ${r.author} · ${r.created_at.slice(5,16)}</span>
        <span class="stars">${'★'.repeat(r.rating)}${'☆'.repeat(5-r.rating)}</span></div>
      <div class="rt">“${r.body}”</div>
      ${r.reply
        ? `<div class="done"><span class="lbl">등록된 답글</span>${r.reply}</div>`
        : `<textarea id="ta${r.id}" placeholder="답글을 직접 쓰거나, AI 초안 버튼을 눌러보세요"></textarea>
           <div class="actions">
             <button class="btn btn-ghost btn-sm" onclick="draft(${r.id})">✨ AI 답글 초안</button>
             <button class="btn btn-primary btn-sm" onclick="saveReply(${r.id})">답글 등록</button>
           </div>`}
    </div>`).join('');
  list.dataset.filter = filter;
}
async function draft(id){
  const btn = document.querySelector(`#rev${id} .btn-ghost`);
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'AI 작성 중…';
  try {
    const { draft, source } = await api(`/api/reviews/${id}/draft`, { method:'POST' });
    $(`#ta${id}`).value = draft;
    toast(source === 'ai' ? 'AI가 답글 초안을 작성했어요 — 확인 후 등록하세요' : '기본 답글을 불러왔어요 (AI 키 미설정)');
  } finally { btn.disabled = false; btn.textContent = orig; }
}
async function saveReply(id){
  const text = $(`#ta${id}`).value.trim();
  if (!text) { toast('답글 내용을 입력해 주세요'); return; }
  await api(`/api/reviews/${id}/reply`, { method:'PUT', body: JSON.stringify({ reply: text }) });
  toast('답글이 등록되었습니다');
  loadReviews($('#reviewList').dataset.filter || 'pending');
  loaded.dash = false;
}

// ---------- 발주 ----------
let cart = {};       // product_id -> qty
let productsCache = [];
async function loadOrdersTab(){
  const { rows } = await api('/api/products');
  productsCache = rows; cart = {};
  renderCart(); renderOrderHistory();
}
function renderCart(){
  $('#productRows').innerHTML = productsCache.map(p => {
    const qty = cart[p.id] || 0;
    return `<tr>
      <td>${p.name} <span style="color:var(--ink3);font-size:12px">${p.unit}</span></td>
      <td class="r num">${won(p.price)}</td>
      <td class="r"><span class="stepper">
        <button aria-label="빼기" onclick="chg(${p.id},-1)">−</button>
        <span class="num">${qty}</span>
        <button aria-label="더하기" onclick="chg(${p.id},1)">+</button></span></td>
      <td class="r num">${qty ? won(p.price * qty) : '—'}</td></tr>`;
  }).join('');
  const total = productsCache.reduce((s, p) => s + p.price * (cart[p.id] || 0), 0);
  $('#cartTotal').textContent = won(total);
}
function chg(id, d){ cart[id] = Math.max(0, (cart[id] || 0) + d); renderCart(); }
$('#submitOrder').addEventListener('click', async () => {
  const items = Object.entries(cart).filter(([,q]) => q > 0)
    .map(([product_id, qty]) => ({ product_id: +product_id, qty }));
  if (!items.length) { toast('발주 품목을 담아 주세요'); return; }
  const { orderId, total } = await api('/api/orders', { method:'POST', body: JSON.stringify({ items }) });
  toast(`발주 #${orderId} 접수 완료 (${won(total)}) — 내일 도착 예정`);
  cart = {}; renderCart(); renderOrderHistory();
});
async function renderOrderHistory(){
  const { rows } = await api('/api/orders');
  const badge = { '접수':'warn', '확정':'acc', '배송중':'acc', '완료':'good', '취소':'bad' };
  $('#orderHistory').innerHTML = rows.length ? rows.map(o => `
    <div style="border:1px solid var(--line);border-radius:10px;padding:11px 13px;margin-bottom:9px">
      <div style="display:flex;justify-content:space-between;gap:8px;font-size:13px;flex-wrap:wrap">
        <b>#${o.id} · ${o.created_at.slice(5,16)}</b>
        <span class="pill ${badge[o.status] || 'neutral'}">${o.status}</span></div>
      <div style="font-size:12.5px;color:var(--ink3);margin-top:4px">
        ${o.items.map(i => `${i.name}×${i.qty}`).join(', ')}</div>
      <div class="num" style="font-size:13.5px;font-weight:600;margin-top:3px">${won(o.total)}</div>
    </div>`).join('') : '<p class="empty">발주 내역이 없습니다</p>';
}

// ---------- 공지 ----------
async function loadNotices(){
  const { rows } = await api('/api/notices');
  $('#noticeList').innerHTML = rows.length ? rows.map(n => `
    <div class="notice ${n.is_read ? '' : 'unread'}" id="nt${n.id}" onclick="openNotice(${n.id}, ${n.is_read ? 'true' : 'false'})">
      <div class="nh"><span class="pill ${n.tag === '본사' ? 'acc' : n.tag === '신메뉴' ? 'good' : 'neutral'}">${n.tag}</span>
        <b>${n.title}</b><time>${n.created_at.slice(5,16)}</time></div>
      <div class="nb">${n.body}</div>
    </div>`).join('') : '<p class="empty">공지가 없습니다</p>';
}
async function openNotice(id, wasRead){
  const el = document.getElementById('nt' + id);
  el.classList.toggle('open');
  if (!wasRead && el.classList.contains('open')) {
    await api(`/api/notices/${id}/read`, { method:'POST' });
    el.classList.remove('unread');
    el.setAttribute('onclick', `openNotice(${id}, true)`);
    loaded.dash = false;
  }
}

// ---------- 요금제 ----------
function loadPlan(){
  const pro = me.plan === 'pro';
  $('#planCard').innerHTML = `
    <h3>현재 플랜: ${pro ? '프로' : '베이직'} ${pro ? '<span class="pill good">이용 중</span>' : '<span class="pill neutral">무료</span>'}</h3>
    <div class="ch">${pro ? '월 29,000원 · 다음 결제일 9월 15일' : '무료 플랜'}</div>
    <ul style="list-style:none;padding:0;display:grid;gap:8px;font-size:14px;color:var(--ink2)">
      <li>✓ 통합 매출 대시보드</li>
      <li>✓ 스마트 발주 · 본사 공지</li>
      <li>${pro ? '✓' : '✗'} AI 리뷰 답글 무제한 ${pro ? '' : '<span class="pill acc">프로 전용</span>'}</li>
      <li>${pro ? '✓' : '✗'} 부정 리뷰 실시간 알림 ${pro ? '' : '<span class="pill acc">프로 전용</span>'}</li>
    </ul>
    ${pro ? '' : '<button class="btn btn-primary btn-sm" style="margin-top:14px" onclick="toast(\'데모 버전에서는 결제 없이 체험만 가능합니다\')">프로로 업그레이드 (월 29,000원)</button>'}`;
}

// ---------- 시작 ----------
(async () => {
  try {
    me = (await api('/api/me')).user;
    if (me.role === 'hq') { location.href = '/admin.html'; return; }
    $('#whoami').textContent = me.store_name;
    $('#storeName').textContent = me.store_name;
    $('#planLabel').textContent = `${me.username} · ${me.plan === 'pro' ? '프로' : '베이직'} 플랜`;
    $('#planSmall').innerHTML = me.plan === 'pro'
      ? '<b>프로 플랜</b> 이용 중<br>다음 결제일 9월 15일'
      : '<b>베이직(무료)</b> 이용 중<br>AI 답글은 프로 전용';
    showTab('dash');
  } catch {}
})();
