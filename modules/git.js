/* Cursor Local - Git 模块（status / diff / stage / commit / push） */
const path = require('path');
const fs = require('fs');
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

  /* 并排 diff：返回 old / new 两端文本（IDEA 式 side-by-side） */
  async function gitSideBySide(cwd, file, staged) {
    let oldText = '', newText = '';
    // old = HEAD 版本（未跟踪/新文件则为空）
    const head = await runGit(cwd, ['show', 'HEAD:' + file]);
    oldText = head.code === 0 ? head.stdout : '';
    if (staged) {
      // 已暂存：new = 暂存区（index）版本
      const idx = await runGit(cwd, ['show', ':' + file]);
      newText = idx.code === 0 ? idx.stdout : '';
    } else {
      // 未暂存/未跟踪：new = 工作区文件内容
      try { newText = fs.readFileSync(path.join(cwd, file), 'utf8'); } catch { newText = ''; }
    }
    return { old: oldText, new: newText };
  }

  /* 文件变更行号（新侧）：解析 git diff -U0，供编辑器 gutter 标记 */
  async function gitChangedLines(cwd, file) {
    const r = await runGit(cwd, ['diff', '-U0', '--', file]);
    if (r.code !== 0) return { ok: false, lines: [] };
    const lines = [];
    let cur = 0;
    for (const line of r.stdout.split('\n')) {
      if (line.startsWith('@@')) {
        const m = line.match(/\+(\d+)/);
        cur = m ? parseInt(m[1], 10) : 0;
        continue;
      }
      if (line.startsWith('+')) { lines.push(cur); cur++; }
      else if (line.startsWith(' ')) { cur++; }
      // - 开头（旧侧行）与空行/元信息忽略
    }
    return { ok: true, lines };
  }

  /* 选择性提交：只提交指定文件列表 */
  async function gitCommitFiles(cwd, files, message) {
    const list = (files || []).filter(Boolean);
    if (!list.length) return { ok: false, error: '未选择要提交的文件' };
    const msg = String(message || '').trim();
    if (!msg) return { ok: false, error: '提交信息不能为空' };
    const a = await runGit(cwd, ['add', '--', ...list]);
    if (a.code !== 0) return { ok: false, error: a.stderr || 'git add 失败' };
    const c = await runGit(cwd, ['commit', '-m', msg]);
    if (c.code !== 0) return { ok: false, error: c.stderr || c.stdout || 'git commit 失败' };
    addLog('info', 'git', '提交 ' + list.length + ' 个文件：' + msg.slice(0, 60));
    return { ok: true, output: (c.stdout + c.stderr).trim() };
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
    ipcMain.handle('git:sideBySide', (_e, { cwd, file, staged }) => gitSideBySide(cwd, file, staged));
    ipcMain.handle('git:changedLines', (_e, { cwd, file }) => gitChangedLines(cwd, file));
    ipcMain.handle('git:stage', (_e, { cwd, file }) => gitStage(cwd, file));
    ipcMain.handle('git:unstage', (_e, { cwd, file }) => gitUnstage(cwd, file));
    ipcMain.handle('git:commit', (_e, { cwd, message }) => gitCommit(cwd, message));
    ipcMain.handle('git:commitFiles', (_e, { cwd, files, message }) => gitCommitFiles(cwd, files, message));
    ipcMain.handle('git:push', (_e, cwd) => gitPush(cwd));
  }

  return { register, gitStatus, gitDiff, gitCommit };
}

module.exports = { createGitModule };
