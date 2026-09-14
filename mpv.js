'use strict';
// mpv in the page (desktop): the picture, and the page's one door to the full-format player. libmpv itself runs in a helper
// process (mpv-host.js, helper/nebula-mpv.c) and draws every frame — subtitles included — into shared memory; this file
// uploads the newest one to a WebGL canvas at the element's size (one memcpy out of that memory per frame) and passes the
// page's calls and mpv's news through. Loaded by preload.js (sandbox: false: it spawns the helper and maps its memory;
// contextIsolation stays on and the page sees only what preload.js hands it). Measured on an i3-3217U (09-15): 1080p x264
// and HEVC drawn at 1366x768 in real time, 12–13 ms a frame; 4K H.264 and 4K 10-bit HEVC at 1366x768, 28–31 ms, none
// dropped. Drawing is CPU work that grows with the picture's size, so a machine that cannot keep up gets a smaller picture,
// stretched back over the canvas by the GPU (adapt) — a little softer, never a slideshow.
const host = require('./mpv-host');

const MIN_W = 854;                                      // the smallest picture adapt() draws (the canvas's width, when smaller)
let canvas = null, gl = null, bw = 0, bh = 0, rw = 0, rh = 0, tw = 0, th = 0;
let running = false, raf = 0, poller = 0, onEvent = null, lastCount = -1, frames = 0, upMs = 0;
let scale = 1, drawEma = 0, slowAt = 0, quickAt = 0, lastDrop = 0, probed = false;

function emit(e) { if (onEvent) { try { onEvent(e); } catch (x) {} } }
function info() { const ok = host.available(); return { available: ok, error: ok ? '' : host.whyNot(), lib: host.libs().join(' | '), version: host.version() }; }
/** The page listens; a moment after launch the helper checks which libmpv works here (Settings then knows before a play). */
function on(cb) {
  onEvent = typeof cb === 'function' ? cb : null; host.on(emit);
  if (!probed) { probed = true; setTimeout(() => { host.probe().catch(() => {}); }, 2500); }
}

// ---- drawing
const VS = 'attribute vec2 p; varying vec2 v; void main(){ v = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5); gl_Position = vec4(p, 0.0, 1.0); }';
const FS = 'precision mediump float; varying vec2 v; uniform sampler2D t; void main(){ gl_FragColor = vec4(texture2D(t, v).rgb, 1.0); }';
function glSetup() {
  gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
  if (!gl) return false;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr); gl.useProgram(pr);
  const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]].forEach((a) => gl.texParameteri(gl.TEXTURE_2D, a[0], a[1]));
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  tw = th = 0;
  return true;
}
/** The canvas follows its element (device pixels, capped to what the helper can draw); the helper draws at that size times
    the adaptive scale — and small while the window is hidden (nothing shows; the sound plays on). */
function fit() {
  const dpr = window.devicePixelRatio || 1;
  let w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (w < 2 || h < 2) return;
  const k = Math.min(1, host.MAX_W / w, host.MAX_H / h); w = Math.max(2, Math.round(w * k)); h = Math.max(2, Math.round(h * k));
  if (w !== bw || h !== bh) { bw = w; bh = h; canvas.width = bw; canvas.height = bh; gl.viewport(0, 0, bw, bh); }
  const f = document.hidden ? Math.min(1, 160 / bw) : Math.max(scale, Math.min(1, MIN_W / bw));
  const ww = Math.max(2, Math.round(bw * f)), wh = Math.max(2, Math.round(bh * f));
  if (ww !== rw || wh !== rh) { rw = ww; rh = wh; host.want(rw, rh); }
}
function tick() {
  raf = 0;
  if (!running) return;
  if (gl) {
    fit();
    const t0 = performance.now(), f = host.frame(lastCount);
    if (f) {
      lastCount = f.count;
      const px = f.view;
      if (f.w !== tw || f.h !== th) { tw = f.w; th = f.h; gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, px); }
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      frames++; upMs = upMs ? upMs * 0.9 + (performance.now() - t0) * 0.1 : performance.now() - t0;
      if (f.drawMs > 0 && f.w === rw && f.h === rh) drawEma = drawEma ? drawEma * 0.9 + f.drawMs * 0.1 : f.drawMs;
    }
  }
  raf = requestAnimationFrame(tick);
}
/** Draw smaller when a frame's drawing takes most of its time slot (or mpv is dropping frames), larger again once drawing
    is quick for a while: steps of 0.8, never under MIN_W wide. A new file starts at full size. */
