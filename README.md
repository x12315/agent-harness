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
│   ├── lark-*/            #   ← 第三方，已 gitignore（由 skills CLI 装入）
│   ├── agent-harness/     #   ← 自有
│   ├── book-translation/  #   ← 自有
│   └── self-explanatory-code/  # ← 自有
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
| `adapters/pi/extensions/handoff.ts`       | `~/.pi/agent/extensions/handoff.ts` | pi 的 extension 是厂商私有机制（文件级软链） |
| `skills/<name>/`                          | `~/.claude/skills/<name>`     | 该 harness 不读 `.agents/`，由 `skills` CLI 建软链 |
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

## 特殊操作流程

下面每个流程都有坑，单独记下来。

### A. 新机器恢复

```bash
git clone <this-repo> ~/.agents
ln -sfn .agents/AGENTS.md ~/AGENTS.md                          # 祖先链发现
ln -sfn ../../.agents/AGENTS.md ~/.pi/agent/AGENTS.md          # pi 全局指令位
ln -sfn ../../../.agents/adapters/pi/extensions/handoff.ts \
        ~/.pi/agent/extensions/handoff.ts                      # pi extension
npx skills add ...        # 按 .skill-lock.json 逐条复现第三方集
```

**`skills/` 不需要任何投影**（pi 原生扫描 `~/.agents/skills/`）。装完必须做
C 的对账——lock 是「应装清单」，不等于磁盘现状。

### B. 投影的建立与拆除

源永远是 `~/.agents/`，投影指向 harness 原生位置。三条规则：

1. **不投影 `skills/`**。往 `~/.pi/agent/skills/` 里放指向 `~/.agents/skills/` 的
   软链是反向冗余：pi 按**解析后的真实路径**去重，所以它能工作（实测数量不变、
   无警告），但多一份要维护的副本。
2. **禁止反向链**（项目 → 全局）。早期 `~/.agents/skills/ielts-writing` 直接软链
   到 `~/Desktop/ielts_writing_helper/.agents/skills/`，使全局技能依赖某个项目的
   存在。技能属于项目就留在项目；要全局可用，就把它作为**自有 skill** 收进
   `skills/` 并加白名单。
3. **`AGENTS.md` 的两条投影会各注入一次**：pi 按 symlink 路径去重（不是
   realpath），所以 cwd 在 `~` 下时同一份指令进提示词两次（约 803B）。保留两条是
   因为 cwd 在 `~` 之外时只有 agent-dir 那条生效。

### C. lock 与磁盘对账

`.skill-lock.json`（应装）与 `skills/`（实装）是两份独立数据，必须能解释差异。
按 `sourceType` 做集合运算，输出三类：**已声明未安装**、**已安装未声明**、**一致**。

本机实测（2026-09-28）：

| 类别 | 数量 | 明细 |
| --- | --- | --- |
| lock 声明 | 55 | github 27 + well-known 28 |
| 磁盘实装 | 55 | 已声明 52（28 个 `lark-*` + 24 个 github）+ 未登记 0 + 自有 3 |
| 已声明未安装 | 3 | `ielts`、`session-handoff`、`session-history` |
| 已安装未声明 | 0 | — |

收编记录（2026-09-28）：原本 9 个无来源技能全部处理完：

- **归为第三方（7 个）**：`implementing-drag-drop` → `ancoleman/ai-design-components`
  （收编前逐字节比对：19 文件 / 0 差异）；`executing-plans`、
  `subagent-driven-development` → `obra/superpowers`；`grilling` →
  `mattpocock/skills`；`ui-ux-pro-max` → `nextlevelbuilder/ui-ux-pro-max-skill`；
  `ielts-speaking` → `yanzhanlin/ielts-claude-skills`；`macos-design` →
  `ceorkm/macos-design-skill`。
- **归为自有（2 个）**：`book-translation`、`self-explanatory-code` 是作者自制，
  已加 `.gitignore` 白名单转为自有技能。

未登记技能只有两条出路：**补来源**（重装或手工补 lock 条目）或**判为自有**
（加白名单）。拖着不处理，它们既不可复现也不入库。

### D. 第三方 skill 的装 / 更新 / 删

```bash
npx skills add <source>      # 安装，自动更新 lockfile
npx skills list              # 看清单
npx skills update            # 更新——唯一允许的更新执行者
npx skills remove <name>     # 删除；不要用交互式全选
```

**不要用 `skills remove` 的交互式全选清理**：`skills list` 会把自有 skill
（`agent-harness`）也列进去（标为 `Source: local`），全选会连它一起删。

#### `well-known` 源（`lark-*`）的收编

飞书的「官方安装方法」就是一个标准 well-known 发现端点，**不需要飞书的下载器**：
`https://open.feishu.cn/lark-cli/skills/regular/.well-known/agent-skills/index.json`
（RFC 8615；`$schema: schemas.agentskills.io/discovery/0.2.0`；每个技能是
`type: archive` + `url: ./<name>.tar.gz` + `digest: sha256:…`）。
`skills` CLI 内置了 provider（`src/providers/wellknown.ts`），lock 里的
`sourceBaseUrl` / `wellKnownDigest` 就是它写的。收编命令：

