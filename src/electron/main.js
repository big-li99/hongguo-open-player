// SPDX-License-Identifier: GPL-3.0-only
const { app, BrowserWindow, Menu, shell, dialog, ipcMain, globalShortcut, screen } = require('electron');
const path = require('path');

// 必须在 app.whenReady 之前注入 Chromium 硬件解码与 macOS VideoToolbox HEVC (H.265) 解码开关
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport,PlatformHEVCEncoderSupport');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const BOSS_KEY_ACCELERATOR = 'CommandOrControl+Alt+B';
const BOSS_KEY_LABEL = process.platform === 'darwin' ? '⌘⌥B' : 'Ctrl+Alt+B';

let mainWindow = null;
let miniWindow = null;
let appBaseUrl = '';
let bossKeyRegistered = false;
let serverInstance = null;
let serverStart = null;
let windowCreation = null;
function createWindow() {
  if (mainWindow) { mainWindow.focus(); return Promise.resolve(); }
  windowCreation ||= buildWindow().catch(error => {
    console.error('Window startup failed:', error);
    dialog.showErrorBox('播放器启动失败', '无法启动本地播放服务，请关闭应用后重试。');
    app.quit();
  }).finally(() => { windowCreation = null; });
  return windowCreation;
}

async function buildWindow() {
  // 1. 启动本地内嵌 Node Express 引擎
  if (app.isPackaged === false && !process.env.HONGGUO_BVC2_FFMPEG) {
    process.env.HONGGUO_BVC2_FFMPEG = path.join(__dirname, '../../build/bytevc2', process.arch, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  }
  process.env.HONGGUO_DATA_DIR = path.join(app.getPath('userData'), 'data');
  process.env.HONGGUO_LOG_DIR = path.join(app.getPath('userData'), 'logs');
  let logger;
  try {
    logger = require('../server/services/logger');
  } catch {
    logger = { info() {}, error() {}, warn() {}, debug() {}, getLogDir() { return ''; }, getLogFilePath() { return ''; } };
  }
  logger.info('Electron', `正在启动原生客户端: 架构=${process.arch}, 平台=${process.platform}, 版本=${typeof app.getVersion === 'function' ? app.getVersion() : 'dev'}`);
  const { startServer } = require('../server/index.js');
  serverStart ||= startServer(8899).catch(error => { serverStart = null; throw error; });
  const res = await serverStart;
  serverInstance = res.server;
  const port = res.port;
  appBaseUrl = `http://127.0.0.1:${port}`;

  // 2. 创建原生跨平台桌面窗口 (macOS / Windows / Linux)
  const isMac = process.platform === 'darwin';
  const windowOptions = {
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: '红果开源播放器',
    backgroundColor: '#0f1015',
    autoHideMenuBar: !isMac, // Windows 下默认隐藏传统菜单栏，保持纯粹现代深色观影质感 (按 Alt 唤出)
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      devTools: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false // 待内容准备完毕后再优雅显示，避免白屏
  };

  if (isMac) {
    windowOptions.titleBarStyle = 'hiddenInset'; // 优雅的 macOS 胶囊红绿灯一体化标题栏
    windowOptions.trafficLightPosition = { x: 16, y: 16 };
  } else {
    // Windows uses ICO; Linux uses the shared PNG artwork.
    windowOptions.icon = process.platform === 'win32'
      ? path.join(__dirname, '../../build/icon.ico')
      : path.join(__dirname, '../client/assets/app-icon.png');
    if (process.platform === 'win32') {
      windowOptions.titleBarStyle = 'hidden';
      windowOptions.titleBarOverlay = { color: '#14171f', symbolColor: '#ffffff', height: 40 };
    }
  }

  const window = new BrowserWindow(windowOptions);
  mainWindow = window;
  const appUrl = appBaseUrl;
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url).catch(console.error);
    return { action: 'deny' };
  });
  const guardNavigation = (event, url) => {
    try { if (new URL(url).origin === appUrl) return; } catch (_) {}
    event.preventDefault();
  };
  let recoveryPending = false;
  window.webContents.on('render-process-gone', async (_event, details) => {
    if (details.reason === 'clean-exit' || recoveryPending || mainWindow !== window || window.isDestroyed?.()) return;
    recoveryPending = true;
    try {
      const result = await dialog.showMessageBox(window, {
        type: 'warning', title: '播放器界面已停止', message: '播放器界面意外停止运行',
        detail: '可以重新加载界面，播放进度将从最近保存的位置恢复。',
        buttons: ['重新加载', '稍后处理'], defaultId: 0, cancelId: 1, noLink: true
      });
      if (result.response === 0 && mainWindow === window && !window.isDestroyed?.() && !window.webContents.isDestroyed?.()) window.webContents.reload();
    } catch (error) {
      console.error('Renderer recovery failed:', error);
    } finally {
      recoveryPending = false;
    }
  });
  window.webContents.on('will-navigate', guardNavigation);
  window.webContents.on('will-redirect', guardNavigation);
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await window.loadURL(appUrl);
      break;
    } catch (err) {
      if (attempt === 5) throw err;
      await new Promise(r => setTimeout(r, 200));
    }
  }
}

