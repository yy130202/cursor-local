// Cursor Local - 主进程
// 复刻 Cursor 核心体验的本地 AI 编程工具
const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const { LocalUserStore } = require('./store/user-store');
const billing = require('./store/billing');

let win = null;
const agents = new Map();
let userStore = null;
function getUserStore() {
  if (!userStore) userStore = new LocalUserStore(app.getPath('userData'));
  return userStore;
}

/* ---------------- 配置（持久化 + API Key 加密） ---------------- */
const configPath = () => process.env.CONFIG_PATH || path.join(app.getPath('userData'), 'config.json');

function decryptApiKey(raw) {
  // 旧版明文（迁移：下次保存会自动转加密）
  if (raw && raw.apiKey) return raw.apiKey;
  if (raw && raw.apiKeyEncrypted) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(raw.apiKeyEncrypted, 'base64'));
      }
      return '';
    } catch {
      return '';
    }
  }
  return '';
}

function loadConfig() {
  const defaults = {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-flash',
    lastFolder: '',
    theme: { preset: 'blue', custom: null }
  };
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return { ...defaults, ...raw, apiKey: decryptApiKey(raw) };
  } catch {
    return defaults;
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  const out = { ...cfg };
  const key = out.apiKey || '';
  delete out.apiKey;
  delete out.apiKeyEncrypted;
  if (key) {
    if (safeStorage.isEncryptionAvailable()) {
      out.apiKeyEncrypted = safeStorage.encryptString(key).toString('base64');
    } else {
      out.apiKey = key; // 降级明文存储
      console.warn('[config] safeStorage 不可用，API Key 将以明文存储（请勿在不受信任的环境使用）');
    }
  }
  fs.writeFileSync(configPath(), JSON.stringify(out, null, 2), 'utf8');
}

/* ---------------- 文件系统 IPC ---------------- */
ipcMain.handle('fs:readDir', async (_e, dirPath) => {
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  const list = [];
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    list.push({
      name: ent.name,
      path: path.join(dirPath, ent.name),
      isDir: ent.isDirectory()
    });
  }
  list.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
  return list.slice(0, 500);
});

ipcMain.handle('fs:readFile', async (_e, filePath) => {
  const stat = await fsp.stat(filePath);
  const buf = await fsp.readFile(filePath);
  let content = buf.toString('utf8');
  const truncated = content.length > 800000;
  if (truncated) content = content.slice(0, 800000);
  return { content, truncated };
});

ipcMain.handle('fs:writeFile', async (_e, filePath, content) => {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content, 'utf8');
  return true;
});

ipcMain.handle('dialog:openFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  const cfg = loadConfig();
  cfg.lastFolder = r.filePaths[0];
  saveConfig(cfg);
  return r.filePaths[0];
});

ipcMain.handle('config:get', () => loadConfig());
ipcMain.handle('config:set', (_e, partial) => {
  const cfg = { ...loadConfig(), ...partial };
  saveConfig(cfg);
  return cfg;
});

/* ---------------- 终端命令执行 ---------------- */
function decodeOut(buf) {
  let s = buf.toString('utf8');
  if (s.includes('\uFFFD')) {
    try { s = new TextDecoder('gbk').decode(buf); } catch { /* 保持 utf8 */ }
  }
  return s;
}

function runCommand(cwd, command, agent, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: process.env });
    if (agent) {
      agent.children = agent.children || new Set();
      agent.children.add(child);
      child.on('close', () => agent.children.delete(child));
    }
    let stdout = '', stderr = '', done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        else child.kill('SIGKILL');
      } catch { /* ignore */ }
      resolve({ code: -1, output: (stdout + stderr).slice(0, 12000) + '\n[命令超时已终止]' });
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += decodeOut(d); if (stdout.length > 200000) stdout = stdout.slice(0, 200000); });
    child.stderr.on('data', (d) => { stderr += decodeOut(d); if (stderr.length > 100000) stderr = stderr.slice(0, 100000); });
    child.on('error', (err) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ code: -1, output: '启动失败: ' + err.message });
    });
    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timer);
      const out = ((stdout || '') + (stderr ? '\n[stderr]\n' + stderr : '')).trim();
      resolve({ code, output: (out || '[无输出]').slice(0, 12000) });
    });
  });
}

