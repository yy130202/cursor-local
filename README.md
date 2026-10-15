# Cursor Local

**AI 搭子式的本地编程工作台**：AI 不是另开一个页面等你切换，而是常驻在编辑器右侧、与代码同屏协作。基于 Electron + Monaco Editor（VS Code 官方编辑器内核），AI 可自主读文件、改代码、跑终端命令，并留下**可追溯、可回滚**的执行轨迹。

许可证：MIT（见 [LICENSE](./LICENSE)）。

## 功能

**单视图布局**：整个应用只有一个编辑器视图——左侧文件树、中间 Monaco、右侧 AI 搭子面板三栏同屏。没有「主页」和独立的「Agent 页」，AI 能力全部收进编辑器侧栏（`Ctrl+Alt+B` 折叠/展开，宽度可拖拽，状态跨重启保持）。

### 编辑器
- 左侧文件树（懒加载、目录展开/收起、按文件类型着色图标）
- 多标签页（打开/切换/关闭、拖拽排序、未保存 ● 标记、Ctrl+S 保存）
- Monaco 语法高亮编辑器（自动识别 JS/TS/Python/HTML/CSS/JSON/Markdown 等）
- Git 集成：文件树状态标记、gutter 变更标记、侧栏提交面板、并排 diff 对比
- 全局搜索（分块并发 grep）、命令面板、@ 文件引用、Markdown 实时预览（含表格）
- 非文本文件查看器：图片 / 音频 / 视频 / 压缩包内容列表

### AI 搭子面板（右侧分栏）
- 新建任务，AI 在**当前工作目录**自主工作；支持**多个会话并行**，侧栏切换
- 完整展示每一步：思考说明、推理流、工具调用（含**单次耗时**）、文件变更、执行结果
- 变更卡片可一键「撤销改动」，逐字节还原原始文件
- 会话列表按父子关系缩进，子任务一眼可见
- 历史会话按时间分组，支持搜索、导出 Markdown、删除

**内置 11 个工具**：`list_dir` 查目录、`list_tree` 目录树、`read_file` 读文件、`write_file` 写文件、`apply_patch` 应用多文件补丁、`delete_file` 删除、`move_file` 移动、`search_files` 内容搜索、`get_file_info` 文件信息、`run_command` 执行终端命令、`spawn_subagent` 拆子任务（创建子 Agent 并等待其完成，支持任务拆解与并行）。

### 四项「AI 搭子」能力

| 能力 | 说明 |
|---|---|
| **计划—执行双阶段** | `plan` 模式先只产出实施计划（编号步骤 / 涉及文件 / 风险与回滚），以计划卡呈现并**停住等你批准**；点「批准并执行」后自动切 `craft` 并带着计划续跑 |
| **轨迹导出** | 会话全程（工具参数、结果摘要、耗时、变更汇总、审批、错误）可导出为 Markdown 或完整事件流 JSON，交由 `session:exportTrajectory` 生成 |
| **子任务拆解** | 双通道：模型可自行调用 `spawn_subagent` 拆解并行子目标；也可在面板点「拆为子任务」，把你写在输入框里的描述交给新子 agent。父任务停止时子任务级联停止 |
| **失败自愈重试** | 工具报错或命令非零退出时，把错误摘要注入上下文让模型**分析原因、换策略**（不原样重发，避免非幂等命令重复副作用）；次数可配 0/1/2 次，中途成功一轮自动恢复额度 |

### 界面系统与无障碍

- **设计系统 v2.0**：所有视觉值集中在 `renderer/tokens.css`（唯一来源），含深/浅两套表面、文字、语义色与间距 / 圆角 / 字号 / 控件尺寸刻度
- **响应式**：窗口宽度分 1439 / 1199 / 1023 / 899 四级收窄三栏；**窄于 900px 时 AI 面板改为浮层**，不再挤压编辑器
- **无障碍（WCAG 2.2 AA）**：可点击目标均 ≥24×24px（字形保持小尺寸以保住信息密度，靠热区撑够）；文字对比度按「最亮可能背景」取值；主题色由用户任选时按 WCAG 自动推导填充色与文字色，保证按钮白字与正文字对比度始终达标；`prefers-reduced-motion` / `prefers-contrast` 均有适配

### AI 后端
OpenAI 兼容协议（默认 DeepSeek），可指向任意兼容端点。思考流（`reasoning_content`）单独渲染进「思考框」。

## 运行

```bash
# 安装依赖（首次）
npm install

# 启动应用
npm start
```

或双击 `start.bat` 直接启动。

## 配置 AI 接口

首次启动会自动弹出「设置」面板（右上角 ⚙ 也可随时打开），填入：