const GITHUB_REPO_URL = 'https://github.com/zfdang/hongguo-open-player';

// ==================== 摸鱼小窗 (置顶迷你播放器) ====================

function miniWindowBounds() {
  const display = mainWindow && !mainWindow.isDestroyed()
    ? screen.getDisplayMatching(mainWindow.getBounds())
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const margin = 24;
  let height = Math.min(568, area.height - margin * 2);
  let width = Math.round(height * 9 / 16);
  if (width > area.width - margin * 2) {
    width = area.width - margin * 2;
    height = Math.round(width * 16 / 9);
  }
  return {
    width,
    height,
    x: Math.round(area.x + area.width - width - margin),
    y: Math.round(area.y + area.height - height - margin)
  };
}

function buildMiniUrl(payload = {}) {
  const params = [['mini', '1']];
  const seriesId = String(payload.seriesId || '').trim();
  if (seriesId) params.push(['series', seriesId]);
  if (payload.seriesTitle) params.push(['title', String(payload.seriesTitle)]);
  const episode = Number(payload.episodeIndex);
  if (Number.isFinite(episode) && episode > 0) params.push(['episode', String(Math.floor(episode))]);
  const position = Number(payload.positionSec);
  if (Number.isFinite(position) && position > 0) params.push(['position', position.toFixed(3)]);
  return `${appBaseUrl}/?${params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`;
}

function registerBossKey() {
  if (bossKeyRegistered) return;
  try {
    bossKeyRegistered = globalShortcut.register(BOSS_KEY_ACCELERATOR, () => toggleMiniWindow());
  } catch (error) {
    console.error('Boss key registration failed:', error);
  }
  if (!bossKeyRegistered) console.warn(`Global shortcut ${BOSS_KEY_ACCELERATOR} is unavailable`);
}

function unregisterBossKey() {
  if (!bossKeyRegistered) return;
  try {
    globalShortcut.unregister(BOSS_KEY_ACCELERATOR);
  } catch (_) {}
  bossKeyRegistered = false;
}

// 老板键：隐藏时同时通知渲染进程暂停播放，避免只闻其声。
function toggleMiniWindow(forceShow) {
  if (!miniWindow || miniWindow.isDestroyed()) return false;
  const shouldShow = typeof forceShow === 'boolean' ? forceShow : !miniWindow.isVisible();
  if (shouldShow) {
    miniWindow.webContents.send('mini:visibility', true);
    miniWindow.show();
    miniWindow.focus();
  } else {
    miniWindow.webContents.send('mini:visibility', false);
    miniWindow.hide();
  }
  return shouldShow;
}

function notifyMainMiniState(active) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('main:mini-state', Boolean(active));
  }
}

