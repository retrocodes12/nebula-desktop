const { app, BrowserWindow, Menu, dialog, ipcMain, screen, session, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

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
