'use strict';
// The full-format player's helper process, seen from the page's side (Node only, no DOM). helper/nebula-mpv.c runs libmpv in
// a plain process of its own — on Linux the page's process cannot host it: Electron's FFmpeg and libvulkan sit first in its
// symbol scope and libmpv's calls land in them, an ABI mismatch that aborts (measured 09-15) — draws each frame into shared
// memory this file maps, and serves mpv's JSON IPC. This file finds the libmpv that works here (probe), starts the helper,
// maps the frames, speaks the IPC and keeps a picture of mpv's state from its property changes. Each helper run is a
// session of its own: a crash takes that helper, never the window, and what it held goes with it; the next play starts
// another. mpv.js draws what is here; scripts/mpv-smoke.cjs drives this file on its own in the workflow.
const path = require('path'), fs = require('fs'), os = require('os'), net = require('net'), crypto = require('crypto'), cp = require('child_process');

const MAX_W = 1920, MAX_H = 1080, HDR = 64, WIN = process.platform === 'win32', FRAME = MAX_W * MAX_H * 4;
const OBSERVE = ['time-pos', 'duration', 'pause', 'paused-for-cache', 'seeking', 'eof-reached', 'idle-active', 'volume', 'mute', 'speed',
  'demuxer-cache-duration', 'dwidth', 'dheight', 'frame-drop-count', 'estimated-vf-fps', 'container-fps', 'video-bitrate', 'audio-bitrate',
  'aid', 'sid', 'audio-codec-name', 'video-codec', 'audio-params/channel-count', 'demuxer-via-network', 'track-list', 'sub-text', 'mpv-version'];
const LIB_DIRS = ['/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu', '/usr/lib64', '/usr/lib', '/lib64', '/usr/local/lib', '/usr/lib/aarch64-linux-gnu'];
// the helper's exits that say this computer cannot run it at all (helper/nebula-mpv.c): no libmpv loads (4), mpv will not be
// made (6) or start (7), or it is too old to draw in software (8). Anything else — a slow start, a crash — was one play's.
const FATAL = { 4: true, 6: true, 7: true, 8: true };

