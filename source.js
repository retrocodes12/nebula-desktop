'use strict';
// The file the shell's FFmpeg reads, fetched by this process and handed to FFmpeg on loopback.
//
// FFmpeg never touches the network itself. The Linux ffmpeg and ffprobe binaries (ffmpeg-static's release) are statically
// linked against glibc, and a static glibc binary cannot load the system's name-service modules: on Zorin 17 /
// Ubuntu 22.04 (nsswitch "files mdns4_minimal dns") both crashed with SIGSEGV on the FIRST host-name lookup, so no
// stream with a name in its address ever reached the converter — Dolby and DTS files played in silence (found
// 2026-09-14; an IP address worked, and that is all the rigs used). Node looks names up the normal way, so FFmpeg is
// given http://127.0.0.1:<port>/s/<key>/<id> and this server fetches the real address: it follows redirects, sends the
// add-on's own request headers (behaviorHints.proxyHeaders — a host that wants its Referer gets it), passes Range
// through so FFmpeg can seek, and cuts the answer off if the host drops, which FFmpeg's -reconnect turns into a ranged
// request from where it was. An HLS playlist is rewritten on the way through so that every address in it comes here
// as well (FFmpeg's HLS reader would open each segment by name itself). Only FFmpeg ever holds the key.
//
// Every converted piece is a fresh FFmpeg, and each one reads the same few places of the file before the piece's own
// seconds: the header, the index at the end, the tracks (measured on a 4 GB MKV: six requests per piece, five of
// them identical, 4–9 s before the first byte of video). What FFmpeg read at each offset is kept for the file being
// played, so from the second piece on only the piece's own bytes come from the host.
const http = require('http'), https = require('https'), crypto = require('crypto');

const KEY = crypto.randomBytes(16).toString('hex');
const MAX_ENTRIES = 64;                    // files FFmpeg may be reading at once, and a margin
const FINAL_TTL = 10 * 60000;              // a redirect's target is reused this long (signed addresses expire)
const LIST_MAX = 8 * 1048576;              // the largest playlist rewritten
const PREFIX_MAX = 4 * 1048576;            // bytes kept from one offset of a file
const PREFIXES = 8;                        // offsets kept per file, the least recently read going first
const CACHED = 2;                          // files that keep them (the one playing, and the one before it)
const HOP = /^(host|connection|keep-alive|proxy-[a-z-]*|te|trailer|transfer-encoding|upgrade|content-length|range|accept-encoding)$/i;
const PASS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag', 'content-encoding'];
// connections to a host are kept for the next request (a redirect's answer, a playlist, a read that ran to the end)
const AGENTS = { 'http:': new http.Agent({ keepAlive: true, maxSockets: 8 }), 'https:': new https.Agent({ keepAlive: true, maxSockets: 8 }) };
const LOG = !!process.env.NEBULA_SOURCE_LOG;

let server = null, port = 0, listening = null, agent = 'NebulaPlayer';
const entries = new Map();                 // id → { src, headers, final, finalAt, used, size, type, pre: Map(offset → { buf, at }) }

/** What a host could reasonably want from the add-on: header names as tokens, values on one line, a dozen at most. */
function cleanHeaders(h) {
  const out = {};
  if (!h || typeof h !== 'object' || Array.isArray(h)) return out;
  Object.keys(h).slice(0, 12).forEach((k) => {
    const v = h[k];
    if (!/^[A-Za-z0-9-]{1,64}$/.test(k) || HOP.test(k) || typeof v !== 'string' || v.length > 2000 || /[\r\n\0]/.test(v)) return;
    out[k] = v;
  });
  return out;
}
/** The player's `h` parameter (JSON), or no headers at all. */
function parseHeaders(s) { if (!s) return {}; try { return cleanHeaders(JSON.parse(s)); } catch (e) { return {}; } }

function start() {
  if (listening) return listening;
  listening = new Promise((ok, no) => {
    const s = http.createServer(handle);
    s.once('error', (e) => { listening = null; no(e); });
    s.listen(0, '127.0.0.1', () => { server = s; port = s.address().port; ok(port); });
  });
  return listening;
}
/** The loopback address FFmpeg reads `src` from; `headers` go to the host with every request. */
async function urlFor(src, headers, ua) {
  if (ua) agent = String(ua);
  await start();
  const hd = cleanHeaders(headers);
  const id = crypto.createHash('sha1').update(src + '\n' + JSON.stringify(hd)).digest('hex').slice(0, 24);
  let e = entries.get(id);
  if (!e) { e = { src, headers: hd, final: '', finalAt: 0, used: 0, size: 0, type: '', pre: null }; entries.set(id, e); }
  touch(e);
  if (entries.size > MAX_ENTRIES) { let old = null, t = Infinity; entries.forEach((x, k) => { if (x.used < t) { t = x.used; old = k; } }); entries.delete(old); }
  return 'http://127.0.0.1:' + port + '/s/' + KEY + '/' + id;
}
/** This file is the one in use: only the CACHED most recent files keep what was read of them. */
function touch(e) {
  e.used = Date.now();
  const held = []; entries.forEach((x) => { if (x.pre) held.push(x); });
  held.sort((a, b) => b.used - a.used).slice(CACHED).forEach((x) => { x.pre = null; });
}
/** An address named inside a playlist, fetched with its file's headers. The last path segment is kept (FFmpeg reads extensions). */
function childUrl(id, abs) {
  let name = 'x';
  try { name = (new URL(abs).pathname.split('/').pop() || '').replace(/[^A-Za-z0-9._-]/g, '').slice(-60) || 'x'; } catch (e) {}
  return 'http://127.0.0.1:' + port + '/s/' + KEY + '/' + id + '/' + name + '?u=' + encodeURIComponent(abs);
}

