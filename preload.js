const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('portManager', {
  getPorts: () => ipcRenderer.invoke('get-ports'),
  kill: (pid) => ipcRenderer.invoke('kill-port', pid),
});
