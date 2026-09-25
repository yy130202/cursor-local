// Cursor Local - 预加载脚本（contextBridge 安全暴露 IPC）
const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');

contextBridge.exposeInMainWorld('api', {
  // 文件系统
  readDir: (p) => ipcRenderer.invoke('fs:readDir', p),
  readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
  writeFile: (p, c) => ipcRenderer.invoke('fs:writeFile', p, c),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  // 配置
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (c) => ipcRenderer.invoke('config:set', c),
  // Agent
  createAgent: (a) => ipcRenderer.invoke('agent:create', a),
  listAgents: () => ipcRenderer.invoke('agent:list'),
  stopAgent: (id) => ipcRenderer.invoke('agent:stop', id),
  onAgentEvent: (cb) => ipcRenderer.on('agent:event', (_e, ev) => cb(ev)),
  // 会话持久化
  listSessions: () => ipcRenderer.invoke('session:list'),
  // 文件变更通知 + 回滚
  onFsChanged: (cb) => ipcRenderer.on('fs:changed', (_e, data) => cb(data)),
  revertChange: (c) => ipcRenderer.invoke('fs:revert', c),
  // 工具
  pathJoin: (...a) => path.join(...a),
  pathDirname: (p) => path.dirname(p)
});
