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
  const already = BrowserWindow.getAllWindows().find((w) => w.__isLegal);
  if (already) { already.focus(); return true; }
  const w = new BrowserWindow({
    width: 1000, height: 920, minWidth: 560, minHeight: 480,
    title: '法律条款 · Cursor Local',
    autoHideMenuBar: true,
    backgroundColor: '#F7F6F2',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false }
  });
  w.__isLegal = true;
  w.loadFile(path.join(__dirname, 'renderer', 'legal.html'));
  return true;
});
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
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function captureTo(file) {
  win.webContents.invalidate();
  await sleep(600);
  const img = await win.webContents.capturePage();
  const png = img.toPNG();
  fs.writeFileSync(file, png);
  console.log('[shot]', path.basename(file), png.length, 'bytes');
}

let screenshotRunning = false;
async function takeScreenshots() {
  if (screenshotRunning) return; // 防重入：did-finish-load 可能触发多次
  screenshotRunning = true;
  const shotDir = path.join(__dirname, 'screenshots');
  fs.mkdirSync(shotDir, { recursive: true });
  try {
    await sleep(2500); // 等待 monaco 加载

    // 1. 主页
    const homeDbg = await win.webContents.executeJavaScript(`(async () => {
      const hc = document.getElementById('home-view').className;
      const bootDebug = window.__bootDebug || null;
      const bootError = window.__bootError || null;
      if (typeof switchMode === 'function') switchMode('home');
      return JSON.stringify({
        homeClassBefore: hc,
        homeActiveNow: document.getElementById('home-view').classList.contains('active'),
        bootDebug, bootError,
        themeCards: document.querySelectorAll('.theme-card').length,
        orbs: document.querySelectorAll('.orb').length,
        recentCards: document.querySelectorAll('.recent-card').length,
        composer: !!document.getElementById('home-composer'),
        snavItems: document.querySelectorAll('.snav-item').length,
        accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
        lucideIcons: document.querySelectorAll('svg.lucide').length
      });
    })()`);
    console.log('[debug home]', homeDbg);
    // 锁屏断言：boot 后应显示锁屏页，点击后退场
    const ls = await win.webContents.executeJavaScript(`(async () => {
      const el = document.getElementById('lockscreen');
      const before = el ? !el.classList.contains('leaving') : false;
      const clock = document.getElementById('ls-clock');
      if (el) el.click();
      await new Promise((r) => setTimeout(r, 800));
      const after = !!document.getElementById('lockscreen');
      return JSON.stringify({ shown: before, clockText: clock ? clock.textContent : 'none', removed: !after });
    })()`);
    console.log('[debug lockscreen]', ls);
    await captureTo(path.join(shotDir, '01-home.png'));

    // 2. Editor
    await win.webContents.executeJavaScript(
      `window.__openFolderForDemo(${JSON.stringify(__dirname)}); switchMode('editor');`
    );
    await sleep(1000);
    const dbg = await win.webContents.executeJavaScript('JSON.stringify(window.__debugState())');
    console.log('[debug editor]', dbg);
    // 选区颜色诊断：从主题服务读取实际选区颜色值
    const deco = await win.webContents.executeJavaScript(`(async () => {
      const ed = EditorState.editor;
      const theme = ed._themeService && ed._themeService.getColorTheme();
      const c = theme ? theme.getColor('editor.selectionBackground') : null;
      return JSON.stringify({ selection: c ? c.toString() : 'none', themeName: ed._themeService ? ed._themeService.getColorTheme().themeName : '?' });
    })()`);
    console.log('[debug deco]', deco);
    const themeTest = await win.webContents.executeJavaScript(`(async () => {
      const r = {};
      try {
        await setTheme('violet', null);
        r.violet = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
        await setTheme('custom', '#10b981');
        r.custom = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
        await setTheme('blue', null);
        r.blue = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      } catch (e) { r.err = String(e.message || e); }
      return JSON.stringify(r);
    })()`);
    console.log('[debug theme]', themeTest);
    await captureTo(path.join(shotDir, '02-editor.png'));

    // 3. Agents
    await win.webContents.executeJavaScript(`switchMode('agents'); window.__demoAgentEntry();`);
    await sleep(800);
    const dbg2 = await win.webContents.executeJavaScript('JSON.stringify(window.__debugAgents())');
    console.log('[debug agents]', dbg2);
    await captureTo(path.join(shotDir, '03-agents.png'));

    // 新功能断言：命令面板 / 全局搜索 / AI 补全开关
    const feat = await win.webContents.executeJavaScript(`(async () => {
      const r = { palette: typeof window.openPalette, search: typeof window.openGlobalSearch, toggle: !!document.getElementById('cfg-ai-complete'), monaco: typeof monaco };
      if (window.openPalette) { window.openPalette(); r.cpItems = document.querySelectorAll('.cp-item').length; const el = document.querySelector('.cmd-palette'); if (el) el.classList.add('hidden'); }
      return JSON.stringify(r);
    })()`);
    console.log('[debug features]', feat);
    // 命令/快捷键系统断言
    const km = await win.webContents.executeJavaScript(`(async () => {
      const cmds = (typeof window.getCommandList === 'function') ? window.getCommandList() : [];
      return JSON.stringify({
        cmdCount: cmds.length,
        cmdSample: cmds.slice(0, 3).map((c) => c.id + ':' + c.key).join(', '),
        formatKey: typeof window.formatKeyEvent,
        ctxMenuReady: !!window.__ctxMenuReady,
        setKeybinding: typeof window.setKeybinding,
        applyAiEdit: typeof window.applyAiEdit,
        inlineChat: typeof window.openInlineChat,
        diagnose: typeof window.openDiagnose,
        monacoTheme: window.__monacoThemeApplied || 'n/a',
        tabDraggable: !!document.querySelector('.tab[draggable="true"]')
      });
    })()`);
    console.log('[debug keymap]', km);
    // 文件操作 IPC 往返验证
    const fsops = await win.webContents.executeJavaScript(`(async () => {
      const base = window.api.pathJoin(${JSON.stringify(__dirname)}, '.fs-test');
      try {
        await window.api.createDir(base);
        await window.api.createFile(window.api.pathJoin(base, 'a.txt'));
        await window.api.rename(window.api.pathJoin(base, 'a.txt'), window.api.pathJoin(base, 'b.txt'));
        await window.api.deletePath(base);
        return JSON.stringify({ ok: true, treeMenuFn: typeof showFileTreeMenu });
      } catch (e) { return JSON.stringify({ ok: false, err: String(e) }); }
    })()`);
    console.log('[debug fsops]', fsops);
    // Git 面板断言
    const gitTest = await win.webContents.executeJavaScript(`(async () => {
      const r = await window.api.gitStatus(${JSON.stringify(__dirname)});
      let sb = { ok: false };
      try { const d = await window.api.gitSideBySide(${JSON.stringify(__dirname)}, 'main.js', false); sb = { ok: typeof d.old === 'string' && typeof d.new === 'string', oldLen: (d.old||'').length, newLen: (d.new||'').length }; } catch (e) { sb.err = String(e); }
      return JSON.stringify({ ok: r.ok, branch: r.branch, staged: (r.staged||[]).length, unstaged: (r.unstaged||[]).length, panelFn: typeof window.openGitPanel, sideBySide: sb });
    })()`);
    console.log('[debug git]', gitTest);
    // 终端验证：xterm 渲染 + 终端创建 + 命令往返
    const termTest = await win.webContents.executeJavaScript(`(async () => {
      window.openTerminal();
      await new Promise((r) => setTimeout(r, 1500));
      const xtermEl = document.querySelector('.term-panel .xterm');
      let echoed = false;
      try {
        const id = await window.api.terminalCreate(null);
        let acc = '';
        const off = new Promise((res) => {
          window.api.onTerminalData(({ id: rid, data }) => {
            if (rid === id) { acc += data; if (acc.includes('HELLO_TERM')) res(true); }
          });
        });
        await window.api.terminalInput(id, 'echo HELLO_TERM\\r\\n');
        echoed = await Promise.race([off, new Promise((r) => setTimeout(() => r(false), 3000))]);
        window.api.terminalKill(id);
      } catch (e) { /* 忽略 */ }
      return JSON.stringify({
        xtermLib: typeof window.Terminal,
        panelVisible: !document.querySelector('.term-panel').classList.contains('hidden'),
        xtermRendered: !!xtermEl,
        echoed
      });
    })()`);
    console.log('[debug term]', termTest);
    // 命令面板增强断言：分组 + 快捷键提示
    const cp = await win.webContents.executeJavaScript(`(async () => {
      window.openPalette();
      return JSON.stringify({
        items: document.querySelectorAll('.cp-item').length,
        groups: document.querySelectorAll('.cp-group').length,
        withKey: document.querySelectorAll('.cp-item .cp-key').length,
        jsonBtn: !!document.getElementById('json-settings-btn')
      });
    })()`);
    console.log('[debug palette2]', cp);
    await win.webContents.executeJavaScript('document.querySelector(".cmd-palette") && document.querySelector(".cmd-palette").classList.add("hidden")');
    // 灵动岛 + 网格背景验证
    const island = await win.webContents.executeJavaScript(`(async () => {
      window.updateIsland('running', 'Agent 运行中 · 测试');
      await new Promise((r) => setTimeout(r, 200));
      const el = document.querySelector('.island');
      const grid = getComputedStyle(document.body, '::before').backgroundImage;
      return JSON.stringify({
        islandVisible: el && !el.classList.contains('hidden'),
        islandClass: el ? el.className : 'none',
        gridApplied: grid.includes('linear-gradient')
      });
    })()`);
    console.log('[debug island]', island);
    await win.webContents.executeJavaScript('window.updateIsland("idle")');
    // 终端面板截图
    await win.webContents.executeJavaScript('window.openTerminal()');
    await sleep(600);
    await captureTo(path.join(shotDir, '06-terminal.png'));
    await win.webContents.executeJavaScript('document.querySelector(".term-panel") && document.querySelector(".term-panel").classList.add("hidden")');
    // 亮色模式验证 + 截图
    const lightTest = await win.webContents.executeJavaScript(`(async () => {
      await window.setMode('light');
      const light = {
        theme: document.documentElement.dataset.theme,
        bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
        text: getComputedStyle(document.documentElement).getPropertyValue('--text').trim()
      };
      await window.setMode('dark');
      const dark = { theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() };
      return JSON.stringify({ light, dark });
    })()`);
    console.log('[debug lightmode]', lightTest);
    await win.webContents.executeJavaScript('switchMode("home"); window.setMode("light")');
    await sleep(400);
    await captureTo(path.join(shotDir, '04-light.png'));
    await win.webContents.executeJavaScript('window.setMode("dark")');
    // Git 面板截图
    await win.webContents.executeJavaScript('switchMode("editor"); window.openGitPanel()');
    await sleep(500);
    await captureTo(path.join(shotDir, '05-git.png'));
    await win.webContents.executeJavaScript('document.querySelector(".git-panel") && document.querySelector(".git-panel").classList.add("hidden")');
    // IDE 体验验证（在 git 面板打开后）：ts worker / 文件树 git 标记 / gutter 标记 / monaco 协议
    const ide = await win.webContents.executeJavaScript(`(async () => {
      let monacoFetch = false;
      try { const resp = await fetch('monaco://vs/base/worker/workerMain.js'); monacoFetch = resp.ok; } catch (e) { monacoFetch = false; }
      let workerErr = '';
      try {
        const w = new Worker('monaco://vs/base/worker/workerMain.js');
        workerErr = await new Promise((resolve) => {
          w.onerror = (e) => resolve('onerror: ' + (e.message || 'unknown') + ' @' + (e.filename || ''));
          w.onmessage = () => resolve('ok: got message');
          setTimeout(() => resolve('no-error-no-message (1.5s)'), 1500);
        });
        w.terminate();
      } catch (e) { workerErr = 'throw: ' + String(e.message || e); }
      let tswErr = '';
      try { await monaco.languages.typescript.getJavaScriptWorker(); tswErr = 'resolved'; }
      catch (e) { tswErr = String(e && e.message || e); }
      const map = window.__gitStatusMap;
      return JSON.stringify({
        monacoFetch, workerErr, tswErr,
        gitMapSize: map ? map.size : 0,
        treeGitMarks: document.querySelectorAll('.tree-git').length,
        gutterMarks: document.querySelectorAll('.git-gutter-change').length
      });
    })()`);
    console.log('[debug ide]', ide);
    // 当前行高亮验证：直接查主题值（不依赖 DOM 渲染时机，更稳定）
    const red = await win.webContents.executeJavaScript(`(async () => {
      const ed = EditorState.editor;
      const th = ed._themeService && ed._themeService.getColorTheme();
      const c = th ? th.getColor('editor.lineHighlightBackground') : null;
      const lineBg = c ? c.toString() : 'none';
      const ok = lineBg.startsWith('rgba(59, 130, 246') || lineBg === 'rgba(59, 130, 246, 0.05)';
      return JSON.stringify({ hasModel: !!ed.getModel(), lineHighlight: lineBg, ok });
    })()`);
    console.log('[debug redline]', red);
  } catch (err) {
    console.error('[shot] FAILED:', err);
  }
  app.quit();
}

