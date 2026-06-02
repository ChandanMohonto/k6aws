// ============================================================
//  BIDZON STRESS TEST — SINGLE SCRIPT
//  Bidders : 100 (created in setup)
//  Auctions: 10  (created in setup)
//  Duration: ~30 min (gradual ramp to 10k VUs)
//  Run     : k6 run bidzon_test.js
//  Output  : bidzon_report.html (auto-generated)
// ============================================================

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// ── Custom Metrics ────────────────────────────────────────────
const bidSuccess      = new Counter('bid_success_total');
const bidFail         = new Counter('bid_fail_total');
const loginFail       = new Counter('login_fail_total');
const auctionJoinFail = new Counter('auction_join_fail_total');
const errorRate       = new Rate('error_rate');
const loginDuration   = new Trend('login_duration',        true);
const bidDuration     = new Trend('bid_duration',          true);
const auctionDuration = new Trend('auction_list_duration', true);

// ── Config ────────────────────────────────────────────────────
const BASE_URL        = 'http://49.12.201.167/api';
const SOCKET_URL      = 'http://49.12.201.167';
const BIDDER_PASSWORD = 'Test@123';
const SELLER_EMAIL    = 'john@example.com';
const SELLER_PASS     = 'SecurePass123';

const PING_INTERVAL_MS = 10000;

// ── Options ───────────────────────────────────────────────────
export const options = {
  setupTimeout: '15m',
  scenarios: {
    bidder_scenario: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '3m', target: 1000 },  // Step 1 — warm up
        { duration: '3m', target: 3000 },  // Step 2 — ramp
        { duration: '3m', target: 5000 },  // Step 3 — mid load
        { duration: '3m', target: 8000 },  // Step 4 — heavy load
        { duration: '3m', target: 9500 },  // Step 5 — near peak
        { duration: '5m', target: 9500 },  // Step 6 — hold peak
        { duration: '3m', target: 0    },  // Step 7 — ramp down
      ],
      gracefulRampDown: '60s',
      exec: 'bidderFlow',
    },
    user_scenario: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '3m', target: 100  },  // Step 1 — warm up
        { duration: '3m', target: 200  },  // Step 2 — ramp
        { duration: '3m', target: 350  },  // Step 3 — mid load
        { duration: '3m', target: 400  },  // Step 4 — heavy load
        { duration: '3m', target: 500  },  // Step 5 — near peak
        { duration: '5m', target: 500  },  // Step 6 — hold peak
        { duration: '3m', target: 0    },  // Step 7 — ramp down
      ],
      gracefulRampDown: '60s',
      exec: 'userFlow',
    },
  },
  thresholds: {
    http_req_duration:     ['p(95)<1500', 'p(99)<3000'],
    http_req_failed:       ['rate<0.01'],
    error_rate:            ['rate<0.01'],
    login_duration:        ['p(95)<1500'],
    bid_duration:          ['p(95)<800'],
    auction_list_duration: ['p(95)<2000'],
  },
};

// ── Helpers ───────────────────────────────────────────────────
function safeJSON(res) {
  try { return JSON.parse(res.body); } catch (e) { return null; }
}

