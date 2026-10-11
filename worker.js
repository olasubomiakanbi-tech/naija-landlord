/* =====================================================================
   NAIJA LANDLORD × LAGOS LIFE — server (Cloudflare Worker)
   Runs on the route  naijalandlord.app/*  in front of GitHub Pages.

   1. Adds the Content-Security-Policy frame-ancestors header Lagos Life
      needs so the game can be shown inside its Games app.
   2. /relay   — the online-play relay (WebSocket, one Durable Object).
      Rooms, chat, lobby and tournaments pass through it on normal HTTPS,
      so networks that block odd ports still work.
   3. /vatar/*  — the small server Lagos Life requires:
        POST /vatar/me       { session, mode }               -> { playerId, owned }
        POST /vatar/claim    { session, mode, purchaseId }   -> { owned }
        POST /vatar/result   { session, mode, matchId, winner } -> { settled | waiting }
        POST /vatar/webhook  (called by Lagos Life)
        GET  /vatar/health   -> which settings are filled in
   Settings (Worker → Settings → Variables and secrets):
     VATAR_TEST_SECRET          vtr_test_…
     VATAR_TEST_RESULTS_SECRET  test results secret
     VATAR_TEST_WEBHOOK_SECRET  vtr_whsec_test_…
     VATAR_LIVE_SECRET          vtr_live_…            (after approval)
     VATAR_LIVE_RESULTS_SECRET  live results secret   (after approval)
     VATAR_LIVE_WEBHOOK_SECRET  vtr_whsec_…           (after approval)
   KV namespace binding:  NL_KV
   Durable Object binding: RELAY -> class Relay (see wrangler.jsonc)
   ===================================================================== */
const FRAME_ANCESTORS = "frame-ancestors 'self' https://lagoslife.app https://www.lagoslife.app https://naijalife.app https://www.naijalife.app https://lagoslife.eliysites.com";
const API_PATH = '/api/games/v1';

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/relay') {
      if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('Naija Landlord relay. Connect with a WebSocket.', { status: 426 });
      if (!env.RELAY) return new Response('Relay not configured', { status: 503 });
      return env.RELAY.get(env.RELAY.idFromName('main')).fetch(req);
    }
    if (url.pathname.startsWith('/vatar/')) {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
      try { return await route(req, env, ctx, url.pathname.slice(6)); }
      catch (e) {
        const status = e.status || 500;
        return json({ error: e.code || 'server', message: e.message || 'Server error' }, status);
      }
    }
    // everything else: the game itself from GitHub Pages, plus the framing header
    const res = await fetch(req);
    const h = new Headers(res.headers);
    h.set('Content-Security-Policy', FRAME_ANCESTORS);
    h.delete('X-Frame-Options');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  },
};

async function route(req, env, ctx, path) {
  if (path === '/health' && req.method === 'GET') {
    return json({
      ok: true, kv: !!env.NL_KV, relay: !!env.RELAY,
      test: { secret: !!env.VATAR_TEST_SECRET, results: !!env.VATAR_TEST_RESULTS_SECRET, webhook: !!env.VATAR_TEST_WEBHOOK_SECRET },
      live: { secret: !!env.VATAR_LIVE_SECRET, results: !!env.VATAR_LIVE_RESULTS_SECRET, webhook: !!env.VATAR_LIVE_WEBHOOK_SECRET },
    });
  }
  if (req.method !== 'POST') throw fail(405, 'method', 'Use POST.');
  if (path === '/webhook') return webhook(req, env, ctx);

  const body = await req.json().catch(() => ({}));
  const mode = body.mode === 'live' ? 'live' : 'test';
  const who = await verifySession(env, mode, body.session);

  if (path === '/me') return json({ playerId: who.playerId, owned: await owned(env, mode, who.playerId) });

  if (path === '/claim') {
    const pid = String(body.purchaseId || '');
    if (!pid) throw fail(400, 'bad_request', 'purchaseId missing.');
    await grant(env, mode, pid, who.playerId);
    return json({ owned: await owned(env, mode, who.playerId) });
  }

  if (path === '/result') return result(env, mode, who, String(body.matchId || ''), String(body.winner || ''));

  throw fail(404, 'not_found', 'Unknown path.');
}

