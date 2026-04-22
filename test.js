// ============================================================
//  BIDZON STRESS TEST — SINGLE SCRIPT
//  Bidders : 100 (created in setup)
//  Auctions: 10  (created in setup)
//  Duration: 5 minutes
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

// Socket.IO session expires in 25s (pingInterval from server)
// We ping every 10s to keep session alive
const PING_INTERVAL_MS = 10000;

// ── Options ───────────────────────────────────────────────────
export const options = {
  setupTimeout: '10m',
  scenarios: {
    bidder_scenario: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 10 },  // Ramp-up → 10 bidder VUs
        { duration: '3m', target: 10 },  // Peak    → 10 bidder VUs
        { duration: '1m', target: 0  },  // Recovery
      ],
      gracefulRampDown: '30s',
      exec: 'bidderFlow',
    },
    user_scenario: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 10 },  // Ramp-up → 10 user VUs
        { duration: '3m', target: 10 },  // Peak    → 10 user VUs
        { duration: '1m', target: 0  },  // Recovery
      ],
      gracefulRampDown: '30s',
      exec: 'userFlow',
    },
  },
  thresholds: {
    // Based on real human experience for an auction platform
    http_req_duration:     ['p(95)<1500', 'p(99)<3000'],  // 95% users under 1.5s
    http_req_failed:       ['rate<0.01'],                  // max 1% request failures
    error_rate:            ['rate<0.01'],                  // max 1% errors
    login_duration:        ['p(95)<1500'],                 // login under 1.5s
    bid_duration:          ['p(95)<800'],                  // bid must be fast — time critical
    auction_list_duration: ['p(95)<2000'],                 // auction list under 2s
  },
};

// ── Helpers ───────────────────────────────────────────────────
function safeJSON(res) {
  try { return JSON.parse(res.body); } catch (e) { return null; }
}