/* ---------------- Agent 工具循环测试（TEST_AGENT + MOCK_LLM） ---------------- */
function runAgentTest() {
  console.log('[test-agent] 开始');
  const testKey = 'sk-test-encrypt-12345';
  saveConfig({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', lastFolder: '', apiKey: testKey });
  const rawFile = fs.readFileSync(configPath(), 'utf8');
  console.log('[test-agent] 明文 key 出现在配置 =', rawFile.includes(testKey), '(应为 false)');
  console.log('[test-agent] 配置含 apiKeyEncrypted 字段 =', rawFile.includes('apiKeyEncrypted'), '(应为 true)');
  console.log('[test-agent] 解密回读 =', loadConfig().apiKey === testKey ? 'OK' : 'FAIL');
  saveConfig({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', lastFolder: '', apiKey: '' });

  const testFile = path.join(__dirname, 'agent-demo', 'hello.txt');
  try { fs.rmSync(path.join(__dirname, 'agent-demo'), { recursive: true, force: true }); } catch { /* 忽略 */ }
  const agent = { id: 'test-agent', task: '验证 Agent 工具循环', cwd: __dirname, status: 'running', messages: [], log: [], children: new Set() };
  agents.set(agent.id, agent);
  emitAgent(agent, 'meta', { task: agent.task, cwd: agent.cwd, ts: Date.now() });
  runAgent(agent).then(async () => {
    try {
      console.log('[test-agent] status =', agent.status);
      console.log('[test-agent] 子进程已清理 =', agent.children.size === 0 ? 'OK(应为 true)' : 'FAIL(' + agent.children.size + ')');
      console.log('[test-agent] 日志截断 =', agent.log.length <= 200 ? 'OK(' + agent.log.length + ')' : 'FAIL(' + agent.log.length + ')');
      console.log('[test-agent] file written =', fs.existsSync(testFile));
      if (fs.existsSync(testFile)) console.log('[test-agent] file content =', JSON.stringify(fs.readFileSync(testFile, 'utf8')));
      agent.log.filter((l) => l.kind === 'tool_result').forEach((l) =>
        console.log('[test-agent] tool_result:', l.name, '=>', String(l.result).replace(/\n/g, ' ').slice(0, 90))
      );
      await revertFile({ path: testFile, before: null, existed: false });
      console.log('[test-agent] revert 删除新文件 =', !fs.existsSync(testFile), '(应为 true)');
      const revFile = path.join(__dirname, 'agent-demo', 'rev.txt');
      await fsp.writeFile(revFile, 'new', 'utf8');
      await revertFile({ path: revFile, before: 'old', existed: true });
      console.log('[test-agent] revert 写回旧内容 =', fs.readFileSync(revFile, 'utf8') === 'old' ? 'OK' : 'FAIL');

      const ta = { id: 'tool-test', task: 't', cwd: __dirname, status: 'done', messages: [], log: [], children: new Set() };
      const tree = await executeTool(ta, 'list_tree', { path: 'agent-demo', depth: 2 });
      console.log('[test-agent] list_tree =', tree.replace(/\n/g, ' / ').slice(0, 60));
      await executeTool(ta, 'write_file', { path: 'agent-demo/search-me.txt', content: 'hello needle world' });
      const sres = await executeTool(ta, 'search_files', { pattern: 'needle', path: 'agent-demo' });
      console.log('[test-agent] search_files =', sres.replace(/\n/g, ' ').slice(0, 60));
      const info = await executeTool(ta, 'get_file_info', { path: 'agent-demo/search-me.txt' });
      console.log('[test-agent] get_file_info =', info.replace(/\n/g, ' ').slice(0, 60));
      await executeTool(ta, 'move_file', { from: 'agent-demo/search-me.txt', to: 'agent-demo/moved.txt' });
      console.log('[test-agent] move_file =', fs.existsSync(path.join(__dirname, 'agent-demo', 'moved.txt')));
      await executeTool(ta, 'delete_file', { path: 'agent-demo/moved.txt' });
      console.log('[test-agent] delete_file =', !fs.existsSync(path.join(__dirname, 'agent-demo', 'moved.txt')));
      console.log('[test-agent] 日志条数 =', logs.length, '(应为 > 0)');
      console.log('[test-agent] 日志级别覆盖 =', ['debug','info','warning','error'].every((lv) => logs.some((l) => l.level === lv)) ? 'OK(有 error 则 OK，无 error 也正常)' : (logs.some((l)=>l.level==='debug') ? '有 debug/info/warning' : '少'));
    } catch (e) {
      console.error('[test-agent] verify error:', e.message);
    }
    app.quit();
  });
}

process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

/* ---------------- 窗口 ---------------- */
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
    if (process.env.TEST_AGENT) runAgentTest();
    else if (process.env.DIAG) runDiag();
    else if (process.env.SHOT_MODE) takeScreenshots();
  });
}

/* 视觉诊断（DIAG 模式，临时调试用） */
async function runDiag() {
  try {
    await sleep(2500);
    const r = await win.webContents.executeJavaScript(`(async () => {
      const cs = (sel, props) => {
        const el = document.querySelector(sel);
        if (!el) return '元素不存在';
        const s = getComputedStyle(el);
        const out = {};
        for (const p of props) out[p] = s[p];
        out.__rect = el.offsetWidth + 'x' + el.offsetHeight;
        return JSON.stringify(out);
      };
      return JSON.stringify({
        swatch: cs('.swatch-block', ['display', 'width', 'height']),
        hero: cs('.hero-banner', ['height']),
        heroLeft: cs('.hero-left', ['height'])
      });
    })()`);
    console.log('[diag]', r);
  } catch (e) {
    console.error('[diag] FAILED', e);
  }
  app.quit();
}

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
