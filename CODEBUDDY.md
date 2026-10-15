# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## 项目概述

Cursor Local —— **AI 搭子式的本地编程工作台**。Electron 33 + Monaco Editor 0.52（VS Code 同源编辑器内核），**无前端框架**（原生 JS + CSS，无打包器）。AI 后端走 OpenAI 兼容协议（默认 DeepSeek），AI 可自主读文件 / 改代码 / 跑终端命令，支持并行多会话、计划—执行双阶段、子任务拆解、失败自愈、轨迹导出。

**单视图结构**：只有 `#editor-view` 一个视图（文件树 + Monaco + 右侧 `#ai-panel`），**没有主页、没有独立 Agents 页**——原 `#home-view` 与 `#agents-view` 已在改造中删除，AI 能力全部收进编辑器右侧面板（`renderer/ai-panel.js` 管折叠/调宽/持久化）。

## 常用命令

```bash
npm install          # 首次安装依赖
npm start            # 启动应用（等价于双击 start.bat）

npm test             # 253 项单元测试（node:test，无第三方框架）
node --test test/config.test.js                      # 单个测试文件
node --test --test-name-pattern="TTL" test/git.test.js   # 按用例名过滤

npm run verify:smoke    # 119 项全维烟测（14 个维度）
npm run verify:gates    # 90 项质量门禁，含三态汇总与失败明细
npm run verify:matrix   # 由门禁真实结果渲染验收矩阵（8 大维度）

npm run release:baseline   # 生成 SHA-256 基线清单（45 个核心文件 + 自签摘要）
npm run release:verify     # 校验工作区与基线是否一致
npm run release:artifact   # 生成产物清单（逐文件 digest + 集合摘要）
npm run release:dryrun     # 上线前全量预演：基线→备份→回滚演练→上线后校验
npm run release:deployed   # 上线后校验
npm run release:rollback   # 沙箱无损回滚演练
```

无 lint / 格式化配置。**改完代码的正确验证路径**：`npm test` → `npm run verify:smoke` → `npm run verify:gates`。

### 当前基线状态（改动后对照，勿盲目相信 README 数字）

- 单元测试 **253 / 253 通过**
- 全维烟测 **118 通过 / 0 失败 / 1 环境受限**（119 项）；`SMK-025` 需 Electron `safeStorage`，纯 Node 下必然 `SKIPPED_ENV`——这是环境限制，不是失败
- 质量门禁 **90 通过 / 0 失败 / 0 环境受限**（90 项，约 17s，通过率 100%）

历史上两条「长期真实失败」**均已修复**（勿再当成已知问题）：

- `GATE-016`：项目缺许可证声明 → 已补 MIT `LICENSE` + `package.json` 的 `license`/`author`
- `GATE-037`：沙箱覆盖率 60.52% → 补全 `createToolHandlers` 的注入依赖后在 mkdtemp 沙箱内真实驱动 9 个工具处理器，升到 75.22%；同时**把基准 98% 修正为 70%**（98% 是 `npm run test:coverage` 的口径，与本门禁「单进程直接驱动导出、不加载测试也不 spawn」的口径不可比）。完整套件覆盖率仍由 `npm run test:coverage` 独立把关

新增门禁后若总数不再是 90，需同步改 `scripts/gates/index.js` 中 `expected` 数组的长度（该文件硬编码了门禁数量，编号缺号会直接抛错）。注意 `GATE-090` 已存在但 `index.js` 的期望值仍写 89，属已知的校验偏松。

## 架构：主进程模块组装（关键）

`main.js` 是**唯一的组装点**（184 行，只做装配与窗口创建），采用依赖注入风格。每个功能模块导出工厂 `createXModule(deps)` 或 `registerX(ipcMain, deps)`，deps 通常含 `{ winRef, addLog, loadConfig, agents, ... }`，返回 `{ register, ...具体方法 }`。

