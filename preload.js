// Cursor Local - 预加载脚本（contextBridge 安全暴露 IPC）
const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');

contextBridge.exposeInMainWorld('api', {
  // 文件系统
  readDir: (p) => ipcRenderer.invoke('fs:readDir', p),
  readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
  writeFile: (p, c) => ipcRenderer.invoke('fs:writeFile', p, c),
  createFile: (p) => ipcRenderer.invoke('fs:createFile', p),
  createDir: (p) => ipcRenderer.invoke('fs:createDir', p),
  rename: (from, to) => ipcRenderer.invoke('fs:rename', { from, to }),
  deletePath: (p) => ipcRenderer.invoke('fs:delete', p),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  // 配置
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (c) => ipcRenderer.invoke('config:set', c),
  // Agent
  createAgent: (a) => ipcRenderer.invoke('agent:create', a),
  listAgents: () => ipcRenderer.invoke('agent:list'),
  stopAgent: (id) => ipcRenderer.invoke('agent:stop', id),
  followAgent: (id, task) => ipcRenderer.invoke('agent:followup', { id, task }),
  onAgentEvent: (cb) => ipcRenderer.on('agent:event', (_e, ev) => cb(ev)),
  // 会话持久化
  listSessions: () => ipcRenderer.invoke('session:list'),
  deleteSession: (id) => ipcRenderer.invoke('session:delete', id),
  clearSessions: () => ipcRenderer.invoke('session:clear'),
  toggleFullscreen: () => ipcRenderer.invoke('window:toggleFullscreen'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  exportSession: (id) => ipcRenderer.invoke('session:export', id),
  // Git
  gitStatus: (cwd) => ipcRenderer.invoke('git:status', cwd),
  gitSideBySide: (cwd, file, staged) => ipcRenderer.invoke('git:sideBySide', { cwd, file, staged }),
  gitChangedLines: (cwd, file) => ipcRenderer.invoke('git:changedLines', { cwd, file }),
  gitStage: (cwd, file) => ipcRenderer.invoke('git:stage', { cwd, file }),
  gitUnstage: (cwd, file) => ipcRenderer.invoke('git:unstage', { cwd, file }),
  gitStageAll: (cwd) => ipcRenderer.invoke('git:stageAll', cwd),
  gitUnstageAll: (cwd) => ipcRenderer.invoke('git:unstageAll', cwd),
  gitClone: (url, dest) => ipcRenderer.invoke('git:clone', { url, dest }),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  agentApproval: (callId, allowed) => ipcRenderer.invoke('agent:approval', { callId, allowed }),
  // 记忆与规则
  memoryGet: (cwd) => ipcRenderer.invoke('memory:get', cwd),
  memoryAdd: (cwd, scope, text) => ipcRenderer.invoke('memory:add', { cwd, scope, text }),
  memoryRemove: (cwd, scope, id) => ipcRenderer.invoke('memory:remove', { cwd, scope, id }),
  memoryClear: (cwd, scope) => ipcRenderer.invoke('memory:clear', { cwd, scope }),
  rulesGet: (cwd) => ipcRenderer.invoke('rules:get', cwd),
  rulesSet: (cwd, scope, text) => ipcRenderer.invoke('rules:set', { cwd, scope, text }),
  gitCommitFiles: (cwd, files, message) => ipcRenderer.invoke('git:commitFiles', { cwd, files, message }),
  gitPush: (cwd) => ipcRenderer.invoke('git:push', cwd),
  gitBranch: (cwd) => ipcRenderer.invoke('git:branch', cwd),
  gitCheckout: (cwd, branch) => ipcRenderer.invoke('git:checkout', { cwd, branch }),
  gitPull: (cwd) => ipcRenderer.invoke('git:pull', cwd),
  gitLog: (cwd) => ipcRenderer.invoke('git:log', cwd),
  gitInit: (cwd) => ipcRenderer.invoke('git:init', cwd),
  // 终端
  terminalCreate: (cwd) => ipcRenderer.invoke('terminal:create', cwd),
  terminalInput: (id, data) => ipcRenderer.invoke('terminal:input', { id, data }),
  terminalKill: (id) => ipcRenderer.invoke('terminal:kill', id),
  onTerminalData: (cb) => ipcRenderer.on('terminal:data', (_e, d) => cb(d)),
  onTerminalExit: (cb) => ipcRenderer.on('terminal:exit', (_e, d) => cb(d)),
  // 文件变更通知 + 回滚
  onFsChanged: (cb) => ipcRenderer.on('fs:changed', (_e, data) => cb(data)),
  revertChange: (c) => ipcRenderer.invoke('fs:revert', c),
  // 全局搜索
  grep: (folder, pattern) => ipcRenderer.invoke('search:grep', { folder, pattern }),
  // AI 辅助
  aiComplete: (code, lang) => ipcRenderer.invoke('ai:complete', { code, lang }),
  aiEdit: (text, instruction) => ipcRenderer.invoke('ai:edit', { text, instruction }),
  aiInline: (code, instruction) => ipcRenderer.invoke('ai:inline', { code, instruction }),
  aiDiagnose: (code, lang) => ipcRenderer.invoke('ai:diagnose', { code, lang }),
  // 日志
  onLog: (cb) => ipcRenderer.on('log:event', (_e, entry) => cb(entry)),
  getLogs: () => ipcRenderer.invoke('log:list'),
  clearLogs: () => ipcRenderer.invoke('log:clear'),
  // 用户系统
  auth: {
    register: (d) => ipcRenderer.invoke('auth:register', d),
    login: (d) => ipcRenderer.invoke('auth:login', d),
    logout: () => ipcRenderer.invoke('auth:logout'),
    current: () => ipcRenderer.invoke('auth:current'),
    updateProfile: (p) => ipcRenderer.invoke('auth:updateProfile', p)
  },
  // token 计费（结构占位）
  billing: {
    query: (uid) => ipcRenderer.invoke('billing:query', uid)
  },
  // 工具
  pathJoin: (...a) => path.join(...a),
  pathDirname: (p) => path.dirname(p)
});