/* ---------------- Agent 引擎 ---------------- */
const AGENT_TOOLS = [
  { type: 'function', function: { name: 'list_dir', description: '列出目录内容，返回条目列表（目录以 / 结尾）', parameters: { type: 'object', properties: { path: { type: 'string', description: '目录路径，相对工作目录或绝对路径' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'read_file', description: '读取文件内容（过大自动截断）', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: '写入文件（覆盖式，需提供完整最终内容；目录不存在会自动创建）', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' }, content: { type: 'string', description: '完整文件内容' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'run_command', description: '在工作目录执行终端命令（npm/node/python/git 等），返回退出码和输出', parameters: { type: 'object', properties: { command: { type: 'string', description: '要执行的命令' } }, required: ['command'] } } }
];

function resolveAgentPath(cwd, p) {
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

/* 沙箱：确保目标路径在工作目录内 */
function assertInsideWorkspace(cwd, target) {
  const rel = path.relative(path.resolve(cwd), path.resolve(target));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return;
  throw new Error(`沙箱拦截：禁止访问工作目录之外的路径（${target}）`);
}

/* 危险命令黑名单（P0 安全） */
const DANGEROUS_PATTERNS = [
  { re: /\brm\s+-[a-z]*r[a-z]*f\b/i, desc: 'rm -rf 递归强制删除' },
  { re: /\brm\s+-[a-z]*f[a-z]*r\b/i, desc: 'rm -fr 递归强制删除' },
  { re: /\bdel\s+\/[sfq]\b/i, desc: 'del /s /f /q 递归强制删除' },
  { re: /\brmdir\s+\/[sq]\b/i, desc: 'rmdir /s /q 递归删除目录' },
  { re: /\bformat\b/i, desc: '格式化磁盘' },
  { re: /\bmkfs(\.\w+)?\b/i, desc: '创建文件系统（格式化）' },
  { re: /\bdd\s+if=/i, desc: 'dd 磁盘写入' },
  { re: /\bshutdown\b/i, desc: '关机' },
  { re: /\breboot\b/i, desc: '重启' },
  { re: /\b:\(\)\s*\{\s*:\|:\s*&\s*\};:/, desc: 'fork 炸弹' },
  { re: /\bchmod\s+-R\s+777\b/i, desc: '全目录 777 权限' },
  { re: /\bgit\s+push\s+(-f|--force)\b/i, desc: 'git 强制推送' },
  { re: /\bnpm\s+publish\b/i, desc: 'npm 发布' },
  { re: /\brm\s+-[a-z]*f[a-z]*\s+\/+(?![\w.])/, desc: '删除根目录' }
];

function checkDangerousCommand(command) {
  for (const { re, desc } of DANGEROUS_PATTERNS) {
    if (re.test(command)) return desc;
  }
  return null;
}

/* 停止 Agent 时杀掉其已启动的子进程树 */
function killChildren(agent) {
  if (!agent.children) return;
  for (const child of agent.children) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      else child.kill('SIGKILL');
    } catch { /* ignore */ }
  }
  agent.children.clear();
}

async function executeTool(agent, name, args) {
  const cwd = agent.cwd;
  switch (name) {
    case 'list_dir': {
      const dir = resolveAgentPath(cwd, args.path || '.');
      assertInsideWorkspace(cwd, dir);
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      return entries.slice(0, 300)
        .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
        .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
        .join('\n') || '[空目录]';
    }
    case 'read_file': {
      const f = resolveAgentPath(cwd, args.path);
      assertInsideWorkspace(cwd, f);
      let content = await fsp.readFile(f, 'utf8');
      if (content.length > 80000) content = content.slice(0, 80000) + '\n...[文件过长已截断]';
      return content || '[空文件]';
    }
    case 'write_file': {
      const f = resolveAgentPath(cwd, args.path);
      assertInsideWorkspace(cwd, f);
      const newContent = args.content ?? '';
      let before = null, existed = false;
      try { before = await fsp.readFile(f, 'utf8'); existed = true; } catch { /* 新文件 */ }
      await fsp.mkdir(path.dirname(f), { recursive: true });
      await fsp.writeFile(f, newContent, 'utf8');
      if (before !== newContent) {
        const change = { path: f, relPath: path.relative(cwd, f), before, after: newContent, existed };
        agent.changes = agent.changes || [];
        agent.changes.push(change);
        emitAgent(agent, 'change', change);
      }
      // 通知文件树/编辑器刷新
      if (win && !win.isDestroyed()) win.webContents.send('fs:changed', { path: f });
      return `[OK] 已写入 ${f}（${newContent.length} 字符）`;
    }
    case 'run_command': {
      const cmd = args.command || 'echo no-command';
      const danger = checkDangerousCommand(cmd);
      if (danger) {
        return `[已拦截危险命令] 检测到「${danger}」，出于安全考虑已拒绝执行。\n如需执行请手动在系统终端操作。`;
      }
      const r = await runCommand(cwd, cmd, agent);
      return `退出码: ${r.code}\n${r.output}`;
    }
    default:
      return `[未知工具 ${name}]`;
  }
}

function emitAgent(agent, kind, payload = {}) {
  agent.log.push({ kind, ...payload, ts: Date.now() });
  if (win && !win.isDestroyed()) {
    win.webContents.send('agent:event', { id: agent.id, kind, ...payload });
  }
}

/* ---------------- 会话持久化 ---------------- */
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

ipcMain.handle('session:list', () => loadSessions());

/* 回滚单个文件变更（diff 审阅的「撤销」） */
async function revertFile({ path: p, before, existed }) {
  if (existed) {
    await fsp.writeFile(p, before ?? '', 'utf8');
  } else {
    await fsp.rm(p, { force: true });
  }
  if (win && !win.isDestroyed()) win.webContents.send('fs:changed', { path: p });
  return true;
}
ipcMain.handle('fs:revert', (_e, c) => revertFile(c));

let mockStep = 0;
async function chatCompletion(cfg, messages) {
  // Mock 模式：无 API Key 也可验证 Agent 工具循环是否打通
  if (process.env.MOCK_LLM) {
    mockStep++;
    if (mockStep === 1) {
      return { choices: [{ message: {
        content: '我先查看目录结构，然后尝试越界写入与危险命令（应被沙箱拦截），再正常写入并确认 Node 版本。',
        tool_calls: [
          { id: 'c1', function: { name: 'list_dir', arguments: '{"path":"."}' } },
          { id: 'c2', function: { name: 'write_file', arguments: JSON.stringify({ path: '../escape.txt', content: 'should be blocked' }) } },
          { id: 'c3', function: { name: 'run_command', arguments: '{"command":"rm -rf /tmp/x"}' } },
          { id: 'c4', function: { name: 'write_file', arguments: JSON.stringify({ path: 'agent-demo/hello.txt', content: 'hello from agent\n' }) } },
          { id: 'c5', function: { name: 'run_command', arguments: '{"command":"node --version"}' } }
        ]
      } }] };
    }
    return { choices: [{ message: { content: '任务完成，已创建 agent-demo/hello.txt。', tool_calls: [] } }] };
  }

  const res = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + cfg.apiKey
    },
    body: JSON.stringify({ model: cfg.model, messages, tools: AGENT_TOOLS, tool_choice: 'auto' })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text.slice(0, 400)}`);
  }
  return res.json();
}

async function chatCompletionStream(cfg, messages, onDelta) {
  const res = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + cfg.apiKey
    },
    body: JSON.stringify({ model: cfg.model, messages, tools: AGENT_TOOLS, tool_choice: 'auto', stream: true })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text.slice(0, 400)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let content = '';
  const toolMap = new Map(); // index -> { id, name, arguments }
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      const delta = json.choices && json.choices[0] && json.choices[0].delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        if (onDelta) onDelta(delta.content);
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const i = tc.index || 0;
          if (!toolMap.has(i)) toolMap.set(i, { id: '', name: '', arguments: '' });
          const acc = toolMap.get(i);
          if (tc.id) acc.id = tc.id;
          if (tc.function) {
            if (tc.function.name) acc.name += tc.function.name;
            if (tc.function.arguments) acc.arguments += tc.function.arguments;
          }
        }
      }
    }
  }
  const tool_calls = [...toolMap.values()].map((tc) => ({
    id: tc.id, function: { name: tc.name, arguments: tc.arguments }
  }));
  // 【token 计费预留】启用后在此记录本次调用用量（结构见 store/billing.js，当前 BILLING_ENABLED=false）
  return { content, tool_calls };
}

async function runAgent(agent) {
  const cfg = loadConfig();
  if (!cfg.apiKey && !process.env.MOCK_LLM) {
    agent.status = 'error';
    emitAgent(agent, 'error', { text: '未配置 API Key，请点击右上角「设置」填入你的 API Key 后重试。' });
    return;
  }
  const sys = [
    '你是运行在本地桌面应用「Cursor Local」中的编码 Agent。',
    `当前工作目录：${agent.cwd}`,
    '你可以使用工具：list_dir 查看目录、read_file 读文件、write_file 写文件（覆盖式，需完整内容）、run_command 执行终端命令。',
    '安全约束：所有文件读写必须限定在工作目录内（越界会被拦截）；run_command 不能执行 rm -rf、format、del /s /q、shutdown、git push --force 等危险命令（会被拦截）。',
    '请自主完成用户任务：先查看相关文件结构，再读取/修改代码，必要时运行命令验证。',
    '用简体中文简要说明每一步在做什么。写文件时必须给出完整最终内容。'
  ].join('\n');
  agent.messages = [
    { role: 'system', content: sys },
    { role: 'user', content: agent.task }
  ];
  agent.status = 'running';
  emitAgent(agent, 'status', { status: 'running' });
  await agentLoop(agent, cfg);
}

/* Agent 工具循环（新建与 followup 续跑共用） */
async function agentLoop(agent, cfg) {
  try {
    for (let i = 0; i < 30; i++) {
      let content = '';
      let calls = [];
      if (process.env.MOCK_LLM) {
        const resp = await chatCompletion(cfg, agent.messages);
        const msg = resp.choices && resp.choices[0] && resp.choices[0].message;
        if (!msg) throw new Error('API 返回格式异常');
        content = msg.content || '';
        calls = msg.tool_calls || [];
        if (content) emitAgent(agent, 'text', { text: content });
        agent.messages.push(msg);
      } else {
        const r = await chatCompletionStream(cfg, agent.messages, (delta) => {
          emitAgent(agent, 'text_delta', { text: delta });
        });
        content = r.content;
        calls = r.tool_calls;
        agent.messages.push({
          role: 'assistant',
          content: content || null,
          tool_calls: calls.length ? calls : undefined
        });
      }
      if (!calls.length) {
        agent.status = 'done';
        emitAgent(agent, 'status', { status: 'done' });
        return;
      }
      for (const tc of calls) {
        let fnName = tc.function && tc.function.name || 'unknown';
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* 忽略 */ }
        emitAgent(agent, 'tool_call', { name: fnName, args });
        let result;
        try {
          result = await executeTool(agent, fnName, args);
        } catch (err) {
          result = 'ERROR: ' + err.message;
        }
        result = String(result);
        emitAgent(agent, 'tool_result', { name: fnName, result: result.slice(0, 3000) });
        agent.messages.push({ role: 'tool', tool_call_id: tc.id, content: result.slice(0, 12000) });
      }
    }
    agent.status = 'done';
    emitAgent(agent, 'status', { status: 'done' });
  } catch (err) {
    agent.status = 'error';
    emitAgent(agent, 'error', { text: String(err.message || err) });
  } finally {
    saveSession(agent); // 会话持久化
  }
}

let agentSeq = 0;
ipcMain.handle('agent:create', (_e, { task, cwd }) => {
  agentSeq += 1;
  const agent = {
    id: 'agent-' + Date.now() + '-' + agentSeq,
    task: String(task || '').trim(),
    cwd: cwd || __dirname,
    status: 'running',
    messages: [],
    log: [],
    children: new Set()
  };
  agents.set(agent.id, agent);
  emitAgent(agent, 'meta', { task: agent.task, cwd: agent.cwd, ts: Date.now() });
  runAgent(agent); // 异步并行运行
  return { id: agent.id };
});

ipcMain.handle('agent:list', () => {
  return [...agents.values()].map((a) => ({
    id: a.id, task: a.task, cwd: a.cwd, status: a.status, log: a.log
  }));
});

ipcMain.handle('agent:stop', (_e, id) => {
  const a = agents.get(id);
  if (a) {
    a.status = 'stopped';
    killChildren(a); // 真正终止其子进程树
    emitAgent(a, 'status', { status: 'stopped' });
  }
  return true;
});

/* 对已结束的 Agent 追加后续任务，续跑同一会话（Cursor 式 follow-up） */
ipcMain.handle('agent:followup', (_e, { id, task }) => {
  const a = agents.get(id);
  if (!a) return { ok: false, error: 'Agent 不存在' };
  if (a.status === 'running') return { ok: false, error: 'Agent 仍在运行中，请等待完成' };
  const t = String(task || '').trim();
  if (!t) return { ok: false, error: '任务不能为空' };
  if (!a.messages || !a.messages.length) return { ok: false, error: '会话为空' };
  a.messages.push({ role: 'user', content: t });
  emitAgent(a, 'user_msg', { text: t });
  a.status = 'running';
  emitAgent(a, 'status', { status: 'running' });
  agentLoop(a, loadConfig()); // 续跑（复用已有上下文）
  return { ok: true };
});

/* ---------------- 用户系统（本地存储 + 预留云接口） ---------------- */
const sessionFile = () => path.join(app.getPath('userData'), 'session.json');
function getSession() {
  try { return JSON.parse(fs.readFileSync(sessionFile(), 'utf8')); } catch { return null; }
}
function setSession(s) {
  if (s) {
    fs.mkdirSync(path.dirname(sessionFile()), { recursive: true });
    fs.writeFileSync(sessionFile(), JSON.stringify(s), 'utf8');
  } else {
    try { fs.rmSync(sessionFile(), { force: true }); } catch { /* 忽略 */ }
  }
}

ipcMain.handle('auth:register', (_e, { username, email, password }) => {
  const store = getUserStore();
  if (!username || !password) return { ok: false, error: '用户名和密码不能为空' };
  if (store.findByUsername(username)) return { ok: false, error: '用户名已存在' };
  if (email && store.findByEmail(email)) return { ok: false, error: '邮箱已被注册' };
  const user = store.createUser({ username, email, password });
  setSession({ userId: user.id });
  return { ok: true, user };
});

ipcMain.handle('auth:login', (_e, { account, password }) => {
  const store = getUserStore();
  const user = store.findByUsername(account) || store.findByEmail(account);
  if (!user || !store.verifyPassword(user, password)) {
    return { ok: false, error: '用户名/邮箱或密码错误' };
  }
  setSession({ userId: user.id });
  return { ok: true, user };
});

ipcMain.handle('auth:logout', () => { setSession(null); return { ok: true }; });
ipcMain.handle('auth:current', () => {
  const s = getSession();
  return s ? getUserStore().getUser(s.userId) : null;
});
ipcMain.handle('auth:updateProfile', (_e, patch) => {
  const s = getSession();
  if (!s) return { ok: false, error: '未登录' };
  return { ok: true, user: getUserStore().updateUser(s.userId, patch) };
});

/* ---------------- token 计费（结构占位，暂不启用） ---------------- */
ipcMain.handle('billing:query', (_e, userId) => billing.queryBilling(userId));

/* ---------------- 窗口 ---------------- */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function captureTo(file) {
  win.webContents.invalidate();
  await sleep(600);
  const img = await win.webContents.capturePage();
  const png = img.toPNG();
  fs.writeFileSync(file, png);
  console.log('[shot]', path.basename(file), png.length, 'bytes');
}

let screenshotRunning = false;
async function takeScreenshots() {
  if (screenshotRunning) return; // 防重入：did-finish-load 可能触发多次
  screenshotRunning = true;
  const shotDir = path.join(__dirname, 'screenshots');
  fs.mkdirSync(shotDir, { recursive: true });
  try {
    await sleep(2500); // 等待 monaco 加载

    // 1. 主页
    const homeDbg = await win.webContents.executeJavaScript(`JSON.stringify({
      themeCards: document.querySelectorAll('.theme-card').length,
      orbs: document.querySelectorAll('.orb').length,
      segPill: document.querySelectorAll('.seg-pill button').length,
      chipBtns: document.querySelectorAll('.chip-btn').length,
      composer: !!document.getElementById('home-composer'),
      sendBtn: !!document.getElementById('home-send'),
      followup: !!document.getElementById('followup-input'),
      snavItems: document.querySelectorAll('.snav-item').length,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      homeActive: document.getElementById('home-view').classList.contains('active'),
      lucideIcons: document.querySelectorAll('svg.lucide').length
    })`);
    console.log('[debug home]', homeDbg);
    await captureTo(path.join(shotDir, '01-home.png'));

    // 2. Editor
    await win.webContents.executeJavaScript(
      `window.__openFolderForDemo(${JSON.stringify(__dirname)}); switchMode('editor');`
    );
    await sleep(1000);
    const dbg = await win.webContents.executeJavaScript('JSON.stringify(window.__debugState())');
    console.log('[debug editor]', dbg);
    const themeTest = await win.webContents.executeJavaScript(`(async () => {
      const r = {};
      try {
        await setTheme('violet', null);
        r.violet = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
        await setTheme('custom', '#10b981');
        r.custom = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
        await setTheme('blue', null);
        r.blue = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      } catch (e) { r.err = String(e.message || e); }
      return JSON.stringify(r);
    })()`);
    console.log('[debug theme]', themeTest);
    await captureTo(path.join(shotDir, '02-editor.png'));

    // 3. Agents
    await win.webContents.executeJavaScript(`switchMode('agents'); window.__demoAgentEntry();`);
    await sleep(800);
    const dbg2 = await win.webContents.executeJavaScript('JSON.stringify(window.__debugAgents())');
    console.log('[debug agents]', dbg2);
    await captureTo(path.join(shotDir, '03-agents.png'));
  } catch (err) {
    console.error('[shot] FAILED:', err);
  }
  app.quit();
}

function runAgentTest() {
  console.log('[test-agent] 开始');
  // 验证 API Key 加密存储（隔离临时配置，不影响真实配置）
  const testKey = 'sk-test-encrypt-12345';
  saveConfig({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', lastFolder: '', apiKey: testKey });
  const rawFile = fs.readFileSync(configPath(), 'utf8');
  console.log('[test-agent] 明文 key 出现在配置 =', rawFile.includes(testKey), '(应为 false)');
  console.log('[test-agent] 配置含 apiKeyEncrypted 字段 =', rawFile.includes('apiKeyEncrypted'), '(应为 true)');
  console.log('[test-agent] 解密回读 =', loadConfig().apiKey === testKey ? 'OK' : 'FAIL');
  saveConfig({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', lastFolder: '', apiKey: '' });

  const testFile = path.join(__dirname, 'agent-demo', 'hello.txt');
  try { fs.rmSync(path.join(__dirname, 'agent-demo'), { recursive: true, force: true }); } catch { /* 忽略 */ }
  const agent = { id: 'test-agent', task: '验证 Agent 工具循环', cwd: __dirname, status: 'running', messages: [], log: [], children: new Set() };
  agents.set(agent.id, agent);
  emitAgent(agent, 'meta', { task: agent.task, cwd: agent.cwd, ts: Date.now() });
  runAgent(agent).then(async () => {
    try {
      console.log('[test-agent] status =', agent.status);
      console.log('[test-agent] file written =', fs.existsSync(testFile));
      if (fs.existsSync(testFile)) console.log('[test-agent] file content =', JSON.stringify(fs.readFileSync(testFile, 'utf8')));
      agent.log.filter((l) => l.kind === 'tool_result').forEach((l) =>
        console.log('[test-agent] tool_result:', l.name, '=>', String(l.result).replace(/\n/g, ' ').slice(0, 90))
      );
      // 验证回滚：hello.txt 是 write_file 新建的（existed=false），回滚应删除它
      await revertFile({ path: testFile, before: null, existed: false });
      console.log('[test-agent] revert 删除新文件 =', !fs.existsSync(testFile), '(应为 true)');
      // 验证回滚：已存在文件写回旧内容
      const revFile = path.join(__dirname, 'agent-demo', 'rev.txt');
      await fsp.writeFile(revFile, 'new', 'utf8');
      await revertFile({ path: revFile, before: 'old', existed: true });
      console.log('[test-agent] revert 写回旧内容 =', fs.readFileSync(revFile, 'utf8') === 'old' ? 'OK' : 'FAIL');
    } catch (e) {
      console.error('[test-agent] verify error:', e.message);
    }
    app.quit();
  });
}

process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#1e1e1e',
    // Win11 云母/亚克力材质（Windows 11 22H2+ 生效，其余系统自动忽略，CSS 兜底）
    backgroundMaterial: 'mica',
    title: 'Cursor Local',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('console-message', (a, b, c) => {
    let level, msg;
    if (typeof b === 'number') { level = b; msg = c; }          // 旧签名 (event, level, message...)
    else if (a && typeof a === 'object') { level = a.level; msg = a.message; } // 新签名
    else { level = '?'; msg = String(a); }
    if (level === 'error') {
      console.log('[console:error]', msg);
    }
  });
  win.webContents.on('did-finish-load', () => {
    if (process.env.TEST_AGENT) runAgentTest();
    else if (process.env.SHOT_MODE) takeScreenshots();
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  // 退出时清理所有 Agent 残留子进程
  for (const a of agents.values()) killChildren(a);
});
