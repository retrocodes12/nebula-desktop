'use strict';
// The full-format player's helper, driven from the main process. helper/nebula-mpv.c runs libmpv in a plain process of its
// own (in-process libmpv aborts on Linux: Electron's own FFmpeg interposes libmpv's, 09-15), draws each frame and serves it
// to the page over loopback HTTP (helper/frames.c: one fetch a frame, a fresh token for every helper — the page stays
// sandboxed), and runs mpv's JSON IPC, which this file speaks. Nothing the page sends reaches mpv unchecked: a load is an
// http(s) address or a file the user picked (granted here first), commands and properties come from short lists — mpv's
// own `run`, `subprocess`, `load-script` and every property that writes a file are out of reach. mpv-ipc.js wires this to
// the window; scripts/mpv-smoke.cjs drives it alone in CI. Each helper run is a session of its own: a crash takes that
// helper, never the window, and what it held goes with it; the next play starts another.
const path = require('path'), fs = require('fs'), os = require('os'), net = require('net'), crypto = require('crypto'), cp = require('child_process');
const { grant, target, clean, sweep } = require('./mpv-args');   // what the page may name, checked there (+ the temp folder's sweep)

const MAX_W = 1920, MAX_H = 1080, WIN = process.platform === 'win32';
const OBSERVE = ['time-pos', 'duration', 'pause', 'paused-for-cache', 'seeking', 'eof-reached', 'idle-active', 'volume', 'mute', 'speed',
  'demuxer-cache-duration', 'dwidth', 'dheight', 'frame-drop-count', 'estimated-vf-fps', 'container-fps', 'video-bitrate', 'audio-bitrate',
  'aid', 'sid', 'audio-codec-name', 'video-codec', 'audio-params/channel-count', 'demuxer-via-network', 'track-list', 'sub-text', 'mpv-version',
  'hwdec-current', 'video-params/gamma', 'video-params/primaries', 'seekable', 'file-size', 'demuxer-cache-idle', 'demuxer-cache-time'];
// a read the host never answers ends at mpv's network-timeout (10 s, the options below): this long without anything new
// while mpv's reader waits on the network is a stall about to end so — and anything that ends sooner was a close
const STALL_MS = 9000;
const GETTABLE = ['aid', 'sid', 'speed', 'volume', 'mute', 'pause', 'sub-text', 'idle-active', 'frame-drop-count', 'container-fps', 'estimated-vf-fps',
  'audio-codec-name', 'video-codec', 'hwdec-current', 'mpv-version', 'demuxer-cache-duration', 'video-params/gamma'];
const LIB_DIRS = ['/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu', '/usr/lib64', '/usr/lib', '/lib64', '/usr/local/lib', '/usr/lib/aarch64-linux-gnu'];
// the helper's exits that say this computer cannot run it at all (helper/nebula-mpv.c): no libmpv loads (4), mpv will not be
// made (6) or start (7), or it is too old to draw in software (8). Anything else — a slow start, a crash — was one play's.
const FATAL = { 4: true, 6: true, 7: true, 8: true };
// what the page may set, and the shape each value must have
const YESNO = /^(yes|no)$/, NUM = /^-?\d{1,7}(\.\d{1,6})?$/, TRACK = /^(\d{1,3}|no|auto)$/, COLOR = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;
const SETTABLE = { pause: YESNO, mute: YESNO, 'sub-bold': YESNO, volume: NUM, speed: NUM, 'sub-delay': NUM, 'sub-speed': NUM, 'sub-scale': NUM, 'sub-pos': NUM,
  'sub-border-size': NUM, 'sub-shadow-offset': NUM, aid: TRACK, sid: TRACK, 'sub-color': COLOR, 'sub-back-color': COLOR, 'sub-border-color': COLOR,
  'sub-shadow-color': COLOR, 'sub-font': /^(sans-serif|serif|monospace)$/, 'sub-border-style': /^(outline-and-shadow|opaque-box|background-box)$/,
  'cache-secs': /^\d{1,7}$/, 'demuxer-max-bytes': /^([1-9]\d{1,2}|10[0-2]\d)MiB$/ };
const SEEK_MODE = /^(absolute|relative)(\+exact|\+keyframes)?$/;

let s = null;                                           // the helper session now running (see start)
let starting = null, probing = null, failed = '', good = '', ver = '', rid = 0, loadSeq = 0, onEvent = null, origin = '';
let reapT = null;                                       // an idle helper leaves after a while (the next play starts another)
let gpu = null;                                         // mpv-gpu.js, when the window's side gave it (useGpu): frames drawn on the graphics chip

