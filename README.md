# Cursor Local

复刻 Cursor 核心体验的**本地桌面 AI 编程工具**，基于 Electron + Monaco Editor（VS Code 官方编辑器内核），内置可在本地自主读文件、改代码、跑终端命令的并行 AI Agent。

## 功能

### Editor Window（传统编辑器）
- 左侧文件树（懒加载、目录展开/收起、按文件类型着色图标）
- 多标签页（打开/切换/关闭、未保存 ● 标记、Ctrl+S 保存）
- Monaco 语法高亮编辑器（自动识别 JS/TS/Python/HTML/CSS/JSON/Markdown 等）

### Agents Window（Agent 优先工作台）
- 新建 Agent 任务，Agent 在**当前工作目录**自主工作
- 支持**多个 Agent 并行**运行，侧栏切换查看
- 完整展示 Agent 每一步：思考说明、工具调用（读文件/写文件/跑命令）、执行结果
- Agent 工具集：`list_dir` 查目录、`read_file` 读文件、`write_file` 写文件、`run_command` 执行终端命令

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

配置保存在本地 `%APPDATA%/cursor-local/config.json`，不会上传。

> 接口遵循 OpenAI 兼容协议，可替换为任意兼容服务（如 DeepSeek、Moonshot、通义、OpenAI 等），只需改 Base URL / Key / 模型。

## 目录结构

```
cursor-clone/
├── main.js            # 主进程：IPC、Agent 引擎（工具循环）、LLM 调用、终端执行
├── preload.js         # contextBridge 安全暴露 API
├── renderer/
│   ├── index.html     # 界面骨架
│   ├── style.css      # VS Code 暗色主题
│   ├── editor.js      # Editor Window：文件树 + 标签页 + Monaco
│   ├── agents.js      # Agents Window：并行 Agent 工作台
│   └── renderer.js    # 窗口切换 + 设置 + 状态栏
├── screenshot-run.js  # 截图验证脚本（开发用）
├── test-agent.js      # Agent 工具循环自测（开发用）
└── start.bat          # 一键启动
```

## 开发验证脚本

```bash
npm run screenshot   # 截图两个窗口渲染效果到 screenshots/
npm run test:agent   # 用 mock LLM 验证 Agent 工具循环全链路
```

## 打包为独立 exe（可选）

如需脱离 Node 环境的独立可执行文件：

```bash
npm install -D electron-builder
npx electron-builder --win portable
```

产物在 `dist/` 目录。
