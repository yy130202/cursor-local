/* Cursor Local - 文件系统模块（读/写/搜索/文件操作 IPC） */
const path = require('path');
const fsp = require('fs').promises;
const { dialog, shell } = require('electron');
const { spawn } = require('child_process');

/* 全局搜索的并发上限：同时在飞的 stat/readFile 数量 */
const CONC_GREP = 8;

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

  /* 全局搜索：递归 grep（跳过 node_modules/.git，限制规模）
     原为纯串行 walk —— 每个文件都 await stat + readFile，磁盘 I/O 串行排队。
     改为「固定大小分块并发 + 块内按序提交」：
       · 块内并发读（块大小 = CONC_GREP），块与块之间串行；
       · 块的 Promise.all 天然按输入顺序返回，故按序合并即可保证结果顺序
         与改造前「按 readdir 序逐文件串行」完全一致；
       · maxResults 在块级边界检查，命中上限不会被并发越界。 */
  ipcMain.handle('search:grep', async (_e, { folder, pattern }) => {
    if (!folder || !pattern) return [];
    const results = [];
    const maxResults = 500;
    const maxDepth = 10;
    const maxFileBytes = 500000;
    const needle = String(pattern).toLowerCase();
    const SKIP = new Set(['node_modules', '.git', 'dist', '.test-sessions']);

    // 扫描单个文件，返回其命中行数组（不直接写 results，保证提交顺序可控）
    async function scanFile(p) {
      try {
        const stat = await fsp.stat(p);
        if (stat.size > maxFileBytes) return [];
        const content = await fsp.readFile(p, 'utf8');
        const lines = content.split('\n');
        const hits = [];
        for (let i = 0; i < lines.length; i++) {
          const idx = lines[i].toLowerCase().indexOf(needle);
          if (idx >= 0) {
            hits.push({ file: path.relative(folder, p), line: i + 1, col: idx + 1, text: lines[i].slice(0, 200) });
            if (hits.length >= maxResults) break;
          }
        }
        return hits;
      } catch {
        return []; // 忽略二进制/读取失败/无权限
      }
    }

    // 分块并发处理一批文件：块内 Promise.all 保序，块间串行
    async function scanFilesOrdered(files) {
      for (let start = 0; start < files.length && results.length < maxResults; start += CONC_GREP) {
        const chunk = files.slice(start, start + CONC_GREP);
        const chunkHits = await Promise.all(chunk.map(scanFile)); // 按 chunk 顺序返回
        for (const hits of chunkHits) {
          for (const h of hits) {
            if (results.length >= maxResults) return;
            results.push(h);
          }
        }
      }
    }

    async function walk(dir, depth) {
      if (results.length >= maxResults || depth > maxDepth) return;
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      const files = [];
      const subdirs = [];
      for (const ent of entries) {
        if (results.length >= maxResults) return;
        if (SKIP.has(ent.name)) continue;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) subdirs.push(p);
        else files.push(p);
      }
      if (files.length) await scanFilesOrdered(files);
      for (const sd of subdirs) {
        if (results.length >= maxResults) return;
        await walk(sd, depth + 1);
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
