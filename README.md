# agent-harness

个人的、厂商中立的 agent loop 仓库。让 skill、指令和工具配置可复用、可版本化、
可跨 harness 迁移。

## 为什么是这个形状

Agent Skills 规范（由 Linux Foundation 下的 Agentic AI Foundation 治理）
只定义了 skill 目录**内部**长什么样，没有规定它们**放在哪**。规范自己的
集成指南推荐客户端同时扫描 `<client>` 私有路径和 `.agents/` 中立路径：

| Scope   | 路径                       | 用途           |
| ------- | -------------------------- | -------------- |
| Project | `<project>/.agents/skills/` | 跨客户端互通   |
| User    | `~/.agents/skills/`         | 跨客户端互通   |

所以本仓库根目录就设在 `~/.agents/`，`skills/` 天然落在中立发现路径上——
遵循规范的 agent 零配置即可读到，不需要给每个工具做 symlink farm。

## 目录结构

```
~/.agents/
├── AGENTS.md              # 通用指令层（中立源）
├── .skill-lock.json       # 第三方 skill 锁定，可复现
├── .gitignore             # 屏蔽第三方 skill 安装产物
├── skills/                # 权威 skill 源。发现路径本身
│   ├── lark-*/            #   ← 第三方，已 gitignore
│   └── agent-harness/     #   ← 自有
└── adapters/              # harness 差异只写在这里
    └── pi/
        └── extensions/handoff.ts
```

分层原则：**内容层通用，适配层隔离。** `skills/` 和 `AGENTS.md` 不含任何
厂商特有概念；每家的私有差异（如 pi 的 extensions）关在 `adapters/<name>/`。

## 投影（symlink）

`~/.agents/` 是源，各 harness 的原生路径是投影：

| 源                                        | 投影                          | 原因                                   |
| ----------------------------------------- | ----------------------------- | -------------------------------------- |
| `AGENTS.md`                               | `~/AGENTS.md`                 | 祖先目录发现，对所有 agent 通用        |
| `AGENTS.md`                               | `~/.pi/agent/AGENTS.md`       | pi 的全局指令只认 agent-dir 下这条路   |
| `adapters/pi/extensions/handoff.ts`       | `~/.pi/agent/extensions/`     | pi 的 extension 是厂商私有机制         |
| `skills/`                                 | —（无需投影）                 | pi 原生扫描 `~/.agents/skills/`        |

若某个 harness 有自家的指令文件名（例：Claude Code 读 `CLAUDE.md`，且不在
agents.md 的支持列表里），在 `adapters/<name>/` 下放一个指向 `../../AGENTS.md`
的软链，再把它投影到该 harness 的位置。目前只装了 pi，所以还没有这类 adapter。

## 第三方 skill

由 `skills` CLI 从远端 registry 安装，锁定在 `.skill-lock.json`：

```bash
npx skills add <source>        # 安装，自动更新 lockfile
npx skills list
```

它们等同 `node_modules`，不入库。在新机器上装完 CLI 后按 lockfile 复现即可。

## 新增自有 skill

```bash
mkdir -p ~/.agents/skills/<name>
$EDITOR ~/.agents/skills/<name>/SKILL.md
```

写完**必须在 `.gitignore` 加一行** `!/skills/<name>/`，否则不会被跟踪。

`SKILL.md` 只用规范定义的六个字段，保证跨 harness 可读：

`name`（必填，小写+连字符，需与目录同名）、`description`（必填，≤1024 字符，
要写清「做什么」和「何时用」）、`license`、`compatibility`、`metadata`、
`allowed-tools`。

厂商特有字段（如 pi 的 `disable-model-invocation`）不要直接写在顶层——其他
实现不认。放 `metadata:` 里。

## 在新机器上恢复

```bash
git clone <this-repo> ~/.agents
ln -sfn .agents/AGENTS.md ~/AGENTS.md
# 按需为每个 harness 建投影，见 README 的「投影」表格
npx skills add ...   # 或按 .skill-lock.json 复现第三方集
```

## 已知问题

- `~/.pi/agent/skills/lark-*` 是 28 个指向 `~/.agents/skills/` 的软链，属早期
  安装遗留。pi 现在原生扫描 `~/.agents/skills/`，这些软链可能造成重复发现。
