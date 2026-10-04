# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

Cursor Local —— 复刻 Cursor 核心体验的本地桌面 AI 编程工具。Electron 33 + Monaco Editor 0.52（VS Code 同源编辑器内核），**无前端框架**（原生 JS + CSS）。AI 后端走 OpenAI 兼容协议（默认 DeepSeek），Agent 可自主读文件 / 改代码 / 跑终端命令，支持并行多 Agent。

三个主视图：`Home`（主页/启动台）、`Editor`（文件树 + 标签页 + Monaco）、`Agents`（Agent 工作台）。顶部按钮或 `switchMode()` 切换。

## 常用命令

```bash
npm install            # 首次安装依赖
npm start              # 启动应用（等价于双击 start.bat）

npm run screenshot     # 截图验证：SHOT_MODE 启动，主进程逐屏 capturePage + DOM 断言 → screenshots/
npm run test:agent     # Agent 工具循环 + 沙箱 + API Key 加密自测（mock LLM，无真实 API 调用）
```

无 lint / 格式化配置，无单测框架。验证靠上面两条**环境变量驱动的自检脚本**——它们不是普通测试，而是主进程内启动、跑完自动 `app.quit()` 的集成验证，改完相关代码务必跑一遍看告警是否仍是预期值。

跑单个断言：直接改 `main.js` 里的 `takeScreenshots()` / `runAgentTest()`，或在 `DIAG=1 npm start` 下加临时诊断（`runDiag()` 已预留）。

## 架构：主进程模块组装（关键）

`main.js` 是**唯一的组装点**，采用依赖注入风格：每个功能是一个工厂函数 `createXModule(deps)`，deps 通常含 `{ winRef, addLog, loadConfig, agents, ... }`，返回 `{ register, ... 具体方法 }`（部分模块如 `log.js` / `ai.js` / `auth.js` 直接用 `registerX(ipcMain, deps)` 函数式注册）。

```
main.js
 ├─ modules/config.js    配置读写（API Key 用 safeStorage 加密）
 ├─ modules/log.js       内存日志环形缓冲 + log:event 推送
 ├─ modules/fs.js        文件读写/搜索/压缩包列表/系统程序打开
 ├─ modules/agent.js     ★ Agent 引擎：工具循环 + 流式 + 沙箱 + 审批
 ├─ modules/session.js   会话持久化 + 文件回滚 revertFile
 ├─ modules/git.js       git status/diff/stage/commit/branch/push/log
 ├─ modules/terminal.js  终端 shell 双向流（xterm.js 前端侧）
 ├─ modules/memory.js    记忆/规则（~/.cursor-local/ 与项目 .cursor-local/）
 ├─ modules/ai.js        AI 补全 / 选区编辑 / 内联改写 / 代码诊断
 ├─ modules/auth.js      本地用户系统（预留 CloudUserStore）
 └─ store/user-store.js  用户存储（scrypt 加盐哈希）
```

新增功能的标准做法：写 `modules/xxx.js` 导出工厂 → 在 `main.js` 顶部 `require` 并创建实例 → 调用 `mod.register(ipcMain)` → 在 `preload.js` 的 `window.api` 里加对应方法 → 渲染层通过 `window.api.xxx()` 调用。

## 渲染层约定（易踩坑）

- `renderer/index.html` 用**普通 `<script src>` 按顺序加载**所有模块（`keymap → editor → agents → theme → ... → renderer.js`）。**没有 ES module、没有打包器**，各文件靠顶层 `const` / `function` 与 `window.xxx` 共享全局。新增渲染模块要加到 `index.html` 的脚本列表且注意顺序。
- 渲染层不能 `require`，只能走 `window.api`（`preload.js` 用 `contextBridge` 暴露，是**唯一 IPC 入口**）。加 IPC 通道时 preload 和主进程 `ipcMain.handle` 必须同时改。
- 跨文件调用的全局约定：`EditorState`（当前文件夹/标签/编辑器实例）、`window.escapeHtml`、`window.lucideIcon`、`window.updateIsland`、`window.setMode`、`window.openPalette` / `openGlobalSearch` / `openTerminal` / `openGitPanel` 等。用 `typeof fn === 'function'` 做防御式调用。
- 命令/快捷键统一定义在 `renderer/keymap.js` 的 `COMMANDS` 数组（含默认键位 + action），用户自定义键位存 config.keybindings。

## 必须知道的环境约束

