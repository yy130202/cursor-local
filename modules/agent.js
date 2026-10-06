/* Cursor Local - Agent 引擎模块（工具循环 / 沙箱 / 权限 / LLM 调用） */
const path = require('path');
const fsp = require('fs').promises;
const { spawn } = require('child_process');
const { createToolHandlers } = require('./agent/tools');

function createAgentModule({ winRef, addLog, loadConfig, agents, saveSession, rootDir, memory }) {
  const win = () => winRef();

  /* ---- 终端命令执行 ---- */
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
      child.stdout.on('data', (d) => {
        const chunk = decodeOut(d);
        stdout += chunk; if (stdout.length > 200000) stdout = stdout.slice(0, 200000);
        if (agent && chunk) emitAgent(agent, 'cmd_delta', { chunk });
      });
      child.stderr.on('data', (d) => {
        const chunk = decodeOut(d);
        stderr += chunk; if (stderr.length > 100000) stderr = stderr.slice(0, 100000);
        if (agent && chunk) emitAgent(agent, 'cmd_delta', { chunk, stderr: true });
      });
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

  /* ---- Agent 工具定义 ---- */
  const AGENT_TOOLS = [
    { type: 'function', function: { name: 'list_dir', description: '列出目录内容，返回条目列表（目录以 / 结尾）', parameters: { type: 'object', properties: { path: { type: 'string', description: '目录路径，相对工作目录或绝对路径' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'list_tree', description: '递归列出目录树（限制深度，跳过 node_modules/.git）', parameters: { type: 'object', properties: { path: { type: 'string', description: '起始目录路径' }, depth: { type: 'number', description: '递归深度（默认 3）' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'read_file', description: '读取文件内容（过大自动截断）', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'write_file', description: '写入文件（覆盖式，需提供完整最终内容；目录不存在会自动创建）', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' }, content: { type: 'string', description: '完整文件内容' } }, required: ['path', 'content'] } } },
    { type: 'function', function: { name: 'delete_file', description: '删除文件或空目录', parameters: { type: 'object', properties: { path: { type: 'string', description: '要删除的文件路径' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'move_file', description: '移动或重命名文件/目录', parameters: { type: 'object', properties: { from: { type: 'string', description: '源路径' }, to: { type: 'string', description: '目标路径' } }, required: ['from', 'to'] } } },
    { type: 'function', function: { name: 'search_files', description: '在目录中搜索包含关键词的文件（返回文件、行号、内容）', parameters: { type: 'object', properties: { pattern: { type: 'string', description: '搜索关键词' }, path: { type: 'string', description: '起始目录，默认工作目录' } }, required: ['pattern'] } } },
    { type: 'function', function: { name: 'get_file_info', description: '获取文件信息（大小、修改时间、类型）', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'run_command', description: '在工作目录执行终端命令（npm/node/python/git 等），返回退出码和输出', parameters: { type: 'object', properties: { command: { type: 'string', description: '要执行的命令' } }, required: ['command'] } } }
  ];

  function resolveAgentPath(cwd, p) {
    return path.isAbsolute(p) ? p : path.resolve(cwd, p);
  }

  function assertInsideWorkspace(cwd, target) {
    let rel;
    try { rel = path.relative(path.resolve(cwd), path.resolve(target)); } catch { rel = target; }
    // Windows 路径大小写不敏感：先按原值判，再按小写判，任一判定在工作区内才放行
    const relLc = rel.toLowerCase();
    const inside = (r) => r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
    if (inside(rel) && inside(relLc)) return;
    throw new Error(`沙箱拦截：禁止访问工作目录之外的路径（${target}）`);
  }

  const DANGEROUS_PATTERNS = [
    // rm 递归强制删除：覆盖 -rf/-fr、-r -f 分离、--recursive/--force 长选项
    { re: /\brm\b[^\n]*\s-[a-z]*r[a-z]*f\b/i, desc: 'rm 递归强制删除' },
    { re: /\brm\b[^\n]*\s-[a-z]*f[a-z]*r\b/i, desc: 'rm 递归强制删除' },
    { re: /\brm\b[^\n]*\s-[a-z]*r\b[^\n]*\s-[a-z]*f\b/i, desc: 'rm -r -f 递归强制删除' },
    { re: /\brm\b[^\n]*\s--(recursive|force)\b/i, desc: 'rm --recursive/--force 递归删除' },
    { re: /\brd\b[^\n]*\s\/[a-z]*s\b/i, desc: 'rd /s 递归删除目录' },
    { re: /\brd\b[^\n]*\s\/[a-z]*q\b/i, desc: 'rd /q 静默删除目录' },
    { re: /\brmdir\b[^\n]*\s\/[a-z]*[sq]\b/i, desc: 'rmdir /s /q 递归删除目录' },
    { re: /\bdel\b[^\n]*\s\/[a-z]*[fsq]\b/i, desc: 'del /s /f /q 递归强制删除' },
    { re: /\bremove-item\b[^\n]*\s-[a-z]*r\b/i, desc: 'PowerShell Remove-Item 递归删除' },
    { re: /\bremove-item\b[^\n]*\s-[a-z]*fo/i, desc: 'PowerShell Remove-Item 强制删除' },
    { re: /\bformat\b/i, desc: '格式化磁盘' },
    { re: /\bmkfs(\.\w+)?\b/i, desc: '创建文件系统（格式化）' },
    { re: /\bdd\s+if=/i, desc: 'dd 磁盘写入' },
    { re: /\bshutdown\b/i, desc: '关机' },
    { re: /\breboot\b/i, desc: '重启' },
    { re: /\bdiskpart\b/i, desc: '磁盘分区' },
    { re: /\bchmod\s+-R\s+777\b/i, desc: '全目录 777 权限' },
    { re: /\bgit\s+push\s+(-f|--force)\b/i, desc: 'git 强制推送' },
    { re: /\bnpm\s+(publish|unpublish)\b/i, desc: 'npm 发布/撤回' },
    { re: /\bcipher\s+\/w\b/i, desc: 'cipher /w 覆写空闲空间' },
    { re: /\btakeown\b[^\n]*\/r\b/i, desc: 'takeown 递归夺取所有权' },
    { re: /\breg\s+delete\b/i, desc: '注册表删除' },
    { re: /\bfind\b[^\n]*\s-delete\b/i, desc: 'find -delete 批量删除' },
    { re: /\bmv\b[^\n]*\/dev\/null\b/i, desc: 'mv 到 /dev/null 销毁文件' }
  ];

  /* 预归一化：去 ANSI、统一空白、拆掉反斜杠转义与引号，消除 shell 层面的等价绕过写法 */
  function normalizeCommand(command) {
    return String(command)
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') // ANSI 转义
      .replace(/[\t\r\n]+/g, ' ')             // 跨行/多空格 → 单空格
      .replace(/\s{2,}/g, ' ')
      .replace(/\\(?=[A-Za-z/\\])/g, '')       // sh\utdown -> shutdown
      .replace(/["']/g, '')                    // 去引号：rm "-rf" -> rm -rf
      .toLowerCase();
  }

  function checkDangerousCommand(command) {
    const c = normalizeCommand(command);
    for (const { re, desc } of DANGEROUS_PATTERNS) {
      if (re.test(c)) return desc;
    }
    return null;
  }

  const CATASTROPHIC_PATTERNS = [
    { re: /\bformat\b/i, desc: '格式化磁盘' },
    { re: /\bmkfs(\.\w+)?\b/i, desc: '创建文件系统' },
    { re: /\bdd\s+if=/i, desc: 'dd 磁盘写入' },
    { re: /\bshutdown\b/i, desc: '关机' },
    { re: /\breboot\b/i, desc: '重启' },
    { re: /\b:\(\)\s*\{\s*:\|:\s*&\s*\};:/, desc: 'fork 炸弹' },
    { re: /\bdiskpart\b/i, desc: '磁盘分区' }
  ];
  function checkCatastrophic(command) {
    const c = normalizeCommand(command);
    for (const { re, desc } of CATASTROPHIC_PATTERNS) {
      if (re.test(c)) return desc;
    }
    return null;
  }

  function isFullControl() {
    try { return loadConfig().permission === 'full'; } catch { return false; }
  }

  /* ---- 审批流（手动审批模式：敏感操作需用户确认，参考 CodeBuddy 三档权限） ---- */
  const APPROVAL_TOOLS = new Set(['write_file', 'create_file', 'create_dir', 'delete_file', 'delete_path', 'move_file', 'move_path', 'apply_patch', 'run_command']);
  const pendingApprovals = new Map();
  let approvalSeq = 0;
  function needsApproval(agent, tool) {
    if (agent.readonly) return false;
    let perm = 'safe';
    try { perm = loadConfig().permission || 'safe'; } catch { /* ignore */ }
    if (perm !== 'manual') return false;
    return APPROVAL_TOOLS.has(tool);
  }
  function requestApproval(agent, tool, args) {
    return new Promise((resolve) => {
      const callId = 'ap-' + Date.now() + '-' + (++approvalSeq);
      const entry = {
        agentId: agent.id, resolve,
        settle: (v) => { if (pendingApprovals.has(callId)) { pendingApprovals.delete(callId); resolve(v); } }
      };
      pendingApprovals.set(callId, entry);
      agent.__pending = agent.__pending || new Set();
      agent.__pending.add(callId);
      emitAgent(agent, 'approval', { callId, tool, args });
      setTimeout(() => entry.settle(false), 120000);
    });
  }

  /* 停止 / 结束时清空该 agent 挂起的审批（resolve 为拒绝，避免停止后仍执行已批准操作） */
  function clearPendingApprovals(agent) {
    if (!agent.__pending) return;
    for (const callId of [...agent.__pending]) {
      const e = pendingApprovals.get(callId);
      if (e) e.settle(false);
    }
    agent.__pending.clear();
  }

  async function searchInDir(folder, pattern, maxResults = 50) {
    const results = [];
    const needle = String(pattern).toLowerCase();
    async function walk(dir, depth) {
      if (results.length >= maxResults || depth > 10) return;
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        if (results.length >= maxResults) return;
        if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist') continue;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) { await walk(p, depth + 1); continue; }
        try {
          const stat = await fsp.stat(p);
          if (stat.size > 500000) continue;
          const content = await fsp.readFile(p, 'utf8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().indexOf(needle) >= 0) {
              results.push(path.relative(folder, p) + ':' + (i + 1) + ': ' + lines[i].slice(0, 160));
              if (results.length >= maxResults) return;
            }
          }
        } catch { /* 忽略二进制 */ }
      }
    }
    await walk(folder, 0);
    return results;
  }

  function killChildren(agent) {
    if (!agent.children || !agent.children.size) return;
    // 先快照并清空，避免迭代中 close 回调删除元素导致漏杀
    const list = [...agent.children];
    agent.children.clear();
    for (const child of list) {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        else child.kill('SIGKILL');
      } catch { /* ignore */ }
    }
  }

  /* 沙箱的真实路径校验：解符号链接 / junction，防止 link-out -> 界外目录 的绕过。
     （assertInsideWorkspace 只做词法判断，对已存在路径不可信）*/
  async function assertRealInsideWorkspace(cwd, target) {
    try {
      const realCwd = await fsp.realpath(path.resolve(cwd));
      let realTarget;
      try { realTarget = await fsp.realpath(path.resolve(target)); }
      catch { realTarget = await fsp.realpath(path.dirname(path.resolve(target))).then((d) => path.join(d, path.basename(target))).catch(() => path.resolve(target)); }
      const rel = path.relative(realCwd, realTarget);
      const relLc = rel.toLowerCase();
      const inside = (r) => r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
      if (inside(rel) && inside(relLc)) return;
      throw new Error(`沙箱拦截：解析后路径在工作目录之外（${target}）`);
    } catch (e) {
      if (e && /沙箱拦截/.test(e.message)) throw e;
      // realpath 失败（路径还不存在等）→ 回退词法校验
      assertInsideWorkspace(cwd, target);
    }
  }

  function emitAgent(agent, kind, payload = {}) {
    agent.log.push({ kind, ...payload, ts: Date.now() });
    const w = win();
    if (w && !w.isDestroyed()) w.webContents.send('agent:event', { id: agent.id, kind, ...payload });
  }

  /* 工具处理器表：工具行为在 modules/agent/tools.js，此处仅做依赖注入 */
  const TOOL_HANDLERS = createToolHandlers({
    fsp, path, win, addLog, runCommand, searchInDir,
    resolveAgentPath, assertRealInsideWorkspace, emitAgent,
    checkDangerousCommand, checkCatastrophic
  });

  /* 工具分发器：只负责「模式拦截 → 构造上下文 → 表驱动调用 → 统一错误包装」。
     新增工具只需在 tools.js 追加处理器，本函数永远不需要改动。 */
  async function executeTool(agent, name, args) {
    if (agent.readonly && APPROVAL_TOOLS.has(name)) {
      return 'ERROR: 当前为 Ask 只读模式，已拦截修改类操作 ' + name;
    }
    const handler = TOOL_HANDLERS[name];
    if (!handler) return `[未知工具 ${name}]`;
    const full = isFullControl();
    addLog('debug', 'tool', `${name} ${JSON.stringify(args || {}).slice(0, 140)}`);
    const cwd = agent.cwd;
    const ctx = {
      agent, args, cwd, full,
      resolve: (p) => resolveAgentPath(cwd, p),
      guard: (target) => (full ? Promise.resolve() : assertRealInsideWorkspace(cwd, target)),
      log: (level, msg) => addLog(level, 'tool', msg)
    };
    try {
      return await handler(ctx);
    } catch (err) {
      addLog('error', 'tool', `${name} 失败: ${err.message}`);
      return 'ERROR: ' + err.message;
    }
  }

  /* ---- LLM 调用 ---- */
  let mockStep = 0;
  async function chatCompletion(cfg, messages) {
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
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({ model: cfg.model, messages, tools: AGENT_TOOLS, tool_choice: 'auto' })
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API ${res.status}: ${text.slice(0, 400)}`);
    }
    return res.json();
  }

  async function chatCompletionStream(cfg, messages, onDelta, onReasoning) {
    const res = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({ model: cfg.model, messages, tools: AGENT_TOOLS, tool_choice: 'auto', stream: true })
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API ${res.status}: ${text.slice(0, 400)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const argAcc = { content: '', toolMap: new Map() };
    // 单行 SSE 处理：抽为闭包，供主循环与尾缓冲复用
    function handleSseLine(line, accState) {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let json;
      try { json = JSON.parse(data); } catch { return; }
      const delta = json.choices && json.choices[0] && json.choices[0].delta;
      if (!delta) return;
      if (delta.content) {
        accState.content += delta.content;
        if (onDelta) onDelta(delta.content);
      }
      // 推理模型（DeepSeek-R1 等）的思考流 → 单独转发用于「思考框」流式展示
      const rc = delta.reasoning_content || delta.reasoning;
      if (rc) { if (onReasoning) onReasoning(rc); }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const i = tc.index || 0;
          if (!accState.toolMap.has(i)) accState.toolMap.set(i, { id: '', name: '', arguments: '' });
          const tcAcc = accState.toolMap.get(i);
          if (tc.id) tcAcc.id = tc.id;
          if (tc.function) {
            // name 只取首个非空值：部分网关会在多个分片重复携带 name，累加会导致 "write_filewrite_file"
            if (tc.function.name && !tcAcc.name) tcAcc.name = tc.function.name;
            if (tc.function.arguments) tcAcc.arguments += tc.function.arguments;
          }
        }
      }
    }
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        handleSseLine(line, argAcc);
      }
    }
    buffer += decoder.decode(); // 冲刷解码器残留
    if (buffer.trim()) {
      for (const line of buffer.split('\n')) handleSseLine(line.trim(), argAcc);
    }
    const tool_calls = [...argAcc.toolMap.values()].map((tc) => ({ id: tc.id, function: { name: tc.name, arguments: tc.arguments } }));
    return { content: argAcc.content, tool_calls };
  }

  async function runAgent(agent) {
    const cfg = loadConfig();
    if (!cfg.apiKey && !process.env.MOCK_LLM) {
      agent.status = 'error';
      emitAgent(agent, 'error', { text: '未配置 API Key，请点击右上角「设置」填入你的 API Key 后重试。' });
      return;
    }
    const perm = cfg.permission || 'safe';
    const sys = [
      '你是运行在本地桌面应用「Cursor Local」中的编码 Agent。',
      `当前工作目录：${agent.cwd}`,
      '你可以使用工具：list_dir 查看目录、list_tree 查看目录树、read_file 读文件、write_file 写文件（覆盖式，需完整内容）、delete_file 删除文件、move_file 移动/重命名、search_files 搜索代码、get_file_info 查看文件信息、run_command 执行终端命令。',
      '权限说明：' + (perm === 'full'
        ? '当前为「完全访问」模式——可读写任意路径、执行任意命令（磁盘格式化/关机等毁灭性操作仍会被拦截）。'
        : perm === 'manual'
        ? '当前为「手动审批」模式——文件写入、删除、移动、命令执行等敏感操作需要用户逐条确认后才会执行，被拒绝时请调整方案。'
        : '当前为「自动审批」模式——文件读写必须限定在工作目录内（越界会被拦截）；run_command 不能执行 rm -rf、format、del /s /q、shutdown、git push --force 等危险命令（会被拦截）。'),
      '请自主完成用户任务：先查看相关文件结构，再读取/修改代码，必要时运行命令验证。',
      '【重要】每次调用工具前后都必须用简体中文给用户文字反馈：调用前说明意图，调用后总结结果与发现。绝对不要只甩出工具调用而不给任何文字说明。',
      '任务收尾时必须给出总结：做了什么、发现了什么、结论与建议的下一步。写文件时必须给出完整最终内容。',
      agent.mode === 'plan' ? '【计划模式】只输出实施计划（步骤、涉及文件、风险点），不要调用任何工具、不要修改任何文件。' : '',
      agent.mode === 'ask' ? '【问答模式】只回答问题与解释代码，不要调用修改类工具。' : ''
    ].filter(Boolean);
    // 注入记忆与规则（跨会话共享的用户偏好 / 项目规则）
    if (memory) {
      try {
        const mem = memory.getMemory(agent.cwd) || { global: [], project: [] };
        const rules = memory.getRules(agent.cwd) || { user: '', project: '' };
        if (mem.global && mem.global.length) sys.push('【用户长期偏好】\n' + mem.global.map((m) => '- ' + m.text).join('\n'));
        if (mem.project && mem.project.length) sys.push('【项目偏好】\n' + mem.project.map((m) => '- ' + m.text).join('\n'));
        if (rules.user && rules.user.trim()) sys.push('【用户规则】\n' + rules.user.trim());
        if (rules.project && rules.project.trim()) sys.push('【项目规则】\n' + rules.project.trim());
      } catch { /* ignore */ }
    }
    const sysText = sys.join('\n');
    agent.messages = [
      { role: 'system', content: sysText },
      { role: 'user', content: agent.task }
    ];
    agent.status = 'running';
    emitAgent(agent, 'status', { status: 'running' });
    await agentLoop(agent, cfg);
  }

  async function agentLoop(agent, cfg) {
    try {
      for (let i = 0; i < 30; i++) {
        if (agent.status === 'stopped' || agent.status === 'error') return; // 已停止则不再继续
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
          }, (rc) => {
            emitAgent(agent, 'reasoning_delta', { text: rc });
          });
          content = r.content;
          calls = r.tool_calls;
          agent.messages.push({ role: 'assistant', content: content || null, tool_calls: calls.length ? calls : undefined });
        }
        if (!calls.length) {
          // 兜底：LLM 没有输出任何文字就结束（只甩工具不总结）→ 追问一次总结
          if ((!content || !content.trim()) && !agent.__askedSummary) {
            agent.__askedSummary = true;
            agent.messages.push({ role: 'user', content: '请用简体中文简要总结：你刚才做了什么、发现了什么、结论是什么、建议的下一步是什么。' });
            continue;
          }
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
          // 手动审批：敏感操作等用户确认
          if (needsApproval(agent, fnName)) {
            const ok = await requestApproval(agent, fnName, args);
            if (!ok) {
              result = '用户拒绝执行 ' + fnName + '，请调整方案或先向用户说明理由。';
              emitAgent(agent, 'tool_result', { name: fnName, result });
              agent.messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
              continue;
            }
          }
          try { result = await executeTool(agent, fnName, args); }
          catch (err) { result = 'ERROR: ' + err.message; }
          result = String(result);
          emitAgent(agent, 'tool_result', { name: fnName, result: result.slice(0, 3000) });
          agent.messages.push({ role: 'tool', tool_call_id: tc.id, content: result.slice(0, 12000) });
        }
      }
      agent.status = 'done';
      emitAgent(agent, 'status', { status: 'done' });
      addLog('info', 'agent', `Agent 完成：${agent.task.slice(0, 60)}`);
    } catch (err) {
      agent.status = 'error';
      emitAgent(agent, 'error', { text: String(err.message || err) });
      addLog('error', 'agent', `Agent 出错：${String(err.message || err).slice(0, 200)}`);
    } finally {
      // 收尾：清理待审批 + 子进程 + 截断日志（防常驻/长任务内存累积）
      clearPendingApprovals(agent);
      killChildren(agent);
      if (agent.log.length > 200) agent.log = agent.log.slice(-200);
      saveSession(agent);
    }
  }

  /* ---- IPC 注册 ---- */
  let agentSeq = 0;
  function register(ipcMain) {
    ipcMain.handle('agent:create', (_e, { task, cwd, mode }) => {
      agentSeq += 1;
      const agent = {
        id: 'agent-' + Date.now() + '-' + agentSeq,
        task: String(task || '').trim(),
        cwd: cwd || rootDir,
        mode: mode || 'craft',
        readonly: mode === 'ask',
        status: 'running',
        messages: [],
        log: [],
        children: new Set()
      };
      agents.set(agent.id, agent);
      emitAgent(agent, 'meta', { task: agent.task, cwd: agent.cwd, ts: Date.now() });
      runAgent(agent);
      return { id: agent.id };
    });

    ipcMain.handle('agent:approval', (_e, { callId, allowed }) => {
      const entry = pendingApprovals.get(callId);
      if (entry) entry.settle(!!allowed);
      return true;
    });

    ipcMain.handle('agent:list', () => {
      return [...agents.values()].map((a) => ({ id: a.id, task: a.task, cwd: a.cwd, status: a.status, log: a.log }));
    });

    ipcMain.handle('agent:stop', (_e, id) => {
      const a = agents.get(id);
      if (a) {
        a.status = 'stopped';
        clearPendingApprovals(a); // 先拒绝挂起审批，再杀进程
        killChildren(a);
        if (a.log.length > 200) a.log = a.log.slice(-200);
        emitAgent(a, 'status', { status: 'stopped' });
      }
      return true;
    });

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
      agentLoop(a, loadConfig());
      return { ok: true };
    });
  }

  return { register, executeTool, runAgent, killChildren, emitAgent, clearPendingApprovals };
}

module.exports = { createAgentModule };
