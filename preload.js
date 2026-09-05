const { contextBridge, ipcRenderer } = require('electron');

// Minimal bridge for the shared player. The player feature-detects this object, so
// the same index.html works unchanged on web and webOS.
//   setMiniMode(true/false) — the small always-on-top mini window
//   onFlush(cb)             — the window is closing: write progress and push the cloud NOW
contextBridge.exposeInMainWorld('nebulaDesktop', {
  setMiniMode: (on) => ipcRenderer.invoke('mini-mode', !!on),
  onFlush: (cb) => { ipcRenderer.on('nebula:flush', () => { try { cb(); } catch (e) {} }); },
});
