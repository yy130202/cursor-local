/* Cursor Local - Git 模块（status / diff / stage / commit / branch / pull / log / push） */
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

  /* porcelain 文件名解析：处理引号转义（C 风格）与重命名 "old -> new" */
  function parsePorcelainName(s) {
    s = String(s).trim();
    if (s.includes(' -> ')) return s.split(' -> ')[1].trim(); // 重命名取新路径
    if (s.startsWith('"')) { try { return JSON.parse(s); } catch { /* fallthrough */ } }
    return s;
  }

  /* numstat 变更统计：file -> { adds, dels } */
  async function numstatMap(cwd, staged) {
    const r = await runGit(cwd, staged ? ['diff', '--cached', '--numstat'] : ['diff', '--numstat']);
    const map = new Map();
    if (r.code === 0) {
      for (const line of r.stdout.split('\n')) {
        if (!line.trim()) continue;
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const file = parsePorcelainName(parts.slice(2).join('\t'));
        map.set(file, { adds: parts[0], dels: parts[1] });
      }
    }
    return map;
  }

  async function gitStatus(cwd) {
    const r = await runGit(cwd, ['status', '--porcelain', '-b']);
    if (r.code !== 0) return { ok: false, error: r.stderr || 'git status 失败' };
    let branch = '';
    const staged = [];
    const unstaged = [];
    const [nsU, nsS] = await Promise.all([numstatMap(cwd, false), numstatMap(cwd, true)]);
    for (const line of r.stdout.split('\n')) {
      if (!line) continue;
      if (line.startsWith('## ')) {
        branch = line.slice(3).split('...')[0].trim();
        continue;
      }
      const x = line[0], y = line[1];
      const file = parsePorcelainName(line.slice(3));
      if (x === '?' && y === '?') {
        unstaged.push({ file, status: 'untracked', staged: false });
        continue;
      }
      if (x !== ' ') {
        const s = nsS.get(file) || {};
        staged.push({ file, status: statusMap[x] || 'modified', staged: true, adds: s.adds, dels: s.dels });
      }
      if (y !== ' ') {
        const s = nsU.get(file) || {};
        unstaged.push({ file, status: statusMap[y] || 'modified', staged: false, adds: s.adds, dels: s.dels });
      }
    }
    return { ok: true, branch, staged, unstaged };
  }

  /* 并排 diff：返回 old / new 两端文本（IDEA 式 side-by-side），统一行尾防异常行终止符标记 */
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
    const norm = (s) => String(s).replace(/\r\n?/g, '\n');
    return { old: norm(oldText), new: norm(newText) };
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

  /* 提交暂存的文件列表 */
  async function gitCommitFiles(cwd, files, message) {
    const list = (files || []).filter(Boolean);
    if (!list.length) return { ok: false, error: '没有暂存的更改可提交' };
    const msg = String(message || '').trim();
    if (!msg) return { ok: false, error: '提交信息不能为空' };
    const c = await runGit(cwd, ['commit', '-m', msg, '--', ...list]);
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

  async function gitStageAll(cwd) {
    const r = await runGit(cwd, ['add', '-A']);
    addLog('info', 'git', '全部暂存');
    return { ok: r.code === 0, error: r.stderr };
  }

  async function gitUnstageAll(cwd) {
    const r = await runGit(cwd, ['reset', '-q']);
    addLog('info', 'git', '全部取消暂存');
    return { ok: r.code === 0, error: r.stderr };
  }

  async function gitPush(cwd) {
    const r = await runGit(cwd, ['push'], 60000);
    if (r.code !== 0) return { ok: false, error: r.stderr || r.stdout || 'git push 失败' };
    addLog('info', 'git', '已推送到远端');
    return { ok: true, output: (r.stdout + r.stderr).trim() };
  }

  /* 分支列表 */
  async function gitBranch(cwd) {
    const cur = await runGit(cwd, ['branch', '--show-current']);
    const list = await runGit(cwd, ['branch', '--list']);
    const current = cur.code === 0 ? cur.stdout.trim() : '';
    const branches = [];
    if (list.code === 0) {
      for (const l of list.stdout.split('\n')) {
        const b = l.replace(/^\*?\s*/, '').trim();
        if (b) branches.push(b);
      }
    }
    return { ok: true, current, branches };
  }

  /* 切换分支 */
  async function gitCheckout(cwd, branch) {
    const r = await runGit(cwd, ['checkout', branch]);
    if (r.code !== 0) return { ok: false, error: r.stderr || '切换分支失败' };
    addLog('info', 'git', '切换到分支 ' + branch);
    return { ok: true };
  }

  /* 拉取远端 */
  async function gitPull(cwd) {
    const r = await runGit(cwd, ['pull'], 60000);
    if (r.code !== 0) return { ok: false, error: r.stderr || r.stdout || 'git pull 失败' };
    addLog('info', 'git', '已拉取远端更新');
    return { ok: true, output: (r.stdout + r.stderr).trim() };
  }

  /* 提交历史 */
  async function gitLog(cwd) {
    const r = await runGit(cwd, ['log', '--oneline', '-n', '30', '--decorate']);
    if (r.code !== 0) return { ok: false, error: r.stderr || 'git log 失败' };
    const entries = r.stdout.split('\n').filter(Boolean).map((l) => {
      const m = l.match(/^(\S+)\s+(.*)$/);
      return m ? { hash: m[1], message: m[2] } : { hash: l, message: '' };
    });
    return { ok: true, entries };
  }

  /* 初始化仓库 */
  async function gitInit(cwd) {
    const r = await runGit(cwd, ['init']);
    if (r.code !== 0) return { ok: false, error: r.stderr || 'git init 失败' };
    addLog('info', 'git', '初始化仓库');
    return { ok: true };
  }

  function register(ipcMain) {
    ipcMain.handle('git:status', (_e, cwd) => gitStatus(cwd));
    ipcMain.handle('git:sideBySide', (_e, { cwd, file, staged }) => gitSideBySide(cwd, file, staged));
    ipcMain.handle('git:changedLines', (_e, { cwd, file }) => gitChangedLines(cwd, file));
    ipcMain.handle('git:stage', (_e, { cwd, file }) => gitStage(cwd, file));
    ipcMain.handle('git:unstage', (_e, { cwd, file }) => gitUnstage(cwd, file));
    ipcMain.handle('git:stageAll', (_e, cwd) => gitStageAll(cwd));
    ipcMain.handle('git:unstageAll', (_e, cwd) => gitUnstageAll(cwd));
    ipcMain.handle('git:commitFiles', (_e, { cwd, files, message }) => gitCommitFiles(cwd, files, message));
    ipcMain.handle('git:push', (_e, cwd) => gitPush(cwd));
    ipcMain.handle('git:branch', (_e, cwd) => gitBranch(cwd));
    ipcMain.handle('git:checkout', (_e, { cwd, branch }) => gitCheckout(cwd, branch));
    ipcMain.handle('git:pull', (_e, cwd) => gitPull(cwd));
    ipcMain.handle('git:log', (_e, cwd) => gitLog(cwd));
    ipcMain.handle('git:init', (_e, cwd) => gitInit(cwd));
  }

  return { register };
}

module.exports = { createGitModule };