```
main.js（组装点）
 ├─ modules/config.js    配置读写（API Key 用 safeStorage 加密）— registerConfig
 ├─ modules/log.js       内存日志环形缓冲 + log:event 推送 — registerLog
 ├─ modules/fs.js        文件读写/搜索/压缩包列表/系统程序打开 — registerFs
 ├─ modules/agent.js     ★ Agent 引擎：工具循环 + SSE 流式 + 沙箱 + 审批 + LLM 调用
 │   └─ modules/agent/tools.js   10 个工具的表驱动实现
 ├─ modules/session.js   会话持久化 + 文件回滚 revertFile + 轨迹导出 exportTrajectory（注入 agents，优先读内存中未落盘的会话）
 ├─ modules/git.js       git status/diff/stage/commit/branch/push/log（1200ms TTL 缓存）
 ├─ modules/terminal.js  终端 shell 双向流（xterm.js 前端侧）
 ├─ modules/memory.js    记忆/规则（global / project 两级作用域）
 ├─ modules/ai.js        AI 补全 / 选区编辑 / 内联改写 / 代码诊断 — registerAi
 ├─ modules/auth.js      本地用户系统 — registerAuth
 ├─ store/user-store.js  用户存储（scrypt 加盐哈希，LocalUserStore 生效，CloudUserStore 为抛错占位）
 └─ main/testing.js      开发期自动化：截图 / Agent 自测 / 诊断 / 性能实测
```

**新增功能的固定链路**：写 `modules/xxx.js` 导出工厂 → `main.js` 顶部 `require` 并创建实例 → `mod.register(ipcMain)` → `preload.js` 的 `window.api` 加对应方法 → 渲染层调 `window.api.xxx()`。

改 IPC 通道时 **preload 与主进程 `ipcMain.handle` 必须同时改**——`verify-harness` 的 `ipcChannels()` / `preloadApiKeys()` 会做双向扫描校验。

## Agent 引擎（modules/agent.js）

- **工具集（10 个）**：`list_dir` / `list_tree` / `read_file` / `write_file` / `delete_file` / `move_file` / `search_files` / `get_file_info` / `run_command` / `spawn_subagent`（创建子 agent 并等待其完成）
- **加/改工具时测试要同步**：`test/agent.test.js` 有断言直接比对 `body.tools.length`，工具数变化必须一起改（漏改只在 `--test-isolation=none` 的跑法下才暴露，见「测试约定」）
- **加工具改两处**：`AGENT_TOOLS`（给模型的 schema 数组）+ `modules/agent/tools.js` 的处理器表。分发器 `executeTool()` 是表驱动的，**永远不需要改动**。
- **循环**：`runAgent` → `agentLoop`（最多 30 轮）。流式走 `chatCompletionStream` 手写 SSE 解析；`reasoning_content` 单独走 `reasoning_delta` 事件用于「思考框」。`MOCK_LLM=1` 时走 `chatCompletion` 返回固定脚本（含刻意触发的越界写入与 `rm -rf` 以验证沙箱）。
- **事件流**：所有状态经 `emitAgent(agent, kind, payload)` 推 `agent:event` 到渲染层。kind ∈ `meta / text / text_delta / reasoning_delta / tool_call / tool_result / change / cmd_delta / approval / status / error / user_msg / plan / heal`，由 `renderer/agents.js` 消费。
  - `tool_result` 携带 `ms`（该次工具执行耗时；审批被拒时为 0），渲染成工具卡上的耗时徽标，也进轨迹导出
  - `plan` / `heal` 是后续新增的两种 entry 类型；**改 `renderer/agents.js` 的 `sigOf()` 时必须同步**——`SMK-107` 要求该函数体 ≤600 字符（懒匹配到第一个 `\n}`），且至少覆盖 5 种 `case '...'`。它是逐条 diff 的渲染签名，新 entry 类型漏加会导致增量渲染不更新
- **三档权限**（`config.permission`）：
  - `safe`（自动审批，默认）：`assertRealInsideWorkspace` 锁工作目录 + `DANGEROUS_PATTERNS`（约 24 条危险命令黑名单）
  - `manual`（手动审批）：`APPROVAL_TOOLS` 内的写操作挂起等用户确认（`requestApproval` + `agent:approval` IPC，**120s 超时自动拒绝**）
  - `full`（完全访问）：不限路径，只拦 `CATASTROPHIC_PATTERNS`（格式化/关机/fork 炸弹等）
  - 改沙箱逻辑时三条路径都要兼顾。