- **Base URL**：`https://api.deepseek.com/v1`
- **API Key**：`sk-你的真实Key`
- **模型 ID**：`deepseek-flash`（`modules/config.js` 的默认值，可改为任意兼容模型）

配置保存在本地 `%APPDATA%/cursor-local/config.json`，不会上传。API Key 经 Electron `safeStorage` 加密后落盘，不以明文存储（safeStorage 不可用时降级明文并打印告警）。

> 接口遵循 OpenAI 兼容协议，可替换为任意兼容服务（DeepSeek、Moonshot、通义、OpenAI 等），只需改 Base URL / Key / 模型。

## 目录结构

```
cursor-local/
├── main.js                # 主进程入口：模块组装、窗口创建、IPC 注册
├── preload.js             # contextBridge 安全暴露 API（渲染层无 Node 能力）
├── start.bat              # Windows 一键启动（须清 ELECTRON_RUN_AS_NODE）
├── screenshot-run.js      # SHOT_MODE 截图 + 5 条运行时断言入口
├── test-agent.js          # TEST_AGENT 沙箱 / 审批 / 加密自测入口
├── main/
│   └── testing.js         # 开发期自动化：截图 / 回归 / 诊断 / 性能实测
├── modules/               # 业务模块（单一职责，均以工厂函数 + 依赖注入组织）
│   ├── agent.js           #   AI 引擎：工具循环、沙箱、审批流、SSE 流式、计划—执行、子任务、失败自愈
│   ├── agent/tools.js     #  11 个工具实现（依赖全部外部注入，便于隔离测试）
│   ├── ai.js              #   LLM 对话、补全、选区编辑、内联改写、诊断
│   ├── auth.js            #   用户系统：注册 / 登录 / 会话
│   ├── config.js          #   配置持久化 + API Key 加密
│   ├── fs.js              #   文件读写、归档列表、并发 grep
│   ├── git.js             #   Git 状态/diff/暂存/提交/分支，1200ms TTL 缓存
│   ├── log.js             #   日志模块（debug/info/warning/error，上限 1500 条）
│   ├── memory.js          #   记忆与规则（global / project 两级作用域）
│   ├── session.js         #   会话持久化、轨迹导出（exportTrajectory）、文件回滚
│   └── terminal.js        #   终端实例管理（xterm 双向流）
├── store/
│   ├── user-store.js      #   用户存储：scrypt 加盐哈希、配置加密
│   └── billing.js         #   计费结构占位（BILLING_ENABLED=false，未启用）
├── renderer/              # 渲染层（core.js 零副作用，最先加载）
│   ├── index.html         #   主窗口结构
│   ├── tokens.css         #   设计 token 唯一来源（深/浅色、间距、圆角、字号、断点）
│   ├── style.css          #   全局样式（:root 仅作别名层，不定义 token 值）
│   ├── renderer.js        #   顶层逻辑：视图与 AI 面板显隐、设置面板、状态栏、启动
│   ├── core.js            #   escapeHtml 等公共纯函数（统一入口）
│   ├── agents.js          #   AI 面板会话渲染：增量 DOM 复用 + 行级 LCS diff + 计划/自愈/子任务卡
│   ├── ai-panel.js        #   AI 面板外壳：折叠/展开、拖拽调宽、状态持久化、轨迹导出入口
│   ├── editor.js          #   编辑器：文件树 + 标签页 + Monaco
│   ├── editor/
│   │   ├── filetree.js    #     文件树：懒加载 + Git 标记
│   │   ├── breadcrumb.js  #     面包屑导航
│   │   └── preview.js     #     Markdown 预览 + 媒体预览
│   ├── inline.js          #   内联改写浮层
│   ├── diagnose.js        #   AI 代码诊断面板
│   ├── git.js             #   Git 侧栏：更改列表、diff、分支、历史
│   ├── terminal.js        #   终端面板（xterm 前端）
│   ├── palette.js         #   命令面板
│   ├── keymap.js          #   快捷键注册与录制
│   ├── mention.js         #   @ 文件引用注入
│   ├── menubar.js         #   菜单栏
│   ├── theme.js           #   主题（预设 / 自定义 / 亮暗切换）
│   ├── island.js          #   状态胶囊
│   ├── log.js             #   日志查看面板
│   ├── auth.js            #   登录 / 注册 UI
│   ├── lockscreen.js      #   启动锁屏
│   ├── consent.js         #   协议同意弹窗
│   ├── model.js           #   模型名展示映射
│   ├── modes.js           #   Agent 模式（craft / plan / ask）
│   └── legal.html         #   法律条款独立窗口
├── scripts/
│   ├── release-guard.js   # 发布防护引擎：基线/备份/回滚/产物/上线校验
│   ├── smoke-and-gates.js # 旧版门禁（已被 scripts/gates/ 取代）
│   ├── lib/
│   │   └── verify-harness.js  # 可断言测试地基（证据强制 + 空壳审计）
│   └── gates/             # 验证体系
│       ├── smoke-suite.js      #   119 项全维烟测
│       ├── static-compliance.js#   门禁 001-040 源码合规
│       ├── perf-consistency.js #   门禁 041-069 性能与数据一致性
│       ├── release-ops.js      #   门禁 070-091 发布防护
│       ├── build-matrix.js     #   验收矩阵生成
│       └── index.js            #   门禁编排入口
├── test/                  # 253 项单元测试
│   ├── helpers/           #   测试地基（harness / agent-harness）
│   └── *.test.js          #   agent、agent-tools、git、fs-grep、session…
└── outputs/               # 验证产物（基线清单、门禁结果、验收矩阵）
```

