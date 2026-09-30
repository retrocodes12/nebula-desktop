'use strict';
// The full-format player's picture on the graphics chip (Linux, main process). The helper draws each frame with the GPU
// into a dmabuf (helper/gpu.c) and says so on its stdout; this takes its own copy of each buffer's descriptor
// (helper/takefd.c — pidfd_getfd, the helper being this process's child), imports the frame as a shared texture and hands
// it to the window, whose preload draws it (preload.js). No pixel is copied through a process on the way: measured on an
// i3-3217U (09-30), 0.4 ms to import and ~3 ms to hand over, a fifth of a core for a 24 fps film where the software
// renderer's frames (loopback HTTP, then a WebGL upload) took more than a core — and mpv decodes on the chip too (VA-API)
// where the chip knows the format.
//
// Nothing is trusted before it is seen to work: at each helper's start the window must read a known colour back from a
// buffer (check); a computer where that fails plays in software for the session, one whose window shows the WRONG colour
// or whose helper dies twice while drawing this way (a graphics driver can take a process down — so can a broken film,
// hence twice) plays in software until the app's version changes (the memo). The helper reads films from anywhere, so
// what it says about its buffers is checked before Chromium's graphics process sees any of it (line).
// mpv-host.js calls in through the object it is given (use); mpv-ipc.js binds the window.
const path = require('path'), fs = require('fs');
let electron = null;
try { electron = require('electron'); } catch (e) { electron = null; }
const st = electron && electron.sharedTexture;

const TEST = [18, 52, 86];                              // the colour helper/nebula-mpv.c paints for the check
const DEBUG = !!process.env.NEBULA_MPV_DEBUG;
const CRASH_DAYS = 14;                                  // two deaths while drawing on the chip within this: software, remembered
let addon = null, off = '', memo = '', version = '', target = null, host = null, testWait = null;

function addonFile() {
  const c = [process.env.NEBULA_TAKEFD, process.resourcesPath && path.join(process.resourcesPath, 'mpv', 'nebula-takefd.node'),
    path.join(__dirname, 'build', 'mpv', process.platform, 'nebula-takefd.node')];
  for (const f of c) { try { if (f && fs.statSync(f).isFile()) return f; } catch (e) {} }
  return '';
}
function note() { try { const j = JSON.parse(fs.readFileSync(memo, 'utf8')); return j && j.version === version ? j : {}; } catch (e) { return {}; } }
function write(j) { if (memo) { try { fs.writeFileSync(memo, JSON.stringify(Object.assign({ version }, j))); } catch (e) {} } }
/** Asked once: is this a computer and a build that can draw this way at all? (Whether it really does is check()'s answer.) */
function init(userData, ver) {
  version = String(ver || '');
  if (process.platform !== 'linux' || !st || typeof st.importSharedTexture !== 'function') { off = 'not on this system'; return; }
  if (process.env.NEBULA_NO_GPU) { off = 'switched off'; return; }
  memo = userData ? path.join(userData, 'mpv-gpu.json') : '';
  if (memo && !process.env.NEBULA_GPU) { const j = note(); if (j.off) { off = String(j.off); return; } }
  const f = addonFile();
  if (!f) { off = 'the graphics bridge is missing from this build'; return; }
  try { addon = require(f); } catch (e) { addon = null; off = 'the graphics bridge would not load'; }
}
/** Software from now on. keep: also after a restart (until the next version). */
function broke(why, keep) {
  if (keep) write({ off: why || 'failed', at: new Date().toISOString() });
  if (off) return;
  off = why || 'failed';
  if (DEBUG) console.log('[mpv-gpu] off: ' + off + (keep ? ' (remembered)' : ''));
}
/** A helper died by itself while drawing this way. Once may be the film (the helper reads whatever it is given): software
    for this session. Twice within CRASH_DAYS is the driver: software until the next version. */
