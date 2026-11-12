// Downloads on a computer (11-04, his "add the downloads option in ios and desktop versions"): a film or an episode kept
// in the app's own folder to watch with no connection. The Android app's rules (DownloadPlan.kt), word for word where they
// are words: only a finished file or a finished unprotected playlist — never live, protected, a web page or a torrent.
// A plain file is fetched with Range so a break resumes where it stopped; a playlist is saved by the bundled FFmpeg
// (-c copy into Matroska). Two at a time. The player plays a saved copy from this app's own server (/dl/<key>/…).
// A TV on the same network plays them too (2026-11-11, his "play downloaded videos on my laptop nebula in my tv nebula"):
// while Share with your TV is on, the sharing listener (relay.js, token-gated) lists the finished copies and serves them
// — /relay/dl/list, /relay/dl/<key>/video.<ext>, /relay/dl/<key>/sub/<i>.<ext> (`attach`). Nothing else on this disk.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

const NO_LIVE = 'Live streams can’t be downloaded. Try another stream.';
const NO_PROTECTED = 'Protected streams can’t be downloaded. Try another stream.';
const NO_KIND = 'This stream can’t be downloaded. Try another one.';
const NO_REACH = 'Couldn’t reach that stream. Try again, or try another one.';
const NO_PAGE = 'That stream is a web page, not a video. Try another one.';
const NO_ROOM = 'Not enough room on this computer for that download.';
const NOT_READY = 'That source isn’t ready yet. Try another one.';
const MARGIN = 500 * 1048576;          // left free after a download
const MIN_FILE = 20 * 1048576;         // under this a "film" is a debrid host's "not ready yet" clip
const PARALLEL = 2;

let dir = '', ffmpeg = 'ffmpeg', push = null;
let items = [];
const running = new Map();             // key -> { stop() }
let saveTimer = null, pushTimer = null;

function setup(o) {
  dir = o.dir; ffmpeg = o.ffmpeg || 'ffmpeg'; push = o.push || null;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  try { items = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).filter((x) => x && x.key && x.file); } catch (e) { items = []; }
  items.forEach((it) => { if (it.state === 'running') it.state = 'queued'; });   // the app closed mid-download: it carries on
  pump();
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { const f = path.join(dir, 'index.json'); fs.writeFileSync(f + '.tmp', JSON.stringify(items)); fs.renameSync(f + '.tmp', f); } catch (e) {}
  }, 300);
}
function pub(it) {
  return { key: it.key, viewer: it.viewer, type: it.type, id: it.id, name: it.name, poster: it.poster || '', addonUrl: it.addonUrl || '',
    source: it.source || '', fileName: it.fileName || '', description: it.description || '', ext: path.extname(it.file),
    state: it.state, bytes: it.bytes || 0, total: it.total || 0, pct: it.pct >= 0 ? it.pct : -1, err: it.err || '', at: it.at,
    subs: (it.subs || []).map((s, i) => ({ i, lang: s.lang })), hls: it.kind === 'hls', streamName: it.streamName || '', streamTitle: it.streamTitle || '' };
}
function list() { return items.map(pub); }
/** What a TV is told of one finished copy: enough to show and play it. Never the add-on's address (it can carry the
    viewer's own keys) nor where the file came from. */
function tvRow(it) {
  return { key: it.key, viewer: it.viewer, type: it.type, id: it.id, name: it.name, poster: it.poster || '', source: it.source || '',
    fileName: it.fileName || '', ext: path.extname(it.file), bytes: it.bytes || it.total || 0, at: it.at,
    subs: (it.subs || []).map((s, i) => ({ i, lang: s.lang, ext: path.extname(s.file) })), streamName: it.streamName || '', streamTitle: it.streamTitle || '' };
}
/** The finished copies of one viewer (who's watching: 'a' or 'b'), newest first — those whose file is still here. */
function shared(viewer) { return items.filter((it) => it.viewer === (viewer === 'b' ? 'b' : 'a') && fileOf(it.key)).map(tvRow); }
/** Where a finished copy is on this disk, or '' — the only way a key ever becomes a path. */
function fileOf(key) {
  const it = /^[0-9a-f]{16}$/.test(String(key || '')) ? find(key) : null;
  if (!it || it.state !== 'done') return '';
  const f = path.join(dir, it.file);
  try { return fs.statSync(f).isFile() ? f : ''; } catch (e) { return ''; }
}
/** Progress is told at most once a second; a state change at once. */
function notify(now) {
  save();
  if (!push) return;
  if (now) { clearTimeout(pushTimer); pushTimer = null; push(list()); return; }
  if (!pushTimer) pushTimer = setTimeout(() => { pushTimer = null; push(list()); }, 1000);
}
function free() { try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch (e) { return Infinity; } }

