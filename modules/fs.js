/* Cursor Local - 文件系统模块（读/写/搜索/文件操作 IPC） */
const path = require('path');
const fsp = require('fs').promises;
const { dialog, shell } = require('electron');
const { spawn } = require('child_process');

/* 压缩包内容列表：用系统 tar（Windows 10+ 自带 bsdtar，支持 zip/tar/gz/bz2/xz） */
function listArchive(file, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn('tar', ['-tf', file], { windowsHide: true });
    let stdout = '', stderr = '', done = false;
    const timer = setTimeout(() => {
      if (done) return; done = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve({ ok: false, error: '读取压缩包超时' });
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', () => { if (done) return; done = true; clearTimeout(timer); resolve({ ok: false, error: '无法执行 tar，请确认系统支持（RAR 需另行安装解压工具）' }); });
    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false, error: (stderr || stdout || '读取失败').trim().slice(0, 300) });
      const entries = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      resolve({ ok: true, entries });
    });
  });
}

function registerFs(ipcMain, { winRef, addLog, loadConfig, saveConfig }) {
  const notifyFs = (p) => {
    const win = winRef();
    if (win && !win.isDestroyed()) win.webContents.send('fs:changed', { path: p });
  };

  ipcMain.handle('fs:readDir', async (_e, dirPath) => {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    const list = [];
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      list.push({ name: ent.name, path: path.join(dirPath, ent.name), isDir: ent.isDirectory() });
    }
    list.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
    return list.slice(0, 500);
  });

  ipcMain.handle('fs:readFile', async (_e, filePath) => {

    const stat = await fsp.stat(filePath);
    const buf = await fsp.readFile(filePath);
    let content = buf.toString('utf8');
    // 兜底上限 50MB（防读到超大文件撑爆内存）；实际降级由渲染进程按阈值判断
    const LIMIT = 50 * 1024 * 1024;
    const truncated = content.length > LIMIT;
    if (truncated) content = content.slice(0, LIMIT);
    return { content, truncated, size: stat.size };
  });

  ipcMain.handle('fs:writeFile', async (_e, filePath, content) => {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, content, 'utf8');
    return true;
  });

  /* 用系统默认程序打开（图片/视频/压缩包等） */
  ipcMain.handle('fs:openExternal', async (_e, filePath) => {
    if (!filePath) return false;
    const r = await shell.openPath(filePath);
    return !r; // 空字符串表示成功
  });

  /* 压缩包内容列表（图片/音视频之外的二进制文件预览） */
  ipcMain.handle('fs:listArchive', async (_e, filePath) => {
    if (!filePath) return { ok: false, error: '未提供文件路径' };
    return listArchive(filePath);
  });

  /* 全局搜索：递归 grep（跳过 node_modules/.git，限制规模） */
  ipcMain.handle('search:grep', async (_e, { folder, pattern }) => {
    if (!folder || !pattern) return [];
    const results = [];
    const maxResults = 500;
    const needle = String(pattern).toLowerCase();
    async function walk(dir, depth) {
      if (results.length >= maxResults || depth > 10) return;
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        if (results.length >= maxResults) return;
        if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist' || ent.name === '.test-sessions') continue;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) { await walk(p, depth + 1); continue; }
        try {
          const stat = await fsp.stat(p);
          if (stat.size > 500000) continue;
          const content = await fsp.readFile(p, 'utf8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const idx = lines[i].toLowerCase().indexOf(needle);
            if (idx >= 0) {
              results.push({ file: path.relative(folder, p), line: i + 1, col: idx + 1, text: lines[i].slice(0, 200) });
              if (results.length >= maxResults) return;
            }
          }
        } catch { /* 忽略二进制/读取失败 */ }
      }
    }
    await walk(folder, 0);
    return results;
  });

  ipcMain.handle('dialog:openFolder', async () => {
    const win = winRef();
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths.length) return null;
    const cfg = loadConfig();
    cfg.lastFolder = r.filePaths[0];
    saveConfig(cfg);
    return r.filePaths[0];
  });

  ipcMain.handle('fs:createFile', async (_e, filePath) => {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, '', 'utf8');
    addLog('info', 'fs', '新建文件 ' + filePath);
    notifyFs(filePath);
    return true;
  });
  ipcMain.handle('fs:createDir', async (_e, dirPath) => {
    await fsp.mkdir(dirPath, { recursive: true });
    addLog('info', 'fs', '新建文件夹 ' + dirPath);
    notifyFs(dirPath);
    return true;
  });
  ipcMain.handle('fs:rename', async (_e, { from, to }) => {
    await fsp.rename(from, to);
    addLog('info', 'fs', '重命名 ' + from + ' → ' + to);
    notifyFs(from); notifyFs(to);
    return true;
  });
  ipcMain.handle('fs:delete', async (_e, targetPath) => {
    await fsp.rm(targetPath, { recursive: true, force: true });
    addLog('warning', 'fs', '删除 ' + targetPath);
    notifyFs(targetPath);
    return true;
  });
}

module.exports = { registerFs };
