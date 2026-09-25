/* Agent 工具循环测试：用 mock LLM 验证 list_dir / write_file / run_command 全链路 */
const { spawn } = require('child_process');
const electron = require('electron');

const env = {
  ...process.env,
  TEST_AGENT: '1',
  MOCK_LLM: '1',
  CONFIG_PATH: require('path').join(__dirname, '.test-config.json'),
  SESSIONS_PATH: require('path').join(__dirname, '.test-sessions')
};
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.'], {
  cwd: __dirname,
  env,
  stdio: 'inherit'
});
child.on('exit', (code) => process.exit(code ?? 0));
