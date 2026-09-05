const { app, BrowserWindow, Menu, dialog, ipcMain, screen, session, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// ---- FFmpeg in the shell: what Chromium cannot decode (Dolby Digital / DTS / TrueHD audio,
// HEVC without a hardware decoder) is re-encoded on the fly, the rest copied through. The
// player asks /probe what a file holds, then pulls /seg pieces and appends them itself.
// Bundled through ffmpeg-static + ffprobe-static (unpacked from the asar); a dev checkout
// without them falls back to whatever is on PATH.
function tool(name) {
  try {
    const mod = require(name === 'ffmpeg' ? 'ffmpeg-static' : 'ffprobe-static');
    const p = name === 'ffmpeg' ? mod : mod.path;
    if (p) return String(p).replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  } catch (e) {}
  return name;
}
const FFMPEG = tool('ffmpeg'), FFPROBE = tool('ffprobe');
const TC_OK = (() => {
  if (process.env.NEBULA_NO_FFMPEG) return false;          // the rigs prove the no-converter path with this
  try { return spawnSync(FFMPEG, ['-version'], { timeout: 5000 }).status === 0 && spawnSync(FFPROBE, ['-version'], { timeout: 5000 }).status === 0; }
  catch (e) { return false; }
})();
ipcMain.on('tc-available', (event) => { event.returnValue = TC_OK; });

const httpUrl = (u) => /^https?:\/\/[^\s"'<>]{4,2000}$/i.test(u || '');
const NET_ARGS = ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '4', '-user_agent', 'NebulaPlayer'];

// What the file holds: duration, the video codec, every audio and subtitle track.
function probe(src, res) {
  // the track list sits in the header: a second of packets is plenty, and keeps a 25 Mbps remux from costing 16 MB per play
  const ff = spawn(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', '-analyzeduration', '1M', '-probesize', '5M', src], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const timer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch (e) {} }, 25000);
  ff.stdout.on('data', (d) => { out += d; });
  ff.on('close', () => {
    clearTimeout(timer);
    let j = null; try { j = JSON.parse(out); } catch (e) {}
    if (!j || !Array.isArray(j.streams)) { res.statusCode = 502; res.setHeader('Content-Type', 'application/json'); res.end('{"error":"probe failed"}'); return; }
    const v = j.streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic)) || null;
    const audio = j.streams.filter((s) => s.codec_type === 'audio').map((s, i) => ({
      i, codec: s.codec_name || '', channels: s.channels || 0, lang: (s.tags && (s.tags.language || s.tags.LANGUAGE)) || '',
      title: (s.tags && (s.tags.title || s.tags.TITLE)) || '', dflt: !!(s.disposition && s.disposition.default),
    }));
    const subs = j.streams.filter((s) => s.codec_type === 'subtitle').map((s, i) => ({ i, codec: s.codec_name || '', lang: (s.tags && s.tags.language) || '', title: (s.tags && s.tags.title) || '' }));
    const body = {
      duration: Number((j.format && j.format.duration) || (v && v.duration) || 0) || 0,
      video: v ? { codec: v.codec_name || '', width: v.width || 0, height: v.height || 0, profile: v.profile || '', pix_fmt: v.pix_fmt || '', transfer: v.color_transfer || '' } : null,
      audio, subs,
    };
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body));
  });
}

// One piece of the file from second `t`, `len` seconds long, as fragmented MP4 with the ORIGINAL
// timestamps kept (-copyts), so the player can drop it straight onto its timeline. Video is
// copied unless `v=h264` asks for a re-encode; audio track `a` becomes stereo AAC.
function segment(q, req, res) {
  const src = q.get('src') || '';
  const t = Math.max(0, Number(q.get('t')) || 0), len = Math.min(30, Math.max(2, Number(q.get('len')) || 10));
  const a = Math.max(0, Number(q.get('a')) || 0), vmode = q.get('v') === 'h264' ? 'h264' : 'copy', vcodec = q.get('vc') || '';
  // -ss before -i lands on the keyframe at or before t (fast, needed for a video copy); -to with -copyts then runs the
  // piece up to the absolute time t+len, so a long keyframe gap never leaves the requested second uncovered
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...NET_ARGS, '-ss', String(t), '-i', src, '-to', String(t + len),
    '-map', '0:v:0', '-map', '0:a:' + a, '-sn', '-dn'];
  if (vmode === 'h264') args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-g', '48', '-force_key_frames', 'expr:gte(t,n_forced*2)');
  else { args.push('-c:v', 'copy'); if (/hevc|h265/i.test(vcodec)) args.push('-tag:v', 'hvc1'); }
  args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-copyts', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '1000000', 'pipe:1');
  const ff = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  ff.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-4000); });
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
  ff.stdout.pipe(res);
  const kill = () => { try { ff.kill('SIGKILL'); } catch (e) {} };
  req.on('close', kill);
  ff.on('close', (code) => { if (code && !res.writableEnded) { try { res.destroy(); } catch (e) {} } if (code) console.error('ffmpeg seg exit', code, err.trim().slice(-300)); });
}