- **`ELECTRON_RUN_AS_NODE` 必须清除**：`start.bat` 和两个验证脚本都显式 `delete env.ELECTRON_RUN_AS_NODE`。否则 Electron 退化为纯 Node（`ipcMain undefined`），应用起不来。
- **Monaco worker 靠自定义协议**：`file://` 的 opaque origin 会禁 `importScripts`，所以 `main.js` 注册 `monaco://` scheme（`protocol.registerSchemesAsPrivileged` + `protocol.handle`），映射到 `node_modules/monaco-editor/min/vs/`。CSP `script-src` / `worker-src` / `connect-src` 已放行 `monaco:`，改 CSP 时别删。
- **`nodeIntegration:false` + `contextIsolation:true` + `sandbox:false`**：sandbox 必须关（preload 要 `require('path')`）。不要退回 nodeIntegration。
- **Windows 特定**：终端用 `cmd.exe /q /k chcp 65001` 修中文乱码；agent/git 子进程输出含 `�` 时回退 GBK 解码；杀进程用 `taskkill /pid X /T /F`（杀进程树）。
- **无边框透明窗口**：`frame:false` + `transparent`，标题栏自绘（`win-min/max/close` IPC）。`SHOT_MODE` 下强制非透明——Windows 上透明窗口截图会得到 0 字节。

## Agent 引擎（modules/agent.js）

- **工具集**：`list_dir` / `list_tree` / `read_file` / `write_file` / `delete_file` / `move_file` / `search_files` / `get_file_info` / `run_command`。工具定义在 `AGENT_TOOLS`，实现在 `executeTool()` 的 switch 里，两者必须同步（加工具改两处 + system prompt 描述）。
- **循环**：`runAgent` → `agentLoop`（最多 30 轮）。流式走 `chatCompletionStream`（解析 SSE，`reasoning_content` 单独走 `reasoning_delta` 事件用于「思考框」）；`MOCK_LLM=1` 时走 `chatCompletion` 返回固定脚本。
- **事件流**：所有状态通过 `emitAgent(agent, kind, payload)` 推 `agent:event` 到渲染层，kind ∈ `meta/text/text_delta/reasoning_delta/tool_call/tool_result/change/cmd_delta/approval/status/error`。前端 `agents.js` 消费这些事件。
- **三档权限**（config.permission，中文：自动审批/手动审批/完全访问）：
  - `safe`（默认）：`assertInsideWorkspace` 锁工作目录 + 13 条危险命令黑名单（`checkDangerousCommand`）。
  - `manual`：`APPROVAL_TOOLS` 里的写操作挂起等用户确认（`requestApproval` + `agent:approval` IPC，120s 超时拒绝）。
  - `full`：不限路径，只拦 `CATASTROPHIC_PATTERNS`（格式化/关机/fork 炸弹等）。改沙箱逻辑时三条路径都要兼顾。
- **模式**：`craft`（全功能）/ `ask`（`readonly`，拦修改类工具）/ `plan`（system prompt 只输出计划）。模式影响 system prompt 拼接。
- **收尾**：`agentLoop` 的 finally 里 `killChildren` 杀子进程树 + 日志截断到 200 条 + `saveSession`。LLM 只甩工具不总结时有「追问一次总结」兜底（`__askedSummary`）。

## 数据与持久化位置

| 数据 | 路径（可用环境变量覆盖） |
|---|---|
| 配置（含加密 API Key） | `%APPDATA%/cursor-local/config.json`（`CONFIG_PATH` 覆盖） |
| 会话 transcript | `userData/sessions/*.json`（`SESSIONS_PATH` 覆盖，测试用 `.test-sessions/`） |
| 用户账号 | `userData/users.json` + `userData/session.json` |
| 记忆 / 规则 | `~/.cursor-local/memory.json`、`rules.md`；项目级在 `<cwd>/.cursor-local/` |

`config.js` 的 `loadConfig` 合并 `defaults`；新增配置项要同时改 `defaults`（否则老配置读不到默认值）。API Key 只在 `saveConfig` 时加密为 `apiKeyEncrypted`，明文旧配置读取时自动迁移。

## 已知的未完成/占位（避免误以为是 bug）

- `store/billing.js`：token 计费**结构占位**，`BILLING_ENABLED=false`，不外发。
- `store/user-store.js` 的 `CloudUserStore`：抛异常占位，当前只用 `LocalUserStore`。
- `screenshot-run.js` / `test-agent.js` 依赖环境变量驱动，不传环境变量直接运行会走正常启动流程。