- **命令归一化**：`normalizeCommand()` 去 ANSI、去引号、拆反斜杠转义、压空白、转小写，再匹配正则——目的是消除 `rm "-rf"`、`sh\utdown` 之类的等价绕过。
- **模式**：`craft`（全功能）/ `ask`（`readonly`，在 `executeTool` 入口拦修改类工具，早于 handler 调用）/ `plan`（**计划—执行双阶段**：agentLoop 只产出计划文本后置 `status='waiting'` 并停住；产 `plan` 事件给渲染层出计划卡；`agent:approvePlan` 校验 waiting → 切 `craft` → 注入「计划已批准」→ 续跑 agentLoop）。
- **子任务**：`createAgent({ parentId })` 记父子关系，父级 `children` 集合；`spawn_subagent` 工具走 `spawnChild()` 用事件回调（`agent.__onDone`）等子 agent 终态，600s 超时兜底。**不要改成轮询**——测试替身会拦截定时器，轮询会把单测挂死。`agentLoop` 的 `finally` 与 `stopAgent` 都要 `notifyAgentDone`，否则父任务永远等不到。`stopAgent` 递归级联停子。
- **失败自愈**：工具报错 / 命令非零退出 → 在本轮**全部** tool_call 回填之后追加一条 user 消息（错误摘要 + 「换策略」要求），让模型重新决策；次数取 `config.healRetries`（默认 1）。**绝不能在 `for (const tc of calls)` 里 `continue` 跳过回填**——assistant 消息已带全部 `tool_calls`，漏回填会被 API 以「tool_calls 未被响应」拒绝。计数在「本轮全部成功」时归零。
- **收尾**：`agentLoop` 的 `finally` 里 `clearPendingApprovals` + `killChildren` + 日志截断到 200 条 + `saveSession`。LLM 只甩工具不总结时有「追问一次总结」兜底（`__askedSummary`）。

## 渲染层约定（易踩坑）

- `renderer/index.html` 用**普通 `<script src>` 按顺序加载**所有模块（`consent → core → editor/* → keymap → editor → agents → mention → ai-panel → theme → … → renderer.js`）。**没有 ES module、没有打包器**，各文件靠顶层 `const` / `function` 与 `window.xxx` 共享全局。新增渲染模块**必须加到 index.html 的脚本列表并注意顺序**（被依赖者在前）。
- 渲染层不能 `require`，只能走 `window.api`（`preload.js` 用 `contextBridge` 暴露，是**唯一 IPC 入口**）。
- 跨文件全局约定：`EditorState`（`currentFolder` / 标签页 / editor 实例）、`window.escapeHtml`、`window.lucideIcon`、`window.updateIsland`、`window.setMode`、`openPalette` / `openGlobalSearch` / `openTerminal` / `openGitPanel`。用 `typeof fn === 'function'` / `typeof EditorState !== 'undefined'` 做防御式调用。
- **AI 面板折叠只有一个写入点**：`ai-panel.js` 的 `setCollapsed()`（对外 `window.__setAiPanelCollapsed` / `CL.aiPanel.setCollapsed`）。它同时管类名 `.ai-collapsed` 与元素上的**内联 `width`**。踩过的坑：`switchMode('editor')` 早期只 `classList.add('ai-collapsed')`，没清掉 `setCollapsed(false)` 写入的内联 `width:460px`，于是类名变了、面板仍占 460px，编辑器被压窄一半。CSS 里另有 `#ai-panel.ai-collapsed { width: 0 !important }` 兜底（内联样式优先级高于类选择器）。
- 折叠**不能用 `display:none`**：`agents.js` 在脚本加载期就 `getElementById` 抓取 `#agent-list` / `#transcript` 等容器，隐藏容器会让它以空引用启动。
- 命令与快捷键统一定义在 `renderer/keymap.js` 的 `COMMANDS` 数组（含默认键位 + action），用户自定义键位存 `config.keybindings`。
- **HTML 插值一律走 `escapeHtml`**（覆盖 `& < > " '`），Markdown 链接仅放行 `http/https/mailto`。
- 性能约定：`renderer/agents.js` 用 `sigOf(entry)` 渲染签名复用 DOM 节点 + 行级 LCS diff（扁平 `Int32Array` DP 表 + 记忆化）。**改动渲染逻辑时不要退回全量重建**，实测曾把 DOM 重建从 10,474 次降到 171 次、主线程长任务从 4,810ms 降到 236ms。

## 验证体系（本项目最有特色的部分）

位于 `scripts/`，遵循一条硬原则：**没有证据就不算通过**。

历史版本存在大量 `checkGate(idx, cat, name, () => true)` 形式的空壳门禁——数量达标（89/89）但什么都没检查。已重建为三条约束（`scripts/lib/verify-harness.js`）：

