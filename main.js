const { app, BrowserWindow, Menu, dialog, ipcMain, net, screen, session, shell } = require('electron');
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
// FFmpeg and FFprobe fetch the file as the page itself does — the same User-Agent, so a host that served the
// player serves them too (ffmpeg's own "Lavf" name is what hosts block) — and ride out a dropped connection.
function netArgs() {
  let ua = 'NebulaPlayer';
  try { ua = session.defaultSession.getUserAgent() || ua; } catch (e) {}
  return ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '4', '-user_agent', ua];
}

// What the file holds: duration, the video codec, every audio and subtitle track. When FFprobe cannot read it,
// what the host did instead (a 403, a page) — the player turns that into a sentence.
function probe(src, res) {
  // the track list sits in the header: a second of packets is plenty, and keeps a 25 Mbps remux from costing 16 MB per play
  const ff = spawn(FFPROBE, ['-v', 'error', ...netArgs(), '-print_format', 'json', '-show_streams', '-show_format', '-analyzeduration', '1M', '-probesize', '5M', src], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  const timer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch (e) {} }, 25000);
  ff.stdout.on('data', (d) => { out += d; });
  ff.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-4000); });
  // a spawn that fails (the binary gone or busy while an update replaces the unpacked files, no file
  // descriptors left) emits 'error' — unhandled, that is an uncaught exception in the main process
  ff.on('error', (e) => {
    clearTimeout(timer);
    if (res.headersSent) return;
    res.statusCode = 502; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'probe failed', http: 0, notmedia: false, detail: 'ffprobe could not start: ' + (e && e.message || e) }));
  });
  ff.on('close', () => {
    clearTimeout(timer);
    if (res.headersSent) return;
    let j = null; try { j = JSON.parse(out); } catch (e) {}
    if (!j || !Array.isArray(j.streams) || !j.streams.length) {
      const http = /(?:HTTP error|Server returned) (\d{3})/.exec(err);
      const body = { error: 'probe failed', http: http ? Number(http[1]) : 0, notmedia: /Invalid data found|does not contain any stream/i.test(err), detail: err.trim().slice(-200) };
      res.statusCode = 502; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); return;
    }
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
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...netArgs(), '-ss', String(t), '-i', src, '-to', String(t + len),
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
  ff.on('error', (e) => { console.error('ffmpeg seg spawn', e && e.message || e); try { res.destroy(); } catch (e2) {} });   // never an uncaught exception
  ff.on('close', (code) => { if (code && !res.writableEnded) { try { res.destroy(); } catch (e) {} } if (code) console.error('ffmpeg seg exit', code, err.trim().slice(-300)); });
}

