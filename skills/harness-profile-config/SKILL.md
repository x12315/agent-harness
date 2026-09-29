---
name: harness-profile-config
description: 创建、修改、删除并检查 ~/.agents 中的跨 harness Profile 与 instruction modules，同时生成 Pi/Codex 原生配置。当用户要求配置 profile、切换工作模式包含哪些 instructions/skills/models/tools，或检查有效 harness 组合时使用；不要使用 Pi 私有的 profile-config 修改生成文件。
license: MIT
metadata:
  repo: "~/.agents"
---

# Cross-harness Profile Config

本 skill 管理中立源码：

- `profiles/*.json`
- `instructions/profile/*.md`

以下是生成物，**禁止直接修改**：

- `AGENTS.md`
- `adapters/pi/profiles/*.json`
- `adapters/codex/profiles/*.config.toml`

## 创建或修改 Profile

1. 读取仓库 `AGENTS.md`、`profiles/README.md` 与 `profiles/profile.schema.json`。
2. 用 `node scripts/harness.mjs profile [name]` 检查现有声明。
3. 编辑 `profiles/<name>.json`；可复用的行为指令进入 `instructions/profile/<name>.md`，不要把大段指令复制到多个 Profile。
4. `skills` 必须显式声明：`[]` 表示无技能，`["*"]` 表示全部，其他名称/glob 是白名单。
5. 共同字段只放 `instructions` 与 `skills`；模型、工具和权限等厂商字段分别进入 `adapters.pi` / `adapters.codex`。
6. 生成并检查：

   ```bash
   node scripts/harness.mjs compose --apply
   node scripts/harness.mjs profile <name>
   node scripts/harness.mjs all
   ```

7. 运行中的 Pi 用 `/profile reload` 或 `/profile use <name>`；Codex 在新会话用 `codex -p <name>`。

## 删除 Profile

删除 `profiles/<name>.json` 后运行 compose。Composer 会移除两端的陈旧生成文件；bootstrap/verify 会报告仍存在的投影或冲突。不能创建或删除 Pi 内置的 `default`。

## 边界

- 不安装或更新 skill/package；缺依赖时使用 `harness.mjs restore` 委托官方工具。
- 不编辑 `~/.pi-profile-switch/profiles`：它是生成目录投影。
- 不编辑 Pi 私有 `profile-config` skill：它由固定版本上游包覆盖，且不参与本仓库 Profile 编排。
- Profile 推荐模型是工程声明；API key、认证状态和临时会话覆盖仍留本机。
