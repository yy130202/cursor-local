# Cursor Local

复刻 Cursor 核心体验的**本地桌面 AI 编程工具**，基于 Electron + Monaco Editor（VS Code 官方编辑器内核），内置可在本地自主读文件、改代码、跑终端命令的并行 AI Agent。

## 功能

### Editor Window（传统编辑器）
- 左侧文件树（懒加载、目录展开/收起、按文件类型着色图标）
- 多标签页（打开/切换/关闭、未保存 ● 标记、Ctrl+S 保存）
- Monaco 语法高亮编辑器（自动识别 JS/TS/Python/HTML/CSS/JSON/Markdown 等）
- Git 集成：文件树状态标记、gutter 变更标记、侧栏提交面板、逐行 diff 对比

### Agents Window（Agent 优先工作台）
- 新建 Agent 任务，Agent 在**当前工作目录**自主工作
- 支持**多个 Agent 并行**运行，侧栏切换查看
- 完整展示 Agent 每一步：思考说明、工具调用、文件变更、执行结果
- 变更卡片可一键「撤销改动」，逐字节还原原始文件
- 历史会话按时间分组，支持导出 Markdown

**内置 9 个工具**：`list_dir` 查目录、`list_tree` 目录树、`read_file` 读文件、`write_file` 写文件、`delete_file` 删除、`move_file` 移动、`search_files` 内容搜索、`get_file_info` 文件信息、`run_command` 执行终端命令。

### 两种窗口随时切换
顶部 `◧ Editor` / `🤖 Agents` 一键切换。

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

| 项 | 值 |
|---|---|
| Base URL | `https://api.deepseek.com/v1` |
| API Key | `sk-你的真实Key` |
| 模型 ID | `deepseek-flash` |

配置保存在本地 `%APPDATA%/cursor-local/config.json`，不会上传。API Key 经 Electron `safeStorage` 加密后落盘，不以明文存储。

> 接口遵循 OpenAI 兼容协议，可替换为任意兼容服务（DeepSeek、Moonshot、通义、OpenAI 等），只需改 Base URL / Key / 模型。

## 目录结构

```
cursor-local-main/
├── main.js              # 主进程入口：模块组装、窗口创建、IPC 注册
├── preload.js           # contextBridge 安全暴露 API（渲染层无 Node 能力）
├── main/
│   └── testing.js       # 开发期自动化：截图 / 回归 / 诊断 / 性能实测
├── modules/             # 业务模块（单一职责，均以工厂函数 + 依赖注入组织）
│   ├── agent.js         #   Agent 引擎：工具循环、危险命令拦截、SSE 流式解析
│   ├── agent/tools.js   #   9 个工具实现（依赖全部外部注入，便于隔离测试）
│   ├── config.js        #   配置持久化 + API Key 加密
│   ├── fs.js            #   文件读写、归档、并发 grep
│   ├── git.js           #   Git 状态/暂存/提交，1200ms TTL 缓存
│   ├── log.js           #   日志模块（debug/info/warning/error，上限 1500 条）
│   ├── memory.js        #   记忆与规则（global / project 两级作用域）
│   ├── session.js       #   会话持久化、导出、文件回滚
│   ├── terminal.js      #   终端实例管理
│   └── ai.js            #   LLM 对话、补全、内联编辑
├── store/
│   └── user-store.js    # 用户存储：scrypt 加盐哈希、配置加密
├── renderer/            # 渲染层（core.js 提供 escapeHtml 等公共能力）
│   ├── agents.js        #   Agents 工作台：增量 DOM 渲染 + 行级 LCS diff
│   ├── editor.js        #   Editor 窗口：文件树 + 标签页 + Monaco
│   └── editor/
│       ├── filetree.js  #     文件树：懒加载 + Git 标记（Set O(1) 查询）
│       └── preview.js   #     媒体预览：图片/音频/视频
├── scripts/
│   ├── release-guard.js # 发布防护引擎：基线/备份/回滚/产物/上线校验
│   ├── lib/
│   │   └── verify-harness.js   # 可断言测试地基（证据强制 + 空壳审计）
│   └── gates/           # 验证体系
│       ├── smoke-suite.js      #   119 项全维烟测
│       ├── static-compliance.js#   门禁 001-040 源码合规
│       ├── perf-consistency.js #   门禁 041-069 性能与数据一致性
│       ├── release-ops.js      #   门禁 070-089 发布防护
│       ├── build-matrix.js     #   验收矩阵生成
│       └── index.js            #   门禁编排入口
├── test/                # 225 项单元测试
├── outputs/             # 验证产物（基线清单、门禁结果、验收矩阵）
└── start.bat
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
npm test                    # 225 项单元测试
npm run verify:smoke        # 119 项全维烟测
npm run verify:gates        # 89 项质量门禁（含三态汇总与失败明细）
npm run verify:matrix       # 由门禁真实结果渲染验收矩阵

npm run release:baseline    # 生成 SHA-256 基线清单（44 个核心文件 + 自签摘要）
npm run release:verify      # 校验工作区与基线是否一致
npm run release:artifact    # 生成产物清单（逐文件 digest + 集合摘要）
npm run release:dryrun      # 上线前全量预演：基线→备份→回滚演练→上线后校验
npm run release:deployed    # 上线后校验：产物 digest、配置摘要、集合摘要
npm run release:rollback    # 沙箱无损回滚演练
```

