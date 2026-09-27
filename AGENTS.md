# AGENTS.md

跨工具的通用指令层。任何支持 AGENTS.md 的 agent 都会读取本文件。

本仓库（`~/.agents/`）是 agent loop 的唯一真相源，通过 symlink 投影到各
harness 的原生位置。详见 `README.md`。

## 环境事实

- 机器：macOS (Apple Silicon)，包管理用 Homebrew。
- 可用：`gh`、`npm`、`uv`、`git`、`python3`。
- 不可用（不要假设存在）：`pnpm`、`stow`、`chezmoi`。
- 默认 shell 为 zsh。

## 约定

- **回复语言：中文。** 代码、标识符、提交信息用英文。
- 改动前先读现有文件，不要凭猜测重写。
- 修改本仓库内容后，若 agent 正在运行，需 `/reload` 才会生效。

## 待补（按需填写）

- 代码风格偏好：
- 提交信息规范：
- 常用项目根目录：