function exe() { return WIN ? 'nebula-mpv.exe' : 'nebula-mpv'; }
function helperFile() {
  const plat = WIN ? 'win' : process.platform;
  const c = [process.env.NEBULA_MPV_HELPER, process.resourcesPath && path.join(process.resourcesPath, 'mpv', exe()), path.join(__dirname, 'build', 'mpv', plat, exe())];
  for (const f of c) { try { if (f && fs.statSync(f).isFile()) return f; } catch (e) {} }
  return '';
}
/** The libmpv the helper tries, in order: the rigs' copy, the system's (a newer one first), then the one this app carries
    (beside the helper: resources/mpv in a build, build/mpv/<platform> in a checkout). */
function libs() {
  if (process.env.NEBULA_NO_MPV) return [];
  const h = helperFile(), out = [], res = h ? path.dirname(h) : '';
  if (process.env.NEBULA_MPV_LIB) out.push(process.env.NEBULA_MPV_LIB);
  if (WIN) { if (res) out.push(path.join(res, 'libmpv-2.dll')); }
  else { out.push('libmpv.so.2', 'libmpv.so.1'); if (res) out.push(path.join(res, 'libmpv.so.1')); }
  return out.filter((p) => !path.isAbsolute(p) || fs.existsSync(p));
}
function plausible(p) { return path.isAbsolute(p) ? fs.existsSync(p) : LIB_DIRS.some((d) => fs.existsSync(path.join(d, p))); }
function available() { return !failed && !!helperFile() && (!!good || libs().some(plausible)); }
function whyNot() {
  if (failed) return failed;
  if (!helperFile()) return 'the player helper is missing from this build';
  return 'no player library on this computer';
}
function version() { return ver; }
function frameBase() { return (s && s.port && s.sock) ? 'http://127.0.0.1:' + s.port + '/' + s.token + '/f' : ''; }
function info() { const ok = available(); return { available: ok, error: ok ? '' : whyNot(), lib: good || libs().join(' | '), version: ver, base: frameBase(), gpu: !!(s && s.gpu) }; }
const DEBUG = !!process.env.NEBULA_MPV_DEBUG;          // the rigs' trace: what mpv said and what went to the page
// a line saying the connection failed under the file (FFmpeg's http layer): a reconnect for anything but a plain close, a known
// length cut short, or (event()) any reconnect short of a size the host gave — https dropped unclosed says just "Input/output
// error" (GnuTLS, 09-15). NOT a plain close with no size: every close-delimited stream ends so, whole or not, and a retry may fail any way
const NET_ERR = /Will reconnect at \d+ in \d+ second\(s\), error=(?!Input\/output error|I\/O error)|ends prematurely at \d+, should be (?!18446744073709551615\b)\d+/i;
function emit(e) {
  if (DEBUG && e.type !== 'state') console.log('[mpv-host] emit ' + e.type + (e.reason ? ' ' + e.reason : '') + (e.error ? ' ' + e.error : ''));
  if (onEvent) { try { onEvent(e); } catch (x) {} }
}
function on(cb) { onEvent = typeof cb === 'function' ? cb : null; }
/** The page's origin: the frame server answers it (and only its fetches can read the frames). */
function setOrigin(o) { if (/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(String(o))) origin = o; }
function spawnHelper(args, stdin, more) {
  const env = Object.assign({}, process.env, more || {});
  delete env.LD_PRELOAD; delete env.LD_LIBRARY_PATH;                    // a plain process: the system's own libraries
  return cp.spawn(helperFile(), args, { env, stdio: [stdin, 'pipe', 'pipe'], windowsHide: true });
}

/** Which libmpv works here, asked once, in the background: each candidate in a helper of its own (two builds in one process
    would share their FFmpeg by name). Settings knows before the first play, and every play after starts that one. */