function crashed(why) {
  const j = note(), last = Date.parse(j.crashedAt || '') || 0, again = last > 0 && Date.now() - last < CRASH_DAYS * 86400000;
  if (again) return broke(why, true);
  write({ crashedAt: new Date().toISOString() });
  broke(why, false);
}
const want = () => !off && !!addon;
function use(h) { host = h; }
/** The window the frames go to: its top frame, or null once it is gone. */
function bind(win) { target = win ? () => (win.isDestroyed() ? null : win.webContents.mainFrame) : null; }

function open(ss) { ss.g = { sets: new Map(), top: 0, busy: 0, next: null, errs: 0, errAt: 0, test: null, looked: '' }; }
function shut(g, serial) {
  const set = g.sets.get(serial);
  if (!set) return;
  set.forEach((b) => { if (b) { if (g.test === b) g.test = null; if (g.next && g.next.b === b) g.next = null; if (b.fd > 2) addon.closeFd(b.fd); b.fd = -1; } });
  g.sets.delete(serial);
}
function close(ss) {
  const g = ss.g;
  if (!g) return;
  Array.from(g.sets.keys()).forEach((k) => shut(g, k));
  ss.g = null;
}
function texture(b) {
  return { pixelFormat: 'bgra', codedSize: { width: b.w, height: b.h }, visibleRect: { x: 0, y: 0, width: b.w, height: b.h },
    handle: { nativePixmap: { planes: [{ stride: b.stride, offset: 0, size: b.stride * b.h, fd: b.fd }], modifier: b.modifier, supportsZeroCopyWebGpuImport: false } } };
}
/** One buffer's picture to the window, with `meta` beside it. Resolves true once the window has taken it. */
function show(ss, b, meta) {
  const g = ss.g, frame = target && target();
  if (!g || !b || b.fd < 3 || !frame) return Promise.resolve(false);
  let im = null;
  try { im = st.importSharedTexture({ textureInfo: texture(b) }); } catch (e) { return Promise.resolve(false); }
  g.busy++;
  return st.sendSharedTexture({ frame, importedSharedTexture: im }, meta).then(() => true, () => false).then((ok) => {
    g.busy--;
    try { im.release(); } catch (e) {}
    return ok;
  });
}
/** A frame the window would not take — or one naming a buffer this side never got: seconds of those on end, and this
    helper goes; the play carries on in software. */