function openMiniWindow(payload = {}) {
  if (!appBaseUrl) return { ok: false, error: '播放服务尚未就绪' };
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.webContents.send('mini:play', payload);
    if (!miniWindow.isVisible()) miniWindow.show();
    miniWindow.focus();
    notifyMainMiniState(true);
    return { ok: true, reused: true };
  }

  const mini = new BrowserWindow({
    ...miniWindowBounds(),
    minWidth: 240,
    minHeight: 426,
    frame: false,
    hasShadow: true,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#000000',
    title: '红果小窗',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      devTools: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  miniWindow = mini;
  mini.setAlwaysOnTop(true, 'floating');
  if (process.platform === 'darwin' && typeof mini.setVisibleOnAllWorkspaces === 'function') {
    mini.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  if (typeof mini.setAspectRatio === 'function') mini.setAspectRatio(9 / 16);
  if (typeof payload.opacity === 'number' && typeof mini.setOpacity === 'function') {
    mini.setOpacity(Math.min(1, Math.max(0.3, payload.opacity)));
  }
  if (typeof mini.setContentProtection === 'function') mini.setContentProtection(payload.protect !== false);

  const appUrl = appBaseUrl;
  mini.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url).catch(console.error);
    return { action: 'deny' };
  });
  const guardNavigation = (event, url) => {
    try { if (new URL(url).origin === appUrl) return; } catch (_) {}
    event.preventDefault();
  };
  mini.webContents.on('will-navigate', guardNavigation);
  mini.webContents.on('will-redirect', guardNavigation);
  mini.once('ready-to-show', () => mini.show());
  mini.on('closed', () => {
    if (miniWindow === mini) miniWindow = null;
    unregisterBossKey();
    notifyMainMiniState(false);
  });
  mini.loadURL(buildMiniUrl(payload)).catch(error => {
    console.error('Mini window failed to load:', error);
  });
  registerBossKey();
  notifyMainMiniState(true);
  return { ok: true, reused: false };
}

function registerMiniIpc() {
  ipcMain.handle('mini:open', (event, payload) => {
    const fromKnownWindow = (mainWindow && event.sender === mainWindow.webContents) ||
      (miniWindow && event.sender === miniWindow.webContents);
    if (!fromKnownWindow) return { ok: false, error: '未授权的窗口' };
    return openMiniWindow(payload || {});
  });

  ipcMain.handle('mini:close', () => {
    if (miniWindow && !miniWindow.isDestroyed()) miniWindow.close();
    return { ok: true };
  });

  ipcMain.handle('mini:return', async (_event, payload = {}) => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) await createWindow();
      if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: '主窗口不可用' };
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      const send = () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('main:open-drama', payload);
      };
      if (mainWindow.webContents.isLoading?.()) mainWindow.webContents.once('did-finish-load', send);
      else send();
      if (miniWindow && !miniWindow.isDestroyed()) miniWindow.close();
      return { ok: true };
    } catch (error) {
      console.error('Return to main window failed:', error);
      return { ok: false, error: '返回主窗口失败' };
    }
  });

  ipcMain.on('mini:hide', () => toggleMiniWindow(false));

  ipcMain.on('mini:always-on-top', (event, value) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && win === miniWindow) win.setAlwaysOnTop(Boolean(value), 'floating');
  });

  ipcMain.on('mini:opacity', (event, value) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== miniWindow || typeof win.setOpacity !== 'function') return;
    const opacity = Number(value);
    win.setOpacity(Number.isFinite(opacity) ? Math.min(1, Math.max(0.3, opacity)) : 1);
  });

  ipcMain.on('mini:protection', (event, value) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && win === miniWindow && typeof win.setContentProtection === 'function') {
      win.setContentProtection(Boolean(value));
    }
  });
}

registerMiniIpc();

