---
name: agent-harness
description: 维护本机厂商中立的 Harness Catalog + Composer（~/.agents/）。当用户要收编或修改 instruction、skill、profile，适配新的 agent harness，恢复声明依赖，或排查资源未生效时使用。
license: MIT
metadata:
  repo: "~/.agents"
---

# agent-harness 维护

`~/.agents/` 收编中立资源与组合声明，并编译成各 harness 的原生配置。修改前必须读取仓库 `AGENTS.md`；硬规则以它为准。设计理由、特殊流程与本机事实见 `README.md`。

## 职责边界

- 仓库拥有：`instructions/`、`profiles/`、自有 skill、adapter、生成器与依赖声明。
- 官方工具拥有：第三方 skill/npm 产物、模型认证、会话和 runtime state。
- `AGENTS.md`、`adapters/pi/profiles/*.json`、`adapters/codex/profiles/*.config.toml` 是生成物，禁止手改。
- Composer 只编译、投射和检查，不实现 registry 或第三方安装协议。

## Instruction 与 Profile

Instruction modules 分三层：

- `instructions/mandatory/`：不可关闭的安全与授权边界。
- `instructions/repository/`：在本仓库工作时常驻。
- `instructions/profile/`：由 `profiles/*.json` 选择的工作模式增量。

Profile 必须显式声明 `skills`：`[]` 表示无 skill，`["*"]` 表示全部，其他名称/glob 表示白名单。厂商资源进入 `adapters.pi` / `adapters.codex`，不要污染中立 instruction。

```bash
node scripts/harness.mjs profile [name]   # 查看声明组合
node scripts/harness.mjs compose          # 检查生成漂移
node scripts/harness.mjs compose --apply  # 重新生成
```

Pi 运行时使用 `pi-profile <name>` 与 `/profile`；Codex 使用 `codex -p <name>`。具体格式和上游差异见 `profiles/README.md`。

## 新增或修改 Skill

```bash
mkdir -p ~/.agents/skills/<name>
# 写 SKILL.md；description 必须同时说明“做什么”和“何时触发”
```

自有 skill 必须在同一提交里给 `.gitignore` 增加 `!/skills/<name>/`。第三方 skill 只能用固定版本 `skills` CLI 安装并更新 `.skill-lock.json`，内容不提交。不要让其他 manager 拥有 `~/.agents/skills`。

`SKILL.md` 顶层只允许 `name`、`description`、`license`、`compatibility`、`metadata`、`allowed-tools`；`name` 与目录同名，厂商字段放 `metadata:`。

## 恢复与对账

```bash
node scripts/harness.mjs install  # 新机器：compose、投影、委托恢复、对账、验收
node scripts/harness.mjs restore  # 默认只打印官方安装命令
node scripts/harness.mjs all      # 改动后的只读总验收
```

`restore` 委托 `skills` CLI 恢复共享 skill，并委托 npm 恢复声明的 adapter runtime。它不拥有安装产物。破坏性操作、graft、回滚与第三方更新步骤见 README“特殊操作流程”。

## 排错

| 症状 | 检查 |
| --- | --- |
| 生成物漂移 | 修改源码后运行 `harness.mjs compose --apply`，不要修生成文件 |
| Profile 引用失败 | `harness.mjs profile <name>`；检查 instruction ID、skill 名/glob、模型认证 |
| Pi Profile 技能数为零 | Profile 必须显式写 `skills`；全量使用 `["*"]` |
| Codex skill 开关无效 | 生成配置必须引用具体 `~/.agents/skills/<name>/SKILL.md` |
| skill 没出现 | 确认文件名恰为 `SKILL.md`、frontmatter 完整、运行中会话已 reload |
| lock 有但磁盘没有 | `harness.mjs reconcile` 后用 `restore --apply` |
| 启动有重名警告 | 查私有 skill 目录和中立目录是否重复；只允许验证过的 adapter 私有产物 |
| 投影被实体化 | 移走冲突实体并运行 `harness.mjs bootstrap --apply`；脚本不会替你删除 |

## 接入新 Harness

1. 先查它是否原生发现 `.agents/skills/` 和 `AGENTS.md`。
2. 在 `adapters/<name>/` 内实现薄翻译层；中立 Profile/schema 不加入厂商字段。
3. 能原生选择 profile 就生成原生配置；否则只提供声明检查，不先造长期 daemon。
4. 把投影加入 `managedLinks()`，把契约检查加入 `verify`。
5. 更新 `profiles/README.md` 与 README 投影表。
6. 运行 `node scripts/harness.mjs all`。

只有当中立 schema/compiler 出现第二个独立仓库使用方时，才将其抽成新项目；不要为潜在复用提前拆仓库。
