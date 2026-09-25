/* Cursor Local - 日志模块（debug / info / warning / error） */
function createLog(winRef) {
  const logs = [];
  function addLog(level, source, message) {
    const entry = { level, source, message: String(message), ts: Date.now() };
    logs.push(entry);
    if (logs.length > 1500) logs.shift();
    const win = winRef();
    if (win && !win.isDestroyed()) win.webContents.send('log:event', entry);
    return entry;
  }
  return { logs, addLog };
}

function registerLog(ipcMain, log) {
  ipcMain.handle('log:list', () => log.logs);
  ipcMain.handle('log:clear', () => { log.logs.length = 0; return true; });
}

module.exports = { createLog, registerLog };
