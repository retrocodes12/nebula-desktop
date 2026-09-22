const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Minimal bridge for the shared player. The player feature-detects this object, so the same index.html works unchanged
// on web and webOS. This preload runs SANDBOXED (Electron's bridge and the web platform, no Node): whatever needs the
// machine lives in the main process and answers over IPC.
//   setMiniMode(true/false) — the small always-on-top mini window
//   onFlush(cb)             — the window is closing: write progress and push the cloud NOW
//   transcodeNow()          — true once the shell has found FFmpeg: /probe and /seg on this origin turn files Chromium
//                             cannot decode into pieces it can (asked in the background; `transcode` is a constant
//                             false kept for an older page)
//   update                  — the in-app updater: info (kind setup|portable|appimage|deb|dev, plat, version), check() /
//                             download() / install() each answer with the state, on(cb) streams it
//   relay                   — Share with your TV: info() = {on, port, token, hosts, name, plat, bytes, served, error?},
//                             set(on) flips it (answers with the state), on(cb) streams state changes
//   mpv                     — the full-format player (main process: mpv-ipc.js → mpv-host.js → helper/nebula-mpv.c).
//                             info() = {available, error, lib, version}; on(cb) streams {type:'state'|'loaded'|'end'|
//                             'tracks'|'available'|…}; attach(canvasId), load(url, opts) (http(s), or 'local:N' from
//                             localFile(file)), command(['seek', t, mode]), set(name, value), get(name), stop(), stats(),
//                             subAdd(text, label, lang) → the track. The picture is drawn here (mpvPicture).