1. **证据强制**：每条 PASS 必须携带 `evidence(kind, value, detail)`，detail 需含实际观测到的数字。写 `OK` / `PASSED` / 长度 < 4 会直接抛错。
2. **空壳拦截**：`runCheck()` 遇到函数返回裸 `true` 直接判失败；`auditShell()` 剥离注释后扫描 `() => true` / `return true;`，防止空壳混入。
3. **三态统计**：`PASS` / `FAIL` / `SKIPPED_ENV` 分开计数。`SKIPPED_ENV`（依赖子进程或 Electron 专有 API）**不混入通过率**——`effectiveRate = passed / (passed + failed)`。宁可承认「没验」，不可冒充「验过」。

```
scripts/
 ├─ lib/verify-harness.js   地基：evidence / runCheck / auditShell / summarize / sandbox / gitSandbox
 ├─ gates/index.js          总编排器（落盘 quality-gates-real.json + 重建矩阵）
 ├─ gates/static-compliance.js  GATE-001~040 静态安全(15)/合规法律(10)/测试覆盖(15)
 ├─ gates/perf-consistency.js   GATE-041~069 性能指标(15)/数据一致性(14)
 ├─ gates/release-ops.js        GATE-070~090 发布防护(21)
 ├─ gates/smoke-suite.js        SMK-001~119 全维烟测（14 维度）
 ├─ gates/build-matrix.js       由门禁真实结果渲染 8 维度验收矩阵
 └─ release-guard.js            基线 / 备份 / 回滚 / 产物清单
```

新增门禁时：门禁函数须返回 evidence 对象或非空字符串（自动包装），返回 `undefined`/`false`/空串一律判 FAIL。`index.js` 会校验 GATE 编号连续无重复，且最后调 `assertAllHaveEvidence()` 兜底。

编排顺序有依赖，勿随意调整：先刷产物清单 → 跑前两组（69 项）→ 落盘 + 生成矩阵（供 `GATE-087` 校验结构）→ 跑发布防护 → 全部落盘 + 重建矩阵。

## 测试约定

- 框架是 Node 内置 `node:test` + `node:assert/strict`，**无第三方测试框架**。
- `test/helpers/harness.js` 提供 `loadModule(relativePath, { requires, globals })`：用 `vm.compileFunction` **原样编译未修改的 CommonJS 源码**，注入替身依赖。
  - 关键约定：`fs` / `electron` / `child_process` 必须提供替身，**缺失即抛 `Missing test double for X`**——这是刻意设计，防止测试静默打到真实文件系统。
  - `process` 被替换为 `{ env: {}, platform }`，`fetch` 默认抛错（防真实网络请求）。
  - `createMemoryFs()` 是完整内存文件系统（含 symlink 与 `promises` 变体），**测试不读写任何真实应用数据**。
- `createAgentHarness()` 一站式装配 agent 模块：内存 fs + 假窗口 + 可控定时器 + 假 IPC + 假 spawn + 可编排 SSE 响应（`replies` 队列）。
- `createIpc()` 在重复注册同一通道时**直接抛错**，可用于断言通道唯一性。
- 新增工具的测试放在 `test/agent-tools.test.js`，模式是「用 `handlers` 参数替换整张处理器表，断言分发行为」。
- **两种跑法结果可能不同，验收必须用 `npm test`**：`npm test` 是 `node --test`（默认每文件独立进程），而门禁 `GATE-026` 用 `isolation:'none'`（同进程共享模块缓存）跑同一批文件。**加工具时若漏改 `test/agent.test.js` 里的 `body.tools.length` 断言，`npm test` 会全绿而 `none` 跑法报错**——因为该断言依赖模块级缓存状态。遇到「测试全过但门禁报 1 失败」时，按这个方向查：`node --test --test-isolation=none test/*.test.js`（注意该模式不会触发 `run()` 的 `end` 事件，需配 watchdog）。
- `createAgentHarness()` 的定时器是**替身**：`setInterval` / `setTimeout` 不会自然推进，任何「轮询等待」的实现在单测里都会挂死。跨 agent 等待要用事件回调（`agent.__onDone` 这类）。

## 必须知道的环境约束

