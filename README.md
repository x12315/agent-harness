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

## 验证改动是否生效

`pi --mode rpc` 可以无模型调用地列出已注册的命令，用来确认 skill / extension
是否被正确发现：

```bash
printf '{"id":"1","type":"get_commands"}\n' | pi --mode rpc
```

输出里看两项：`source=skill` 的条目（确认 `sourceInfo.baseDir` 指向 `~/.agents`）
和 `source=extension` 的条目。stderr 应为空——有重名或格式错误会在这里报警告。

首次引导时实测结果：31 个命令，含 28 个第三方 `lark-*`、自有 `agent-harness`
（`baseDir: ~/.agents`）、以及经软链加载的 `handoff` extension；stderr 为空。

## 第三方依赖的管理

三种东西要分开，混了就会出问题：

| 类别 | 例子 | 管理机制 | 入库？ |
| --- | --- | --- | --- |
| 第三方 skill | `skills/lark-*/` | `skills` CLI，锁定在 `.skill-lock.json` | ❌ 不 vendor |
| 依赖清单 | `.skill-lock.json` | 归 git 管 | ✅ |
| 自有 skill | `skills/agent-harness/` | 直接写 | ✅ |

原则与 `node_modules` / `package-lock.json` 相同：**依赖产物不入库，声明入库。**
这样仓库只有几百行，换机器靠 lockfile 复现。

### 为什么不用 APM

Microsoft APM 是这个领域功能最全的管理器（skills / prompts / agents / hooks /
plugins / MCP / LSP 一起管，有 lockfile、policy、audit，覆盖 copilot / claude /
cursor / codex / gemini / windsurf / kiro / opencode / grok-build）。
但对本仓库它**不适用**：

1. **装不了现有的第三方集。** 28 个 lark skill 全部是 `sourceType: well-known`
   （`https://open.feishu.cn/lark-cli/skills/regular/.well-known/agent-skills/*.tar.gz`）。
   APM 的源类型只有 git repo / 本地路径 / bundle / marketplace / registry，
   其 CLI 参考中 `well-known` 出现 0 次。换过去等于丢掉这 28 个 skill。
2. **会撞目录。** APM 默认把 skill 部署到 `.agents/skills/`（传
   `--legacy-skill-paths` 才用各家私有路径），与 `skills` CLI 的安装目标完全
   相同。两个管理器写同一个目录，谁都不是权威。

结论：**`skills` CLI 是当前唯一选择**，不是因为它最好，而是因为它是唯一能复现
现有第三方集的。pi 不在 APM 的 target 列表里（可用 `--target agent-skills` 间接
覆盖），但这不是决定因素。

### 如果将来要迁到 APM

先确认要装的第三方源都能被 APM 表达，再把自有 skill 移出 `skills/`（见下），
避免两个管理器争抢 `.agents/skills/` 的所有权。

### 共享目录的固有风险

`~/.agents/skills/` 既是**多个管理器的部署目标**，又是本仓库的源目录，即
「构建产物落在源码树里」。`.gitignore` 的白名单机制就是为这个设计的。注意
`skills list` 会把 `agent-harness` 也列进它的清单（标为 `Source: local`），
所以不要用 `skills remove` 的交互式全选来清理——会误删自有 skill。

## 尚未版本化的东西

`~/.pi/agent/settings.json` 里的 `packages` 数组（[pi
packages](https://pi.dev/packages) 声明）目前不在本仓库里。当前是空的，所以还没
关系；一旦开始用 `pi install`，那份声明应该按同样原则搬进来——声明入库，
`node_modules` 之类的产物不入库。

## 已知情况

- `~/.pi/agent/skills/lark-*` 是 28 个指向 `~/.agents/skills/` 的软链，属早期
  安装遗留。pi 原生扫描 `~/.agents/skills/`，但两者并存**不会**造成重复发现
  ——pi 按解析后的真实路径去重，实测无警告。可以保留，不必清理。
- 本仓库的 git 身份是 repo-local 的占位值（`montana <montana@localhost>`），
  因为这台机器没有全局 `user.name` / `user.email`。推送到远端前请改成真实值。