function probe() {
  if (probing) return probing;
  probing = (async () => {
    const list = libs().filter(plausible);
    if (failed || good || !helperFile() || !list.length) return available();
    let why = '', fatal = true;
    for (const lib of list) {
      const r = await probeOne(lib);
      if (r.code === 0) { good = lib; emit({ type: 'available', ok: true, error: '' }); return true; }
      if (!FATAL[r.code]) fatal = false;                // a probe that timed out or crashed proves nothing
      why = r.why || why;
    }
    if (fatal) { failed = why || 'no player library could be loaded'; emit({ type: 'available', ok: false, error: failed }); }
    return available();
  })();
  return probing;
}
function probeOne(lib) {
  return new Promise((done) => {
    let out = '', p = null, t = null, over = false;
    const fin = (code) => { if (over) return; over = true; clearTimeout(t); const m = /^ERROR\s*(.*)$/m.exec(out); done({ code, why: m ? m[1].trim() : '' }); };
    try { p = spawnHelper(['--probe', lib], 'ignore'); } catch (e) { return fin(-1); }
    t = setTimeout(() => { try { p.kill(); } catch (e) {} }, 20000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', () => {});
    p.on('error', () => fin(-1));
    p.on('close', (code) => fin(code === 0 && /^OK /m.test(out) ? 0 : (code == null ? -1 : code)));
  });
}

/** The helper, started once and kept for every play after (a new one after a crash). Resolves once mpv answers. */
function start() {
  if (s && s.sock) return Promise.resolve();
  if (starting) return starting;
  if (s) { drop(s, true); s = null; }                   // a helper whose control line went: gone, or going
  let mine = null, done = false, timer = null;
  mine = new Promise((ok, no) => {
    const list = good ? [good] : libs().filter(plausible);
    let ss = null, out = '', err = '';
    const fin = (e) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (starting === mine) starting = null;
      if (!e) { emit({ type: 'up', base: frameBase(), gpu: !!ss.gpu }); return ok(); }
      if (ss) { if (s === ss) s = null; drop(ss, true); }
      no(e);
    };
    const give = (m, fatal) => { const e = new Error(m); e.fatal = !!fatal; fin(e); };
    if (!helperFile() || !list.length) return give(whyNot(), true);
    sweep();
    ss = { p: null, dir: '', ipc: '', port: 0, token: crypto.randomBytes(16).toString('hex'), sock: null, rbuf: '', pending: new Map(), props: {},
      recent: [], subFiles: [], headEnd: -1, headAt: 0, starve: null, loaded: false, busy: false, ready: false, gone: false, dropped: false, quitting: false, expect: null, cur: null,
      waiting: false, queue: [] };
    try {
      ss.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-mpv-' + process.pid + '-'));   // 0700: the socket and subtitle files are this user's
      ss.ipc = WIN ? '\\\\.\\pipe\\nebula-mpv-' + process.pid + '-' + crypto.randomBytes(8).toString('hex') : path.join(ss.dir, 'ipc');
    } catch (e) { return give('no temporary folder: ' + (e && e.message || e)); }
    let p;
    // stdin stays a pipe: the helper leaves as it closes. The token goes in the environment ('-' in its place): a command
    // line can be read by any user on the machine
    try { p = spawnHelper([ss.ipc, String(MAX_W), String(MAX_H), String(process.pid), '-', origin || 'null', list.join('|')].concat(options()), 'pipe', { NEBULA_MPV_TOKEN: ss.token, NEBULA_MPV_GPU: (ss.asked = !!(gpu && gpu.want())) ? '1' : '0' }); }
    catch (e) { try { fs.rmSync(ss.dir, { recursive: true, force: true }); } catch (x) {} return give(String(e && e.message || e)); }
    ss.p = p; s = ss;
    p.stdin.on('error', () => {});
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    // drawn on the graphics chip, the picture did not reach the window — or that helper never got as far as drawing: it
    // goes and a software one takes its place (once: gpu.broke() has been called, so the next is not asked for the chip)
    const chip = () => !!gpu && (ss.ready ? !!ss.gpu : !!ss.asked);
    const late = (msg) => { if (!done && chip() && gpu.want()) { gpu.broke('the player did not start drawing on the graphics chip in time', false); again(); } else give(msg); };
    const again = () => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (starting === mine) starting = null;
      if (s === ss) s = null;
      ss.quitting = true; drop(ss, true);
      start().then(ok, no);
    };
    p.stdout.on('data', (d) => {
      out += d;
      if (!ss.ready) {
        const m = /^READY (\d+)( gpu)?\r?\n/m.exec(out);
        if (done || !m) return;                          // an ERROR line is followed by the exit, whose code says how final it is
        ss.ready = true; ss.port = Number(m[1]); ss.gpu = !!m[2] && !!gpu && !!ss.asked;
        if (ss.dropped) return give('stopped');
        if (ss.gpu) { gpu.open(ss); clearTimeout(timer); timer = setTimeout(() => late('the player helper did not answer in 20 s'), 20000); }
        connect(ss).then(() => (ss.gpu ? gpu.check(ss) : true)).then((fine) => { if (ss.dropped) give('stopped'); else if (fine) fin(null); else again(); },
          (e) => give('control: ' + (e && e.message || e)));
      }
      if (!ss.gpu) { if (ss.ready) out = ''; return; }
      let i;                                             // its buffers and frames, a line each (mpv-gpu.js)
      while ((i = out.indexOf('\n')) >= 0) { const l = out.slice(0, i); out = out.slice(i + 1); if (ss.g && !/^READY/.test(l)) gpu.line(ss, l); }
      if (out.length > 4096) out = '';                   // (no line of its is this long)
    });
    p.on('error', (e) => give(String(e && e.message || e)));
    p.on('close', (code, sig) => {
      ss.gone = true;
      const last = err.trim().split('\n').pop() || '';
      // a helper that died by itself while drawing on the graphics chip, or on its way there (a driver can do that): software
      // from now on, remembered — and one that ended before it was up, asked for the chip, gets a software one in its place
      const own = !ss.quitting && !ss.killed;
      if (own && chip() && /^SIG(SEGV|ABRT|BUS|ILL|FPE)$/.test(String(sig))) gpu.crashed('the player stopped while drawing on the graphics chip');
      else if (own && chip() && code === 9) gpu.broke('the graphics chip stopped giving buffers', false);
      if (!done) {
        if (own && chip() && !FATAL[code]) { gpu.broke('the player would not start drawing on the graphics chip', false); return again(); }
        const m = /^ERROR\s*(.*)$/m.exec(out);
        return give((m ? m[1].trim() : 'the player helper stopped (' + (code != null ? 'exit ' + code : sig) + ')') + (last ? ' — ' + last : ''), !!FATAL[code]);
      }
      const inPlay = ss.loaded || ss.busy, current = s === ss;
      if (current) s = null;
      drop(ss, false);
      // a helper already replaced says nothing about the play now on
      if (current && inPlay && !ss.quitting) emit({ type: 'end', reason: 'error', error: 'the player stopped unexpectedly', detail: last, loaded: ss.loaded });
    });
    timer = setTimeout(() => late('the player helper did not answer in 10 s'), 10000);
  });
  if (!done) starting = mine;
  return mine;
}
/** A helper asked to leave — and made to, if it is stuck (inside a graphics driver, say). */
function end(ss) {
  if (!ss || !ss.p || ss.gone) return;
  ss.killed = true;
  try { ss.p.kill(); } catch (e) {}
  const t = setTimeout(() => { if (!ss.gone) { try { ss.p.kill('SIGKILL'); } catch (e) {} } }, 1500);
  if (t.unref) t.unref();
}
/** Everything one helper run holds, let go: its control line and its files — and the process, when asked. */
function drop(ss, kill) {
  if (ss.dropped) return;
  ss.dropped = true;
  if (kill) end(ss);
  if (ss.g && gpu) gpu.close(ss);
  if (ss.sock) { try { ss.sock.destroy(); } catch (e) {} ss.sock = null; }
  ss.pending.forEach((q) => q.no(new Error('closed'))); ss.pending.clear();
  ss.subFiles = [];
  if (ss.dir) { try { fs.rmSync(ss.dir, { recursive: true, force: true }); } catch (e) {} }
}
function options() {
  // (sw: / gpu: — set only when the helper draws in software / on the graphics chip: helper/nebula-mpv.c)
  const o = { 'sw:hwdec': 'auto-copy-safe', 'gpu:hwdec': 'auto-safe', 'keep-open': 'yes', 'msg-level': 'all=warn', 'input-default-bindings': 'no', 'input-vo-keyboard': 'no', 'osd-level': '0',
    config: 'no', 'load-scripts': 'no', osc: 'no', ytdl: 'no', 'sub-auto': 'no', 'audio-file-auto': 'no', cache: 'auto', 'network-timeout': '10',
    'audio-client-name': 'Nebula', sid: 'no', 'hr-seek': 'yes',
    // a dropped connection is picked up again inside FFmpeg for a moment (retries at 0 and 1 s); past that the page
    // reconnects from where it was (mpvState), and a dead address fails fast enough for the built-in engine to try it
    // (not reconnect_streamed: a stream that cannot seek would be fetched again from its first byte — a no-length TS then plays
    // again at its end, a drop splices the start in; mpv's own default. The page reconnects a live one at its edge, 09-15)
    'stream-lavf-o': 'reconnect=1,reconnect_on_network_error=1,reconnect_delay_max=2',
    // the software renderer's scaling is most of a frame's cost: bicubic + ordered dither draws 4K HEVC at 1080p in 42 ms on
    // an i3-3217U where mpv's default lanczos + random dither took 53 (09-15); the page draws smaller when even that is too slow
    'sw:zimg-scaler': 'bicubic', 'sw:zimg-dither': 'ordered',
    // every frame is labelled SDR BT.709 on its way to the renderer, so no libmpv version converts HDR or wide colour on the
    // CPU (mpv 0.34 would not at all: PQ came out flat, 09-15); the page's shader tone-maps from the file's own values
    // (drawn on the graphics chip, mpv's own renderer converts HDR there: no relabelling, and the page's shader stays out)
    'sw:vf': 'format=gamma=bt.1886:primaries=bt.709' };
  if (process.env.NEBULA_MPV_AO) o.ao = process.env.NEBULA_MPV_AO;     // the rigs play in silence
  return Object.keys(o).map((k) => k + '=' + o[k]);
}
function connect(ss) {
  return new Promise((ok, no) => {
    let tries = 0;
    const go = () => {
      if (ss.dropped) return no(new Error('stopped'));
      const k = net.createConnection(ss.ipc);
      const retry = (e) => { k.destroy(); if (++tries > 60) no(e); else setTimeout(go, 50); };
      k.once('error', retry);
      k.once('connect', () => {
        k.removeListener('error', retry);
        ss.sock = k; ss.rbuf = ''; k.setEncoding('utf8');
        k.on('data', (c) => onData(ss, c)); k.on('error', () => {}); k.on('close', () => { if (ss.sock === k) ss.sock = null; });
        OBSERVE.forEach((n, i) => send(ss, ['observe_property', i + 1, n]).catch(() => {}));
        send(ss, ['request_log_messages', 'warn']).catch(() => {});   // a host's "HTTP error 403" arrives as a warning
        ok();
      });
    };
    go();
  });
}
function send(ss, args) {
  return new Promise((ok, no) => {
    if (!ss || !ss.sock) return no(new Error('not connected'));
    const id = ++rid;
    const t = setTimeout(() => { if (ss.pending.delete(id)) no(new Error('no answer')); }, 15000);
    ss.pending.set(id, { ok: (d) => { clearTimeout(t); ok(d); }, no: (e) => { clearTimeout(t); no(e); } });
    ss.sock.write(JSON.stringify({ command: args, request_id: id }) + '\n');
  });
}
function fire(args) { send(s, args.map((x) => (typeof x === 'number' ? x : String(x)))).catch(() => {}); }
function onData(ss, chunk) {
  ss.rbuf += chunk;
  let i;
  while ((i = ss.rbuf.indexOf('\n')) >= 0) {
    const line = ss.rbuf.slice(0, i); ss.rbuf = ss.rbuf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch (e) { continue; }
    if (m.request_id && ss.pending.has(m.request_id)) { const q = ss.pending.get(m.request_id); ss.pending.delete(m.request_id); if (m.error === 'success') q.ok(m.data); else q.no(new Error(m.error)); continue; }
    if (m.event) event(ss, m);
  }
}
/** A stalled download (a host that stopped sending, the connection left open): mpv's reader waiting on the network
    (demuxer-cache-idle: no) while nothing new is demuxed (demuxer-cache-time — the last packet read in, which the playhead
    cannot move) for STALL_MS marks where the play's download stood (snapshot().neterr, in the play's own clock); that read
    then ends in mpv's network timeout, which mpv takes for an end of file. A stream that closes before that — at once, or a
    host that holds its close a few seconds — has ended. Half a second's film read in again clears it. */
