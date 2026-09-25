/* 截图验证脚本：以 SHOT_MODE 启动应用，主进程自动截图后退出 */
const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron');

const env = { ...process.env, SHOT_MODE: '1' };
delete env.ELECTRON_RUN_AS_NODE; // 防止 Electron 退化为纯 Node 模式

const child = spawn(electron, ['.'], {
  cwd: __dirname,
  env,
  stdio: 'inherit'
});
child.on('exit', (code) => {
  console.log('[screenshot-run] exited with', code);
  process.exit(code ?? 0);
});
