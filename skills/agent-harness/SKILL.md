---
name: agent-harness
description: 维护本机 agent loop 仓库（~/.agents/）。当用户要新增或修改 skill、调整跨
  harness 的指令、为新的 agent 工具做适配、或排查 skill 没被加载时使用。
license: MIT
metadata:
  repo: "~/.agents"
---

# agent-harness 维护

本仓库 `~/.agents/` 是 agent loop 的唯一真相源。改动前读 `README.md`，那里有
完整的分层说明与投影表。

## 核心约束

1. **内容层保持厂商中立。** `skills/` 和 `AGENTS.md` 里不出现任何 harness 特有
   概念。厂商私有的东西一律关进 `adapters/<name>/`。
2. **只用规范定义的六个 frontmatter 字段**：`name` / `description` /
   `license` / `compatibility` / `metadata` / `allowed-tools`。厂商扩展字段
   （如 pi 的 `disable-model-invocation`）放进 `metadata:`，否则别的实现不认。
3. `name` 必须与所在目录同名——pi 不强制，但其他实现会强制。

## 新增一个 skill

```bash
mkdir -p ~/.agents/skills/<name>
# 写 SKILL.md，description 要同时说明「做什么」和「何时触发」
```

**必须**在同一提交里往 `.gitignore` 加一行 `!/skills/<name>/`。`.gitignore`
默认忽略 `skills/` 全部内容（第三方安装产物 6MB+，等同 node_modules），只白名单
放行自有 skill，忘了加白名单会导致文件不被跟踪。

`description` 决定模型是否加载该 skill，写成 "Helps with X" 这种会失效。

## 第三方依赖

skill 目录下的第三方集由 `skills` CLI 管理（`skills add` / `update` / `remove`），
锁定在 `.skill-lock.json`。**不要把它们 vendor 进仓库**——依赖产物不入库，
声明入库。

注意 `skills list` 会把自有 skill 也列进它的清单（标为 `Source: local`），
不要用 `skills remove` 的交互式全选清理。

APM（Microsoft Agent Package Manager）虽然更全，但装不了本机这批第三方 skill
（它们来自 `well-known` 源，APM 不支持），且默认也写 `.agents/skills/` 会撞目录。
详见 `README.md` 的「第三方依赖的管理」。

## 排错

| 症状 | 检查 |
| --- | --- |
| skill 没出现在可用列表 | 目录下是否有**恰好**名为 `SKILL.md` 的文件；`name` 字段是否存在；`description` 是否为空（缺失则不加载） |
| 启动有重名警告 | 同一个 skill 被多处发现。检查 `~/.pi/agent/skills/` 下的遗留软链与 `~/.agents/skills/` 是否重复 |
| 改了没生效 | 运行中的 session 需 `/reload` |
| 确认 pi 能看到哪些 skill | 看启动诊断，或直接 `/skill:<name>` 强制加载 |
| `AGENTS.md` 没被读到 | 确认 `~/.pi/agent/AGENTS.md` 软链可解析（从该目录到 `~/.agents/` 要上**两**级） |

## 为新的 harness 做适配

1. 查它是否遵循 `.agents/skills/` 约定——若是，skill 无需任何适配。
2. 查它的全局指令文件名（pi 是 `~/.pi/agent/AGENTS.md`，Claude Code 是
   `CLAUDE.md`，多数工具支持 `AGENTS.md`）。不同则在 `adapters/<name>/` 下建
   指向 `../../AGENTS.md` 的软链，再投影到它的位置。
3. 把该 harness 的私有资产（如 pi 的 extensions）放进 `adapters/<name>/`，
   原位置留绝对路径软链。
4. 在 `README.md` 的「投影」表格里补一行。