function starveCheck(ss) {
  const P = ss.props, t = P['time-pos'], got = P['demuxer-cache-time'];
  if (typeof t !== 'number' || typeof got !== 'number') return;
  const now = Date.now(), idle = P['demuxer-cache-idle'] === true;
  // a failed connection FFmpeg picked up again by itself (reconnect on a seekable host): once the download has moved on by a
  // second of film — judged from 2 s after the failure, when what had already arrived is read in — it was no failure (round 13)
  if (ss.neterr != null && ss.netAt && now - ss.netAt >= 2000) {
    if (ss.netGot == null) ss.netGot = got;
    else if (!idle && got > ss.netGot + 1) { ss.neterr = null; ss.netGot = null; ss.netAt = 0; }
  }
  if (got > ss.headEnd + 0.01) {
    ss.headEnd = got;
    // (once marked, only half a second's film read in again clears it: at the end of file mpv counts the last packet — seen 09-15)
    if (ss.starve == null) ss.headAt = now;
    else if (!idle && got > ss.starveGot + 0.5) { ss.starve = null; ss.headAt = now; }
  }
  if (idle !== ss.idle) { if (!idle) ss.headAt = now; ss.idle = idle; }          // (a reader that starts reading gets its own wait)
  else if (!idle && ss.headAt && now - ss.headAt >= STALL_MS && ss.starve == null) {
    ss.starve = t + (typeof P['demuxer-cache-duration'] === 'number' ? P['demuxer-cache-duration'] : 0); ss.starveGot = ss.headEnd;
  }
}
/** This load's file is the one mpv is on: its entry id answered loadfile ('any' for an mpv that does not number them). */
function ours(ss) { return ss.expect != null && ss.expect !== 'next' && (ss.cur === ss.expect || ss.cur === 'any'); }
function event(ss, m) {
  if (m.event === 'property-change') {
    ss.props[m.name] = m.data;
    if (m.name === 'mpv-version' && m.data) ver = String(m.data).replace(/^mpv\s*/, '');
    if (ss === s && m.name === 'track-list' && ss.loaded) emit({ type: 'tracks', tracks: m.data || [] });
    return;
  }
  if (m.event === 'log-message') {
    const t = String(m.text || '').trim();
    if (DEBUG && t) console.log('[mpv-host] log ' + (m.prefix || '') + ': ' + t);
    if (t) { ss.recent.push(t); if (ss.recent.length > 6) ss.recent.shift(); }
    // where the download stood when the connection failed (film seconds): an end of file there is a lost connection, not the
    // film's end — even where mpv's length is only its estimate of what it has read (snapshot().neterr)
    const P = ss.props, r = /Will reconnect at (\d+) in \d+ second\(s\), error=/i.exec(t);
    if ((NET_ERR.test(t) || (r && P['file-size'] > 0 && +r[1] < P['file-size'])) && typeof P['time-pos'] === 'number') {
      ss.neterr = P['time-pos'] + (typeof P['demuxer-cache-duration'] === 'number' ? P['demuxer-cache-duration'] : 0); ss.netAt = Date.now(); ss.netGot = null;
    }
    if (ss === s && /Cannot seek/i.test(t)) emit({ type: 'seekfail' });   // (mpv refused a seek: no restart will come for it)
    return;
  }
  if (DEBUG) console.log('[mpv-host] mpv ' + m.event + ' entry ' + m.playlist_entry_id + ' expect ' + ss.expect + ' cur ' + ss.cur + (ss === s ? '' : ' (an old helper)'));
  if (ss !== s) return;                                 // a helper on its way out says nothing more to the page
  // loadfile's answer names the new file's entry, and a fresh mpv can send the file's first events before it (seen 09-15):
  // those wait for the answer — a file that fails at once would otherwise end unheard and the page wait out its 45 s
  if (ss.waiting && /^(start-file|file-loaded|end-file|seek|playback-restart|video-reconfig)$/.test(m.event)) { ss.queue.push(m); return; }
  if (m.event === 'start-file') {
    ss.cur = m.playlist_entry_id != null ? m.playlist_entry_id : 'any';
    if (ss.expect === 'next') ss.expect = ss.cur;
    if (!ours(ss)) return;                              // a file an earlier load asked for, already replaced
    ss.recent = []; ss.neterr = null; ss.netAt = 0; ss.headEnd = -1; ss.headAt = 0; ss.starve = null; ss.idle = undefined; ss.busy = true; emit({ type: 'start' });
    if (ss.oldSubs && ss.oldSubs.length) { ss.oldSubs.forEach((f) => fs.unlink(f, () => {})); ss.oldSubs = []; }   // mpv has let them go
  } else if (m.event === 'file-loaded') {
    if (!ours(ss)) return;
    ss.loaded = true; emit({ type: 'loaded', tracks: ss.props['track-list'] || [], version: ver });
  } else if (m.event === 'end-file') {
    if (ss.expect == null || ss.expect === 'next' || (m.playlist_entry_id != null && m.playlist_entry_id !== ss.expect)) return;   // replaced or stopped: not news
    if (m.reason === 'redirect') { ss.expect = 'next'; return; }   // a playlist link: mpv goes on to the entry it named
    const was = ss.loaded; ss.loaded = false; ss.busy = false;
    // what the host said, when it said anything (an HTTP status first), else mpv's last word
    const detail = ss.recent.filter((t) => /HTTP error \d{3}|\b[45]\d\d\b/.test(t)).pop() || ss.recent[ss.recent.length - 1] || '';
    emit({ type: 'end', reason: m.reason || 'stop', error: m.file_error || '', detail, loaded: was });
  } else if (!ours(ss)) return;
  else if (m.event === 'seek') { ss.headEnd = -1; ss.headAt = Date.now(); ss.starve = null; emit({ type: 'seek' }); }   // (the download starts again from there)
  else if (m.event === 'playback-restart') emit({ type: 'restart' });
  else if (m.event === 'video-reconfig') emit({ type: 'video', w: ss.props.dwidth || 0, h: ss.props.dheight || 0 });
}