```bash
npx --yes skills@latest add "https://open.feishu.cn/lark-cli/skills/regular" \
    -g -s '*' -a zed claude-code -y
```

四个坑，不知道就会装错位置：

1. **必须带一个 universal agent（如 `zed`）** 才能让文件落进规范存储
   `~/.agents/skills/`。`src/agents.ts` 里 `globalSkillsDir` 指向
   `~/.agents/skills` 的只有 `dexto`、`kimi-code-cli`、`loaf`、`sarvam-code`、
   `warp`、`zed`——它们是“读中立路径”的 agent。只传 `-a claude-code` 时，
   **base 会变成 `~/.claude/skills/`**，文件复制到那里，`~/.agents/skills/` 一个都
   没有，pi 也就看不到。正确输出里应出现 `universal: Zed` + `symlink → Claude Code`。
2. **不要用 `--all` / `-a '*'`**。CLI 把 pi 也当目标
   （`globalSkillsDir: ~/.pi/agent/skills`，且通过 `~/.pi/agent` 存在性自动探测），
   全局安装会在那里重建一整套软链农场——正是 B 里拆掉的旧模型。必须显式列 agent。
3. **`-a` 是空格分隔多值**（`-a zed claude-code`），不是逗号。
4. **`--json` 对 well-known 源不支持**（会直接报错退出，什么都没装）。

`well-known` 源只能由 `skills` CLI 安装——任何只认 git 的管理器都表达不了它们。
这是「为什么不用 APM」的第一条，也是图形管理器不能接管安装的根本原因。

#### 收编未登记技能（把磁盘上的“野”技能接回 lock）

源用 `https://skills.sh/api/search?q=<name>` 解析（返回 `owner/repo/skill`）：

```bash
npx --yes skills@latest add <owner/repo> -s <skill> -g -a zed claude-code -y
```

**警告：安装是整目录替换，不是合并。** 本地独有的文件会消失。执行前先留快照：

```bash
tar czf /tmp/agents-before-absorb-$(date +%Y%m%d-%H%M%S).tar.gz -C ~ .agents
```

若能从上游取到同名技能，**装之前先逐文件比对**——一致才说明本地无改动，收编无损：

```bash
gh api "repos/<owner>/<repo>/git/trees/main?recursive=1" \
  --jq '.tree[] | select(.path|startswith("skills/<name>/")) | .path'
# 逐文件取回后用 diff -rq 比对
```

实测（2026-09-28 收编 6 个）：全部 6 个的 `SKILL.md` 都与磁盘旧版不同（旧版较旧，
上游文件更多，如 `scripts/`、`catalog-summary.json`），其中 `ielts-speaking` 的
`rubrics/` 与 `skill-references/` 两个本地独有目录**被删掉了**——要从快照里取回来
才能合并。若本地有改动，先比对再决定装不装。

对照的是：后来收编的 `implementing-drag-drop` 因先验证过“与上游逐字节一致”
（19 文件 / 0 差异），收编完全无损。**先验证再装**比事后从快照掘回来省事得多。

### E. 验证改动是否生效

`pi --mode rpc` 可以无模型调用地列出已注册的命令，用来确认 skill / extension
是否被正确发现：

```bash
printf '{"id":"1","type":"get_commands"}\n' | pi --mode rpc
```

验收标准（三条都要满足）：

1. stderr 为空——有重名或格式错误会在这里报警告
2. `source=skill` 的每一条 `sourceInfo.baseDir` 都指向 `~/.agents`
3. 预期的 extension 都在（本机：`handoff`、`webui`、`llama`）

本机实测（2026-09-28）：61 个命令 = skill 55（含 28 个 `lark-*`）+ extension 3 +
prompt 3，stderr 为空。

命令数取决于实际装了什么，**不要拿固定数字当验收标准**——用“skill 的 `baseDir`
全部指向 `~/.agents`”和“stderr 为空”这两条。

### F. 回滚

改动 `~/.agents` 前先留三份素材：

```bash
tar czf /tmp/agents-backup-$(date +%Y%m%d-%H%M%S).tar.gz -C ~ .agents
cp ~/.agents/.skill-lock.json /tmp/lock-before.json
find ~/.agents/skills -maxdepth 1 -type l -exec ls -la {} \; > /tmp/links-before.txt
```

框架文件可以用 `git reset --hard` 回退，但**第三方技能不在 git 里**——只能靠
tar 快照或重新 `npx skills add`。

### G. 绕过 clone 的 git 流程（graft）

当 `github.com:443` 不可达而 `api.github.com` 正常时（实测过：`github.com` 超时、
`api.github.com` 200），用 API 取 tarball 落地，再 graft 到远端历史：