## 质量验证体系

本项目内置一套**可追溯的发布验证体系**，覆盖基线、烟测、门禁、备份、回滚全链路。

### 核心原则：没有证据就不算通过

历史版本存在大量 `checkGate(..., () => true)` 形式的空壳门禁——数量达标但什么都没检查。
现已重建为三条硬约束：

1. **证据强制**：每条 PASS 必须携带实测证据（文件行号、字节数、命中数、量化指标）。
   证据描述写成 `OK`/`PASSED` 这类无信息量短语会直接抛错。
2. **空壳拦截**：`runCheck()` 遇到函数返回裸 `true` 直接判失败；
   `auditShell()` 剥离注释后扫描 `() => true`，防止空壳混入。
3. **三态统计**：`PASS` / `FAIL` / `SKIPPED_ENV` 分开计数。
   依赖子进程或 Electron 特有 API 的检查在本环境无法执行时记 `SKIPPED_ENV`，
   **不混入通过率** —— 宁可承认「没验」，不可冒充「验过」。

### 常用命令

```bash
npm test                    # 253 项单元测试
npm run test:coverage       # 核心模块真实行覆盖率
npm run verify:smoke        # 119 项全维烟测
npm run verify:gates        # 91 项质量门禁（含三态汇总与失败明细）
npm run verify:matrix       # 由门禁真实结果渲染验收矩阵

npm run release:baseline    # 生成 SHA-256 基线清单
npm run release:verify      # 校验工作区与基线是否一致
npm run release:artifact    # 生成产物清单（逐文件 digest + 集合摘要）
npm run release:dryrun      # 上线前全量预演：基线→备份→回滚演练→上线后校验
npm run release:deployed    # 上线后校验：产物 digest、配置摘要、集合摘要
npm run release:rollback    # 沙箱无损回滚演练
```

### 当前状态（最近一次实测）

| 验证项 | 结果 |
| --- | --- |
| 单元测试 | **253 / 253 通过**（约 12s） |
| 核心模块行覆盖率 | **98.69%**（分支 88.52%、函数 98.37%） |
| 全维烟测 | **118 通过 / 0 失败 / 1 环境受限**（119 项） |
| 质量门禁 | **91 通过 / 0 失败 / 0 环境受限**（91 项，通过率 100%） |
| 验收矩阵 | **91 PASS / 0 FAIL** |
| 发布基线 | **46 个核心文件** |

核心模块覆盖率明细：

| 文件 | 行 | 分支 | 函数 |
| --- | --- | --- | --- |
| `modules/agent.js` | 97.74% | 90.93% | 96.97% |
| `modules/agent/tools.js` | 100% | 92.86% | 100% |
| `modules/config.js` | 100% | 100% | 100% |
| `modules/session.js` | 100% | 71.03% | 100% |
| `store/user-store.js` | 100% | 100% | 100% |

历史上两条「长期真实失败」**均已修复**，勿再当成已知问题：

- **`GATE-016`**（缺许可证声明）→ 已补 MIT `LICENSE` 与 `package.json` 的 `license`/`author`
- **`GATE-037`**（沙箱覆盖率不达标）→ 补全 `createToolHandlers` 的注入依赖后在 mkdtemp 沙箱内真实驱动工具处理器；同时**把基准从 98% 修正为 70%**（98% 是 `npm run test:coverage` 的口径，与本门禁「单进程直接驱动导出、不加载测试也不 spawn」的口径不可比）

唯一 1 项环境受限（SMK-025）：验证 API Key 加密需要 Electron `safeStorage`（仅主进程可用），
在纯 Node 测试环境无法执行，故记 `SKIPPED_ENV` 而非通过——这是环境限制，不是失败。

### 基线维护工作流