// ---- The full-format player's picture. Each frame is fetched from the helper's loopback frame server (helper/frames.c:
// one request a frame, the newest newer than the last one) and drawn on a WebGL canvas at the element's size. The size asked
// for is never more than the video has (the GPU stretches it) and smaller while this machine cannot draw a frame in the time
// it lasts (adapt) — a little softer, never a slideshow. A hidden window asks for nothing and the helper stops drawing (mpv's
// clock moves on). Measured on an i3-3217U (09-15): 1080p drawn at 1366x768 in 12–13 ms; 4K HEVC at 1080p in 42 ms, which
// adapt() steps down.
function mpvPicture() {
  let info0 = null;
  try { info0 = ipcRenderer.sendSync('mpv-info'); } catch (e) { info0 = null; }
  if (!info0) return null;
  const MAX_W = 1920, MAX_H = 1080, MIN_W = 854, MAGIC = 0x46504d4e;   // MIN_W: the smallest picture adapt() draws
  const VS = 'attribute vec2 p; varying vec2 v; void main(){ v = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5); gl_Position = vec4(p, 0.0, 1.0); }';
  const FS = 'precision mediump float; varying vec2 v; uniform sampler2D t; void main(){ gl_FragColor = vec4(texture2D(t, v).rgb, 1.0); }';
  // HDR (PQ, HLG) and wide-colour SDR frames arrive as coded (mpv-host labels every frame SDR BT.709, so no libmpv converts on
  // the CPU); this turns them into what an SDR screen shows, per pixel on the GPU: to linear light, BT.2020 → BT.709, the
  // BT.2390 tone curve (peak 1000 nits, reference white 203), BT.1886. mode: 0 SDR · 1 PQ · 2 HLG · 3 SDR in BT.2020.
  const FS_HDR = ['precision highp float;', 'varying vec2 v; uniform sampler2D t; uniform int mode;',
    'const mat3 TO709 = mat3(1.6605, -0.1246, -0.0182, -0.5876, 1.1329, -0.1006, -0.0728, -0.0083, 1.1187);',
    'const float M1 = 0.1593017578125, M2 = 78.84375, C1 = 0.8359375, C2 = 18.8515625, C3 = 18.6875;',
    'vec3 pqToNits(vec3 e){ vec3 p = pow(max(e, vec3(1e-6)), vec3(1.0 / M2)); return 10000.0 * pow(max(p - C1, vec3(0.0)) / (C2 - C3 * p), vec3(1.0 / M1)); }',
    'float nitsToPq(float l){ float y = pow(max(l, 1e-6) / 10000.0, M1); return pow((C1 + C2 * y) / (1.0 + C3 * y), M2); }',
    'vec3 hlgToNits(vec3 e){ vec3 s = mix(e * e / 3.0, (exp((e - 0.55991073) / 0.17883277) + 0.28466892) / 12.0, step(0.5, e));',
    '  return 1000.0 * pow(max(dot(s, vec3(0.2627, 0.6780, 0.0593)), 1e-6), 0.2) * s; }',
    'void main(){',
    '  vec3 c = texture2D(t, v).rgb;',
    '  if (mode == 0) { gl_FragColor = vec4(c, 1.0); return; }',
    '  vec3 l = mode == 1 ? pqToNits(c) : (mode == 2 ? hlgToNits(c) : pow(max(c, vec3(0.0)), vec3(2.4)) * 203.0);',
    '  l = max(TO709 * l, vec3(0.0));',
    '  if (mode != 3) {',
    '    float mx = max(max(l.r, l.g), l.b), pw = nitsToPq(1000.0), ml = nitsToPq(203.0) / pw, ks = 1.5 * ml - 0.5;',
    '    float e1 = min(1.0, nitsToPq(mx) / pw), e2 = e1;',
    '    if (e1 > ks) { float x = (e1 - ks) / (1.0 - ks), x2 = x * x, x3 = x2 * x; e2 = (2.0 * x3 - 3.0 * x2 + 1.0) * ks + (x3 - 2.0 * x2 + x) * (1.0 - ks) + (-2.0 * x3 + 3.0 * x2) * ml; }',
    '    l *= mx > 1e-6 ? pqToNits(vec3(e2 * pw)).r / mx : 0.0;',
    '  }',
    '  gl_FragColor = vec4(pow(clamp(l / 203.0, 0.0, 1.0), vec3(1.0 / 2.4)), 1.0);',
    '}'].join('\n');
  let onEvent = null, base = info0.base || '', props = {}, tracks = [];
  let canvas = null, gl = null, gl2 = false, bw = 0, bh = 0, rw = 0, rh = 0, tw = 0, th = 0, vw = 0, vh = 0, uMode = null, mode = 0, modeSet = -1;
  let running = false, pumpId = 0, next = null, raf = 0, frames = 0, drawn = 0, upMs = 0, lastCount = 0, count0 = 0, lastGen = -1, staleGen = -1;
  let scale = 1, drawEma = 0, slowAt = 0, quickAt = 0, lastDrop = 0, hist = [], drawGap = 0, lastDrawAt = 0;
  const emit = (m) => { if (onEvent) { try { onEvent(m); } catch (x) {} } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function glSetup() {
    const o = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false };
    gl = canvas.getContext('webgl2', o); gl2 = !!gl;
    if (!gl) gl = canvas.getContext('webgl', o);
    if (!gl) return false;
    const sh = (type, src) => { const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); return x; };
    const link = (fs) => { const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); return p; };
    let pr = link(FS_HDR);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) pr = link(FS);    // a GPU without highp: HDR shows as coded, nothing breaks
    gl.useProgram(pr);
    uMode = gl.getUniformLocation(pr, 'mode'); modeSet = -1;
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]
      .forEach((a) => gl.texParameteri(gl.TEXTURE_2D, a[0], a[1]));
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    tw = th = bw = bh = 0;
    return true;
  }
  /** The canvas follows its element (device pixels, capped); the picture asked for is that size times the adaptive scale,
      never more than the video's own pixels, never under MIN_W wide (unless the video is smaller). */
  function fit() {
    const dpr = window.devicePixelRatio || 1;
    let w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (w < 2 || h < 2) return;
    const k = Math.min(1, MAX_W / w, MAX_H / h);
    w = Math.max(2, Math.round(w * k)); h = Math.max(2, Math.round(h * k));
    if (w !== bw || h !== bh) { bw = w; bh = h; canvas.width = bw; canvas.height = bh; gl.viewport(0, 0, bw, bh); }
    const src = vw > 0 && vh > 0 ? Math.min(1, Math.max(vw / bw, vh / bh)) : 1;
    const f = Math.max(Math.min(scale, src), Math.min(1, MIN_W / bw, src));
    rw = Math.max(2, Math.round(bw * f)); rh = Math.max(2, Math.round(bh * f));
  }
  function draw() {
    raf = 0;
    const f = next; next = null;
    if (f && gl && !gl.isContextLost() && (gl2 || f.stride === f.w * 4)) {
      const t0 = performance.now(), px = new Uint8Array(f.buf, 32, f.h * f.stride);
      if (gl2) gl.pixelStorei(gl.UNPACK_ROW_LENGTH, f.stride >> 2);   // rows padded to 64 bytes: the helper's fast path
      if (uMode && modeSet !== mode) { gl.uniform1i(uMode, mode); modeSet = mode; }
      if (f.w !== tw || f.h !== th) { tw = f.w; th = f.h; gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, px); }
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      frames++; lastGen = f.gen;
      const d = performance.now() - t0;
      upMs = upMs ? upMs * 0.9 + d * 0.1 : d;
      if (f.drawMs > 0 && f.w === rw && f.h === rh) drawEma = drawEma ? drawEma * 0.9 + f.drawMs * 0.1 : f.drawMs;
      const now = performance.now();                    // how far apart frames reach the screen
      if (lastDrawAt) drawGap = drawGap ? drawGap * 0.9 + (now - lastDrawAt) * 0.1 : now - lastDrawAt;
      lastDrawAt = now;
    }
  }
  /** Frames are asked for as fast as the helper draws them (each request is answered with the next one) and the newest is
      drawn at each animation frame: a frame not yet drawn when a newer one arrives is skipped, and adapt() watches for that. */
  async function pump(id) {
    let fails = 0;
    while (running && id === pumpId) {
      if (!base || !gl || document.hidden) { await sleep(200); continue; }
      fit();
      let r = null;
      try { r = await fetch(base + '?after=' + lastCount + '&w=' + rw + '&h=' + rh + '&pad=' + (gl2 ? 1 : 0), { cache: 'no-store' }); }
      catch (e) { await sleep(Math.min(1000, 50 * ++fails)); continue; }
      if (id !== pumpId) return;
      if (r.status === 204) { fails = 0; continue; }
      if (!r.ok) { await sleep(Math.min(1000, 50 * ++fails)); continue; }
      let buf = null;
      try { buf = await r.arrayBuffer(); } catch (e) { continue; }
      if (id !== pumpId || buf.byteLength < 32) continue;
      const hd = new Uint32Array(buf, 0, 8);
      if (hd[0] !== MAGIC || buf.byteLength < 32 + hd[2] * hd[3]) continue;
      fails = 0;
      lastCount = hd[6] + hd[7] * 4294967296; drawn = Math.max(0, lastCount - count0);   // this file's frames the helper drew
      if (hd[5] === staleGen) continue;                  // the file before this load, still on its way out
      next = { buf, w: hd[1], h: hd[2], stride: hd[3], drawMs: hd[4] / 1000, gen: hd[5] };
      if (!raf) raf = requestAnimationFrame(draw);
    }
  }
  /** Draw smaller when a frame's drawing takes most of its time slot, mpv drops frames, or this page shows well under the
      frames the helper draws (the fetch and upload cannot keep up — a 50/60 fps film); larger again once all of it is quick
      for a while: steps of 0.8. A new file starts at full size. */
  function adapt(s) {
    const fps = s.vfps > 0 ? s.vfps : (s.fps > 0 ? s.fps : 24), slot = 1000 / Math.min(120, Math.max(10, fps)), now = Date.now();
    const dropped = (s.drop || 0) > lastDrop;
    lastDrop = s.drop || 0;
    hist.push({ f: frames, d: drawn });                  // the last two seconds (a state comes four times a second)
    if (hist.length > 9) hist.shift();
    // page skips mean slowness only when frames also reach the screen well apart (a 60 fps film on a 60 Hz screen skips a
    // frame now and then around the refresh without anything being slow)
    const dd = drawn - hist[0].d, df = frames - hist[0].f, pageOk = dd < 12 || df >= dd * 0.97;
    const pageSlow = hist.length >= 8 && dd >= 12 && df < dd * 0.85 && drawGap > slot * 1.4;
    if (s.pause !== false || s.cache || document.hidden) { slowAt = quickAt = 0; lastDrawAt = 0; return; }
    const drawSlow = drawEma > 0 && (drawEma > slot * 0.75 || (dropped && drawEma > slot * 0.5));
    if (drawSlow || pageSlow) {
      quickAt = 0;
      if (!slowAt) slowAt = now;
      else if (now - slowAt >= 1500 && bw * scale > MIN_W) { scale = Math.max(0.3, scale * 0.8); slowAt = now; drawEma = 0; hist = []; }
    } else if (drawEma > 0 && drawEma < slot * 0.35 && pageOk && scale < 1) {
      slowAt = 0;
      if (!quickAt) quickAt = now;
      else if (now - quickAt >= 8000) { scale = Math.min(1, scale / 0.8); quickAt = now; drawEma = 0; hist = []; }
    } else slowAt = quickAt = 0;
  }
  ipcRenderer.on('nebula:mpv', (_e, m) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'up') { base = m.base || ''; lastCount = 0; count0 = 0; lastGen = -1; staleGen = -1; return; }   // a new helper counts from 0
    if (m.type === 'state' && m.s) {
      props = m.s.p || {}; vw = m.s.w || 0; vh = m.s.h || 0;
      mode = m.s.gamma === 'pq' ? 1 : (m.s.gamma === 'hlg' ? 2 : (m.s.prim === 'bt.2020' ? 3 : 0));
      adapt(m.s);
      delete m.s.p;
      Object.assign(m.s, { frames, drawn, upMs: Math.round(upMs * 10) / 10, drawMs: drawEma > 0 ? Math.round(drawEma * 10) / 10 : 0, rw, rh, cw: bw, ch: bh,
        sc: Math.round(scale * 100) / 100 });
    }
    if ((m.type === 'tracks' || m.type === 'loaded') && Array.isArray(m.tracks)) tracks = m.tracks;
    emit(m);
  });
  window.addEventListener('pagehide', () => { if (running) { running = false; pumpId++; ipcRenderer.send('mpv-stop'); } });

  return {
    info() { try { return ipcRenderer.sendSync('mpv-info') || info0; } catch (e) { return info0; } },
    on(cb) { onEvent = typeof cb === 'function' ? cb : null; },
    /** Draw into this canvas (by id) from now on; false when this computer cannot draw here. */
    attach(id) {
      const c = document.getElementById(id);
      if (!c) return false;
      if (c !== canvas) {
        canvas = c; gl = null;
        c.addEventListener('webglcontextlost', (e) => { e.preventDefault(); if (canvas === c) gl = null; }, false);
        c.addEventListener('webglcontextrestored', () => { if (canvas === c) glSetup(); }, false);   // a GPU reset: the picture comes back
      }
      if (!gl || gl.isContextLost()) { gl = null; if (!glSetup()) return false; }
      fit();
      return true;
    },
    load(url, o) {
      if (typeof url !== 'string' || !(/^https?:\/\//i.test(url) || /^local:\d+$/.test(url))) return { ok: false, error: 'this address cannot be played here' };
      ipcRenderer.send('mpv-load', url, o && typeof o === 'object' ? o : {});
      running = true; frames = 0; drawn = 0; count0 = lastCount; scale = 1; drawEma = 0; slowAt = quickAt = 0; lastDrop = 0; hist = []; drawGap = 0; lastDrawAt = 0;
      vw = vh = 0; staleGen = lastGen; next = null;
      pump(++pumpId);
      return { ok: true };
    },
    command(a) { ipcRenderer.send('mpv-command', a); return 0; },
    set(k, v) { ipcRenderer.send('mpv-set', String(k), String(v)); return 0; },
    /** An observed property in mpv's string form (the last state), or the track list as JSON. */
    get(k) { if (k === 'track-list') return JSON.stringify(tracks); const v = props[k]; return v == null ? null : String(v); },
    /** keep: the last picture stays on the canvas (a play that failed stands under its sentence). */
    stop(keep) {
      running = false; pumpId++; next = null;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      ipcRenderer.send('mpv-stop');
      if (!keep && gl && !gl.isContextLost()) gl.clear(gl.COLOR_BUFFER_BIT);
    },
    /** frames = shown here; drawn = the helper's count (more than shown when the page cannot take them as fast). */
    stats() {
      return { frames, drawn, upMs: Math.round(upMs * 10) / 10, w: bw, h: bh, rw, rh, fw: tw, fh: th, scale: Math.round(scale * 100) / 100,
        drawMs: Math.round(drawEma * 10) / 10, mode, shader: uMode ? 'hdr' : 'plain', lib: info0.lib || '' };
    },
    subAdd(text, label, lang) { return ipcRenderer.invoke('mpv-sub', String(text || ''), String(label || ''), String(lang || '')); },
    /** A file the user picked (input or drop) → 'local:N' for load(), '' when it is not a film this player takes. */
    localFile(file) {
      let p = '';
      try { p = webUtils.getPathForFile(file) || ''; } catch (e) { p = ''; }
      return p ? ipcRenderer.invoke('mpv-grant', p) : Promise.resolve('');
    },
  };
}
const mpv = mpvPicture();

// The converter's availability: asked without blocking the page (a slow first check under a virus scan froze it for up to
// 30 s when this was sendSync), and asked once more a minute later if the first check failed.
let tcOk = false;
const tcAsk = () => ipcRenderer.invoke('tc-available').then((v) => { tcOk = v === true; }).catch(() => {});
tcAsk().then(() => { if (!tcOk) setTimeout(tcAsk, 60000); });

contextBridge.exposeInMainWorld('nebulaDesktop', {
  mpv: mpv ? {
    info: () => mpv.info(), on: (cb) => mpv.on(cb), attach: (id) => mpv.attach(id), load: (url, o) => mpv.load(url, o),
    command: (a) => mpv.command(a), set: (n, v) => mpv.set(n, v), get: (n) => mpv.get(n), stop: (keep) => mpv.stop(keep === true), stats: () => mpv.stats(),
    subAdd: (text, label, lang) => mpv.subAdd(text, label, lang), localFile: (f) => mpv.localFile(f),
  } : null,
  relay: {
    info: () => ipcRenderer.sendSync('relay-info'),
    set: (on) => ipcRenderer.invoke('relay-set', !!on),
    on: (cb) => { ipcRenderer.on('nebula:relay', (_event, state) => { try { cb(state); } catch (e) {} }); },
  },
  setMiniMode: (on) => ipcRenderer.invoke('mini-mode', !!on),
  onFlush: (cb) => { ipcRenderer.on('nebula:flush', () => { try { cb(); } catch (e) {} }); },
  transcode: false,                  // the old one-shot answer, for a page that still reads it; the live one is transcodeNow
  transcodeNow: () => tcOk,          // false until the shell's FFmpeg check answers (asked in the background, never waited on)
  update: {
    info: ipcRenderer.sendSync('update-info'),
    check: () => ipcRenderer.invoke('update-check'),
    download: () => ipcRenderer.invoke('update-download'),
    install: () => ipcRenderer.invoke('update-install'),
    on: (cb) => { ipcRenderer.on('nebula:update', (_event, state) => { try { cb(state); } catch (e) {} }); },
  },
});
