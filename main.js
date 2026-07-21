const { app, BrowserWindow, session, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Serve the player over http://127.0.0.1 instead of file:// — Chromium blocks EME
// (ClearKey) on file:// (opaque) origins, so a localhost origin is required for DRM.
function startServer() {
  return new Promise((resolve, reject) => {
    const root = path.join(__dirname, 'renderer');
    const mime = {
      '.html': 'text/html; charset=utf-8', '.js': 'application/javascript',
      '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml',
      '.json': 'application/json', '.ico': 'image/x-icon',
    };
    const server = http.createServer((req, res) => {
      try {
        let p = decodeURIComponent((req.url || '/').split('?')[0]);
        if (p === '/' || p === '') p = '/index.html';
        const file = path.normalize(path.join(root, p));
        if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          res.statusCode = 404; res.end('not found'); return;
        }
        res.setHeader('Content-Type', mime[path.extname(file).toLowerCase()] || 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
      } catch (e) {
        res.statusCode = 500; res.end('error');
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
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
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  // Open external links (e.g. the phone-pairing page) in the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // The window must only ever show the local player — send any in-window
  // navigation attempt to the OS browser instead.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}/`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  win.loadURL(`http://127.0.0.1:${port}/index.html`);
}

app.whenReady().then(createWindow);
// Without this, closing the window leaves Nebula (and its local server) running forever.
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => app.quit());
