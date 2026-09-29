/* Cursor Local - 终端模块（xterm.js 前端 + 主进程 shell 双向流） */
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

function createTerminalModule({ winRef, addLog }) {
  const sessions = new Map(); // id -> child
  let seq = 0;

  function spawnShell(cwd) {
    // Windows 用 cmd.exe；chcp 65001 切 UTF-8（修复中文乱码），windowsHide 保证有隐藏控制台使 chcp 生效
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'cmd.exe' : 'bash';
    const args = isWin ? ['/q', '/k', 'chcp 65001 >nul'] : ['-i'];
    return spawn(shell, args, { cwd, env: process.env, windowsHide: true });
  }

  function create(cwd) {
    const id = 'term-' + Date.now() + '-' + (++seq);
    const child = spawnShell(cwd || process.cwd());
    const win = winRef();
    // StringDecoder 处理 UTF-8 多字节字符跨块截断
    const decOut = new StringDecoder('utf8');
    const decErr = new StringDecoder('utf8');
    child.stdout.on('data', (d) => {
      if (win && !win.isDestroyed()) win.webContents.send('terminal:data', { id, data: decOut.write(d) });
    });
    child.stderr.on('data', (d) => {
      if (win && !win.isDestroyed()) win.webContents.send('terminal:data', { id, data: decErr.write(d) });
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