function showAboutDialog() {
  const version = typeof app.getVersion === 'function' ? app.getVersion() : '1.0.0';
  const iconPath = process.platform === 'darwin'
    ? path.join(__dirname, '../../build/icon.png')
    : path.join(__dirname, '../client/assets/app-icon.png');
  let icon;
  try {
    const { nativeImage } = require('electron');
    if (nativeImage?.createFromPath && require('node:fs').existsSync(iconPath)) {
      icon = nativeImage.createFromPath(iconPath);
    }
  } catch (_) {}

  dialog.showMessageBox(mainWindow || undefined, {
    type: 'info',
    title: '关于 红果开源播放器',
    message: `红果开源播放器 v${version}`,
    detail: `一款优雅、无广告的开源跨平台红果短剧播放器。\n\n项目开源主页: ${GITHUB_REPO_URL}\n开源许可: GPL-3.0`,
    buttons: ['访问 GitHub 主页', '确定'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    ...(icon ? { icon } : {})
  }).then(result => {
    if (result && result.response === 0) {
      shell.openExternal(GITHUB_REPO_URL).catch(console.error);
    }
  }).catch(console.error);
}

// 构建原生 macOS 菜单栏
function setupMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [
          {
            label: '红果开源播放器',
            submenu: [
              {
                label: '关于 红果开源播放器',
                click: () => showAboutDialog()
              },
              {
                label: '生成新的设备 ID',
                click: () => {
                  if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.executeJavaScript('window.__app?.resetDevice?.()').catch(console.error);
                  }
                }
              },
              { type: 'separator' },
              { role: 'services', label: '服务' },
              { type: 'separator' },
              { role: 'hide', label: '隐藏 红果开源播放器' },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '全部显示' },
              { type: 'separator' },
              { role: 'quit', label: '退出 红果开源播放器' }
            ]
          }
        ]
      : []),
    ...(!isMac ? [{ label: '文件', submenu: [{ role: 'close', label: '关闭窗口' }, { role: 'quit', label: '退出' }] }] : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' },
        { type: 'separator' },
        {
          label: '小窗播放当前剧集（摸鱼模式）',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.executeJavaScript('window.__app?.openMiniPlayer?.()').catch(console.error);
            }
          }
        },
        {
          label: `显示 / 隐藏小窗 (${BOSS_KEY_LABEL})`,
          click: () => toggleMiniWindow()
        }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        ...(isMac
          ? [
              { type: 'separator' },
              { role: 'front', label: '前置全部窗口' },
              { type: 'separator' },
              { role: 'window', label: '窗口' }
            ]
          : [{ role: 'close', label: '关闭' }])
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 红果开源播放器',
          click: () => showAboutDialog()
        },
        {
          label: '生成新的设备 ID',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.executeJavaScript('window.__app?.resetDevice?.()').catch(console.error);
            }
          }
        },
        {
          label: 'GitHub 项目主页',
          click: async () => {
            await shell.openExternal(GITHUB_REPO_URL);
          }
        },
        { type: 'separator' },
        {
          label: '打开日志目录 (Troubleshooting)',
          click: async () => {
            const logger = require('../server/services/logger');
            await shell.openPath(logger.getLogDir());
          }
        },
        {
          label: '查看当前运行日志',
          click: async () => {
            const logger = require('../server/services/logger');
            const logFile = logger.getLogFilePath();
            if (require('node:fs').existsSync(logFile)) {
              await shell.openPath(logFile);
            } else {
              dialog.showMessageBox(mainWindow, { type: 'info', title: '日志文件', message: '暂无日志生成' });
            }
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// 单实例锁定 (Single Instance Lock)
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    if (process.platform === 'darwin' && !app.isPackaged) {
      app.dock?.setIcon(path.join(__dirname, '../../build/icon.png'));
    }
    if (typeof app.setAboutPanelOptions === 'function') {
      app.setAboutPanelOptions({
        applicationName: '红果开源播放器',
        applicationVersion: typeof app.getVersion === 'function' ? app.getVersion() : '1.0.0',
        copyright: 'Copyright © 2026 zfdang. Licensed under GPL-3.0.',
        website: GITHUB_REPO_URL,
        credits: GITHUB_REPO_URL
      });
    }
    setupMenu();
    createWindow().catch((err) => {
      console.error('Failed to create window:', err);
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow().catch(console.error);
      }
    });
  });

  // 所有窗口关闭时退出应用
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('will-quit', () => {
    unregisterBossKey();
    try { globalShortcut.unregisterAll(); } catch (_) {}
  });

  let quitting = false;
  app.on('before-quit', event => {
    if (quitting || !serverInstance) return;
    quitting = true;
    event.preventDefault();
    try { require('../server/services/logger').info('Electron', '应用程序正在退出，保存状态并关闭服务...'); } catch (_) {}
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.destroy();
      mainWindow = null;
    }
    if (miniWindow && !miniWindow.isDestroyed()) {
      miniWindow.destroy();
      miniWindow = null;
    }
    unregisterBossKey();
    try { globalShortcut.unregisterAll(); } catch (_) {}
    require('../server/services/streamService').shutdown();
    serverInstance.close();
    serverInstance.closeAllConnections?.();
    require('../server/services/storeService').pending.catch(console.error).finally(() => app.quit());
  });
}
