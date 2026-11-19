const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

for (const platform of ['darwin', 'win32', 'linux']) test(`desktop lifecycle and packaged window options on ${platform}`, async () => {
  const app = new EventEmitter();
  Object.assign(app, { commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), getPath: () => '/tmp/player-user', setAboutPanelOptions() {}, quit() {} });
  const windows = [];
  const ipcHandlers = new Map();
  const ipcListeners = new Map();
  class Window extends EventEmitter {
    static getAllWindows() { return windows.filter(w => !w.closed); }
    static fromWebContents(webContents) { return windows.find(w => w.webContents === webContents) || null; }
    constructor(options) { super(); this.options = options; this.bounds = { x: options.x || 0, y: options.y || 0, width: options.width || 0, height: options.height || 0 }; this.webContents = new EventEmitter(); this.webContents.reload = () => { this.reloads = (this.reloads || 0) + 1; }; this.webContents.sent = []; this.webContents.send = (channel, ...args) => { this.webContents.sent.push({ channel, args }); }; this.webContents.isLoading = () => false; this.webContents.setWindowOpenHandler = handler => { this.open = handler; }; windows.push(this); }
    async loadURL(url) { this.loadedUrl = url; this.emit('ready-to-show'); }
    getBounds() { return this.bounds; }
    setBounds(bounds) { this.bounds = { ...this.bounds, ...bounds }; this.boundsSet = bounds; this.emit('resize'); }
    isMinimized() { return false; }
    restore() {}
    isVisible() { return this.visible !== false; }
    hide() { this.visible = false; }
    close() { this.closed = true; this.emit('closed'); }
    destroy() { this.closed = true; this.emit('closed'); }
    isDestroyed() { return Boolean(this.closed); }
    setAlwaysOnTop(value, level) { this.alwaysOnTop = value; this.alwaysOnTopLevel = level; }
    setVisibleOnAllWorkspaces(value) { this.visibleOnAllWorkspaces = value; }
    setAspectRatio(value) { this.aspectRatio = value; }
    setContentProtection(value) { this.contentProtection = value; }
    setOpacity(value) { this.opacity = value; }
    show() { this.shown = true; this.visible = true; }
    focus() {}
  }
  let starts = 0;
  let lastMenuTemplate = [];
  let openedUrl = null;
  const context = { console, process: { platform, env: {} }, __dirname: '/repo/src/electron', setTimeout,
    require(name) {
      if (name === 'electron') return { app, BrowserWindow: Window,
        ipcMain: {
          handle(channel, handler) { ipcHandlers.set(channel, handler); },
          on(channel, handler) { ipcListeners.set(channel, handler); }
        },
        globalShortcut: { register: () => true, unregister() {}, unregisterAll() {} },
        screen: {
          getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
          getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
          getCursorScreenPoint: () => ({ x: 0, y: 0 })
        },
        Menu: { buildFromTemplate(tmpl) { lastMenuTemplate = tmpl; return tmpl; }, setApplicationMenu() {} },
        shell: { openExternal: async (url) => { openedUrl = url; }, openPath: async () => {} },
        dialog: { showErrorBox() {}, showMessageBox: async () => ({ response: 0 }) } };
      if (name === '../server/index.js') return { startServer: async () => { starts++; return { server: { close() {} }, port: 8899 }; } };
      if (name === '../server/services/logger') return require('../../src/server/services/logger');
      return require(name);
    } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../src/electron/main.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(windows[0].shown, true);
  windows[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(windows[0].reloads, 1);
  assert.ok(require('../../package.json').build.files.includes('build/icon.png'));
  if (platform === 'win32') {
    assert.equal(windows[0].options.titleBarStyle, 'hidden');
    assert.equal(windows[0].options.titleBarOverlay.height, 40);
    assert.ok(require('../../package.json').build.files.includes('build/icon.ico'));
  }
  windows[0].closed = true;
  windows[0].emit('closed');
  app.emit('activate');
  app.emit('activate');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 1);
  for (const name of ['will-navigate', 'will-redirect']) {
    let blocked = 0;
    for (const url of ['bad url', 'file:///etc/passwd', 'https://elsewhere.example']) windows[1].webContents.emit(name, { preventDefault() { blocked++; } }, url);
    assert.equal(blocked, 3);
  }
  assert.equal(windows[1].shown, true);
  assert.equal(windows.length, 2);
  assert.equal(windows[1].open({ url: 'file:///etc/passwd' }).action, 'deny');
  const helpMenu = lastMenuTemplate.find(m => m.label === '帮助');
  assert.ok(helpMenu);
  const aboutHelp = helpMenu.submenu.find(i => i.label === '关于 红果开源播放器');
  assert.ok(aboutHelp);
  aboutHelp.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(openedUrl, 'https://github.com/zfdang/hongguo-open-player');

  // 摸鱼小窗：主窗口可通过 IPC 打开置顶迷你播放器，并复用同一个小窗。
  const miniOpen = ipcHandlers.get('mini:open');
  assert.ok(miniOpen);
  const sender = windows[1].webContents;
  const opened = await miniOpen({ sender }, { seriesId: '123', seriesTitle: '测试短剧', episodeIndex: 3, positionSec: 12.5 });
  assert.equal(opened.ok, true);
  assert.equal(opened.reused, false);
  const mini = windows[2];
  assert.ok(mini);
  assert.equal(mini.options.frame, false);
  assert.equal(mini.options.alwaysOnTop, true);
  assert.equal(mini.alwaysOnTop, true);
  assert.equal(mini.alwaysOnTopLevel, 'floating');
  assert.equal(mini.options.minWidth, 220);
  assert.equal(mini.options.minHeight, 124);
  assert.equal(mini.contentProtection, true);
  assert.ok(mini.options.webPreferences.preload.endsWith('/preload.js'));
  assert.match(mini.loadedUrl, /\/\?mini=1&series=123&title=/);
  assert.match(mini.loadedUrl, /&episode=3&position=12\.500$/);
  assert.equal(mini.shown, true);
  // 视频元数据就绪后窗口自动贴合画面真实宽高（横屏 16:9 → 320x180），不再固定 9:16。
  const fitVideo = ipcListeners.get('mini:fit-video');
  assert.ok(fitVideo);
  fitVideo({ sender: mini.webContents }, { width: 1920, height: 1080 });
  assert.equal(mini.bounds.width, 320);
  assert.equal(mini.bounds.height, 180);
  const reopened = await miniOpen({ sender }, { seriesId: '456' });
  assert.equal(reopened.ok, true);
  assert.equal(reopened.reused, true);
  assert.equal(windows.length, 3);
  const denied = await miniOpen({ sender: new EventEmitter() }, { seriesId: '456' });
  assert.equal(denied.ok, false);

  // 小窗进度同步：小窗上报播放进度，小窗直接关闭后主窗口收到 main:mini-closed
  const syncProgress = ipcListeners.get('mini:sync-progress');
  assert.ok(syncProgress);
  syncProgress({ sender: mini.webContents }, { seriesId: '456', seriesTitle: '第二部', episodeIndex: 2, positionSec: 33.4 });
  mini.close();
  const closedMsg = windows[1].webContents.sent.find(msg => msg.channel === 'main:mini-closed');
  assert.ok(closedMsg);
  assert.equal(closedMsg.args[0].seriesId, '456');
  assert.equal(closedMsg.args[0].episodeIndex, 2);
  assert.equal(closedMsg.args[0].positionSec, 33.4);
});

test('packaging artifact names use english hongguo-open-player without breaking chinese productName', () => {
  const pkg = require('../../package.json');
  assert.equal(pkg.build.productName, '红果开源播放器');
  assert.ok(pkg.build.artifactName.startsWith('${name}-'));
  assert.equal(pkg.build.mac.artifactName, '${name}-${version}-mac-${arch}.${ext}');
  assert.equal(pkg.build.win.artifactName, '${name}-${version}-win-${arch}.${ext}');
  assert.equal(pkg.build.nsis.artifactName, '${name}-${version}-win-${arch}-setup.${ext}');
  assert.equal(pkg.build.portable.artifactName, '${name}-${version}-win-${arch}-portable.${ext}');
  for (const pattern of [
    pkg.build.artifactName,
    pkg.build.mac.artifactName,
    pkg.build.win.artifactName,
    pkg.build.nsis.artifactName,
    pkg.build.portable.artifactName,
  ]) {
    assert.ok(/^[\w-${}.]+$/.test(pattern), `Pattern ${pattern} contains disallowed characters`);
  }
});