/* ---------- Lagos Life API ---------- */
function apiBase(env) { return (env.VATAR_API || 'https://lagoslife.app') + API_PATH; }
function secretFor(env, mode) {
  const s = mode === 'live' ? env.VATAR_LIVE_SECRET : env.VATAR_TEST_SECRET;
  if (!s) throw fail(503, 'not_configured', `The ${mode} secret is not set on the server yet.`);
  return s;
}
async function vatar(env, mode, method, path, body, extraHeaders) {
  const res = await fetch(apiBase(env) + path, {
    method,
    headers: Object.assign({ authorization: 'Bearer ' + secretFor(env, mode), 'content-type': 'application/json' }, extraHeaders || {}),
    body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw fail(res.status, j.error || 'upstream', j.message || 'Lagos Life refused the request.');
  return j;
}
async function verifySession(env, mode, session) {
  if (!session) throw fail(401, 'no_session', 'Missing session.');
  const v = await vatar(env, mode, 'POST', '/session/verify', { session });
  if (!v.playerId) throw fail(401, 'bad_session', 'Session not valid.');
  return v;
}

/* ---------- purchases ---------- */
async function owned(env, mode, playerId) {
  return (await env.NL_KV.get(`own:${mode}:${playerId}`, 'json')) || [];
}
/* give the item once, then tell Lagos Life it was delivered (safe to repeat) */
async function grant(env, mode, purchaseId, mustBePlayer) {
  const p = await vatar(env, mode, 'GET', `/purchases/${encodeURIComponent(purchaseId)}`);
  if (mustBePlayer && p.playerId !== mustBePlayer) throw fail(403, 'not_yours', 'That purchase belongs to someone else.');
  if (p.status === 'refunded') throw fail(409, 'refunded', 'That purchase was refunded.');
  if (p.status !== 'paid' && p.status !== 'delivered') throw fail(409, 'not_paid', 'That purchase is not paid.');
  const doneKey = `pur:${mode}:${purchaseId}`;
  if (!(await env.NL_KV.get(doneKey))) {
    const key = `own:${mode}:${p.playerId}`;
    const list = (await env.NL_KV.get(key, 'json')) || [];
    if (!list.includes(p.productId)) list.push(p.productId);
    await env.NL_KV.put(key, JSON.stringify(list));
    await env.NL_KV.put(doneKey, '1');
  }
  if (p.status === 'paid') await vatar(env, mode, 'POST', `/purchases/${encodeURIComponent(purchaseId)}/deliver`, {});
  return p;
}

/* ---------- match results ----------
   Every player's game reports the winner when the game ends.
   Friendly (no stake): the first report from a player in the match settles it.
   Staked: someone other than the named winner must confirm it, and no report
   may disagree, so a winner cannot crown themselves. A draw needs two matching reports. */
async function result(env, mode, who, matchId, winner) {
  if (!matchId || !winner) throw fail(400, 'bad_request', 'matchId and winner are required.');
  const m = await vatar(env, mode, 'GET', `/matches/${encodeURIComponent(matchId)}`);
  const ids = (m.players || []).map(p => p.playerId);
  if (!ids.includes(who.playerId)) throw fail(403, 'not_in_match', 'You are not in this match.');
  if (m.status !== 'playing') return json({ settled: m.status === 'done', status: m.status }, m.status === 'done' ? 200 : 409);
  if (winner !== 'draw' && !ids.includes(winner)) throw fail(400, 'bad_winner', 'Winner is not in this match.');

  const key = `res:${mode}:${matchId}`;
  const claims = (await env.NL_KV.get(key, 'json')) || {};
  claims[who.playerId] = winner;
  await env.NL_KV.put(key, JSON.stringify(claims), { expirationTtl: 60 * 60 * 24 });

  let ok;
  const votes = Object.entries(claims);
  const agree = votes.every(([, w]) => w === winner);
  if (!m.stake) ok = true;
  else if (winner === 'draw') ok = agree && votes.length >= Math.min(2, ids.length);
  else ok = agree && votes.some(([pid, w]) => w === winner && pid !== winner);
  if (!ok) return json({ settled: false, waiting: true }, 202);

  const path = `${API_PATH}/matches/${encodeURIComponent(matchId)}/result`;
  const body = JSON.stringify({ winner });
  const ts = String(Math.floor(Date.now() / 1000));
  const rs = mode === 'live' ? env.VATAR_LIVE_RESULTS_SECRET : env.VATAR_TEST_RESULTS_SECRET;
  if (!rs) throw fail(503, 'not_configured', `The ${mode} results secret is not set on the server yet.`);
  const sig = await hmacHex(rs, ['POST', path, ts, m.nonce, await sha256Hex(body)].join('\n'));
  try {
    await vatar(env, mode, 'POST', `/matches/${encodeURIComponent(matchId)}/result`, body, { 'X-Vatar-Timestamp': ts, 'X-Vatar-Signature': 'v1=' + sig });
  } catch (e) {
    if (e.status === 409) return json({ settled: true, already: true });
    throw e;
  }
  return json({ settled: true });
}

/* ---------- webhooks: a nudge, never proof. We check with the API before granting. ---------- */
async function webhook(req, env, ctx) {
  const raw = await req.text();
  const sig = (req.headers.get('X-Vatar-Signature') || '').replace(/^sha256=/, '');
  let mode = null;
  for (const [m, secret] of [['test', env.VATAR_TEST_WEBHOOK_SECRET], ['live', env.VATAR_LIVE_WEBHOOK_SECRET]]) {
    if (secret && sig && safeEqual(await hmacHex(secret, raw), sig)) { mode = m; break; }
  }
  if (!mode) return json({ error: 'bad_signature' }, 401);
  let ev = {}; try { ev = JSON.parse(raw); } catch (e) {}
  if (ev.type === 'purchase.paid' && ev.data && ev.data.purchaseId) {
    ctx.waitUntil(grant(env, ev.mode === 'live' ? 'live' : mode, ev.data.purchaseId).catch(() => {}));
  }
  return json({ ok: true });
}

/* ---------- helpers ---------- */
function cors() {
  return { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' };
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, cors()) });
}
function fail(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }
const enc = new TextEncoder();
function toHex(buf) { return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join(''); }
async function sha256Hex(text) { return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text))); }
async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* =====================================================================
   RELAY: a tiny publish/subscribe hub with retained messages and
   "last will" messages, the same ideas as MQTT, spoken as JSON.
     client -> {t:'sub',topic} {t:'unsub',topic} {t:'pub',topic,p,r} {t:'will',topic,p,r} {t:'ping'}
     server -> {t:'msg',topic,p} {t:'pong'}
   ===================================================================== */
