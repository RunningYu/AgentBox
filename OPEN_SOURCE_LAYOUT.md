# AgentBox 开源目录说明

本项目已按“源码”和“构建产物”分离：

```text
AgentBox/           # 源码目录
AgentBox-releases/  # 可选的安装包归档目录，不纳入源码仓库
```

## 源码目录

`AgentBox/` 保留完整可构建源码：

- `src/`：React 前端源码
- `src-tauri/`：Tauri / Rust 后端源码、权限配置、图标和内置资源
- `scripts/`：macOS 打包、签名、公证脚本
- `docs/`：设计文档和开发记录
- `demos/`：独立功能演示页面
- `public/`：前端静态资源
- `package.json`：开发、测试和打包入口

## 构建产物

以下目录不建议纳入开源仓库：

- `node_modules/`
- `dist/`
- `src-tauri/target/`
- `releases/`
- `*.dmg`
- `*.app`
- `*.zip`

历史安装包统一放在同级的 `AgentBox-releases/`，避免源码仓库携带大体积二进制文件。

## 打包兼容性

`npm run dist:mac` 仍可在源码目录内直接执行。脚本会：

1. 使用当前源码构建 `AgentBox.app`
2. 生成当前版本 DMG 到 `src-tauri/target/release/bundle/dmg/`
3. 自动复制一份到 `../AgentBox-releases/`

如需改归档路径：

```bash
AGENTBOX_RELEASES_DIR=/path/to/releases npm run dist:mac
```

源码仓库不依赖本机绝对路径；构建脚本默认将安装包输出到项目同级的
`AgentBox-releases/`，也可以通过 `AGENTBOX_RELEASES_DIR` 指定其他目录。