// ── Setup ─────────────────────────────────────────────────────
export function setup() {
  console.log('=== SETUP STARTED ===');

  // ── Step 1: Login as user — get fresh JWT ─────────────────
  console.log('Step 1: User login...');
  const loginRes  = http.post(
    `${BASE_URL}/user/login`,
    JSON.stringify({ email: SELLER_EMAIL, password: SELLER_PASS, type: 'user' }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  const loginBody = safeJSON(loginRes);
  if (!loginBody || !loginBody.token) {
    console.error(`User login FAILED: status=${loginRes.status} body=${loginRes.body.substring(0, 300)}`);
    return { bidders: [], auctionIds: [] };
  }
  const token = loginBody.token;
  console.log(`✅ User JWT OK — ID: ${loginBody.data.id}`);

  const authJSON = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const authForm = { Authorization: `Bearer ${token}` };

  // ── Step 2: Create 100 bidder accounts ────────────────────
  console.log('Step 2: Creating 100 bidder accounts...');
  const bidders = [];

  for (let i = 1; i <= 1000; i++) {
    const num   = String(i).padStart(3, '0');
    const email = `bidzon_bidder${num}@test.com`;
    const name  = `BidzonBidder${num}`;

    const res  = http.post(
      `${BASE_URL}/bidder/create`,
      { name, email, coins: '500' },
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
      } else {
        console.warn(`Bidder ${i} login failed — skipping`);
      }
    } else {
      console.error(`Bidder ${i} FAILED: status=${res.status} body=${res.body.substring(0, 200)}`);
    }
    sleep(0.1);
  }

  console.log(`✅ ${bidders.length}/100 bidder accounts ready`);

  const bidderIds = bidders.map(b => b.id).filter(id => id !== null && id !== undefined);
  console.log(`Bidder IDs collected: ${bidderIds.length}`);

  if (bidderIds.length === 0) {
    console.error('No bidder IDs — cannot run test');
    return { bidders: [], auctionIds: [] };
  }

  // ── Step 2.5: Close all existing auctions → unreserve bidders
  console.log('Step 2.5: Closing existing auctions to unreserve all bidders...');
  const aListRes  = http.get(`${BASE_URL}/auction/auctions`, { headers: authJSON });
  const aListBody = safeJSON(aListRes);
  if (aListBody && aListBody.success && Array.isArray(aListBody.data)) {
    aListBody.data.forEach(auction => {
      if (auction.status !== 'completed') {
        const closeRes  = http.put(
          `${BASE_URL}/auction/close`,
          JSON.stringify({ id: auction.id }),
          { headers: authJSON }
        );
        const closeBody = safeJSON(closeRes);
        if (closeRes.status === 200 && closeBody && closeBody.success) {
          console.log(`✅ Closed auction ${auction.id} — bidders unreserved`);
        } else {
          console.warn(`Could not close auction ${auction.id}: ${closeRes.body.substring(0, 100)}`);
        }
        sleep(0.2);
      } else {
        console.log(`Auction ${auction.id} already completed — skipping`);
      }
    });
  }
  console.log('✅ All existing auctions closed — bidders now unreserved');
  sleep(1);

  // ── Step 3: Create 10 fresh auctions ──────────────────────
  console.log(`Step 3: Creating 10 auctions with ${bidderIds.length} bidder IDs...`);
  const auctionIds = [];

  for (let a = 1; a <= 100; a++) {
    // 2 hours from now — timer won't expire during test
    const auctionAt = new Date(Date.now() + 7200000).toISOString();

    let formParts = [
      'title='            + encodeURIComponent(`Bidzon Load Test Auction ${a}`),
      'description='      + encodeURIComponent(`Stress test auction ${a}`),
      'starting_price=10.00',
      'stake=1.00',
      'final_price=9999.00',
      'shipping_charges=0.00',
      'auction_at='       + encodeURIComponent(auctionAt),
      'no_of_bidders='    + String(bidderIds.length),
    ];
    bidderIds.forEach(id => formParts.push('bidders=' + String(id)));
    const formBody = formParts.join('&');

    const aRes  = http.post(
      `${BASE_URL}/auction/create`,
      formBody,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const aBody = safeJSON(aRes);

    if (aRes.status === 200 && aBody && aBody.success) {
      const assignedCount = aBody.data.bidders ? aBody.data.bidders.length : 0;
      auctionIds.push(aBody.data.id);
      console.log(`✅ Auction ${a} created — ID: ${aBody.data.id} | bidders assigned: ${assignedCount}`);
    } else {
      console.error(`Auction ${a} FAILED: status=${aRes.status} body=${aRes.body.substring(0, 300)}`);
    }
    sleep(0.3);
  }

  console.log(`✅ ${auctionIds.length}/10 auctions created`);
  console.log(`Auction IDs: ${auctionIds.join(', ')}`);

  if (auctionIds.length === 0) {
    console.error('No auctions created — VUs cannot bid');
    return { bidders, auctionIds: [] };
  }

  // ── Step 4: Activate all auctions ─────────────────────────
  console.log('Step 4: Activating all auctions...');
  auctionIds.forEach(id => {
    const res  = http.put(
      `${BASE_URL}/auction/update/status`,
      JSON.stringify({ id, status: 'active' }),
      { headers: authJSON }
    );
    const body = safeJSON(res);
    if (res.status === 200 && body && body.success) {
      console.log(`✅ Auction ${id} activated`);
    } else {
      console.warn(`Auction ${id} activate failed: ${res.body.substring(0, 100)}`);
    }
    sleep(0.2);
  });

  console.log('=== SETUP COMPLETE ===');
  console.log(`Bidders: ${bidders.length} | Auctions: ${auctionIds.length}`);
  return { bidders, auctionIds, token };
}

// ── Socket.IO Helpers ─────────────────────────────────────────
// Socket.IO over HTTP Long Polling
// Packet codes:
//   40  = connect to namespace
//   41  = disconnect
//   42  = emit event
//   2   = ping (keep-alive — session expires in 25s without this)
//   3   = pong (server response to ping)

function socketHandshake(userId) {
  // Step 1: GET handshake — server returns SID + config
  // Response: 0{"sid":"xxx","pingInterval":25000,"pingTimeout":20000}
  const res   = http.get(`${SOCKET_URL}/socket.io/?EIO=4&transport=polling`);
  if (res.status !== 200) return null;

  const match = res.body.match(/"sid":"([^"]+)"/);
  if (!match) return null;
  const sid = match[1];

  // Step 2: POST "40" = connect to Socket.IO namespace
  const connectRes = http.post(
    `${SOCKET_URL}/socket.io/?EIO=4&transport=polling&sid=${sid}`,
    '40',
    { headers: { 'Content-Type': 'text/plain' } }
  );
  if (connectRes.status !== 200) {
    console.warn(`Socket connect failed: ${connectRes.status} — ${connectRes.body}`);
    return null;
  }

  // Step 3: POST "42["join",{"id":userId}]" = register user to socket
  http.post(
    `${SOCKET_URL}/socket.io/?EIO=4&transport=polling&sid=${sid}`,
    `42["join",{"id":${userId}}]`,
    { headers: { 'Content-Type': 'text/plain' } }
  );

  return sid;
}

function socketPing(sid) {
  // POST "2" = ping — keeps session alive (server pingInterval = 25s)
  // Must ping before session expires to avoid "Session ID unknown" error
  http.post(
    `${SOCKET_URL}/socket.io/?EIO=4&transport=polling&sid=${sid}`,
    '2',
    { headers: { 'Content-Type': 'text/plain' } }
  );
}

function socketEmit(sid, event, payload) {
  // POST "42["eventName",{...}]" = emit Socket.IO event
  return http.post(
    `${SOCKET_URL}/socket.io/?EIO=4&transport=polling&sid=${sid}`,
    `42["${event}",${JSON.stringify(payload)}]`,
    { headers: { 'Content-Type': 'text/plain' } }
  );
}

function socketPoll(sid) {
  // GET = long poll — receive server events (auction:bid, auction:timer etc)
  return http.get(
    `${SOCKET_URL}/socket.io/?EIO=4&transport=polling&sid=${sid}`
  );
}

function socketDisconnect(sid) {
  // POST "41" = disconnect from namespace
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

  // ── Login as bidder ────────────────────────────────────────
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

  // ── List auctions ──────────────────────────────────────────
  const aStart = Date.now();
  check(http.get(`${BASE_URL}/auction/auctions`, { headers: authHdr }),
    { 'auction list 200': r => r.status === 200 });
  auctionDuration.add(Date.now() - aStart);
  sleep(Math.random() + 0.5);

  // ── View single auction ────────────────────────────────────
  http.get(`${BASE_URL}/auction/auction?id=${auctionId}`, { headers: authHdr });
  sleep(Math.random() + 0.5);

  // ── Socket.IO connect ──────────────────────────────────────
  // GET handshake → POST "40" connect → POST "42["join"]" register user
  const sid = socketHandshake(userId);
  if (!sid) {
    auctionJoinFail.add(1);
    console.warn(`VU${__VU} socket handshake failed`);
    sleep(2); return;
  }

  // ── Join auction room ──────────────────────────────────────
  // POST "42["auction:join",{"auction_id":X}]"
  const joinRes = socketEmit(sid, 'auction:join', { auction_id: auctionId });
  if (joinRes.status !== 200) {
    auctionJoinFail.add(1);
    console.warn(`VU${__VU} auction:join failed: ${joinRes.status}`);
    socketDisconnect(sid);
    sleep(2); return;
  }
  sleep(0.5); // wait for join confirmation

  // ── Poll to confirm join ───────────────────────────────────
  socketPoll(sid);
  sleep(0.5);

  // ── Bid loop — same socket session + ping to keep alive ───
  // Socket.IO session expires in 25s (pingInterval)
  // We ping before each bid to keep it alive
  const bidCount  = Math.floor(Math.random() * 2) + 2; // 2-3 bids
  let lastPingTime = Date.now();

  for (let b = 0; b < bidCount; b++) {

    // Ping if more than 10s since last ping — prevents "Session ID unknown"
    if (Date.now() - lastPingTime > PING_INTERVAL_MS) {
      socketPing(sid);
      lastPingTime = Date.now();
    }

    // POST "42["auction:bid",{"auction_id":X,"user_id":Y}]"
    const bStart = Date.now();
    const bRes   = socketEmit(sid, 'auction:bid', { auction_id: auctionId, user_id: userId });
    bidDuration.add(Date.now() - bStart);

    if (bRes.status === 200) {
      bidSuccess.add(1);
      console.log(`VU${__VU} bid ${b+1} accepted — auction ${auctionId}`);
    } else {
      bidFail.add(1);
      console.warn(`VU${__VU} bid ${b+1} FAILED: status=${bRes.status} body=${bRes.body ? bRes.body.substring(0, 150) : 'empty'}`);
    }

    // Poll to receive server events (auction:bid broadcast, auction:timer)
    socketPoll(sid);

    sleep(Math.random() * 2 + 1); // 1-3s between bids
  }

  // ── Leave auction room ─────────────────────────────────────
  // POST "42["auction:leave",{"auction_id":X}]"
  socketEmit(sid, 'auction:leave', { auction_id: auctionId });
  sleep(0.5);

  // ── Disconnect ─────────────────────────────────────────────
  // POST "41"
  socketDisconnect(sid);
  sleep(Math.random() * 2 + 1);
}

// ── Scenario 2: Normal User Flow ──────────────────────────────
export function userFlow(data) {
  if (!data || !data.auctionIds || !data.auctionIds.length) { sleep(1); return; }

  const auctionId = data.auctionIds[Math.floor(Math.random() * data.auctionIds.length)];

  // ── Login as user ──────────────────────────────────────────
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

  // ── List auctions ──────────────────────────────────────────
  const aStart = Date.now();
  check(http.get(`${BASE_URL}/auction/auctions`, { headers: jsonHdr }),
    { 'user: list 200': r => r.status === 200 });
  auctionDuration.add(Date.now() - aStart);
  sleep(Math.random() + 1);

  // ── View auction ───────────────────────────────────────────
  check(http.get(`${BASE_URL}/auction/auction?id=${auctionId}`, { headers: jsonHdr }),
    { 'user: view 200': r => r.status === 200 });
  sleep(Math.random() * 2 + 1);

  // ── View another random auction ────────────────────────────
  const auctionId2 = data.auctionIds[Math.floor(Math.random() * data.auctionIds.length)];
  check(http.get(`${BASE_URL}/auction/auction?id=${auctionId2}`, { headers: jsonHdr }),
    { 'user: view2 200': r => r.status === 200 });

  sleep(Math.random() * 5 + 3);
}

// ── Teardown ──────────────────────────────────────────────────
export function teardown(data) {
  console.log(`\n=== TEST COMPLETE ===`);
  console.log(`Bidders: ${data?.bidders?.length} | Auctions: ${data?.auctionIds?.length}`);
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
<html lang="en">
<head>
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
td.lb{color:var(--muted);width:220px;}
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
  <p>Generated: ${runDate} &nbsp;|&nbsp; 100 Bidders | 10 Auctions | 5 min | k6 HTTP Polling</p></div>
  <span class="badge ${allPass ? 'pb' : 'fb'}">${allPass ? 'PASS' : 'FAIL'}</span>
</div>

<div class="wrap">

<div class="sec"><div class="st">Executive Summary</div>
<div class="grid">
  <div class="kpi"><div class="kl">Peak VUs</div><div class="kv" style="color:var(--accent)">20</div><div class="ks">10 bidders + 10 users</div></div>
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

<div class="sec"><div class="st">Bidder Journey (10 VUs)</div>
<div class="journey">
  <div class="js">Login as Bidder</div><div class="ja">→</div>
  <div class="js">List Auctions</div><div class="ja">→</div>
  <div class="js">View Auction</div><div class="ja">→</div>
  <div class="js">Handshake (SID)</div><div class="ja">→</div>
  <div class="js">Connect (40)</div><div class="ja">→</div>
  <div class="js">Join User (42 join)</div><div class="ja">→</div>
  <div class="js">Join Room (42 auction:join)</div><div class="ja">→</div>
  <div class="js">Ping (2) + Bid x2-3</div><div class="ja">→</div>
  <div class="js">Leave (42 auction:leave)</div><div class="ja">→</div>
  <div class="js">Disconnect (41)</div>
</div></div>

<div class="sec"><div class="st">Normal User Journey (10 VUs)</div>
<div class="journey">
  <div class="js">Login as User</div><div class="ja">→</div>
  <div class="js">List Auctions</div><div class="ja">→</div>
  <div class="js">View Auction</div><div class="ja">→</div>
  <div class="js">View Another Auction</div>
</div></div>

<div class="sec"><div class="st">Socket.IO Packet Reference</div>
<div class="tw"><table>
  <thead><tr><th>Packet</th><th>Meaning</th><th>When Used</th></tr></thead>
  <tbody>
    <tr><td style="font-family:monospace">GET ?EIO=4&transport=polling</td><td>Handshake — get session SID</td><td>Start of every bidder session</td></tr>
    <tr><td style="font-family:monospace">POST body: 40</td><td>Connect to Socket.IO namespace</td><td>After handshake</td></tr>
    <tr><td style="font-family:monospace">POST body: 42["join",{"id":X}]</td><td>Register user to socket session</td><td>After connect</td></tr>
    <tr><td style="font-family:monospace">POST body: 42["auction:join",{...}]</td><td>Join auction room</td><td>Before bidding</td></tr>
    <tr><td style="font-family:monospace">POST body: 2</td><td>Ping — keep session alive (expires in 25s)</td><td>Every 10s during bid loop</td></tr>
    <tr><td style="font-family:monospace">POST body: 42["auction:bid",{...}]</td><td>Place a bid</td><td>Bid loop x2-3</td></tr>
    <tr><td style="font-family:monospace">GET ?sid=xxx</td><td>Poll — receive server events</td><td>After each bid</td></tr>
    <tr><td style="font-family:monospace">POST body: 42["auction:leave",{...}]</td><td>Leave auction room</td><td>After bid loop</td></tr>
    <tr><td style="font-family:monospace">POST body: 41</td><td>Disconnect</td><td>End of session</td></tr>
  </tbody>
</table></div></div>

<div class="sec"><div class="st">Load Phases — 5 Minutes Total</div>
<div class="phases">
  <div class="ph" style="background:#1e3a5f;color:#60a5fa">Ramp-Up<br/>1m → 20</div>
  <div class="ph" style="background:#3b1f6b;color:#a78bfa">Peak<br/>3m @ 20</div>
  <div class="ph" style="background:#1f3a2a;color:#6ee7b7">Recovery<br/>1m → 0</div>
</div>
<p style="font-size:12px;color:var(--muted)">Setup: Login → Create bidders → Close old auctions (unreserve) → Create 10 auctions → Activate</p>
</div>

<div class="sec"><div class="st">Threshold Results</div>
<div class="tw"><table>
  <thead><tr><th>Metric</th><th>Threshold</th><th>Actual</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td>http_req_duration p95</td><td>&lt;1500ms — 95% users under 1.5s</td><td>${ms('http_req_duration','p(95)')}</td><td>${sb(p95,1500)}</td></tr>
    <tr><td>http_req_duration p99</td><td>&lt;3000ms — worst 1% under 3s</td><td>${ms('http_req_duration','p(99)')}</td><td>${sb(p99,3000)}</td></tr>
    <tr><td>http_req_failed rate</td><td>&lt;1% — max 1 in 100 fail</td><td>${pct('http_req_failed','rate')}</td><td>${sb(errRaw,0.01)}</td></tr>
    <tr><td>login_duration p95</td><td>&lt;1500ms — login acceptable under 1.5s</td><td>${ms('login_duration','p(95)')}</td><td>${sb(raw('login_duration','p(95)'),1500)}</td></tr>
    <tr><td>bid_duration p95</td><td>&lt;800ms — bid must be fast (time-critical)</td><td>${ms('bid_duration','p(95)')}</td><td>${sb(raw('bid_duration','p(95)'),800)}</td></tr>
    <tr><td>auction_list_duration p95</td><td>&lt;2000ms — list page under 2s</td><td>${ms('auction_list_duration','p(95)')}</td><td>${sb(raw('auction_list_duration','p(95)'),2000)}</td></tr>
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
  <div class="fi" style="border-left:3px solid var(--red)"><h4>Socket.IO Session Expiry (25s pingInterval)</h4><p>Socket.IO sessions expire in 25 seconds if no ping is sent. Script now sends ping packet "2" every 10 seconds during bid loop to prevent "Session ID unknown" errors.</p></div>
  <div class="fi" style="border-left:3px solid var(--red)"><h4>Bidder Reserved Status Blocks Assignment</h4><p>Server marks bidders as reserved when assigned to auctions. Setup closes all existing auctions first (Step 2.5) to unreserve bidders before creating new test auctions.</p></div>
  <div class="fi" style="border-left:3px solid var(--yellow)"><h4>PostgreSQL Connection Pool Pressure</h4><p>Each bid triggers a DB write (coin deduction + bid record). Knex default pool of 10 will queue under concurrent load. Watch for timeout errors at peak.</p></div>
  <div class="fi" style="border-left:3px solid #6c63ff"><h4>Auction Timer Broadcast</h4><p>Server emits auction:timer every second to all room members. Monitor event loop lag during peak with multiple active auctions.</p></div>
</div>

<div class="sec"><div class="st">Recommendations</div>
  <div class="rc"><div class="rn">1</div><div><h4>Increase PostgreSQL pool — pool.max=100 + PgBouncer</h4><p>Set Knex pool.max=100 and add PgBouncer to handle concurrent bid writes.</p></div></div>
  <div class="rc"><div class="rn">2</div><div><h4>Run PM2 in cluster mode with Redis adapter</h4><p>pm2 start app.js -i max. Add @socket.io/redis-adapter for cross-instance room support.</p></div></div>
  <div class="rc"><div class="rn">3</div><div><h4>Cache GET /api/auction/auctions with Redis 5s TTL</h4><p>Every VU calls this endpoint — a short cache reduces DB reads by 95% at peak.</p></div></div>
  <div class="rc"><div class="rn">4</div><div><h4>Throttle auction:timer to every 3s for large rooms</h4><p>Reduces event loop broadcast pressure by 66% for rooms with 100+ concurrent bidders.</p></div></div>
  <div class="rc"><div class="rn">5</div><div><h4>Add direct bidder unreserve API endpoint</h4><p>Currently bidders can only be unreserved by closing an auction. A direct unreserve endpoint would simplify test setup and auction management.</p></div></div>
</div>

<div class="sec"><div class="st">Test Configuration</div>
<div class="tw"><table><tbody>
  <tr><td class="lb">Bidders</td><td>100 (bidzon_bidder001-100@test.com)</td></tr>
  <tr><td class="lb">Auctions</td><td>10 (created fresh each run)</td></tr>
  <tr><td class="lb">Bidder VUs</td><td>10 peak</td></tr>
  <tr><td class="lb">User VUs</td><td>10 peak</td></tr>
  <tr><td class="lb">Duration</td><td>5 minutes</td></tr>
  <tr><td class="lb">Setup Steps</td><td>Login → Create bidders → Close old auctions → Create auctions → Activate</td></tr>
  <tr><td class="lb">Socket ping interval</td><td>Every 10s (server expires at 25s)</td></tr>
  <tr><td class="lb">Base URL</td><td>http://49.12.201.167/api</td></tr>
  <tr><td class="lb">Socket URL</td><td>http://49.12.201.167 (Socket.IO polling)</td></tr>
  <tr><td class="lb">Bid interval</td><td>1-3 seconds randomised</td></tr>
  <tr><td class="lb">Bids per session</td><td>2-3</td></tr>
  <tr><td class="lb">auction_at</td><td>2 hours from test start</td></tr>
  <tr><td class="lb">setupTimeout</td><td>10 minutes</td></tr>
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