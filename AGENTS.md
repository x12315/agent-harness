# AGENTS.md

跨工具的通用指令层。任何支持 AGENTS.md 的 agent 都会读取本文件。

本仓库（`~/.agents/`）是 agent loop 的唯一真相源，通过 symlink 投影到各
harness 的原生位置。详见 `README.md`。

## 环境事实

- 机器：macOS (Apple Silicon)，包管理用 Homebrew。
- 可用：`gh`、`npm`、`uv`、`git`、`python3`。
- 不可用（不要假设存在）：`pnpm`、`stow`、`chezmoi`。
- 默认 shell 为 zsh。
- Skill 根目录：`~/.agents/skills/`（中立发现路径，pi 与多数 harness 原生读取）。
- 第三方 skill 用 `npx skills`（未全局安装）装，锁在 `.skill-lock.json`。

## 约定

- **回复语言：中文。** 代码、标识符、提交信息用英文。
- 改动前先读现有文件，不要凭猜测重写。
- 修改本仓库内容后，若 agent 正在运行，需 `/reload` 才会生效。
- 改动 `~/.agents/` 前先读 `README.md` 的「特殊操作流程」——投影、对账、回滚、
  graft 都有坑；第三方 skill 的安装/更新规则见「第三方依赖的管理」。

## 待补（按需填写）

- 代码风格偏好：
- 提交信息规范：
- 常用项目根目录：`~/Desktop/`、`~/Documents/`、`~/conductor/repos/`
  （这些下面有带项目级 `.agents/skills/` 的仓库）
