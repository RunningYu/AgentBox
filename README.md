# AgentBox

AgentBox 是一款面向开发者的开源 macOS AI 工作台，将 AI 会话、Agent 配置、提示词工具箱和文件文档管理整合到一个客户端中。

它支持 Claude Code、Codex 等本机 AI CLI，适合代码编写、代码审查、需求分析、问题排查、技术文档阅读和日常研发协作。

> AgentBox 采用本地优先设计。会话、Agent 配置和工具箱数据主要保存在本机，不依赖云端账号即可使用。

## 界面预览


### AI 工作台

展示会话列表、终端交互、输入框、工具箱和文档上下文面板。

<img width="1512" height="949" alt="image" src="https://github.com/user-attachments/assets/eadb805e-eb3b-44e7-8e7c-9a4b439d4775" />
<img width="1679" height="1046" alt="image" src="https://github.com/user-attachments/assets/13f16d43-d84c-4cad-b866-f81df943dc82" />
<img width="1680" height="1050" alt="image" src="https://github.com/user-attachments/assets/5088b9ee-5438-45a3-b35a-04b601a6c7cd" />
<img width="1680" height="1020" alt="image" src="https://github.com/user-attachments/assets/19b900f6-4704-4cca-92af-b9385b584490" />
<img width="1680" height="1050" alt="image" src="https://github.com/user-attachments/assets/171554a6-7fed-4900-a8d3-d6840d7bafbe" />
<img width="1680" height="1050" alt="image" src="https://github.com/user-attachments/assets/9dea9ea9-dccf-472c-a2b4-3ca0480daf1b" />
会话创建

<img width="521" height="480" alt="image" src="https://github.com/user-attachments/assets/343bc27f-df16-4007-a3b3-6b1102529121" />





<!-- ![AI 工作台](docs/screenshots/01-ai-workspace.png) -->

### Agent 中心

展示 Agent 列表、配置总览、行为规则、Skill、模型和工作目录等信息。
<img width="1680" height="1020" alt="image" src="https://github.com/user-attachments/assets/02b32e9e-76f7-4ebd-bbff-e484243129bc" />
<img width="1112" height="1737" alt="image" src="https://github.com/user-attachments/assets/078321e5-752a-45e0-bb3b-8e6dbd161be9" />

<!-- ![Agent 中心](docs/screenshots/02-agent-center.png) -->

### Agent 编辑页

展示 Agent 基本信息、模型、工作目录、系统提示词、行为规则、Skill、知识库和 MCP 配置。
<img width="1110" height="920" alt="image" src="https://github.com/user-attachments/assets/15fef9e4-759b-4e6c-879b-14deeef90083" />




<!-- ![Agent 编辑页](docs/screenshots/03-agent-editor.png) -->

### 工具箱

展示提示词、代码片段、自定义工具和工作流，以及搜索、收藏、排序和导入导出功能。

截图文件：`docs/screenshots/04-toolbox.png`
<img width="1680" height="1050" alt="image" src="https://github.com/user-attachments/assets/3d4c5903-a5aa-4722-b8da-b280ddff1586" />

<!-- ![工具箱](docs/screenshots/04-toolbox.png) -->

### File 工作区

展示文件目录、文档预览、搜索、缩放、大纲和右键引用操作。

截图文件：`docs/screenshots/05-file-workspace.png`
<img width="1680" height="1050" alt="image" src="https://github.com/user-attachments/assets/aa6d9f41-f391-44bb-853f-2d3308e1ec64" />
<img width="1680" height="1050" alt="image" src="https://github.com/user-attachments/assets/2e1f9d28-ffc3-4ac6-8a10-a17af777beb2" />

<img width="1680" height="1050" alt="image" src="https://github.com/user-attachments/assets/88a3cc9f-3136-4d42-b4f5-1edd565d14e3" />


<!-- ![File 工作区](docs/screenshots/05-file-workspace.png) -->

### 文档预览

展示 Markdown、Word、PDF、图片或代码文件在 File 工作区中的预览效果。

截图文件：`docs/screenshots/06-document-preview.png`

<!-- ![文档预览](docs/screenshots/06-document-preview.png) -->

### 快捷工具浮窗

展示通过快捷键唤起的快速工具面板。
<img width="1680" height="1020" alt="image" src="https://github.com/user-attachments/assets/ca03b98d-c695-420f-9f54-bbdd0b2d8285" />
<img width="811" height="822" alt="image" src="https://github.com/user-attachments/assets/5d93a676-c012-40fe-b6e4-bdd6c03450ac" />


### 实施追踪插件

实时追踪文档、代码的改动

<img width="1445" height="848" alt="image" src="https://github.com/user-attachments/assets/767a7565-f7ea-45af-a7be-07e430d2c4fc" />
<!-- ![文档预览](docs/screenshots/06-document-preview.png) -->

## 核心功能

### 1. AI 工作台

