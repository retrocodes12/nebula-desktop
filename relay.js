'use strict';
// Share with your TV — a read-ahead cache for the television on the same network.
//
// The TV's own buffer is capped by its memory; this computer's is not. While sharing is on, the TV sends
// every request of a stream here (GET /relay?u=<address>&k=<token>) and is answered from a cache this
// server fills AHEAD of it: a plain file is read past the furthest byte the TV has taken, and the next
// pieces of a segmented stream are fetched before they are asked for — the playlist named them, or the
// number in the address steps by the same amount each time. A source that pauses for a minute then
// costs the TV nothing, as long as this machine got ahead of it.
//
// Safety: every request carries the token (published to the TV through the profile's cloud store — the
// two must be signed in together); any http(s) host may be fetched EXCEPT this machine's loopback and
// link-local addresses (the TV must not reach services that exist only for this PC); the address is
// resolved once and pinned, so a name cannot flip to a private address between the check and the fetch.
// Manifests, playlists and text pass straight through, never cached (a live manifest changes every few
// seconds). Every answer carries CORS headers: the TV's player is a packaged (file://) app.
const http = require('http'), https = require('https'), dns = require('dns'), os = require('os');
const crypto = require('crypto'), fs = require('fs'), path = require('path');

const PORTS = [47320, 47321, 47322, 47323, 47324];   // after the renderer's own 47313–47317
const CHUNK = 1048576;                                // the cache's unit: one megabyte
const AHEAD = 160 * CHUNK;                            // how far a reader runs past what the TV has taken
const PRE_MAX = 24 * CHUNK;                           // a guessed piece is read this far before anyone asks for it
const PRE_DEPTH = 40;                                 // pieces guessed ahead of the last one the TV asked for
const PRE_INFLIGHT = 3;                               // guesses fetched at once
const LINGER = 45000;                                 // a reader nobody has read from for this long stops
const IDLE = 600000;                                  // an address nobody asked about for this long is forgotten
const WAIT = 40000;                                   // the TV's request waits this long for a byte, then gives up
const EDGE_HOLD = 6000;                               // after a guess found nothing (the live edge), no guesses past it for this long
const MANIFEST_RE = /\.(mpd|m3u8|m3u|xml|json|vtt|srt|ttml|dfxp|ass|ssa|txt|html?|key)(\?|#|$)/i;
const TEXT_TYPE_RE = /^text\/|xml|json|mpegurl/i;

let server = null, sockets = new Set(), port = 0, token = '', ua = 'NebulaPlayer', name = os.hostname();
let cap = 512 * CHUNK, stateFile = '', cacheBytes = 0, served = 0, sweeper = null;
const entries = new Map();     // address → entry: what is known and held of one file or piece
const lru = new Map();         // "address#piece" → entry, oldest first
const families = new Map();    // address with its counter blanked → { delta, top, guessTop, edge, edgeAt }
const playlists = new Map();   // segment address → the address that follows it in its playlist

class RelayError extends Error { constructor(status, msg, pre) { super(msg); this.status = status; this.pre = !!pre; } }

// ---- state on disk: the token (the TV keeps a copy through the cloud, so it must survive restarts) and whether sharing was on
function readState(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'relay.json'), 'utf8')) || {}; } catch (e) { return {}; } }
function writeState(dir, s) { try { fs.writeFileSync(path.join(dir, 'relay.json'), JSON.stringify(s)); } catch (e) {} }
function wasOn(dir) { return readState(dir).on === true; }

function lanHosts() {
  const out = [];
  try {
    const ifs = os.networkInterfaces();
    Object.keys(ifs).forEach((k) => (ifs[k] || []).forEach((a) => {
      const fam = a.family === 4 || a.family === 'IPv4';
      if (fam && !a.internal && !/^169\.254\./.test(a.address)) out.push(a.address);
    }));
  } catch (e) {}
  return out;
}
function info() { return { on: !!server, port, token, hosts: lanHosts(), name, bytes: cacheBytes, served, cap, held: entries.size }; }

