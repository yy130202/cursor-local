/* Cursor Local - 终端模块（xterm.js 前端 + 主进程 PTY 双向流）
 *
 * 【为什么必须用 PTY，而不是 child_process 的管道】
 * 管道模式下子进程的 stdin 不是终端（process.stdin.isTTY === false），
 * 所有依赖 TTY 的程序都会走错分支：
 *   - claude / codex 这类 CLI 会切到「非交互 --print 模式」，直接报
 *     「Input must be provided either through stdin or as a prompt argument」
 *   - python 的 REPL 不显示提示符、vim / ssh / top 拒绝启动
 *   - git rebase -i 等交互式子命令无法编辑
 * node-pty 在 Windows 上走 ConPTY、在 Unix 上走 forkpty，提供真实终端语义。
 * 它自 1.0 起采用 N-API，且 npm 包内含 win32-x64 / win32-arm64 / darwin 的 prebuilds，
 * 因此既不需要本机编译工具链，也不需要用 electron-rebuild 针对 Electron ABI 重建。
 *
 * 【降级策略】原生模块加载失败时回退到管道模式（改造前的行为），并在终端里显式打印警告。
 * 静默降级会让用户以为是「claude 坏了」，而不是「终端不支持 TTY」—— 这类误判的成本更高。
 */
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

let pty = null;
let ptyError = '';
let ptyTried = false;

/* 延迟加载原生模块 —— 不要把 require('node-pty') 放在模块顶层。
   实测：顶层 require 会让 Electron 在窗口创建阶段加载这个 .node，
   直接干扰窗口初始化：SHOT_MODE 下窗口内容区变成 1433px（应为 1440）、
   截图产出 0 字节、AI 面板展开宽度只有 1px，整个验证流程卡死。
   改为「首次真正创建终端时」才加载 —— 不使用终端的场景零开销。 */
function getPty() {
  if (process.env.DISABLE_PTY) return null; // 排查开关：强制走管道路径，用于对比定位
  if (ptyTried) return pty;
  ptyTried = true;
  try { pty = require('node-pty'); } catch (e) { ptyError = (e && e.message) ? e.message : String(e); }
  return pty;
}

function createTerminalModule({ winRef, addLog }) {
  const sessions = new Map(); // id -> { kind: 'pty' | 'pipe', proc }
  let seq = 0;

  function send(channel, payload) {
    const w = winRef();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }

  /* node-pty 要求 env 的每个值都是字符串，而 process.env 里可能存在 undefined */
  function cleanEnv() {
    const out = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') out[k] = v;
    out.TERM = 'xterm-256color';
    out.COLORTERM = 'truecolor';
    return out;
  }

  function shellSpec(isWin) {
    return isWin
      ? { file: process.env.ComSpec || 'cmd.exe', args: ['/q', '/k', 'chcp 65001 >nul'] }
      : { file: process.env.SHELL || 'bash', args: ['-l'] };
  }

  function create(cwd, cols, rows) {
    const id = 'term-' + Date.now() + '-' + (++seq);
    const dir = cwd || process.cwd();
    const isWin = process.platform === 'win32';
    const { file, args } = shellSpec(isWin);

    const ptyLib = getPty();
    if (ptyLib) {
      const proc = ptyLib.spawn(file, args, {
        name: 'xterm-256color',
        cols: Math.max(20, cols | 0) || 100,
        rows: Math.max(5, rows | 0) || 30,
        cwd: dir,
        env: cleanEnv(),
        // Windows 显式走 ConPTY：winpty 已废弃，且 ConPTY 对中文与宽字符处理更好
        ...(isWin ? { useConpty: true } : {}),
      });
      proc.onData((data) => send('terminal:data', { id, data }));
      proc.onExit(({ exitCode }) => { send('terminal:exit', { id, code: exitCode }); sessions.delete(id); });
      sessions.set(id, { kind: 'pty', proc });
      addLog('info', 'terminal', '终端启动 [PTY] (' + dir + ')');
      return id;
    }

    /* ---- 降级：管道模式（无 TTY，交互式程序受限） ---- */
    const child = spawn(file, args, { cwd: dir, env: process.env, windowsHide: true });
    const decOut = new StringDecoder('utf8');
    const decErr = new StringDecoder('utf8');
    child.stdout.on('data', (d) => send('terminal:data', { id, data: decOut.write(d) }));
    child.stderr.on('data', (d) => send('terminal:data', { id, data: decErr.write(d) }));
    child.on('error', (err) => send('terminal:data', { id, data: '\r\n[启动失败] ' + err.message }));
    child.on('close', (code) => { send('terminal:exit', { id, code }); sessions.delete(id); });
    sessions.set(id, { kind: 'pipe', proc: child });
    addLog('warning', 'terminal', '终端降级为管道模式：' + ptyError);
    setTimeout(() => send('terminal:data', {
      id,
      data: '\r\n\x1b[33m[终端警告] 原生终端模块（node-pty）不可用，当前为管道模式。\r\n'
        + 'claude / python 交互模式 / vim / ssh 等需要 TTY 的程序无法正常工作。\r\n'
        + '修复：npm install node-pty\x1b[0m\r\n',
    }), 300);
    return id;
  }

  function input(id, data) {
    const s = sessions.get(id);
    if (!s) return;
    if (s.kind === 'pty') s.proc.write(data);
    else s.proc.stdin.write(data);
  }

  /* 窗口尺寸变化：必须同步给 PTY，否则 CLI 的换行位置与全屏界面会错乱 */
  function resize(id, cols, rows) {
    const s = sessions.get(id);
    if (!s || s.kind !== 'pty') return false;
    try {
      s.proc.resize(Math.max(20, cols | 0), Math.max(5, rows | 0));
      return true;
    } catch { return false; }
  }

  function kill(id) {
    const s = sessions.get(id);
    if (!s) return;
    try { s.proc.kill(); } catch { /* 进程可能已退出 */ }
    sessions.delete(id);
  }

  /* 回收全部终端。PTY 是主进程持有的原生句柄，不显式杀掉会让 Electron 无法正常退出
     （表现为进程残留、随后的自动化流程超时）。 */
  function killAll() {
    for (const id of [...sessions.keys()]) kill(id);
  }

  function register(ipcMain) {
    // 兼容两种调用：旧签名直接传 cwd 字符串，新签名传 { cwd, cols, rows }
    ipcMain.handle('terminal:create', (_e, payload) => {
      const p = (payload && typeof payload === 'object') ? payload : { cwd: payload };
      return create(p.cwd, p.cols, p.rows);
    });
    ipcMain.handle('terminal:input', (_e, { id, data }) => { input(id, data); return true; });
    ipcMain.handle('terminal:resize', (_e, { id, cols, rows }) => resize(id, cols, rows));
    ipcMain.handle('terminal:kill', (_e, id) => { kill(id); return true; });
  }

  return { register, killAll, hasPty: () => !!getPty() };
}

module.exports = { createTerminalModule };