const MAX_SUBS = 300, MAX_TOPIC = 300, MAX_PAYLOAD = 900 * 1024, RETAIN_DAYS = 7;

export function topicMatch(filter, topic) {
  const f = filter.split('/'), t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}
/* lobby lists and online flags are re-sent often, so they live in memory only */
function persistTopic(topic) { return !/(^|\/)(lobby|tlobby|presence)\//.test(topic); }

export class RelayCore {
  /* io: { sockets(), att(ws), setAtt(ws,a), send(ws,str), store: {get,put,delete,list} } */
  constructor(io) { this.io = io; this.subs = new Map(); this.ret = null; this.loading = null; }
  load() {
    if (this.ret) return Promise.resolve();
    if (!this.loading) this.loading = (async () => {
      const ret = new Map(), now = Date.now();
      const r = await this.io.store.list({ prefix: 'r:' });
      for (const [k, v] of r) {
        if (!v || now - v.at > RETAIN_DAYS * 864e5) { await this.io.store.delete(k); continue; }
        ret.set(k.slice(2), v);
      }
      const live = new Set(this.io.sockets().map(ws => (this.io.att(ws) || {}).id));
      const s = await this.io.store.list({ prefix: 's:' });
      for (const [k, v] of s) {
        const cid = k.slice(2);
        if (live.has(cid)) this.subs.set(cid, new Set(v)); else await this.io.store.delete(k);
      }
      this.ret = ret;
    })();
    return this.loading;
  }
  async message(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_PAYLOAD + 2048) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'ping') { this.io.send(ws, '{"t":"pong"}'); return; }
    await this.load();
    const a = this.io.att(ws) || {};
    const cid = a.id;
    const topic = typeof m.topic === 'string' ? m.topic : '';
    if (!cid || !topic || topic.length > MAX_TOPIC) return;
    if (m.t === 'sub') {
      const set = this.subs.get(cid) || new Set();
      if (!set.has(topic) && set.size < MAX_SUBS) { set.add(topic); this.subs.set(cid, set); await this.io.store.put('s:' + cid, [...set]); }
      for (const [t, v] of this.ret) if (topicMatch(topic, t)) this.io.send(ws, JSON.stringify({ t: 'msg', topic: t, p: v.p }));
    } else if (m.t === 'unsub') {
      const set = this.subs.get(cid);
      if (set && set.delete(topic)) await this.io.store.put('s:' + cid, [...set]);
    } else if (m.t === 'pub') {
      if (topic.includes('+') || topic.includes('#')) return;
      const p = typeof m.p === 'string' ? m.p : '';
      if (p.length > MAX_PAYLOAD) return;
      await this.publish(topic, p, !!m.r);
    } else if (m.t === 'will') {
      const p = typeof m.p === 'string' ? m.p.slice(0, 1024) : '';
      a.will = { topic, p, r: !!m.r };
      this.io.setAtt(ws, a);
    }
  }
  async publish(topic, p, retain) {
    if (retain) {
      const gone = p === '' || (/(^|\/)presence\//.test(topic) && p === '0');
      if (gone) { if (this.ret.delete(topic) && persistTopic(topic)) await this.io.store.delete('r:' + topic); }
      else {
        const v = { p, at: Date.now() };
        this.ret.set(topic, v);
        if (persistTopic(topic)) await this.io.store.put('r:' + topic, v);
      }
    }
    const out = JSON.stringify({ t: 'msg', topic, p });
    for (const ws of this.io.sockets()) {
      const a = this.io.att(ws); if (!a) continue;
      const set = this.subs.get(a.id);
      if (!set) continue;
      for (const f of set) if (topicMatch(f, topic)) { this.io.send(ws, out); break; }
    }
  }
  async closed(ws) {
    await this.load();
    const a = this.io.att(ws) || {};
    if (a.closed) return;
    a.closed = true; this.io.setAtt(ws, a);
    if (a.id) { this.subs.delete(a.id); await this.io.store.delete('s:' + a.id); }
    if (a.will && a.will.topic) await this.publish(a.will.topic, a.will.p, a.will.r);
  }
}

export class Relay {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.core = new RelayCore({
      sockets: () => ctx.getWebSockets(),
      att: ws => { try { return ws.deserializeAttachment(); } catch (e) { return null; } },
      setAtt: (ws, a) => { try { ws.serializeAttachment(a); } catch (e) {} },
      send: (ws, str) => { try { ws.send(str); } catch (e) {} },
      store: {
        get: k => ctx.storage.get(k), put: (k, v) => ctx.storage.put(k, v),
        delete: k => ctx.storage.delete(k), list: o => ctx.storage.list(o),
      },
    });
    /* keep-alive pings are answered without waking the object */
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}')); } catch (e) {}
  }
  async fetch(req) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: crypto.randomUUID() });
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, msg) { await this.core.message(ws, typeof msg === 'string' ? msg : new TextDecoder().decode(msg)); }
  async webSocketClose(ws) { await this.core.closed(ws); try { ws.close(); } catch (e) {} }
  async webSocketError(ws) { await this.core.closed(ws); }
}
