// SPDX-License-Identifier: GPL-3.0-only
// 仅向渲染进程暴露摸鱼小窗所需的有限 IPC 能力，保持 contextIsolation。
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const handler = (_event, payload) => {
    try {
      callback(payload);
    } catch (error) {
      console.error(`[preload] ${channel} handler failed:`, error);
    }
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('hongguoDesktop', {
  isDesktopApp: true,
  platform: process.platform,
  openMiniPlayer: (payload) => ipcRenderer.invoke('mini:open', payload),
  closeMiniPlayer: () => ipcRenderer.invoke('mini:close'),
  hideMiniPlayer: () => ipcRenderer.send('mini:hide'),
  returnToMainWindow: (payload) => ipcRenderer.invoke('mini:return', payload),
  setMiniAlwaysOnTop: (value) => ipcRenderer.send('mini:always-on-top', Boolean(value)),
  setMiniOpacity: (value) => ipcRenderer.send('mini:opacity', Number(value)),
  setMiniProtection: (value) => ipcRenderer.send('mini:protection', Boolean(value)),
  fitMiniToVideo: (width, height, force = false) => ipcRenderer.send('mini:fit-video', { width: Number(width), height: Number(height), force: Boolean(force) }),
  onMiniPlay: (callback) => subscribe('mini:play', callback),
  onMiniVisibility: (callback) => subscribe('mini:visibility', callback),
  onMiniState: (callback) => subscribe('main:mini-state', callback),
  onOpenDrama: (callback) => subscribe('main:open-drama', callback)
});