// ---- what the window asks (mpv-ipc.js) — every value checked here
/** A property as mpv's own string form would give it (yes/no, numbers, JSON for lists); only observed ones are known. */
function get(k) {
  const v = s ? s.props[k] : undefined;
  if (v === undefined || v === null) return null;
  if (v === true) return 'yes';
  if (v === false) return 'no';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}
function snapshot() {
  if (s) starveCheck(s);
  const P = s ? s.props : {}, num = (k) => (typeof P[k] === 'number' ? P[k] : null), flag = (k) => (typeof P[k] === 'boolean' ? P[k] : null);
  const dur = num('duration'), p = {};
  GETTABLE.forEach((k) => { p[k] = get(k); });
  return { t: num('time-pos'), dur, pause: flag('pause'), cache: flag('paused-for-cache'), seeking: flag('seeking'), eof: flag('eof-reached'), idle: flag('idle-active'),
    vol: num('volume'), mute: flag('mute'), speed: num('speed'), ahead: num('demuxer-cache-duration'), w: num('dwidth'), h: num('dheight'), drop: num('frame-drop-count'),
    vfps: num('estimated-vf-fps'), fps: num('container-fps'), vbr: num('video-bitrate'), abr: num('audio-bitrate'), aid: get('aid'), sid: get('sid'),
    acodec: P['audio-codec-name'] || null, vcodec: P['video-codec'] || null, ach: num('audio-params/channel-count'), gamma: P['video-params/gamma'] || null,
    prim: P['video-params/primaries'] || null,
    hw: P['hwdec-current'] || null, gpu: !!(s && s.gpu), live: !(dur > 0) && P['demuxer-via-network'] === true,
    neterr: s && typeof (s.neterr != null ? s.neterr : s.starve) === 'number' ? Math.round((s.neterr != null ? s.neterr : s.starve) * 10) / 10 : null, seekable: flag('seekable'), fsize: num('file-size'),
    ridle: flag('demuxer-cache-idle'), got: num('demuxer-cache-time'), p };   // (ridle: mpv's reader has stopped; got: the last packet it read in)
}
/** A film is on and moving (the display is kept awake for it). */
function playing() { return !!(s && s.loaded && s.props.pause === false && s.props['idle-active'] !== true); }
/** Play `url` (http(s), or 'local:<id>' from grant()): o = { start, headers, ua, alang, slang, aheadSecs, maxBytes, aid, speed,
    volume, mute, pause, again }. A new file starts on its own terms — the preferred language's track, 1×, playing — unless o
    carries the last file's (a reconnect, again: true — its track, its speed, a pause the viewer asked for, its subtitle files). */