function adapt(s) {
  const fps = s.vfps > 0 ? s.vfps : (s.fps > 0 ? s.fps : 24), slot = 1000 / Math.min(120, Math.max(10, fps)), now = Date.now();
  const dropped = (s.drop || 0) > lastDrop; lastDrop = s.drop || 0;
  if (s.pause !== false || s.cache || document.hidden || !(drawEma > 0)) { slowAt = quickAt = 0; return; }
  if (drawEma > slot * 0.75 || (dropped && drawEma > slot * 0.5)) {
    quickAt = 0;
    if (!slowAt) slowAt = now;
    else if (now - slowAt >= 1500 && bw * scale > MIN_W) { scale = Math.max(0.3, scale * 0.8); slowAt = now; drawEma = 0; }
  } else if (drawEma < slot * 0.35 && scale < 1) {
    slowAt = 0;
    if (!quickAt) quickAt = now;
    else if (now - quickAt >= 8000) { scale = Math.min(1, scale / 0.8); quickAt = now; drawEma = 0; }
  } else slowAt = quickAt = 0;
}
/** mpv's state four times a second (timers run while the window is minimized, where animation frames stop). */
function state() {
  if (!running) return;
  const s = host.snapshot();
  adapt(s);
  if (document.hidden && canvas && gl) fit();          // no animation frames while hidden: the small size is asked for here
  emit({ type: 'state', s: Object.assign(s, { frames, upMs: Math.round(upMs * 10) / 10, drawMs: drawEma > 0 ? Math.round(drawEma * 10) / 10 : s.drawMs,
    rw, rh, cw: bw, ch: bh, sc: Math.round(scale * 100) / 100 }) });
}

// ---- what the page calls (through preload.js)
/** Draw into this canvas (by id) from now on. */
function attach(id) {
  const c = document.getElementById(id);
  if (!c) return false;
  if (c !== canvas || !gl) { canvas = c; gl = null; bw = bh = 0; rw = rh = 0; if (!glSetup()) { canvas = null; return false; } }
  fit();
  return true;
}
/** Play `url` (http(s) or a local path) — see mpv-host.load for the options. */
function load(url, o) {
  const r = host.load(url, o);
  running = true; lastCount = -1; frames = 0; scale = 1; drawEma = 0; slowAt = quickAt = 0; lastDrop = 0; rw = rh = 0;
  if (!raf) raf = requestAnimationFrame(tick);
  if (!poller) poller = setInterval(state, 250);
  return r;
}
function command(args) { return host.command(args); }
function set(name, value) { return host.set(name, value); }
function get(name) { return host.get(name); }
function subAdd(text, label, lang) { return host.subAdd(text, label, lang); }
/** The file stops; the canvas goes black and nothing more is drawn until the next load (the helper stays for it). */
function stop() {
  running = false;
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  if (poller) { clearInterval(poller); poller = 0; }
  host.stop();
  if (gl) gl.clear(gl.COLOR_BUFFER_BIT);
}
function stats() { return { frames, upMs: Math.round(upMs * 10) / 10, w: bw, h: bh, rw, rh, scale: Math.round(scale * 100) / 100, lib: host.libs()[0] || '' }; }
function dispose() { stop(); host.dispose(); }

module.exports = { info, on, attach, load, command, set, get, stop, stats, subAdd, dispose };
