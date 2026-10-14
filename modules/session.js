/* Cursor Local - 会话持久化模块（保存/加载/删除/导出/回滚） */
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { app } = require('electron');

function createSessionModule({ winRef, addLog, agents }) {
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

  /**
   * 导出会话轨迹（Trajectory）。
   * 优先读内存 agents Map（运行中/刚完成的会话可能还没落盘），
   * 回落读磁盘 sessions/*.json。
   * format: 'md' 人类可读（含工具参数/结果摘要/耗时/diff 统计/审批/错误）
   *         'json' 完整事件 log（供程序化分析）
   */
  function exportTrajectory(id, format) {
    let data = null;
    const mem = agents && agents.get(id);
    if (mem) {
      data = { id: mem.id, task: mem.task, cwd: mem.cwd, status: mem.status, log: mem.log || [], changes: mem.changes || [], ts: Date.now() };
    } else {
      try {
        data = JSON.parse(fs.readFileSync(path.join(sessionsDir(), id + '.json'), 'utf8'));
      } catch { return null; }
    }
    if (!data) return null;
    if (format === 'json') return JSON.stringify(data, null, 2);

    const log = data.log || [];
    const lines = [];
    lines.push('# ' + (data.task || 'Agent 会话'));
    lines.push('');
    lines.push('> 会话 `' + data.id + '` · ' + new Date(data.ts || Date.now()).toLocaleString('zh-CN')
      + ' · 状态 ' + (data.status || 'done') + (data.cwd ? ' · 目录 `' + data.cwd + '`' : ''));
    lines.push('');
    for (const e of log) {
      switch (e.kind) {
        case 'meta': break;
        case 'user_msg': lines.push('## 任务\n\n' + e.text + '\n'); break;
        case 'text': lines.push('**Agent**：' + e.text + '\n'); break;
        case 'reasoning': lines.push('<details><summary>思考过程</summary>\n\n' + e.text + '\n\n</details>\n'); break;
        case 'tool_call':
          lines.push('#### 🔧 `' + e.name + '`');
          if (e.args && Object.keys(e.args).length) {
            lines.push('```json\n' + JSON.stringify(e.args, null, 2).slice(0, 1500) + '\n```');
          }
          break;
        case 'tool_result': {
          const ms = typeof e.ms === 'number' ? '（' + e.ms + 'ms）' : '';
          lines.push('**结果**' + ms + '：');
          lines.push('```\n' + String(e.result == null ? '' : e.result).slice(0, 1200) + '\n```\n');
          break;
        }
        case 'change': {
          const ch = e.change || e;
          const before = ch.before == null ? '' : String(ch.before);
          const after = ch.after == null ? '' : String(ch.after);
          const added = after.split('\n').length - before.split('\n').length;
          lines.push('#### ✏️ 修改 `' + (ch.relPath || ch.path) + '`（' + (added >= 0 ? '+' + added : added) + ' 行）\n');
          break;
        }
        case 'approval': lines.push('> ⏳ 审批 `' + e.name + '`\n'); break;
        case 'plan': lines.push('## 计划\n\n' + e.text + '\n'); break;
        case 'heal': lines.push('> ⚠️ 自愈重试 `' + e.name + '`（第 ' + e.attempt + '/' + e.limit + ' 次）：' + e.reason + '\n'); break;
        case 'subtask': lines.push('#### 🧩 子任务 `' + e.task + '` → ' + (e.status || '') + '\n'); break;
        case 'error': lines.push('> ❌ **错误**：' + e.text + '\n'); break;
        case 'status': break;
        default: break;
      }
    }
    // 变更汇总
    const changes = data.changes || [];
    if (changes.length) {
      lines.push('## 变更汇总\n');
      lines.push('| 文件 | 行数变化 |');
      lines.push('|---|---|');
      for (const c of changes) {
        const before = c.before == null ? '' : String(c.before);
        const after = c.after == null ? '' : String(c.after);
        const d = after.split('\n').length - before.split('\n').length;
        lines.push('| `' + (c.relPath || c.path) + '` | ' + (d >= 0 ? '+' + d : d) + ' |');
      }
      lines.push('');
    }
    return lines.join('\n');
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
    ipcMain.handle('session:exportTrajectory', (_e, payload) => {
      const id = typeof payload === 'string' ? payload : payload && payload.id;
      const format = (typeof payload === 'object' && payload && payload.format) || 'md';
      const out = exportTrajectory(id, format);
      addLog('info', 'session', '导出轨迹 ' + id + '（' + format + '）' + (out ? ' 成功' : ' 失败'));
      return out;
    });
    ipcMain.handle('fs:revert', (_e, c) => revertFile(c));
  }

  return { register, saveSession, loadSessions, revertFile, exportTrajectory };
}

module.exports = { createSessionModule };