function keyOk(k) {
  if (!k || k.length !== KEY.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(k), Buffer.from(KEY)); } catch (e) { return false; }
}
/** One request to the host, redirects followed (the add-on's credentials stay with the host they were meant for). */
function open(url, headers, method, hop, cb) {
  let u; try { u = new URL(url); } catch (e) { return cb(new Error('bad address')); }
  if (!/^https?:$/.test(u.protocol)) return cb(new Error('not http'));
  if (/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname) && Number(u.port) === port) return cb(new Error('refused address'));
  let done = false; const t0 = Date.now();
  const req = (u.protocol === 'https:' ? https : http).request(u, { method, headers, timeout: 20000, agent: AGENTS[u.protocol] }, (up) => {
    const st = up.statusCode, loc = up.headers.location;
    if (LOG) console.error('[source]', method, st, u.host, headers.Range || '-', (Date.now() - t0) + ' ms');
    if ((st === 301 || st === 302 || st === 303 || st === 307 || st === 308) && loc && hop < 6) {
      up.resume(); done = true;
      let next; try { next = new URL(loc, u); } catch (e) { return cb(new Error('bad redirect')); }
      const h = Object.assign({}, headers);
      if (next.origin !== u.origin) { delete h.Authorization; delete h.authorization; delete h.Cookie; delete h.cookie; }
      return open(next.href, h, st === 303 ? 'GET' : method, hop + 1, cb);
    }
    done = true; cb(null, up, url);
  });
  req.on('timeout', () => req.destroy(new Error('timed out')));
  req.on('error', (e) => { if (!done) { done = true; cb(e); } });
  req.end();
}
/** The file's own address, or where it last redirected to while that is fresh. */
function fileAddress(e) { return e.final && Date.now() - e.finalAt < FINAL_TTL ? e.final : e.src; }
/** The whole playlist, every address in it (lines and URI="…" attributes) pointed back here. */
function playlist(up, first, base, id, res) {
  const parts = [first]; let len = first.length;
  up.on('data', (d) => { if (len < LIST_MAX) { parts.push(d); len += d.length; } });
  up.on('end', () => {
    const via = (ref) => { let abs; try { abs = new URL(ref, base).href; } catch (e) { return ref; } return /^https?:/i.test(abs) ? childUrl(id, abs) : ref; };
    const text = Buffer.concat(parts).toString('utf8').split(/\r?\n/).map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t[0] === '#') return line.replace(/URI="([^"]+)"/g, (all, ref) => 'URI="' + via(ref) + '"');
      return via(t);
    }).join('\n');
    const body = Buffer.from(text, 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
    res.end(body);
  });
}
/** Keep what the host sends from `off` (up to PREFIX_MAX, `first` being its first chunk) as that offset's copy. */
function capture(e, off, up, first) {
  if (!e.pre) e.pre = new Map();
  const parts = [first.length > PREFIX_MAX ? first.slice(0, PREFIX_MAX) : first]; let len = parts[0].length;
  const keep = () => {
    if (!len || !e.pre) return;
    const buf = Buffer.concat(parts, len), had = e.pre.get(off);
    if (had && had.buf.length >= buf.length) return;
    e.pre.set(off, { buf, at: Date.now() });
    if (e.pre.size > PREFIXES) { let old = null, t = Infinity; e.pre.forEach((x, k) => { if (x.at < t) { t = x.at; old = k; } }); e.pre.delete(old); }
  };
  up.on('data', (d) => { if (len < PREFIX_MAX) { const c = d.length > PREFIX_MAX - len ? d.slice(0, PREFIX_MAX - len) : d; parts.push(c); len += c.length; } });
  up.on('end', keep); up.on('close', keep);
}
/** A read of an offset already held: those bytes at once, and the host is asked for the rest only if FFmpeg reads past them. */
function fromCache(e, off, hit, h, res) {
  hit.at = Date.now();
  if (LOG) console.error('[source] held', off, hit.buf.length + ' bytes');
  res.writeHead(206, { 'Content-Type': e.type || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Range': 'bytes ' + off + '-' + (e.size - 1) + '/' + e.size, 'Content-Length': e.size - off });
  const rest = off + hit.buf.length;
  if (rest >= e.size) { res.end(hit.buf); return; }
  let up = null, closed = false;
  res.on('close', () => { closed = true; if (up) { try { up.destroy(); } catch (x) {} } });
  const more = () => {
    if (closed) return;
    open(fileAddress(e), Object.assign({}, h, { Range: 'bytes=' + rest + '-' }), 'GET', 0, (err, u2) => {
      if (err || u2.statusCode !== 206 || closed) { if (u2) u2.destroy(); try { res.destroy(); } catch (x) {} return; }
      up = u2; const cut = () => { try { res.destroy(); } catch (x) {} };
      up.on('error', cut); up.on('aborted', cut); up.pipe(res);
    });
  };
  if (res.write(hit.buf)) setTimeout(more, 50); else res.once('drain', more);
}
function handle(req, res) {
  let q; try { q = new URL(req.url || '/', 'http://127.0.0.1'); } catch (x) { res.writeHead(400); res.end(); return; }
  const m = /^\/s\/([0-9a-f]+)\/([0-9a-f]+)(?:\/([^/]*))?$/.exec(q.pathname);
  const e = m && keyOk(m[1]) ? entries.get(m[2]) : null;
  const child = !!(m && m[3] !== undefined), target = child ? String(q.searchParams.get('u') || '') : '';
  if (!e || (child && !/^https?:\/\//i.test(target))) { res.writeHead(404); res.end(); return; }
  touch(e);
  const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
  const h = Object.assign({ 'User-Agent': agent, Accept: '*/*' }, e.headers, { 'Accept-Encoding': 'identity' });
  if (req.headers.range) h.Range = req.headers.range;
  // an open-ended read from a known offset of the file itself (not a playlist's piece) may already be held
  const rg = /^bytes=(\d+)-$/.exec(String(req.headers.range || 'bytes=0-').trim()), off = rg ? Number(rg[1]) : -1;
  const hit = !child && method === 'GET' && off >= 0 && e.size > 0 && e.pre ? e.pre.get(off) : null;
  if (hit) return fromCache(e, off, hit, h, res);
  const reply = (err, up, at) => {
    if (err) { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end(String(err.message || err)); return; }
    if (!child && up.statusCode < 400 && at !== e.src) { e.final = at; e.finalAt = Date.now(); }
    const hd = {}; PASS.forEach((k) => { if (up.headers[k]) hd[k] = up.headers[k]; });
    if (method === 'HEAD') { res.writeHead(up.statusCode, hd); up.destroy(); res.end(); return; }
    // the file's size from its answer ("bytes a-b/size", or a whole-file 200): what makes a held offset servable
    const cr = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(up.headers['content-range'] || ''));
    const whole = up.statusCode === 200 && off === 0 && Number(up.headers['content-length']) > 0 && !up.headers['content-encoding'];
    const keepable = !child && off >= 0 && ((up.statusCode === 206 && cr && Number(cr[1]) === off && Number(cr[2]) === Number(cr[3]) - 1) || whole);
    // a host that drops mid-file: the socket closes short of the length, and FFmpeg asks again from where it was
    const cut = () => { try { res.destroy(); } catch (x) {} };
    up.on('error', cut); up.on('aborted', cut);
    res.on('close', () => { try { up.destroy(); } catch (x) {} });
    // an HLS playlist, known by its first line whatever its type or address says, is rewritten (and never kept: a held
    // copy would hand the next FFmpeg the ORIGINAL addresses); anything else streams through, its first bytes kept
    let seen = false;
    up.once('data', (first) => {
      seen = true;
      if (up.statusCode < 300 && /^(﻿)?#EXTM3U/.test(first.slice(0, 16).toString('utf8'))) return playlist(up, first, at, m[2], res);
      if (keepable) { e.size = cr ? Number(cr[3]) : Number(up.headers['content-length']); e.type = String(up.headers['content-type'] || ''); capture(e, off, up, first); }
      res.writeHead(up.statusCode, hd); res.write(first); up.pipe(res);
    });
    up.once('end', () => { if (!seen) { res.writeHead(up.statusCode, hd); res.end(); } });
  };
  if (child) return open(target, h, method, 0, reply);
  const addr = fileAddress(e);
  if (addr === e.src) return open(e.src, h, method, 0, reply);
  open(addr, h, method, 0, (err, up, at) => {
    // the remembered target stopped answering (a signed address that expired): once more from the add-on's address
    if (err || up.statusCode >= 400) { if (up) up.resume(); e.final = ''; return open(e.src, h, method, 0, reply); }
    reply(null, up, at);
  });
}

module.exports = { urlFor, parseHeaders, cleanHeaders, _port: () => port };