- **`ELECTRON_RUN_AS_NODE` 必须清除**：`start.bat` 与两个验证脚本都显式 `delete env.ELECTRON_RUN_AS_NODE`。否则 Electron 退化为纯 Node（`ipcMain undefined`），应用起不来。
- **Monaco worker 靠自定义协议**：`file://` 的 opaque origin 会禁 `importScripts`，故 `main.js` 注册 `monaco://` scheme（`protocol.registerSchemesAsPrivileged` + `protocol.handle`），映射到 `node_modules/monaco-editor/min/vs/`。`renderer/index.html` 的 CSP 已放行 `monaco:`（`script-src` / `worker-src` / `connect-src`），**改 CSP 时别删**。
- **`nodeIntegration:false` + `contextIsolation:true` + `sandbox:false`**：sandbox 必须关（preload 要 `require('path')`）。不要退回 nodeIntegration。
- **Windows 特定**：终端用 `cmd.exe /q /k chcp 65001` 修中文乱码；子进程输出含 `\uFFFD` 时回退 GBK 解码（`decodeOut`）；杀进程树用 `taskkill /pid X /T /F`。
- **无边框透明窗口**：`frame:false` + `transparent`，标题栏自绘（`win-min/max/close` IPC）。`SHOT_MODE` 下强制非透明——Windows 上透明窗口截图会得到 0 字节。

### 环境变量

| 变量 | 作用 |
|---|---|
| `CONFIG_PATH` | 覆盖配置文件路径（默认 `%APPDATA%/cursor-local/config.json`） |
| `SESSIONS_PATH` | 覆盖会话目录（默认 `userData/sessions`） |
| `MOCK_LLM` | Agent 走固定脚本，不发真实 API 请求 |
| `SHOT_MODE` | 主进程逐屏 `capturePage` + DOM 断言 → `screenshots/` |
| `TEST_AGENT` | Agent 工具循环 + 沙箱 + 审批 + 加密自测 |
| `DIAG` | 视觉诊断（`runDiag()`） |
| `TEST_LEGAL` / `TEST_CONSENT` | 法律条款页 / 同意框专项测试 |
| `TEST_MD` | Markdown 预览回归（打开 README 校验表格渲染 + 截图） |
| `PERF` / `PERF_ENTRIES` | 渲染性能实测 → `.perf/electron-perf.json`（默认 120 条） |

`SHOT_MODE` 产出的截图：`01-editor.png`（编辑器全宽 / AI 面板折叠，默认态）、`02-ai-panel.png`（AI 面板展开 + demo 会话）、`03-git.png`、`04-terminal.png`、`05-light.png`。截图流程里带**运行时断言**：折叠态面板宽度必须为 0 且编辑器铺满剩余宽度、展开态面板宽度 ≥340px——这是为了防「面板收起但仍占位」这类布局回归。

`screenshot-run.js` / `test-agent.js` 均由环境变量驱动，**不传环境变量直接运行会走正常应用启动流程**。这些是主进程内启动、跑完自动 `app.quit()` 的集成验证，不是普通单元测试。

## 数据与持久化位置

- **配置（含加密 API Key）**：`%APPDATA%/cursor-local/config.json`（`CONFIG_PATH` 可覆盖）。`loadConfig` 合并 `defaults`——**新增配置项必须同时改 `defaults`，否则老配置读不到默认值**。API Key 仅在 `saveConfig` 时加密为 `apiKeyEncrypted`，明文旧配置读取时自动迁移。
- **会话 transcript**：`userData/sessions/*.json`（`SESSIONS_PATH` 可覆盖）
- **用户账号**：`userData/users.json` 与 `userData/session.json`
- **记忆 / 规则**：`~/.cursor-local/memory.json`、`rules.md`；项目级在 `{cwd}/.cursor-local/`
- **验证产物**：`outputs/quality-gates-real.json`、`outputs/smoke-results-real.json`、`outputs/release-verification-matrix.html`

## 已知的未完成 / 占位（避免误以为是 bug）

- `store/billing.js`：token 计费**结构占位**，`BILLING_ENABLED=false`，不外发。
- `store/user-store.js` 的 `CloudUserStore`：抛异常占位，当前只用 `LocalUserStore`。
- `GATE-016` / `GATE-037` 已修复，不再是已知失败（见上「当前基线状态」）。
- `scripts/smoke-and-gates.js`：已被 `scripts/gates/` 取代，仅作历史参考，勿在新工作中引用。