- 支持创建 Claude Code、Codex、普通终端和 GUI Agent 会话。
- 每个会话拥有独立的本机 PTY 进程，多个会话可以并行运行。
- 支持会话分组、折叠、置顶、重命名、移动和删除。
- 支持启动、停止、重新启动和恢复历史会话。
- 切换会话时保留对应的终端进程和输出记录。
- 支持保存工作目录、CLI 会话 ID、模型和会话状态。
- 支持底部输入框和终端直接输入两种交互方式。
- 支持拖动调整输入框高度，避免长文本被底部操作区遮挡。
- 支持全局搜索会话名称、历史输出、工具箱内容和文档内容。

会话启动时，Agent 配置会被转换为当前会话的初始化上下文，包括系统提示词、行为规则、Skill、知识库和 MCP 信息，使 AI 在第一次交互时即可按照配置的工作方式处理任务。

### 2. Agent 中心

Agent 中心用于沉淀可重复使用的 AI 工作方式。每个 Agent 可以独立配置：

- Agent 名称和描述
- Claude Code、Codex 或 GUI Agent 类型
- 默认模型
- 工作目录
- 默认分组
- 系统提示词
- 行为规则
- Skill
- 知识库或文档资源
- MCP 服务

支持的管理操作：

- 新建 Agent
- 编辑 Agent 配置
- 复制 Agent 配置
- 删除 Agent
- 从列表直接创建 Agent 会话
- 导入和导出 Agent 配置
- 按 Claude、Codex、GUI 类型筛选
- 在配置总览、基本信息、行为规则、能力与资源之间切换

复制 Agent 时会自动生成“原名称-复制”的新配置，保存后即可作为独立 Agent 使用。

### 3. Claude Code 和 Codex 会话

AgentBox 通过本机登录 Shell 启动对应 CLI：

```text
claude
codex
```

使用前需要确保对应命令已经安装，并且可以从当前 Shell 的 `PATH` 中找到。

会话能力包括：

- 新建 Claude Code 会话
- 新建 Codex 会话
- 指定模型和工作目录
- 恢复已有 CLI 会话
- 保存并识别 CLI 会话 ID
- 停止当前 PTY 进程
- 恢复会话前清理旧画面
- 加载 Claude 和 Codex 历史记录
- 对 Codex 终端输出进行结构化阅读和问答区分

### 4. 工具箱

工具箱用于管理可重复使用的研发辅助内容，包括：

- 提示词
- 代码片段
- URL
- Agent
- 工作流
- 自定义 Shell 或脚本功能

支持：

- 搜索工具名称、描述和内容
- 按来源筛选
- 按类型筛选
- 收藏和取消收藏
- 调整工具顺序
- 新增、编辑和删除自定义工具
- 在 AI 会话中直接插入工具内容
- 导出全部、当前筛选结果或指定工具
- 导入工具配置
- 导入时预览新增项和冲突项
- 对冲突配置执行跳过、覆盖或另存为新配置

在 AI 会话输入框中输入 `/` 可以唤起 Skill、Agent、CLI 命令和工具箱提示词。支持按名称、来源和描述进行匹配，也支持中文提示词名称搜索。

### 5. File 工作区

File 工作区是独立的本地文件查看页面，适合长时间阅读和整理文档。

主要能力：

- 选择本地目录并浏览文件树
- 展开、折叠和调整目录列表宽度
- 打开多个文件标签
- 收藏常用文件
- 按文件名筛选
- 使用 `Cmd + F` 搜索当前文档
- 按回车跳转到下一个匹配结果
- 调整文档整体缩放比例
- 显示或隐藏 Markdown 大纲
- 右键插入引用
- 右键插入带路径引用
- 将当前文件内容插入 AI 会话
- 将文件路径、文件夹路径或压缩包路径插入 AI 会话

当前支持预览的文件类型包括：

- 文档：`.md`、`.markdown`、`.docx`、`.doc`、`.pdf`、`.rtf`、`.odt`、`.ods`、`.odp`
- 图片：`.png`、`.jpg`、`.jpeg`、`.gif`、`.svg`
- 代码和配置：`.java`、`.js`、`.jsx`、`.ts`、`.tsx`、`.css`、`.html`、`.xml`、`.json`、`.yaml`、`.yml`、`.properties`、`.sql`、`.kt`、`.rs`、`.toml`、`.log`、`.sh`、`.bash`、`.py`、`.go`、`.c`、`.cpp`、`.h`、`.vue`、`.ini`、`.conf`、`.env`

其中 `.docx` 会尽量保留 Word 原始排版；`.doc`、`.rtf`、`.odt`、`.ods` 和 `.odp` 使用 macOS 文档转换能力生成可阅读的 HTML 预览。

### 6. PromptPad 和快捷工具

- 支持通过快捷键唤起快速工具浮窗。
- 支持将工具内容写入剪贴板。
- 在已授权 macOS 辅助功能权限后，可自动粘贴到其他应用。
- 支持 JSON 格式化、URL 打开、剪贴板读取和内容写入。
- 支持语音输入，将语音识别结果写入当前会话输入框。