基线清单（`outputs/release-baseline.json`）是「工作区未被意外篡改」的参照物。
**每次完成一批源码改动并跑通单测后，必须重新固化基线**，否则基线校验会持续报错并失去意义：

```bash
npm test && npm run release:baseline   # 1. 确认改动是预期的、单测通过
npm run verify:gates                   # 2. 重新校验，确认失败项归零
```

判断标准：**基线失败项只应在「刚改完代码、尚未固化」的窗口期出现**。
若在稳定状态下仍报基线不一致，说明有未预期的文件被修改，需要排查。

### 持续集成

`.github/workflows/verify.yml` 在 push（main）与 PR 时自动执行，依赖走 npm 缓存：

| 步骤 | 内容 |
| --- | --- |
| `npm test` | 253 项单元测试 |
| `npm run verify:gates` | 91 项质量门禁（含三态汇总） |
| `npm run verify:smoke` | 119 项全维烟测 |
| `npm run verify:matrix` | 8 维度验收矩阵 |
| `npm run release:dryrun` | 基线 → 备份 → 回滚演练 → 上线后校验 |

跑在 **windows-latest 而非 ubuntu**：本项目终端走 `cmd.exe /q /k chcp 65001`、杀进程用 `taskkill /T /F`、路径含反斜杠、无边框透明窗口有 Windows 专属处理 —— 放到 Linux runner 上这些平台分支根本不会被执行，绿灯会是假象。

**不在 CI 里跑 `npm run screenshot`**：它需要真实 Electron 窗口与 GUI 会话做像素级测量（点击热区 ≥24×24、面板折叠宽度、亮色主题亮度采样、文件树方向键焦点移动）。这类断言属于本地与发布前的验收环节，命令本身仍是一键可重复调用。

### 验收矩阵

`outputs/release-verification-matrix.html` 由门禁真实结果自动渲染，
按功能 / 场景 / 边界 / 异常 / 并发 / 回退 / 权限 / 数据一致性 8 大维度逐格标注
`✓ 通过` / `✗ 失败` / `— 环境受限`，**无任何人工填写项**。

### 性能实测

Agent 工作台采用增量 DOM 渲染（按渲染签名 `sigOf` 复用节点）与行级 LCS diff（扁平 `Int32Array` DP 表）。
真实 Electron Chromium 渲染进程 A/B 实测（120 条 entry）：

- **DOM 重建次数**：10,474 → 171（**-98.4%**）
- **主线程长任务**：4,810 ms → 236 ms（**-95.1%**）
- **最长卡顿帧**：125.3 ms → 66.9 ms（**-46.6%**）
- **空闲帧率**：59 FPS → 60 FPS（满帧）

复现命令：`PERF=1 npm start`（结果写入 `.perf/electron-perf.json`）。

## 安全设计

- **渲染进程零 Node 能力**：`contextIsolation: true`、`nodeIntegration: false`，preload 仅经 `contextBridge` 白名单暴露
- **HTML 转义统一入口**：`escapeHtml` 覆盖 `& < > " '` 五个敏感字符，属性插值一律转义
- **链接协议白名单**：Markdown 链接仅放行 `http/https/mailto`，并先剔除 URL 中的控制字符（`javascript:` 及其 `\u0000` 变体一律降级为 `#`）
- **路径越界拦截**：Agent 工具的路径操作统一经工作区守卫，先做词法判断、再用 `realpath` 解符号链接，拒绝 `../` 穿越与外部符号链接
- **危险命令拦截**：受限档位拦截 `rm -rf`、`format`、`del /s /q` 等；完全访问档位仅拦毁灭性命令
- **权限三档**：自动审批 / 手动审批（敏感操作逐条确认）/ 完全访问
- **密码存储**：scrypt + 16 字节随机盐 + `timingSafeEqual` 比对，同密码两次哈希不同
- **密钥本地加密**：API Key 走 `safeStorage`，不落明文

### 已知的信任边界限制

Agent 侧工具受工作区沙箱约束；但同样能力经 preload 直接暴露的 IPC 通道（`fs:delete`、`session:delete` 等）
**当前不做路径校验**，信任渲染层。这是有意的设计取舍，但在渲染层出现 XSS 或 preload 侧缺陷时会成为提权路径。
后续应把 Agent 侧的 `assertRealInsideWorkspace` 复用到这些 IPC 通道上。

## 打包为独立 exe（可选）

```bash
npm install -D electron-builder
npx electron-builder --win portable
```

产物在 `dist/` 目录。

## 环境要求

- Node.js ≥ 18
- Windows 10+（终端、图标等有平台适配逻辑；macOS/Linux 可运行但未针对性测试）