function load(url, o) {
  clearTimeout(reapT);
  const my = ++loadSeq, file = target(url), opts = clean(o && typeof o === 'object' ? o : {});
  if (s) { s.loaded = false; s.expect = null; }
  if (!file) { setImmediate(() => { if (my === loadSeq) emit({ type: 'end', reason: 'error', error: 'this address cannot be played here', detail: '', loaded: false }); }); return { ok: false }; }
  const go = () => {
    if (my !== loadSeq) return;                         // stopped, or another file asked for, while the helper started
    if (!s || !s.sock) return emit({ type: 'end', reason: 'error', error: 'the player stopped', detail: '', loaded: false });
    const ss = s;
    ss.busy = true; ss.expect = null; ss.cur = null; ss.waiting = true; ss.queue = []; ss.neterr = null; ss.netAt = 0;
    // another film: the last one's subtitle files go once mpv has let them go (at this file's start); a reconnect keeps them
    if (!opts.again) { ss.oldSubs = (ss.oldSubs || []).concat(ss.subFiles); ss.subFiles = []; }
    fire(['set', 'start', opts.start > 0 ? String(opts.start) : 'none']);
    fire(['set', 'user-agent', opts.ua]);
    fire(['change-list', 'http-header-fields', 'clr', '']);
    opts.headers.forEach(([k, v]) => { if (/^user-agent$/i.test(k)) fire(['set', 'user-agent', v]); else fire(['change-list', 'http-header-fields', 'append', k + ': ' + v]); });
    fire(['set', 'alang', opts.alang]); fire(['set', 'slang', opts.slang]); fire(['set', 'aid', opts.aid]); fire(['set', 'sid', 'no']);
    fire(['set', 'speed', opts.speed]); fire(['set', 'volume', String(opts.volume)]); fire(['set', 'mute', opts.mute ? 'yes' : 'no']); fire(['set', 'pause', opts.pause ? 'yes' : 'no']);
    fire(['set', 'cache-secs', String(opts.aheadSecs > 0 ? opts.aheadSecs : 3600000)]);   // Buffer ahead, or mpv's own (practically unbounded)
    fire(['set', 'demuxer-max-bytes', opts.maxBytes + 'MiB']);
    send(ss, ['loadfile', file, 'replace']).then((d) => {
      if (DEBUG) console.log('[mpv-host] loadfile answered ' + JSON.stringify(d) + ' load ' + my + '/' + loadSeq + (s === ss ? '' : ' (helper replaced)'));
      if (my !== loadSeq || s !== ss) return;
      ss.expect = d && d.playlist_entry_id != null ? d.playlist_entry_id : 'next';
      ss.waiting = false;
      const q = ss.queue; ss.queue = [];
      q.forEach((x) => event(ss, x));
    }, (e) => {
      if (my !== loadSeq || s !== ss) return;
      ss.waiting = false; ss.queue = [];
      emit({ type: 'end', reason: 'error', error: String(e && e.message || e), detail: '', loaded: false });
    });
  };
  if (s && s.sock) { go(); return { ok: true }; }
  start().then(go, (e) => {
    const m = String(e && e.message || e);
    if (e && e.fatal) { failed = m; emit({ type: 'available', ok: false, error: m }); }   // this session plays through the app's own engine from now on
    if (my === loadSeq) emit({ type: 'end', reason: 'error', error: m, detail: '', loaded: false });
  });
  return { ok: true };
}
/** Only a seek: a position, absolute or relative. */
function command(args) {
  if (!Array.isArray(args) || args[0] !== 'seek' || !NUM.test(String(args[1])) || !SEEK_MODE.test(String(args[2] || 'relative'))) return 0;
  fire(['seek', String(args[1]), String(args[2] || 'relative')]);
  return 0;
}
/** Only the properties in SETTABLE, each in its own shape. */
function set(name, value) {
  const v = String(value);
  if (!Object.prototype.hasOwnProperty.call(SETTABLE, name) || v.length > 64 || !SETTABLE[name].test(v)) return 0;
  fire(['set', name, v]);
  return 0;
}
function stop() {
  loadSeq++;
  if (!s) return;
  s.loaded = false; s.busy = false; s.expect = null; s.waiting = false; s.queue = [];
  if (s.sock) fire(['stop']);
  // nothing played for three minutes: the helper goes (its frame buffers, its wakeups); the next play starts another
  clearTimeout(reapT);
  reapT = setTimeout(() => { if (s && !s.busy && !s.loaded && !starting) dispose(); }, 180000);
  if (reapT.unref) reapT.unref();
}
/** A subtitle the page fetched, written to a file in this helper's folder and added as a track (not shown until chosen). */
async function subAdd(text, label, lang) {
  const ss = s, t = String(text || '');
  if (!ss || !ss.sock || !ss.dir || t.length > 8e6) return null;
  const lab = String(label || '').replace(/[\r\n\0]/g, ' ').slice(0, 100), lg = /^[A-Za-z-]{0,12}$/.test(String(lang || '')) ? String(lang || '') : '';
  const ext = /^\s*WEBVTT/.test(t) ? '.vtt' : (/^\s*\[Script Info\]/i.test(t) ? '.ass' : '.srt');
  // one file per text: a reconnect adding this film's subtitles again writes nothing new
  const file = path.join(ss.dir, 'sub-' + crypto.createHash('sha1').update(t).digest('hex').slice(0, 16) + ext);
  const known = (ss.props['track-list'] || []).filter((x) => x.type === 'sub' && x['external-filename'] === file).map((x) => x.id);
  if (known.length) {                                   // this text is already a track of this file: that one, not a second copy
    const tr = (ss.props['track-list'] || []).filter((x) => x.type === 'sub' && x.id === Math.max(...known))[0];
    if (tr) return { id: tr.id, lang: tr.lang || lg, title: tr.title || lab };
  }
  ss.oldSubs = (ss.oldSubs || []).filter((f) => f !== file);
  if (!ss.subFiles.includes(file)) { try { fs.writeFileSync(file, t); ss.subFiles.push(file); } catch (e) { return null; } }
  try { await send(ss, ['sub-add', file, 'auto', lab, lg]); } catch (e) { return null; }
  for (let i = 0; i < 40; i++) {                        // the new track reaches the track list a moment later
    const tr = (ss.props['track-list'] || []).filter((x) => x.type === 'sub' && x['external-filename'] === file && !known.includes(x.id)).pop();
    if (tr) return { id: tr.id, lang: tr.lang || lg, title: tr.title || lab };
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}
/** The window is going away: mpv quits, the helper goes (it also leaves as its stdin closes; killed if it lingers), and
    everything it held is removed. */
function dispose() {
  loadSeq++; starting = null;
  const ss = s; s = null;
  if (!ss) return;
  ss.quitting = true;
  if (ss.sock) { try { ss.sock.end(JSON.stringify({ command: ['quit'] }) + '\n'); } catch (e) {} ss.sock = null; }
  try { if (ss.p && ss.p.stdin) ss.p.stdin.end(); } catch (e) {}
  const p = ss.p;
  if (p && !ss.gone) { const t = setTimeout(() => { if (!ss.gone) { try { p.kill('SIGKILL'); } catch (e) {} } }, 1500); if (t.unref) t.unref(); }
  drop(ss, false);
}

/** The picture on the graphics chip (mpv-gpu.js, from the window's side). lost: the window stopped taking its frames — that
    helper goes, the page reconnects, and the next helper draws in software. view: the size shown, and whether anyone looks. */
function useGpu(g) { gpu = g || null; if (gpu) gpu.use({ lost: end }); }
function view(w, h, look) { if (gpu && s && s.gpu) gpu.view(s, w, h, look); }

module.exports = { available, whyNot, libs, version, info, on, setOrigin, probe, start, load, command, set, get, stop, subAdd, grant, snapshot, playing,
  frameBase, dispose, useGpu, view, MAX_W, MAX_H };
