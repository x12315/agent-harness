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
- `adapters.pi`：Pi 的推荐模型与 tools/extensions/MCP 选择。
- `adapters.codex`：Codex 的推荐模型与 sandbox/approval 选择。

模型映射刻意留在 adapter 内：中立层只表达共同的 instructions/skills，不能假设两个 harness 使用同一 provider ID。命令行和会话显式选择仍可覆盖推荐模型。

Profile 名不能是 `default`：这是 `pi-profile-switch` 的内置全量模式。

## 命令

```bash
node scripts/harness.mjs profile          # 查看全部声明组合
node scripts/harness.mjs profile review   # 查看一个
node scripts/harness.mjs compose          # 检查生成物
node scripts/harness.mjs compose --apply  # 重新生成
```

运行时：

```bash
pi-profile ask
# 会话中：/profile、/profile status、/profile use review、/profile overlay ...

codex -p ask
codex -p review
codex -p implement
```

Pi 的 profile 可以在会话中热切换；Codex 的 profile 在启动时通过 `-p` 选择。两边都读取同一份中立声明，但由 adapter 生成各自格式。

## 上游边界

- `pi-profile-switch` 只负责 Pi 的解析、热切换、runtime overlay 与冲突报告；版本声明在 `scripts/pinned-versions.json`，由 `restore` 委托 npm 安装。
- 0.11.0 会生成 `~/.pi/agent/skills/profile-config/SKILL.md`。它只会编辑 Pi 原生 profile，不能作为本仓库的跨平台配置入口，因此 composer 不声明它，bootstrap 也用展开后的精确 `-path` 从普通 Pi 排除它。但上游 launcher 会把它强制带进所有 Pi Profile，当前无法由 Profile 收窄；常驻规则禁止它修改生成物，请使用自有 `harness-profile-config`。已向上游提交 opt-out 请求 [VincentFF/pi-profile-switch#64](https://github.com/VincentFF/pi-profile-switch/issues/64)。该私有产物仍由 `verify` 与固定版本模板逐字比对。
- 0.11.0 实现中，省略 `skills` 会收窄为零（与文档声称的“不收窄”不同），所以中立 schema 强制显式声明，全部技能用 `["*"]`。
- 当前 Codex 实现要求 `skills.config.path` 指向具体 `SKILL.md`，而不是文档所说的 skill 文件夹；生成器使用可跨机器展开的 `~/.agents/skills/<name>/SKILL.md`。

## 为什么暂不拆新项目

中立 schema 与 composer 目前只有这个仓库一个使用方。代码保持无第三方依赖、输入输出边界清楚；等出现第二个独立仓库或第三个 harness adapter，再把 `compose.mjs` 与 schema 抽成单独项目。在此之前拆仓库只会增加版本协调，不会增加复用。
