const { contextBridge, ipcRenderer } = require('electron');
// The detached window receives map operations only, never staff, billing or database selection IPC.
contextBridge.exposeInMainWorld('demo', {
  mapWindowContext: () => ipcRenderer.invoke('map:window-context'),
  mapContext: (payload) => ipcRenderer.invoke('map:context', payload),
  saveMapLocation: (payload) => ipcRenderer.invoke('map:save', payload),
  onMapChanged: (callback) => ipcRenderer.on('map:changed', () => callback()),
});