function tokenOk(k) {
  if (!k || !token || k.length !== token.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(k), Buffer.from(token)); } catch (e) { return false; }
}
/** Loopback, unspecified and link-local: what exists for this machine alone. Other private ranges are the LAN itself. */
function privateTarget(addr) {
  if (process.env.NEBULA_RELAY_ALLOW_LOOPBACK === '1') return false;     // the rigs' upstream lives on this machine
  const a = String(addr || '').replace(/^::ffff:/i, '');
  return !a || /^127\./.test(a) || a === '0.0.0.0' || a === '::1' || a === '::' || /^169\.254\./.test(a) || /^fe[89ab][0-9a-f]:/i.test(a);
}
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// ---- upstream: one request, the address pinned to what it resolved to, redirects followed with the same check
function fetchUpstream(url, headers, method, cb, hop) {
  let u; try { u = new URL(url); } catch (e) { return cb(new RelayError(400, 'bad address')); }
  if (!/^https?:$/.test(u.protocol)) return cb(new RelayError(400, 'not http'));
  dns.lookup(u.hostname, (err, address, family) => {
    if (err) return cb(new RelayError(502, 'no such host'));
    if (privateTarget(address)) return cb(new RelayError(403, 'refused address'));
    const mod = u.protocol === 'https:' ? https : http;
    const opts = {
      method: method || 'GET',
      headers: Object.assign({ 'User-Agent': ua, Accept: '*/*', 'Accept-Encoding': 'identity' }, headers || {}),
      // the connection goes to the address that passed the check, whatever the name says a moment later
      lookup: (h, o, done) => (o && o.all) ? done(null, [{ address, family }]) : done(null, address, family),
      timeout: 20000,
    };
    let done = false;
    const req = mod.request(u, opts, (res) => {
      const st = res.statusCode, loc = res.headers.location;
      if ((st === 301 || st === 302 || st === 303 || st === 307 || st === 308) && loc && (hop || 0) < 5) {
        res.resume();
        let next; try { next = new URL(loc, u).href; } catch (e) { return cb(new RelayError(502, 'bad redirect')); }
        return fetchUpstream(next, headers, method, cb, (hop || 0) + 1);
      }
      done = true; cb(null, res);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => { if (!done) { done = true; cb(new RelayError(502, e && e.message || 'failed')); } });
    req.end();
  });
}

// ---- the cache: pieces of one megabyte per address, the oldest touched going first when the cap is reached
function entryFor(url) {
  let e = entries.get(url);
  if (!e) {
    e = { url, total: -1, type: '', ranges: null, chunks: new Map(), reader: null, far: 0, waiters: [], fail: null, failAt: 0, plain: false, lastClient: Date.now(), fam: null };
    entries.set(url, e);
  }
  return e;
}
function wake(e) { const w = e.waiters; e.waiters = []; w.forEach((f) => f()); }
function waitOn(e, ms) {
  return new Promise((ok) => {
    const fn = () => { clearTimeout(t); ok(true); };
    const t = setTimeout(() => { const i = e.waiters.indexOf(fn); if (i >= 0) e.waiters.splice(i, 1); ok(false); }, ms);
    e.waiters.push(fn);
  });
}
function dropChunk(ent, idx) {
  const b = ent.chunks.get(idx);
  if (b) { ent.chunks.delete(idx); cacheBytes -= b.length; }
  lru.delete(ent.url + '#' + idx);
}
function store(e, idx, buf) {
  dropChunk(e, idx);
  e.chunks.set(idx, buf); cacheBytes += buf.length; lru.set(e.url + '#' + idx, e);
  while (cacheBytes > cap && lru.size) {
    const [k, ent] = lru.entries().next().value;
    dropChunk(ent, Number(k.slice(k.lastIndexOf('#') + 1)));
    if (!ent.chunks.size && !ent.reader && ent !== e) entries.delete(ent.url);
  }
  wake(e);
}
function touch(e, idx) { const k = e.url + '#' + idx; if (lru.has(k)) { lru.delete(k); lru.set(k, e); } }
function forget(e) {
  stopReader(e);
  Array.from(e.chunks.keys()).forEach((i) => dropChunk(e, i));
  entries.delete(e.url);
  wake(e);
}

// ---- readers: one upstream connection per address, filling pieces from an offset until it is far enough ahead
function stopReader(e) {
  const r = e.reader; if (!r) return;
  r.dead = true; e.reader = null;
  try { if (r.res) r.res.destroy(); } catch (x) {}
}
function resumeReader(e) {
  const r = e.reader;
  if (r && r.paused && r.res && r.pos - Math.max(e.far, r.from) <= AHEAD / 2) { r.paused = false; r.res.resume(); }
}
function startReader(e, from, pre) {
  stopReader(e);
  const r = { from, pos: from, pending: [], pendingLen: 0, res: null, paused: false, pre: !!pre, dead: false, startedAt: Date.now() };
  e.reader = r; e.fail = null;
  fetchUpstream(e.url, from > 0 ? { Range: 'bytes=' + from + '-' } : {}, 'GET', (err, res) => {
    if (r.dead) { if (res) res.destroy(); return; }
    // status 0 = not a failure but not cacheable either: from here on this address passes straight through
    // (a refusal of our own — a bad or private address — is not remembered: it costs nothing to say again)
    const fail = (status, msg) => { if (!status) e.plain = true; e.fail = new RelayError(status, msg, r.pre); e.failAt = status === 400 || status === 403 ? 0 : Date.now(); if (res) res.destroy(); stopReader(e); wake(e); familyEdge(e); };
    if (err) return fail(err.status || 502, err.message);
    r.res = res;
    const st = res.statusCode, type = String(res.headers['content-type'] || '');
    if (st === 206) {
      const m = /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(String(res.headers['content-range'] || ''));
      if (!m || Number(m[1]) !== from) return fail(502, 'wrong range from the host');
      e.ranges = true;
      if (m[3] === '*') return fail(0, 'no length');
      e.total = Number(m[3]);
    } else if (st === 200) {
      if (from > 0) { e.ranges = false; return fail(0, 'host ignores ranges'); }
      const cl = Number(res.headers['content-length']);
      if (!(cl > 0)) return fail(0, 'no length');                   // an endless stream, or unknown: straight through
      e.total = cl;
    } else return fail(st, 'host answered ' + st);
    if (type) e.type = type;
    if (TEXT_TYPE_RE.test(type)) return fail(0, 'text');
    e.fail = null;
    wake(e);                                                   // the length is known: a waiting request can answer its headers
    const flush = (final) => {
      while (r.pendingLen >= CHUNK || (final && r.pendingLen > 0)) {
        const all = r.pending.length === 1 ? r.pending[0] : Buffer.concat(r.pending, r.pendingLen);
        const take = Math.min(CHUNK, all.length), piece = all.subarray(0, take);
        r.pending = take < all.length ? [all.subarray(take)] : []; r.pendingLen = all.length - take;
        store(e, r.pos / CHUNK, Buffer.from(piece));           // a copy: the upstream buffer is reused
        r.pos += take;
      }
    };
    res.on('data', (d) => {
      if (r.dead) return;
      r.pending.push(d); r.pendingLen += d.length;
      flush(false);
      const limit = r.pre && !e.far ? PRE_MAX : AHEAD, lead = r.pos - Math.max(e.far, r.from);
      // far enough ahead, or the cache is nearly full: wait for the TV to catch up (its next read resumes this)
      if (!r.paused && (lead > limit || (cacheBytes > cap * 0.9 && lead > 2 * CHUNK))) { r.paused = true; res.pause(); }
    });
    res.on('end', () => {
      if (r.dead) return;
      flush(true);
      if (e.reader === r) e.reader = null;
      r.done = true;
      wake(e);
      if (r.pre) guess(e.url, true);                           // a guessed piece is in: guess the next
    });
    res.on('error', () => { if (!r.dead) { if (e.reader === r) e.reader = null; wake(e); } });
    res.on('aborted', () => { if (!r.dead) { if (e.reader === r) e.reader = null; wake(e); } });
  });
}
/** A reader that covers the piece wanted, from the one running (resumed) or a fresh one at that offset (a seek). */
function ensureReader(e, idx) {
  const want = idx * CHUNK, r = e.reader;
  if (want > e.far) e.far = want;                               // asked for counts as taken: the reader's lead is measured from here
  if (r && !r.dead && r.pos <= want && want - r.pos <= AHEAD) { if (r.paused && r.res) { r.paused = false; r.res.resume(); } return; }
  if (r && !r.dead && r.res === null && r.from <= want && want - r.from <= AHEAD) return;   // still connecting
  startReader(e, want, false);
}

// ---- guessing the next pieces of a segmented stream
function familyOf(url) {
  const h = url.indexOf('#'); if (h >= 0) url = url.slice(0, h);
  const q = url.indexOf('?'), rest = q < 0 ? '' : url.slice(q);
  let p = q < 0 ? url : url.slice(0, q), ext = '';
  const em = /(\.[A-Za-z][A-Za-z0-9]{0,5})$/.exec(p);              // the extension's own digit (.m4s, .mp4) is not the counter
  if (em) { ext = em[1]; p = p.slice(0, -ext.length); }
  const m = /^(.*\D)?(\d+)(\D*)$/.exec(p);
  if (!m) return null;
  const head = m[1] || '', width = m[2].length, tail = m[3] + ext;
  return { key: head + '#' + tail + rest, n: Number(m[2]), make: (k) => head + String(k).padStart(width, '0') + tail + rest };
}
function familyEdge(e) {
  const f = e.fam; if (!f) return;
  const s = families.get(f.key); if (!s) return;
  if (e.fail && (e.fail.status === 404 || e.fail.status === 416 || e.fail.status === 403)) { s.edge = f.n; s.edgeAt = Date.now(); s.guessTop = Math.min(s.guessTop, f.n - 1); }
}
function preInflight() { let n = 0; entries.forEach((e) => { if (e.reader && e.reader.pre && !e.reader.paused) n++; }); return n; }
function prefetch(url, fam) {
  const e = entryFor(url);
  if (e.reader || e.chunks.size || e.plain) return false;
  if (e.fail && Date.now() - e.failAt < EDGE_HOLD) return false;
  e.fam = fam || null; e.lastClient = Date.now();
  startReader(e, 0, true);
  return true;
}
/** After a request (or a guessed piece arriving): fetch what should come next, a few at a time, up to PRE_DEPTH ahead. */
function guess(url, chained) {
  let n = preInflight();
  // the playlist said what follows
  let next = playlists.get(url), hops = 0;
  while (next && hops < PRE_DEPTH && n < PRE_INFLIGHT) { if (prefetch(next, null)) n++; next = playlists.get(next); hops++; }
  if (hops) return;
  // the number in the address steps by the same amount each time
  const f = familyOf(url); if (!f) return;
  let s = families.get(f.key);
  if (!s) { s = { delta: 0, top: f.n, guessTop: f.n, last: f.n, edge: 0, edgeAt: 0 }; families.set(f.key, s); if (!chained) return; }
  if (!chained) {
    const d = f.n - s.last;
    if (d > 0 && (!s.delta || d < s.delta)) s.delta = d;
    s.last = f.n;
    if (f.n > s.top) { s.top = f.n; if (s.edge && f.n >= s.edge) s.edge = 0; }
    if (s.guessTop < s.top) s.guessTop = s.top;
  }
  if (!s.delta) return;
  while (n < PRE_INFLIGHT && s.guessTop - s.top < PRE_DEPTH * s.delta) {
    const k = s.guessTop + s.delta;
    if (s.edge && k >= s.edge && Date.now() - s.edgeAt < EDGE_HOLD) return;
    s.guessTop = k;
    if (prefetch(f.make(k), { key: f.key, n: k })) n++;
  }
}
/** A playlist passing through: remember which piece follows which, so the guess needs no counter. */
function learnPlaylist(base, text) {
  let prev = null;
  String(text).split(/\r?\n/).forEach((line) => {
    const l = line.trim(); if (!l || l[0] === '#') return;
    let abs; try { abs = new URL(l, base).href; } catch (e) { return; }
    if (MANIFEST_RE.test(abs)) { prev = null; return; }
    if (prev && prev !== abs) playlists.set(prev, abs);
    prev = abs;
  });
  while (playlists.size > 6000) playlists.delete(playlists.keys().next().value);
}

// ---- answering the TV
function parseRange(h) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(h || '').trim()); if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) return null;                                      // a suffix range (bytes=-500): let the host answer it
  return { a: Number(m[1]), b: m[2] ? Number(m[2]) : null };
}
function failRes(res, err) {
  if (res.headersSent) { try { res.end(); } catch (e) {} return; }
  const st = err && err.status >= 400 ? err.status : 502;
  res.writeHead(st, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end(err && err.message || 'failed');
}
/** Manifests, playlists, HEAD, hosts that ignore ranges: the host's answer as it is, plus CORS. */
function passthrough(req, res, url) {
  const h = {}; if (req.headers.range) h.Range = req.headers.range;
  const playlist = /\.m3u8?(\?|#|$)/i.test(url);
  fetchUpstream(url, h, req.method === 'HEAD' ? 'HEAD' : 'GET', (err, up) => {
    if (err) return failRes(res, err);
    const hd = { 'Cache-Control': 'no-store' };
    ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'].forEach((k) => { if (up.headers[k]) hd[k] = up.headers[k]; });
    const isList = playlist || /mpegurl/i.test(String(up.headers['content-type'] || ''));
    if (isList && up.statusCode === 200) delete hd['content-length'];   // read whole, then sent
    res.writeHead(up.statusCode, hd);
    if (req.method === 'HEAD') { up.destroy(); res.end(); return; }
    if (isList && up.statusCode === 200) {
      const parts = []; let len = 0;
      up.on('data', (d) => { if (len < 2 * CHUNK) { parts.push(d); len += d.length; } });
      up.on('end', () => { const body = Buffer.concat(parts, len); try { learnPlaylist(url, body.toString('utf8')); } catch (e) {} res.end(body); });
      up.on('error', () => { try { res.end(); } catch (e) {} });
    } else {
      up.pipe(res);
      up.on('error', () => { try { res.end(); } catch (e) {} });
    }
    res.on('close', () => { try { up.destroy(); } catch (e) {} });
  });
}
async function ready(e, a) {
  if (e.fail && (e.fail.pre || Date.now() - e.failAt > 3000)) e.fail = null;
  if (e.total >= 0 || e.plain || e.fail) return;
  if (!e.reader) startReader(e, a - a % CHUNK, false);
  const t0 = Date.now();
  while (e.total < 0 && !e.plain && !e.fail && Date.now() - t0 < WAIT) await waitOn(e, 1000);
}
async function serve(req, res, url) {
  const e = entryFor(url);
  e.lastClient = Date.now(); e.fam = null;
  const rg = parseRange(req.headers.range), a = rg ? rg.a : 0;
  await ready(e, a);
  try { guess(url, false); } catch (x) {}
  if (e.plain) return passthrough(req, res, url);
  if (e.fail) return failRes(res, e.fail);
  if (e.total < 0) return failRes(res, new RelayError(504, 'the host did not answer in time'));
  if (rg && a > 0 && e.ranges === false) return passthrough(req, res, url);
  const total = e.total;
  if (a >= total) { res.writeHead(416, { 'Content-Range': 'bytes */' + total }); res.end(); return; }
  const end = rg && rg.b != null ? Math.min(rg.b, total - 1) : total - 1;
  const hd = { 'Content-Type': e.type || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': end - a + 1, 'Cache-Control': 'no-store' };
  if (rg) { hd['Content-Range'] = 'bytes ' + a + '-' + end + '/' + total; res.writeHead(206, hd); } else res.writeHead(200, hd);
  let gone = false;
  res.on('close', () => { gone = true; wake(e); });
  for (let pos = a; pos <= end && !gone;) {
    const idx = Math.floor(pos / CHUNK), buf = e.chunks.get(idx);
    if (!buf) {
      if (e.fail && !e.fail.pre) break;
      ensureReader(e, idx);
      const got = await waitOn(e, WAIT);
      if (!got && !e.chunks.get(idx)) break;                  // nothing arrived in WAIT: the TV will ask again
      continue;
    }
    touch(e, idx);
    const off = pos - idx * CHUNK, len = Math.min(buf.length - off, end - pos + 1);
    if (len <= 0) break;
    const more = res.write(buf.subarray(off, off + len));
    pos += len; served += len;
    if (pos > e.far) { e.far = pos; resumeReader(e); }
    e.lastClient = Date.now();
    if (!more && !gone) await new Promise((ok) => { const d = () => { res.off('close', d); ok(); }; res.once('drain', d); res.once('close', d); });
  }
  try { res.end(); } catch (x) {}
}
function handle(req, res) {
  let u; try { u = new URL(req.url || '/', 'http://x'); } catch (e) { res.writeHead(400); res.end(); return; }
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (!tokenOk(u.searchParams.get('k'))) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('token'); return; }
  if (u.pathname === '/relay/healthz') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, name, v: 1 })); return; }
  if (u.pathname === '/relay/stats') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(info())); return; }
  if (u.pathname !== '/relay' || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(404); res.end(); return; }
  const target = u.searchParams.get('u') || '';
  if (!/^https?:\/\/[^\s"'<>]{4,4000}$/i.test(target)) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad address'); return; }
  if (req.method === 'HEAD' || MANIFEST_RE.test(target)) return passthrough(req, res, target);
  serve(req, res, target).catch(() => { try { if (!res.headersSent) res.writeHead(500); res.end(); } catch (e) {} });
}

// ---- the server
function sweep() {
  const now = Date.now();
  entries.forEach((e) => {
    const r = e.reader;
    if (r && now - e.lastClient > LINGER && (!r.pre || r.paused || now - r.startedAt > LINGER)) stopReader(e);
    if (!e.reader && now - e.lastClient > IDLE) forget(e);
  });
}
function start(opts) {
  opts = opts || {};
  if (opts.ua) ua = opts.ua;
  if (opts.name) name = opts.name;
  if (opts.cap > 0) cap = opts.cap;
  if (opts.dir) {
    stateFile = opts.dir;
    const s = readState(opts.dir);
    token = /^[0-9a-f]{32}$/.test(String(s.token || '')) ? s.token : crypto.randomBytes(16).toString('hex');
    writeState(opts.dir, { token, on: true });
  } else if (opts.token && /^[0-9a-f]{32}$/.test(opts.token)) token = opts.token;
  else if (!token) token = crypto.randomBytes(16).toString('hex');
  if (server) return Promise.resolve(info());
  const attempt = (i) => new Promise((resolve, reject) => {
    const p = i < PORTS.length ? PORTS[i] : 0, s = http.createServer(handle);
    s.on('connection', (sock) => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); });
    s.on('clientError', (err, sock) => { try { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) {} });
    s.once('error', (err) => { s.close(); if (p !== 0 && err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) resolve(attempt(i + 1)); else reject(err); });
    s.listen(p, opts.host || '0.0.0.0', () => { server = s; port = s.address().port; resolve(info()); });
  });
  return attempt(0).then((i) => { sweeper = setInterval(sweep, 5000); return i; });
}
function stop() {
  if (stateFile) writeState(stateFile, { token, on: false });
  clearInterval(sweeper); sweeper = null;
  entries.forEach((e) => forget(e));
  families.clear(); playlists.clear(); served = 0;
  const s = server; server = null; port = 0;
  if (!s) return Promise.resolve(info());
  sockets.forEach((k) => { try { k.destroy(); } catch (e) {} }); sockets.clear();
  return new Promise((ok) => s.close(() => ok(info())));
}
module.exports = { start, stop, info, wasOn, CHUNK, _familyOf: familyOf };
