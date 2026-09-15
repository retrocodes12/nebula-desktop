'use strict';
// The full-format player, wired to the window (main process). The page calls through preload.js over IPC — only this
// window's own top frame is listened to — and mpv-host.js checks every call before mpv sees it; mpv's news and a picture of
// its state four times a second go back as 'nebula:mpv'. While a film plays unpaused the display is kept awake: the page's
// <video> sits idle under mpv, so Chromium's own wake lock is not held for it.
const { app, ipcMain, powerSaveBlocker } = require('electron');
let host = null, blocker = -1;                          // blocker: the display-sleep block while a film plays
try { host = require('./mpv-host'); } catch (e) { host = null; }

function attach(win, origin) {
  ['mpv-info', 'mpv-load', 'mpv-set', 'mpv-command', 'mpv-stop'].forEach((c) => ipcMain.removeAllListeners(c));
  ['mpv-sub', 'mpv-grant'].forEach((c) => ipcMain.removeHandler(c));
  if (!host) {
    ipcMain.on('mpv-info', (e) => { e.returnValue = { available: false, error: 'the full-format player is missing from this build', lib: '', version: '', base: '' }; });
    return;
  }
  host.setOrigin(origin);
  const wc = win.webContents;
  const own = (e) => e.sender === wc && e.senderFrame === wc.mainFrame;
  const send = (m) => { if (!win.isDestroyed()) wc.send('nebula:mpv', m); };
  let ticker = null;
  const awake = (on) => {
    if (on && blocker < 0) blocker = powerSaveBlocker.start('prevent-display-sleep');
    else if (!on && blocker >= 0) { try { powerSaveBlocker.stop(blocker); } catch (e) {} blocker = -1; }
  };
  // awake only while a film plays in a window someone can see (not paused, not minimised)
  const tick = () => { send({ type: 'state', s: host.snapshot() }); awake(host.playing() && win.isVisible() && !win.isMinimized()); };
  const run = (on) => {
    if (on && !ticker) ticker = setInterval(tick, 250);
    else if (!on && ticker) { clearInterval(ticker); ticker = null; awake(false); setTimeout(() => { if (!ticker) send({ type: 'state', s: host.snapshot() }); }, 400); }   // one last word: stopped, idle
  };
  host.on((m) => { send(m); });
  ipcMain.on('mpv-info', (e) => { e.returnValue = own(e) ? host.info() : null; });
  ipcMain.on('mpv-load', (e, url, o) => { if (own(e)) { host.load(url, o); run(true); } });
  ipcMain.on('mpv-set', (e, k, v) => { if (own(e)) host.set(k, v); });
  ipcMain.on('mpv-command', (e, a) => { if (own(e)) host.command(a); });
  ipcMain.on('mpv-stop', (e) => { if (own(e)) { host.stop(); run(false); } });
  ipcMain.handle('mpv-sub', (e, text, label, lang) => (own(e) ? host.subAdd(text, label, lang) : null));
  ipcMain.handle('mpv-grant', (e, p) => (own(e) ? host.grant(p) : ''));
  // which libmpv works here, a moment after launch: Settings knows before the first play
  setTimeout(() => { host.probe().catch(() => {}); }, 2500);
  win.on('closed', () => { run(false); host.dispose(); });
}

const awake = () => blocker >= 0;
app.nebulaAwake = awake;                                // read-only, for the rigs (the main process's own object)
module.exports = { attach, awake };