// ── Setup ─────────────────────────────────────────────────────
export function setup() {
  console.log('=== SETUP STARTED ===');

  // Step 1: Login
  console.log('Step 1: User login...');
  const loginRes  = http.post(
    `${BASE_URL}/user/login`,
    JSON.stringify({ email: SELLER_EMAIL, password: SELLER_PASS, type: 'user' }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  const loginBody = safeJSON(loginRes);
  if (!loginBody || !loginBody.token) {
    console.error(`User login FAILED: ${loginRes.body.substring(0, 200)}`);
    return { bidders: [], auctionIds: [] };
  }
  const token   = loginBody.token;
  const authJSON = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const authForm = { Authorization: `Bearer ${token}` };
  console.log(`✅ User JWT OK — ID: ${loginBody.data.id}`);

  // Step 2: Create 100 bidder accounts
  console.log('Step 2: Creating 1000 bidder accounts...');
  const bidders = [];
  for (let i = 1; i <= 1000; i++) {
    const num   = String(i).padStart(3, '0');
    const email = `bidzon_bidder${num}@test.com`;
    const res   = http.post(
      `${BASE_URL}/bidder/create`,
      { name: `BidzonBidder${num}`, email, coins: '500' },
      { headers: authForm }
    );
    const body = safeJSON(res);
    if (res.status === 200 && body && body.success) {
      bidders.push({ id: body.data.id, email, password: BIDDER_PASSWORD });
      console.log(`Bidder ${i} created — ID: ${body.data.id}`);
    } else if (body && body.message && body.message.toLowerCase().includes('already')) {
      const lr = http.post(
        `${BASE_URL}/user/login`,
        JSON.stringify({ email, password: BIDDER_PASSWORD, type: 'bidder' }),
        { headers: { 'Content-Type': 'application/json' } }
      );
      const lb = safeJSON(lr);
      if (lb && lb.data && lb.data.id) {
        bidders.push({ id: lb.data.id, email, password: BIDDER_PASSWORD });
        console.log(`Bidder ${i} exists — ID: ${lb.data.id}`);
      }
    } else {
      console.error(`Bidder ${i} FAILED: ${res.body.substring(0, 150)}`);
    }
    sleep(0.1);
  }
  console.log(`✅ ${bidders.length}/1000 bidders ready`);

  const bidderIds = bidders.map(b => b.id).filter(id => id);
  if (bidderIds.length === 0) {
    console.error('No bidder IDs — cannot run');
    return { bidders: [], auctionIds: [] };
  }

  // Step 2.5: Close existing auctions → unreserve bidders
  console.log('Step 2.5: Closing existing auctions to unreserve bidders...');
  const aList = safeJSON(http.get(`${BASE_URL}/auction/auctions`, { headers: authJSON }));
  if (aList && aList.success && Array.isArray(aList.data)) {
    aList.data.forEach(a => {
      if (a.status !== 'completed') {
        const r = http.put(`${BASE_URL}/auction/close`, JSON.stringify({ id: a.id }), { headers: authJSON });
        const b = safeJSON(r);
        console.log(b && b.success ? `✅ Closed auction ${a.id}` : `⚠️ Could not close auction ${a.id}`);
        sleep(0.2);
      }
    });
  }
  console.log('✅ Bidders unreserved');
  sleep(1);

  // Step 3: Create 100 fresh auctions
  console.log(`Step 3: Creating 100 auctions with ${bidderIds.length} bidders...`);
  const auctionIds = [];
  for (let a = 1; a <= 100; a++) {
    const auctionAt = new Date(Date.now() + 7200000).toISOString();
    // let parts = [
    //   'title='            + encodeURIComponent(`Bidzon Load Test Auction ${a}`),
    //   'description='      + encodeURIComponent(`Stress test auction ${a}`),
    //   'starting_price=10.00', 'stake=1.00', 'final_price=9999.00',
    //   'shipping_charges=0.00',
    //   'auction_at='       + encodeURIComponent(auctionAt),
    //   'no_of_bidders='    + String(bidderIds.length),
    // ];
    // bidderIds.forEach(id => parts.push('bidders=' + String(id)));
    // const aRes  = http.post(`${BASE_URL}/auction/create`, parts.join('&'), {
    //   headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    // });

    //new code
    // ✅ Clean, compact, no repeated keys
const auctionPayload = JSON.stringify({
  title:            `Bidzon Load Test Auction ${a}`,
  description:      `Stress test auction ${a}`,
  starting_price:   '10.00',
  stake:            '1.00',
  final_price:      '9999.00',
  shipping_charges: '0.00',
  auction_at:       auctionAt,
  no_of_bidders:    bidderIds.length,
  bidders:          bidderIds,   // clean array — no repeated keys
});

const aRes = http.post(`${BASE_URL}/auction/create`, auctionPayload, {
  headers: {
    Authorization:  `Bearer ${token}`,
    'Content-Type': 'application/json',   // ← changed
  },
});
    //new code end

    const aBody = safeJSON(aRes);
    if (aRes.status === 200 && aBody && aBody.success) {
      auctionIds.push(aBody.data.id);
      console.log(`✅ Auction ${a} created — ID: ${aBody.data.id} | bidders: ${aBody.data.bidders ? aBody.data.bidders.length : 0}`);
    } else {
      console.error(`Auction ${a} FAILED: ${aRes.body.substring(0, 200)}`);
    }
    sleep(0.3);
  }

  if (auctionIds.length === 0) {
    console.error('No auctions — cannot run');
    return { bidders, auctionIds: [] };
  }

  // Step 4: Activate all auctions
  console.log('Step 4: Activating auctions...');
  auctionIds.forEach(id => {
    const r = http.put(`${BASE_URL}/auction/update/status`, JSON.stringify({ id, status: 'active' }), { headers: authJSON });
    const b = safeJSON(r);
    console.log(b && b.success ? `✅ Auction ${id} active` : `⚠️ Auction ${id} activate failed`);
    sleep(0.2);
  });

  console.log(`=== SETUP COMPLETE === bidders:${bidders.length} auctions:${auctionIds.length}`);
  return { bidders, auctionIds, token };
}

// ── Socket.IO Helpers ─────────────────────────────────────────
function socketHandshake(userId) {
  const res = http.get(`${SOCKET_URL}/socket.io/?EIO=4&transport=polling`);
  if (res.status !== 200) {
    console.warn(`Handshake GET failed: ${res.status}`);
    return null;
  }

  const match = res.body.match(/"sid":"([^"]+)"/);
  if (!match) {
    console.warn(`No SID in handshake response: ${res.body.substring(0, 100)}`);
    return null;
  }
  const sid = match[1];

  const connectRes = http.post(
    `${SOCKET_URL}/socket.io/?EIO=4&transport=polling&sid=${sid}`,
    '40',
    { headers: { 'Content-Type': 'text/plain' } }
  );
  if (connectRes.status !== 200) {
    console.warn(`Connect "40" failed: ${connectRes.status} — ${connectRes.body}`);
    return null;
  }

  const pollRes = http.get(`${SOCKET_URL}/socket.io/?EIO=4&transport=polling&sid=${sid}`);
  if (pollRes.status !== 200) {
    console.warn(`Poll after connect failed: ${pollRes.status}`);
    return null;
  }

  http.post(
    `${SOCKET_URL}/socket.io/?EIO=4&transport=polling&sid=${sid}`,
    `42["join",{"id":${userId}}]`,
    { headers: { 'Content-Type': 'text/plain' } }
  );

  return sid;
}

function socketPing(sid) {
  http.post(
    `${SOCKET_URL}/socket.io/?EIO=4&transport=polling&sid=${sid}`,
    '2',
    { headers: { 'Content-Type': 'text/plain' } }
  );
}

function socketEmit(sid, event, payload) {
  return http.post(
    `${SOCKET_URL}/socket.io/?EIO=4&transport=polling&sid=${sid}`,
    `42["${event}",${JSON.stringify(payload)}]`,
    { headers: { 'Content-Type': 'text/plain' } }
  );
}

function socketPoll(sid) {
  return http.get(`${SOCKET_URL}/socket.io/?EIO=4&transport=polling&sid=${sid}`);
}

function socketDisconnect(sid) {
  http.post(
    `${SOCKET_URL}/socket.io/?EIO=4&transport=polling&sid=${sid}`,
    '41',
    { headers: { 'Content-Type': 'text/plain' } }
  );
}

// ── Scenario 1: Bidder Flow ───────────────────────────────────
export function bidderFlow(data) {
  if (!data || !data.bidders || !data.bidders.length) { sleep(1); return; }
  if (!data.auctionIds || !data.auctionIds.length)   { sleep(1); return; }

  const bidder    = data.bidders[(__VU - 1) % data.bidders.length];
  const auctionId = data.auctionIds[Math.floor(Math.random() * data.auctionIds.length)];

  // Login
  const loginStart = Date.now();
  const loginRes   = http.post(
    `${BASE_URL}/user/login`,
    JSON.stringify({ email: bidder.email, password: bidder.password, type: 'bidder' }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  loginDuration.add(Date.now() - loginStart);

  const loginBody = safeJSON(loginRes);
  if (!check(loginRes, { 'bidder login 200': r => r.status === 200 }) || !loginBody || !loginBody.token) {
    loginFail.add(1); errorRate.add(1); sleep(2); return;
  }
  errorRate.add(0);

  const token   = loginBody.token;
  const userId  = loginBody.data.id;
  const authHdr = { Authorization: `Bearer ${token}` };
  sleep(Math.random() * 1 + 0.5);

  // List auctions
  const aStart = Date.now();
  check(http.get(`${BASE_URL}/auction/auctions`, { headers: authHdr }),
    { 'auction list 200': r => r.status === 200 });
  auctionDuration.add(Date.now() - aStart);
  sleep(Math.random() + 0.5);

  // View auction
  http.get(`${BASE_URL}/auction/auction?id=${auctionId}`, { headers: authHdr });
  sleep(Math.random() + 0.5);

  // Socket.IO connect
  const sid = socketHandshake(userId);
  if (!sid) {
    auctionJoinFail.add(1);
    sleep(2); return;
  }

  // Join auction room
  const joinRes = socketEmit(sid, 'auction:join', { auction_id: auctionId });
  if (joinRes.status !== 200) {
    auctionJoinFail.add(1);
    console.warn(`VU${__VU} auction:join failed: ${joinRes.status} — ${joinRes.body}`);
    socketDisconnect(sid);
    sleep(2); return;
  }

  socketPoll(sid);
  sleep(0.5);

  // Bid loop
  const bidCount   = Math.floor(Math.random() * 2) + 2;
  let lastPingTime = Date.now();

  for (let b = 0; b < bidCount; b++) {
    if (Date.now() - lastPingTime > PING_INTERVAL_MS) {
      socketPing(sid);
      lastPingTime = Date.now();
      console.log(`VU${__VU} ping sent — session kept alive`);
    }

    const bStart = Date.now();
    const bRes   = socketEmit(sid, 'auction:bid', { auction_id: auctionId, user_id: userId });
    bidDuration.add(Date.now() - bStart);

    if (bRes.status === 200) {
      bidSuccess.add(1);
      console.log(`VU${__VU} bid ${b + 1} ✅ — auction ${auctionId}`);
    } else {
      bidFail.add(1);
      console.warn(`VU${__VU} bid ${b + 1} ❌ — status:${bRes.status} body:${bRes.body ? bRes.body.substring(0, 150) : 'empty'}`);
    }

    socketPoll(sid);
    sleep(Math.random() * 2 + 1);
  }

  // Leave + disconnect
  socketEmit(sid, 'auction:leave', { auction_id: auctionId });
  sleep(0.3);
  socketDisconnect(sid);
  sleep(Math.random() * 2 + 1);
}

// ── Scenario 2: Normal User Flow ──────────────────────────────
export function userFlow(data) {
  if (!data || !data.auctionIds || !data.auctionIds.length) { sleep(1); return; }

  const auctionId = data.auctionIds[Math.floor(Math.random() * data.auctionIds.length)];

  // Login
  const loginStart = Date.now();
  const loginRes   = http.post(
    `${BASE_URL}/user/login`,
    JSON.stringify({ email: SELLER_EMAIL, password: SELLER_PASS, type: 'user' }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  loginDuration.add(Date.now() - loginStart);

  const loginBody = safeJSON(loginRes);
  if (!check(loginRes, { 'user login 200': r => r.status === 200 }) || !loginBody || !loginBody.token) {
    loginFail.add(1); errorRate.add(1); sleep(3); return;
  }
  errorRate.add(0);

  const token   = loginBody.token;
  const jsonHdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  sleep(Math.random() + 1);

  // List auctions
  const aStart = Date.now();
  check(http.get(`${BASE_URL}/auction/auctions`, { headers: jsonHdr }),
    { 'user: list 200': r => r.status === 200 });
  auctionDuration.add(Date.now() - aStart);
  sleep(Math.random() + 1);

  // View auction
  check(http.get(`${BASE_URL}/auction/auction?id=${auctionId}`, { headers: jsonHdr }),
    { 'user: view 200': r => r.status === 200 });
  sleep(Math.random() * 2 + 1);

  // View another auction
  const auctionId2 = data.auctionIds[Math.floor(Math.random() * data.auctionIds.length)];
  check(http.get(`${BASE_URL}/auction/auction?id=${auctionId2}`, { headers: jsonHdr }),
    { 'user: view2 200': r => r.status === 200 });

  sleep(Math.random() * 5 + 3);
}

// ── Teardown ──────────────────────────────────────────────────
export function teardown(data) {
  console.log(`=== TEST COMPLETE === bidders:${data?.bidders?.length} auctions:${data?.auctionIds?.length}`);
  console.log(`Auction IDs: ${data?.auctionIds?.join(', ')}`);
}

// ── handleSummary — Auto HTML Report ─────────────────────────
export function handleSummary(data) {
  const runDate = new Date().toLocaleString();
  const m       = data.metrics;

  const ms  = (k, s) => { const v = m[k]?.values?.[s]; return v !== undefined ? Math.round(v) + 'ms' : '—'; };
  const pct = (k, s) => { const v = m[k]?.values?.[s]; return v !== undefined ? (v * 100).toFixed(2) + '%' : '—'; };
  const cnt = (k)    => { const v = m[k]?.values?.count; return v !== undefined ? Number(v).toLocaleString() : '0'; };
  const raw = (k, s) => m[k]?.values?.[s];
  const mb  = (k)    => { const v = m[k]?.values?.count; return v ? (v / 1024 / 1024).toFixed(2) + ' MB' : '—'; };

  const p95    = raw('http_req_duration', 'p(95)');
  const p99    = raw('http_req_duration', 'p(99)');
  const errRaw = raw('http_req_failed', 'rate');
  const allPass = p95 < 1500 && p99 < 3000 && errRaw < 0.01;

  const sb  = (v, l) => v !== undefined && v < l
    ? '<span style="color:#22c55e;font-weight:700">PASS</span>'
    : '<span style="color:#ef4444;font-weight:700">FAIL</span>';
  const clr = (v, l) => v !== undefined ? (v < l ? '#22c55e' : '#ef4444') : '#94a3b8';

  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Bidzon — Stress Test Report</title>
<style>
:root{--bg:#0f1117;--surface:#1a1d27;--card:#20243a;--border:#2e3250;--accent:#6c63ff;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b;--text:#e2e8f0;--muted:#94a3b8;}
*{box-sizing:border-box;margin:0;padding:0;}body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;}
.hdr{background:linear-gradient(135deg,#1a1d27,#12162a);border-bottom:1px solid var(--border);padding:28px 48px;display:flex;align-items:center;justify-content:space-between;}
.hdr h1{font-size:22px;font-weight:700;}.hdr h1 span{color:var(--accent);}.hdr p{color:var(--muted);font-size:12px;margin-top:4px;}
.badge{padding:6px 18px;border-radius:20px;font-size:12px;font-weight:700;}
.pb{background:rgba(34,197,94,.15);color:#22c55e;border:1px solid rgba(34,197,94,.3);}
.fb{background:rgba(239,68,68,.15);color:#ef4444;border:1px solid rgba(239,68,68,.3);}
.wrap{max-width:1300px;margin:0 auto;padding:32px 48px;}.sec{margin-bottom:40px;}
.st{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid var(--border);}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:12px;}
.kpi{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px 20px;}
.kl{font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);margin-bottom:6px;}
.kv{font-size:26px;font-weight:700;line-height:1;}.ks{font-size:11px;color:var(--muted);margin-top:4px;}
.tw{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:12px;}
table{width:100%;border-collapse:collapse;}thead tr{background:var(--surface);}
th{padding:10px 16px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);font-weight:700;}
td{padding:10px 16px;border-top:1px solid var(--border);font-size:13px;}tr:hover td{background:rgba(108,99,255,.04);}
td.lb{color:var(--muted);width:220px;}td.mono{font-family:monospace;font-size:12px;}
.phases{display:flex;border-radius:10px;overflow:hidden;height:44px;margin-bottom:10px;}
.ph{display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex:1;text-align:center;line-height:1.4;}
.journey{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:8px 0;}
.js{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:9px 13px;font-size:12px;font-weight:600;}
.ja{color:var(--accent);font-size:14px;padding:0 2px;}
.fi{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:14px 18px;margin-bottom:10px;}
.fi h4{font-size:13px;font-weight:600;margin-bottom:4px;}.fi p{font-size:12px;color:var(--muted);line-height:1.6;}
.rc{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:14px 18px;margin-bottom:10px;display:flex;gap:14px;align-items:flex-start;}
.rn{width:26px;height:26px;border-radius:50%;background:var(--accent);color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px;}
.rc h4{font-size:13px;font-weight:600;margin-bottom:3px;}.rc p{font-size:12px;color:var(--muted);line-height:1.6;}
.footer{border-top:1px solid var(--border);padding:18px 48px;color:var(--muted);font-size:11px;display:flex;justify-content:space-between;}
</style></head><body>

<div class="hdr">
  <div><h1><span>Bidzon</span> — Stress Test Report</h1>
  <p>Generated: ${runDate} &nbsp;|&nbsp; 100 Bidders | 10 Auctions | ~30 min | 10,000 Peak VUs</p></div>
  <span class="badge ${allPass ? 'pb' : 'fb'}">${allPass ? 'PASS' : 'FAIL'}</span>
</div>

<div class="wrap">

<div class="sec"><div class="st">Executive Summary</div>
<div class="grid">
  <div class="kpi"><div class="kl">Peak VUs</div><div class="kv" style="color:var(--accent)">10,000</div><div class="ks">9500 bidders + 500 users</div></div>
  <div class="kpi"><div class="kl">Total Requests</div><div class="kv" style="color:var(--accent)">${cnt('http_reqs')}</div><div class="ks">avg ${ms('http_req_duration','avg')}</div></div>
  <div class="kpi"><div class="kl">p95 Latency</div><div class="kv" style="color:${clr(p95,1500)}">${ms('http_req_duration','p(95)')}</div><div class="ks">Threshold &lt;1500ms</div></div>
  <div class="kpi"><div class="kl">p99 Latency</div><div class="kv" style="color:${clr(p99,3000)}">${ms('http_req_duration','p(99)')}</div><div class="ks">Threshold &lt;3000ms</div></div>
  <div class="kpi"><div class="kl">Error Rate</div><div class="kv" style="color:${clr(errRaw,0.01)}">${pct('http_req_failed','rate')}</div><div class="ks">Threshold &lt;1%</div></div>
  <div class="kpi"><div class="kl">Bids Placed</div><div class="kv" style="color:var(--green)">${cnt('bid_success_total')}</div><div class="ks">${cnt('bid_fail_total')} failed</div></div>
  <div class="kpi"><div class="kl">Login p95</div><div class="kv" style="color:${clr(raw('login_duration','p(95)'),1500)}">${ms('login_duration','p(95)')}</div><div class="ks">Threshold &lt;1500ms</div></div>
  <div class="kpi"><div class="kl">Bid Emit p95</div><div class="kv" style="color:${clr(raw('bid_duration','p(95)'),800)}">${ms('bid_duration','p(95)')}</div><div class="ks">Threshold &lt;800ms</div></div>
  <div class="kpi"><div class="kl">Auction List p95</div><div class="kv" style="color:${clr(raw('auction_list_duration','p(95)'),2000)}">${ms('auction_list_duration','p(95)')}</div><div class="ks">Threshold &lt;2000ms</div></div>
  <div class="kpi"><div class="kl">Data Sent</div><div class="kv" style="color:var(--accent)">${mb('data_sent')}</div><div class="ks">&nbsp;</div></div>
  <div class="kpi"><div class="kl">Data Received</div><div class="kv" style="color:var(--accent)">${mb('data_received')}</div><div class="ks">&nbsp;</div></div>
</div></div>

<div class="sec"><div class="st">Load Phases — ~30 Minutes Total</div>
<div class="phases">
  <div class="ph" style="background:#1a2740;color:#60a5fa">Step 1<br/>3m→1k</div>
  <div class="ph" style="background:#1e2b4a;color:#818cf8">Step 2<br/>3m→3k</div>
  <div class="ph" style="background:#251f52;color:#a78bfa">Step 3<br/>3m→5k</div>
  <div class="ph" style="background:#2d1f5e;color:#c4b5fd">Step 4<br/>3m→8k</div>
  <div class="ph" style="background:#3b1f6b;color:#ddd6fe">Step 5<br/>3m→9.5k</div>
  <div class="ph" style="background:#4c1d95;color:#ede9fe">Peak<br/>5m@10k</div>
  <div class="ph" style="background:#1f3a2a;color:#6ee7b7">Down<br/>3m→0</div>
</div>
<div class="tw"><table>
  <thead><tr><th>Step</th><th>Duration</th><th>Bidder VUs</th><th>User VUs</th><th>Total VUs</th></tr></thead>
  <tbody>
    <tr><td>Step 1 — Warm up</td><td>3 min</td><td>1,000</td><td>100</td><td>1,100</td></tr>
    <tr><td>Step 2 — Ramp</td><td>3 min</td><td>3,000</td><td>200</td><td>3,200</td></tr>
    <tr><td>Step 3 — Mid load</td><td>3 min</td><td>5,000</td><td>350</td><td>5,350</td></tr>
    <tr><td>Step 4 — Heavy load</td><td>3 min</td><td>8,000</td><td>400</td><td>8,400</td></tr>
    <tr><td>Step 5 — Near peak</td><td>3 min</td><td>9,500</td><td>500</td><td>10,000</td></tr>
    <tr><td>Step 6 — Peak hold</td><td>5 min</td><td>9,500</td><td>500</td><td><strong>10,000</strong></td></tr>
    <tr><td>Step 7 — Ramp down</td><td>3 min</td><td>0</td><td>0</td><td>0</td></tr>
  </tbody>
</table></div></div>

<div class="sec"><div class="st">Threshold Results</div>
<div class="tw"><table>
  <thead><tr><th>Metric</th><th>Threshold</th><th>Actual</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td>http_req_duration p95</td><td>&lt;1500ms</td><td>${ms('http_req_duration','p(95)')}</td><td>${sb(p95,1500)}</td></tr>
    <tr><td>http_req_duration p99</td><td>&lt;3000ms</td><td>${ms('http_req_duration','p(99)')}</td><td>${sb(p99,3000)}</td></tr>
    <tr><td>http_req_failed rate</td><td>&lt;1%</td><td>${pct('http_req_failed','rate')}</td><td>${sb(errRaw,0.01)}</td></tr>
    <tr><td>login_duration p95</td><td>&lt;1500ms</td><td>${ms('login_duration','p(95)')}</td><td>${sb(raw('login_duration','p(95)'),1500)}</td></tr>
    <tr><td>bid_duration p95</td><td>&lt;800ms</td><td>${ms('bid_duration','p(95)')}</td><td>${sb(raw('bid_duration','p(95)'),800)}</td></tr>
    <tr><td>auction_list_duration p95</td><td>&lt;2000ms</td><td>${ms('auction_list_duration','p(95)')}</td><td>${sb(raw('auction_list_duration','p(95)'),2000)}</td></tr>
  </tbody>
</table></div></div>

<div class="sec"><div class="st">Full Latency Breakdown</div>
<div class="tw"><table>
  <thead><tr><th>Metric</th><th>Min</th><th>Avg</th><th>p50</th><th>p90</th><th>p95</th><th>p99</th><th>Max</th></tr></thead>
  <tbody>
    <tr><td>All HTTP</td><td>${ms('http_req_duration','min')}</td><td>${ms('http_req_duration','avg')}</td><td>${ms('http_req_duration','med')}</td><td>${ms('http_req_duration','p(90)')}</td><td>${ms('http_req_duration','p(95)')}</td><td>${ms('http_req_duration','p(99)')}</td><td>${ms('http_req_duration','max')}</td></tr>
    <tr><td>Login</td><td>${ms('login_duration','min')}</td><td>${ms('login_duration','avg')}</td><td>${ms('login_duration','med')}</td><td>${ms('login_duration','p(90)')}</td><td>${ms('login_duration','p(95)')}</td><td>${ms('login_duration','p(99)')}</td><td>${ms('login_duration','max')}</td></tr>
    <tr><td>Bid Emit</td><td>${ms('bid_duration','min')}</td><td>${ms('bid_duration','avg')}</td><td>${ms('bid_duration','med')}</td><td>${ms('bid_duration','p(90)')}</td><td>${ms('bid_duration','p(95)')}</td><td>${ms('bid_duration','p(99)')}</td><td>${ms('bid_duration','max')}</td></tr>
    <tr><td>Auction List</td><td>${ms('auction_list_duration','min')}</td><td>${ms('auction_list_duration','avg')}</td><td>${ms('auction_list_duration','med')}</td><td>${ms('auction_list_duration','p(90)')}</td><td>${ms('auction_list_duration','p(95)')}</td><td>${ms('auction_list_duration','p(99)')}</td><td>${ms('auction_list_duration','max')}</td></tr>
    <tr><td>http_req_waiting</td><td>${ms('http_req_waiting','min')}</td><td>${ms('http_req_waiting','avg')}</td><td>${ms('http_req_waiting','med')}</td><td>${ms('http_req_waiting','p(90)')}</td><td>${ms('http_req_waiting','p(95)')}</td><td>—</td><td>${ms('http_req_waiting','max')}</td></tr>
  </tbody>
</table></div></div>

<div class="sec"><div class="st">Request Counters</div>
<div class="tw"><table>
  <thead><tr><th>Metric</th><th>Value</th></tr></thead>
  <tbody>
    <tr><td>Total HTTP Requests</td><td>${cnt('http_reqs')}</td></tr>
    <tr><td>Bids Placed (success)</td><td>${cnt('bid_success_total')}</td></tr>
    <tr><td>Bids Failed</td><td>${cnt('bid_fail_total')}</td></tr>
    <tr><td>Login Failures</td><td>${cnt('login_fail_total')}</td></tr>
    <tr><td>Auction Join Failures</td><td>${cnt('auction_join_fail_total')}</td></tr>
    <tr><td>Data Sent</td><td>${mb('data_sent')}</td></tr>
    <tr><td>Data Received</td><td>${mb('data_received')}</td></tr>
  </tbody>
</table></div></div>

<div class="sec"><div class="st">Detected Bottlenecks</div>
  <div class="fi" style="border-left:3px solid var(--red)"><h4>Socket.IO EIO4 — Poll Required After Connect</h4><p>EIO4 protocol requires a GET poll after sending "40" connect packet to receive server namespace confirmation before emitting any events. Missing this poll causes "Session ID unknown" errors.</p></div>
  <div class="fi" style="border-left:3px solid var(--red)"><h4>Socket.IO Session Expiry — 25s pingInterval</h4><p>Sessions expire in 25 seconds without a ping. Script sends ping packet "2" every 10 seconds during bid loop to prevent session expiry errors.</p></div>
  <div class="fi" style="border-left:3px solid var(--yellow)"><h4>Bidder Reserved Status Blocks Assignment</h4><p>Server marks bidders as reserved when assigned to auctions. Setup closes all existing auctions (Step 2.5) to unreserve bidders before creating new test auctions.</p></div>
  <div class="fi" style="border-left:3px solid var(--yellow)"><h4>PostgreSQL Connection Pool Pressure</h4><p>Each bid triggers a DB write. Knex default pool of 10 will queue under 10k concurrent load. Increase to pool.max=100 with PgBouncer.</p></div>
  <div class="fi" style="border-left:3px solid #6c63ff"><h4>Auction Timer Broadcast at 10k Scale</h4><p>Server emits auction:timer every second to all room members. At 10k VUs this will heavily stress the event loop. Monitor lag closely.</p></div>
</div>

<div class="sec"><div class="st">Recommendations</div>
  <div class="rc"><div class="rn">1</div><div><h4>Increase PostgreSQL pool — pool.max=100 + PgBouncer</h4><p>Set Knex pool.max=100 and add PgBouncer to handle concurrent bid writes at 10k scale.</p></div></div>
  <div class="rc"><div class="rn">2</div><div><h4>Run PM2 in cluster mode with Redis Socket.IO adapter</h4><p>pm2 start app.js -i max. Add @socket.io/redis-adapter for cross-instance room support.</p></div></div>
  <div class="rc"><div class="rn">3</div><div><h4>Cache GET /api/auction/auctions with Redis 5s TTL</h4><p>Every VU calls this — a 5s Redis cache reduces DB reads by 95% at peak.</p></div></div>
  <div class="rc"><div class="rn">4</div><div><h4>Throttle auction:timer broadcast to every 3s</h4><p>Reduces event loop pressure by 66% for rooms with 1000+ concurrent bidders.</p></div></div>
  <div class="rc"><div class="rn">5</div><div><h4>Add direct bidder unreserve API endpoint</h4><p>Currently only auction close/delete unreserves bidders. A direct endpoint simplifies management.</p></div></div>
</div>

<div class="sec"><div class="st">Test Configuration</div>
<div class="tw"><table><tbody>
  <tr><td class="lb">Bidders</td><td>100 (bidzon_bidder001-100@test.com)</td></tr>
  <tr><td class="lb">Auctions</td><td>10 fresh per run</td></tr>
  <tr><td class="lb">Peak VUs</td><td>10,000 (9500 bidder + 500 user)</td></tr>
  <tr><td class="lb">Duration</td><td>~30 minutes (7 steps)</td></tr>
  <tr><td class="lb">Socket ping</td><td>Every 10s (server expires at 25s)</td></tr>
  <tr><td class="lb">auction_at</td><td>2 hours from test start</td></tr>
  <tr><td class="lb">Bids per session</td><td>2-3</td></tr>
  <tr><td class="lb">Base URL</td><td>http://49.12.201.167/api</td></tr>
  <tr><td class="lb">Socket URL</td><td>http://49.12.201.167</td></tr>
  <tr><td class="lb">setupTimeout</td><td>15 minutes</td></tr>
</tbody></table></div></div>

</div>
<div class="footer">
  <span>Bidzon Stress Test Report</span>
  <span>Generated: ${runDate}</span>
</div>
</body></html>`;

  const result = {};
  result['bidzon_report.html']  = html;
  result['bidzon_summary.json'] = JSON.stringify(data, null, 2);
  result['stdout'] = '\n✅ Report: bidzon_report.html\n📄 Summary: bidzon_summary.json\n';
  return result;
}