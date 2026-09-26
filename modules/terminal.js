/* Cursor Local - 终端模块（xterm.js 前端 + 主进程 shell 双向流） */
const { spawn } = require('child_process');

function createTerminalModule({ winRef, addLog }) {
  const sessions = new Map(); // id -> child
  let seq = 0;

  function spawnShell(cwd) {
    // Windows 用 cmd.exe（无需原生编译）；非 Windows 用 bash
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'cmd.exe' : 'bash';
    const child = spawn(shell, isWin ? ['/q'] : ['-i'], { cwd, env: process.env });
    return child;
  }

  function create(cwd) {
    const id = 'term-' + Date.now() + '-' + (++seq);
    const child = spawnShell(cwd || process.cwd());
    const win = winRef();
    child.stdout.on('data', (d) => {
      if (win && !win.isDestroyed()) win.webContents.send('terminal:data', { id, data: d.toString('utf8') });
    });
    child.stderr.on('data', (d) => {
      if (win && !win.isDestroyed()) win.webContents.send('terminal:data', { id, data: d.toString('utf8') });
    });
    child.on('error', (err) => {
      if (win && !win.isDestroyed()) win.webContents.send('terminal:data', { id, data: '\r\n[启动失败] ' + err.message });
    });
    child.on('close', (code) => {
      if (win && !win.isDestroyed()) win.webContents.send('terminal:exit', { id, code });
      sessions.delete(id);
    });
    sessions.set(id, child);
    addLog('info', 'terminal', '终端启动 (' + (cwd || process.cwd()) + ')');
    return id;
  }

  function input(id, data) {
    const s = sessions.get(id);
    if (s) s.stdin.write(data);
  }

  function kill(id) {
    const s = sessions.get(id);
    if (s) { try { s.kill(); } catch { /* ignore */ } sessions.delete(id); }
  }

  function register(ipcMain) {
    ipcMain.handle('terminal:create', (_e, cwd) => create(cwd));
    ipcMain.handle('terminal:input', (_e, { id, data }) => { input(id, data); return true; });
    ipcMain.handle('terminal:kill', (_e, id) => { kill(id); return true; });
  }

  return { register };
}

module.exports = { createTerminalModule };
