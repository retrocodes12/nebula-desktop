const { contextBridge, ipcRenderer } = require('electron');

// Minimal bridge for the shared player. The player feature-detects this object, so
// the same index.html works unchanged on web and webOS.
//   setMiniMode(true/false) — the small always-on-top mini window
//   onFlush(cb)             — the window is closing: write progress and push the cloud NOW
//   transcode               — true when the shell has FFmpeg: /probe and /seg on this origin
//                             turn files Chromium cannot decode into pieces it can
//   update                  — the in-app updater: info (kind setup|portable|appimage|deb|dev, plat, version), check() /
//                             download() / install() each answer with the state, on(cb) streams it
//   relay                   — Share with your TV: info() = {on, port, token, hosts, name, plat, bytes, served, error?},
//                             set(on) flips it (answers with the state), on(cb) streams state changes
//   mpv                     — mpv.js: the full-format player (libmpv in a helper process) draws into the player's canvas.
//                             info() = {available, error, lib, version}; on(cb) streams {type:'state'|'loaded'|'end'|
//                             'available'|…}; attach(canvasId), load(url, opts), command([…]), set(name, value), get(name),
//                             stop(), stats(), subAdd(text, label, lang)
let mpv = null;
try { mpv = require('./mpv'); } catch (e) { mpv = null; }   // a missing native part only means the page keeps its own engine
if (mpv) {
  // the helper goes with the page: a reload or navigation fires pagehide; closing the window does not (the shell destroys
  // it 700 ms after nebula:flush), so the flush lets it go too
  const bye = () => { try { mpv.dispose(); } catch (e) {} };
  window.addEventListener('pagehide', bye);
  ipcRenderer.on('nebula:flush', () => setTimeout(bye, 150));   // after the page has read its last position from mpv
}
contextBridge.exposeInMainWorld('nebulaDesktop', {
  mpv: mpv ? {
    info: () => mpv.info(), on: (cb) => mpv.on(cb), attach: (id) => mpv.attach(id), load: (url, o) => mpv.load(url, o),
    command: (a) => mpv.command(a), set: (n, v) => mpv.set(n, v), get: (n) => mpv.get(n), stop: () => mpv.stop(), stats: () => mpv.stats(),
    subAdd: (text, label, lang) => mpv.subAdd(text, label, lang),
  } : null,
  relay: {
    info: () => ipcRenderer.sendSync('relay-info'),
    set: (on) => ipcRenderer.invoke('relay-set', !!on),
    on: (cb) => { ipcRenderer.on('nebula:relay', (_event, state) => { try { cb(state); } catch (e) {} }); },
  },
  setMiniMode: (on) => ipcRenderer.invoke('mini-mode', !!on),
  onFlush: (cb) => { ipcRenderer.on('nebula:flush', () => { try { cb(); } catch (e) {} }); },
  transcode: ipcRenderer.sendSync('tc-available') === true,
  update: {
    info: ipcRenderer.sendSync('update-info'),
    check: () => ipcRenderer.invoke('update-check'),
    download: () => ipcRenderer.invoke('update-download'),
    install: () => ipcRenderer.invoke('update-install'),
    on: (cb) => { ipcRenderer.on('nebula:update', (_event, state) => { try { cb(state); } catch (e) {} }); },
  },
});