function failed(ss, g) {
  const now = Date.now();
  if (!g.errs++) g.errAt = now;
  if (g.errs >= 12 && now - g.errAt >= 4000 && ss.g === g) { broke('the window stopped taking frames', false); if (host) host.lost(ss); }
}
function frame(ss, b, meta) {
  const g = ss.g;
  show(ss, b, meta).then((ok) => {
    if (ss.g !== g) return;
    if (ok) g.errs = 0; else failed(ss, g);
    // the newest frame that had to wait (the window was two behind) goes now: the last picture of a seek is never lost
    if (g.next && g.busy < 2) { const n = g.next; g.next = null; frame(ss, n.b, n.meta); }
  });
}
/** A line of the helper's stdout after READY: its buffers, the check's picture, a frame. */
function line(ss, l) {
  const g = ss.g;
  if (!g) return;
  const a = l.split(' ');
  if (a.length > 10 || !a.slice(1).every((x) => /^\d{1,20}$/.test(x))) return;   // numbers only, whatever the helper was made to say
  if (a[0] === 'BUF' && a.length === 10) {
    // a buffer as gpu.c makes them: one plane of 4 bytes a pixel from its start, no larger than a frame can be, of the
    // newest set or the next (a set older than the one before is closed; serials only go up)
    const serial = +a[1], i = +a[2], w = +a[4], h = +a[5], stride = +a[7];
    if (serial < g.top || serial > g.top + 1e6 || i >= 8 || w < 2 || h < 2 || w > 8192 || h > 8192 || stride < w * 4 || stride > w * 4 + 4096 || +a[8] !== 0 || +a[6] < 3) return;
    if (ss.p.exitCode !== null || ss.p.signalCode !== null) return;   // (a helper that has gone: its number may be another process's by now)
    const fd = addon.takeFd(ss.p.pid, +a[6]);
    if (fd < 0) {
      if (DEBUG) console.log('[mpv-gpu] takeFd ' + fd);
      // this kernel or its rules will not hand a child's descriptor over (EPERM 1, ENOSYS 38): no later try will differ
      if (fd === -1 || fd === -38) broke('this system does not let the player share its picture', true);
      return;
    }
    // really a dmabuf, and one that holds what the line says: nothing else goes on to Chromium's graphics process
    let kind = '';
    try { kind = fs.readlinkSync('/proc/self/fd/' + fd); } catch (e) { kind = ''; }
    const size = addon.sizeFd(fd);
    if (!/dmabuf/.test(kind) || (size > 0 && size < stride * h)) { if (DEBUG) console.log('[mpv-gpu] refused ' + kind + ' ' + size); addon.closeFd(fd); return; }
    if (serial > g.top) { Array.from(g.sets.keys()).forEach((k) => { if (k < g.top) shut(g, k); }); g.top = serial; g.sets.set(serial, []); }
    const set = g.sets.get(serial), was = set[i];
    if (was && was.fd > 2) addon.closeFd(was.fd);
    set[i] = { fd, w, h, stride, modifier: a[9] };
  } else if (a[0] === 'T' && a.length === 3) g.test = (g.sets.get(+a[1]) || [])[+a[2]] || null;
  else if (a[0] === 'F' && a.length === 6) {
    const b = (g.sets.get(+a[1]) || [])[+a[2]], meta = { count: +a[3], gen: +a[4], drawMs: +a[5] / 1000, w: b ? b.w : 0, h: b ? b.h : 0 };
    if (!b) return failed(ss, g);                        // a frame in a buffer this side does not hold: counted, not shown
    if (g.busy >= 2) g.next = { b, meta };               // the window is two frames behind: only the newest waits (the page counts the rest)
    else frame(ss, b, meta);
  }
}
/** The window's answer to a check picture (mpv-ipc.js → here): true, false = another colour arrived, null = it could not look. */
function tested(v) { if (testWait) { const w = testWait; testWait = null; w(v === true ? true : (v === false ? false : null)); } }
/** Does a frame drawn this way really arrive? The helper's check buffer goes to the window, which must read its colour
    back (three tries: the first import of a session takes half a second). false → this helper is replaced by a software one. */
async function check(ss) {
  for (let i = 0; i < 40 && ss.g && !ss.g.test && !off; i++) await new Promise((r) => setTimeout(r, 50));
  for (let n = 0; n < 3 && ss.g && ss.g.test && !off; n++) {
    const answer = new Promise((ok) => { testWait = ok; setTimeout(() => { if (testWait === ok) { testWait = null; ok(null); } }, 2500); });
    const sent = await show(ss, ss.g.test, { test: TEST });
    const got = sent ? await answer : (testWait = null, null);
    if (DEBUG) console.log('[mpv-gpu] check ' + n + ': sent ' + sent + ' answer ' + got);
    if (got === true) return !!ss.g;
    if (got === false) { broke('this computer\'s graphics would not show the picture', true); return false; }   // another colour: final
  }
  if (ss.g) broke('the window did not take a frame', false);   // (a session that went away meanwhile says nothing about the window)
  return false;
}
/** The size the window shows the picture at, and whether anyone is looking (a hidden window: nothing is drawn). */
function view(ss, w, h, look) {
  if (!ss || !ss.g || !ss.p || !ss.p.stdin || ss.gone) return;
  const s = 'S ' + Math.max(2, Math.min(8192, w | 0)) + ' ' + Math.max(2, Math.min(8192, h | 0)) + '\nV ' + (look ? 1 : 0) + '\n';
  if (s === ss.g.looked) return;
  ss.g.looked = s;
  try { ss.p.stdin.write(s); } catch (e) {}
}
module.exports = { init, want, use, bind, open, close, line, check, tested, view, broke, crashed, TEST };