let koffi = null, mm = null;                            // the mapping calls: libc mmap, or kernel32 MapViewOfFile
let s = null;                                           // the helper session now running (see start)
let starting = null, probing = null, failed = '', good = '', ver = '', rid = 0, loadSeq = 0, onEvent = null;

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
function emit(e) { if (onEvent) { try { onEvent(e); } catch (x) {} } }
function on(cb) { onEvent = typeof cb === 'function' ? cb : null; }
function spawnHelper(args, stdin) {
  const env = Object.assign({}, process.env);
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
      if (!e) return ok();
      if (ss) { if (s === ss) s = null; drop(ss, true); }
      no(e);
    };
    const give = (m, fatal) => { const e = new Error(m); e.fatal = !!fatal; fin(e); };
    if (!helperFile() || !list.length) return give(whyNot(), true);
    sweep();
    ss = { p: null, dir: '', ipc: '', shmName: '', shm: null, sock: null, rbuf: '', pending: new Map(), props: {}, recent: [], subFiles: [],
      loaded: false, busy: false, ready: false, gone: false, dropped: false, quitting: false };
    const tag = process.pid + '-' + crypto.randomBytes(4).toString('hex');
    try {
      ss.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-mpv-' + process.pid + '-'));   // 0700: the socket and subtitle files are this user's
      if (WIN) { ss.ipc = '\\\\.\\pipe\\nebula-mpv-' + tag; ss.shmName = 'Local\\nebula-mpv-' + tag; }
      else { ss.ipc = path.join(ss.dir, 'ipc'); ss.shmName = fs.existsSync('/dev/shm') ? '/dev/shm/nebula-mpv-' + tag : path.join(ss.dir, 'frames'); }
    } catch (e) { return give('no temporary folder: ' + (e && e.message || e)); }
    let p;
    // stdin stays a pipe: the helper leaves when it closes — this page gone, even if its process is not (a reload)
    try { p = spawnHelper([ss.shmName, ss.ipc, String(MAX_W), String(MAX_H), String(process.pid), list.join('|')].concat(options()), 'pipe'); }
    catch (e) { if (ss.dir) { try { fs.rmSync(ss.dir, { recursive: true, force: true }); } catch (x) {} } return give(String(e && e.message || e)); }
    ss.p = p; s = ss;
    p.stdin.on('error', () => {});
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.stdout.on('data', (d) => {
      if (done || ss.ready) return;
      out += d;
      if (!/^READY /m.test(out)) return;                 // an ERROR line is followed by the exit, whose code says how final it is
      ss.ready = true;
      if (ss.dropped) return give('stopped');
      try { mapShm(ss); } catch (e) { return give('frames: ' + (e && e.message || e)); }
      connect(ss).then(() => { if (ss.dropped) give('stopped'); else fin(null); }, (e) => give('control: ' + (e && e.message || e)));
    });
    p.on('error', (e) => give(String(e && e.message || e)));
    p.on('close', (code, sig) => {
      ss.gone = true;
      const last = err.trim().split('\n').pop() || '';
      if (!done) {
        const m = /^ERROR\s*(.*)$/m.exec(out);
        return give((m ? m[1].trim() : 'the player helper stopped (' + (code != null ? 'exit ' + code : sig) + ')') + (last ? ' — ' + last : ''), !!FATAL[code]);
      }
      const inPlay = ss.loaded || ss.busy;
      if (s === ss) s = null;
      drop(ss, false);
      if (inPlay && !ss.quitting) emit({ type: 'end', reason: 'error', error: 'the player stopped unexpectedly', detail: last, loaded: ss.loaded });
    });
    timer = setTimeout(() => give('the player helper did not answer in 10 s'), 10000);
  });
  if (!done) starting = mine;
  return mine;
}
/** Everything one helper run holds, let go: its frames, its control line, its files — and the process, when asked. */
function drop(ss, kill) {
  if (ss.dropped) return;
  ss.dropped = true;
  if (kill && ss.p && !ss.gone) { try { ss.p.kill(); } catch (e) {} }
  if (ss.shm && mm) unmap(ss.shm);
  ss.shm = null;
  if (ss.sock) { try { ss.sock.destroy(); } catch (e) {} ss.sock = null; }
  ss.pending.forEach((q) => q.no(new Error('closed'))); ss.pending.clear();
  if (!WIN && /^\/dev\/shm\/nebula-mpv-/.test(ss.shmName)) { try { fs.unlinkSync(ss.shmName); } catch (e) {} }
  ss.subFiles = [];
  if (ss.dir) { try { fs.rmSync(ss.dir, { recursive: true, force: true }); } catch (e) {} }
}
/** What a Nebula that ended without cleaning up left behind (frame memory, a socket folder): removed when its process is gone. */
function sweep() {
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  const clear = (d, rm) => {
    try { fs.readdirSync(d).forEach((f) => { const m = /^nebula-mpv-(\d+)-/.exec(f); if (m && Number(m[1]) !== process.pid && !alive(Number(m[1]))) rm(path.join(d, f)); }); } catch (e) {}
  };
  if (!WIN) clear('/dev/shm', (f) => { try { fs.unlinkSync(f); } catch (e) {} });
  clear(os.tmpdir(), (f) => { try { fs.rmSync(f, { recursive: true, force: true }); } catch (e) {} });
}
function options() {
  const o = { hwdec: 'auto-copy-safe', 'keep-open': 'yes', 'msg-level': 'all=warn', 'input-default-bindings': 'no', 'input-vo-keyboard': 'no', 'osd-level': '0',
    ytdl: 'no', 'sub-auto': 'no', 'audio-file-auto': 'no', cache: 'yes', 'network-timeout': '20', 'audio-client-name': 'Nebula', sid: 'no', 'hr-seek': 'yes',
    'stream-lavf-o': 'reconnect=1,reconnect_streamed=1,reconnect_delay_max=5',
    // the software renderer's scaling is most of a frame's cost: bicubic + ordered dither draws 4K HEVC at 1080p in 42 ms on
    // an i3-3217U where the default lanczos + random dither took 53 (09-15); mpv.js draws smaller when even that is too slow
    'zimg-scaler': 'bicubic', 'zimg-dither': 'ordered' };
  if (process.env.NEBULA_MPV_AO) o.ao = process.env.NEBULA_MPV_AO;     // the rigs play in silence
  return Object.keys(o).map((k) => k + '=' + o[k]);
}
// The shared memory is copied, never wrapped: Electron's V8 sandbox aborts on an ArrayBuffer over memory it did not allocate
// (koffi.view — fine in plain Node, fatal here, 09-15). A new frame is one memcpy into a buffer V8 owns (~1 ms for 1366x768).
function mapShm(ss) {
  if (!koffi) koffi = require('koffi');
  const size = HDR + 2 * FRAME;
  let ptr = null;
  if (WIN) {
    if (!mm) {
      const k = koffi.load('kernel32.dll');
      mm = { open: k.func('void *OpenFileMappingW(uint32_t, int, const char16_t *)'), map: k.func('void *MapViewOfFile(void *, uint32_t, uint32_t, uint32_t, size_t)'),
        unmap: k.func('int UnmapViewOfFile(void *)'), close: k.func('int CloseHandle(void *)'),
        cin: k.func('void RtlMoveMemory(void *, uintptr_t, size_t)'), cout: k.func('void RtlMoveMemory(uintptr_t, void *, size_t)') };
    }
    const h = mm.open(0xF001F, 0, ss.shmName); if (!h) throw new Error('OpenFileMapping');
    ptr = mm.map(h, 0xF001F, 0, 0, size); mm.close(h);
    if (!ptr) throw new Error('MapViewOfFile');
  } else {
    if (!mm) {
      const c = koffi.load('libc.so.6');
      mm = { mmap: c.func('void *mmap(void *, size_t, int, int, int, long)'), munmap: c.func('int munmap(void *, size_t)'),
        cin: c.func('void *memcpy(void *, uintptr_t, size_t)'), cout: c.func('void *memcpy(uintptr_t, void *, size_t)') };
    }
    const fd = fs.openSync(ss.shmName, 'r+');
    try { ptr = mm.mmap(null, size, 3, 1, fd, 0); } finally { fs.closeSync(fd); }         // PROT_READ|PROT_WRITE, MAP_SHARED
    if (!ptr || koffi.address(ptr) === 0xFFFFFFFFFFFFFFFFn) throw new Error('mmap');
  }
  const head = new Uint8Array(HDR);
  const shm = { ptr, base: koffi.address(ptr), size, head, dv: new DataView(head.buffer), px: new Uint8Array(0), tmp: new Uint8Array(8) };
  mm.cin(shm.head, shm.base, HDR);
  if (shm.dv.getUint32(0, true) !== 0x564d504e) { unmap(shm); throw new Error('these are not the helper\'s frames'); }
  ss.shm = shm;
}
function unmap(m) { try { if (WIN) mm.unmap(m.ptr); else mm.munmap(m.ptr, m.size); } catch (e) {} }
function head() { mm.cin(s.shm.head, s.shm.base, HDR); return s.shm.dv; }
/** Frames drawn so far (the helper's counter). */
function count() { return (s && s.shm) ? Number(head().getBigUint64(48, true)) : -1; }
function connect(ss) {
  return new Promise((ok, no) => {
    let tries = 0;
    const go = () => {
      if (ss.dropped) return no(new Error('stopped'));
      const k = net.createConnection(ss.ipc);
      k.once('connect', () => {
        ss.sock = k; ss.rbuf = ''; k.setEncoding('utf8');
        k.on('data', (c) => onData(ss, c)); k.on('error', () => {}); k.on('close', () => { if (ss.sock === k) ss.sock = null; });
        OBSERVE.forEach((n, i) => send(ss, ['observe_property', i + 1, n]).catch(() => {}));
        send(ss, ['request_log_messages', 'warn']).catch(() => {});   // a host's "HTTP error 403" arrives as a warning
        ok();
      });
      k.once('error', (e) => { k.destroy(); if (++tries > 60) no(e); else setTimeout(go, 50); });
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
function event(ss, m) {
  if (m.event === 'property-change') {
    ss.props[m.name] = m.data;
    if (m.name === 'mpv-version' && m.data) ver = String(m.data).replace(/^mpv\s*/, '');
    if (ss === s && m.name === 'track-list' && ss.loaded) emit({ type: 'tracks', tracks: m.data || [] });
    return;
  }
  if (m.event === 'log-message') { const t = String(m.text || '').trim(); if (t) { ss.recent.push(t); if (ss.recent.length > 6) ss.recent.shift(); } return; }
  if (ss !== s) return;                                 // a helper on its way out says nothing more to the page
  if (m.event === 'start-file') { ss.recent = []; ss.busy = true; emit({ type: 'start' }); }
  else if (m.event === 'file-loaded') { ss.loaded = true; emit({ type: 'loaded', tracks: ss.props['track-list'] || [] }); }
  else if (m.event === 'end-file') {
    const was = ss.loaded; ss.loaded = false; ss.busy = false;
    // what the host said, when it said anything (an HTTP status first), else mpv's last word
    const detail = ss.recent.filter((t) => /HTTP error \d{3}|\b[45]\d\d\b/.test(t)).pop() || ss.recent[ss.recent.length - 1] || '';
    emit({ type: 'end', reason: m.reason || 'stop', error: m.file_error || '', detail, loaded: was });
  }
  else if (m.event === 'seek') emit({ type: 'seek' });
  else if (m.event === 'playback-restart') emit({ type: 'restart' });
  else if (m.event === 'video-reconfig') emit({ type: 'video', w: ss.props.dwidth || 0, h: ss.props.dheight || 0 });
}

// ---- what mpv.js asks
/** A property as mpv's own string form would give it (yes/no, numbers, JSON for lists); only observed ones are known. */
function get(k) {
  const v = s ? s.props[k] : undefined;
  if (v === undefined || v === null) return null;
  if (v === true) return 'yes'; if (v === false) return 'no';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}
function snapshot() {
  const P = s ? s.props : {}, num = (k) => (typeof P[k] === 'number' ? P[k] : null), flag = (k) => (typeof P[k] === 'boolean' ? P[k] : null);
  const dur = num('duration');
  return { t: num('time-pos'), dur, pause: flag('pause'), cache: flag('paused-for-cache'), seeking: flag('seeking'), eof: flag('eof-reached'), idle: flag('idle-active'),
    vol: num('volume'), mute: flag('mute'), speed: num('speed'), ahead: num('demuxer-cache-duration'), w: num('dwidth'), h: num('dheight'), drop: num('frame-drop-count'),
    vfps: num('estimated-vf-fps'), fps: num('container-fps'), vbr: num('video-bitrate'), abr: num('audio-bitrate'), aid: get('aid'), sid: get('sid'),
    acodec: P['audio-codec-name'] || null, vcodec: P['video-codec'] || null, ach: num('audio-params/channel-count'),
    live: !(dur > 0) && P['demuxer-via-network'] === true, drawMs: (s && s.shm) ? Math.round(head().getUint32(56, true) / 100) / 10 : 0 };
}
/** The newest finished frame when it is newer than `since`: copied out of the shared memory into a buffer reused from call to
    call (the bytes are only good until the next call), else null. */
function frame(since) {
  if (!s || !s.shm) return null;
  const shm = s.shm, dv = head(), n = Number(dv.getBigUint64(48, true));
  if (n === since) return null;
  const cur = dv.getUint32(24, true) & 1, w = dv.getUint32(32 + 4 * cur, true), h = dv.getUint32(40 + 4 * cur, true), len = w * h * 4;
  if (w < 2 || h < 2 || len > FRAME) return null;
  if (shm.px.length < len) shm.px = new Uint8Array(len);
  mm.cin(shm.px, shm.base + BigInt(HDR + cur * FRAME), len);
  return { count: n, view: shm.px.subarray(0, len), w, h, drawMs: dv.getUint32(56, true) / 1000 };
}
/** The size to draw at next (the canvas's, in device pixels, capped). */
function want(w, h) {
  if (!s || !s.shm) return;
  const shm = s.shm, dv = new DataView(shm.tmp.buffer);
  dv.setUint32(0, Math.max(2, Math.min(MAX_W, w | 0)), true); dv.setUint32(4, Math.max(2, Math.min(MAX_H, h | 0)), true);
  mm.cout(shm.base + 16n, shm.tmp, 8);
}
/** Play `url` (http(s) or a local path): o = { start, headers: {name: value}, ua, alang, slang, aheadSecs, maxBytes }. */
function load(url, o) {
  o = o || {};
  const my = ++loadSeq;
  if (s) s.loaded = false;
  const go = () => {
    if (my !== loadSeq) return;                         // stopped, or another file asked for, while the helper started
    if (!s || !s.sock) return emit({ type: 'end', reason: 'error', error: 'the player stopped', detail: '', loaded: false });
    s.busy = true;
    fire(['set', 'start', o.start > 0 ? String(o.start) : 'none']);
    fire(['set', 'user-agent', o.ua || 'Nebula']);
    fire(['change-list', 'http-header-fields', 'clr', '']);
    Object.keys(o.headers || {}).forEach((k) => {
      if (/^user-agent$/i.test(k)) fire(['set', 'user-agent', o.headers[k]]); else fire(['change-list', 'http-header-fields', 'append', k + ': ' + o.headers[k]]);
    });
    fire(['set', 'alang', o.alang || '']); fire(['set', 'slang', o.slang || '']); fire(['set', 'sid', 'no']); fire(['set', 'pause', 'no']);
    fire(['set', 'demuxer-readahead-secs', String(o.aheadSecs > 0 ? o.aheadSecs : 20)]);
    fire(['set', 'demuxer-max-bytes', (o.maxBytes > 0 ? o.maxBytes : 150) + 'MiB']);
    fire(['loadfile', String(url), 'replace']);
  };
  if (s && s.sock) { go(); return { ok: true }; }
  start().then(go, (e) => {
    const m = String(e && e.message || e);
    if (e && e.fatal) { failed = m; emit({ type: 'available', ok: false, error: m }); }   // this session plays through the app's own engine from now on
    if (my === loadSeq) emit({ type: 'end', reason: 'error', error: m, detail: '', loaded: false });
  });
  return { ok: true };
}
function command(args) { fire((args || []).map(String)); return 0; }
function set(name, value) { fire(['set', String(name), String(value)]); return 0; }
function stop() {
  loadSeq++;
  if (!s) return;
  s.loaded = false; s.busy = false;
  if (s.sock) fire(['stop']);
}
/** A subtitle the page fetched, written to a file here and added as a track (not shown until chosen): resolves to the track. */
async function subAdd(text, label, lang) {
  const ss = s;
  if (!ss || !ss.sock || !ss.dir) return null;
  const t = String(text || ''), ext = /^\s*WEBVTT/.test(t) ? '.vtt' : (/^\s*\[Script Info\]/i.test(t) ? '.ass' : '.srt');
  const file = path.join(ss.dir, 'sub-' + (ss.subFiles.length + 1) + ext);
  try { fs.writeFileSync(file, t); ss.subFiles.push(file); } catch (e) { return null; }
  try { await send(ss, ['sub-add', file, 'auto', String(label || ''), String(lang || '')]); } catch (e) { return null; }
  for (let i = 0; i < 40; i++) {                        // the new track reaches the track list a moment later
    const tr = (ss.props['track-list'] || []).filter((x) => x.type === 'sub' && x['external-filename'] === file)[0];
    if (tr) return { id: tr.id, lang: tr.lang || lang || '', title: tr.title || label || '' };
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}
/** The page is going away: mpv quits, the helper goes (it also leaves as its stdin closes; killed if it lingers), and
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

module.exports = { available, whyNot, libs, version, on, probe, start, load, command, set, get, stop, subAdd, frame, count, want, snapshot, dispose, MAX_W, MAX_H };