## 快速开始

### 环境要求

- macOS
- Node.js 18 或更高版本
- npm
- Rust toolchain
- Tauri CLI
- 可选：Claude Code CLI
- 可选：Codex CLI

如果要使用 AI 会话，请提前安装对应 CLI，并确认命令可以正常执行：

```bash
claude --version
codex --version
```

### 安装依赖

```bash
npm install
```

### 启动开发环境

```bash
npm run dev
```

如需启动 Tauri 桌面开发模式：

```bash
npm run tauri dev
```

### 运行测试

```bash
npm test -- --run
```

### 构建前端

```bash
npm run build
```

## 打包 macOS 应用

构建未签名的 `.app` 和 `.dmg`：

```bash
npm run dist:mac
```

构建产物：

```text
src-tauri/target/release/bundle/macos/AgentBox.app
src-tauri/target/release/bundle/dmg/AgentBox_<版本>_aarch64.dmg
```

默认情况下，DMG 还会复制到源码目录同级的 `AgentBox-releases/`。

如需指定安装包归档目录：

```bash
AGENTBOX_RELEASES_DIR=/path/to/releases npm run dist:mac
```

## 签名与公证

直接分发给其他用户时，建议使用 Apple Developer ID 签名和 notarization 公证。

检查签名环境：

```bash
npm run dist:mac:check-signing
```

生成签名并公证的安装包：

```bash
npm run dist:mac:signed
```

需要提前准备：

1. Apple Developer ID Application 证书。
2. `notarytool` 凭据。

可以通过环境变量指定签名证书：

```bash
export AGENTBOX_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
```

可以通过环境变量指定公证 profile：

```bash
export AGENTBOX_NOTARY_PROFILE="你的 profile 名称"
```

默认公证 profile 为 `agentbox-notary`。

## 本地数据

AgentBox 主要使用本地文件保存数据：

```text
~/.agentbox/features.json
~/.agentbox/prefs.json
~/.agentbox/ai_workspace.json
~/.agentbox/ai_session_history/
```

这些文件包含工具箱配置、收藏排序、会话列表、会话元数据和历史输出。删除应用不会自动删除这些数据，重新安装后仍可能继续读取原有配置。

从旧版本升级时，如果检测到 `~/.promptpad`，AgentBox 会在首次访问本地数据时将缺失文件复制到 `~/.agentbox`；新目录中已有的文件不会被覆盖，旧目录也会保留作为备份。

## 项目结构

```text
AgentBox/
├── src/                 # React 前端源码
│   ├── features/        # AI 会话、Agent、工具箱、File 等功能模块
│   ├── shared/          # 共享类型、存储和数据模型
│   └── styles.css       # 全局样式
├── src-tauri/           # Tauri / Rust 后端
│   ├── src/             # PTY、会话存储、文件读取和系统能力
│   ├── macos/           # macOS 语音助手源码
│   ├── icons/           # 应用图标
│   └── tauri.conf.json  # Tauri 构建配置
├── scripts/             # 开发、打包、签名和公证脚本
├── demos/               # 独立功能演示页面
├── docs/                # 文档和截图目录
├── public/              # 静态资源
├── package.json         # 前端和 Tauri 命令入口
└── README.md
```

构建生成的 `node_modules/`、`dist/`、`src-tauri/target/`、`src-tauri/resources/`、`.app`、`.dmg` 和 `.zip` 不建议提交到 GitHub。

## 技术栈

- React 18：构建桌面端用户界面
- TypeScript：类型安全和前端业务开发
- Vite：前端开发和生产构建
- Tauri 2：提供 macOS 桌面容器和系统能力
- Rust：实现 PTY、文件系统、会话存储和系统调用
- portable-pty：管理 Claude Code、Codex 和普通终端进程
- xterm.js：终端内容展示和交互
- docx-preview：Word 文档预览
- Mermaid：流程图和技术图表渲染
- Vitest、Testing Library：单元测试和界面交互测试

## 隐私与安全说明

- AgentBox 默认不上传会话内容和本地文件。
- AI 请求由本机安装的 Claude Code、Codex 或其他 CLI 负责处理。
- 使用本地文件引用功能时，应用会读取用户主动选择的文件或目录。
- 工作目录、会话历史和工具箱配置保存在本机。
- 请勿将包含密钥、Token、密码或个人隐私的文件直接发送给 AI。
- macOS 辅助功能权限仅用于 PromptPad 的自动粘贴能力。

## 当前限制

- Claude Code 和 Codex 需要用户自行安装，AgentBox 不内置第三方 CLI。
- AI 会话能力取决于本机 CLI 的版本、登录状态和可用模型。
- 文档预览默认限制单文件大小，超大文件可能无法加载。
- `.doc` 等旧格式依赖 macOS 文档转换能力。
- 未签名或未公证的 macOS 应用可能被 Gatekeeper 拦截。