/** One GET, redirects followed (credentials stay with the host they were meant for). cb(err, res) once. */
function get(url, headers, hop, cb) {
  let done = false; const once = (e, r) => { if (!done) { done = true; cb(e, r); } };
  let u; try { u = new URL(url); } catch (e) { return once(new Error('bad address')); }
  if (!/^https?:$/.test(u.protocol)) return once(new Error('not http'));
  const req = (u.protocol === 'https:' ? https : http).get(u, { headers, timeout: 30000 }, (res) => {
    const st = res.statusCode, loc = res.headers.location;
    if ([301, 302, 303, 307, 308].indexOf(st) >= 0 && loc && hop < 6) {
      res.resume();
      let n; try { n = new URL(loc, u); } catch (e) { return once(new Error('bad redirect')); }
      const h = Object.assign({}, headers);
      if (n.origin !== u.origin) { delete h.Authorization; delete h.authorization; delete h.Cookie; delete h.cookie; }
      return get(n.href, h, hop + 1, once);
    }
    res.url = u.href; once(null, res);
  });
  req.on('timeout', () => req.destroy(new Error('timed out')));
  req.on('error', (e) => once(e));
  return req;
}
function text(url, headers) {
  return new Promise((ok, no) => get(url, headers, 0, (e, res) => {
    if (e) return no(e);
    if (res.statusCode < 200 || res.statusCode > 299) { res.resume(); return no(new Error('HTTP ' + res.statusCode)); }
    let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { b += c; if (b.length > 4e6) res.destroy(); });
    res.on('end', () => ok({ body: b, url: res.url })); res.on('error', no);
  }));
}
/** What a stream's first bytes say it is (DownloadPlan.sniff). */
function sniff(url, headers) {
  return new Promise((ok) => {
    const h = Object.assign({}, headers, { Range: 'bytes=0-4095' });
    get(url, h, 0, (e, res) => {
      if (e) return ok({ refused: NO_REACH });
      const st = res.statusCode, type = String(res.headers['content-type'] || '').toLowerCase();
      if (st < 200 || st > 299) { res.resume(); return ok({ refused: NO_REACH }); }
      const cr = String(res.headers['content-range'] || ''); const m = /\/(\d+)\s*$/.exec(cr);
      const total = m ? Number(m[1]) : (st === 200 ? Number(res.headers['content-length'] || 0) : 0);
      let head = Buffer.alloc(0);
      const fin = () => {
        const t = head.toString('utf8').replace(/^\uFEFF/, '').trimStart(), low = t.slice(0, 256).toLowerCase();
        if (t.startsWith('#EXTM3U') || type.indexOf('mpegurl') >= 0) return ok({ hls: true, url: res.url });
        if (low.indexOf('<mpd') >= 0 || type.indexOf('dash+xml') >= 0) return ok({ refused: NO_KIND });
        if (type.indexOf('text/html') >= 0 || low.startsWith('<!doctype') || low.startsWith('<html')) return ok({ refused: NO_PAGE });
        if (!(total > 0)) return ok({ refused: NO_LIVE });
        if (total < MIN_FILE) return ok({ refused: NOT_READY });
        ok({ file: true, total, type, url: res.url });
      };
      res.on('data', (c) => { head = Buffer.concat([head, c]); if (head.length >= 1024) { res.destroy(); fin(); } });
      res.on('end', fin); res.on('error', fin);
    });
  });
}
/** A playlist that can be kept: the best variant of a master list, finished (#EXT-X-ENDLIST) and unprotected. */
async function playlist(url, headers) {
  let p = await text(url, headers);
  if (/#EXT-X-STREAM-INF/i.test(p.body)) {
    const lines = p.body.split(/\r?\n/); let best = null, bw = -1;
    for (let i = 0; i < lines.length; i++) {
      const m = /^#EXT-X-STREAM-INF:(.*)$/i.exec(lines[i]); if (!m) continue;
      const b = Number((/BANDWIDTH=(\d+)/i.exec(m[1]) || [])[1] || 0);
      let j = i + 1; while (j < lines.length && (!lines[j].trim() || lines[j].startsWith('#'))) j++;
      if (j < lines.length && b > bw) { bw = b; best = new URL(lines[j].trim(), p.url).href; }
    }
    if (!best) return { refused: NO_KIND };
    p = await text(best, headers);
  }
  if (/#EXT-X-KEY:(?![^\n]*METHOD=NONE)/i.test(p.body) || /#EXT-X-SESSION-KEY/i.test(p.body)) return { refused: NO_PROTECTED };
  if (!/#EXT-X-ENDLIST/i.test(p.body)) return { refused: NO_LIVE };
  let dur = 0; p.body.replace(/#EXTINF:([\d.]+)/gi, (_m, d) => { dur += Number(d) || 0; return ''; });
  return { url: p.url, dur };
}

function extFor(meta, type, url) {
  const pick = (s) => { const m = /\.(mkv|mp4|m4v|webm|mov|avi|ts)(?:$|[?#])/i.exec(String(s || '')); return m ? '.' + m[1].toLowerCase() : ''; };
  return pick(meta.fileName) || pick(url) || (/mp4/.test(type) ? '.mp4' : /webm/.test(type) ? '.webm' : '.mkv');
}

/** Start keeping a stream. Answers null when it is on its way, or the sentence why not. */
async function add(o) {
  const m = o && o.meta || {};
  if (!o || !/^https?:\/\//i.test(o.url || '') || !m.id || !m.type) return NO_KIND;
  if (/\.mpd(\?|#|$)/i.test(o.url)) return NO_KIND;
  const headers = Object.assign({ 'User-Agent': o.ua || 'NebulaPlayer' }, o.headers || {});
  const old = items.find((x) => x.viewer === (m.viewer || 'a') && x.type === m.type && x.id === m.id);
  if (old && old.state !== 'failed') return null;               // already saved or on its way
  if (old) remove(old.key);
  const s = await sniff(o.url, headers);
  if (s.refused) return s.refused;
  let kind = 'file', url = s.url || o.url, total = s.total || 0, dur = 0;
  if (s.hls) {
    let pl; try { pl = await playlist(url, headers); } catch (e) { return NO_REACH; }
    if (pl.refused) return pl.refused;
    kind = 'hls'; url = pl.url; dur = pl.dur;
  }
  if (free() - (kind === 'file' ? total : 0) < MARGIN) return NO_ROOM;
  const key = crypto.randomBytes(8).toString('hex');
  const it = {
    key, kind, url, headers, viewer: m.viewer || 'a', type: m.type, id: m.id, name: m.name || '', poster: m.poster || '',
    addonUrl: m.addonUrl || '', source: m.source || '', fileName: m.fileName || '', description: m.description || '',
    streamName: m.streamName || '', streamTitle: m.streamTitle || '',
    file: key + (kind === 'hls' ? '.mkv' : extFor(m, s.type || '', url)), state: 'queued', bytes: 0, total, dur, pct: -1, err: '', subs: [], at: Date.now(),
  };
  items.unshift(it); notify(true); pump();
  return null;
}

function pump() {
  if (!dir) return;
  for (const it of items) {
    if (running.size >= PARALLEL) break;
    if (it.state !== 'queued' || running.has(it.key)) continue;
    it.state = 'running'; it.err = '';
    (it.kind === 'hls' ? runHls : runFile)(it);
  }
  notify(true);
}
function finished(it, err) {
  running.delete(it.key);
  if (it.state === 'running') {
    if (err) { it.state = 'failed'; it.err = String(err.message || err).slice(0, 200); }
    else { it.state = 'done'; it.pct = 100; }
  }
  notify(true); pump();
}

function runFile(it) {
  const part = path.join(dir, it.file + '.part');
  let have = 0; try { have = fs.statSync(part).size; } catch (e) {}
  const h = Object.assign({}, it.headers, have > 0 ? { Range: 'bytes=' + have + '-' } : {});
  let out = null, res0 = null, stopped = false;
  const req = get(it.url, h, 0, (e, res) => {
    if (stopped) { if (res) res.destroy(); return; }
    if (e) return finished(it, e);
    res0 = res;
    if (res.statusCode === 200 && have > 0) have = 0;            // the host ignored the Range: start again
    else if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); return finished(it, new Error('HTTP ' + res.statusCode)); }
    if (!it.total) { const m = /\/(\d+)\s*$/.exec(String(res.headers['content-range'] || '')); it.total = m ? Number(m[1]) : Number(res.headers['content-length'] || 0) + have; }
    it.bytes = have;
    out = fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' });
    res.on('data', (c) => { it.bytes += c.length; if (it.total) it.pct = Math.min(99.9, it.bytes * 100 / it.total); notify(); });
    res.on('error', (er) => { out.end(); if (!stopped) finished(it, er); });
    out.on('error', (er) => { res.destroy(); if (!stopped) finished(it, er); });
    res.pipe(out);
    out.on('finish', () => {
      if (stopped) return;
      if (it.total && it.bytes < it.total) return finished(it, new Error('The connection dropped · ' + Math.round(it.bytes * 100 / it.total) + '% kept'));
      try { fs.renameSync(part, path.join(dir, it.file)); } catch (er) { return finished(it, er); }
      it.total = it.bytes; finished(it, null);
    });
  });
  running.set(it.key, { stop() { stopped = true; try { req.destroy(); } catch (e) {} try { if (res0) res0.destroy(); } catch (e) {} try { if (out) out.end(); } catch (e) {} running.delete(it.key); } });
}

function runHls(it) {
  const part = path.join(dir, it.key + '.part.mkv');
  const hdr = Object.keys(it.headers).map((k) => k + ': ' + it.headers[k] + '\r\n').join('');
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  if (hdr) args.push('-headers', hdr);
  args.push('-i', it.url, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-f', 'matroska', '-progress', 'pipe:1', part);
  let p, stopped = false, errText = '';
  try { p = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { return finished(it, e); }
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (c) => {
    const m = /out_time_(?:us|ms)=(\d+)/.exec(c); if (m && it.dur > 0) { it.pct = Math.min(99.9, Number(m[1]) / 1e6 * 100 / it.dur); }
    const s = /total_size=(\d+)/.exec(c); if (s) it.bytes = Number(s[1]);
    notify();
  });
  p.stderr.setEncoding('utf8'); p.stderr.on('data', (c) => { errText = (errText + c).slice(-300); });
  p.on('error', (e) => { if (!stopped) finished(it, e); });
  p.on('close', (code) => {
    if (stopped) return;
    if (code !== 0) return finished(it, new Error(errText.trim().split('\n').pop() || 'FFmpeg stopped (' + code + ')'));
    try { fs.renameSync(part, path.join(dir, it.file)); it.bytes = it.total = fs.statSync(path.join(dir, it.file)).size; } catch (er) { return finished(it, er); }
    finished(it, null);
  });
  running.set(it.key, { stop() { stopped = true; try { p.kill('SIGKILL'); } catch (e) {} running.delete(it.key); } });
}

function find(key) { return items.find((x) => x.key === key); }
function remove(key) {
  const it = find(key); if (!it) return;
  const r = running.get(key); if (r) r.stop();
  for (const f of [it.file, it.file + '.part', it.key + '.part.mkv']) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) {} }
  try { fs.rmSync(path.join(dir, it.key + '-subs'), { recursive: true, force: true }); } catch (e) {}
  items = items.filter((x) => x !== it); notify(true); pump();
}
/** pause | resume | retry | remove */
function cmd(key, c) {
  const it = find(key); if (!it) return false;
  if (c === 'remove') { remove(key); return true; }
  if (c === 'pause' && (it.state === 'running' || it.state === 'queued')) { const r = running.get(key); if (r) r.stop(); it.state = 'paused'; notify(true); pump(); return true; }
  if ((c === 'resume' || c === 'retry') && (it.state === 'paused' || it.state === 'failed')) { it.state = 'queued'; it.err = ''; pump(); return true; }
  return false;
}
/** A subtitle file kept beside the download (the player fetched it; the shell only writes it). */
function saveSub(key, lang, body) {
  const it = find(key); if (!it || typeof body !== 'string' || body.length > 5e6) return false;
  const sub = path.join(dir, it.key + '-subs'); try { fs.mkdirSync(sub, { recursive: true }); } catch (e) {}
  const i = (it.subs || []).length, ext = /^\uFEFF?\s*WEBVTT/.test(body) ? '.vtt' : '.srt';
  try { fs.writeFileSync(path.join(sub, 'sub-' + i + ext), body); } catch (e) { return false; }
  it.subs = (it.subs || []).concat([{ file: 'sub-' + i + ext, lang: String(lang || '').slice(0, 12) }]);
  notify(true); return true;
}

const MIME = { '.mkv': 'video/x-matroska', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.ts': 'video/mp2t', '.srt': 'text/plain; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8' };
/** /dl/<key>/video.<ext> and /dl/<key>/sub/<i>: a saved copy, with Range (both engines seek with it). A TV asks for a
    subtitle with its extension (sub/<i>.srt): its engine reads the kind of file from the address. */
function serve(req, res, pathname) {
  const m = /^\/dl\/([0-9a-f]{16})\/(?:video\.[a-z0-9]+|sub\/(\d+)(?:\.[a-z]{2,4})?)$/.exec(pathname);
  const it = m && find(m[1]);
  if (!it || it.state !== 'done') { res.statusCode = 404; res.end('not found'); return; }
  const f = m[2] != null ? (it.subs[Number(m[2])] && path.join(dir, it.key + '-subs', it.subs[Number(m[2])].file)) : path.join(dir, it.file);
  let st; try { st = fs.statSync(f); } catch (e) { res.statusCode = 404; res.end('gone'); return; }
  res.setHeader('Content-Type', MIME[path.extname(f).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Cache-Control', 'no-store');
  const r = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (r && (r[1] || r[2])) {
    let a = r[1] ? Number(r[1]) : st.size - Number(r[2]), b = r[1] && r[2] ? Math.min(Number(r[2]), st.size - 1) : st.size - 1;
    if (a < 0) a = 0;
    if (a >= st.size || a > b) { res.statusCode = 416; res.setHeader('Content-Range', 'bytes */' + st.size); res.end(); return; }
    res.statusCode = 206; res.setHeader('Content-Range', 'bytes ' + a + '-' + b + '/' + st.size); res.setHeader('Content-Length', b - a + 1);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(f, { start: a, end: b }).pipe(res); return;
  }
  res.setHeader('Content-Length', st.size);
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(f).pipe(res);
}

/** The TV's side of Downloads, on the sharing listener: the list of one viewer's finished copies and the files themselves.
    `ready()` makes sure the index is loaded (main.js sets Downloads up the first time anything asks). The listener has
    already checked the token and answers CORS; it stops with sharing, and takes every open file with it. */
function attach(relay, ready) {
  relay.route('/relay/dl/', (req, res, u) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    try { if (ready) ready(); } catch (e) {}
    if (u.pathname === '/relay/dl/list') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ v: 1, items: shared(u.searchParams.get('v')) })); return;
    }
    serve(req, res, u.pathname.slice('/relay'.length));
  });
  relay.health(() => ({ dl: { v: 1 } }));
}

module.exports = { setup, list, add, cmd, saveSub, serve, shared, fileOf, attach, _sniff: sniff, _playlist: playlist };
