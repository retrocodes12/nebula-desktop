const { contextBridge, ipcRenderer } = require('electron');

// Minimal bridge for the shared player: window.nebulaDesktop.setMiniMode(true/false)
// toggles the small always-on-top mini window. The player feature-detects this
// object, so the same index.html works unchanged on web and webOS.
contextBridge.exposeInMainWorld('nebulaDesktop', {
  setMiniMode: (on) => ipcRenderer.invoke('mini-mode', !!on),
});