### 当前状态

| 项目 | 结果 |
|---|---|
| 单元测试 | 225 / 225 通过 |
| 全维烟测 | 118 通过 / 0 失败 / 1 环境受限（119 项） |
| 质量门禁 | 86 通过 / 2 失败 / 1 环境受限（89 项，通过率 97.73%） |

**两条已知失败项**（均为真实问题，非工具误报）：

- **无许可证声明**：LICENSE 文件、`package.json` license 字段、文档声明三者全缺，分发存在法律风险。
- **核心模块真实覆盖率 60.52%**，远低于早期声称的 98%；其中 `modules/agent/tools.js` 仅 30.97%。

### 验收矩阵

`outputs/release-verification-matrix.html` 由门禁真实结果自动渲染，
按功能 / 场景 / 边界 / 异常 / 并发 / 回退 / 权限 / 数据一致性 8 大维度逐格标注
`✓ 通过` / `✗ 失败` / `— 环境受限`，**无任何人工填写项**。

### 性能实测

Agent 工作台采用增量 DOM 渲染（按渲染签名 `sigOf` 复用节点）与行级 LCS diff（扁平 `Int32Array` DP 表）。
真实 Electron Chromium 渲染进程 A/B 实测（120 条 entry）：

| 指标 | 优化前 | 优化后 | 降幅 |
|---|---|---|---|
| DOM 重建次数 | 10,474 | 171 | **-98.4%** |
| 主线程长任务 | 4,810 ms | 236 ms | **-95.1%** |
| 最长卡顿帧 | 125.3 ms | 66.9 ms | **-46.6%** |
| 空闲帧率 | 59 FPS | 60 FPS | 满帧 |

复现命令：`PERF=1 npm start`（结果写入 `.perf/electron-perf.json`）。

## 安全设计

- **渲染进程零 Node 能力**：`contextIsolation: true`、`nodeIntegration: false`，preload 仅经 `contextBridge` 白名单暴露
- **HTML 转义统一入口**：`escapeHtml` 覆盖 `& < > " '` 五个敏感字符，属性插值一律转义
- **链接协议白名单**：Markdown 链接仅放行 `http/https/mailto`，`javascript:` 等一律降级为 `#`
- **路径越界拦截**：Agent 工具的路径操作统一经工作区守卫，拒绝 `../` 穿越与外部符号链接
- **危险命令拦截**：受限档位拦截 `rm -rf`、`format`、`del /s /q` 等；完全访问档位仅拦毁灭性命令
- **密码存储**：scrypt + 16 字节随机盐，同密码两次哈希不同
- **密钥本地加密**：API Key 走 `safeStorage`，不落明文

## 打包为独立 exe（可选）

```bash
npm install -D electron-builder
npx electron-builder --win portable
```

产物在 `dist/` 目录。

## 环境要求

- Node.js ≥ 18
- Windows 10+（终端、图标等有平台适配逻辑；macOS/Linux 可运行但未针对性测试）
