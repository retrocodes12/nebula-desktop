'use strict';
// The full-format player's picture, end to end, in a real window: `electron scripts/gpu-check.cjs <film> [--gpu]`.
// The app's own path does the work — preload.js (sandboxed, as in the app) → mpv-ipc.js → mpv-host.js → the helper →
// (on the graphics chip: mpv-gpu.js and a shared texture; else the software frame server) → the preload's canvas — and a
// still film of four colours (red | green over blue | white) plays into it. Then the window's own pixels are read back:
// the four colours where they belong prove the picture arrives, in the right colours, the right way up. Prints one JSON
// line; exit 0 = the picture is right (and, with --gpu, it came from the graphics chip), 1 = it is not, 2 = it never came.
// CI runs it on Windows (a runner has no graphics chip: WARP, Direct3D's software device, stands in — NEBULA_GPU_WARP=1)
// and it runs here on Linux on the real screen.
const path = require('path'), http = require('http'), fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');

const root = path.join(__dirname, '..');
const film = path.resolve(process.argv.slice(2).find((a) => /\.(mkv|mp4|webm)$/i.test(a)) || '');
const needGpu = process.argv.includes('--gpu');
const SPOTS = [['red', 0.25, 0.25, [255, 0, 0]], ['green', 0.75, 0.25, [0, 255, 0]], ['blue', 0.25, 0.75, [0, 0, 255]], ['white', 0.75, 0.75, [255, 255, 255]]];
const TOL = 48;                                        // (limited-range video and chroma subsampling move a colour a little)

// a CI runner's display adapter is a software one that Chromium otherwise refuses to draw with
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.setPath('userData', fs.mkdtempSync(path.join(require('os').tmpdir(), 'nebula-gpucheck-')));   // (no memo from an earlier run)

const PAGE = `<!doctype html><meta charset="utf-8"><title>gpu-check</title>
<style>html,body{margin:0;background:#000;overflow:hidden}canvas{display:block;width:100vw;height:100vh}</style>
<canvas id="c"></canvas><script>
(async function () {
  var m = window.nebulaDesktop && window.nebulaDesktop.mpv;
  if (!m) { console.log('STATE no-mpv'); return; }
  for (var i = 0; i < 100 && !m.info().available; i++) await new Promise(function (r) { setTimeout(r, 200); });
  if (!m.info().available) { console.log('STATE unavailable ' + m.info().error); return; }
  if (!m.attach('c')) { console.log('STATE no-canvas'); return; }
  // (a play whose player stopped is played again, as the player page does — how a switch to software reaches the window)
  m.on(function (e) { if (e && (e.type === 'end' || e.type === 'error')) { console.log('EVENT ' + JSON.stringify(e)); if (e.reason === 'error') setTimeout(function () { m.load(location.origin + '/film', { title: 'gpu-check' }); }, 500); } });
  m.load(location.origin + '/film', { title: 'gpu-check' });
  setInterval(function () { console.log('STATS ' + JSON.stringify(m.stats())); }, 500);
})();
</script>`;

function serve() {
  return new Promise((ok) => {
    const size = fs.statSync(film).size;
    const srv = http.createServer((req, res) => {
      if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
      if (req.url !== '/film') { res.writeHead(404); return res.end(); }
      const r = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      const a = r ? +r[1] : 0, b = r && r[2] ? Math.min(+r[2], size - 1) : size - 1;
      res.writeHead(r ? 206 : 200, Object.assign({ 'content-type': 'video/x-matroska', 'accept-ranges': 'bytes', 'content-length': b - a + 1 },
        r ? { 'content-range': 'bytes ' + a + '-' + b + '/' + size } : {}));
      fs.createReadStream(film, { start: a, end: b }).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => ok(srv));
  });
}

function finish(code, out) {
  console.log(JSON.stringify(out));
  if (process.env.GPU_CHECK_OUT) { try { fs.writeFileSync(process.env.GPU_CHECK_OUT, JSON.stringify(out, null, 1)); } catch (e) {} }
  setTimeout(() => app.exit(code), 300);
}

app.whenReady().then(async () => {
  if (!film || !fs.existsSync(film)) return finish(2, { ok: false, why: 'no film: ' + film });
  // what preload.js asks of the app's main process besides the player (main.js answers these in the app)
  ipcMain.on('update-info', (e) => { e.returnValue = { kind: 'dev', plat: process.platform, version: app.getVersion(), state: 'idle' }; });
  ipcMain.on('relay-info', (e) => { e.returnValue = { on: false }; });
  ipcMain.handle('tc-available', () => false);
  const srv = await serve(), origin = 'http://127.0.0.1:' + srv.address().port;
  const win = new BrowserWindow({ width: 640, height: 360, useContentSize: true, show: true, backgroundColor: '#000000',
    webPreferences: { preload: path.join(root, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  require(path.join(root, 'mpv-ipc')).attach(win, origin);
  let stats = null, state = '', events = [];
  win.webContents.on('console-message', (e, level, message) => {
    const msg = String((e && typeof e.message === 'string') ? e.message : message || '');
    if (msg.startsWith('STATS ')) { try { stats = JSON.parse(msg.slice(6)); } catch (x) {} }
    else if (msg.startsWith('STATE ')) state = msg.slice(6);
    else if (msg.startsWith('EVENT ')) events.push(msg.slice(6));
  });
  await win.loadURL(origin + '/');
  const t0 = Date.now();
  while (Date.now() - t0 < 90000 && !state && !(stats && stats.frames >= 36)) await new Promise((r) => setTimeout(r, 250));
  if (!stats || stats.frames < 36) return finish(2, { ok: false, why: state || 'too few frames', stats, events });
  // the picture check on the chip (Windows: mpv-gpu.js verify) looks 1.2 s into the play and once more a second later; a
  // wrong picture goes to software, where the page picks the play up — so judge only after that, on frames still coming
  await new Promise((r) => setTimeout(r, 4500));
  for (let n0 = stats.frames, t1 = Date.now(); Date.now() - t1 < 15000; ) {
    await new Promise((r) => setTimeout(r, 500));
    if (stats.frames !== n0) break;
  }
  const look = async () => {
    await new Promise((r) => setTimeout(r, 700));      // (a frame drawn at the canvas's settled size)
    const img = await win.webContents.capturePage(), sz = img.getSize(), px = img.toBitmap();   // BGRA
    const spots = SPOTS.map(([name, fx, fy, want]) => {
      const x = Math.floor(sz.width * fx), y = Math.floor(sz.height * fy), i = (y * sz.width + x) * 4;
      const got = [px[i + 2], px[i + 1], px[i]];
      return { name, got, ok: got.every((v, k) => Math.abs(v - want[k]) <= TOL) };
    });
    return { size: sz, spots, right: spots.every((s) => s.ok), frames: stats.frames };
  };
  const first = await look();
  // then the window changes size: new buffers are made at the new size and the old set is let go of (on Windows the
  // helper closes its handles in this process) — the picture must come back right, and keep coming
  win.setContentSize(800, 450);
  await new Promise((r) => setTimeout(r, 1500));
  const was = stats.frames;
  await new Promise((r) => setTimeout(r, 1000));
  const second = await look(), moving = stats.frames > was;
  const gpu = !!stats.gpu, right = first.right && second.right && moving;
  finish(right && (!needGpu || gpu) ? 0 : 1, { ok: right && (!needGpu || gpu), gpu, picture: right, first, second, moving, stats, events,
    host: require(path.join(root, 'mpv-host')).info(), hw: (require(path.join(root, 'mpv-host')).snapshot() || {}).hw });
});
