// Cursor Local - 主进程（模块化：窗口/截图/测试 + 组装各功能模块）
// 复刻 Cursor 核心体验的本地 AI 编程工具
const { app, BrowserWindow, ipcMain, protocol, net, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { pathToFileURL } = require('url');
const { LocalUserStore } = require('./store/user-store');
const billing = require('./store/billing');

const { loadConfig, saveConfig, configPath, registerConfig } = require('./modules/config');
const { createLog, registerLog } = require('./modules/log');
const { createMemoryModule } = require('./modules/memory');
const { registerFs } = require('./modules/fs');
const { createAgentModule } = require('./modules/agent');
const { createSessionModule } = require('./modules/session');
const { registerAi } = require('./modules/ai');
const { registerAuth } = require('./modules/auth');
const { createGitModule } = require('./modules/git');
const { createTerminalModule } = require('./modules/terminal');
const { createTesting } = require('./main/testing');

let win = null;
const agents = new Map();
let userStore = null;
function getUserStore() {
  if (!userStore) userStore = new LocalUserStore(app.getPath('userData'));
  return userStore;
}

/* ---- 组装依赖 + 模块 ---- */
const winRef = () => win;
const log = createLog(winRef);
const addLog = log.addLog;
const logs = log.logs;

const sessionMod = createSessionModule({ winRef, addLog });
const memoryMod = createMemoryModule();
const agentMod = createAgentModule({ winRef, addLog, loadConfig, agents, saveSession: sessionMod.saveSession, rootDir: __dirname, memory: memoryMod });
const gitMod = createGitModule({ winRef, addLog });
const terminalMod = createTerminalModule({ winRef, addLog });
const { executeTool, runAgent, killChildren, emitAgent, clearPendingApprovals } = agentMod;
const { revertFile } = sessionMod;

/* 开发期自动化（截图 / 回归 / 诊断），仅在对应环境变量激活时运行 */
const testing = createTesting({
  winRef: () => win,
  agents,
  rootDir: __dirname,
  logs,
  config: { loadConfig, saveConfig, configPath },
  agentApi: { executeTool, runAgent, emitAgent },
  sessionApi: { revertFile }
});

registerConfig(ipcMain);
registerLog(ipcMain, log);
registerFs(ipcMain, { winRef, addLog, loadConfig, saveConfig });
agentMod.register(ipcMain);
sessionMod.register(ipcMain);
gitMod.register(ipcMain);
terminalMod.register(ipcMain);
memoryMod.register(ipcMain);
registerAi(ipcMain, { loadConfig });
registerAuth(ipcMain, { getUserStore });

/* 法律条款页（用户协议 / 隐私政策 / 免责声明）—— 独立窗口打开 */
ipcMain.handle('legal:open', () => {
  const already = BrowserWindow.getAllWindows().find((w) => w.__isLegal && !w.isDestroyed());
  if (already) { already.show(); already.focus(); already.moveTop(); return true; }
  const w = new BrowserWindow({
    width: 1000, height: 920, minWidth: 560, minHeight: 480,
    title: '法律条款 · Cursor Local',
    autoHideMenuBar: true,
    backgroundColor: '#F7F6F2',
    center: true,
    show: false, // 等内容就绪再显示，避免白屏闪烁
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false }
  });
  w.__isLegal = true;
  w.once('ready-to-show', () => { w.show(); w.focus(); w.moveTop(); });
  // 兜底：若 ready-to-show 未触发，1.5s 后强制显示
  setTimeout(() => { if (!w.isDestroyed() && !w.isVisible()) { w.show(); w.focus(); } }, 1500);
  w.on('closed', () => { w.__isLegal = false; });
  w.loadFile(path.join(__dirname, 'renderer', 'legal.html'));
  return true;
});
/* 供「不同意条款」等场景优雅退出 */
ipcMain.handle('app:quit', () => { app.quit(); return true; });

ipcMain.handle('billing:query', (_e, userId) => billing.queryBilling(userId));
// 窗口全屏切换（F11）
ipcMain.handle('window:toggleFullscreen', () => {
  const w = BrowserWindow.getFocusedWindow() || (winRef ? winRef() : null);
  if (w && !w.isDestroyed()) w.setFullScreen(!w.isFullScreen());
  return true;
});
// 窗口控制（自绘标题栏）
ipcMain.handle('window:minimize', () => {
  const w = BrowserWindow.getFocusedWindow() || (winRef ? winRef() : null);
  if (w && !w.isDestroyed()) w.minimize();
  return true;
});
ipcMain.handle('window:maximize', () => {
  const w = BrowserWindow.getFocusedWindow() || (winRef ? winRef() : null);
  if (w && !w.isDestroyed()) { if (w.isMaximized()) w.unmaximize(); else w.maximize(); }
  return true;
});
ipcMain.handle('window:close', () => {
  const w = BrowserWindow.getFocusedWindow() || (winRef ? winRef() : null);
  if (w && !w.isDestroyed()) w.close();
  return true;
});
// 选择文件夹（克隆仓库等）
ipcMain.handle('dialog:pickFolder', async () => {
  const w = winRef ? winRef() : null;
  const opts = { properties: ['openDirectory', 'createDirectory'] };
  const r = w && !w.isDestroyed() ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? null : r.filePaths[0];
});

/* ---------------- 截图验证（SHOT_MODE） ---------------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    frame: false, // 无边框（自绘标题栏 + 透明窗口，Win10 也透出桌面）
    transparent: !process.env.SHOT_MODE, // 透明窗口透出桌面；截图模式非透明（transparent 窗口 Windows 截图会 0 字节）
    backgroundColor: process.env.SHOT_MODE ? '#1e1e1e' : '#00000000',
    title: 'Cursor Local',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('console-message', (a, b, c) => {
    let level, msg;
    if (typeof b === 'number') { level = b; msg = c; }
    else if (a && typeof a === 'object') { level = a.level; msg = a.message; }
    else { level = '?'; msg = String(a); }
    if (level === 'error') console.log('[console:error]', msg);
  });
  win.webContents.on('did-finish-load', () => {
    if (process.env.TEST_AGENT) testing.runAgentTest();
    else if (process.env.DIAG) testing.runDiag();
    else if (process.env.TEST_LEGAL) testing.runLegalTest();
    else if (process.env.TEST_CONSENT) testing.runConsentTest();
    else if (process.env.SHOT_MODE) testing.takeScreenshots();
  });
}

/* 视觉诊断（DIAG 模式，临时调试用） */

// monaco:// 协议：让 worker 以同源方式加载 Monaco 语言服务（file:// 的 opaque origin 会禁 importScripts）
protocol.registerSchemesAsPrivileged([
  { scheme: 'monaco', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

app.whenReady().then(() => {
  protocol.handle('monaco', (request) => {
    try {
      const u = new URL(request.url);
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      const safe = path.normalize(rel).replace(/^(\.\.[\/\\])+/, '');
      const filePath = path.join(__dirname, 'node_modules', 'monaco-editor', 'min', 'vs', safe);
      return net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
  createWindow();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  for (const a of agents.values()) { clearPendingApprovals(a); killChildren(a); }
});
