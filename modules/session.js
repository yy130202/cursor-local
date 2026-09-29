/* Cursor Local - 会话持久化模块（保存/加载/删除/导出/回滚） */
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { app } = require('electron');

function createSessionModule({ winRef, addLog }) {
  const sessionsDir = () => process.env.SESSIONS_PATH || path.join(app.getPath('userData'), 'sessions');

  function saveSession(agent) {
    try {
      const dir = sessionsDir();
      fs.mkdirSync(dir, { recursive: true });
      const data = {
        id: agent.id, task: agent.task, cwd: agent.cwd, status: agent.status,
        log: agent.log, changes: agent.changes || [], ts: Date.now()
      };
      fs.writeFileSync(path.join(dir, agent.id + '.json'), JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error('[session] save failed:', err.message);
    }
  }

  function loadSessions() {
    try {
      const dir = sessionsDir();
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
          catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
    } catch {
      return [];
    }
  }

  async function revertFile({ path: p, before, existed }) {
    if (existed) {
      await fsp.writeFile(p, before ?? '', 'utf8');
    } else {
      await fsp.rm(p, { force: true });
    }
    const win = winRef();
    if (win && !win.isDestroyed()) win.webContents.send('fs:changed', { path: p });
    return true;
  }

  function register(ipcMain) {
    ipcMain.handle('session:list', () => loadSessions());
    ipcMain.handle('session:delete', (_e, id) => {
      try {
        fs.rmSync(path.join(sessionsDir(), id + '.json'), { force: true });
        addLog('info', 'session', '删除会话 ' + id);
        return true;
      } catch (e) { return false; }
    });
    ipcMain.handle('session:clear', () => {
      try {
        for (const f of fs.readdirSync(sessionsDir())) {
          if (f.endsWith('.json')) fs.rmSync(path.join(sessionsDir(), f), { force: true });
        }
        addLog('info', 'session', '清空全部会话');
        return true;
      } catch (e) { return false; }
    });
    ipcMain.handle('session:export', (_e, id) => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(sessionsDir(), id + '.json'), 'utf8'));
        let md = '# ' + (data.task || 'Agent 会话') + '\n\n';
        md += '> ' + new Date(data.ts).toLocaleString('zh-CN') + ' · 状态 ' + (data.status || 'done') + '\n\n';
        for (const e of (data.log || [])) {
          if (e.kind === 'meta') continue;
          else if (e.kind === 'user_msg') md += '## 任务\n' + e.text + '\n\n';
          else if (e.kind === 'text') md += '**Agent**：' + e.text + '\n\n';
          else if (e.kind === 'tool_call') md += '- 调用 `' + e.name + '`\n';
          else if (e.kind === 'change') md += '- 修改 `' + (e.relPath || e.path) + '`\n';
          else if (e.kind === 'error') md += '> **错误**：' + e.text + '\n\n';
        }
        return md;
      } catch { return null; }
    });
    ipcMain.handle('fs:revert', (_e, c) => revertFile(c));
  }

  return { register, saveSession, loadSessions, revertFile };
}

module.exports = { createSessionModule };
