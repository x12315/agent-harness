# Harness Profiles

`profiles/*.json` 是跨 harness 的组合声明。它们只引用已经收编的 instruction modules 与 skills，并把厂商差异关进 `adapters.<name>`；不复制或安装资源。

## 数据流

```text
instructions/ + profiles/
          │
          ▼
 scripts/compose.mjs
    ├── AGENTS.md
    ├── adapters/pi/profiles/*.json
    └── adapters/codex/profiles/*.config.toml
```

前三者是源码；后三者是受控生成物。生成物提交到 git，方便新机器在安装 composer 依赖前就能被 harness 读取，但禁止手改。

## Profile 字段

- `instructions`：`instructions/profile/` 下的模块 ID。不可关闭与仓库级模块由 composer 自动加入 `AGENTS.md`，不在这里重复。
- `skills`：必须显式声明。`[]` 表示无共享 catalog skill，`["*"]` 表示全部已声明 skill，其他名称/glob 表示白名单。Pi 0.11.0 的包私有 `profile-config` 仍会常驻，见下方上游边界。
- `adapters.pi`：Pi 的推荐模型与 tools/extensions/MCP 选择。`harness-manager` 必须在每个 Profile 中显式保留；implement 显式列出仓库自有和已声明 package 的扩展集，本机私有 UI 扩展不进入共享声明。
- `adapters.codex`：Codex 的推荐模型与 sandbox/approval 选择。

模型映射刻意留在 adapter 内：中立层只表达共同的 instructions/skills，不能假设两个 harness 使用同一 provider ID。命令行和会话显式选择仍可覆盖推荐模型。

Profile 名不能是 `default`：这是 `pi-profile-switch` 的内置全量模式。

## 管理与运行

管理面不属于任何工作 Profile，也不受它的 tools/sandbox 权限约束：

```bash
harness                              # 状态与下一步
harness profile list
harness profile show review
harness profile edit review          # 编辑中立源码，随后自动生成、投影、验收
harness apply
harness doctor
```

Pi 内使用 `/harness` 打开同一管理面；它是人类触发的 extension command，不向模型注册 tool。工作会话通过控制面启动：

```bash
harness run pi ask
harness run codex review
```

Pi 会话中仍可用 `/profile use review` 热切换；`pi-profile` 只是 `harness run pi` 背后的 runtime engine。Codex 仍由原生 `-p` 实现，但用户无需记住 adapter 命令。

## 上游边界

- `pi-profile-switch` 只负责 Pi 的解析、热切换、runtime overlay 与冲突报告；版本声明在 `scripts/pinned-versions.json`，由 `restore` 委托 npm 安装。
- 0.11.0 会生成 `~/.pi/agent/skills/profile-config/SKILL.md`。它只会编辑 Pi 原生 profile，不能作为本仓库的跨平台配置入口，因此 composer 不声明它，bootstrap 也用展开后的精确 `-path` 从普通 Pi 排除它。但上游 launcher 会把它强制带进所有 Pi Profile，当前无法由 Profile 收窄；用户管理入口是 `/harness`，扩展命令会在 skill 展开前被处理，不经过模型。已向上游提交 opt-out 请求 [VincentFF/pi-profile-switch#64](https://github.com/VincentFF/pi-profile-switch/issues/64)。该私有产物仍由 `verify` 与固定版本模板逐字比对。
- 0.11.0 实现中，省略 `skills` 会收窄为零（与文档声称的“不收窄”不同），所以中立 schema 强制显式声明，全部技能用 `["*"]`。省略 `extensions` 同样不会保留普通用户扩展，因此 implement 也显式声明共享扩展集；runtime canary 会验证管理、收藏、handoff、goal 与 webui 命令仍在。
- 当前 Codex 实现要求 `skills.config.path` 指向具体 `SKILL.md`，而不是文档所说的 skill 文件夹；生成器使用可跨机器展开的 `~/.agents/skills/<name>/SKILL.md`。

## 为什么暂不拆新项目

中立 schema 与 composer 目前只有这个仓库一个使用方。代码保持无第三方依赖、输入输出边界清楚；等出现第二个独立仓库或第三个 harness adapter，再把 `compose.mjs` 与 schema 抽成单独项目。在此之前拆仓库只会增加版本协调，不会增加复用。
