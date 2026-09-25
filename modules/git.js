/* Cursor Local - Git 模块（status / diff / stage / commit / push） */
const { spawn } = require('child_process');

function createGitModule({ winRef, addLog }) {
  function runGit(cwd, args, timeoutMs = 30000) {
    return new Promise((resolve) => {
      const child = spawn('git', args, { cwd });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, timeoutMs);
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: err.message }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
  }

  const statusMap = { ' ': null, M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflict' };

  async function gitStatus(cwd) {
    const r = await runGit(cwd, ['status', '--porcelain', '-b']);
    if (r.code !== 0) return { ok: false, error: r.stderr || 'git status 失败' };
    let branch = '';
    const staged = [];
    const unstaged = [];
    for (const line of r.stdout.split('\n')) {
      if (!line) continue;
      if (line.startsWith('## ')) {
        branch = line.slice(3).split('...')[0].trim();
        continue;
      }
      const x = line[0], y = line[1];
      const file = line.slice(3).trim();
      if (x === '?' && y === '?') {
        unstaged.push({ file, status: 'untracked', staged: false });
        continue;
      }
      if (x !== ' ') {
        staged.push({ file, status: statusMap[x] || 'modified', staged: true });
      }
      if (y !== ' ') {
        unstaged.push({ file, status: statusMap[y] || 'modified', staged: false });
      }
    }
    return { ok: true, branch, staged, unstaged };
  }

  async function gitDiff(cwd, file, staged) {
    const args = staged ? ['diff', '--cached', '--', file] : ['diff', '--', file];
    const r = await runGit(cwd, args);
    return r.stdout || '[无差异]';
  }

  async function gitStage(cwd, file) {
    const r = await runGit(cwd, ['add', '--', file]);
    addLog('info', 'git', '暂存 ' + file);
    return r.code === 0;
  }

  async function gitUnstage(cwd, file) {
    const r = await runGit(cwd, ['reset', 'HEAD', '--', file]);
    addLog('info', 'git', '取消暂存 ' + file);
    return r.code === 0;
  }

  async function gitCommit(cwd, message) {
    const msg = String(message || '').trim();
    if (!msg) return { ok: false, error: '提交信息不能为空' };
    const a = await runGit(cwd, ['add', '-A']);
    if (a.code !== 0) return { ok: false, error: a.stderr || 'git add 失败' };
    const c = await runGit(cwd, ['commit', '-m', msg]);
    if (c.code !== 0) return { ok: false, error: c.stderr || c.stdout || 'git commit 失败' };
    addLog('info', 'git', '提交：' + msg.slice(0, 60));
    return { ok: true, output: (c.stdout + c.stderr).trim() };
  }

  async function gitPush(cwd) {
    const r = await runGit(cwd, ['push'], 60000);
    if (r.code !== 0) return { ok: false, error: r.stderr || r.stdout || 'git push 失败' };
    addLog('info', 'git', '已推送到远端');
    return { ok: true, output: (r.stdout + r.stderr).trim() };
  }

  function register(ipcMain) {
    ipcMain.handle('git:status', (_e, cwd) => gitStatus(cwd));
    ipcMain.handle('git:diff', (_e, { cwd, file, staged }) => gitDiff(cwd, file, staged));
    ipcMain.handle('git:stage', (_e, { cwd, file }) => gitStage(cwd, file));
    ipcMain.handle('git:unstage', (_e, { cwd, file }) => gitUnstage(cwd, file));
    ipcMain.handle('git:commit', (_e, { cwd, message }) => gitCommit(cwd, message));
    ipcMain.handle('git:push', (_e, cwd) => gitPush(cwd));
  }

  return { register, gitStatus, gitDiff, gitCommit };
}

module.exports = { createGitModule };