// Chromium only exposes a plain file's audio tracks (video.audioTracks — the Hindi /
// Tamil / English choices inside one MKV) behind this Blink feature. The player already
// switches them natively when the list exists; without the flag every such file reports
// one track. Must be set before the app is ready.
app.commandLine.appendSwitch('enable-blink-features', 'AudioVideoTracks');

// The player's storage (add-ons, profile, progress, settings) is keyed by the page's
// origin, and the origin includes the port — so the port must be the SAME on every
// launch. listen(0) picked a random one and made every restart a fresh install.
const PORTS = [47313, 47314, 47315, 47316, 47317];

// Serve the player over http://127.0.0.1 instead of file:// — Chromium blocks EME
// (ClearKey) on file:// (opaque) origins, so a localhost origin is required for DRM.
function startServer() {
  const root = path.join(__dirname, 'renderer');
  const mime = {
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript',
    '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  };
  const handler = (req, res) => {
    try {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      if (u.pathname === '/probe' || u.pathname === '/seg') {
        const src = u.searchParams.get('src') || '';
        if (!TC_OK) { res.statusCode = 501; res.end('no ffmpeg'); return; }
        if (!httpUrl(src)) { res.statusCode = 400; res.end('bad src'); return; }
        if (u.pathname === '/probe') probe(src, res); else segment(u.searchParams, req, res);
        return;
      }
      let p = decodeURIComponent((req.url || '/').split('?')[0]);
      if (p === '/' || p === '') p = '/index.html';
      const file = path.normalize(path.join(root, p));
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.statusCode = 404; res.end('not found'); return;
      }
      res.setHeader('Content-Type', mime[path.extname(file).toLowerCase()] || 'application/octet-stream');
      // a fixed origin must never hand out the previous version's page after an update
      res.setHeader('Cache-Control', 'no-store');
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      res.statusCode = 500; res.end('error');
    }
  };
  // Fixed port first; walk the short list when something else holds it (in use, or a
  // Windows excluded-port range, which fails with EACCES rather than EADDRINUSE), and
  // fall back to a random one as a last resort (storage would not carry over that once).
  const attempt = (i) => new Promise((resolve, reject) => {
    const port = i < PORTS.length ? PORTS[i] : 0;
    const server = http.createServer(handler);
    server.once('error', (err) => {
      server.close();
      if (port !== 0 && err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) resolve(attempt(i + 1));
      else reject(err);
    });
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
  return attempt(0);
}

async function createWindow() {
  const port = await startServer();
  // Grant media/EME permissions.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    title: 'Nebula',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  // Only ever hand real web links to the OS browser: a dropped file used to arrive here as
  // file:///… and open in whatever player owns the extension.
  const external = (url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  // The window must only ever show the local player — send any in-window
  // navigation attempt to the OS browser instead.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}/`)) {
      event.preventDefault();
      external(url);
    }
  });
  // Mini player: shrink to an always-on-top window in the bottom-right corner
  // (great for keeping a match visible while working); toggling off restores
  // the exact previous bounds. Driven by the player UI via preload.js.
  let savedBounds = null;
  let savedMaximized = false;
  const enterMini = () => {
    savedMaximized = win.isMaximized();
    if (savedMaximized) win.unmaximize();
    savedBounds = win.getBounds();
    const wa = screen.getDisplayMatching(savedBounds).workArea;
    const w = 480, h = 300;
    win.setMinimumSize(320, 200);
    win.setBounds({ x: wa.x + wa.width - w - 16, y: wa.y + wa.height - h - 16, width: w, height: h });
    win.setAlwaysOnTop(true, 'floating');
  };
  ipcMain.removeHandler('mini-mode');
  ipcMain.handle('mini-mode', (_event, on) => {
    if (win.isDestroyed()) return;
    if (on && !savedBounds) {
      // from fullscreen the bounds would be the whole screen: leave it first, then shrink
      if (win.isFullScreen()) { win.once('leave-full-screen', enterMini); win.setFullScreen(false); }
      else enterMini();
    } else if (!on && savedBounds) {
      win.setAlwaysOnTop(false);
      win.setMinimumSize(900, 600);
      win.setBounds(savedBounds);
      if (savedMaximized) win.maximize();
      savedBounds = null;
      savedMaximized = false;
    }
  });

  // Closing mid-playback: give the page a moment to write progress and push the cloud —
  // quitting at once killed the keepalive request before it left the process.
  let flushed = false;
  win.on('close', (event) => {
    if (flushed || win.isDestroyed()) return;
    event.preventDefault();
    flushed = true;
    try { win.webContents.send('nebula:flush'); } catch (e) {}
    setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, 700);
  });

  win.loadURL(`http://127.0.0.1:${port}/index.html`);
  // a second launch (double-clicked the icon again) brings this window forward
  app.on('second-instance', () => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
}

// Only one Nebula at a time: a second copy would take the next port and see an empty
// library. Hand its launch to the running window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // No stock File/Edit/View bar (Alt used to reveal it) and none of its shortcuts:
  // Ctrl+R restarted the stream, Ctrl+W closed the window, F11 fought the player's own fullscreen.
  Menu.setApplicationMenu(null);
  app.whenReady().then(createWindow).catch((err) => {
    dialog.showErrorBox('Nebula could not start', String((err && err.message) || err));
    app.quit();
  });
  // Without this, closing the window leaves Nebula (and its local server) running forever.
  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}