// ---- In-app update. The installer build asks GitHub for the newest release through electron-updater:
// the latest.yml beside the installer names the file and its sha512, the blockmap makes the download
// differential, and the installer runs silently on restart into the same folder. The portable build
// cannot be replaced by an installer: it downloads the new portable exe beside the running one, steps
// its own file aside (Windows lets a running exe be renamed, not overwritten), gives the new file its
// name and starts it once this process has gone. A dev checkout does neither.
// On Linux the same electron-updater does both shapes from latest-linux.yml (which lists BOTH files):
// the AppImage is swapped for the new one in place and restarted, the .deb is handed to dpkg, which
// asks for a password first. An unpacked build is neither and takes the web path like a dev checkout.
// NEBULA_UPDATE_FEED=<url> points every kind at a local feed (the rigs); NEBULA_UPDATE_DELAY=<ms> moves the first check.
const UPDATE_REPO = 'https://github.com/retrocodes12/nebula-desktop';
const PORTABLE_FILE = process.env.PORTABLE_EXECUTABLE_FILE || '';
const APPIMAGE_FILE = process.env.APPIMAGE || '';
const UPDATE_FEED = process.env.NEBULA_UPDATE_FEED || '';
// electron-builder writes resources/package-type into the deb and rpm builds, and electron-updater
// reads that same file to choose its installer — so it is also the honest answer to "how was this installed".
const PACKAGE_TYPE = (() => {
  try { return fs.readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim(); } catch (e) { return ''; }
})();
// How this copy can replace itself. 'dev' never checks: a checkout, or a build unpacked by hand
// (a tar.gz, `--dir`), which has no path back to a release and takes the player's web nudge instead.
const UPDATE_KIND = (() => {
  if (PORTABLE_FILE) return 'portable';        // the Windows portable exe names itself in the environment
  if (APPIMAGE_FILE) return 'appimage';        // so does the AppImage runtime
  if (PACKAGE_TYPE === 'deb') return 'deb';
  if (!app.isPackaged && !UPDATE_FEED) return 'dev';
  // packaged with nothing above to say how: a Windows install, or a Linux build unpacked by hand, which
  // has no release to go back to. (UPDATE_FEED is the rigs pointing a build at a local feed — it checks.)
  return (process.platform === 'linux' && !UPDATE_FEED) ? 'dev' : 'setup';
})();
// (app.getVersion() is package.json's version for the packaged app and for `electron <app dir>`; a dev run of
// `electron main.js` gets Electron's own — that run is kind 'dev' and never checks)
const upd = {
  kind: UPDATE_KIND, plat: process.platform === 'win32' ? 'windows' : (process.platform === 'linux' ? 'linux' : ''),
  version: app.getVersion(), state: 'idle', latest: '', notes: '', percent: 0, transferred: 0, total: 0, file: '', error: '', manual: false,
};
let mainWin = null;
function updSet(patch) {
  Object.assign(upd, patch);
  try { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('nebula:update', upd); } catch (e) {}
  return upd;
}
// a newer than b, on the three numbers (a leading "v" ignored)
function newerVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number), pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x > y; }
  return false;
}
function updErrorText(e) {
  const code = (e && e.code) || '', msg = String((e && e.message) || e || '');
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|net::ERR|fetch failed/i.test(code + ' ' + msg)) return 'No connection to the update server.';
  if (/ERR_UPDATER_(LATEST_VERSION_NOT_FOUND|CHANNEL_FILE_NOT_FOUND|NO_PUBLISHED_VERSIONS)/.test(code) || /HTTP 404/.test(msg)) return 'The update server has no release to offer.';
  if (/sha512|checksum/i.test(msg)) return 'The download did not match its checksum. Try again.';
  return 'Could not update: ' + msg.split('\n')[0].slice(0, 140);
}
// the release body from GitHub arrives as HTML; one plain sentence of it is enough for a banner
function notesText(rn) {
  const s = Array.isArray(rn) ? rn.map((n) => (n && n.note) || '').join(' ') : String(rn || '');
  return s.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;|&#\d+;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}
// a per-machine install (Program Files, chosen in the assisted installer) needs elevation for a silent update:
// Windows will ask, so the player says so before the restart. A per-user install and the portable build never do.
// The .deb is always in this class: dpkg writes to /opt, so the update runs through pkexec or sudo.
const ELEVATED = (() => {
  if (UPDATE_KIND === 'deb') return true;
  if (process.platform !== 'win32' || !app.isPackaged || PORTABLE_FILE) return false;
  try { const p = path.join(path.dirname(process.execPath), '.nebula-write-test'); fs.writeFileSync(p, ''); fs.unlinkSync(p); return false; } catch (e) { return true; }
})();
upd.elevated = ELEVATED;
let updater = null;
function getUpdater() {
  if (updater) return updater;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = false;
  // never on a plain quit: that install runs with no relaunch, and a person who reopens Nebula inside those seconds
  // gets the fresh instance killed by the installer. The Restart button is the one way in (--force-run relaunches).
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;
  if (UPDATE_FEED) { autoUpdater.forceDevUpdateConfig = true; autoUpdater.setFeedURL({ provider: 'generic', url: UPDATE_FEED }); }
  autoUpdater.on('checking-for-update', () => updSet({ state: 'checking', error: '' }));
  autoUpdater.on('update-available', (info) => updSet({ state: 'available', latest: info.version, notes: notesText(info.releaseNotes) }));
  autoUpdater.on('update-not-available', (info) => updSet({ state: 'current', latest: info.version }));
  autoUpdater.on('download-progress', (p) => updSet({ state: 'downloading', percent: Math.min(100, Math.round(p.percent || 0)), transferred: p.transferred || 0, total: p.total || 0 }));
  autoUpdater.on('update-downloaded', (info) => updSet({ state: 'ready', latest: info.version, file: info.downloadedFile || '', percent: 100 }));
  autoUpdater.on('error', (e) => updSet({ state: 'error', error: updErrorText(e) }));
  updater = autoUpdater;
  return updater;
}
const PORTABLE_DIR = PORTABLE_FILE ? path.dirname(PORTABLE_FILE) : '';
const feedUrl = (name) => (UPDATE_FEED ? new URL(name, UPDATE_FEED).toString() : `${UPDATE_REPO}/releases/latest/download/${name}`);
async function portableCheck() {
  updSet({ state: 'checking', error: '' });
  try {
    const r = await net.fetch(feedUrl('latest.yml'), { headers: { 'Cache-Control': 'no-cache' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const m = /^version:\s*['"]?(\d[^\s'"]*)/m.exec(await r.text());
    if (!m) throw new Error('no version in latest.yml');
    if (newerVersion(m[1], upd.version)) updSet({ state: 'available', latest: m[1], notes: '' });
    else updSet({ state: 'current', latest: m[1] });
  } catch (e) { updSet({ state: 'error', error: updErrorText(e) }); }
  return upd;
}
async function portableDownload() {
  const ver = upd.latest, dest = path.join(PORTABLE_DIR, 'Nebula-Portable.new.exe'), part = dest + '.part';
  updSet({ state: 'downloading', percent: 0, transferred: 0, total: 0 });
  let reader = null, out = null;
  try {
    // pinned to the tag the check saw (the CI names it v<version>): "latest" can point at the previous release for a
    // minute while a release is re-cut, and this must never install a version other than the one the banner named
    const r = await net.fetch(UPDATE_FEED ? feedUrl('Nebula-Portable.exe') : `${UPDATE_REPO}/releases/download/v${ver}/Nebula-Portable.exe`);
    if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
    const total = Number(r.headers.get('content-length')) || 0;
    out = fs.createWriteStream(part);
    // a folder the person cannot write to, or a full disk, fails the stream: that must reach the catch, not hang the loop
    const failed = new Promise((_, no) => out.once('error', no));
    reader = r.body.getReader();
    let got = 0, last = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), failed]);
      if (done) break;
      got += value.length;
      if (!out.write(Buffer.from(value))) await Promise.race([new Promise((ok) => out.once('drain', ok)), failed]);
      if (Date.now() - last > 250) { last = Date.now(); updSet({ state: 'downloading', percent: total ? Math.min(99, Math.round(got * 100 / total)) : 0, transferred: got, total }); }
    }
    await Promise.race([new Promise((ok) => out.end(ok)), failed]);
    if (total && got !== total) throw new Error('the download stopped short');
    fs.renameSync(part, dest);
    updSet({ state: 'ready', latest: ver, file: dest, percent: 100, transferred: got, total });
  } catch (e) {
    try { if (reader) reader.cancel(); } catch (e2) {}
    try { if (out) out.destroy(); } catch (e2) {}
    try { fs.unlinkSync(part); } catch (e2) {}
    updSet({ state: 'error', error: updErrorText(e) });
  }
  return upd;
}
function portableInstall() {
  const old = PORTABLE_FILE.replace(/\.exe$/i, '') + '.old.exe';
  try {
    try { fs.unlinkSync(old); } catch (e) {}
    fs.renameSync(PORTABLE_FILE, old);
    try { fs.renameSync(upd.file, PORTABLE_FILE); } catch (e) { fs.renameSync(old, PORTABLE_FILE); throw e; }
  } catch (e) {
    // could not swap: the new file is there for the person to open by hand
    try { shell.showItemInFolder(upd.file); } catch (e2) {}
    updSet({ state: 'error', error: 'Nebula could not replace itself. The new version is saved beside it as ' + path.basename(upd.file) + ' — close Nebula and open that file.' });
    return upd;
  }
  updSet({ state: 'installing' });
  // the new file starts a few seconds later, when this process (and its single-instance lock) should be gone; the
  // delay is `ping`, because `timeout` refuses to run without a console and this child has none. If the old process
  // is still letting go, the new one keeps asking for the lock for a while (see acquireLock — the .old.exe is its cue).
  try {
    const child = spawn('cmd.exe', ['/d', '/c', 'ping -n 4 127.0.0.1 >nul & start "" "' + PORTABLE_FILE + '"'],
      { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
    child.on('error', () => {});   // no shell to start it with: the swap is done, the person opens Nebula as usual
    child.unref();
  } catch (e) {}
  setTimeout(() => app.quit(), 300);
  return upd;
}
async function updCheck(manual) {
  if (upd.kind === 'dev' || upd.state === 'checking' || upd.state === 'downloading' || upd.state === 'ready' || upd.state === 'installing') return upd;
  upd.manual = !!manual;
  if (upd.kind === 'portable') return portableCheck();
  try { await getUpdater().checkForUpdates(); } catch (e) { updSet({ state: 'error', error: updErrorText(e) }); }
  return upd;
}
async function updDownload() {
  if (upd.kind === 'dev' || upd.state === 'downloading' || upd.state === 'ready' || upd.state === 'installing') return upd;
  upd.manual = true;                               // a person asked: a failure may be said out loud
  if (upd.state !== 'available') { await updCheck(true); if (upd.state !== 'available') return upd; }
  if (upd.kind === 'portable') return portableDownload();
  updSet({ state: 'downloading', percent: 0, transferred: 0, total: 0 });
  try { await getUpdater().downloadUpdate(); } catch (e) { updSet({ state: 'error', error: updErrorText(e) }); }
  return upd;
}
function updInstall() {
  if (upd.state !== 'ready') return upd;
  upd.manual = true;
  if (upd.kind === 'portable') return portableInstall();
  updSet({ state: 'installing' });
  // silent install into the same folder, then the installer starts the new Nebula
  setImmediate(() => { try { getUpdater().quitAndInstall(true, true); } catch (e) { updSet({ state: 'error', error: updErrorText(e) }); } });
  return upd;
}
ipcMain.on('update-info', (event) => { event.returnValue = upd; });
ipcMain.handle('update-check', () => updCheck(true));
ipcMain.handle('update-download', () => updDownload());
ipcMain.handle('update-install', () => updInstall());
function updSchedule() {
  if (upd.kind === 'dev') return;
  if (PORTABLE_FILE) { try { fs.unlinkSync(PORTABLE_FILE.replace(/\.exe$/i, '') + '.old.exe'); } catch (e) {} }   // the file we stepped aside from last time
  const first = Number(process.env.NEBULA_UPDATE_DELAY) || 8000;
  setTimeout(() => updCheck(false), first);
  // a version already found stays found: an offline re-check must not turn "1.62.0 is available" into an error
  setInterval(() => { if (upd.state === 'idle' || upd.state === 'current' || upd.state === 'error') updCheck(false); }, 6 * 3600 * 1000);
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
        // only the player's own page may drive FFmpeg: a browser stamps a request from any other site
        // (a page open in Chrome aiming at this fixed loopback port) as cross-site / same-site / none,
        // while a non-browser caller on this machine sends no such header and already has the machine
        const sfs = String(req.headers['sec-fetch-site'] || '');
        if (sfs && sfs !== 'same-origin') { res.statusCode = 403; res.end('forbidden'); return; }
        const src = u.searchParams.get('src') || '';
        if (!TC_OK) { res.statusCode = 501; res.end('no ffmpeg'); return; }
        if (!httpUrl(src)) { res.statusCode = 400; res.end('bad src'); return; }
        if (u.pathname === '/probe') probe(src, res); else segment(u.searchParams, req, res);
        return;
      }
      let p = decodeURIComponent((req.url || '/').split('?')[0]);
      if (p === '/' || p === '') p = '/index.html';
      const file = path.normalize(path.join(root, p));
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {   // root + sep: a sibling "renderer-x" is not inside
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
  mainWin = win;
  updSchedule();
  // a second launch (double-clicked the icon again) brings this window forward
  app.on('second-instance', () => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
}

// Only one Nebula at a time: a second copy would take the next port and see an empty
// library. Hand its launch to the running window instead — except right after the portable
// build swapped itself (its .old.exe sibling is still there): that launch IS the relaunch, and
// the old process may still be letting go of the lock, so keep asking for a few seconds.
const RELAUNCHED = !!(PORTABLE_FILE && fs.existsSync(PORTABLE_FILE.replace(/\.exe$/i, '') + '.old.exe'));
async function acquireLock() {
  if (app.requestSingleInstanceLock()) return true;
  if (!RELAUNCHED) return false;
  for (let i = 0; i < 40; i++) {
    await new Promise((ok) => setTimeout(ok, 250));
    if (app.requestSingleInstanceLock()) return true;
  }
  return false;
}
acquireLock().then((got) => {
  if (!got) { app.quit(); return; }
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
});