```bash
gh api repos/<owner>/<repo>/tarball/main > /tmp/repo.tar.gz
tar xzf /tmp/repo.tar.gz -C /tmp/stage
cp -R /tmp/stage/*/. ~/.agents/
cd ~/.agents && git init -b main && git remote add origin <url>
git add -A && git commit -m "<本地提交>"
git fetch origin && git reset --soft origin/main   # HEAD 换到远端历史，工作区/暂存区不动
git diff --cached --stat origin/main                # 核对将要提交的差异
git commit -m "<合并提交>"                           # 生成 origin/main 的子提交
git push -u origin main
```

`git reset --soft` 是关键：它把远端 HEAD 变成父节点，避免产生一条无共同祖先的
历史（直接 push 会被拒或被迫 `--force`）。

**注意**：`git push` 前确认提交身份是对的。本机全局身份是
`montana <2398925789@qq.com>`，仓库里没有 repo-local 覆盖。

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

### 只读检测：`skills-manager` CLI 与 APP 能否联动

`skills-manager`（Rust 桌面 APP + 自带 CLI）是这个领域唯一按「git 库 + DB 外置
且可由技能文件重建」设计的工具，但它的**联动条件与本仓库相撞**。

能联动的部分：CLI 与 APP 共享同一套 SQLite DB、中心库和 sync engine；APP 启动
时会把匹配版本的 CLI 发布到 `~/.skills-manager/bin/skills-manager-cli`，所以
agent 用到的就是 APP 的版本。

冲突在于 `--skills-root` 会**连 base 一起重定向**（`src-tauri/src/bin/skills-manager-cli.rs`）：

```rust
if let Some(skills_root) = &cli.skills_root {
    let base = central_repo::external_base_dir(skills_root);  // ~/.skills-manager/external/<name>-<hash>
    central_repo::set_runtime_base_dir_override(Some(base));
    central_repo::set_runtime_skills_dir_override(Some(skills_root.clone()));
}
```

于是它的 DB 落在那个 external 命名空间里，**与 APP 的库彻底隔离**——这正是它
「external checkout 保持干净」的实现方式，也意味着这个模式**不与 APP 联动**。

想要联动，只能让 APP 的 repo path 指向 `~/.agents`（`repo set-path`）、CLI 不带
`--skills-root`。代价是三件事：

1. `~/.agents/` 根下会多出 6 个状态文件：`skills-manager.db`、`scenarios/`、
   `cache/`、`logs/`、`.skills-manager.lock`、`git-askpass.sh`（必须 gitignore）
2. APP 成为该目录的**第二个写入方**，重演「为什么不用 APM」第 2 条
3. APP 的 git 功能会在 `~/.agents/skills/` 里 `git init`（**嵌套仓库**），因此
   Backup 页与 `git` 子命令必须完全不用

结论：**只读检测用 CLI + `--skills-root ~/.agents/skills`**——零污染、不与 APP
联动、也不需要装 APP。**要 APP 可视化，就必须接受它拥有这个目录**，与 `skills`
CLI 争抢所有权。两者不可兼得。

### 共享目录的固有风险

`~/.agents/skills/` 既是**多个管理器的部署目标**，又是本仓库的源目录，即
「构建产物落在源码树里」。`.gitignore` 的白名单机制就是为这个设计的。注意
`skills list` 会把 `agent-harness` 也列进它的清单（标为 `Source: local`），
所以不要用 `skills remove` 的交互式全选来清理——会误删自有 skill。

## 尚未版本化的东西

`~/.pi/agent/settings.json` 里的 `packages` 数组（[pi
packages](https://pi.dev/packages) 声明）目前**不在**本仓库里，而本机已经不是空的
（`["npm:pi-web-ui"]`）。一旦这份声明开始变化，应按同样原则搬进来——声明入库，
`node_modules` 之类的产物不入库。

## 已知情况

- **28 个 `lark-*` 已收编入库**（2026-09-28）：由 `skills` CLI 从飞书 well-known
  端点装入 `~/.agents/skills/`，Claude Code 侧为软链。早先 README 描述的
  「只存在于 lock、磁盘没有」已不成立。注：早先那句“31 个命令含 28 个 lark”与
  “`~/.pi/agent/skills/lark-*` 有 28 个软链”描述的是**另一台机器/另一时刻**的
  状态，本机按 B 的规则不建那套软链。
- **`~/.pi/agent/skills/` 现在没有软链**。历史上那里有 5 条指向
  `~/.agents/skills/` 的软链（非 lark），已按 B 的规则 1 删除；实测技能数 27→27、
  无警告。
- **`~/.agents/skills/.openclaude/skills/` 是一棵重复树**：22 个目录，其中 21 个与
  上层同名目录逐字节相同，另有一个 `grill-me`。看着像 OpenClaude 的安装目标，
  与本仓库无关。pi 的技能加载器**跳过点目录**，所以它不造成重复发现，纯占空间。
- **git 身份来自全局配置**（`montana <2398925789@qq.com>`），仓库里没有
  repo-local 覆盖，与早先 README 的描述不同。
- `~/.pi/agent/skills/` 是个空目录，保留（pi 原生全局技能位，将来放厂商专用技能）。
